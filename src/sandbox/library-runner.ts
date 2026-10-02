import { SandboxRunner } from "./runner.js";

export class LibraryRunner implements SandboxRunner {
  private initialized = false;

  async initialize(config: any): Promise<void> {
    const srt = await import("@anthropic-ai/sandbox-runtime");
    // This must be srt's own initialize(), not a local stash. It is what
    // starts the filtering proxy and — on Linux — the socat bridge into the
    // child's network namespace. wrapWithSandbox() only *reads* that state:
    // skip this call and the child still gets `--unshare-net`, but with no
    // proxy behind it, so the network allowlist is never consulted and the
    // session has no network at all. That is indistinguishable from a correct
    // empty allowlist, which is why it is easy to miss.
    await srt.SandboxManager.initialize(config);
    this.initialized = true;
  }

  async wrapWithSandbox(command: string, options?: any): Promise<string> {
    if (!this.initialized) {
      throw new Error("Runner not initialized");
    }
    const srt = await import("@anthropic-ai/sandbox-runtime");
    // No per-call override: the policy was already installed as the session
    // config by initialize(). Passing it again here would be redundant, and
    // doing so would let a wrapped command keep working even if initialize()
    // had failed — exactly the silent-fallback shape the design forbids.
    return srt.SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, options);
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
