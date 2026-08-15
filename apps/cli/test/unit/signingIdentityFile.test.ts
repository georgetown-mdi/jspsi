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
  loadSigningCertificate,
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

test("loadSigningIdentity resolves undefined when the file does not exist", async () => {
  await expect(
    loadSigningIdentity(path.join(dir, "missing.json")),
  ).resolves.toBeUndefined();
});

test("save then load round-trips and preserves the fingerprint", async () => {
  const idPath = path.join(dir, "signing-identity.json");
  const id = await generateSigningIdentity("Party A, Agency A");
  saveSigningIdentity(idPath, id);
  const before = await computeCertificateFingerprint(id.certificate);

  const loaded = await loadSigningIdentity(idPath);
  expect(loaded).toEqual(id);
  expect(await computeCertificateFingerprint(loaded!.certificate)).toBe(before);
});

test("saveSigningIdentity writes the file owner-read-only on Unix", async () => {
  if (process.platform === "win32") return;
  const idPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(idPath, await generateSigningIdentity("Party A"));
  const mode = fs.statSync(idPath).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("saveSigningIdentity creates parent directories", async () => {
  const idPath = path.join(dir, "nested", "deeper", "signing-identity.json");
  saveSigningIdentity(idPath, await generateSigningIdentity("Party A"));
  expect(fs.existsSync(idPath)).toBe(true);
});

test("loadSigningIdentity rejects with UsageError on invalid JSON", async () => {
  const idPath = path.join(dir, "bad.json");
  fs.writeFileSync(idPath, "{ not json", { mode: 0o600 });
  await expect(loadSigningIdentity(idPath)).rejects.toThrow(UsageError);
});

test("loadSigningIdentity does not echo file content on an invalid-JSON file", async () => {
  // The identity file holds the P-256 private key. A JSON parse failure must
  // report path-only: Node's JSON.parse echoes a snippet of the source start in
  // its message (here exactly the leading 10 chars), so a file that begins with
  // the key would otherwise leak it. The 10-char marker leads the file so the old
  // (content-echoing) path would surface it; the guard must not.
  const idPath = path.join(dir, "leaky.json");
  const MARKER = "LEAKME1234";
  fs.writeFileSync(idPath, `${MARKER} not json`, { mode: 0o600 });
  let caught: unknown;
  try {
    await loadSigningIdentity(idPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(idPath);
  expect((caught as Error).message).toContain("could not be parsed as JSON");
  expect((caught as Error).message).not.toContain(MARKER);
});

test("loadSigningIdentity rejects with UsageError on a malformed identity", async () => {
  const idPath = path.join(dir, "malformed.json");
  fs.writeFileSync(idPath, JSON.stringify({ version: "wrong" }), {
    mode: 0o600,
  });
  await expect(loadSigningIdentity(idPath)).rejects.toThrow(UsageError);
});

test("loadSigningIdentity rejects with UsageError on a tampered (inconsistent) identity", async () => {
  const idPath = path.join(dir, "tampered.json");
  const id = await generateSigningIdentity("Party A");
  const other = await generateSigningIdentity("Party A");
  // swap in a private key that no longer matches the certificate's public key
  id.privateKey = other.privateKey;
  fs.writeFileSync(idPath, JSON.stringify(id), { mode: 0o600 });
  await expect(loadSigningIdentity(idPath)).rejects.toThrow(UsageError);
});

test("loadSigningCertificate resolves undefined when the file does not exist", async () => {
  await expect(
    loadSigningCertificate(path.join(dir, "missing.json")),
  ).resolves.toBeUndefined();
});

test("loadSigningCertificate returns the identity's certificate", async () => {
  const idPath = path.join(dir, "signing-identity.json");
  const id = await generateSigningIdentity("Party A, Agency A");
  saveSigningIdentity(idPath, id);
  const certificate = await loadSigningCertificate(idPath);
  expect(certificate).toEqual(id.certificate);
});

test("loadSigningCertificate does not import the private key beside it", async () => {
  // A caller that only needs whose certificate this is takes the public half,
  // so a private key the signing path refuses -- here not a key at all -- does
  // not stand between it and the certificate.
  const idPath = path.join(dir, "inconsistent.json");
  const id = await generateSigningIdentity("Party A");
  fs.writeFileSync(
    idPath,
    JSON.stringify({ ...id, privateKey: "not a key at all" }),
    { mode: 0o600 },
  );
  await expect(loadSigningIdentity(idPath)).rejects.toThrow(UsageError);
  expect(await loadSigningCertificate(idPath)).toEqual(id.certificate);
});

test("loadSigningCertificate rejects an unrecognized identity-file version", async () => {
  // The certificate carries its own version, but a document that is not a
  // signing identity of a recognized format is not mined for one here while
  // loadSigningIdentity refuses it.
  const idPath = path.join(dir, "future.json");
  const id = await generateSigningIdentity("Party A");
  fs.writeFileSync(
    idPath,
    JSON.stringify({ ...id, version: "psilink-signing-identity/v99" }),
    { mode: 0o600 },
  );
  await expect(loadSigningCertificate(idPath)).rejects.toThrow(UsageError);
  await expect(loadSigningCertificate(idPath)).rejects.toThrow(
    /malformed or unsupported/,
  );
});

test("loadSigningCertificate rejects a certificate whose self-signature is broken", async () => {
  // The identity binding is still checked: an altered certificate no longer
  // ties the identity it names to the key that signs with it.
  const idPath = path.join(dir, "tampered-certificate.json");
  const id = await generateSigningIdentity("Party A");
  fs.writeFileSync(
    idPath,
    JSON.stringify({
      ...id,
      certificate: { ...id.certificate, identity: "Party Z" },
    }),
    { mode: 0o600 },
  );
  await expect(loadSigningCertificate(idPath)).rejects.toThrow(UsageError);
});

test("defaultSigningIdentityPath is per-user, not per-working-directory", () => {
  const p = defaultSigningIdentityPath();
  expect(p.startsWith(os.homedir())).toBe(true);
  expect(p.endsWith(path.join(".psilink", "signing-identity.json"))).toBe(true);
});
