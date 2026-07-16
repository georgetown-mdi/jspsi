/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import {
  computeCertificateFingerprint,
  deriveReceiptBinder,
  generateSigningIdentity,
  signReceiptContent,
  verifyReceiptSignature,
} from "@psilink/core";

import vectorsRaw from "../../../../packages/core/test/vectors/signed-receipt-vectors.json?raw";

// The companion to packages/core/test/signedReceipt.test.ts's vector suite: it
// runs the SAME checked-in signed-receipt vectors through the browser build of
// @psilink/core in real Chromium. The Node suite proves Node reproduces the
// vectors and this suite proves the browser reproduces the same fingerprint,
// binder, and signature, so a signature produced by one implementation (the CLI,
// Node) is byte-identical to -- and verifiable by -- the other (the web build,
// browser). This is the cross-implementation determinism the signed-receipt work
// requires. The step uses only platform-neutral primitives (crypto.subtle,
// TextEncoder, the pure-JS canonicalizer, @noble/curves), so it holds by
// construction; the test guards against a regression introducing a platform
// dependency.

type ReceiptContent = Parameters<typeof signReceiptContent>[1];

interface ReceiptVector {
  name: string;
  seed: string;
  identity: string;
  sessionKey: string;
  role: "initiator" | "responder";
  content: ReceiptContent;
  expected: { binder: string; signature: string; fingerprint: string };
}

const vectors = (JSON.parse(vectorsRaw) as { vectors: Array<ReceiptVector> })
  .vectors;

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("signed receipt in the browser", () => {
  test.each(vectors)(
    "$name: browser build reproduces the fingerprint, binder, and signature",
    async (vector) => {
      const identity = generateSigningIdentity(vector.identity, {
        seed: b64uToBytes(vector.seed),
      });
      const fingerprint = await computeCertificateFingerprint(
        identity.certificate,
      );
      expect(fingerprint).toBe(vector.expected.fingerprint);

      const binder = await deriveReceiptBinder(
        b64uToBytes(vector.sessionKey),
        vector.role,
      );
      expect(binder).toBe(vector.expected.binder);

      const signature = await signReceiptContent(
        identity,
        vector.content,
        vector.role,
      );
      expect(signature).toBe(vector.expected.signature);
      // The signature the browser produced verifies -- a cross-implementation
      // signer's output is accepted by the verifier (bytes bound to the same role).
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
});
