import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { anchorReadDenyGlobs, hasLiteralBase } from "../../src/config/globs.js";

describe("hasLiteralBase", () => {
  it("accepts patterns that name a directory to walk from", () => {
    expect(hasLiteralBase("/home/me/proj/.env")).toBe(true);
    expect(hasLiteralBase("/home/me/proj/.env")).toBe(true);
    expect(hasLiteralBase("proj/.env")).toBe(true);
    expect(hasLiteralBase(".env")).toBe(true);
    expect(hasLiteralBase("/home/me/proj/**")).toBe(true);
  });

  it("rejects patterns whose only prefix is a wildcard", () => {
    // These are the shapes `srt` cannot expand on Linux: the walk has no
    // literal directory to start from, so it returns nothing and the deny is
    // left unenforced while still looking configured.
    expect(hasLiteralBase("**/.env")).toBe(false);
    expect(hasLiteralBase("**")).toBe(false);
    expect(hasLiteralBase("*.pem")).toBe(false);
    expect(hasLiteralBase("?/x")).toBe(false);
    expect(hasLiteralBase("[ab]")).toBe(false);
  });

  it("rejects root-anchored wildcards", () => {
    // Absolute, so `path.isAbsolute` is satisfied, but the static prefix stops
    // at "/" — still nowhere for the walk to start.
    expect(hasLiteralBase("**/.pem")).toBe(false);
    expect(hasLiteralBase("/.env")).toBe(true);
  });
});

describe("anchorReadDenyGlobs", () => {
  let project: string;
  let other: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-anchor-project-"));
    other = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-anchor-other-"));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("anchors a relative pattern under every anchor", () => {
    const result = anchorReadDenyGlobs(["**/.env"], [project, other]);

    expect(result).toEqual([
      path.join(project, "**/.env"),
      path.join(other, "**/.env"),
    ]);
  });

  it("produces patterns that have a literal base", () => {
    // The property that matters: after anchoring, nothing can be silently
    // unenforced for want of a directory to walk from.
    const result = anchorReadDenyGlobs(
      ["**/.env", "secrets/**", "id_rsa*"],
      [project]
    );

    expect(result.length).toBeGreaterThan(0);
    for (const pattern of result) {
      expect(hasLiteralBase(pattern)).toBe(true);
      expect(path.isAbsolute(pattern)).toBe(true);
    }
  });

  it("leaves absolute patterns alone", () => {
    const absolute = path.join(project, "config", "*.pem");

    // The user already said where they meant; anchoring a second copy under
    // every root would widen the deny beyond what was asked for.
    expect(anchorReadDenyGlobs([absolute], [project, other])).toEqual([
      absolute,
    ]);
  });

  it("deduplicates repeated patterns and anchors", () => {
    const result = anchorReadDenyGlobs(
      ["**/.env", "**/.env"],
      [project, project]
    );

    expect(result).toEqual([path.join(project, "**/.env")]);
  });

  it("expands a leading tilde before deciding", () => {
    const result = anchorReadDenyGlobs(["~/.aws/**/credentials"], [project]);

    expect(path.isAbsolute(result[0])).toBe(true);
    expect(result[0]).toBe(
      path.join(os.homedir(), ".aws", "**", "credentials")
    );
  });

  it("still emits a relative pattern when there is nothing to anchor against", () => {
    // Left for the validator to reject rather than silently dropped: dropping a
    // deny the user asked for would be a policy weaker than the one they wrote.
    expect(anchorReadDenyGlobs(["**/.env"], [])).toEqual(["**/.env"]);
  });
});
