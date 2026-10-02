import * as fs from "fs";
import * as path from "path";
import { OcsConfig, OcsConfigSchema, Provenance, ProvenanceEntry, SrtKeys } from "./types.js";
import { normalizePath } from "./paths.js";

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function unionArrays(a: string[], b: string[]): string[] {
  const set = new Set(a);
  for (const item of b) {
    set.add(item);
  }
  return Array.from(set);
}

export class ConfigError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadJsonConfig(filePath: string): any {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (e: any) {
    throw new ConfigError(`Failed to parse config at ${filePath}: ${e.message}`);
  }
}

export function isInsideProject(projectPath: string, candidate: string): boolean {
  const proj = normalizePath(projectPath);
  const cand = normalizePath(candidate);
  if (cand === proj) return true;
  if (cand.startsWith(proj + path.sep)) return true;
  return false;
}

function resolvePathWithContainment(projectPath: string, candidate: string): { ok: boolean; reason?: string; absolute: string } {
  const proj = normalizePath(projectPath);
  try {
    const expanded = candidate.startsWith("~") ? path.join(process.env.HOME || process.env.USERPROFILE || "", candidate.slice(1)) : candidate;
    // Resolve relative to project path if not absolute
    let abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(proj, expanded);
    let checkPath = abs;
    try {
      if (fs.existsSync(abs)) {
        abs = fs.realpathSync(abs);
        checkPath = abs;
      } else {
        // For non-existent paths, check ancestor
        let current = abs;
        let found = false;
        while (current !== path.dirname(current)) {
          if (fs.existsSync(current)) {
            try {
              const real = fs.realpathSync(current);
              checkPath = real;
            } catch (e) {
              checkPath = current;
            }
            found = true;
            break;
          }
          current = path.dirname(current);
        }
        if (!found) {
          checkPath = abs;
        }
      }
    } catch (e) {
      // ignore
    }
    const projNorm = normalizePath(proj);
    const sep = path.sep;
    const projNorm2 = normalizePath(proj);
    if (checkPath === projNorm2) return { ok: true, absolute: abs };
    if (checkPath.startsWith(projNorm2 + sep)) return { ok: true, absolute: abs };
    // Always reject if it doesn't start with project root AND isn't in allowed globals
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const allowedGlobals = [
      path.join(home, ".config", "opencode"),
      path.join(home, ".local", "share", "opencode"),
      path.join(home, ".cache", "opencode"),
      path.join(home, ".local", "state", "opencode"),
      path.join(home, ".config", "ocs"),
      "/tmp",
      "/var/tmp",
    ].map(g => normalizePath(g));
    for (const g of allowedGlobals) {
      const gNorm = normalizePath(g);
      if (checkPath === gNorm || checkPath.startsWith(gNorm + sep)) {
        return { ok: true, absolute: abs };
      }
    }
    return { ok: false, reason: `Path ${candidate} resolves outside project and not in global grants`, absolute: abs };
  } catch (e: any) {
    return { ok: false, reason: e.message, absolute: candidate };
  }
}

export function validateContainment(projectPath: string, paths: string[]): void {
  for (const p of paths) {
    const res = resolvePathWithContainment(projectPath, p);
    if (!res.ok) {
      throw new ConfigError(res.reason || `Invalid path: ${p}`);
    }
  }
}

export async function mergeConfigs(hostConfig: any, projectConfig: any, projectPath: string): Promise<{ config: OcsConfig; provenance: Provenance }> {
  const host = OcsConfigSchema.parse(hostConfig || {});
  const projectRaw = projectConfig || {};
  
  // Check for srt keys in project - hard error
  if (projectRaw.srt && typeof projectRaw.srt === "object") {
    for (const k of Object.keys(projectRaw.srt)) {
      if (SrtKeys.includes(k as any)) {
        throw new ConfigError(`Project config cannot set srt.${k} - srt keys are host-only`);
      }
    }
  }
  
  const project = OcsConfigSchema.parse(projectRaw);
  
  // Validate protected patterns for portability
  const { validateProtectedPatterns } = await import("../sandbox/validator.js");
  validateProtectedPatterns(project.protected.read || []);
  validateProtectedPatterns(project.protected.write || []);
  
  // Validate containment for project paths
  validateContainment(projectPath, project.mounts.read);
  validateContainment(projectPath, project.mounts.write);
  
  // Merge
  const resolvedProjectMountsRead = project.mounts.read.map((p) => {
    const res = resolvePathWithContainment(projectPath, p);
    return res.absolute;
  });
  const resolvedProjectMountsWrite = project.mounts.write.map((p) => {
    const res = resolvePathWithContainment(projectPath, p);
    return res.absolute;
  });

  const merged: OcsConfig = {
    network: {
      allow: unionArrays(host.network.allow, project.network.allow),
      deny: unionArrays(host.network.deny, project.network.deny),
    },
    mounts: {
      read: unionArrays(host.mounts.read, resolvedProjectMountsRead),
      write: unionArrays(host.mounts.write, resolvedProjectMountsWrite),
    },
    protected: {
      read: unionArrays(host.protected.read, project.protected.read),
      write: unionArrays(host.protected.write, project.protected.write),
    },
    srt: {
      ...host.srt,
    },
  };
  
  // Build provenance
  const provenance: Provenance = {
    network: {
      allow: [],
      deny: [],
    },
    mounts: {
      read: [],
      write: [],
    },
    protected: {
      read: [],
      write: [],
    },
    srt: {},
  };
  
  // Helper to add provenance
  const addProv = (arr: ProvenanceEntry[], values: string[], source: "host" | `project:${string}`) => {
    for (const v of values) {
      arr.push({ source, value: v });
    }
  };
  
  const projName = path.basename(normalizePath(projectPath));
  addProv(provenance.network.allow, host.network.allow, "host");
  addProv(provenance.network.allow, project.network.allow, `project:${projName}`);
  addProv(provenance.network.deny, host.network.deny, "host");
  addProv(provenance.network.deny, project.network.deny, `project:${projName}`);
  addProv(provenance.mounts.read, host.mounts.read, "host");
  addProv(provenance.mounts.read, project.mounts.read, `project:${projName}`);
  addProv(provenance.mounts.write, host.mounts.write, "host");
  addProv(provenance.mounts.write, project.mounts.write, `project:${projName}`);
  addProv(provenance.protected.read, host.protected.read, "host");
  addProv(provenance.protected.read, project.protected.read, `project:${projName}`);
  addProv(provenance.protected.write, host.protected.write, "host");
  addProv(provenance.protected.write, project.protected.write, `project:${projName}`);
  
  if (host.srt) {
    for (const k of Object.keys(host.srt)) {
      provenance.srt[k] = { source: "host", value: (host.srt as any)[k] };
    }
  }
  
  return { config: merged, provenance };
}
