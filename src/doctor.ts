import * as fs from "fs";
import * as os from "os";
import {
  applyHostConfig,
  loadJsonConfig,
  mergeConfigs,
  ConfigError,
} from "./config/merge.js";
import { getHomeConfigPath } from "./config/paths.js";
import { getDefaultHostConfig } from "./config/defaults.js";
import { resolveSeccompBinary, resolveSrtVersion } from "./sandbox/seccomp.js";
import {
  checkOpencodeReachable,
  findOnPath,
  formatFindings,
  hasFailure,
  type Finding,
} from "./preflight.js";

/**
 * `ocs doctor` — everything that can make a working install look broken.
 *
 * Installation is exactly when these go missing, and each one fails in a way
 * that points somewhere other than the cause:
 *
 * - no `bwrap` — `srt` throws deep in its own stack, or nothing happens
 * - no `socat` — the sandbox comes up with no network at all, which is
 *   indistinguishable from a correct empty allowlist (recorded in PLAN.md)
 * - no `rg` — the mandatory-deny scan silently finds nothing to protect
 * - `opencode` outside the read mounts — `127`, blamed on the typo
 *
 * So this reports each one by name, says what to install, and exits non-zero
 * while anything required is missing. Read-only: it resolves nothing, merges
 * nothing, and starts no sandbox, so it is safe to run on a machine you are
 * still setting up.
 */

type HostTool = {
  /** The command as typed on a shell. */
  command: string;
  /** Package that provides it, for the "how do I get this" line. */
  package: string;
  /** Linux-only, because macOS uses Seatbelt and has no proxy bridge to run. */
  linuxOnly: boolean;
  /** What breaks when it is absent, phrased for a human. */
  consequence: string;
};

const HOST_TOOLS: HostTool[] = [
  {
    command: "bwrap",
    package: "bubblewrap",
    linuxOnly: true,
    consequence: "there is no sandbox primitive to run the policy",
  },
  {
    command: "socat",
    package: "socat",
    linuxOnly: true,
    consequence:
      "the network proxies never reach the namespace, so the sandbox has no network — " +
      "which looks exactly like a correct empty allowlist",
  },
  {
    command: "rg",
    package: "ripgrep",
    linuxOnly: true,
    consequence:
      "the scan for sensitive files under writable paths finds nothing, so it protects nothing",
  },
];

export type DoctorReport = {
  findings: Finding[];
  /** False when something required is missing. */
  ok: boolean;
};

/**
 * Run every check against a project path.
 *
 * The project is optional: the environment checks are the point of this command,
 * and they should work in a directory that is not a project at all. When one is
 * given, `opencode`'s reachability is judged against the policy that project
 * would actually get.
 */
export async function runDoctor(projectPath?: string): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const isLinux = process.platform === "linux";
  const isMacOS = process.platform === "darwin";

  // --- Platform ------------------------------------------------------------
  if (isLinux) {
    findings.push({
      subject: "platform",
      status: "ok",
      detail: `linux/${process.arch} — bubblewrap and seccomp`,
    });
  } else if (isMacOS) {
    findings.push({
      subject: "platform",
      status: "warn",
      detail: `darwin/${process.arch} — Seatbelt. This path is implemented but not verified`,
      fix:
        "macOS support is unproven: the opencode state directories are the Linux XDG layout and\n" +
        "  may differ under ~/Library/Application Support, so expect to need -m grants.\n" +
        "  Report what breaks rather than working around it.",
    });
  } else {
    findings.push({
      subject: "platform",
      status: "fail",
      detail: `${process.platform}/${process.arch} is not supported`,
      fix: "srt supports linux and macOS only.",
    });
  }

  // --- The sandbox runtime itself ------------------------------------------
  // A resolution failure here means a broken install, and it is the single most
  // valuable thing to distinguish from "the sandbox misbehaved".
  const srt = resolveSrtVersion();
  if ("error" in srt) {
    findings.push({
      subject: "@anthropic-ai/sandbox-runtime",
      status: "fail",
      detail: srt.error,
      fix:
        "ocs depends on it as a normal library dependency — there is no global srt to fall back\n" +
        "  to. Reinstall ocs (npm i -g ocs, or reinstall the package). If this is an Arch install\n" +
        "  and the registry could not be reached during the build, that is the same problem.",
    });
  } else {
    findings.push({
      subject: "@anthropic-ai/sandbox-runtime",
      status: "ok",
      detail: srt.version,
    });
  }

  // --- Host tools ----------------------------------------------------------
  for (const tool of HOST_TOOLS) {
    if (tool.linuxOnly && !isLinux) {
      findings.push({
        subject: tool.command,
        status: "ok",
        detail: "not used on this platform",
      });
      continue;
    }
    const found = findOnPath(tool.command);
    findings.push({
      subject: tool.command,
      status: found === null ? "fail" : "ok",
      detail: found === null ? `not on PATH — ${tool.consequence}` : found,
      ...(found === null
        ? { fix: `Install it: ${installHint(tool.package, isLinux)}` }
        : {}),
    });
  }

  // --- seccomp helper ------------------------------------------------------
  // Only fatal when the policy actually claims sockets are blocked. Reporting
  // it as a hard failure on a host that has allowed sockets would train people
  // to ignore this command.
  const seccomp = resolveSeccompBinary();
  if (!isLinux) {
    findings.push({
      subject: "apply-seccomp",
      status: "ok",
      detail: "not used on this platform — Seatbelt filters sockets by path",
    });
  } else if (seccomp.path !== null) {
    findings.push({
      subject: "apply-seccomp",
      status: "ok",
      detail: seccomp.path,
    });
  } else {
    findings.push({
      subject: "apply-seccomp",
      status: "fail",
      detail: seccomp.reason ?? "not found",
      fix:
        "ocs refuses to start rather than run with unblocked Unix sockets, so this is fatal.\n" +
        "  Reinstall so the package ships its prebuilt helper for this architecture.",
    });
  }

  // --- Host config ---------------------------------------------------------
  const homeConfigPath = getHomeConfigPath();
  findings.push({
    subject: "host config",
    status: fs.existsSync(homeConfigPath) ? "ok" : "warn",
    detail: fs.existsSync(homeConfigPath)
      ? homeConfigPath
      : `absent (${homeConfigPath})`,
    ...(fs.existsSync(homeConfigPath)
      ? {}
      : { fix: "Run `ocs init` to write a starting policy." }),
  });

  // --- opencode reachability ----------------------------------------------
  const project = projectPath ?? os.homedir();
  try {
    const hostConfig = applyHostConfig(
      getDefaultHostConfig(),
      loadJsonConfig(homeConfigPath)
    );
    // Project config is deliberately not merged: a project may only add paths
    // inside the project or inside a grant it already has, so it can never be
    // what makes opencode reachable. Judging against the trusted policy keeps
    // this check stable no matter which repository you happen to be standing in.
    const { config } = await mergeTrustedPolicy(hostConfig, project);
    findings.push(...checkOpencodeReachable(config, project));
  } catch (e: unknown) {
    findings.push({
      subject: "policy",
      status: "fail",
      detail: e instanceof ConfigError ? e.message : String(e),
      fix: "Fix the host config, or delete it to fall back to the built-in defaults.",
    });
  }

  return { findings, ok: !hasFailure(findings) };
}

/**
 * Merge the host policy for a project without loading that project's config.
 *
 * A thin wrapper rather than a second merge path: the gate, the normalisation
 * and the provenance bookkeeping all live in `mergeConfigs`, and reimplementing
 * any of that for the doctor is how the two start disagreeing about what a
 * default is.
 */
function mergeTrustedPolicy(
  hostConfig: Parameters<typeof mergeConfigs>[0],
  project: string
) {
  return mergeConfigs(hostConfig, {}, project);
}

function installHint(pkg: string, isLinux: boolean): string {
  return isLinux
    ? `sudo pacman -S ${pkg}   # Arch   (or your distro's equivalent: apt install ${pkg})`
    : `brew install ${pkg}`;
}

export { formatFindings };
