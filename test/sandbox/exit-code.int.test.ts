import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";

/**
 * Exit-status propagation through the sandbox.
 *
 * This is the regression test for a bug in `@anthropic-ai/sandbox-runtime`
 * ≤ 0.0.77: the wrapper script ended with a bare `exit` inside an EXIT trap,
 * which bash and dash resolve to the script's own status but zsh resolves to
 * the status of the trap's last command — the `kill`. Under zsh, a failing
 * command reported exit 0.
 *
 * That matters more than it looks. `ocs` is a wrapper: its whole job is to run
 * a command under a policy and hand back what happened. A sandbox that reports
 * success for a failed run is worse than no sandbox, because a script wrapping
 * `ocs` sees a clean exit and carries on as though the run worked.
 *
 * `srt` is pinned to 0.0.78, which fixes the trap, and `binShell` is left
 * undefined so bash is used — bash was never affected, but the default is
 * asserted here so a future bump that changes it fails visibly.
 */
const hasBwrap =
  spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBwrap)("exit status propagation (needs bwrap)", () => {
  let project: string;
  let manager: SandboxManager | undefined;

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-exit-"));
  });

  afterEach(async () => {
    // Invariant 6. A skipped reset leaks the proxy and the socat bridge, and the
    // leak shows up as an unrelated failure much later.
    await manager?.reset();
    manager = undefined;
  });

  const run = async (command: string): Promise<number | null> => {
    const mgr = new SandboxManager();
    manager = mgr;
    await mgr.initialize(getDefaultHostConfig(), project);
    const wrapped = await mgr.wrap(command);

    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", wrapped], {
        stdio: "ignore",
        cwd: project,
      });
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
  };

  it("reports 0 for a command that succeeds", async () => {
    expect(await run("true")).toBe(0);
  });

  it("reports 1 for a command that fails", async () => {
    expect(await run("false")).toBe(1);
  });

  it("preserves an arbitrary non-zero status", async () => {
    // Not just "non-zero": a caller may be distinguishing 2 from 127, and a
    // wrapper that collapses them to 1 loses that.
    expect(await run("exit 42")).toBe(42);
  });

  it("reports 127 when the command does not exist", async () => {
    expect(await run("definitely-not-a-real-command-xyz")).toBe(127);
  });
});
