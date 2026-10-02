import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import type { OcsConfig } from "../../src/config/types.js";

/**
 * Unix-socket blocking, verified rather than assumed.
 *
 * Two independent bugs hide behind the same green test suite, and this file is
 * written to catch both:
 *
 * 1. **`apply-seccomp` was never bound into the sandbox.** srt emits the binary
 *    into the bwrap command line and assumes it will be visible inside. With a
 *    global install that is true; as a library dependency it is false, so every
 *    sandboxed command died with `apply-seccomp: No such file or directory` and
 *    exit 127. See src/sandbox/seccomp.ts.
 * 2. **The filter could silently fail to load.** A seccomp filter is kernel
 *    state; if the binary runs but the kernel ignores it, srt reports success
 *    and the sandbox has a hole shaped exactly like the feature it advertises.
 *
 * Both are invisible to a test that only checks the compiled policy, which is
 * why this runs the real thing in both directions. Asserting only the blocked
 * case would also pass if `AF_UNIX` were broken by something else; asserting only
 * the permitted case would pass if the policy were having no effect whatsoever.
 */
const hasBwrap =
  spawnSync("bwrap", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBwrap)("seccomp socket blocking (needs bwrap)", () => {
  let project: string;
  let manager: SandboxManager | undefined;

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-seccomp-"));

    // Written once and run inside the sandbox: bind an AF_UNIX listener and
    // report what happened. `EPERM` means the seccomp filter refused the
    // socket(2); success means it did not.
    fs.writeFileSync(
      path.join(project, "probe.js"),
      [
        'const net = require("net");',
        "const s = net.createServer();",
        's.on("error", (e) => { console.log(e.code); process.exit(0); });',
        's.listen(process.argv[2], () => { console.log("LISTEN_OK"); process.exit(0); });',
      ].join("\n")
    );
  });

  afterEach(async () => {
    // Invariant 6.
    await manager?.reset();
    manager = undefined;
  });

  const listenAttempt = async (
    mutate: (c: OcsConfig) => void
  ): Promise<string> => {
    const config = getDefaultHostConfig();
    mutate(config);

    const sock = path.join(
      project,
      `probe-${Math.random().toString(36).slice(2)}.sock`
    );
    fs.rmSync(sock, { force: true });

    const mgr = new SandboxManager();
    manager = mgr;
    await mgr.initialize(config, project);
    const wrapped = await mgr.wrap(`node probe.js ${JSON.stringify(sock)}`);

    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", wrapped], { cwd: project });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("exit", (code) =>
        resolve(code === 0 ? out.trim() : `EXIT_${code}`)
      );
      child.on("error", () => resolve("SPAWN_FAILED"));
    });
  };

  it("blocks AF_UNIX by default", async () => {
    expect(await listenAttempt(() => {})).toBe("EPERM");
  });

  it("permits AF_UNIX when the host config asks for it", async () => {
    // The negative control. Without it, the test above would still pass on a
    // machine where sockets are broken for unrelated reasons — and, worse, on a
    // machine where the policy has no effect at all.
    expect(
      await listenAttempt((c) => {
        c.srt = { ...c.srt, allowAllUnixSockets: true };
      })
    ).toBe("LISTEN_OK");
  });
});
