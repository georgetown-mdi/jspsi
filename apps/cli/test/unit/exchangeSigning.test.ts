import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  UsageError,
  generateSigningIdentity,
  computeCertificateFingerprint,
} from "@psilink/core";
import type { SigningConfig } from "@psilink/core";

import { resolveSigningPersist } from "../../src/commands/exchange";
import { saveSigningIdentity } from "../../src/signingIdentityFile";

let dir: string;
const noopLog = { warn: () => {} };

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
  await expect(
    resolveSigningPersist(undefined, "Party A", noopLog),
  ).resolves.toBeNull();
});

test("returns null for the non-certificate modes", async () => {
  const none: SigningConfig = { mode: "none" };
  const session: SigningConfig = { mode: "session-derived" };
  await expect(
    resolveSigningPersist(none, "Party A", noopLog),
  ).resolves.toBeNull();
  await expect(
    resolveSigningPersist(session, "Party A", noopLog),
  ).resolves.toBeNull();
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
  const resolved = await resolveSigningPersist(config, "Party A", noopLog);
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
  await expect(
    resolveSigningPersist(config, "Party A", noopLog),
  ).rejects.toThrow(UsageError);
  await expect(
    resolveSigningPersist(config, "Party A", noopLog),
  ).rejects.toThrow(/no signing identity was found/);
});

test("certificate mode with no pin resolves (verification fails closed at run time)", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const resolved = await resolveSigningPersist(config, "Party A", noopLog);
  // The pin is absent here; the fail-closed rejection happens in the signing step
  // (verifyPresentedCertificate), not at config resolution.
  expect(resolved).not.toBeNull();
  expect(resolved!.partnerFingerprint).toBeUndefined();
});

// --- divergence from the run's linkage_terms.identity ------------------------
// The loaded certificate is bound to "Party A" throughout; only the terms
// identity handed to the resolver varies.

test("warns when the loaded identity diverges from the run's terms identity", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const warn = vi.fn();
  const resolved = await resolveSigningPersist(
    config,
    "Party A, Agency A, a@agency-a.gov",
    { warn },
  );
  // Warned, and still resolved: the exchange proceeds rather than being refused.
  expect(resolved).not.toBeNull();
  expect(resolved!.identity).toEqual(identity);
  expect(warn).toHaveBeenCalledOnce();
  const message = warn.mock.calls[0]?.[0] as string;
  expect(message).toContain('"Party A"');
  expect(message).toContain('"Party A, Agency A, a@agency-a.gov"');
  expect(message).toContain("linkage_terms.identity");
  expect(message).toContain("reject");
});

test("is silent when the loaded identity matches the run's terms identity", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const warn = vi.fn();
  await resolveSigningPersist(config, "Party A", { warn });
  expect(warn).not.toHaveBeenCalled();
});

test("is silent when the run carries no terms identity", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const warn = vi.fn();
  await resolveSigningPersist(config, undefined, { warn });
  await resolveSigningPersist(config, "", { warn });
  expect(warn).not.toHaveBeenCalled();
});
