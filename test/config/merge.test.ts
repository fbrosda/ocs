import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mergeConfigs,
  ConfigError,
  loadJsonConfig,
} from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Merge semantics and provenance.
 *
 * The provenance assertions matter as much as the merged values: `--explain`
 * is documented as the way to answer "what is this repo actually asking for?",
 * so a policy that merges correctly but cannot say where an entry came from has
 * still failed at the job.
 */
describe("merge configs", () => {
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.homedir(), ".ocs-merge-"));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  describe("union", () => {
    it("adds a project domain to the host's", async () => {
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com"];

      const { config } = await mergeConfigs(
        host,
        { network: { allow: ["extra.example.com"] } },
        project
      );

      expect(config.network.allow).toEqual([
        "api.anthropic.com",
        "extra.example.com",
      ]);
    });

    it("collapses a duplicate rather than listing it twice", async () => {
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com"];

      const { config } = await mergeConfigs(
        host,
        { network: { allow: ["api.anthropic.com"] } },
        project
      );

      expect(config.network.allow).toEqual(["api.anthropic.com"]);
    });

    it("never lets a project subtract", async () => {
      const host = getDefaultHostConfig();
      host.mounts.read = ["/opt/sdk", "/usr/local/share"];
      host.protected.read = ["**/.env", "**/id_rsa*"];

      // An empty list is not a request to clear the list. There is no syntax
      // for removal and there will not be one.
      const { config } = await mergeConfigs(
        host,
        { mounts: { read: [] }, protected: { read: ["**/.env"] } },
        project
      );

      expect(config.mounts.read).toEqual(
        expect.arrayContaining(["/opt/sdk", "/usr/local/share"])
      );
      expect(config.protected.read).toEqual(
        expect.arrayContaining(["**/.env", "**/id_rsa*"])
      );
    });
  });

  describe("provenance", () => {
    it("attributes each entry to the file it came from", async () => {
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com"];
      const name = path.basename(project);

      const { provenance } = await mergeConfigs(
        host,
        { network: { allow: ["repo.example.com"] } },
        project
      );

      const byValue = Object.fromEntries(
        provenance.network.allow.map((e) => [e.value, e.source])
      );
      expect(byValue["api.anthropic.com"]).toBe("host");
      expect(byValue["repo.example.com"]).toBe(`project:${name}`);
    });

    it("attributes a command-line grant to the command line", async () => {
      const { provenance } = await mergeConfigs(
        getDefaultHostConfig(),
        {},
        project,
        {
          network: { allow: ["typed.example.com"] },
          mounts: { write: ["/tmp/typed"] },
        }
      );

      const domain = provenance.network.allow.find(
        (e) => e.value === "typed.example.com"
      );
      expect(domain?.source).toBe("cli");

      const mount = provenance.mounts.write.find(
        (e) => e.value === "/tmp/typed"
      );
      expect(mount?.source).toBe("cli");
    });

    it("shows a command-line path resolved to absolute, not as typed", async () => {
      const cwd = process.cwd();
      try {
        process.chdir(project);
        const { provenance } = await mergeConfigs(
          getDefaultHostConfig(),
          {},
          project,
          {
            mounts: { read: ["./vendor"] },
          }
        );

        const entry = provenance.mounts.read.find((e) => e.source === "cli");
        expect(entry?.value).toBe(path.join(project, "vendor"));
      } finally {
        process.chdir(cwd);
      }
    });

    it("attributes every srt setting to the host", async () => {
      const host = getDefaultHostConfig();
      host.srt = { ...host.srt, mandatoryDenySearchDepth: 7 };

      const { provenance } = await mergeConfigs(host, {}, project);

      expect(provenance.srt.mandatoryDenySearchDepth).toEqual({
        source: "host",
        value: 7,
      });
    });
  });

  describe("loading", () => {
    it("treats a missing file as an empty config", () => {
      // A project with no .ocs/config.json is the normal case, not an error.
      expect(loadJsonConfig(path.join(project, "nope.json"))).toEqual({});
    });

    it("names the file when a config is malformed", () => {
      const bad = path.join(project, "bad.json");
      fs.writeFileSync(bad, "{ not json");

      expect(() => loadJsonConfig(bad)).toThrow(ConfigError);
      expect(() => loadJsonConfig(bad)).toThrow(/bad\.json/);
    });

    it("does not inherit host values into the project half", async () => {
      // A merge bug should fail closed rather than inherit something unintended,
      // which is why the project is parsed into its own structure and merged
      // into a fresh policy instead of being patched onto the host config.
      const host = getDefaultHostConfig();
      host.network.allow = ["api.anthropic.com"];

      const { config } = await mergeConfigs(host, {}, project);

      expect(config.network.allow).toEqual(["api.anthropic.com"]);
      expect(config.srt?.allowAppleEvents).toBe(false);
    });
  });
});
