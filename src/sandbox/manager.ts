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

  // `ocs` groups these under `srt` because they are the settings that remove
  // the sandbox rather than widen it (invariant 3). `srt` is not however where
  // it reads them: these two live under `network`, the other four at the top
  // level. Spreading all six flat puts two of them somewhere the config schema
  // strips without a word, which turns "allow unix sockets" into a no-op that
  // looks configured.
  const config: any = {
    filesystem,
    network,
  };

  // Add srt settings if present
  if (ocsConfig.srt) {
    for (const [key, value] of Object.entries(ocsConfig.srt)) {
      if (key === "allowAllUnixSockets" || key === "allowLocalBinding") {
        network[key] = value;
      } else {
        config[key] = value;
      }
    }
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
