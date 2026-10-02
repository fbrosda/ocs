import { describe, it, expect, beforeEach } from "vitest";
import {
  mergeConfigs,
  ConfigError,
  validateContainment,
} from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("merge configs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
  });

  it("should merge host and project configs", async () => {
    const host = getDefaultHostConfig();
    const project = {
      network: { allow: ["example.com"] },
    };
    const result = await mergeConfigs(host, project, tmpDir);
    expect(result.config.network.allow).toContain("example.com");
  });

  it("should reject srt keys in project config", async () => {
    const host = getDefaultHostConfig();
    const project = {
      srt: { allowAppleEvents: true },
    };
    await expect(mergeConfigs(host, project, tmpDir)).rejects.toThrow(ConfigError);
  });

  it("should reject paths outside project", async () => {
    const host = getDefaultHostConfig();
    const project = {
      mounts: { write: ["/etc"] },
    };
    await expect(mergeConfigs(host, project, tmpDir)).rejects.toThrow(ConfigError);
  });

  it("should allow paths inside project", async () => {
    const host = getDefaultHostConfig();
    // Create the src dir first
    fs.mkdirSync(path.join(tmpDir, "src"));
    const project = {
      mounts: { write: ["./src"] },
    };
    const result = await mergeConfigs(host, project, tmpDir);
    // src is inside project, so it should be in the merged write list
    expect(result.config.mounts.write.some((w) => w.startsWith(tmpDir))).toBe(
      true
    );
  });
});
