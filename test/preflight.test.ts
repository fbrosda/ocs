import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getDefaultHostConfig } from "../src/config/defaults.js";
import {
  checkOpencodeReachable,
  findOnPath,
  hasFailure,
  type Finding,
} from "../src/preflight.js";

/**
 * The 127 that isn't a typo.
 *
 * `ocs` runs `opencode` inside the sandbox, so opencode has to be readable under
 * the compiled policy. It usually is — `/usr/bin/opencode` sits under a `/usr`
 * grant — and when it isn't, the sandboxed shell reports `127`, which everyone
 * reads as a typo in the command. These tests pin the detection and, more
 * importantly, that it never *grants* its way out of the problem.
 */
describe("preflight reachability", () => {
  let ungranted: string;
  let binDir: string;
  let project: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    // In the home tree, not /tmp: the point is a location the policy does not
    // cover, and /tmp is granted.
    ungranted = fs.mkdtempSync(path.join(os.homedir(), ".ocs-preflight-"));
    binDir = path.join(ungranted, "bin");
    project = fs.mkdtempSync(path.join(os.homedir(), ".ocs-preflight-proj-"));
    fs.mkdirSync(binDir);
    savedPath = process.env.PATH;
    process.env.PATH = binDir;
  });

  afterEach(() => {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    fs.rmSync(ungranted, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const fakeOpencode = (shebang: string) => {
    const file = path.join(binDir, "opencode");
    fs.writeFileSync(file, `${shebang}\necho hi\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  it("reports a missing opencode rather than assuming one exists", () => {
    const findings = checkOpencodeReachable(getDefaultHostConfig(), project);

    expect(hasFailure(findings)).toBe(true);
    expect(findings[0]?.subject).toBe("opencode");
    expect(findings[0]?.detail).toMatch(/not found on PATH/);
    expect(findings[0]?.fix).toMatch(/opencode\.ai/);
  });

  it("refuses when opencode is outside every readable path, and says which grant fixes it", () => {
    const binary = fakeOpencode("#!/bin/sh");

    const findings = checkOpencodeReachable(getDefaultHostConfig(), project);

    expect(hasFailure(findings)).toBe(true);
    const failure = findings.find((f) => f.status === "fail");
    expect(failure?.detail).toContain(binary);
    // The fix has to be copy-pasteable, not a description of one.
    expect(failure?.fix).toContain(`ocs -m ${binDir} ${project}`);
  });

  it("accepts the same binary once the policy grants its directory", () => {
    fakeOpencode("#!/bin/sh");
    const config = getDefaultHostConfig();
    config.mounts.read.push(binDir);

    const findings = checkOpencodeReachable(config, project);

    expect(hasFailure(findings)).toBe(false);
    expect(findings.find((f) => f.subject === "opencode")?.status).toBe("ok");
  });

  it("never grants anything itself", () => {
    // The tempting fix is to append the directory holding opencode to the read
    // mounts so the check passes. That would make one command's location part of
    // the security policy of every later run, silently. Assert the config comes
    // back untouched.
    fakeOpencode("#!/bin/sh");
    const config = getDefaultHostConfig();
    const before = [...config.mounts.read];

    checkOpencodeReachable(config, project);

    expect(config.mounts.read).toEqual(before);
  });

  it("catches an interpreter the policy cannot read either", () => {
    // Granting opencode without granting node that runs it still exits 127, one
    // level down. `#!/usr/bin/env node` is the common shape and it resolves
    // through PATH, which is how a user-local node ends up here.
    const nodeDir = path.join(ungranted, "nodebin");
    fs.mkdirSync(nodeDir);
    const node = path.join(nodeDir, "node");
    fs.writeFileSync(node, "#!/bin/sh\n");
    fs.chmodSync(node, 0o755);
    process.env.PATH = `${binDir}:${nodeDir}`;

    fakeOpencode("#!/usr/bin/env node");
    const config = getDefaultHostConfig();
    config.mounts.read.push(binDir);

    const findings = checkOpencodeReachable(config, project);

    // opencode itself is now readable, so the only thing left to complain about
    // is the interpreter.
    expect(findings.find((f) => f.subject === "opencode")?.status).toBe("ok");
    const interp: Finding | undefined = findings.find((f) =>
      f.subject.includes("interpreter")
    );
    expect(interp?.status).toBe("fail");
    expect(interp?.fix).toContain(`-m ${nodeDir}`);
  });

  it("says nothing about an interpreter for a native binary", () => {
    // No shebang: there is no interpreter to be unreadable, and inventing a
    // finding here would be noise on every Linux install.
    const file = path.join(binDir, "opencode");
    fs.writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
    fs.chmodSync(file, 0o755);

    const findings = checkOpencodeReachable(getDefaultHostConfig(), project);

    expect(findings.some((f) => f.subject.includes("interpreter"))).toBe(false);
  });

  describe("findOnPath", () => {
    it("resolves a command through PATH", () => {
      const binary = fakeOpencode("#!/bin/sh");
      expect(findOnPath("opencode")).toBe(binary);
    });

    it("returns null for a command that is not there", () => {
      expect(findOnPath("definitely-not-a-real-command-xyz")).toBeNull();
    });

    it("skips a file that is not executable", () => {
      // PATH lookup is what the shell does, and the shell would skip it too.
      fs.writeFileSync(path.join(binDir, "opencode"), "not executable\n");
      expect(findOnPath("opencode")).toBeNull();
    });
  });
});
