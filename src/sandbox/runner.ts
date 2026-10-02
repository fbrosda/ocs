import type {
  SandboxRuntimeConfig,
  WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";

/**
 * The seam that keeps the library/CLI decision reversible.
 *
 * Nothing outside `src/sandbox/` should learn which implementation it is
 * talking to, and nothing outside `src/sandbox/` should import
 * `@anthropic-ai/sandbox-runtime` at all — that package is an explicitly
 * unstable research preview, and confining the instability to this one adapter
 * is the entire reason the interface exists (AGENTS.md invariant 5).
 */
export interface SandboxRunner {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandbox(
    command: string,
    options?: WrapWithSandboxOptions
  ): Promise<string>;

  /**
   * Policy patterns the platform could not enforce.
   *
   * Part of the interface rather than an implementation detail because it is a
   * fail-closed decision point: `ocs` refuses to start a command when this
   * comes back non-empty, so a runner that cannot report it must return `[]`
   * only if it genuinely has nothing to report.
   */
  unenforcedGlobWarnings(): Promise<string[]>;

  /** Tears down proxies. Must be called on every exit path. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
