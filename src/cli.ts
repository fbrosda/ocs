#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { loadJsonConfig, mergeConfigs, ConfigError } from "./config/merge.js";
import { getHomeConfigPath, getDefaultProjectConfig, normalizePath } from "./config/paths.js";
import { getDefaultHostConfig } from "./config/defaults.js";

const program = new Command();

program
  .name("ocs")
  .description("OpenCode Sandbox")
  .version("0.0.1")
  .argument("[project-path]", "Project path", process.cwd())
  .option("-m, --mount <path>", "Extra read-only mount", (v, p) => p.concat(v), [] as string[])
  .option("-w, --mount-write <path>", "Extra writable mount", (v, p) => p.concat(v), [] as string[])
  .option("-n, --domain <domain>", "Allowed domain", (v, p) => p.concat(v), [] as string[])
  .option("-c, --config <path>", "Alternate project config")
  .option("--print-config", "Print compiled config and exit")
  .option("--explain", "Annotate with origins")
  .option("--debug", "Enable debug")
  .option("-y, --yes", "Do not prompt")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (projectPathArg, options, command) => {
    try {
      const projectPath = normalizePath(projectPathArg);
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        console.error(`Project path does not exist or is not a directory: ${projectPath}`);
        process.exit(1);
      }

      const homeConfigPath = getHomeConfigPath();
      const hostConfig = { ...getDefaultHostConfig(), ...loadJsonConfig(homeConfigPath) };
      
      const projConfigPath = options.config || getDefaultProjectConfig(projectPath);
      const projConfig = loadJsonConfig(projConfigPath);
      
      // Apply CLI overrides
      if (options.domain && options.domain.length > 0) {
        projConfig.network = projConfig.network || {};
        projConfig.network.allow = [...(projConfig.network.allow || []), ...options.domain];
      }
      if (options.mount && options.mount.length > 0) {
        projConfig.mounts = projConfig.mounts || {};
        projConfig.mounts.read = [...(projConfig.mounts.read || []), ...options.mount];
      }
      if (options.mountWrite && options.mountWrite.length > 0) {
        projConfig.mounts = projConfig.mounts || {};
        projConfig.mounts.write = [...(projConfig.mounts.write || []), ...options.mountWrite];
      }

      const merged = await mergeConfigs(hostConfig, projConfig, projectPath);
      const { config, provenance } = merged;

      if (options.printConfig) {
        if (options.explain) {
          console.log(JSON.stringify({ config, provenance }, null, 2));
        } else {
          console.log(JSON.stringify(config, null, 2));
        }
        process.exit(0);
      }

      const { SandboxManager } = await import("./sandbox/manager.js");
      const manager = new SandboxManager();
      try {
        await manager.initialize(config, projectPath);
        process.chdir(projectPath);
        const cmd = program.args.length > 0 ? program.args.join(" ") : "opencode";
        const wrapped = await manager.wrap(cmd);
        const { spawn } = await import("child_process");
        const child = spawn("sh", ["-c", wrapped], {
          stdio: "inherit",
          cwd: projectPath,
        });
        child.on("exit", async (code) => {
          await manager.reset();
          process.exit(code || 0);
        });
        child.on("error", async (err) => {
          console.error(err);
          await manager.reset();
          process.exit(1);
        });
        process.on("SIGINT", () => {
          child.kill("SIGINT");
        });
        process.on("SIGTERM", () => {
          child.kill("SIGTERM");
        });
      } catch (err: any) {
        console.error(err.message || err);
        await manager.reset();
        process.exit(1);
      }
    } catch (e: any) {
      if (e instanceof ConfigError) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      console.error(e);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Initialize ocs configuration")
  .action(() => {
    const homeConfigPath = getHomeConfigPath();
    const home = os.homedir();
    const defaultHost = getDefaultHostConfig();
    // Try to infer from opencode config
    const opencodeConfigPath = path.join(home, ".config", "opencode", "opencode.json");
    if (fs.existsSync(opencodeConfigPath)) {
      try {
        const oc = JSON.parse(fs.readFileSync(opencodeConfigPath, "utf-8"));
        // Simple inference - look for provider configs
        if (oc.providers) {
          console.log("Inferring providers from", opencodeConfigPath);
        }
      } catch (e) {
        // ignore
      }
    }
    if (!fs.existsSync(homeConfigPath)) {
      fs.writeFileSync(homeConfigPath, JSON.stringify(defaultHost, null, 2));
      console.log("Created", homeConfigPath);
    } else {
      console.log("Config already exists:", homeConfigPath);
    }
  });

program.parse(process.argv);
