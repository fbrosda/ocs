import { describe, it, expect, beforeEach } from "vitest";
import { mergeConfigs, ConfigError } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("containment edge cases", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-test-"));
    projectDir = tmpDir;
  });

  it("accepts ./src, src/, /abs/project/src", async () => {
    fs.mkdirSync(path.join(projectDir, "src"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { read: ["./src"] } }, projectDir)
    ).resolves.not.toThrow();
    await expect(
      mergeConfigs(host, { mounts: { read: ["src/"] } }, projectDir)
    ).resolves.not.toThrow();
    await expect(
      mergeConfigs(
        host,
        { mounts: { read: [path.join(projectDir, "src")] } },
        projectDir
      )
    ).resolves.not.toThrow();
  });

  it("rejects ../sibling", async () => {
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { read: ["../../etc"] } }, projectDir)
    ).rejects.toThrow(ConfigError);
  });

  it("rejects ~/.aws", async () => {
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { read: ["~/.aws"] } }, projectDir)
    ).rejects.toThrow(ConfigError);
  });

  it("rejects /, /home, /usr", async () => {
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { read: ["/"] } }, projectDir)
    ).rejects.toThrow(ConfigError);
    await expect(
      mergeConfigs(host, { mounts: { read: ["/home"] } }, projectDir)
    ).rejects.toThrow(ConfigError);
  });

  it("accepts build/out if nearest existing ancestor is inside project", async () => {
    fs.mkdirSync(path.join(projectDir, "build"));
    const host = getDefaultHostConfig();
    await expect(
      mergeConfigs(host, { mounts: { write: ["build/out"] } }, projectDir)
    ).resolves.not.toThrow();
  });
});
