import { SandboxRunner } from "./runner.js";
import { getDefaultHostConfig } from "../config/defaults.js";

export class LibraryRunner implements SandboxRunner {
  private initialized = false;

  async initialize(config: any): Promise<void> {
    // Store config - srt will be initialized when wrapping
    this.config = config;
    this.initialized = true;
  }

  private config: any;

  async wrapWithSandbox(command: string, options?: any): Promise<string> {
    if (!this.initialized) {
      throw new Error("Runner not initialized");
    }
    const srt = await import("@anthropic-ai/sandbox-runtime");
    const wrapped = await srt.SandboxManager.wrapWithSandbox(command, undefined, this.config, undefined, options);
    return wrapped;
  }

  async reset(): Promise<void> {
    const srt = await import("@anthropic-ai/sandbox-runtime");
    await srt.SandboxManager.reset();
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
