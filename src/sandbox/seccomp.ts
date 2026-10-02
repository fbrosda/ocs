import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { OcsConfig } from "../config/types.js";

/*
 * Unix-socket blocking needs a helper binary that runs *inside* the sandbox,
 * and nothing in the policy as written makes it reachable there.
 *
 * `srt` blocks `socket(AF_UNIX, ...)` with a seccomp filter applied by a static
 * `apply-seccomp` binary it ships in `vendor/seccomp/<arch>/`. It resolves that
 * binary on the host, emits it into the bwrap command line, and — this is the
 * part that matters — assumes it will be visible in the sandbox. It does not
 * bind it.
 *
 * With a global install that assumption holds, because `/usr/lib/node_modules`
 * sits under a readable `/usr`. As a library dependency it does not: the binary
 * lives inside `node_modules` next to `ocs`, and the read policy denies the home
 * directory wholesale and re-opens only specific paths. So the binary is
 * present on the host, named in the command, and absent from the sandbox.
 *
 * The result is the worst of the two failure modes. It is not the graceful
 * "binary missing, socket blocking off" path, because the binary *was* found;
 * and it is not a working sandbox, because bwrap then fails to exec it:
 *
 *   /usr/bin/bash: apply-seccomp: No such file or directory
 *
 * Every sandboxed command exits 127. Discovered by the integration suite, not by
 * reading this — which is the argument for having one.
 */

/** srt's vendor directory names, keyed by Node's `process.arch`. */
const VENDOR_ARCH: Record<string, string> = {
  x64: "x64",
  arm64: "arm64",
};

export type SeccompBinary = {
  /** Absolute path on the host, or null when there is nothing to bind. */
  path: string | null;
  /** Why it could not be resolved, when `path` is null. */
  reason: string | null;
};

/**
 * Locate the `apply-seccomp` binary srt will use.
 *
 * Resolved here rather than taken from srt so `ocs` can bind exactly the path
 * that will be named in the command. `srt` does not export its own resolver,
 * and letting the two disagree is how you end up binding one file and executing
 * another.
 */
export function resolveSeccompBinary(): SeccompBinary {
  const arch = VENDOR_ARCH[process.arch];

  if (!arch) {
    return {
      path: null,
      reason: `no prebuilt apply-seccomp binary ships for ${process.arch}; srt supports x64 and arm64 only`,
    };
  }

  let packageRoot: string;
  try {
    // Resolved from this module rather than a hardcoded relative path, so the
    // result is correct whether ocs runs from `src/` under tsx, from `dist/`, or
    // from a global install.
    const require = createRequire(import.meta.url);
    packageRoot = path.dirname(
      require.resolve("@anthropic-ai/sandbox-runtime/package.json")
    );
  } catch (e: unknown) {
    return {
      path: null,
      reason: `could not locate @anthropic-ai/sandbox-runtime: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const binary = path.join(
    packageRoot,
    "vendor",
    "seccomp",
    arch,
    "apply-seccomp"
  );

  if (!fs.existsSync(binary)) {
    return { path: null, reason: `expected a prebuilt binary at ${binary}` };
  }

  return { path: binary, reason: null };
}

/**
 * The `apply-seccomp` path to bind into the sandbox, or null when socket
 * blocking is not part of this policy.
 *
 * Throws when the binary is missing but the policy still claims Unix sockets are
 * blocked. That combination is not something to warn about and carry on: an
 * unblocked `socket(AF_UNIX, ...)` is how a sandboxed agent reaches an MCP
 * server, a Docker socket or a systemd socket belonging to the host, and every
 * filesystem and network rule above it stops mattering. Running anyway would be
 * the fallback-to-a-weaker-policy that the whole design forbids — with a status
 * message claiming a confinement that is not there.
 *
 * Two cases legitimately do not need it, and both are checked rather than
 * assumed:
 *
 * - **Not Linux.** seccomp is a Linux mechanism; macOS uses a Seatbelt profile
 *   with a real socket-paths allowlist, so there is no binary to find.
 * - **`srt.allowAllUnixSockets`.** The host config has explicitly asked for
 *   sockets to be permitted. Erroring there would make the documented escape
 *   hatch unusable on exactly the platforms where users reach for it.
 */
export function bindSeccompBinary(ocsConfig: OcsConfig): string | null {
  // Checked before resolving: with sockets already permitted, srt skips the
  // filter, so the binary is dead weight and binding it would grant read access
  // to a file inside node_modules for no reason.
  if (
    process.platform !== "linux" ||
    ocsConfig.srt?.allowAllUnixSockets === true
  ) {
    return null;
  }

  const resolved = resolveSeccompBinary();

  if (resolved.path !== null) {
    return resolved.path;
  }

  throw new Error(
    "Refusing to start: this policy blocks Unix sockets, but the helper that does it is missing\n" +
      `(${resolved.reason}).\n\n` +
      "Without it srt would skip the seccomp filter entirely and the sandbox would still report\n" +
      "success. AF_UNIX is not a minor gap: it is a direct route to any socket the host exposes.\n\n" +
      "Fixes:\n" +
      "  - reinstall, so @anthropic-ai/sandbox-runtime ships its prebuilt apply-seccomp for your\n" +
      "    architecture, or\n" +
      "  - if you are on an architecture srt has no prebuilt binary for, accept open sockets with\n" +
      `    srt.allowAllUnixSockets in ${path.join(process.env.HOME ?? "~", ".config", "ocs", "config.json")}\n` +
      "    (host config only — a project cannot ask for this), understanding that it is\n" +
      "    equivalent to giving up socket-level confinement."
  );
}
