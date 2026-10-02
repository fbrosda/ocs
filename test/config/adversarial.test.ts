import { describe, it, expect } from "vitest";
import { mergeConfigs, ConfigError } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("adversarial cases", () => {
  let tmpDir: string;

  it("rejects mounts.write to root", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { write: ["/"] } }, tmpDir)
    ).rejects.toThrow(ConfigError);
  });

  it("rejects mounts.read to home", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { read: ["~"] } }, tmpDir)
    ).rejects.toThrow(ConfigError);
  });

  it("rejects srt.allowAppleEvents from project", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { srt: { allowAppleEvents: true } }, tmpDir)
    ).rejects.toThrow(ConfigError);
  });

  it("rejects srt.enableWeakerNestedSandbox from project", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { srt: { enableWeakerNestedSandbox: true } }, tmpDir)
    ).rejects.toThrow(ConfigError);
  });
});
