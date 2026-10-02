import type {
  SandboxRuntimeConfig,
  WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
import { SandboxRunner } from "./runner.js";

export class LibraryRunner implements SandboxRunner {
  private initialized = false;

  async initialize(config: SandboxRuntimeConfig): Promise<void> {
    const srt = await import("@anthropic-ai/sandbox-runtime");
    // This must be srt's own initialize(), not a local stash. It is what starts
    // the filtering proxy and — on Linux — the socat bridge into the child's
    // network namespace. wrapWithSandbox() only *reads* that state: skip this
    // call and the child still gets `--unshare-net`, but with no proxy behind
    // it, so the network allowlist is never consulted and the session has no
    // network at all. That is indistinguishable from a correct empty allowlist,
    // which is why it is easy to miss.
    await srt.SandboxManager.initialize(config);
    this.initialized = true;
  }

  async wrapWithSandbox(
    command: string,
    options?: WrapWithSandboxOptions
  ): Promise<string> {
    if (!this.initialized) {
      throw new Error("Runner not initialized");
    }
    const srt = await import("@anthropic-ai/sandbox-runtime");
    // No per-call policy override: the policy was already installed as the
    // session config by initialize(). Passing it again here would be redundant,
    // and doing so would let a wrapped command keep working even if initialize()
    // had failed — exactly the silent-fallback shape the design forbids.
    //
    // `binShell` is left undefined so srt uses bash. That is deliberate and
    // load-bearing: srt <= 0.0.77 wrapped the command in a trap whose bare
    // `exit` zsh resolves to the status of the trap's last command rather than
    // the script's, so under zsh a failing command reported exit 0. Fixed in
    // 0.0.78, and bash was never affected — but the default is stated here
    // rather than inherited so a future bump cannot quietly reintroduce it.
    return srt.SandboxManager.wrapWithSandbox(
      command,
      undefined,
      undefined,
      undefined,
      options
    );
  }

  async unenforcedGlobWarnings(): Promise<string[]> {
    if (!this.initialized) {
      return [];
    }
    const srt = await import("@anthropic-ai/sandbox-runtime");
    return srt.SandboxManager.getLinuxGlobPatternWarnings();
  }

  async reset(): Promise<void> {
    const srt = await import("@anthropic-ai/sandbox-runtime");
    await srt.SandboxManager.reset();
    this.initialized = false;
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
