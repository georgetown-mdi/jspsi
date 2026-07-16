import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SIGNED_RECEIPT_VERSION,
  ReceiptVerificationError,
  buildReceiptContent,
  deriveReceiptBinder,
  digestCommittedPayload,
  exchangeSignedReceipt,
  parseDualSignedRecord,
  serializeDualSignedRecord,
  signReceiptContent,
  verifyReceiptSignature,
} from "../src/signedReceipt";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/signingIdentity";
import { createMessagePipe } from "../src/connection/messageConnection";

import type {
  DualSignedRecord,
  ReceiptContent,
  SignedReceiptExchangeInputs,
} from "../src/signedReceipt";
import type { CommittedPayload } from "../src/exchangeRecord";
import type { SigningIdentity } from "../src/signingIdentity";

// --- Fixtures ----------------------------------------------------------------

// Deterministic identities so the tests are reproducible and can be re-derived
// by an independent implementation seeded identically (the cross-impl class).
const seedA = new Uint8Array(32).map((_, i) => i);
const seedB = new Uint8Array(32).map((_, i) => (i + 100) & 0xff);
const identityA = generateSigningIdentity("Party A", { seed: seedA });
const identityB = generateSigningIdentity("Party B", { seed: seedB });

const fingerprintA = await computeCertificateFingerprint(identityA.certificate);
const fingerprintB = await computeCertificateFingerprint(identityB.certificate);

// A fixed session key so both parties derive the same binder; a distinct one
// stands in for a different exchange (the replay class).
const sessionKey = new Uint8Array(32).fill(7);
const otherSessionKey = new Uint8Array(32).fill(9);

function content(overrides: Partial<ReceiptContent> = {}): ReceiptContent {
  return {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
    ...overrides,
  };
}

// --- Per-exchange binder -----------------------------------------------------

describe("deriveReceiptBinder", () => {
  test("both parties derive the same binder for one exchange", async () => {
    // The binder is derived from the initiator's role by BOTH parties, so the two
    // sides compute one shared value with no extra messages.
    const a = await deriveReceiptBinder(sessionKey, "initiator");
    const b = await deriveReceiptBinder(sessionKey, "initiator");
    expect(a).toBe(b);
    // 32 bytes -> 43 unpadded base64url characters.
    expect(a).toHaveLength(43);
  });

  test("a different session key yields a different binder (replay separation)", async () => {
    const a = await deriveReceiptBinder(sessionKey, "initiator");
    const other = await deriveReceiptBinder(otherSessionKey, "initiator");
    expect(a).not.toBe(other);
  });

  test("the role suffix separates the two role labels", async () => {
    const init = await deriveReceiptBinder(sessionKey, "initiator");
    const resp = await deriveReceiptBinder(sessionKey, "responder");
    expect(init).not.toBe(resp);
  });

  test("an unknown role throws rather than deriving a silent binder", async () => {
    await expect(
      deriveReceiptBinder(sessionKey, "bogus" as "initiator"),
    ).rejects.toThrow(/unknown role/);
  });
});

// --- Sign / verify -----------------------------------------------------------

describe("signReceiptContent / verifyReceiptSignature", () => {
  test("a signature verifies against the same content and certificate", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c);
    expect(verifyReceiptSignature(identityA.certificate, c, sig)).toBe(true);
  });

  test("Ed25519 signatures are deterministic (same content, same signature)", async () => {
    const c = content();
    const sig1 = await signReceiptContent(identityA, c);
    const sig2 = await signReceiptContent(identityA, c);
    expect(sig1).toBe(sig2);
  });

  test("a mutated content field fails verification (tamper detection)", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c);
    const tampered = content({ termsHash: "dGFtcGVyZWQ" });
    expect(verifyReceiptSignature(identityA.certificate, tampered, sig)).toBe(
      false,
    );
  });

  test("a content with a different binder fails (wrong exchange)", async () => {
    const c = content({
      binder: await deriveReceiptBinder(sessionKey, "initiator"),
    });
    const sig = await signReceiptContent(identityA, c);
    const otherExchange = content({
      binder: await deriveReceiptBinder(otherSessionKey, "initiator"),
    });
    expect(
      verifyReceiptSignature(identityA.certificate, otherExchange, sig),
    ).toBe(false);
  });

  test("the wrong certificate (another party's) fails verification", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c);
    expect(verifyReceiptSignature(identityB.certificate, c, sig)).toBe(false);
  });

  test("a malformed signature is a false verdict, not a throw", () => {
    expect(
      verifyReceiptSignature(identityA.certificate, content(), "!!!"),
    ).toBe(false);
    expect(
      verifyReceiptSignature(identityA.certificate, content(), "AAAA"),
    ).toBe(false);
  });

  test("a mutated directional payload digest fails verification", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c);
    const swapped = content({
      initiatorToResponderPayload: c.responderToInitiatorPayload,
      responderToInitiatorPayload: c.initiatorToResponderPayload,
    });
    // Swapping the two directions changes the signed bytes, so the signature over
    // the original directions must not verify.
    expect(verifyReceiptSignature(identityA.certificate, swapped, sig)).toBe(
      false,
    );
  });
});

// --- Directional payload digest ----------------------------------------------

describe("digestCommittedPayload / buildReceiptContent", () => {
  const sentAtoB: CommittedPayload = {
    columns: ["dose"],
    rows: [["5mg"], ["10mg"]],
  };
  const sentBtoA: CommittedPayload = {
    columns: ["status"],
    rows: [["active"]],
  };
  const empty: CommittedPayload = { columns: [], rows: [] };

  test("the digest is deterministic and salt-free (same data, same digest)", async () => {
    expect(await digestCommittedPayload(sentAtoB)).toBe(
      await digestCommittedPayload({
        columns: ["dose"],
        rows: [["5mg"], ["10mg"]],
      }),
    );
  });

  test("distinct data yields distinct digests", async () => {
    expect(await digestCommittedPayload(sentAtoB)).not.toBe(
      await digestCommittedPayload(sentBtoA),
    );
    expect(await digestCommittedPayload(empty)).not.toBe(
      await digestCommittedPayload(sentAtoB),
    );
  });

  test("both roles build byte-identical content from the same flow", async () => {
    // The initiator sends A->B and receives B->A; the responder sends B->A and
    // receives A->B. buildReceiptContent keys by role, so both produce the same
    // two directional digests under the same keys -- the mutually-signed bytes.
    const binder = "YmluZGVy";
    const termsHash = "dGVybXNIYXNo";
    const initiatorContent = await buildReceiptContent(
      "initiator",
      termsHash,
      sentAtoB, // initiator's localPayloadSent (A->B)
      sentBtoA, // initiator's partnerPayloadReceived (B->A)
      binder,
    );
    const responderContent = await buildReceiptContent(
      "responder",
      termsHash,
      sentBtoA, // responder's localPayloadSent (B->A)
      sentAtoB, // responder's partnerPayloadReceived (A->B)
      binder,
    );
    expect(initiatorContent).toEqual(responderContent);
    expect(initiatorContent.initiatorToResponderPayload).toBe(
      await digestCommittedPayload(sentAtoB),
    );
    expect(initiatorContent.responderToInitiatorPayload).toBe(
      await digestCommittedPayload(sentBtoA),
    );
  });
});

// --- Wire exchange over the in-memory pipe -----------------------------------

/**
 * Run the two-party signature exchange over an in-memory pipe. Both parties build
 * the SAME content (as they do in a real exchange, from shared state); each side's
 * inputs carry its own identity and the pinned fingerprint of the partner.
 */
async function runReceiptExchange(
  initiatorInputs: SignedReceiptExchangeInputs,
  responderInputs: SignedReceiptExchangeInputs,
): Promise<[DualSignedRecord, DualSignedRecord]> {
  const [connInit, connResp] = createMessagePipe();
  return Promise.all([
    exchangeSignedReceipt(connInit, "initiator", initiatorInputs),
    exchangeSignedReceipt(connResp, "responder", responderInputs),
  ]);
}

function inputsFor(
  identity: SigningIdentity,
  pinnedFingerprint: string | undefined,
  sharedContent: ReceiptContent,
): SignedReceiptExchangeInputs {
  return { identity, pinnedFingerprint, content: sharedContent };
}

/**
 * Run the exchange expecting the RESPONDER to reject the initiator's frame before
 * sending its own, and return the responder's rejection reason. When the responder
 * rejects pre-send the initiator is left parked on a receive that never arrives
 * (the accepted terminate-and-restart semantics; a real transport would surface a
 * peer-silence timeout). The in-memory pipe has no inactivity deadline, so close
 * the initiator's connection once the responder settles to release its receive --
 * modeling the caller tearing the connection down on the terminated exchange.
 */
async function expectResponderReject(
  initiatorInputs: SignedReceiptExchangeInputs,
  responderInputs: SignedReceiptExchangeInputs,
): Promise<unknown> {
  const [connInit, connResp] = createMessagePipe();
  const initiator = exchangeSignedReceipt(
    connInit,
    "initiator",
    initiatorInputs,
  ).catch(() => undefined);
  const responderResult = await exchangeSignedReceipt(
    connResp,
    "responder",
    responderInputs,
  ).then(
    () => {
      throw new Error("expected the responder to reject, but it resolved");
    },
    (reason: unknown) => reason,
  );
  // Release the initiator's parked receive so the test does not hang.
  await connInit.close();
  await connResp.close();
  await initiator;
  return responderResult;
}

describe("exchangeSignedReceipt (two-party over the pipe)", () => {
  test("a successful swap yields one dual-signed record on both sides", async () => {
    const shared = content();
    const [recInit, recResp] = await runReceiptExchange(
      inputsFor(identityA, fingerprintB, shared),
      inputsFor(identityB, fingerprintA, shared),
    );
    // Both parties write a byte-identical artifact (roles fixed by the handshake,
    // not by local/partner), carrying both certificates and signatures.
    expect(recInit).toEqual(recResp);
    expect(recInit.version).toBe(SIGNED_RECEIPT_VERSION);
    expect(recInit.content).toEqual(shared);
    expect(recInit.initiator.certificate).toEqual(identityA.certificate);
    expect(recInit.responder.certificate).toEqual(identityB.certificate);
    // Each party's signature verifies against the shared content under its cert.
    expect(
      verifyReceiptSignature(
        recInit.initiator.certificate,
        recInit.content,
        recInit.initiator.signature,
      ),
    ).toBe(true);
    expect(
      verifyReceiptSignature(
        recInit.responder.certificate,
        recInit.content,
        recInit.responder.signature,
      ),
    ).toBe(true);
  });

  test("a forged partner signature is rejected and terminates the exchange", async () => {
    // The initiator signs a DIFFERENT content than the shared one both verify
    // against, so its frame's signature does not verify for the responder. The
    // responder rejects with a security error BEFORE sending its own signature.
    const shared = content();
    const initiatorSignsWrong = inputsFor(identityA, fingerprintB, {
      ...shared,
      termsHash: "Zm9yZ2Vk",
    });
    const reason = await expectResponderReject(
      initiatorSignsWrong,
      inputsFor(identityB, fingerprintA, shared),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(/signature does not verify/);
  });

  test("a partner certificate not matching the pin is rejected fail-closed", async () => {
    // The responder pins the WRONG fingerprint for the initiator (fingerprintB
    // instead of fingerprintA), so the presented cert A fails the pin. The pin
    // check runs BEFORE the signature check, so this fails on the fingerprint.
    const shared = content();
    const reason = await expectResponderReject(
      inputsFor(identityA, fingerprintB, shared),
      inputsFor(identityB, fingerprintB, shared),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(/not trusted/);
  });

  test("no pinned fingerprint fails closed before the signature check", async () => {
    // The responder has NO pin for the partner, so the presented cert cannot be
    // trusted at all: reject before ever verifying the signature.
    const shared = content();
    const reason = await expectResponderReject(
      inputsFor(identityA, fingerprintB, shared),
      inputsFor(identityB, undefined, shared),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(/not trusted/);
  });

  test("a receipt from another exchange (binder mismatch) is rejected", async () => {
    // Both parties agree on their pins and identities, but the initiator computes
    // its content with a binder from a DIFFERENT session while the responder uses
    // this exchange's binder. The responder rebuilds this exchange's content and
    // rejects the initiator's signature -- a receipt from another session cannot be
    // presented as evidence of this one.
    const thisBinder = await deriveReceiptBinder(sessionKey, "initiator");
    const otherBinder = await deriveReceiptBinder(otherSessionKey, "initiator");
    const reason = await expectResponderReject(
      inputsFor(identityA, fingerprintB, content({ binder: otherBinder })),
      inputsFor(identityB, fingerprintA, content({ binder: thisBinder })),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(
      /different exchange|does not verify/,
    );
  });
});

// --- Serialize / parse -------------------------------------------------------

describe("serialize / parse dual-signed record", () => {
  test("round-trips through serialize and parse", async () => {
    const shared = content();
    const [record] = await runReceiptExchange(
      inputsFor(identityA, fingerprintB, shared),
      inputsFor(identityB, fingerprintA, shared),
    );
    const parsed = parseDualSignedRecord(
      JSON.parse(serializeDualSignedRecord(record)),
    );
    expect(parsed).toEqual(record);
  });

  test("rejects an unrecognized version", () => {
    expect(() =>
      parseDualSignedRecord({
        version: "psilink-signed-receipt/v2",
        content: content(),
        initiator: { certificate: identityA.certificate, signature: "AAAA" },
        responder: { certificate: identityB.certificate, signature: "AAAA" },
      }),
    ).toThrow();
  });
});

// --- Cross-implementation determinism ----------------------------------------

// These vectors ARE the deterministic output of signReceiptContent /
// deriveReceiptBinder (regenerated by generate-signed-receipt-vectors.mjs). The
// cross-implementation guarantee is that any implementation, seeded and given the
// same content and session key, reproduces the same binder and signature -- so a
// signature one side produces the other side (a different implementation) can
// verify. This test pins the bytes; the browser suite reproduces them against the
// web build.
describe("cross-implementation vectors", () => {
  const vectorsPath = new URL(
    "./vectors/signed-receipt-vectors.json",
    import.meta.url,
  );
  const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
    vectors: Array<{
      name: string;
      seed: string;
      identity: string;
      sessionKey: string;
      role: "initiator" | "responder";
      content: ReceiptContent;
      expected: { binder: string; signature: string; fingerprint: string };
    }>;
  };

  const fromB64Url = (s: string): Uint8Array =>
    new Uint8Array(Buffer.from(s, "base64url"));

  for (const vector of vectors) {
    test(`${vector.name}: binder and signature reproduce`, async () => {
      const identity = generateSigningIdentity(vector.identity, {
        seed: fromB64Url(vector.seed),
      });
      const fingerprint = await computeCertificateFingerprint(
        identity.certificate,
      );
      expect(fingerprint).toBe(vector.expected.fingerprint);

      const binder = await deriveReceiptBinder(
        fromB64Url(vector.sessionKey) as Uint8Array<ArrayBuffer>,
        vector.role,
      );
      expect(binder).toBe(vector.expected.binder);

      const signature = await signReceiptContent(identity, vector.content);
      expect(signature).toBe(vector.expected.signature);
      // And the produced signature verifies -- a cross-impl signer's output is
      // accepted by this verifier.
      expect(
        verifyReceiptSignature(identity.certificate, vector.content, signature),
      ).toBe(true);
    });
  }
});
