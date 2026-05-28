import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";

// 43-char base64url token satisfying the pakeToken format constraint.
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- loadKeyFile -------------------------------------------------------------

test("loadKeyFile returns undefined when the file does not exist", () => {
  const result = loadKeyFile(path.join(dir, "missing.key"));
  expect(result).toBeUndefined();
});

test("loadKeyFile parses a valid key file with pakeToken and expires", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      pakeToken: TOKEN,
      expires: "2027-01-01T00:00:00.000Z",
    }),
  );
  const result = loadKeyFile(keyPath);
  expect(result?.pakeToken).toBe(TOKEN);
  expect(result?.expires).toBe("2027-01-01T00:00:00.000Z");
});

test("loadKeyFile parses a valid key file with pakeToken only", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(keyPath, JSON.stringify({ pakeToken: TOKEN }));
  const result = loadKeyFile(keyPath);
  expect(result?.pakeToken).toBe(TOKEN);
  expect(result?.expires).toBeUndefined();
});

test("loadKeyFile throws when pakeToken is missing", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ expires: "2027-01-01T00:00:00.000Z" }),
  );
  expect(() => loadKeyFile(keyPath)).toThrow();
});

test("loadKeyFile throws when pakeToken is empty", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(keyPath, JSON.stringify({ pakeToken: "" }));
  expect(() => loadKeyFile(keyPath)).toThrow();
});

test("loadKeyFile throws when expires is not a valid ISO 8601 datetime", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ pakeToken: TOKEN, expires: "not-a-date" }),
  );
  expect(() => loadKeyFile(keyPath)).toThrow();
});

// --- saveKeyFile -------------------------------------------------------------

test("saveKeyFile writes a file that loadKeyFile can read back", () => {
  const keyPath = path.join(dir, ".psilink.key");
  saveKeyFile(keyPath, {
    pakeToken: TOKEN,
    expires: "2028-06-01T12:00:00.000Z",
  });
  const result = loadKeyFile(keyPath);
  expect(result?.pakeToken).toBe(TOKEN);
  expect(result?.expires).toBe("2028-06-01T12:00:00.000Z");
});

test("saveKeyFile writes valid JSON with a trailing newline", () => {
  const keyPath = path.join(dir, ".psilink.key");
  saveKeyFile(keyPath, { pakeToken: TOKEN });
  const raw = fs.readFileSync(keyPath, "utf8");
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(raw.endsWith("\n")).toBe(true);
});

test("saveKeyFile rejects a malformed pakeToken before writing to disk", () => {
  const keyPath = path.join(dir, ".psilink.key");
  expect(() => saveKeyFile(keyPath, { pakeToken: "too-short" })).toThrow(
    "base64url-encoded 32-byte value",
  );
  // No file should have been written.
  expect(fs.existsSync(keyPath)).toBe(false);
});
