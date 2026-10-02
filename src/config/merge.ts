import * as fs from "fs";
import * as path from "path";
import {
  OcsConfig,
  OcsConfigSchema,
  Provenance,
  ProvenanceEntry,
  SrtKeys,
} from "./types.js";
import {
  expandTilde,
  getGlobalGrantDirs,
  isAtOrUnder,
  normalizePath,
} from "./paths.js";

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
 * Reject the two path spellings that cannot mean what they appear to mean on
 * any platform `ocs` supports.
 *
 * A NUL byte is never a valid filename character, and an empty string is never a
 * path. Both reach downstream as "the current directory" or as a silently
 * truncated string depending on who reads them, which is not something to pass
 * into a security policy.
 *
 * Deliberately *not* checked: backslashes and Windows drive letters. A backslash
 * is an ordinary filename character on Linux and macOS alike, so on both
 * platforms `..\\..\\etc` resolves inside the project and the containment gate
 * already handles it correctly. Rejecting them was guarding a Windows parsing
 * difference that does not exist on either target, and refusing valid Unix
 * filenames containing a backslash — which does not make a sandbox safer, only
 * harder to configure.
 */
function validatePathSyntax(raw: string, source: string): void {
  const problems: string[] = [];

  if (raw === "") {
    problems.push("it is empty");
  }
  if (raw.includes("\0")) {
    problems.push("it contains a NUL byte");
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

/**
 * Reject network grants that name no specific host.
 *
 * `*`, `*.com` and a bare `*.*` each match every host on the internet, so
 * allowing one hands the agent an unrestricted network — the exact thing the
 * allowlist exists to prevent. That is worth an early, explanatory refusal.
 *
 * This is deliberately *not* a reimplementation of srt's domain validator. A
 * previous version of this file mirrored `isValidDomainPattern` so the check
 * would agree exactly; it cost 55 lines that had to be kept in step with an
 * upstream function we do not control, and any divergence would be a silent
 * disagreement rather than a loud failure. Instead this checks only the property
 * `ocs` has an opinion about — "does this name a host, or everything" — and lets
 * `validateCompiledPolicy` run srt's own schema as the authority on the rest.
 *
 * Two layers is not redundancy: this one produces a message naming the repo that
 * asked, and srt's runs last, on the compiled policy, before a proxy is started.
 */
function rejectOverBroadNetworkGrants(domains: string[], source: string): void {
  const escapes = domains.filter((d) => !namesSpecificHosts(d));

  if (escapes.length === 0) {
    return;
  }

  throw new ConfigError(
    `${source} requested network access that is an escape rather than a grant: ${escapes.join(", ")}\n\n` +
      "A pattern with no registrable domain to anchor it ('*', '*.com') matches every host, so\n" +
      "allowing it hands the agent an unrestricted network — which is the one thing the allowlist\n" +
      "exists to prevent.\n\n" +
      "Name the hosts you actually need:\n" +
      '  ["*"]       → ["api.example.com", "*.example.com"]\n' +
      '  ["*.com"]   → ["github.com", "*.github.com"]\n\n' +
      "A wildcard with two or more labels after it is a bounded grant and is allowed —\n" +
      "'*.github.com' is not the same request as '*.com'."
  );
}

/**
 * Does this pattern name a bounded set of hosts, or all of them?
 *
 * Only the wildcard cases are decided here; anything without a `*` is a
 * candidate host and is srt's business to validate.
 */
function namesSpecificHosts(entry: string): boolean {
  if (!entry.includes("*")) {
    return true;
  }

  // `*.example.com` is bounded; `*`, `*.com` and `a.*.com` are not.
  if (!entry.startsWith("*.")) {
    return false;
  }
  const labels = entry.slice(2).split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

/**
 * Layer the user's host config over the built-in defaults.
 *
 * The host file is trusted, and trusted means two different things for scalars
 * and for lists:
 *
 * - **A scalar** (`srt.mandatoryDenySearchDepth`, the `allow*` booleans) is
 *   replaced. The user owns it; that is the entire point of a settings file, and
 *   `false` has to be respected rather than read as "unset".
 * - **A list** (`network.allow`, `protected.read`, `mounts.*`) is unioned with the
 *   defaults. Mentioning a list means "add to this", never "this is now the whole
 *   policy".
 *
 * That asymmetry is the whole design of the function, and it is why the file has
 * no subtract syntax on any channel. There is exactly one place a user removes a
 * default: editing the defaults themselves, or a future explicit deny/remove
 * mechanism designed as its own feature. Silently losing protection is the one
 * outcome worth engineering against.
 *
 * This exists because the previous `{ ...defaults, ...hostFile }` was wrong in a
 * way that only showed up on the second key a user added. A shallow spread
 * replaces a whole nested object, so a host file saying `protected.read:
 * ["**\/*.tfstate"]` deleted the built-in `**\/.env` protection outright — a
 * committed secret became readable because the user added an unrelated glob. Same
 * for `mounts.read`, which lost `/usr` and opencode's own directories and left a
 * sandbox with no userland. Silent weakening on an unrelated edit is the exact
 * failure mode the rest of this file exists to prevent.
 */
export function applyHostConfig(
  defaults: OcsConfig,
  hostFile: Record<string, unknown>
): OcsConfig {
  const file = (hostFile ?? {}) as Partial<OcsConfig>;

  return {
    ...defaults,
    // Every list is unioned, never replaced. A host file that mentions
    // `protected.read` is adding a rule, not restating the whole policy, and
    // treating it as a restatement is what made `**\/*.tfstate` silently delete
    // the built-in `**\/.env` protection. The same applies to `mounts.read`:
    // replacing it with `["/opt/some-tool"]` drops `/usr` and opencode's own
    // directories, leaving a sandbox with no userland. A user adding one mount
    // should not have to enumerate the other eleven.
    network: {
      allow: union(
        defaults.network.allow,
        file.network?.allow,
        "network.allow"
      ),
      deny: union(defaults.network.deny, file.network?.deny, "network.deny"),
    },
    mounts: {
      read: union(defaults.mounts.read, file.mounts?.read, "mounts.read"),
      write: union(defaults.mounts.write, file.mounts?.write, "mounts.write"),
    },
    protected: {
      read: union(
        defaults.protected.read,
        file.protected?.read,
        "protected.read"
      ),
      write: union(
        defaults.protected.write,
        file.protected?.write,
        "protected.write"
      ),
    },
    // Scalars replace, including to `false`, so a user can turn a setting off.
    srt:
      file.srt === undefined ? defaults.srt : { ...defaults.srt, ...file.srt },
  };
}

/**
 * Union two lists, tolerating an absent one.
 *
 * A non-array on the file side is passed through rather than coerced. Spreading
 * the string `"not-an-array"` would yield twelve one-character "domains" — the
 * sort of thing that passes a length check and fails confusingly much later.
 * Handing it on unchanged lets the schema reject it with a message about the
 * actual mistake.
 */
function union(a: string[], b: string[] | undefined, key: string): string[] {
  if (b === undefined) {
    return a;
  }
  if (!Array.isArray(b)) {
    // Fail closed here rather than coercing. Spreading `"not-an-array"` would
    // yield twelve one-character "domains" — the sort of value that passes a
    // length check and fails confusingly much later, at the proxy. Saying so
    // now is also the difference between a message naming the bad key and a
    // schema complaint about the wrong type in the wrong place.
    throw new ConfigError(
      `${HOME_CONFIG_HINT}\n\n` +
        `"${key}" must be an array of strings, but it is ${describe(b)}.`
    );
  }
  return [...new Set([...a, ...b])];
}

/** Where the user fixes a bad host file. Named once so it cannot drift. */
const HOME_CONFIG_HINT =
  "Fix ~/.config/ocs/config.json (or the file passed to --config).";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
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
