import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergeConfigs, ConfigError } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * The containment table from PLAN.md, as tests.
 *
 * Each case is a path a repository's config might name, and the answer the gate
 * has to give. The table is the specification of the second, independent half
 * of the merge: monotonic merging alone cannot produce these answers, because
 * every one of these inputs is an *addition*.
 */
describe("containment edge cases", () => {
  let root: string;
  let project: string;
  let outside: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    // Under the home directory, not os.tmpdir(). /tmp and /var/tmp are global
    // grants every project already has, so a sibling placed there is legitimately
    // reachable and the "leaves the project" cases below would prove nothing.
    // A sibling in the home tree is the real-world case.
    root = fs.mkdtempSync(path.join(os.homedir(), ".ocs-edge-"));
    project = path.join(root, "proj");
    fs.mkdirSync(project);
    outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const merge = (
    projectConfig: unknown,
    cli?: Parameters<typeof mergeConfigs>[3]
  ) => mergeConfigs(getDefaultHostConfig(), projectConfig, project, cli);

  describe("accepted: lands inside the project", () => {
    it("accepts ./src, src/ and the absolute form of the same directory", async () => {
      fs.mkdirSync(path.join(project, "src"));

      const { config } = await merge({
        mounts: { read: ["./src", "src/", path.join(project, "src")] },
      });

      // All three spellings normalise to the same absolute path, so the union
      // holds one entry rather than three that mean the same thing.
      const granted = config.mounts.read.filter(
        (p) => p === path.join(project, "src")
      );
      expect(granted).toHaveLength(1);
    });

    it("accepts the project directory itself", async () => {
      await expect(merge({ mounts: { read: ["."] } })).resolves.toBeDefined();
    });

    it("accepts a not-yet-created path whose nearest existing ancestor is inside", async () => {
      fs.mkdirSync(path.join(project, "build"));

      await expect(
        merge({ mounts: { write: ["build/out"] } })
      ).resolves.toBeDefined();
    });

    it("accepts a path that does not exist at all, inside the project", async () => {
      await expect(
        merge({ mounts: { write: ["dist/a/b/c"] } })
      ).resolves.toBeDefined();
    });

    it("accepts the directories every project already has", async () => {
      // These are the global grants — the other half of "inside the project or
      // inside something ocs already gives everyone".
      await expect(
        merge({ mounts: { write: ["/tmp/build-cache"] } })
      ).resolves.toBeDefined();
      await expect(
        merge({
          mounts: { read: [path.join(os.homedir(), ".cache", "opencode")] },
        })
      ).resolves.toBeDefined();
    });
  });

  describe("rejected: leaves the project", () => {
    it("rejects ../sibling", async () => {
      await expect(merge({ mounts: { read: ["../sibling"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a path that climbs out and back in", async () => {
      // `${project}/../../etc` resolves to /etc, so the lexical shape starting
      // inside the project means nothing.
      await expect(
        merge({ mounts: { read: [path.join(project, "..", "..", "etc")] } })
      ).rejects.toThrow(ConfigError);
    });

    it("rejects ~/.aws", async () => {
      await expect(merge({ mounts: { read: ["~/.aws"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects the bare home directory and the root", async () => {
      await expect(merge({ mounts: { read: ["~"] } })).rejects.toThrow(
        ConfigError
      );
      await expect(merge({ mounts: { read: ["/"] } })).rejects.toThrow(
        ConfigError
      );
      await expect(merge({ mounts: { write: ["/"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects /home and /usr", async () => {
      await expect(merge({ mounts: { read: ["/home"] } })).rejects.toThrow(
        ConfigError
      );
      await expect(merge({ mounts: { read: ["/usr"] } })).rejects.toThrow(
        ConfigError
      );
    });

    it("rejects a not-yet-created path whose nearest existing ancestor is outside", async () => {
      // The complement of the accepted case, and the one that matters: if the
      // ancestor check were skipped whenever the path is missing, a repo could
      // create its way out through a component that does not exist yet.
      await expect(
        merge({ mounts: { write: [path.join(outside, "build", "out")] } })
      ).rejects.toThrow(ConfigError);
    });

    it("rejects a sibling directory with an innocuous name", async () => {
      fs.mkdirSync(path.join(root, "sibling"));
      await expect(
        merge({ mounts: { write: ["../sibling"] } })
      ).rejects.toThrow(ConfigError);
    });
  });

  describe("rejected: malformed", () => {
    // Neither of these can mean anything useful. A NUL byte is never a valid
    // filename character, and "" is never a path — both reach downstream as
    // something other than what they say.
    const malformed = ["", "a\0b"];

    for (const bad of malformed) {
      it(`rejects ${JSON.stringify(bad)} from a project config`, async () => {
        await expect(merge({ mounts: { read: [bad] } })).rejects.toThrow(
          ConfigError
        );
      });

      it(`rejects ${JSON.stringify(bad)} from the command line too`, async () => {
        await expect(merge({}, { mounts: { read: [bad] } })).rejects.toThrow(
          ConfigError
        );
      });
    }

    it("explains why rather than just refusing", async () => {
      await expect(merge({ mounts: { read: ["a\0b"] } })).rejects.toThrow(
        /NUL byte/
      );
    });
  });

  describe("backslash and drive letters are left alone", () => {
    // Both are valid Unix filenames, and both platforms ocs targets are POSIX.
    // Refusing them would break real configuration without making anything
    // safer: the containment gate already judges `..\\..\\etc` correctly because
    // it is one ordinary filename component.
    it("accepts a backslash in a project path", async () => {
      const odd = path.join(project, "weird\\name");
      fs.mkdirSync(odd);

      const { config } = await merge({
        mounts: { read: ["weird\\name"] },
      });

      expect(config.mounts.read).toContain(odd);
    });

    it("still contains a backslash traversal rather than granting it", async () => {
      // The point of not rejecting the spelling: containment, not syntax, is
      // what decides. `..\\..\\etc` is a filename, not a traversal, so it stays
      // inside the project.
      const { config } = await merge({
        mounts: { read: ["..\\..\\etc"] },
      });

      expect(config.mounts.read).toContain(
        path.resolve(project, "..\\..\\etc")
      );
    });
  });

  describe("trusted vs untrusted", () => {
    it("treats the same path differently on the two channels", async () => {
      // The distinction the whole split exists for: one arrived with a clone,
      // the other was typed in the user's own shell.
      await expect(merge({ mounts: { write: [outside] } })).rejects.toThrow(
        ConfigError
      );

      const { config } = await merge({}, { mounts: { write: [outside] } });
      expect(config.mounts.write).toContain(outside);
    });

    it("resolves a command-line path to absolute", async () => {
      const cwd = process.cwd();
      try {
        process.chdir(project);
        const { config } = await merge(
          {},
          { mounts: { read: ["relative-dir"] } }
        );

        expect(config.mounts.read).toContain(
          path.join(project, "relative-dir")
        );
      } finally {
        process.chdir(cwd);
      }
    });

    it("expands a tilde on the command line", async () => {
      const { config } = await merge(
        {},
        { mounts: { read: ["~/.npm/_cacache"] } }
      );

      // The documented `npx` fix from the README. As a host-config entry it
      // works; as a project entry it is refused, because a repository should
      // not be able to hand itself the npm cache.
      expect(config.mounts.read).toContain(
        path.join(os.homedir(), ".npm", "_cacache")
      );
      await expect(
        merge({ mounts: { read: ["~/.npm/_cacache"] } })
      ).rejects.toThrow(ConfigError);
    });
  });
});
