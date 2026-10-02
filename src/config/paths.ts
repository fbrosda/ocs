import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function normalizePath(p: string): string {
  const expanded = expandTilde(p);
  const resolved = path.resolve(expanded);
  return resolved;
}

export function ensureDir(p: string): void {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

export function getHomeConfigPath(): string {
  const configDir = path.join(os.homedir(), ".config", "ocs");
  ensureDir(configDir);
  return path.join(configDir, "config.json");
}

export function getDefaultProjectConfig(projectPath: string): string {
  return path.join(projectPath, ".ocs", "config.json");
}
