import * as fs from "fs";
import * as path from "path";
import {
  OcsConfig,
  OcsConfigSchema,
  Provenance,
  ProvenanceEntry,
  SrtKeys,
} from "./types.js";
import { expandTilde, getGlobalGrantDirs, normalizePath } from "./paths.js";

function unionArrays(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * The message from a caught value, whatever was thrown.
 *
 * A thrown non-Error used to stringify as "undefined" here, which is the worst
 * possible shape for the one message that has to tell a user why their config
 * was refused.
 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Grants supplied on the command line rather than read from a file.
 *
 * These are a distinct trust channel, not a fourth config file. `-m`/`-w`/`-n`
 * were typed by the user in their own shell, so they are exempt from the
 * containment gate that untrusted project config goes through — but they are
 * still resolved to absolute and still carry `cli` provenance, because "you
 * typed it" is not the same claim as "it is safe".
 */
export type CliGrants = {
  network?: { allow?: string[] };
  mounts?: { read?: string[]; write?: string[] };
};

const EMPTY_GRANTS: CliGrants = {};

export function loadJsonConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (e: unknown) {
    throw new ConfigError(
      `Failed to parse config at ${filePath}: ${errorMessage(e)}`
    );
  }
}

export function isInsideProject(
  projectPath: string,
  candidate: string
): boolean {
  const proj = normalizePath(projectPath);
  const cand = normalizePath(candidate);
  return cand === proj || cand.startsWith(proj + path.sep);
}

type ContainmentResult =
  { ok: true; absolute: string } | { ok: false; reason: string };

/**
 * The containment gate — the second, independent half of what makes untrusted
 * project config safe.
 *
 * Monotonic merging alone is not enough, and this is the reason: a hostile repo
 * shipping `mounts.write: ["/"]` is *adding an entry*, so a plain union accepts
 * it. No syntax for removal does nothing about a syntax for addition.
 *
 * A project path must land inside the project, or inside a directory every
 * project already has. Symlinks are resolved *before* the comparison, so a
 * link planted in the repo pointing at `~/.aws` is rejected rather than
 * honoured, and a path that does not exist yet is resolved against its nearest
 * existing ancestor, so a not-yet-created `build/` cannot smuggle itself out
 * through a component that does not exist.
 */
function resolveWithContainment(
  projectPath: string,
  candidate: string
): ContainmentResult {
  const proj = normalizePath(projectPath);

  let abs: string;
  let checkPath: string;
  try {
    abs = path.resolve(proj, expandTilde(candidate));

    if (fs.existsSync(abs)) {
      // Existing: realpath it, so a symlink is judged by where it lands.
      abs = fs.realpathSync(abs);
      checkPath = abs;
    } else {
      // Not existing: judge the nearest existing ancestor, which is the part
      // that decides containment. The tail of the path cannot exist yet.
      checkPath = nearestExistingAncestor(abs);
    }
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `Path ${candidate} could not be resolved: ${errorMessage(e)}`,
    };
  }

  if (isAtOrUnder(checkPath, proj)) {
    return { ok: true, absolute: abs };
  }

  for (const grant of getGlobalGrantDirs().map(normalizePath)) {
    if (isAtOrUnder(checkPath, grant)) {
      return { ok: true, absolute: abs };
    }
  }

  return {
    ok: false,
    reason:
      `Path ${candidate} resolves to ${checkPath}, which is outside the project (${proj}) and\n` +
      "outside every directory ocs grants to all projects.\n\n" +
      "A repository's config can ask for extra access but cannot grant it to itself. If this\n" +
      "repo legitimately needs it, you can grant it for one run from your own shell:\n" +
      `  ocs -w ${candidate} ${proj}`,
  };
}

function isAtOrUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function nearestExistingAncestor(abs: string): string {
  let current = abs;
  while (true) {
    if (fs.existsSync(current)) {
      try {
        return fs.realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root without finding anything. Nothing exists
      // here, so there is no realpath to disagree with.
      return abs;
    }
    current = parent;
  }
}

/**
 * Reject path syntax that cannot mean what it appears to mean.
 *
 * These are not escapes on Linux — a NUL byte or a backslash is just an
 * ordinary character in a filename, so `../../etc` spelled with backslashes
 * stays inside the project and the containment check passes it. That is exactly
 * why they matter: the value lands in a security policy as something that
 * looks like a traversal and is inert here, and stays inert only for as long as
 * nothing downstream re-parses it. A policy entry is a thing other software
 * will eventually interpret.
 *
 * Failing closed costs nothing, because none of these spellings are useful to
 * anyone on either platform.
 */
function validatePathSyntax(raw: string, source: string): void {
  const problems: string[] = [];

  if (raw === "") {
    problems.push("it is empty");
  }
  if (raw.includes("\0")) {
    problems.push("it contains a NUL byte");
  }
  if (raw.includes("\\")) {
    problems.push(
      "it contains a backslash, which is a path separator on Windows but an ordinary character here"
    );
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    problems.push("it looks like a Windows drive-letter path");
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `${source} contains a path that ${problems.join("; ")}: ${JSON.stringify(raw)}\n\n` +
        "Rejecting it rather than resolving it: a path in a policy is later read by the sandbox\n" +
        "runtime, and a value that means one thing here and another there is not safe to pass on."
    );
  }
}

export function validateContainment(
  projectPath: string,
  paths: string[]
): void {
  for (const p of paths) {
    const res = resolveWithContainment(projectPath, p);
    if (!res.ok) {
      throw new ConfigError(res.reason);
    }
  }
}

/**
 * Resolve a user-typed path to absolute without asking where it is allowed to
 * point. Relative paths resolve against the current directory, because that is
 * what the user's shell did when they typed them.
 */
function resolveTrusted(p: string): string {
  return path.resolve(expandTilde(p));
}

/** Drop a `:port` suffix. Only a bare 1–65535 number counts as one. */
function stripPort(entry: string): string {
  const idx = entry.lastIndexOf(":");
  if (idx === -1 || entry.indexOf(":") !== idx) {
    return entry;
  }
  return /^[1-9][0-9]{0,4}$/.test(entry.slice(idx + 1))
    ? entry.slice(0, idx)
    : entry;
}

/**
 * Whether a pattern is a usable domain grant, mirroring `isValidDomainPattern`
 * in srt.
 *
 * Kept in step with srt deliberately rather than approximated: this is the same
 * predicate, reimplemented so `ocs` can say *why* in terms of the repo that
 * asked, at the point where the path is being merged, instead of surfacing an
 * srt schema complaint later from `initialize()`. `validateCompiledPolicy`
 * still runs srt's own schema afterwards, so this copy being wrong could only
 * make us late, not lenient.
 */
function isUsableDomainPattern(entry: string): boolean {
  const val = stripPort(entry);

  // A bare IPv6 literal, e.g. `[::1]` or `[::1]:443`.
  if (val.includes(":") && (val.startsWith("[") || val.includes("::"))) {
    return true;
  }
  // A protocol, path or port that survived stripping is not a host.
  if (val.includes("://") || val.includes("/") || val.includes(":")) {
    return false;
  }
  if (val === "localhost") {
    return true;
  }
  if (val.startsWith("*.")) {
    // At least two labels after the wildcard: `*.example.com` is a bounded
    // grant, `*.com` is every site on the internet.
    const parts = val.slice(2).split(".");
    return parts.length >= 2 && parts.every((p) => p.length > 0);
  }
  if (val.includes("*")) {
    return false;
  }
  return val.includes(".") && !val.startsWith(".") && !val.endsWith(".");
}

/**
 * Reject network patterns that are a sandbox escape dressed as a grant.
 *
 * `srt` already refuses these in `allowedDomains`. Catching them here means the
 * message can name the repo and the offending entry, rather than arriving as a
 * schema complaint from `initialize()` after `ocs` has already resolved paths
 * and is about to start a proxy.
 *
 * Only unscoped patterns are rejected. `*.github.com` is a bounded grant and
 * stays legal — the documented risk of allowing github is a policy mistake, not
 * a bug, and not this tool's to overrule.
 */
function rejectOverBroadNetworkGrants(domains: string[], source: string): void {
  const overBroad = domains.filter((d) => !isUsableDomainPattern(d));

  if (overBroad.length === 0) {
    return;
  }

  throw new ConfigError(
    `${source} requested network access that is an escape rather than a grant: ${overBroad.join(", ")}\n\n` +
      "A pattern with no registrable domain to anchor it ('*', '*.com', 'localhost:') matches\n" +
      "every host, so allowing it hands the agent an unrestricted network — which is the one\n" +
      "thing the allowlist exists to prevent.\n\n" +
      "Name the hosts you actually need:\n" +
      '  ["*"]              → ["api.example.com", "*.example.com"]\n' +
      '  ["*.com"]          → ["github.com", "*.github.com"]'
  );
}

export async function mergeConfigs(
  hostConfig: unknown,
  projectConfig: unknown,
  projectPath: string,
  cliGrants: CliGrants = EMPTY_GRANTS
): Promise<{ config: OcsConfig; provenance: Provenance }> {
  const host = OcsConfigSchema.parse(hostConfig ?? {});
  const projectRaw = (projectConfig ?? {}) as Record<string, unknown>;

  // Permission gate. A project config that names any `srt` key is not a config
  // with a bad value, it is a repo asking to disable the sandbox — four of
  // those settings remove the sandbox rather than widen it. Hard error, no
  // warning, no override.
  const projectSrt = projectRaw.srt;
  if (projectSrt && typeof projectSrt === "object") {
    for (const k of Object.keys(projectSrt as object)) {
      if ((SrtKeys as readonly string[]).includes(k)) {
        throw new ConfigError(
          `Project config cannot set srt.${k}.\n\n` +
            "srt keys are host-only because four of them do not widen the sandbox — they remove it.\n" +
            "allowAppleEvents lets a sandboxed process launch applications that run outside it;\n" +
            "allowAllUnixSockets reaches the docker socket, ssh-agent and gpg-agent; the two\n" +
            "enableWeaker* settings exist to accommodate a weaker host.\n\n" +
            "This repo ships a .ocs/config.json that tries to set one, so ocs is stopping rather\n" +
            "than warning. There is no flag to override it; if you do want the weaker policy, put\n" +
            "it in ~/.config/ocs/config.json where the change is visible in a file you control."
        );
      }
    }
  }

  const project = OcsConfigSchema.parse(projectRaw);

  rejectOverBroadNetworkGrants(project.network.allow, "Project config");

  // Containment gate. Runs over the project's own paths only; CLI grants take
  // the trusted path below. Syntax is checked for both — "trusted" means we skip
  // the containment question, not that a malformed path is worth passing on.
  for (const p of [...project.mounts.read, ...project.mounts.write]) {
    validatePathSyntax(p, "Project config");
  }
  validateContainment(projectPath, project.mounts.read);
  validateContainment(projectPath, project.mounts.write);

  const resolveAll = (paths: string[]): string[] =>
    paths.map((p) => {
      const res = resolveWithContainment(projectPath, p);
      // Already validated above; this is the narrow the compiler needs, not a
      // second opinion. If it ever fires, the gate above has a hole.
      if (!res.ok) {
        throw new ConfigError(res.reason);
      }
      return res.absolute;
    });

  const cliReadPaths = cliGrants.mounts?.read ?? [];
  const cliWritePaths = cliGrants.mounts?.write ?? [];
  for (const p of [...cliReadPaths, ...cliWritePaths]) {
    validatePathSyntax(p, "Command line");
  }
  const cliRead = cliReadPaths.map(resolveTrusted);
  const cliWrite = cliWritePaths.map(resolveTrusted);
  const cliDomains = cliGrants.network?.allow ?? [];

  // A domain typed on the command line gets no leeway the config path doesn't
  // get, so the same check applies.
  rejectOverBroadNetworkGrants(cliDomains, "Command line");

  const resolvedProjectRead = resolveAll(project.mounts.read);
  const resolvedProjectWrite = resolveAll(project.mounts.write);

  const merged: OcsConfig = {
    network: {
      allow: unionArrays(
        unionArrays(host.network.allow, project.network.allow),
        cliDomains
      ),
      deny: unionArrays(host.network.deny, project.network.deny),
    },
    mounts: {
      read: unionArrays(
        unionArrays(host.mounts.read, resolvedProjectRead),
        cliRead
      ),
      write: unionArrays(
        unionArrays(host.mounts.write, resolvedProjectWrite),
        cliWrite
      ),
    },
    // Denies are unioned raw: they are patterns matched by the runtime, not
    // paths `ocs` resolves, and narrowing one would only make the policy weaker.
    protected: {
      read: unionArrays(host.protected.read, project.protected.read),
      write: unionArrays(host.protected.write, project.protected.write),
    },
    // Host only. The permission gate above is what guarantees the project half
    // of this is empty; re-asserting it here would be redundant, not safer.
    srt: { ...host.srt },
  };

  const projName = path.basename(normalizePath(projectPath));
  const provenance: Provenance = {
    network: { allow: [], deny: [] },
    mounts: { read: [], write: [] },
    protected: { read: [], write: [] },
    srt: {},
  };

  const add = (
    entries: ProvenanceEntry[],
    values: string[],
    source: ProvenanceEntry["source"]
  ): void => {
    for (const value of values) {
      entries.push({ source, value });
    }
  };

  add(provenance.network.allow, host.network.allow, "host");
  add(provenance.network.allow, project.network.allow, `project:${projName}`);
  add(provenance.network.allow, cliDomains, "cli");
  add(provenance.network.deny, host.network.deny, "host");
  add(provenance.network.deny, project.network.deny, `project:${projName}`);
  add(provenance.mounts.read, host.mounts.read, "host");
  add(provenance.mounts.read, project.mounts.read, `project:${projName}`);
  add(provenance.mounts.read, cliRead, "cli");
  add(provenance.mounts.write, host.mounts.write, "host");
  add(provenance.mounts.write, project.mounts.write, `project:${projName}`);
  add(provenance.mounts.write, cliWrite, "cli");
  add(provenance.protected.read, host.protected.read, "host");
  add(provenance.protected.read, project.protected.read, `project:${projName}`);
  add(provenance.protected.write, host.protected.write, "host");
  add(
    provenance.protected.write,
    project.protected.write,
    `project:${projName}`
  );

  if (host.srt) {
    for (const [k, value] of Object.entries(host.srt)) {
      provenance.srt[k] = { source: "host", value };
    }
  }

  return { config: merged, provenance };
}
