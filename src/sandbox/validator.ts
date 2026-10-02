import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { hasLiteralBase } from "../config/globs.js";

/**
 * Validation of the *compiled* policy — the step after merging and the last
 * point at which `ocs` still knows what the sandbox is about to be given.
 *
 * Everything here fails closed. A pattern the runtime cannot enforce is not a
 * warning, it is a deny the user believes they have and do not, and the whole
 * point of compiling a policy in one place is that this is the moment to find
 * out.
 */

/** Glob metacharacters, as `srt` counts them for expand-vs-bind decisions. */
function hasGlobChars(p: string): boolean {
  return /[*?[\]]/.test(p);
}

/**
 * A read-deny glob with no literal directory is expanded by `srt` into nothing
 * on Linux, and the entry is left unenforced.
 *
 * This is reachable only from an *absolute* pattern now — `buildSrtConfig`
 * anchors relative ones first, which is what makes the built-in credential
 * defaults work at all. What is left is a user writing a root-anchored
 * `**\/*.pem` and getting a config that validates, prints, and protects
 * nothing.
 */
function validateReadDenyGlobs(paths: readonly string[]): void {
  const unenforceable = paths.filter(
    (p) => hasGlobChars(p) && !hasLiteralBase(p)
  );

  if (unenforceable.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to start: ${unenforceable.length} read-deny pattern(s) would be silently ignored.\n` +
      unenforceable.map((p) => `  ${p}`).join("\n") +
      "\n\n" +
      "A read-deny glob is expanded on Linux by walking the filesystem from the pattern's\n" +
      "first literal directory. A pattern that starts with a wildcard ('/**/*.pem') has\n" +
      "none, so nothing is denied while the rule still appears configured.\n" +
      "macOS matches these patterns natively, so this is a rule that protects a secret on\n" +
      "one platform and does nothing on the other.\n\n" +
      "Fix: give the pattern a literal directory to start from — 'myproject/**/*.pem' — or\n" +
      "write absolute paths under ~/.config/ocs/config.json.\n" +
      "Relative patterns are already anchored for you and need no change."
  );
}

/**
 * Validate the compiled policy.
 *
 * Two independent checks, in order of how quietly they would otherwise fail:
 * `srt`'s own schema first (it rejects over-broad network patterns such as `*`
 * and `*.com` outright), then the read-deny glob check above, which no schema
 * can express.
 */
export function validateCompiledPolicy(config: SandboxRuntimeConfig): void {
  const parsed = SandboxRuntimeConfigSchema.safeParse(config);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`
    );
    throw new Error(
      `Refusing to start: the compiled policy is not valid for the sandbox runtime.\n${issues.join("\n")}\n\n` +
        "This is almost always an over-broad pattern. srt rejects '*' and single-label\n" +
        "wildcards such as '*.com' in an allowlist because they are a sandbox escape rather\n" +
        "than a grant."
    );
  }

  validateReadDenyGlobs(config.filesystem.denyRead);
  validateReadDenyGlobs(config.filesystem.allowRead ?? []);
}
