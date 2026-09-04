import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SIGNED_RECEIPT_VERSION,
  ReceiptVerificationError,
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
  parseDualSignedRecord,
  serializeDualSignedRecord,
  signReceiptContent,
  verifyReceiptSignature,
} from "../src/signedReceipt";
import { fromBase64Url, hkdfDerive, toBase64Url } from "../src/utils/crypto";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/signingIdentity";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";

import type {
  DualSignedRecord,
  ReceiptContent,
  SignedReceiptExchangeInputs,
} from "../src/signedReceipt";
import type { CommittedPayload } from "../src/exchangeRecord";
import type { P256PrivateJwk, SigningIdentity } from "../src/signingIdentity";

// --- Fixtures ----------------------------------------------------------------

// Fixed keys so the tests are reproducible and can be re-derived by an
// independent implementation given the same key (the cross-impl class).
// crypto.subtle.generateKey takes no seed, so a fixed key -- not a seed -- is
// what makes a signing identity reproducible.
const keyA: P256PrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "TGM247iz3ncbYTocehc0g0zWnBpPX_7LJAxjvA3bFXQ",
  y: "9olsXRTKROADd5HCMAMzJZpxuQHlJYV10QfluKxItCQ",
  d: "ERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzA",
};
const keyB: P256PrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "UUL0inyAyvR1RKQo_FfScqbGeK1ek__Lo2ZmqZY55R0",
  y: "0b22-1mBRFZ6Jlfo_zYZ-6oM0qBAwZqyKvkQxwWnV7o",
  d: "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM",
};
const identityA = await generateSigningIdentity("Party A", {
  privateKey: keyA,
});
const identityB = await generateSigningIdentity("Party B", {
  privateKey: keyB,
});
// The agreed-terms identity each party asserts for its partner. In these
// fixtures the certificate identity and the agreed-terms identity coincide
// (a well-behaved partner); the tautology-fix test below drives them apart.
const partnerIdentityForA = identityB.certificate.identity;
const partnerIdentityForB = identityA.certificate.identity;

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
  test("ECDSA signatures are randomized: two signings differ and both verify", async () => {
    // The receipt format therefore cannot pin a signature as a known answer;
    // what reproduces across implementations is the signed bytes, so a fixed
    // signature over them verifies everywhere (see the vector suite below).
    const c = content();
    const sig1 = await signReceiptContent(identityA, c, "initiator");
    const sig2 = await signReceiptContent(identityA, c, "initiator");
    expect(sig1).not.toBe(sig2);
    for (const sig of [sig1, sig2])
      expect(
        await verifyReceiptSignature(
          identityA.certificate,
          c,
          sig,
          "initiator",
        ),
      ).toBe(true);
  });

  test("a signature is the fixed-length raw r||s, and any other length is refused", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c, "initiator");
    expect(fromBase64Url(sig)).toHaveLength(64);
    const truncated = toBase64Url(fromBase64Url(sig).subarray(0, 63));
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        c,
        truncated,
        "initiator",
      ),
    ).toBe(false);
    // A DER SEQUENCE of the same two field elements is refused on its length,
    // not decoded: crypto.subtle emits and accepts only the raw encoding.
    const raw = fromBase64Url(sig);
    const der = new Uint8Array([
      0x30,
      0x44,
      0x02,
      0x20,
      ...raw.subarray(0, 32),
      0x02,
      0x20,
      ...raw.subarray(32),
    ]);
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        c,
        toBase64Url(der),
        "initiator",
      ),
    ).toBe(false);
  });

  test("a mutated content field fails verification (tamper detection)", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c, "initiator");
    const tampered = content({ termsHash: "dGFtcGVyZWQ" });
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        tampered,
        sig,
        "initiator",
      ),
    ).toBe(false);
  });

  test("a content with a different binder fails (wrong exchange)", async () => {
    const c = content({
      binder: await deriveReceiptBinder(sessionKey, "initiator"),
    });
    const sig = await signReceiptContent(identityA, c, "initiator");
    const otherExchange = content({
      binder: await deriveReceiptBinder(otherSessionKey, "initiator"),
    });
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        otherExchange,
        sig,
        "initiator",
      ),
    ).toBe(false);
  });

  test("the wrong certificate (another party's) fails verification", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c, "initiator");
    expect(
      await verifyReceiptSignature(identityB.certificate, c, sig, "initiator"),
    ).toBe(false);
  });

  test("the wrong signer role fails verification (block-swap resistance)", async () => {
    // A signature made bound to the initiator role does not verify when checked as
    // the responder's: the signed bytes bind the signer's role, so the two blocks in
    // a dual-signed record are not interchangeable.
    const c = content();
    const sig = await signReceiptContent(identityA, c, "initiator");
    expect(
      await verifyReceiptSignature(identityA.certificate, c, sig, "responder"),
    ).toBe(false);
  });

  test("a malformed signature is a false verdict, not a throw", async () => {
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        content(),
        "!!!",
        "initiator",
      ),
    ).toBe(false);
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        content(),
        "AAAA",
        "initiator",
      ),
    ).toBe(false);
  });

  test("a mutated directional payload MAC fails verification", async () => {
    const c = content();
    const sig = await signReceiptContent(identityA, c, "initiator");
    const swapped = content({
      initiatorToResponderPayload: c.responderToInitiatorPayload,
      responderToInitiatorPayload: c.initiatorToResponderPayload,
    });
    // Swapping the two directions changes the signed bytes, so the signature over
    // the original directions must not verify.
    expect(
      await verifyReceiptSignature(
        identityA.certificate,
        swapped,
        sig,
        "initiator",
      ),
    ).toBe(false);
  });
});

// --- Directional payload MAC -------------------------------------------------

describe("buildReceiptContent (session-keyed directional payload MACs)", () => {
  const sentAtoB: CommittedPayload = {
    columns: ["dose"],
    rows: [["5mg"], ["10mg"]],
  };
  const sentBtoA: CommittedPayload = {
    columns: ["status"],
    rows: [["active"]],
  };
  const empty: CommittedPayload = { columns: [], rows: [] };
  const binder = "YmluZGVy";
  const termsHash = "dGVybXNIYXNo";

  test("both roles build byte-identical content from the same flow and session key", async () => {
    // The initiator sends A->B and receives B->A; the responder sends B->A and
    // receives A->B. buildReceiptContent keys by role, so both produce the same
    // two directional MACs under the same keys -- the mutually-signed content.
    const initiatorContent = await buildReceiptContent(
      "initiator",
      termsHash,
      sentAtoB, // initiator's localPayloadSent (A->B)
      sentBtoA, // initiator's partnerPayloadReceived (B->A)
      binder,
      sessionKey,
    );
    const responderContent = await buildReceiptContent(
      "responder",
      termsHash,
      sentBtoA, // responder's localPayloadSent (B->A)
      sentAtoB, // responder's partnerPayloadReceived (A->B)
      binder,
      sessionKey,
    );
    expect(initiatorContent).toEqual(responderContent);
  });

  test("distinct data yields distinct directional MACs", async () => {
    const c = await buildReceiptContent(
      "initiator",
      termsHash,
      sentAtoB,
      sentBtoA,
      binder,
      sessionKey,
    );
    expect(c.initiatorToResponderPayload).not.toBe(
      c.responderToInitiatorPayload,
    );
    const withEmpty = await buildReceiptContent(
      "initiator",
      termsHash,
      empty,
      sentBtoA,
      binder,
      sessionKey,
    );
    expect(withEmpty.initiatorToResponderPayload).not.toBe(
      c.initiatorToResponderPayload,
    );
  });

  test("a different session key yields different directional MACs (third-party non-recomputability)", async () => {
    // The MAC key is derived from the session key, so a holder without the session
    // key cannot recompute the MAC (nor brute-force the payload from it): the same
    // payload under a different session key produces a different MAC.
    const c = await buildReceiptContent(
      "initiator",
      termsHash,
      sentAtoB,
      sentBtoA,
      binder,
      sessionKey,
    );
    const other = await buildReceiptContent(
      "initiator",
      termsHash,
      sentAtoB,
      sentBtoA,
      binder,
      otherSessionKey,
    );
    expect(other.initiatorToResponderPayload).not.toBe(
      c.initiatorToResponderPayload,
    );
    expect(other.responderToInitiatorPayload).not.toBe(
      c.responderToInitiatorPayload,
    );
  });

  test("the empty-payload direction is not a public constant (session-keyed)", async () => {
    const macKeyA = await hkdfDerive(
      sessionKey,
      "psilink-signed-receipt-payload-v1:initiator-to-responder",
      32,
    );
    const macKeyB = await hkdfDerive(
      otherSessionKey,
      "psilink-signed-receipt-payload-v1:initiator-to-responder",
      32,
    );
    const emptyA = await buildReceiptContent(
      "initiator",
      termsHash,
      empty,
      sentBtoA,
      binder,
      sessionKey,
    );
    const emptyB = await buildReceiptContent(
      "initiator",
      termsHash,
      empty,
      sentBtoA,
      binder,
      otherSessionKey,
    );
    expect(emptyA.initiatorToResponderPayload).not.toBe(
      emptyB.initiatorToResponderPayload,
    );
    // The two session keys' derived MAC keys differ, so a third party without the
    // session key holds no fixed value to recognize the empty direction by.
    expect(macKeyA).not.toEqual(macKeyB);
  });
});

// --- Wire exchange over the in-memory pipe -----------------------------------

/**
 * Run the two-party signature exchange over an in-memory pipe. Both parties
 * build the SAME content (as they do in a real exchange, from shared
 * state); each side's inputs hold its own identity and the pinned
 * fingerprint of the partner.
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
  partnerIdentity: string,
  sharedContent: ReceiptContent,
): SignedReceiptExchangeInputs {
  return {
    identity,
    pinnedFingerprint,
    partnerIdentity,
    content: sharedContent,
  };
}

/**
 * Run the exchange expecting the RESPONDER to reject the initiator's frame
 * before sending its own, returning the responder's rejection reason. The
 * initiator is left parked on a receive that never arrives -- the accepted
 * terminate-and-restart semantics (a real transport would report a
 * peer-silence timeout there). The pipe has no inactivity deadline, so
 * close the initiator's connection once the responder settles, modeling
 * the caller tearing down a terminated exchange.
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
      inputsFor(identityA, fingerprintB, partnerIdentityForA, shared),
      inputsFor(identityB, fingerprintA, partnerIdentityForB, shared),
    );
    // Both parties write the same artifact (roles fixed by the handshake,
    // not by local/partner), holding both certificates and signatures: each
    // copies the signature the other sent rather than re-deriving it, so the
    // two files agree byte for byte even though ECDSA signing is randomized.
    expect(recInit).toEqual(recResp);
    expect(recInit.version).toBe(SIGNED_RECEIPT_VERSION);
    expect(recInit.content).toEqual(shared);
    expect(recInit.initiator.certificate).toEqual(identityA.certificate);
    expect(recInit.responder.certificate).toEqual(identityB.certificate);
    expect(
      await verifyReceiptSignature(
        recInit.initiator.certificate,
        recInit.content,
        recInit.initiator.signature,
        "initiator",
      ),
    ).toBe(true);
    expect(
      await verifyReceiptSignature(
        recInit.responder.certificate,
        recInit.content,
        recInit.responder.signature,
        "responder",
      ),
    ).toBe(true);
    expect(
      await verifyReceiptSignature(
        recInit.initiator.certificate,
        recInit.content,
        recInit.initiator.signature,
        "responder",
      ),
    ).toBe(false);
  });

  test("a forged partner signature is rejected and terminates the exchange", async () => {
    // The initiator signs a DIFFERENT content than the shared one both verify
    // against, so its frame's signature does not verify for the responder. The
    // responder rejects with a security error BEFORE sending its own signature.
    const shared = content();
    const initiatorSignsWrong = inputsFor(
      identityA,
      fingerprintB,
      partnerIdentityForA,
      {
        ...shared,
        termsHash: "Zm9yZ2Vk",
      },
    );
    const reason = await expectResponderReject(
      initiatorSignsWrong,
      inputsFor(identityB, fingerprintA, partnerIdentityForB, shared),
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
      inputsFor(identityA, fingerprintB, partnerIdentityForA, shared),
      inputsFor(identityB, fingerprintB, partnerIdentityForB, shared),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(/not trusted/);
  });

  test("no pinned fingerprint fails closed before the signature check", async () => {
    // The responder has NO pin for the partner, so the presented cert cannot be
    // trusted at all: reject before ever verifying the signature.
    const shared = content();
    const reason = await expectResponderReject(
      inputsFor(identityA, fingerprintB, partnerIdentityForA, shared),
      inputsFor(identityB, undefined, partnerIdentityForB, shared),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(/not trusted/);
  });

  test("a validly-pinned cert whose identity differs from the agreed terms fails closed", async () => {
    // The responder pins the initiator's REAL certificate (fingerprintA) but
    // asserts a DIFFERENT agreed-terms identity for it than the certificate
    // holds. The pin and self-signature pass, but the certificate does not
    // authorize the asserted agreed-terms identity, so the receipt is
    // rejected with a security error -- closing the tautology where the
    // certificate's own identity was asserted.
    const shared = content();
    const reason = await expectResponderReject(
      inputsFor(identityA, fingerprintB, partnerIdentityForA, shared),
      inputsFor(identityB, fingerprintA, "Not Party A", shared),
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
      inputsFor(
        identityA,
        fingerprintB,
        partnerIdentityForA,
        content({ binder: otherBinder }),
      ),
      inputsFor(
        identityB,
        fingerprintA,
        partnerIdentityForB,
        content({ binder: thisBinder }),
      ),
    );
    expect(reason).toBeInstanceOf(ReceiptVerificationError);
    expect((reason as Error).message).toMatch(
      /different exchange|does not verify/,
    );
  });

  // What a party parked here observes when its partner refuses a binding of its
  // own just before the swap and aborts (assertReceiptBindingsOrAbort in
  // exchange.ts). Both roles park on a receive at some point -- the responder
  // before it sends anything, the initiator after -- so both are driven.
  for (const parkedRole of ["initiator", "responder"] as const) {
    test(`the ${parkedRole} ends on a partner abort rather than waiting out its transport`, async () => {
      const [connParked, connAborting] = createMessagePipe();
      const shared = content();
      const parked = exchangeSignedReceipt(
        connParked,
        parkedRole,
        inputsFor(
          parkedRole === "initiator" ? identityA : identityB,
          parkedRole === "initiator" ? fingerprintB : fingerprintA,
          parkedRole === "initiator"
            ? partnerIdentityForA
            : partnerIdentityForB,
          shared,
        ),
      ).then(
        () => {
          throw new Error("expected the parked party to reject, not return");
        },
        (reason: unknown) => reason,
      );
      // The initiator sends its own frame first and then parks, so drain it.
      if (parkedRole === "initiator") await connAborting.receive();
      await connAborting.send({
        decision: "abort",
        abortReasons: [
          "a signing certificate does not authorize the identity its holder " +
            "agreed terms under",
        ],
      });
      // The frame is not a receipt, so the parked receive refuses it as a
      // protocol fault -- with no close, no timeout, and nothing signed.
      const reason = await parked;
      expect(reason).toBeInstanceOf(ConnectionError);
      expect((reason as ConnectionError).kind).toBe("protocol");
      await connParked.close();
      await connAborting.close();
    });
  }
});

// --- Serialize / parse -------------------------------------------------------

describe("serialize / parse dual-signed record", () => {
  test("round-trips through serialize and parse", async () => {
    const shared = content();
    const [record] = await runReceiptExchange(
      inputsFor(identityA, fingerprintB, partnerIdentityForA, shared),
      inputsFor(identityB, fingerprintA, partnerIdentityForB, shared),
    );
    const parsed = parseDualSignedRecord(
      JSON.parse(serializeDualSignedRecord(record)),
    );
    expect(parsed).toEqual(record);
  });

  test("rejects an unrecognized version", () => {
    expect(() =>
      parseDualSignedRecord({
        version: "psilink-signed-receipt/v9",
        content: content(),
        initiator: { certificate: identityA.certificate, signature: "AAAA" },
        responder: { certificate: identityB.certificate, signature: "AAAA" },
      }),
    ).toThrow();
  });

  test("rejects a record from the previous format rather than parsing it", () => {
    // A record written under the previous signature scheme holds both the old
    // record version and old certificates (an Ed25519 key in an RFC 8037 OKP
    // JWK). Either discriminant refuses it; neither is reinterpreted.
    const v1Certificate = {
      version: "psilink-signing-cert/v1",
      algorithm: "ed25519",
      identity: "Party A",
      publicKey: {
        kty: "OKP",
        crv: "Ed25519",
        x: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
      },
      signature:
        "8WKs03xb2bO9IsxziElnQeQ4v6--9DKTCRl5RyasydYD5THhQBBQwUD0nDHK7Lqm8NqgxczxhKX7JjJWlJiyAQ",
    };
    const v1Party = { certificate: v1Certificate, signature: "AAAA" };
    expect(() =>
      parseDualSignedRecord({
        version: "psilink-signed-receipt/v1",
        content: content(),
        initiator: v1Party,
        responder: v1Party,
      }),
    ).toThrow();
    // Even relabelled with the current record version, the embedded v1
    // certificates are refused.
    expect(() =>
      parseDualSignedRecord({
        version: SIGNED_RECEIPT_VERSION,
        content: content(),
        initiator: v1Party,
        responder: v1Party,
      }),
    ).toThrow();
  });

  test("rejects an oversized certificate identity before any crypto work", () => {
    // The certificate/receipt wire schema bounds partner-controlled fields, so a
    // ~megabyte identity is refused at parse rather than passing shape validation
    // ahead of the fingerprint/signature work.
    const oversizedCert = {
      ...identityA.certificate,
      identity: "x".repeat(2000),
    };
    expect(() =>
      parseDualSignedRecord({
        version: SIGNED_RECEIPT_VERSION,
        content: content(),
        initiator: { certificate: oversizedCert, signature: "AAAA" },
        responder: { certificate: identityB.certificate, signature: "AAAA" },
      }),
    ).toThrow();
  });

  test("rejects an oversized base64url signature field before any crypto work", () => {
    expect(() =>
      parseDualSignedRecord({
        version: SIGNED_RECEIPT_VERSION,
        content: content(),
        initiator: {
          certificate: identityA.certificate,
          signature: "A".repeat(2000),
        },
        responder: { certificate: identityB.certificate, signature: "AAAA" },
      }),
    ).toThrow();
  });
});

// --- Cross-implementation vectors --------------------------------------------

// ECDSA signing is randomized, so these vectors pin two things instead of a
// reproduce-the-signature known answer: the fingerprint and per-exchange
// binder are deterministic known answers, reproduced by any implementation
// given the same key, identity, session key, and role. The signature is
// verify-only -- produced by OpenSSL over bytes the generator assembles
// from docs/spec/EXCHANGE_RECORD.md, not from signedReceipt.ts -- so
// accepting it proves this build's signed bytes match an independent
// implementation's, and the same fixed signature verifies in the browser
// suite's Chromium run of this file too. This build's own signature is
// also checked below, since sign and verify share the byte construction.
describe("cross-implementation vectors", () => {
  const vectorsPath = new URL(
    "./vectors/signed-receipt-vectors.json",
    import.meta.url,
  );
  const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
    vectors: Array<{
      name: string;
      identity: string;
      privateKey: P256PrivateJwk;
      sessionKey: string;
      role: "initiator" | "responder";
      content: ReceiptContent;
      expected: { binder: string; signature: string; fingerprint: string };
    }>;
  };

  for (const vector of vectors) {
    const otherRole = vector.role === "initiator" ? "responder" : "initiator";

    test(`${vector.name}: the fingerprint and binder reproduce`, async () => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      expect(await computeCertificateFingerprint(identity.certificate)).toBe(
        vector.expected.fingerprint,
      );
      expect(
        await deriveReceiptBinder(
          fromBase64Url(vector.sessionKey),
          vector.role,
        ),
      ).toBe(vector.expected.binder);
    });

    test(`${vector.name}: the checked-in foreign signature verifies`, async () => {
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
    });

    test(`${vector.name}: a signature this build produces also verifies, and differs`, async () => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      const signature = await signReceiptContent(
        identity,
        vector.content,
        vector.role,
      );
      expect(signature).not.toBe(vector.expected.signature);
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          signature,
          vector.role,
        ),
      ).toBe(true);
    });

    test(`${vector.name}: a flipped bit, the other role, and mutated content are rejected`, async () => {
      const identity = await generateSigningIdentity(vector.identity, {
        privateKey: vector.privateKey,
      });
      const flipped = fromBase64Url(vector.expected.signature);
      flipped[0] = (flipped[0] as number) ^ 0x01;
      expect(
        await verifyReceiptSignature(
          identity.certificate,
          vector.content,
          toBase64Url(flipped),
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
    });
  }
});
