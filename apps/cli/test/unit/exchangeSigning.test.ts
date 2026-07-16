import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  UsageError,
  generateSigningIdentity,
  computeCertificateFingerprint,
} from "@psilink/core";
import type { SigningConfig } from "@psilink/core";

import { resolveSigningPersist } from "../../src/commands/exchange";
import { saveSigningIdentity } from "../../src/signingIdentityFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-signing-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const identity = generateSigningIdentity("Party A", {
  seed: new Uint8Array(32).map((_, i) => i),
});

test("returns null when signing is absent (the unsigned path)", () => {
  expect(resolveSigningPersist(undefined)).toBeNull();
});

test("returns null for the non-certificate modes", () => {
  const none: SigningConfig = { mode: "none" };
  const session: SigningConfig = { mode: "session-derived" };
  expect(resolveSigningPersist(none)).toBeNull();
  expect(resolveSigningPersist(session)).toBeNull();
});

test("loads the identity and pin for certificate mode", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const fingerprint = await computeCertificateFingerprint(identity.certificate);
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
    partnerFingerprint: fingerprint,
    receiptOutput: path.join(dir, "receipt.json"),
  };
  const resolved = resolveSigningPersist(config);
  expect(resolved).not.toBeNull();
  expect(resolved!.identity).toEqual(identity);
  expect(resolved!.partnerFingerprint).toBe(fingerprint);
  expect(resolved!.receiptOutput).toEqual({
    receiptFile: path.join(dir, "receipt.json"),
  });
});

test("certificate mode with no identity file is a usage error", () => {
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: path.join(dir, "does-not-exist.json"),
  };
  expect(() => resolveSigningPersist(config)).toThrow(UsageError);
  expect(() => resolveSigningPersist(config)).toThrow(
    /no signing identity was found/,
  );
});

test("certificate mode with no pin resolves (verification fails closed at run time)", () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const resolved = resolveSigningPersist(config);
  // The pin is absent here; the fail-closed rejection happens in the signing step
  // (verifyPresentedCertificate), not at config resolution.
  expect(resolved).not.toBeNull();
  expect(resolved!.partnerFingerprint).toBeUndefined();
});
