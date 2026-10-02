import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergeConfigs, ConfigError } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import {
  getGlobalGrantDirs,
  getDefaultReadDirs,
  getOpencodeBaseDirs,
  getOcsRuntimeDir,
  isAtOrUnder,
  normalizePath,
} from "../../src/config/paths.js";
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
    // Both fixtures live in the home tree, and neither may live under
    // os.tmpdir(). That is not tidiness — it is what makes the `..` cases below
    // mean anything.
    //
    // /tmp and /var/tmp are global grants every project already has, so a path
    // that climbs out of a project *under /tmp* lands back inside a grant and is
    // legitimately accepted. The containment tests were written against a
    // fixture in os.tmpdir(), which made `../../etc` resolve to `/etc` on a
    // machine with the default TMPDIR and to `/tmp/etc` — accepted — on any
    // machine where TMPDIR pointed one level deeper. A security assertion whose
    // subject is derived from ambient environment is a test that silently stops
    // testing; this suite now pins its own premise instead (see below).
    project = fs.mkdtempSync(path.join(os.homedir(), ".ocs-adv-proj-"));
    outside = fs.mkdtempSync(path.join(os.homedir(), ".ocs-adv-outside-"));
  });

  /**
   * The premise every `..` case in this file rests on.
   *
   * If the fixture ever moves somewhere whose ancestors are granted — under
   * /tmp, say — then climbing out lands in a grant, the gate accepts it by
   * design, and the assertions below start failing for reasons that have
   * nothing to do with the gate. Better to fail here, with a sentence that says
   * what happened, than to fail six cases later with `../../etc` in the message.
   *
   * This is not hypothetical: it is what a `HOME` set to a directory under /tmp
   * produces, and the containment cases below all fail together when it does.
   * That is the intended outcome — there is no ungranted directory under such a
   * `HOME`, so the cases cannot mean anything, and saying so is better than
   * passing them for the wrong reason.
   */
  it("places its fixtures outside every global grant (fails if HOME is inside /tmp)", () => {
    const projectDir = path.dirname(project);
    expect(getGlobalGrantDirs().map(normalizePath)).not.toContain(
      normalizePath(projectDir)
    );
    // One level up must also be ungranted, or `..` proves nothing.
    expect(
      getGlobalGrantDirs().some((g) =>
        isAtOrUnder(normalizePath(projectDir), normalizePath(g))
      )
    ).toBe(false);
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

    it("rejects climbing out with ..", async () => {
      // A sibling of the project. Deterministic now that the fixture is in the
      // home tree: the parent of the fixture is not itself a grant.
      await expect(merge({ mounts: { read: [".."] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects climbing out with ../../etc", async () => {
      // The PLAN.md containment table's `project/../../etc` row. Two levels up
      // from a home-tree fixture is the home directory's parent, which nothing
      // grants — under the old /tmp fixture this same string resolved to
      // `/tmp/etc` on any machine with a deeper TMPDIR and was accepted.
      await expect(merge({ mounts: { read: ["../../etc"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a read of a system directory the way it already rejects a write", async () => {
      await expect(merge({ mounts: { read: ["/etc"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("accepts a project path inside a global grant, because it is already granted", async () => {
      // The documented rule, asserted rather than left implicit: a project may
      // name a path inside a grant every project already has, and
      // `~/.config/opencode` is one of those (paths.ts, getGlobalGrantDirs).
      //
      // Acceptance is sound *only* because the host policy already grants it,
      // so that is the half worth asserting: if this ever fails because the host
      // default was narrowed, the project entry stopped being a no-op and the
      // gate's reasoning no longer holds.
      const opencodeConfigDir = getOpencodeBaseDirs()[0]!;
      const spelling = path.relative(project, opencodeConfigDir);

      const { config } = await mergeConfigs(
        getDefaultHostConfig(),
        { mounts: { read: [spelling] } },
        project
      );

      expect(config.mounts.read).toContain(opencodeConfigDir);
      expect(getDefaultHostConfig().mounts.read).toContain(opencodeConfigDir);
    });

    it("accepts a write on opencode's own config, which the host already grants", async () => {
      // PLAN.md open question 3. The agent can rewrite its own model and MCP
      // config, and a project config can reach that path through the same
      // global-grant allowance above — not because anyone decided a repository
      // should be able to do that, but because the path is already inside the
      // trust boundary of every session. Pinning it here makes the answer
      // deliberate and gives whoever decides otherwise a test to change.
      const opencodeConfigDir = getOpencodeBaseDirs()[0]!;
      const spelling = path.relative(project, opencodeConfigDir);

      const { config } = await mergeConfigs(
        getDefaultHostConfig(),
        { mounts: { write: [spelling] } },
        project
      );

      expect(config.mounts.write).toContain(opencodeConfigDir);
      expect(getDefaultHostConfig().mounts.write).toContain(opencodeConfigDir);
    });

    it("rejects a path one character away from a grant", async () => {
      // The prefix trap, in the direction that matters: `/home/fb/.config/ocs`
      // is granted, `/home/fb/.config/ocs-backup` is not, and a `startsWith`
      // without a separator would say otherwise.
      const sibling = `${getOcsRuntimeDir()}-not-granted`;
      fs.mkdirSync(sibling, { recursive: true });
      try {
        await expect(merge({ mounts: { read: [sibling] } })).rejects.toThrow(
          ConfigError
        );
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it("treats opencode's own directories as grants and system directories as not", () => {
      // Two lists describe "what a project may name", and the difference between
      // them is deliberate rather than an oversight:
      //
      // - opencode's state directories and ~/.config/ocs are read *and* write
      //   defaults, so a project naming one adds nothing and is allowed to.
      // - the system directories are read defaults because the sandbox needs a
      //   userland to exist at all, but a project naming one is a containment
      //   failure. Nothing in a repository's business, and "needed to boot" is
      //   not the same claim as "granted on request" — keeping that distinction
      //   sharp is the point.
      const reads = getDefaultReadDirs().map(normalizePath);
      const grants = getGlobalGrantDirs().map(normalizePath);

      for (const dir of [...getOpencodeBaseDirs(), getOcsRuntimeDir()]) {
        const normalized = normalizePath(dir);
        expect(reads).toContain(normalized);
        expect(grants).toContain(normalized);
      }
      for (const dir of ["/usr", "/etc"]) {
        expect(reads).toContain(normalizePath(dir));
        expect(grants).not.toContain(normalizePath(dir));
      }
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
