import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * XDG base directories, with the documented fallbacks.
 *
 * A set variable wins, but only when it is absolute: the XDG spec says a
 * relative value is invalid and must be ignored, and honouring one would let
 * a stray `XDG_CONFIG_HOME=.` silently move opencode's config directory into
 * whatever directory `ocs` happened to be launched from.
 */
function xdgBaseDir(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  return value && path.isAbsolute(value) ? value : fallback;
}

export function expandTilde(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function normalizePath(p: string): string {
  return path.resolve(expandTilde(p));
}

export function ensureDir(p: string): void {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

/**
 * The four directories this opencode build keeps state in.
 *
 * Derived from the XDG base directories rather than hardcoded so
 * `XDG_DATA_HOME` and friends are respected. PLAN.md M0 lists "confirm which
 * directories this opencode build actually uses" as an open item, so treat
 * this as the Linux layout and re-derive it on macOS — that platform puts
 * state under `~/Library/Application Support`, and porting the Linux paths
 * would be a silent confinement hole rather than a cosmetic difference.
 */
export function getOpencodeBaseDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(
      xdgBaseDir("XDG_CONFIG_HOME", path.join(home, ".config")),
      "opencode"
    ),
    path.join(
      xdgBaseDir("XDG_DATA_HOME", path.join(home, ".local", "share")),
      "opencode"
    ),
    path.join(
      xdgBaseDir("XDG_CACHE_HOME", path.join(home, ".cache")),
      "opencode"
    ),
    path.join(
      xdgBaseDir("XDG_STATE_HOME", path.join(home, ".local", "state")),
      "opencode"
    ),
  ];
}

/** Where `ocs` keeps its own host config and any runtime state. */
export function getOcsRuntimeDir(): string {
  return path.join(
    xdgBaseDir("XDG_CONFIG_HOME", path.join(os.homedir(), ".config")),
    "ocs"
  );
}

export function getTempDirs(): string[] {
  return ["/tmp", "/var/tmp"];
}

/**
 * Paths every project is granted regardless of what its config asks for.
 *
 * This is the second half of the containment gate: a project-supplied path is
 * accepted when it lands inside the project *or* inside one of these. They are
 * derived, not independently declared, so the defaults and the gate cannot
 * drift apart — they were previously written out twice and had already begun
 * to disagree.
 */
export function getGlobalGrantDirs(): string[] {
  return [...getOpencodeBaseDirs(), getOcsRuntimeDir(), ...getTempDirs()];
}

/**
 * System directories mounted read-only so the sandbox has a usable userland.
 * Nothing here is writable, so a project config asking for any of these paths
 * is a containment failure rather than a grant.
 */
export function getSystemReadDirs(): string[] {
  return ["/usr", "/etc", "/bin", "/lib", "/lib64", "/opt"];
}

/**
 * The roots a relative read-deny glob is anchored to.
 *
 * A credential pattern is only meaningful where the sandbox can actually
 * create or read a file, which is to say inside the project (the repository
 * you just cloned — the actual threat) and inside opencode's own state
 * directories. Anchoring further out would mean walking all of `/tmp` on every
 * launch to defend against a file nobody put there; a host config that really
 * wants a location covered can spell the pattern absolutely.
 */
export function getDenyReadAnchors(projectPath: string): string[] {
  return [
    normalizePath(projectPath),
    ...getOpencodeBaseDirs().map(normalizePath),
  ];
}

export function getHomeConfigPath(): string {
  const configDir = path.join(os.homedir(), ".config", "ocs");
  ensureDir(configDir);
  return path.join(configDir, "config.json");
}

export function getDefaultProjectConfig(projectPath: string): string {
  return path.join(projectPath, ".ocs", "config.json");
}
