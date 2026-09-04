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
import {
  assertPrivateKeyMatchesPublic,
  ECDSA_P256_SIGNATURE_BYTES,
  importPrivateSigningKey,
} from "../src/signingKeys";
import { fromBase64Url, toBase64Url } from "../src/utils/crypto";

import type {
  P256PrivateJwk,
  SigningCertificate,
  SigningIdentity,
} from "../src/signingIdentity";

const IDENTITY = "Jane Smith, Agency A\njsmith@agency-a.gov";

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

function freshIdentity(identity = IDENTITY): Promise<SigningIdentity> {
  return generateSigningIdentity(identity);
}

// deep clone so a test mutation never leaks into another test's fixture
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Whether the platform's own importKey admits `jwk` as a P-256 key. The
 * point-validity half of the load check is delegated to it, so every rejection
 * the module relies on is measured here rather than assumed. */
async function platformImportsKey(jwk: JsonWebKey): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      "jwk",
      jwk,
      ECDSA_P256,
      false,
      jwk.d === undefined ? ["verify"] : ["sign"],
    );
    return true;
  } catch {
    return false;
  }
}

/** The DER SEQUENCE encoding of a raw `r || s` signature: the encoding a
 * certificate signature must never take, built here so a test can measure
 * it against the raw one. */
function derEncodeSignature(raw: Uint8Array): Uint8Array {
  const derInteger = (value: Uint8Array): Array<number> => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const body = [...value.subarray(start)];
    // A leading octet at or above 0x80 would be treated as a negative INTEGER.
    if ((body[0] ?? 0) >= 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const half = raw.length / 2;
  const body = [
    ...derInteger(raw.subarray(0, half)),
    ...derInteger(raw.subarray(half)),
  ];
  return new Uint8Array([0x30, body.length, ...body]);
}

// --- Generation and round-trip ----------------------------------------------

describe("generateSigningIdentity", () => {
  test("produces an identity with a self-signed certificate at the current versions", async () => {
    const id = await freshIdentity();
    expect(id.version).toBe(SIGNING_IDENTITY_VERSION);
    expect(id.certificate.version).toBe(SIGNING_CERTIFICATE_VERSION);
    expect(id.certificate.algorithm).toBe("ecdsa-p256-sha256");
    expect(id.certificate.identity).toBe(IDENTITY);
    expect(id.certificate.publicKey.kty).toBe("EC");
    expect(id.certificate.publicKey.crv).toBe("P-256");
    expect(id.privateKey.x).toBe(id.certificate.publicKey.x);
    expect(id.privateKey.y).toBe(id.certificate.publicKey.y);
    expect(await verifyCertificateSelfSignature(id.certificate)).toBe(true);
  });

  test("the self-signature is the fixed-length raw r||s, never DER", async () => {
    const id = await freshIdentity();
    const signature = fromBase64Url(id.certificate.signature);
    // Length is the discriminator, not the leading byte: the first byte of
    // a raw signature is r's top octet, uniform over the curve order, so a
    // `signature[0] !== 0x30` check calls a correct signature DER once in
    // 256 generations. The two encodings are told apart by size instead,
    // measured on this very signature rather than asserted in prose -- DER
    // wraps the same pair in a SEQUENCE header plus a tag and length per
    // INTEGER, padding any integer whose top bit is set.
    expect(signature).toHaveLength(ECDSA_P256_SIGNATURE_BYTES);
    expect(derEncodeSignature(signature).length).toBeGreaterThan(
      ECDSA_P256_SIGNATURE_BYTES,
    );
  });

  test("rejects an empty identity", async () => {
    await expect(generateSigningIdentity("")).rejects.toThrow(SigningError);
  });

  test("two generations use independent keys (distinct fingerprints)", async () => {
    const a = await computeCertificateFingerprint(
      (await freshIdentity()).certificate,
    );
    const b = await computeCertificateFingerprint(
      (await freshIdentity()).certificate,
    );
    expect(a).not.toBe(b);
  });

  test("a generated identity loads back and reproduces the same fingerprint", async () => {
    const id = await freshIdentity();
    const before = await computeCertificateFingerprint(id.certificate);
    const reloaded = await parseSigningIdentity(
      JSON.parse(serializeSigningIdentity(id)),
    );
    const after = await computeCertificateFingerprint(reloaded.certificate);
    expect(after).toBe(before);
    expect(reloaded).toEqual(id);
  });

  test("a fixed private key reproduces the key and fingerprint, but not the signature", async () => {
    // ECDSA signing is randomized, so the certificate body -- and therefore the
    // fingerprint a partner pins -- is what stays reproducible, not the bytes of
    // the self-signature. Both signatures verify.
    const { vectors } = readVectors();
    const privateKey = vectors[0]!.privateKey;
    const a = await generateSigningIdentity(IDENTITY, { privateKey });
    const b = await generateSigningIdentity(IDENTITY, { privateKey });
    expect(b.certificate.publicKey).toEqual(a.certificate.publicKey);
    expect(await computeCertificateFingerprint(b.certificate)).toBe(
      await computeCertificateFingerprint(a.certificate),
    );
    expect(b.certificate.signature).not.toBe(a.certificate.signature);
    expect(await verifyCertificateSelfSignature(a.certificate)).toBe(true);
    expect(await verifyCertificateSelfSignature(b.certificate)).toBe(true);
  });

  test("rejects a supplied private key that is not a valid P-256 key", async () => {
    const { vectors } = readVectors();
    const broken: P256PrivateJwk = {
      ...vectors[0]!.privateKey,
      d: vectors[1]!.privateKey.d,
    };
    expect(await platformImportsKey(broken as unknown as JsonWebKey)).toBe(
      false,
    );
    await expect(
      generateSigningIdentity(IDENTITY, { privateKey: broken }),
    ).rejects.toThrow(SigningError);
  });
});

// --- Parse: pre-existing identity / certificate ------------------------------

describe("parseSigningIdentity / parseCertificate", () => {
  test("loads a pre-existing keypair + certificate", async () => {
    const id = await freshIdentity();
    const raw = JSON.parse(serializeSigningIdentity(id));
    await expect(parseSigningIdentity(raw)).resolves.toBeDefined();
    const certRaw = JSON.parse(serializeCertificate(id.certificate));
    await expect(parseCertificate(certRaw)).resolves.toBeDefined();
  });

  test("rejects a missing certificate / identity (empty object)", async () => {
    await expect(parseCertificate({})).rejects.toThrow();
    await expect(parseSigningIdentity({})).rejects.toThrow();
  });

  test("rejects a wrong-length public coordinate, naming the length", async () => {
    const cert = clone((await freshIdentity()).certificate);
    cert.publicKey.x = toBase64Url(new Uint8Array([1, 2]));
    await expect(parseCertificate(cert)).rejects.toThrow(
      /coordinate x must be 32 bytes, got 2/,
    );
  });

  test("rejects a coordinate padded to 33 bytes that importKey would admit", async () => {
    // Measured: the platform accepts a coordinate with a 33rd leading zero
    // byte and decodes it to the same point, so the fixed 32-byte length is
    // this module's pin, not importKey's. Two encodings of one key would
    // otherwise be two fingerprints for one key.
    const cert = clone((await freshIdentity()).certificate);
    const padded = new Uint8Array(33);
    padded.set(fromBase64Url(cert.publicKey.x), 1);
    const paddedJwk = {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(padded),
      y: cert.publicKey.y,
    };
    expect(await platformImportsKey(paddedJwk)).toBe(true);
    cert.publicKey.x = paddedJwk.x;
    await expect(parseCertificate(cert)).rejects.toThrow(
      /coordinate x must be 32 bytes, got 33/,
    );
  });

  test("rejects a base64-padded coordinate that importKey would admit", async () => {
    const cert = clone((await freshIdentity()).certificate);
    const bytes = fromBase64Url(cert.publicKey.x);
    const withPadding = Buffer.from(bytes).toString("base64");
    expect(
      await platformImportsKey({
        kty: "EC",
        crv: "P-256",
        x: withPadding,
        y: cert.publicKey.y,
      }),
    ).toBe(true);
    cert.publicKey.x = withPadding;
    // The `=` never survives the schema's alphabet check, so this is refused
    // before the canonical-form pin is reached.
    await expect(parseCertificate(cert)).rejects.toThrow();
  });

  test("rejects a point that is not on the curve", async () => {
    const cert = clone((await freshIdentity()).certificate);
    const y = fromBase64Url(cert.publicKey.y);
    y[31] = (y[31] as number) ^ 0x01;
    const offCurve = {
      kty: "EC",
      crv: "P-256",
      x: cert.publicKey.x,
      y: toBase64Url(y),
    };
    expect(await platformImportsKey(offCurve)).toBe(false);
    cert.publicKey.y = offCurve.y as string;
    await expect(parseCertificate(cert)).rejects.toThrow(
      /is not a valid P-256 point/,
    );
  });

  test("rejects the identity element (x = y = 0)", async () => {
    // P-256 has cofactor 1, so there is no small-order subgroup to reject and
    // the identity is the whole of the degenerate case. Its rejection is
    // importKey's, measured here rather than assumed.
    const cert = clone((await freshIdentity()).certificate);
    const zero = toBase64Url(new Uint8Array(32));
    expect(
      await platformImportsKey({ kty: "EC", crv: "P-256", x: zero, y: zero }),
    ).toBe(false);
    cert.publicKey.x = zero;
    cert.publicKey.y = zero;
    await expect(parseCertificate(cert)).rejects.toThrow(
      /is not a valid P-256 point/,
    );
  });

  test("rejects a coordinate at the field prime", async () => {
    const cert = clone((await freshIdentity()).certificate);
    const fieldPrime = toBase64Url(
      new Uint8Array(
        Buffer.from(
          "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
          "hex",
        ),
      ),
    );
    expect(
      await platformImportsKey({
        kty: "EC",
        crv: "P-256",
        x: fieldPrime,
        y: cert.publicKey.y,
      }),
    ).toBe(false);
    cert.publicKey.x = fieldPrime;
    await expect(parseCertificate(cert)).rejects.toThrow(
      /is not a valid P-256 point/,
    );
  });

  test("rejects a wrong-length signature, naming the length", async () => {
    const cert = clone((await freshIdentity()).certificate);
    cert.signature = toBase64Url(new Uint8Array(63));
    await expect(parseCertificate(cert)).rejects.toThrow(
      /certificate signature must be 64 bytes, got 63/,
    );
  });

  test("rejects a DER-encoded signature", async () => {
    // WebCrypto emits and accepts only the fixed-length raw r||s, so a DER
    // SEQUENCE is refused on its length rather than decoded.
    const cert = clone((await freshIdentity()).certificate);
    const raw = fromBase64Url(cert.signature);
    const der = Buffer.concat([
      Buffer.from([0x30, 0x44, 0x02, 0x20]),
      Buffer.from(raw.subarray(0, 32)),
      Buffer.from([0x02, 0x20]),
      Buffer.from(raw.subarray(32)),
    ]);
    cert.signature = toBase64Url(new Uint8Array(der));
    await expect(parseCertificate(cert)).rejects.toThrow(
      /certificate signature must be 64 bytes, got 70/,
    );
  });

  test("rejects a certificate whose self-signature does not verify", async () => {
    const cert = clone((await freshIdentity()).certificate);
    cert.identity = "Someone Else"; // body changed, signature no longer covers it
    expect(await verifyCertificateSelfSignature(cert)).toBe(false);
    await expect(parseCertificate(cert)).rejects.toThrow(SigningError);
  });

  test("rejects an identity file whose private key does not match its certificate", async () => {
    const id = clone(await freshIdentity());
    const other = await freshIdentity();
    id.privateKey = clone(other.privateKey);
    await expect(parseSigningIdentity(id)).rejects.toThrow(
      /does not match its certificate's public key/,
    );
  });

  test("rejects an identity file whose private scalar does not belong with its own coordinates", async () => {
    // On this platform importKey refuses the scalar against the coordinates
    // stored beside it, so the load never reaches the keypair probe -- measured
    // here rather than assumed, since the module does not depend on it (the
    // probe below is the platform-independent half).
    const id = clone(await freshIdentity());
    const other = await freshIdentity();
    id.privateKey.d = other.privateKey.d;
    expect(
      await platformImportsKey(id.privateKey as unknown as JsonWebKey),
    ).toBe(false);
    await expect(parseSigningIdentity(id)).rejects.toThrow(
      /is not a valid P-256 private key/,
    );
  });

  test("the keypair probe refuses a private key that is not the public key's, whatever importKey admits", async () => {
    // The identity file's private-to-certificate binding must not rest on a
    // platform behavior: assertPrivateKeyMatchesPublic signs a fixed probe and
    // verifies it under the certificate's public key, so a mismatch is caught on
    // any runtime. Driven here against two keys the platform imports happily.
    const a = await freshIdentity();
    const b = await freshIdentity();
    const keyA = await importPrivateSigningKey(a.privateKey);
    await expect(
      assertPrivateKeyMatchesPublic(
        keyA,
        a.privateKey,
        a.certificate.publicKey,
        "mismatch",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertPrivateKeyMatchesPublic(
        keyA,
        // Coordinates that pass the equality check but belong to another key, so
        // only the signature probe can catch the mismatch.
        { ...a.privateKey, x: b.privateKey.x, y: b.privateKey.y },
        b.certificate.publicKey,
        "mismatch",
      ),
    ).rejects.toThrow("mismatch");
  });

  test("rejects a non-base64url key via the schema", async () => {
    const cert = clone((await freshIdentity()).certificate) as unknown as {
      publicKey: { x: string };
    };
    cert.publicKey.x = "not base64url!!";
    await expect(parseCertificate(cert)).rejects.toThrow();
  });
});

// --- Format-version enforcement ----------------------------------------------

// A document written under the previous certificate format: an Ed25519 key in an
// RFC 8037 OKP JWK. It must be refused outright, never reinterpreted under the
// current scheme -- an OKP JWK has no `y`, so a reader that ignored the
// version would be guessing at a coordinate.
const V1_CERTIFICATE = {
  version: "psilink-signing-cert/v1",
  algorithm: "ed25519",
  identity: IDENTITY,
  publicKey: {
    kty: "OKP",
    crv: "Ed25519",
    x: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  },
  signature:
    "8WKs03xb2bO9IsxziElnQeQ4v6--9DKTCRl5RyasydYD5THhQBBQwUD0nDHK7Lqm8NqgxczxhKX7JjJWlJiyAQ",
};

const V1_IDENTITY_FILE = {
  version: "psilink-signing-identity/v1",
  privateKey: {
    kty: "OKP",
    crv: "Ed25519",
    x: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
    d: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  },
  certificate: V1_CERTIFICATE,
};

describe("format-version enforcement", () => {
  test("a certificate from the previous format is rejected, not parsed", async () => {
    await expect(parseCertificate(V1_CERTIFICATE)).rejects.toThrow();
  });

  test("an identity file from the previous format is rejected, not parsed", async () => {
    await expect(parseSigningIdentity(V1_IDENTITY_FILE)).rejects.toThrow();
  });

  test("a current-format body carrying the previous version is still rejected", async () => {
    // The version is the discriminant on its own: a document that is otherwise a
    // well-formed current certificate does not become acceptable by shape.
    const cert = clone((await freshIdentity()).certificate) as unknown as {
      version: string;
    };
    cert.version = "psilink-signing-cert/v1";
    await expect(parseCertificate(cert)).rejects.toThrow();
  });
});

// --- Partner certificate trust (fingerprint pinning) ------------------------

describe("partner certificate pinning", () => {
  test("accepts a certificate whose fingerprint matches the pinned value", async () => {
    const id = await freshIdentity();
    const pinned = await computeCertificateFingerprint(id.certificate);
    expect(await matchesPinnedFingerprint(id.certificate, pinned)).toBe(true);
    await expect(
      assertPartnerCertificateTrusted(id.certificate, pinned),
    ).resolves.toBeUndefined();
  });

  test("rejects an unpinned partner certificate (no pinned value)", async () => {
    const id = await freshIdentity();
    await expect(
      assertPartnerCertificateTrusted(id.certificate, undefined),
    ).rejects.toThrow(SigningError);
    await expect(
      assertPartnerCertificateTrusted(id.certificate, ""),
    ).rejects.toThrow(SigningError);
  });

  test("rejects a certificate whose fingerprint does not match the pin", async () => {
    const a = await freshIdentity();
    const b = await freshIdentity();
    const pinnedB = await computeCertificateFingerprint(b.certificate);
    expect(await matchesPinnedFingerprint(a.certificate, pinnedB)).toBe(false);
    await expect(
      assertPartnerCertificateTrusted(a.certificate, pinnedB),
    ).rejects.toThrow(SigningError);
  });

  test("rejects a tampered certificate even if its fingerprint is pinned", async () => {
    // An attacker who recomputes the fingerprint of a tampered body still cannot
    // pass, because the self-signature no longer verifies.
    const a = await freshIdentity();
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

  test("reports an invalid partner key precisely, not as a bad signature", async () => {
    const cert = clone((await freshIdentity()).certificate);
    const zero = toBase64Url(new Uint8Array(32));
    cert.publicKey.x = zero;
    cert.publicKey.y = zero;
    await expect(
      assertPartnerCertificateTrusted(cert, ANY_PIN),
    ).rejects.toThrow(/is not a valid P-256 point/);
  });

  test("reports a failed partner self-signature distinctly from a bad key", async () => {
    const cert = clone((await freshIdentity()).certificate);
    cert.identity = "Tampered"; // body changed, key still valid -> signature fails
    await expect(
      assertPartnerCertificateTrusted(cert, ANY_PIN),
    ).rejects.toThrow(/self-signature does not verify/);
  });
});

// --- Identity binding --------------------------------------------------------

describe("certificate identity binding", () => {
  test("accepts a receipt identity the certificate authorizes", async () => {
    const id = await freshIdentity();
    expect(certificateAuthorizesIdentity(id.certificate, IDENTITY)).toBe(true);
    expect(() =>
      assertCertificateAuthorizesIdentity(id.certificate, IDENTITY),
    ).not.toThrow();
  });

  test("rejects a receipt identity the certificate does not authorize", async () => {
    const id = await freshIdentity();
    expect(
      certificateAuthorizesIdentity(id.certificate, "Different Identity"),
    ).toBe(false);
    expect(() =>
      assertCertificateAuthorizesIdentity(id.certificate, "Different Identity"),
    ).toThrow(SigningError);
  });

  test("binding is exact: trailing whitespace is not authorized", async () => {
    const id = await freshIdentity();
    expect(certificateAuthorizesIdentity(id.certificate, IDENTITY + " ")).toBe(
      false,
    );
  });
});

// --- Full presented-certificate gate ----------------------------------------

describe("verifyPresentedCertificate", () => {
  test("accepts a pinned, self-consistent certificate that authorizes the asserted identity", async () => {
    const id = await freshIdentity();
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
    const id = await freshIdentity();
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
    const id = await freshIdentity();
    await expect(
      verifyPresentedCertificate({
        certificate: id.certificate,
        pinnedFingerprint: undefined,
        assertedIdentity: IDENTITY,
      }),
    ).rejects.toThrow(SigningError);
  });
});

// --- Cross-implementation vectors -------------------------------------------

// The checked-in vectors are the cross-implementation contract. The public
// coordinates and the fingerprint are known answers any implementation
// given the same key must reproduce. The self-signature is verify-only --
// ECDSA signing is randomized -- produced by openssl over signed bytes the
// generator assembles from the spec, so parsing it proves this
// implementation accepts a signature made outside the codebase. They also
// serve as the acceptance criteria's fixtures (a valid keypair + cert,
// plus -- via the two vectors -- a mismatched identity binding and a
// non-matching fingerprint).
interface SigningVector {
  name: string;
  description: string;
  identity: string;
  privateKey: P256PrivateJwk;
  expected: { publicKeyX: string; publicKeyY: string; fingerprint: string };
  identityFile: SigningIdentity;
  certificate: SigningCertificate;
}

function readVectors(): { vectors: SigningVector[] } {
  return JSON.parse(
    readFileSync(
      new URL("./vectors/signing-cert-vectors.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: SigningVector[] };
}

const { vectors } = readVectors();

describe("signing-cert-vectors.json", () => {
  test("has at least two vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(2);
  });

  test.each(vectors)(
    "$name reproduces the deterministic anchors from its fixed key",
    async (vec) => {
      const id = await generateSigningIdentity(vec.identity, {
        privateKey: vec.privateKey,
      });
      expect(id.certificate.publicKey.x).toBe(vec.expected.publicKeyX);
      expect(id.certificate.publicKey.y).toBe(vec.expected.publicKeyY);
      expect(await computeCertificateFingerprint(id.certificate)).toBe(
        vec.expected.fingerprint,
      );
      // Everything but the signature is byte-identical to the checked-in file.
      expect({
        ...id.certificate,
        signature: vec.certificate.signature,
      }).toEqual(vec.certificate);
      expect(id.certificate.signature).not.toBe(vec.certificate.signature);
    },
  );

  test.each(vectors)(
    "$name parses and self-verifies its foreign-produced signature",
    async (vec) => {
      await expect(
        parseSigningIdentity(vec.identityFile),
      ).resolves.toBeDefined();
      await expect(parseCertificate(vec.certificate)).resolves.toBeDefined();
      expect(await computeCertificateFingerprint(vec.certificate)).toBe(
        vec.expected.fingerprint,
      );
    },
  );

  test.each(vectors)(
    "$name rejects its certificate with one signature bit flipped",
    async (vec) => {
      const cert = clone(vec.certificate);
      const signature = fromBase64Url(cert.signature);
      signature[0] = (signature[0] as number) ^ 0x01;
      cert.signature = toBase64Url(signature);
      expect(await verifyCertificateSelfSignature(cert)).toBe(false);
      await expect(parseCertificate(cert)).rejects.toThrow(SigningError);
    },
  );

  test("the two vectors cross-reject (mismatched identity and fingerprint)", async () => {
    const [a, b] = vectors as [SigningVector, SigningVector];
    expect(certificateAuthorizesIdentity(a.certificate, b.identity)).toBe(
      false,
    );
    await expect(
      assertPartnerCertificateTrusted(a.certificate, b.expected.fingerprint),
    ).rejects.toThrow(SigningError);
    await expect(
      verifyPresentedCertificate({
        certificate: a.certificate,
        pinnedFingerprint: a.expected.fingerprint,
        assertedIdentity: a.identity,
      }),
    ).resolves.toBeUndefined();
  });
});
