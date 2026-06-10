import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { getLogger } from "@psilink/core";

import { preflightKeyFilePath } from "../../src/keyFilePreflight";

// Minimal logger stub: the helper only calls log.info (the parent-created
// notice). Capture those messages so the mkdir-side-effect branch can be
// asserted; cast through unknown because the helper's parameter is the full
// loglevel logger type but only `info` is exercised.
function makeLogger(): { log: ReturnType<typeof getLogger>; infos: string[] } {
  const infos: string[] = [];
  const log = {
    info: (...args: unknown[]) => {
      infos.push(args.map(String).join(" "));
    },
  } as unknown as ReturnType<typeof getLogger>;
  return { log, infos };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-preflight-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- missing / whitespace-only path ------------------------------------------

test("rejects a missing (non-string) keyFilePath", () => {
  const { log } = makeLogger();
  expect(() =>
    preflightKeyFilePath(undefined as unknown as string, log),
  ).toThrow("non-empty keyFilePath");
});

test("rejects an empty keyFilePath", () => {
  const { log } = makeLogger();
  expect(() => preflightKeyFilePath("", log)).toThrow("non-empty keyFilePath");
});

test("rejects a whitespace-only keyFilePath", () => {
  const { log } = makeLogger();
  expect(() => preflightKeyFilePath("   ", log)).toThrow(
    "non-empty keyFilePath",
  );
});

// --- trimming ----------------------------------------------------------------

test("trims leading and trailing whitespace and returns the trimmed path", () => {
  const { log } = makeLogger();
  const realKey = path.join(dir, "key.json");
  const result = preflightKeyFilePath(`  ${realKey}  `, log);
  expect(result).toBe(realKey);
  // The whitespace-padded name must never have produced an on-disk artifact.
  expect(fs.readdirSync(dir)).toEqual([]);
});

// --- existing target is not a regular file -----------------------------------

test("rejects when keyFilePath itself is an existing directory", () => {
  const { log } = makeLogger();
  const keyAsDir = path.join(dir, "key-as-directory");
  fs.mkdirSync(keyAsDir);
  expect(() => preflightKeyFilePath(keyAsDir, log)).toThrow(
    "not a regular file",
  );
});

test.skipIf(process.platform === "win32")(
  "accepts a symlink at the key path, even one resolving to a directory",
  () => {
    // saveKeyFile renames a temp file onto the key path, which replaces the
    // symlink itself rather than following it, so a symlink here -- including
    // one resolving to a directory -- is overwritten cleanly and must NOT be
    // rejected. Locks the guard against a future false-positive "reject
    // symlinks" change.
    const { log } = makeLogger();
    const realDir = path.join(dir, "some-dir");
    fs.mkdirSync(realDir);
    const linkAtKeyPath = path.join(dir, "key-symlink");
    fs.symlinkSync(realDir, linkAtKeyPath);
    expect(preflightKeyFilePath(linkAtKeyPath, log)).toBe(linkAtKeyPath);
  },
);

test.skipIf(process.platform === "win32")(
  "rejects when keyFilePath is an existing non-regular node (socket)",
  async () => {
    // A unix-domain socket is a non-regular, non-directory, non-symlink node,
    // so it exercises the guard's "non-regular filesystem entry" arm (distinct
    // from the directory sub-case). Created with net rather than mkfifo so the
    // test needs no external command.
    const { log } = makeLogger();
    const sockPath = path.join(dir, "key.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      expect(() => preflightKeyFilePath(sockPath, log)).toThrow(
        "non-regular filesystem entry",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

// --- parent directory checks -------------------------------------------------

test("rejects when the parent exists but is a regular file", () => {
  const { log } = makeLogger();
  const fileParent = path.join(dir, "not-a-dir");
  fs.writeFileSync(fileParent, "");
  expect(() =>
    preflightKeyFilePath(path.join(fileParent, "key.json"), log),
  ).toThrow("exists but is not a directory");
});

test("creates the parent directory when it does not yet exist", () => {
  const { log, infos } = makeLogger();
  const createdParent = path.join(dir, "newly-created", "nested");
  expect(fs.existsSync(createdParent)).toBe(false);
  const keyFilePath = path.join(createdParent, "key.json");
  const result = preflightKeyFilePath(keyFilePath, log);
  expect(result).toBe(keyFilePath);
  expect(fs.existsSync(createdParent)).toBe(true);
  // The mkdir side effect is surfaced to the user.
  expect(
    infos.some((m) => m.includes("created keyFilePath parent directory")),
  ).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "rejects when the parent is a dangling symlink",
  () => {
    const { log } = makeLogger();
    const target = path.join(dir, "missing-target");
    const link = path.join(dir, "dangling-link");
    fs.symlinkSync(target, link);
    expect(() =>
      preflightKeyFilePath(path.join(link, "key.json"), log),
    ).toThrow("dangling");
  },
);

test.skipIf(process.platform === "win32")(
  "rejects when the parent directory is not writable",
  () => {
    // root bypasses mode bits, so the probe would succeed; skip there.
    if (process.getuid?.() === 0) return;
    const { log } = makeLogger();
    const readOnlyDir = path.join(dir, "readonly");
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o555);
    try {
      expect(() =>
        preflightKeyFilePath(path.join(readOnlyDir, "key.json"), log),
      ).toThrow("not writable");
    } finally {
      // Restore mode so afterEach can remove the tmp dir.
      fs.chmodSync(readOnlyDir, 0o755);
    }
  },
);

// --- valid cases -------------------------------------------------------------

test("accepts a non-existent path under an existing writable directory", () => {
  const { log } = makeLogger();
  const keyFilePath = path.join(dir, "key.json");
  const result = preflightKeyFilePath(keyFilePath, log);
  expect(result).toBe(keyFilePath);
  // The write probe must clean up after itself, leaving no litter.
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("accepts an existing regular file at the key path", () => {
  const { log } = makeLogger();
  const keyFilePath = path.join(dir, "existing.key");
  fs.writeFileSync(keyFilePath, "{}");
  const result = preflightKeyFilePath(keyFilePath, log);
  expect(result).toBe(keyFilePath);
  // Only the pre-existing file remains; the probe left nothing behind.
  expect(fs.readdirSync(dir)).toEqual(["existing.key"]);
});
