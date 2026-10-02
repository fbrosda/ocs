import * as fs from "fs";
import * as path from "path";
import type { OcsConfig } from "./config/types.js";
import { isAtOrUnder, normalizePath } from "./config/paths.js";

/**
 * Can the thing we are about to sandbox actually be executed inside the sandbox?
 *
 * `ocs` runs `opencode`, so `opencode` has to be *readable and executable* under
 * the compiled policy. That is not a formality, and when it fails it fails
 * silently: the sandboxed shell reports `127` for a command it cannot see, which
 * is indistinguishable from a typo.
 *
 * The common case is invisible on a development machine and near-universal on
 * somebody else's. A system-wide `opencode` sits in `/usr/bin`, which every
 * policy reads. An opencode installed by its own installer, by nvm, or by a
 * user-local npm prefix sits under `$HOME` — and the policy denies the home
 * directory wholesale, re-opening only specific paths inside it. Those four
 * directories are opencode's *config and state*, never the directory its
 * *executable* happens to live in.
 *
 * So the failure is: works for the author, `127` for the user, no explanation.
 * Checking it here is the difference. Nothing is auto-granted — see the note on
 * `checkOpencodeReachable` about why widening the policy to paper over it would
 * be the wrong fix.
 */

export type FindingStatus = "ok" | "warn" | "fail";

export type Finding = {
  /** What was checked, for the report. */
  subject: string;
  status: FindingStatus;
  /** One line: what is true right now. */
  detail: string;
  /** What the user can do about it, when there is something to do. */
  fix?: string;
};

/**
 * Resolve an executable the way a shell would, on the host.
 *
 * Deliberately *not* an exact `sh` reimplementation: `PATHEXT`, command hashing
 * and shell builtins have no bearing on whether a path is readable under the
 * policy, which is the only question being asked here.
 */
export function findOnPath(name: string): string | null {
  if (name.includes(path.sep)) {
    return fs.existsSync(name) ? path.resolve(name) : null;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return null;
}

/**
 * Every path the compiled policy makes readable.
 *
 * The project plus the merged read mounts. Deliberately the same list
 * `buildSrtConfig` puts in `allowRead`, so this cannot drift into disagreeing
 * with what actually runs — a reachability check that consults a different list
 * than the one the sandbox enforces is a check on nothing.
 */
function readableRoots(config: OcsConfig, projectPath: string): string[] {
  return [projectPath, ...config.mounts.read].map(normalizePath);
}

/**
 * The interpreter a `#!` line asks for, as a host path.
 *
 * Two shapes matter. A literal path (`#!/usr/bin/node`) is used as written. An
 * `env` indirection (`#!/usr/bin/env node`) names a *command*, so it has to go
 * through `PATH` like any other — which is exactly the case that breaks under a
 * user-local node, since `node` then resolves into `$HOME` too.
 *
 * Returns null when there is no shebang (a native binary, which needs no
 * interpreter) or when it cannot be parsed, in which case the caller reports
 * nothing rather than guessing.
 */
function interpreterOf(binary: string): { path: string; via: string } | null {
  let firstLine: string;
  try {
    // One byte is enough: a shebang cannot span lines, and a multi-gigabyte
    // binary should not be read into memory to find out.
    const fd = fs.openSync(binary, "r");
    const buf = Buffer.alloc(256);
    const read = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    firstLine = buf.subarray(0, read).toString("utf-8").split("\n")[0] ?? "";
  } catch {
    return null;
  }

  if (!firstLine.startsWith("#!")) {
    return null;
  }

  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  const interpreter = tokens[0];
  if (!interpreter) {
    return null;
  }

  if (path.basename(interpreter) === "env") {
    const named = tokens[1];
    if (!named) {
      return null;
    }
    const resolved = findOnPath(named);
    return resolved ? { path: resolved, via: named } : null;
  }

  return { path: interpreter, via: path.basename(interpreter) };
}

/**
 * Check that `opencode` is reachable under a merged policy.
 *
 * Returns findings rather than throwing, because `ocs doctor` reports all of
 * them at once while the run path refuses on the first fatal one. Never grants
 * anything: the caller decides.
 *
 * Note what is deliberately *not* done here — quietly adding the directory
 * holding `opencode` to the read mounts would make the check pass, and would
 * also mean one command's location silently becomes part of the security policy
 * of every later run. A grant that appears from nowhere is exactly the kind of
 * widening this project refuses; so is fixing it in the one place it is easy.
 */
export function checkOpencodeReachable(
  config: OcsConfig,
  projectPath: string
): Finding[] {
  const roots = readableRoots(config, projectPath);
  const findings: Finding[] = [];

  const executable = findOnPath("opencode");
  if (executable === null) {
    return [
      {
        subject: "opencode",
        status: "fail",
        detail: "not found on PATH",
        fix:
          "Install opencode and make sure it is on PATH: https://opencode.ai/docs/\n" +
          "  `ocs` runs opencode inside the sandbox; it does not install or locate it for you.",
      },
    ];
  }

  // realpath before judging: a symlink into a readable directory is fine, and a
  // symlink out of one is exactly the case that must be caught.
  let resolved = executable;
  try {
    resolved = fs.realpathSync(executable);
  } catch {
    // Unresolvable link: judge the path as spelled, which is the safe direction.
  }

  const dir = path.dirname(resolved);
  const readable = roots.some((root) => isAtOrUnder(resolved, root));

  if (!readable) {
    findings.push({
      subject: "opencode",
      status: "fail",
      detail: `${resolved} is outside every directory this policy can read`,
      fix:
        "The sandbox denies your home directory and re-opens only what the policy names, so an\n" +
        "  opencode installed by its own installer, by nvm, or into a user-local node prefix is\n" +
        "  present on the host and invisible inside the sandbox — which surfaces as a bare `127`.\n" +
        "  Grant the directory for one run:\n" +
        `    ocs -m ${dir} ${projectPath}\n` +
        "  or permanently, in ~/.config/ocs/config.json:\n" +
        `    "mounts": { "read": ["${dir}"] }`,
    });
  } else {
    findings.push({
      subject: "opencode",
      status: "ok",
      detail: resolved,
    });
  }

  // The interpreter has the same problem and the same 127, one level down.
  const interpreter = interpreterOf(resolved);
  if (interpreter !== null) {
    let interpPath = interpreter.path;
    try {
      interpPath = fs.realpathSync(interpreter.path);
    } catch {
      // As above: judge as spelled.
    }
    if (!roots.some((root) => isAtOrUnder(interpPath, root))) {
      findings.push({
        subject: `${interpreter.via} (opencode's interpreter)`,
        status: "fail",
        detail: `${interpPath} is outside every directory this policy can read`,
        fix:
          `    ocs -m ${path.dirname(interpPath)} ${projectPath}\n` +
          "  opencode's interpreter is as unreadable as opencode itself; granting one\n" +
          "  without the other still exits 127.",
      });
    }
  }

  return findings;
}

/** True when nothing in the findings is fatal. */
export function hasFailure(findings: Finding[]): boolean {
  return findings.some((f) => f.status === "fail");
}

/** Render findings the way `ocs doctor` prints them. */
export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => {
      const mark =
        f.status === "ok" ? "ok  " : f.status === "warn" ? "warn" : "FAIL";
      const lines = [`  [${mark}] ${f.subject}: ${f.detail}`];
      if (f.fix) {
        for (const line of f.fix.split("\n")) {
          lines.push(`         ${line}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
}
