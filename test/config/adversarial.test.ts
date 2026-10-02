import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergeConfigs, ConfigError } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Hostile repository configs.
 *
 * Every fixture here is a `.ocs/config.json` that arrived via `git clone`, so
 * each one is written from the attacker's side: what would a repo have to say
 * to get itself more than it was given. None of them are bugs in the fixtures —
 * see AGENTS.md, "Do not 'fix' the hostile fixtures".
 */
describe("adversarial cases", () => {
  let project: string;
  let outside: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-adv-proj-"));
    // Deliberately *not* under os.tmpdir(): /tmp and /var/tmp are global grants
    // every project already has, so a symlink pointing there is legitimately
    // allowed and would prove nothing. This has to be somewhere a project
    // cannot reach — a directory in the home tree is the real hostile case.
    outside = fs.mkdtempSync(path.join(os.homedir(), ".ocs-adv-outside-"));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const merge = (projectConfig: unknown) =>
    mergeConfigs(getDefaultHostConfig(), projectConfig, project);

  describe("containment", () => {
    it("rejects mounts.write to root", async () => {
      await expect(merge({ mounts: { write: ["/"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects mounts.read to the home directory", async () => {
      await expect(merge({ mounts: { read: ["~"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects mounts.write to a system directory", async () => {
      await expect(merge({ mounts: { write: ["/etc"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a credential directory outside the project", async () => {
      await expect(merge({ mounts: { read: ["~/.aws"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects climbing out with ../", async () => {
      await expect(merge({ mounts: { read: ["../../etc"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a symlink planted in the repo pointing out of it", async () => {
      // The case monotonic merging cannot catch: the path is inside the project,
      // it is *adding* an entry, and it looks entirely reasonable in a diff.
      // Only resolving the link before comparing rejects it.
      fs.symlinkSync(outside, path.join(project, "innocent-looking-dir"));
      fs.mkdirSync(path.join(outside, "secrets"));

      await expect(
        merge({ mounts: { read: ["innocent-looking-dir"] } })
      ).rejects.toThrow(ConfigError);
      await expect(
        merge({ mounts: { write: ["innocent-looking-dir"] } })
      ).rejects.toThrow(ConfigError);
    });

    it("rejects a write path that reaches out through a symlinked component", async () => {
      // The tail does not exist yet, so a check that only looked at the literal
      // spelling would judge it by the symlink's name and let it through.
      fs.symlinkSync(outside, path.join(project, "link"));
      fs.mkdirSync(path.join(outside, "elsewhere"));

      await expect(
        merge({ mounts: { write: ["link/elsewhere/deep"] } })
      ).rejects.toThrow(ConfigError);
    });

    it("rejects the same path in a project config that -m would accept", async () => {
      // Same input, different trust channel. The distinction is the whole point
      // of having two: one is a file that arrived with a clone, the other is
      // something the user typed in their own shell.
      const pathOutside = path.join(outside, "vendor");

      await expect(merge({ mounts: { write: [pathOutside] } })).rejects.toThrow(
        ConfigError
      );

      const { config } = await mergeConfigs(
        getDefaultHostConfig(),
        {},
        project,
        { mounts: { write: [pathOutside] } }
      );
      expect(config.mounts.write).toContain(pathOutside);
    });
  });

  describe("permission gate", () => {
    // Each of these is a setting that removes the sandbox rather than widening
    // it. A repo that can set them is not sandboxed, so the response is to stop.
    const escapeHatches = [
      "allowAppleEvents",
      "allowAllUnixSockets",
      "allowLocalBinding",
      "enableWeakerNestedSandbox",
      "enableWeakerNetworkIsolation",
      "mandatoryDenySearchDepth",
    ];

    for (const key of escapeHatches) {
      it(`rejects srt.${key} from a project config`, async () => {
        await expect(
          merge({
            srt: { [key]: key === "mandatoryDenySearchDepth" ? 99 : true },
          })
        ).rejects.toThrow(ConfigError);
      });
    }

    it("rejects the gate even when the value is the harmless one", async () => {
      // `false` and `true` are both refused. The signal that a repo is reaching
      // for this section is the problem; the value it lands on is not the test.
      await expect(
        merge({ srt: { allowAllUnixSockets: false } })
      ).rejects.toThrow(ConfigError);
    });

    it("names the setting and says where the real change belongs", async () => {
      await expect(merge({ srt: { allowAppleEvents: true } })).rejects.toThrow(
        /srt\.allowAppleEvents/
      );
      await expect(merge({ srt: { allowAppleEvents: true } })).rejects.toThrow(
        /host-only|\.config\/ocs/
      );
    });
  });

  describe("network", () => {
    it("rejects a wildcard as a grant", async () => {
      // `*` matches every host on every port. Allowing it is not a grant, it is
      // the absence of the network boundary this tool exists to provide.
      await expect(merge({ network: { allow: ["*"] } })).rejects.toThrow(
        ConfigError
      );
      await expect(merge({ network: { allow: ["*:443"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a single-label wildcard", async () => {
      await expect(merge({ network: { allow: ["*.com"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a wildcard on the command line too", async () => {
      // Trusted does not mean unchecked. `-n` still gets the same answer as a
      // config file, so a typo cannot quietly become an open network.
      await expect(
        mergeConfigs(getDefaultHostConfig(), {}, project, {
          network: { allow: ["*"] },
        })
      ).rejects.toThrow(ConfigError);
    });

    it("rejects wildcard shapes that name no bounded host set", async () => {
      // The shapes that are easy to write and easy to wave through: `a.*.com`
      // looks scoped, `*.*` looks like a pattern, and `*.` looks like a typo that
      // a careless matcher would treat as everything.
      for (const escape of ["a.*.com", "*.*", "*.", "*..com", "*.example."]) {
        await expect(merge({ network: { allow: [escape] } })).rejects.toThrow(
          ConfigError
        );
      }
    });

    it("accepts a scoped wildcard", async () => {
      // `*.github.com` is a real grant to a bounded set of hosts, and the
      // documented risk of it is a policy mistake rather than a bug.
      const { config } = await merge({ network: { allow: ["*.github.com"] } });
      expect(config.network.allow).toContain("*.github.com");
    });

    it("passes non-wildcard entries through to the runtime's own validation", async () => {
      // `localhost` and a bare IPv6 literal are host entries the early check has
      // no opinion about. They used to be reimplemented here; now they reach the
      // compiled policy and are judged by srt's schema, which is the authority.
      // What this asserts is that we are not *over*-rejecting on the way past.
      const { config } = await merge({
        network: { allow: ["localhost", "[::1]", "api.example.com:8443"] },
      });

      expect(config.network.allow).toEqual([
        "opencode.ai",
        "localhost",
        "[::1]",
        "api.example.com:8443",
      ]);
    });

    it("allows a project to add a deny but never to subtract one", async () => {
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com", "api.openai.com"];

      const { config } = await mergeConfigs(
        host,
        { network: { allow: ["extra.example.com"] } },
        project
      );

      // There is no syntax for removal, so the host's entries are all still
      // there and the project's is merely appended.
      expect(config.network.allow).toEqual(
        expect.arrayContaining([
          "api.anthropic.com",
          "api.openai.com",
          "extra.example.com",
        ])
      );
    });
  });

  describe("subtraction", () => {
    it("cannot remove a host mount", async () => {
      const host = getDefaultHostConfig();
      const before = [...host.mounts.read];

      const { config } = await merge({ mounts: { read: [] } });

      expect(config.mounts.read).toEqual(expect.arrayContaining(before));
    });

    it("cannot remove a protected read by restating the list", async () => {
      const host = getDefaultHostConfig();
      host.protected.read = ["**/.env", "**/id_rsa*"];

      const { config } = await merge({ protected: { read: ["**/.env"] } });

      expect(config.protected.read).toEqual(
        expect.arrayContaining(["**/.env", "**/.netrc"])
      );
    });

    it("treats an empty project object as a no-op, not a reset", async () => {
      const host = getDefaultHostConfig();
      const { config } = await mergeConfigs(host, {}, project);

      expect(config.mounts.write).toEqual(
        expect.arrayContaining(host.mounts.write)
      );
      expect(config.network.allow).toEqual(host.network.allow);
    });
  });
});
