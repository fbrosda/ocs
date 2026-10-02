import { SandboxRunner } from "./runner.js";
import { LibraryRunner } from "./library-runner.js";
import { OcsConfig } from "../config/types.js";
import * as path from "path";
import * as os from "os";

export function buildSrtConfig(ocsConfig: OcsConfig, projectPath: string): any {
  const home = os.homedir();
  
  // Build filesystem config
  const filesystem: any = {
    denyRead: [
      home,
      ...(ocsConfig.protected.read || []),
    ],
    allowRead: [
      projectPath,
      ...(ocsConfig.mounts.read || []),
    ],
    allowWrite: [
      projectPath,
      path.join(home, ".config", "opencode"),
      path.join(home, ".local", "share", "opencode"),
      path.join(home, ".cache", "opencode"),
      path.join(home, ".local", "state", "opencode"),
      "/tmp",
      "/var/tmp",
      ...(ocsConfig.mounts.write || []),
    ],
    denyWrite: [
      ...(ocsConfig.protected.write || []),
    ],
  };

  const network: any = {
    allowedDomains: ocsConfig.network.allow || [],
    deniedDomains: ocsConfig.network.deny || [],
  };

  const config: any = {
    filesystem,
    network,
  };

  // Add srt settings if present
  if (ocsConfig.srt) {
    Object.assign(config, ocsConfig.srt);
  }

  return config;
}

export class SandboxManager {
  private runner: SandboxRunner;

  constructor(runner?: SandboxRunner) {
    this.runner = runner || new LibraryRunner();
  }

  async initialize(ocsConfig: OcsConfig, projectPath: string): Promise<void> {
    const srtConfig = buildSrtConfig(ocsConfig, projectPath);
    await this.runner.initialize(srtConfig);
  }

  async wrap(command: string, options?: any): Promise<string> {
    return this.runner.wrapWithSandbox(command, options);
  }

  async reset(): Promise<void> {
    return this.runner.reset();
  }

  async close(): Promise<void> {
    return this.runner.close();
  }
}
