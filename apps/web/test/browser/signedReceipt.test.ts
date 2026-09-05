/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import {
  computeCertificateFingerprint,
  deriveReceiptBinder,
  generateSigningIdentity,
  parseCertificate,
  parseDualSignedRecord,
  parseSigningIdentity,
  signReceiptContent,
  verifyCertificateSelfSignature,
  verifyDualSignedRecord,
  verifyReceiptSignature,
} from "@psilink/core";

import certVectorsRaw from "../../../../packages/core/test/vectors/signing-cert-vectors.json?raw";
import receiptVectorsRaw from "../../../../packages/core/test/vectors/signed-receipt-vectors.json?raw";

import type {
  P256PrivateJwk,
  SigningCertificate,
  SigningIdentity,
} from "@psilink/core";

// The companion to packages/core/test/records/signedReceipt.test.ts and
// signingIdentity.test.ts: it runs the same checked-in vectors through the
// browser build of @psilink/core in real Chromium. ECDSA signing is
// randomized, so cross-build verification (not signature reproduction) is
// what proves the two builds agree on canonical encoding, signed bytes, and
// key rejection.

type ReceiptContent = Parameters<typeof signReceiptContent>[1];

interface ReceiptVector {
  name: string;
  identity: string;
  privateKey: P256PrivateJwk;
  sessionKey: string;
  role: "initiator" | "responder";
  content: ReceiptContent;
  expected: { binder: string; fingerprint: string; signature: string };
}

interface CertVector {
  name: string;
  identity: string;
  privateKey: P256PrivateJwk;
  expected: { publicKeyX: string; publicKeyY: string; fingerprint: string };
  identityFile: SigningIdentity;
  certificate: SigningCertificate;
}

interface ReceiptBundle {
  expected: {
    initiatorFingerprint: string;
    responderFingerprint: string;
    initiatorIdentity: string;
    responderIdentity: string;
  };
  record: unknown;
}

const { vectors: receiptVectors, bundle: receiptBundle } = JSON.parse(
  receiptVectorsRaw,
) as { vectors: Array<ReceiptVector>; bundle: ReceiptBundle };
const certVectors = (
  JSON.parse(certVectorsRaw) as { vectors: Array<CertVector> }
).vectors;

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64u(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("signing certificates in the browser", () => {
  test.each(certVectors)(
    "$name: the browser build reproduces the public key and fingerprint",
    async (vector) => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      expect(identity.certificate.publicKey.x).toBe(vector.expected.publicKeyX);
      expect(identity.certificate.publicKey.y).toBe(vector.expected.publicKeyY);
      expect(await computeCertificateFingerprint(identity.certificate)).toBe(
        vector.expected.fingerprint,
      );
    },
  );

  test.each(certVectors)(
    "$name: the browser build accepts the foreign-signed certificate and identity file",
    async (vector) => {
      // Core -> browser for the certificate self-signature: the checked-in
      // signature was made outside this build, and the browser's verifier -- and
      // therefore its reconstruction of the signed bytes -- accepts it.
      await expect(parseCertificate(vector.certificate)).resolves.toBeDefined();
      await expect(
        parseSigningIdentity(vector.identityFile),
      ).resolves.toBeDefined();
      expect(await computeCertificateFingerprint(vector.certificate)).toBe(
        vector.expected.fingerprint,
      );
    },
  );

  test.each(certVectors)(
    "$name: the browser build rejects the certificate with one signature bit flipped",
    async (vector) => {
      const signature = b64uToBytes(vector.certificate.signature);
      signature[0] ^= 0x01;
      const tampered = {
        ...vector.certificate,
        signature: bytesToB64u(signature),
      };
      expect(await verifyCertificateSelfSignature(tampered)).toBe(false);
    },
  );

  test("the browser build rejects an off-curve key, the identity element, and a non-canonical coordinate", async () => {
    // The rejections the Node suite makes, re-asserted on this platform through
    // the module rather than through importKey: the outcome is what has to hold
    // in the browser, and which layer refuses is the Node suite's measurement.
    const [vector] = certVectors as [CertVector];
    const withPublicKey = (x: string, y: string) => ({
      ...vector.certificate,
      publicKey: { ...vector.certificate.publicKey, x, y },
    });
    const { x, y } = vector.privateKey;

    const offCurveY = b64uToBytes(y);
    offCurveY[31] ^= 0x01;
    await expect(
      parseCertificate(withPublicKey(x, bytesToB64u(offCurveY))),
    ).rejects.toThrow(/is not a valid P-256 point/);

    const zero = bytesToB64u(new Uint8Array(32));
    await expect(parseCertificate(withPublicKey(zero, zero))).rejects.toThrow(
      /is not a valid P-256 point/,
    );

    // A coordinate with a 33rd leading zero byte is the same point under a
    // different string, and therefore a second fingerprint for one key. The
    // fixed 32-byte length is the module's pin rather than importKey's, so it
    // must hold here whatever this platform's importKey would have admitted.
    const padded = new Uint8Array(33);
    padded.set(b64uToBytes(x), 1);
    await expect(
      parseCertificate(withPublicKey(bytesToB64u(padded), y)),
    ).rejects.toThrow(/must be 32 bytes, got 33/);
  });

  test("the browser build rejects an identity file whose private key is not its certificate's", async () => {
    // The keypair-agreement check is a signature probe rather than a platform
    // behavior, so this holds on any runtime; asserting it here is what makes
    // that platform-independence a check instead of a claim.
    const [a, b] = certVectors as [CertVector, CertVector];
    await expect(
      parseSigningIdentity({ ...a.identityFile, privateKey: b.privateKey }),
    ).rejects.toThrow(/does not match its certificate's public key/);
    await expect(
      parseSigningIdentity({
        ...a.identityFile,
        privateKey: { ...a.privateKey, d: b.privateKey.d },
      }),
    ).rejects.toThrow();
  });
});

describe("signed receipt in the browser", () => {
  test.each(receiptVectors)(
    "$name: the browser build reproduces the fingerprint and binder",
    async (vector) => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      expect(await computeCertificateFingerprint(identity.certificate)).toBe(
        vector.expected.fingerprint,
      );
      expect(
        await deriveReceiptBinder(b64uToBytes(vector.sessionKey), vector.role),
      ).toBe(vector.expected.binder);
    },
  );

  test.each(receiptVectors)(
    "$name: a signature produced outside the browser build verifies inside it",
    async (vector) => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          vector.expected.signature,
          vector.role,
        ),
      ).toBe(true);
    },
  );

  test.each(receiptVectors)(
    "$name: a signature the browser build produces verifies over the same fixed key and content",
    async (vector) => {
      // The other direction. Signing and verification share one construction of
      // the signed bytes, and the test above already showed this build's bytes
      // match the ones the checked-in signature covers, so a signature made here
      // is over those same bytes -- which is what the Node suite verifies from
      // its side.
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      const signature = await signReceiptContent(
        identity,
        vector.content,
        vector.role,
      );
      expect(signature).not.toBe(vector.expected.signature);
      expect(b64uToBytes(signature)).toHaveLength(64);
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          signature,
          vector.role,
        ),
      ).toBe(true);
    },
  );

  test.each(receiptVectors)(
    "$name: the browser build rejects a flipped bit, the other role, and mutated content",
    async (vector) => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      const otherRole =
        vector.role === "initiator" ? "responder" : ("initiator" as const);
      const flipped = b64uToBytes(vector.expected.signature);
      flipped[0] ^= 0x01;
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          bytesToB64u(flipped),
          vector.role,
        ),
      ).toBe(false);
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          vector.expected.signature,
          otherRole,
        ),
      ).toBe(false);
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          { ...vector.content, termsHash: "bXV0YXRlZA" },
          vector.expected.signature,
          vector.role,
        ),
      ).toBe(false);
    },
  );

  test("the browser build verifies a whole bundle signed outside it", async () => {
    // The verification consumer's turn at the same contract: every signature in
    // this record -- both certificate self-signatures and both receipt
    // signatures -- was made by openssl, so a browser build whose signed bytes
    // or certificate body diverged would reject it.
    const record = parseDualSignedRecord(receiptBundle.record);
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [
        receiptBundle.expected.responderFingerprint,
        receiptBundle.expected.initiatorFingerprint,
      ],
      expectedIdentities: [
        receiptBundle.expected.initiatorIdentity,
        receiptBundle.expected.responderIdentity,
      ],
      expectedTermsHash: record.content.termsHash,
      // The bundle is a receipt with no exchange record beside it, so its own
      // binder stands in for the record's: what this test pins is the signed-byte
      // layout, not the pairing.
      recordReceiptBinder: record.content.binder,
    });
    expect(report.outcome).toBe("verified");
    expect(report.initiator.fingerprint).toBe(
      receiptBundle.expected.initiatorFingerprint,
    );
  });
});
