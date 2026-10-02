import { ConfigError } from "../config/merge.js";

const UNSUPPORTED_GLOBS = new Set(["*/*", "*/**", "**/*", "*/"]);

export function validateProtectedPatterns(patterns: string[]): void {
  for (const p of patterns) {
    if (UNSUPPORTED_GLOBS.has(p)) {
      // basic check
    }
    // Reject patterns with wildcard in first component like **/...
    // Reject patterns where the first path component contains a wildcard
    // e.g., `/**/*.pem` has ** as first component effectively - wildcard in first component
    const firstPart = p.split("/")[0];
    if (firstPart.includes("*") || firstPart.includes("?") || firstPart.includes("[")) {
      throw new ConfigError(`Protected pattern '${p}' is not portable (may be silently skipped on Linux)`);
    }
    // Also catch patterns starting with **/ as wildcard in first component
    if (p.startsWith("**/")) {
      throw new ConfigError(`Protected pattern '${p}' is not portable (may be silently skipped on Linux)`);
    }
  }
}
