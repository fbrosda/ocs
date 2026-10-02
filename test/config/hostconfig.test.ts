import { describe, it, expect } from "vitest";
import { applyHostConfig, mergeConfigs } from "../../src/config/merge.js";
import { getDefaultHostConfig } from "../../src/config/defaults.js";

/**
 * How the user's own config layers over the built-in defaults.
 *
 * This is the one place where "project config may only add" does not apply,
 * because the host file is the file the user edits. These tests exist mostly to
 * pin down a bug that was quiet and load-bearing: the previous implementation
 * shallow-spread the file over the defaults, so adding one glob to
 * `protected.read` deleted the built-in `.env` protection. Nothing errored; a
 * committed secret just became readable.
 */
describe("applyHostConfig", () => {
  it("keeps the built-in credential protection when a glob is added", () => {
    const result = applyHostConfig(getDefaultHostConfig(), {
      protected: { read: ["**/*.tfstate"] },
    });

    expect(result.protected.read).toContain("**/.env");
    expect(result.protected.read).toContain("**/*.tfstate");
  });

  it("keeps the system read grants when a mount is added", () => {
    // The other half of the same bug: losing `/usr` leaves a sandbox with no
    // userland, which looks like ocs being broken rather than misconfigured.
    const result = applyHostConfig(getDefaultHostConfig(), {
      mounts: { read: ["/opt/some-tool"] },
    });

    expect(result.mounts.read).toContain("/usr");
    expect(result.mounts.read).toContain("/opt/some-tool");
  });

  it("adds a domain to the built-in ones rather than replacing them", () => {
    // Trust does not mean "may narrow by omission". There is no subtract syntax
    // on any channel in this tool, precisely so that a config edit can never be
    // the reason a protection quietly stops applying.
    const result = applyHostConfig(getDefaultHostConfig(), {
      network: { allow: ["api.example.com"] },
    });

    expect(result.network.allow).toContain("api.example.com");
    expect(result.network.allow).toContain("opencode.ai");
  });

  it("does not treat an empty list as a request to clear the defaults", () => {
    const result = applyHostConfig(getDefaultHostConfig(), {
      network: { allow: [] },
    });

    expect(result.network.allow.length).toBeGreaterThan(0);
  });

  it("does not duplicate a default the user restates", () => {
    const defaults = getDefaultHostConfig();
    const restated = defaults.network.allow[0];

    const result = applyHostConfig(defaults, {
      network: { allow: [restated] },
    });

    expect(result.network.allow.filter((d) => d === restated)).toHaveLength(1);
  });

  it("treats an empty file as no change at all", () => {
    const defaults = getDefaultHostConfig();

    expect(applyHostConfig(defaults, {})).toEqual(defaults);
  });

  it("lets a scalar be overridden, including to false", () => {
    // The `false` case is the one a truthiness check would get wrong.
    const result = applyHostConfig(getDefaultHostConfig(), {
      srt: { allowLocalBinding: true, mandatoryDenySearchDepth: 5 },
    });

    expect(result.srt?.allowLocalBinding).toBe(true);
    expect(result.srt?.mandatoryDenySearchDepth).toBe(5);

    const off = applyHostConfig(getDefaultHostConfig(), {
      srt: { mandatoryDenySearchDepth: 0 },
    });
    expect(off.srt?.mandatoryDenySearchDepth).toBe(0);
  });

  it("still leaves project config unable to subtract", async () => {
    // The distinction that matters: replacement is a *host* privilege. A project
    // adding an allow entry must not be able to drop one.
    const host = applyHostConfig(getDefaultHostConfig(), {
      network: { allow: ["api.example.com"] },
    });

    const { config } = await mergeConfigs(host, {}, "/tmp");

    expect(config.network.allow).toContain("api.example.com");
  });

  it("reports a malformed host list, naming the key and where to fix it", () => {
    // Refused rather than coerced. Spreading a string here would produce twelve
    // one-character "domains", which is the kind of wrong value that passes a
    // length check and fails much later at the proxy.
    expect(() =>
      applyHostConfig(getDefaultHostConfig(), {
        network: { allow: "not-an-array" as unknown as string[] },
      })
    ).toThrow(/network\.allow.*must be an array of strings/s);
  });
});
