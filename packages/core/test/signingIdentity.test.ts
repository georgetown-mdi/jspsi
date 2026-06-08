import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SIGNING_CERTIFICATE_VERSION,
  SIGNING_IDENTITY_VERSION,
  SigningError,
  assertCertificateAuthorizesIdentity,
  assertPartnerCertificateTrusted,
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  generateSigningIdentity,
  matchesPinnedFingerprint,
  parseCertificate,
  parseSigningIdentity,
  serializeCertificate,
  serializeSigningIdentity,
  verifyCertificateSelfSignature,
  verifyPresentedCertificate,
} from "../src/signingIdentity";
import { fromBase64Url, toBase64Url } from "../src/utils/crypto";

import type {
  SigningCertificate,
  SigningIdentity,
} from "../src/signingIdentity";

const IDENTITY = "Jane Smith, Agency A\njsmith@agency-a.gov";

function freshIdentity(identity = IDENTITY): SigningIdentity {
  return generateSigningIdentity(identity);
}

// deep clone so a test mutation never leaks into another test's fixture
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- Generation and round-trip ----------------------------------------------

describe("generateSigningIdentity", () => {
  test("produces a v1 identity with a self-signed v1 certificate", () => {
    const id = freshIdentity();
    expect(id.version).toBe(SIGNING_IDENTITY_VERSION);
    expect(id.certificate.version).toBe(SIGNING_CERTIFICATE_VERSION);
    expect(id.certificate.algorithm).toBe("ed25519");
    expect(id.certificate.identity).toBe(IDENTITY);
    expect(id.privateKey.x).toBe(id.certificate.publicKey.x);
    expect(verifyCertificateSelfSignature(id.certificate)).toBe(true);
  });

  test("rejects an empty identity", () => {
    expect(() => generateSigningIdentity("")).toThrow(SigningError);
  });

  test("two generations use independent keys (distinct fingerprints)", async () => {
    const a = await computeCertificateFingerprint(freshIdentity().certificate);
    const b = await computeCertificateFingerprint(freshIdentity().certificate);
    expect(a).not.toBe(b);
  });

  test("a generated identity loads back and reproduces the same fingerprint", async () => {
    const id = freshIdentity();
    const before = await computeCertificateFingerprint(id.certificate);
    const reloaded = parseSigningIdentity(
      JSON.parse(serializeSigningIdentity(id)),
    );
    const after = await computeCertificateFingerprint(reloaded.certificate);
    expect(after).toBe(before);
    expect(reloaded).toEqual(id);
  });

  test("a deterministic seed reproduces the identity exactly", () => {
    const seed = new Uint8Array(32).map((_, i) => i);
    const a = generateSigningIdentity(IDENTITY, { seed });
    const b = generateSigningIdentity(IDENTITY, { seed: seed.slice() });
    expect(b).toEqual(a);
  });
});

// --- Parse: pre-existing identity / certificate ------------------------------

describe("parseSigningIdentity / parseCertificate", () => {
  test("loads a pre-existing keypair + certificate", () => {
    const id = freshIdentity();
    const raw = JSON.parse(serializeSigningIdentity(id));
    expect(() => parseSigningIdentity(raw)).not.toThrow();
    const certRaw = JSON.parse(serializeCertificate(id.certificate));
    expect(() => parseCertificate(certRaw)).not.toThrow();
  });

  test("rejects a missing certificate / identity (empty object)", () => {
    expect(() => parseCertificate({})).toThrow();
    expect(() => parseSigningIdentity({})).toThrow();
  });

  test("rejects a malformed (wrong-length) public key", () => {
    const cert = clone(freshIdentity().certificate);
    // valid base64url but only 2 bytes -- passes the schema, fails the byte check
    cert.publicKey.x = toBase64Url(new Uint8Array([1, 2]));
    expect(() => parseCertificate(cert)).toThrow(SigningError);
  });

  test("rejects a degenerate (small-order) public key", () => {
    const cert = clone(freshIdentity().certificate);
    cert.publicKey.x = toBase64Url(new Uint8Array(32)); // all-zero: small order
    expect(() => parseCertificate(cert)).toThrow(SigningError);
  });

  test("rejects a certificate whose self-signature does not verify", () => {
    const cert = clone(freshIdentity().certificate);
    cert.identity = "Someone Else"; // body changed, signature no longer covers it
    expect(verifyCertificateSelfSignature(cert)).toBe(false);
    expect(() => parseCertificate(cert)).toThrow(SigningError);
  });

  test("rejects an identity file whose private key does not match its certificate", () => {
    const id = clone(freshIdentity());
    const other = freshIdentity();
    id.privateKey.d = other.privateKey.d; // private key now disagrees with cert pub
    expect(() => parseSigningIdentity(id)).toThrow(SigningError);
  });

  test("rejects a non-base64url key via the schema", () => {
    const cert = clone(freshIdentity().certificate) as unknown as {
      publicKey: { x: string };
    };
    cert.publicKey.x = "not base64url!!";
    expect(() => parseCertificate(cert)).toThrow();
  });
});

// --- Partner certificate trust (fingerprint pinning) ------------------------

describe("partner certificate pinning", () => {
  test("accepts a certificate whose fingerprint matches the pinned value", async () => {
    const id = freshIdentity();
    const pinned = await computeCertificateFingerprint(id.certificate);
    expect(await matchesPinnedFingerprint(id.certificate, pinned)).toBe(true);
    await expect(
      assertPartnerCertificateTrusted(id.certificate, pinned),
    ).resolves.toBeUndefined();
  });

  test("rejects an unpinned partner certificate (no pinned value)", async () => {
    const id = freshIdentity();
    await expect(
      assertPartnerCertificateTrusted(id.certificate, undefined),
    ).rejects.toThrow(SigningError);
    await expect(
      assertPartnerCertificateTrusted(id.certificate, ""),
    ).rejects.toThrow(SigningError);
  });

  test("rejects a certificate whose fingerprint does not match the pin", async () => {
    const a = freshIdentity();
    const b = freshIdentity();
    const pinnedB = await computeCertificateFingerprint(b.certificate);
    expect(await matchesPinnedFingerprint(a.certificate, pinnedB)).toBe(false);
    await expect(
      assertPartnerCertificateTrusted(a.certificate, pinnedB),
    ).rejects.toThrow(SigningError);
  });

  test("rejects a tampered certificate even if its fingerprint is pinned", async () => {
    // An attacker who recomputes the fingerprint of a tampered body still cannot
    // pass, because the self-signature no longer verifies.
    const a = freshIdentity();
    const tampered: SigningCertificate = clone(a.certificate);
    tampered.identity = "Impostor";
    const pinnedTampered = await computeCertificateFingerprint(tampered);
    await expect(
      assertPartnerCertificateTrusted(tampered, pinnedTampered),
    ).rejects.toThrow(SigningError);
  });

  // The self-signature check runs before the fingerprint match, so these reach
  // it regardless of the (here irrelevant) pinned value.
  const ANY_PIN = "A".repeat(43);

  test("reports a degenerate partner key precisely, not as a bad signature", async () => {
    const cert = clone(freshIdentity().certificate);
    cert.publicKey.x = toBase64Url(new Uint8Array(32)); // all-zero: small order
    await expect(
      assertPartnerCertificateTrusted(cert, ANY_PIN),
    ).rejects.toThrow(/small-order|degenerate/);
  });

  test("reports a failed partner self-signature distinctly from a bad key", async () => {
    const cert = clone(freshIdentity().certificate);
    cert.identity = "Tampered"; // body changed, key still valid -> signature fails
    await expect(
      assertPartnerCertificateTrusted(cert, ANY_PIN),
    ).rejects.toThrow(/self-signature does not verify/);
  });
});

// --- Identity binding --------------------------------------------------------

describe("certificate identity binding", () => {
  test("accepts a receipt identity the certificate authorizes", () => {
    const id = freshIdentity();
    expect(certificateAuthorizesIdentity(id.certificate, IDENTITY)).toBe(true);
    expect(() =>
      assertCertificateAuthorizesIdentity(id.certificate, IDENTITY),
    ).not.toThrow();
  });

  test("rejects a receipt identity the certificate does not authorize", () => {
    const id = freshIdentity();
    expect(
      certificateAuthorizesIdentity(id.certificate, "Different Identity"),
    ).toBe(false);
    expect(() =>
      assertCertificateAuthorizesIdentity(id.certificate, "Different Identity"),
    ).toThrow(SigningError);
  });

  test("binding is exact: trailing whitespace is not authorized", () => {
    const id = freshIdentity();
    expect(certificateAuthorizesIdentity(id.certificate, IDENTITY + " ")).toBe(
      false,
    );
  });
});

// --- Full presented-certificate gate ----------------------------------------

describe("verifyPresentedCertificate", () => {
  test("accepts a pinned, self-consistent certificate that authorizes the asserted identity", async () => {
    const id = freshIdentity();
    const pinned = await computeCertificateFingerprint(id.certificate);
    await expect(
      verifyPresentedCertificate({
        certificate: id.certificate,
        pinnedFingerprint: pinned,
        assertedIdentity: IDENTITY,
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects when the asserted identity is not authorized, even if pinned", async () => {
    const id = freshIdentity();
    const pinned = await computeCertificateFingerprint(id.certificate);
    await expect(
      verifyPresentedCertificate({
        certificate: id.certificate,
        pinnedFingerprint: pinned,
        assertedIdentity: "Not The Cert Identity",
      }),
    ).rejects.toThrow(SigningError);
  });

  test("rejects when not pinned, before any identity check", async () => {
    const id = freshIdentity();
    await expect(
      verifyPresentedCertificate({
        certificate: id.certificate,
        pinnedFingerprint: undefined,
        assertedIdentity: IDENTITY,
      }),
    ).rejects.toThrow(SigningError);
  });
});

// --- Cross-implementation reproducibility vectors ---------------------------

// The checked-in vectors are the cross-implementation contract: any independent
// implementation that seeds Ed25519 identically must reproduce the same public
// key, self-signature, and fingerprint, and must parse the checked-in identity
// files and certificates. They double as the fixtures the acceptance criteria
// require (a valid keypair + cert, plus -- via the two vectors -- a mismatched
// identity binding and a non-matching fingerprint).
interface SigningVector {
  name: string;
  description: string;
  seed: string;
  identity: string;
  expected: { publicKeyX: string; signature: string; fingerprint: string };
  identityFile: SigningIdentity;
  certificate: SigningCertificate;
}

const { vectors } = JSON.parse(
  readFileSync(
    new URL("./vectors/signing-cert-vectors.json", import.meta.url),
    "utf8",
  ),
) as { vectors: SigningVector[] };

describe("signing-cert-vectors.json", () => {
  test("has at least two vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(2);
  });

  test.each(vectors)(
    "$name regenerates from its seed to the expected bytes",
    async (vec) => {
      const seed = fromBase64Url(vec.seed);
      const id = generateSigningIdentity(vec.identity, { seed });
      expect(id.certificate.publicKey.x).toBe(vec.expected.publicKeyX);
      expect(id.certificate.signature).toBe(vec.expected.signature);
      expect(await computeCertificateFingerprint(id.certificate)).toBe(
        vec.expected.fingerprint,
      );
      expect(id).toEqual(vec.identityFile);
    },
  );

  test.each(vectors)("$name parses and self-verifies", async (vec) => {
    expect(() => parseSigningIdentity(vec.identityFile)).not.toThrow();
    expect(() => parseCertificate(vec.certificate)).not.toThrow();
    expect(await computeCertificateFingerprint(vec.certificate)).toBe(
      vec.expected.fingerprint,
    );
  });

  test("the two vectors cross-reject (mismatched identity and fingerprint)", async () => {
    const [a, b] = vectors;
    // mismatched identity binding: A's cert does not authorize B's identity
    expect(certificateAuthorizesIdentity(a.certificate, b.identity)).toBe(
      false,
    );
    // non-matching fingerprint: A's cert is not trusted under B's pinned value
    await expect(
      assertPartnerCertificateTrusted(a.certificate, b.expected.fingerprint),
    ).rejects.toThrow(SigningError);
    // but each is trusted under its own pin and authorizes its own identity
    await expect(
      verifyPresentedCertificate({
        certificate: a.certificate,
        pinnedFingerprint: a.expected.fingerprint,
        assertedIdentity: a.identity,
      }),
    ).resolves.toBeUndefined();
  });
});
