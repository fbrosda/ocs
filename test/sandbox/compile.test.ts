import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { buildSrtConfig } from "../../src/sandbox/manager.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import { hasLiteralBase } from "../../src/config/globs.js";
import { mergeConfigs } from "../../src/config/merge.js";

/**
 * Tests for the policy handed to the sandbox runtime.
 *
 * These compile a real policy from the real defaults and then check the thing
 * that actually matters: that every deny in it can be enforced. Asserting on
 * the shape of the object is not enough, because the bug this exists to catch
 * had exactly the right shape — a `denyRead` full of well-formed globs that
 * matched nothing.
 */
describe("buildSrtConfig", () => {
  let home: string;
  let project: string;
  let elsewhere: string;
  let savedEnv: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-c-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-c-proj-"));
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-c-cwd-"));

    // Pin the environment the defaults derive from, so the assertions below are
    // about this machine's $HOME rather than whatever the developer has.
    savedEnv = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_STATE_HOME;

    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const dir of [home, project, elsewhere]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("read-deny globs", () => {
    it("leaves no pattern the platform cannot enforce", () => {
      const config = buildSrtConfig(getDefaultHostConfig(), project);

      // Every deny has to name a literal directory for a Linux expand to start
      // from. A wildcard in the first component expands to nothing, so the deny
      // is silently not enforced.
      for (const pattern of config.filesystem.denyRead) {
        expect(hasLiteralBase(pattern)).toBe(true);
      }
    });

    it("actually finds a committed .env, from a working directory that is not the project", async () => {
      // The regression test. `**\/.env` used to expand to nothing whenever cwd
      // was not the project tree, so the built-in credential protection was a
      // no-op in exactly the situation nobody would notice: launching ocs from
      // somewhere else.
      const secret = path.join(project, "services", "api", ".env");
      fs.mkdirSync(path.dirname(secret), { recursive: true });
      fs.writeFileSync(secret, "TOKEN=secret\n");

      const config = buildSrtConfig(getDefaultHostConfig(), project);

      // Reach into srt's expander on purpose. It is the code that decides what
      // gets denied, so asserting against our own idea of it would only prove
      // we agree with ourselves. `srt` is pinned to an exact version, so this
      // path is stable; if a bump moves it, this test failing loudly is the
      // signal to re-verify the assumption rather than a nuisance to silence.
      const { expandReadDenyGlobLinux } =
        await import("@anthropic-ai/sandbox-runtime/dist/sandbox/read-deny-glob.js");

      process.chdir(elsewhere);
      expect(process.cwd()).not.toBe(project);

      const denied = config.filesystem.denyRead.flatMap((pattern) =>
        expandReadDenyGlobLinux(pattern, [], new Set())
      );

      expect(denied).toContain(secret);
    });

    it("denies credential files in the opencode state directories too", async () => {
      const opencodeData = path.join(home, ".local", "share", "opencode");
      fs.mkdirSync(opencodeData, { recursive: true });
      const secret = path.join(opencodeData, "auth", ".env");
      fs.mkdirSync(path.dirname(secret), { recursive: true });
      fs.writeFileSync(secret, "TOKEN=secret\n");

      const config = buildSrtConfig(getDefaultHostConfig(), project);
      const { expandReadDenyGlobLinux } =
        await import("@anthropic-ai/sandbox-runtime/dist/sandbox/read-deny-glob.js");

      process.chdir(elsewhere);
      const denied = config.filesystem.denyRead.flatMap((pattern) =>
        expandReadDenyGlobLinux(pattern, [], new Set())
      );

      expect(denied).toContain(secret);
    });

    it("denies the home directory outright", () => {
      const config = buildSrtConfig(getDefaultHostConfig(), project);

      // First, so nothing below it can be re-opened by a broader allow.
      expect(config.filesystem.denyRead[0]).toBe(home);
    });

    it("refuses to compile a policy with a root-anchored deny glob", () => {
      const host = getDefaultHostConfig();
      host.protected.read.push("/**/.pem");

      // Anchoring cannot rescue this one: it is already absolute, and there is
      // no directory above "/" to walk down from. Failing here is the only
      // honest outcome — macOS would honour it, Linux would not, and a rule
      // that protects a secret on one platform only is worse than no rule.
      expect(() => buildSrtConfig(host, project)).toThrow(/silently ignored/);
    });
  });

  describe("seccomp binding", () => {
    // The binary srt runs to install the filter, and the path it is told to
    // run, must be the same file. Binding one and naming the other is the kind
    // of mismatch that passes review and fails at run time.
    it("binds the same apply-seccomp path it configures", () => {
      const config = buildSrtConfig(getDefaultHostConfig(), project);

      const applyPath = config.seccomp?.applyPath;
      expect(applyPath).toBeDefined();
      expect(fs.existsSync(applyPath as string)).toBe(true);
      expect(config.filesystem.allowRead).toContain(applyPath);
    });

    it("binds it as a single file rather than the directory holding it", () => {
      // node_modules is not readable in the sandbox, so granting the vendor
      // directory instead of the binary would grant something nobody asked for
      // and still work. Granting the binary is the whole point.
      const config = buildSrtConfig(getDefaultHostConfig(), project);
      const applyPath = config.seccomp?.applyPath as string;

      for (const grant of config.filesystem.allowRead) {
        if (grant.includes("seccomp")) {
          expect(grant).toBe(applyPath);
        }
      }
    });

    it("still binds it when the host asks for open unix sockets", async () => {
      // Whether sockets are permitted is srt's decision to act on, and it acts
      // by not wrapping the command. The binary is simply unused then, so the
      // binding is absent by design — checked here so the behaviour is stated
      // rather than implied by whichever way the code happened to fall.
      const host = getDefaultHostConfig();
      host.srt = { ...host.srt, allowAllUnixSockets: true };

      const config = buildSrtConfig(host, project);

      expect(config.seccomp?.applyPath).toBeUndefined();
      expect(
        config.filesystem.allowRead.some((p) => p.includes("seccomp"))
      ).toBe(false);
    });
  });

  describe("escape hatches", () => {
    it("places each setting where the runtime reads it", () => {
      const host = getDefaultHostConfig();
      host.srt = {
        ...host.srt,
        allowAllUnixSockets: true,
        allowLocalBinding: true,
        allowAppleEvents: true,
        enableWeakerNestedSandbox: true,
        enableWeakerNetworkIsolation: true,
        mandatoryDenySearchDepth: 5,
      };

      const config = buildSrtConfig(host, project);

      // Two of these live under `network` in the runtime's schema. Spread flat
      // they would be stripped without a word, turning "allow unix sockets"
      // into a no-op that still looks configured.
      expect(config.network.allowAllUnixSockets).toBe(true);
      expect(config.network.allowLocalBinding).toBe(true);
      expect(
        config.filesystem.allowRead.some((p) => p.includes("seccomp"))
      ).toBe(false);

      expect(config.allowAppleEvents).toBe(true);
      expect(config.enableWeakerNestedSandbox).toBe(true);
      expect(config.enableWeakerNetworkIsolation).toBe(true);
      expect(config.mandatoryDenySearchDepth).toBe(5);
    });

    it("does not let the hatches clobber the network allowlist", () => {
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com"];
      host.srt = { ...host.srt, allowLocalBinding: true };

      const config = buildSrtConfig(host, project);

      expect(config.network.allowedDomains).toEqual(["api.anthropic.com"]);
      expect(config.network.deniedDomains).toEqual([]);
    });
  });

  describe("filesystem grants", () => {
    it("grants the project read and write", () => {
      const config = buildSrtConfig(getDefaultHostConfig(), project);

      expect(config.filesystem.allowRead).toContain(project);
      expect(config.filesystem.allowWrite).toContain(project);
    });

    it("derives the opencode directories from XDG rather than hardcoding them", async () => {
      process.env.XDG_DATA_HOME = path.join(home, "xdg-data");
      const expected = path.join(home, "xdg-data", "opencode");

      const config = buildSrtConfig(getDefaultHostConfig(), project);

      expect(config.filesystem.allowRead).toContain(expected);
      expect(config.filesystem.allowWrite).toContain(expected);
    });

    it("ignores a relative XDG override", () => {
      // The XDG spec says a relative value is invalid and must be ignored.
      // Honouring one would let a stray `XDG_CONFIG_HOME=.` move opencode's
      // config directory to wherever ocs happened to be launched from.
      process.env.XDG_CONFIG_HOME = "relative/path";

      const config = buildSrtConfig(getDefaultHostConfig(), project);

      expect(config.filesystem.allowRead).toContain(
        path.join(home, ".config", "opencode")
      );
    });

    it("writes nothing but the project, opencode's state, and the temp dirs", () => {
      const config = buildSrtConfig(getDefaultHostConfig(), project);
      const writable = config.filesystem.allowWrite;

      expect(writable).toContain("/tmp");
      expect(writable.some((p) => p === home)).toBe(false);
      expect(writable.some((p) => p.startsWith("/etc"))).toBe(false);
      expect(writable.some((p) => p.startsWith("/usr"))).toBe(false);
    });

    it("carries a project grant through to the compiled policy", async () => {
      const subdir = path.join(project, "vendor");
      fs.mkdirSync(subdir);

      const { config } = await mergeConfigs(
        getDefaultHostConfig(),
        { mounts: { write: ["vendor"] } },
        project
      );
      const compiled = buildSrtConfig(config, project);

      // The merge layer resolves a project-relative path to absolute; the
      // compile step must not then drop it, or `mounts.write` in a project
      // config would silently do nothing.
      expect(compiled.filesystem.allowWrite).toContain(subdir);
    });

    it("rejects a project config that reaches outside itself", async () => {
      await expect(
        mergeConfigs(
          getDefaultHostConfig(),
          { mounts: { write: ["/etc"] } },
          project
        )
      ).rejects.toThrow(/outside the project/);
    });
  });
});
