import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  UsageError,
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "@psilink/core";
import {
  defaultSigningIdentityPath,
  loadSigningIdentity,
  saveSigningIdentity,
} from "../../src/signingIdentityFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-sign-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadSigningIdentity returns undefined when the file does not exist", () => {
  expect(loadSigningIdentity(path.join(dir, "missing.json"))).toBeUndefined();
});

test("save then load round-trips and preserves the fingerprint", async () => {
  const idPath = path.join(dir, "signing-identity.json");
  const id = generateSigningIdentity("Party A, Agency A");
  saveSigningIdentity(idPath, id);
  const before = await computeCertificateFingerprint(id.certificate);

  const loaded = loadSigningIdentity(idPath);
  expect(loaded).toEqual(id);
  expect(await computeCertificateFingerprint(loaded!.certificate)).toBe(before);
});

test("saveSigningIdentity writes the file owner-read-only on Unix", () => {
  if (process.platform === "win32") return;
  const idPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(idPath, generateSigningIdentity("Party A"));
  const mode = fs.statSync(idPath).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("saveSigningIdentity creates parent directories", () => {
  const idPath = path.join(dir, "nested", "deeper", "signing-identity.json");
  saveSigningIdentity(idPath, generateSigningIdentity("Party A"));
  expect(fs.existsSync(idPath)).toBe(true);
});

test("loadSigningIdentity throws UsageError on invalid JSON", () => {
  const idPath = path.join(dir, "bad.json");
  fs.writeFileSync(idPath, "{ not json", { mode: 0o600 });
  expect(() => loadSigningIdentity(idPath)).toThrow(UsageError);
});

test("loadSigningIdentity does not echo file content on an invalid-JSON file", () => {
  // The identity file holds the Ed25519 private key. A JSON parse failure must
  // report path-only: Node's JSON.parse echoes a snippet of the source start in
  // its message (here exactly the leading 10 chars), so a file that begins with
  // the key would otherwise leak it. The 10-char marker leads the file so the old
  // (content-echoing) path would surface it; the guard must not.
  const idPath = path.join(dir, "leaky.json");
  const MARKER = "LEAKME1234";
  fs.writeFileSync(idPath, `${MARKER} not json`, { mode: 0o600 });
  let caught: unknown;
  try {
    loadSigningIdentity(idPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(idPath);
  expect((caught as Error).message).toContain("could not be parsed as JSON");
  expect((caught as Error).message).not.toContain(MARKER);
});

test("loadSigningIdentity throws UsageError on a malformed identity", () => {
  const idPath = path.join(dir, "malformed.json");
  fs.writeFileSync(idPath, JSON.stringify({ version: "wrong" }), {
    mode: 0o600,
  });
  expect(() => loadSigningIdentity(idPath)).toThrow(UsageError);
});

test("loadSigningIdentity throws UsageError on a tampered (inconsistent) identity", () => {
  const idPath = path.join(dir, "tampered.json");
  const id = generateSigningIdentity("Party A");
  const other = generateSigningIdentity("Party A");
  // swap in a private key that no longer matches the certificate's public key
  id.privateKey.d = other.privateKey.d;
  fs.writeFileSync(idPath, JSON.stringify(id), { mode: 0o600 });
  expect(() => loadSigningIdentity(idPath)).toThrow(UsageError);
});

test("defaultSigningIdentityPath is per-user, not per-working-directory", () => {
  const p = defaultSigningIdentityPath();
  expect(p.startsWith(os.homedir())).toBe(true);
  expect(p.endsWith(path.join(".psilink", "signing-identity.json"))).toBe(true);
});
