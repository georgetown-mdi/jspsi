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

const identity = await generateSigningIdentity("Party A", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "JHWxrL6MWMbpKlF5G-EULYpHJ5M6PnEdleg66V0RCvo",
    y: "ZQuEikGWXN5_AKJYN-xh_HjLnqrQG4QpVkzPocFYbJg",
    d: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw",
  },
});

test("returns null when signing is absent (the unsigned path)", async () => {
  await expect(resolveSigningPersist(undefined)).resolves.toBeNull();
});

test("returns null for the non-certificate modes", async () => {
  const none: SigningConfig = { mode: "none" };
  const session: SigningConfig = { mode: "session-derived" };
  await expect(resolveSigningPersist(none)).resolves.toBeNull();
  await expect(resolveSigningPersist(session)).resolves.toBeNull();
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
  const resolved = await resolveSigningPersist(config);
  expect(resolved).not.toBeNull();
  expect(resolved!.identity).toEqual(identity);
  expect(resolved!.partnerFingerprint).toBe(fingerprint);
  expect(resolved!.receiptOutput).toEqual({
    receiptFile: path.join(dir, "receipt.json"),
  });
});

test("certificate mode with no identity file is a usage error", async () => {
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: path.join(dir, "does-not-exist.json"),
  };
  await expect(resolveSigningPersist(config)).rejects.toThrow(UsageError);
  await expect(resolveSigningPersist(config)).rejects.toThrow(
    /no signing identity was found/,
  );
});

test("certificate mode with no pin resolves (verification fails closed at run time)", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const resolved = await resolveSigningPersist(config);
  // The pin is absent here; the fail-closed rejection happens in the signing step
  // (verifyPresentedCertificate), not at config resolution.
  expect(resolved).not.toBeNull();
  expect(resolved!.partnerFingerprint).toBeUndefined();
});
