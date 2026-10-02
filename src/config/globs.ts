import * as path from "path";
import { expandTilde } from "./paths.js";

/*
 * Read-deny globs are the one part of the policy resolved by walking the
 * filesystem rather than handed to bubblewrap as a bind, and the two platforms
 * do that differently:
 *
 * - macOS turns the pattern into a Seatbelt regex, so it is matched lazily
 *   against whatever the process opens, at any depth, at any time.
 * - Linux expands the pattern at wrap time into concrete paths to mount over,
 *   which is what makes it cheap and what makes it break in one specific way:
 *   the walk has to start from a literal directory.
 *
 * `srt` takes that start directory from the pattern's static prefix. For a
 * double-star-then-slash pattern (`**\/.env` below) there isn't one — the
 * pattern begins with the wildcard — so the walk bails, the entry expands to
 * nothing, and the deny is silently not enforced. `srt` reports this through
 * `getLinuxGlobPatternWarnings()`; its own wording is "expands to nothing and
 * leaves the entry unenforced".
 *
 * This was not hypothetical for `ocs`. The built-in `protected.read` defaults
 * are all that shape, and a relative pattern is additionally resolved against
 * `process.cwd()`, so they worked only because the CLI happened to chdir to the
 * project first. Launch `ocs` from anywhere else — a service manager, an editor
 * task, a different project directory — and every credential glob in the
 * default policy quietly stopped denying, while still *looking* configured in
 * `--print-config`. A protection that vanishes when a path you did not control
 * changes is worse than no protection, because it is believed.
 *
 * So relative patterns are anchored here, at compile time, against roots we
 * know rather than against whatever the process happens to be sitting in.
 */

/** The non-glob prefix of a pattern: everything before the first metacharacter. */
function staticPrefix(pattern: string): string {
  const idx = pattern.search(/[*?[\]]/);
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

/**
 * Whether the pattern names a literal directory for a Linux expand to start
 * from. Mirrors `globPatternBaseDir()` in srt: a prefix that is empty, or that
 * stops at the root, leaves the walk nowhere to begin.
 */
export function hasLiteralBase(pattern: string): boolean {
  const prefix = staticPrefix(pattern);
  return prefix !== "" && prefix !== "/";
}

/**
 * Rewrite relative read-deny globs as absolute ones under each anchor.
 *
 * Absolute patterns pass through untouched — the user already said where they
 * meant. Relative ones are expanded under every anchor rather than only the
 * first, because `**\/.env` means "in the tree I am worried about" and the
 * project directory is only one of the trees that qualify.
 */
export function anchorReadDenyGlobs(
  patterns: string[],
  anchors: string[]
): string[] {
  const concreteAnchors = [...new Set(anchors.map((a) => path.resolve(a)))];
  const anchored: string[] = [];

  for (const pattern of patterns) {
    const expanded = expandTilde(pattern);

    if (path.isAbsolute(expanded)) {
      anchored.push(expanded);
      continue;
    }

    if (concreteAnchors.length === 0) {
      // Nothing to anchor against. Leave it for the validator to reject rather
      // than silently dropping a deny the user asked for.
      anchored.push(expanded);
      continue;
    }

    for (const anchor of concreteAnchors) {
      anchored.push(path.join(anchor, expanded));
    }
  }

  return [...new Set(anchored)];
}
