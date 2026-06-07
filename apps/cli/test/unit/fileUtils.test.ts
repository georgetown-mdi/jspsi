import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  detectFileConflicts,
  expandTilde,
  writeFileOwnerOnly,
} from "../../src/fileUtils";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fileutils-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- detectFileConflicts -----------------------------------------------------

describe("detectFileConflicts", () => {
  test("returns only the paths that already exist", () => {
    const existing = path.join(dir, "psilink.yaml");
    const missing = path.join(dir, ".psilink.key");
    fs.writeFileSync(existing, "channel: filedrop\n");
    expect(detectFileConflicts([existing, missing])).toEqual([existing]);
  });

  test("returns an empty array when nothing exists", () => {
    expect(
      detectFileConflicts([path.join(dir, "a"), path.join(dir, "b")]),
    ).toEqual([]);
  });

  test("reports a dangling symlink as a conflict", () => {
    // existsSync follows the link and would report this absent; lstatSync sees
    // the link itself, so the gate refuses rather than letting a write follow it.
    const link = path.join(dir, "dangling.yaml");
    fs.symlinkSync(path.join(dir, "no-such-target"), link);
    expect(detectFileConflicts([link])).toEqual([link]);
  });
});

// --- writeFileOwnerOnly ------------------------------------------------------

describe("writeFileOwnerOnly", () => {
  test("writes content and creates missing parent directories", () => {
    const p = path.join(dir, "nested", "deep", "secret");
    writeFileOwnerOnly(p, "x");
    expect(fs.readFileSync(p, "utf8")).toBe("x");
  });

  test("overwrites an existing file by default", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "first");
    writeFileOwnerOnly(p, "second");
    expect(fs.readFileSync(p, "utf8")).toBe("second");
  });

  test("with exclusive, creates a new file", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "only", { exclusive: true });
    expect(fs.readFileSync(p, "utf8")).toBe("only");
  });

  test("with exclusive, refuses to overwrite and preserves the original", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "original", { exclusive: true });
    expect(() => writeFileOwnerOnly(p, "clobber", { exclusive: true })).toThrow(
      /already exists/,
    );
    expect(fs.readFileSync(p, "utf8")).toBe("original");
    // no stray temp file left behind
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  test("writes owner-only (0600) on POSIX", () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "x");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

// --- expandTilde -------------------------------------------------------------

describe("expandTilde", () => {
  const home = os.homedir();

  test("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~")).toBe(home);
  });

  test("expands a leading ~/ to a path under home", () => {
    expect(expandTilde("~/.psilink/signing-identity.json")).toBe(
      path.join(home, ".psilink/signing-identity.json"),
    );
  });

  test("leaves an absolute path unchanged", () => {
    expect(expandTilde("/etc/psilink/id.json")).toBe("/etc/psilink/id.json");
  });

  test("leaves a relative path unchanged", () => {
    expect(expandTilde("./id.json")).toBe("./id.json");
  });

  test("does not expand another user's home (~user)", () => {
    expect(expandTilde("~other/id.json")).toBe("~other/id.json");
  });

  test("does not expand an embedded ~", () => {
    expect(expandTilde("/a/~/b")).toBe("/a/~/b");
  });

  test("passes undefined through (for optional path options)", () => {
    expect(expandTilde(undefined)).toBeUndefined();
  });
});
