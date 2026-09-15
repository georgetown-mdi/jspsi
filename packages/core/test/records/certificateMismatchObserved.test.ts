import { describe, expect, test } from "vitest";

import {
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
} from "../../src/records/signedReceipt";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
  observedPartnerCertificateMismatch,
  withPartnerCertificateCondition,
} from "../../src/records/signingIdentity";
import { buildExchangeRecord } from "../../src/records/exchangeRecord";
import { reconcileReceivedPayload } from "../../src/payloadExchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../../src/connection/messageConnection";

import type { SignedReceiptExchangeInputs } from "../../src/records/signedReceipt";
import type {
  PartnerCertificateCondition,
  SigningIdentity,
} from "../../src/records/signingIdentity";
import type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

// The record's certificate-mismatch marker, arm by arm. Every arm drives the
// real check that refuses -- the signed-receipt swap for the certificate ones,
// the received-payload reconciliation for its own -- and then builds a record
// the way the run path does, from the terminating error's own condition rather
// than from its message. What each arm's record states is specified in
// docs/spec/EXCHANGE_RECORD.md ("When a record is owed").

// --- Fixtures ----------------------------------------------------------------

const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["status"],
  rows: [["active"]],
};

const baseInputs: Omit<
  ExchangeRecordInputs,
  "outcome" | "certificateMismatchObserved"
> = {
  localTerms: termsA,
  partnerTerms: termsB,
  contributedLinkageFields: ["ssn"],
  recordsExposed: 2,
  resultSize: 1,
  associationTable: [[0], [0]],
  localPayloadSent,
  partnerPayloadReceived,
  createdAt: "2026-01-02T03:04:05.000Z",
};

const sessionKey = new Uint8Array(32).fill(7);

const identityA = await generateSigningIdentity("Party A");
const identityB = await generateSigningIdentity("Party B");
const fingerprintA = await computeCertificateFingerprint(identityA.certificate);
const fingerprintB = await computeCertificateFingerprint(identityB.certificate);

/**
 * What a terminated run's record states, built the way the run path builds it:
 * the outcome plus the marker read off the terminating error's own condition.
 */
async function terminatedRecordFor(error: unknown): Promise<boolean> {
  const { record } = await buildExchangeRecord({
    ...baseInputs,
    outcome: "receipt-swap-terminated",
    certificateMismatchObserved: observedPartnerCertificateMismatch(error),
  });
  return record.certificateMismatchObserved;
}

async function receiptInputs(
  identity: SigningIdentity,
  pinnedFingerprint: string | undefined,
  partnerIdentity: string,
): Promise<SignedReceiptExchangeInputs> {
  const binder = await deriveReceiptBinder(sessionKey, "initiator");
  return {
    identity,
    pinnedFingerprint,
    partnerIdentity,
    content: await buildReceiptContent(
      "initiator",
      "dGVybXM",
      localPayloadSent,
      partnerPayloadReceived,
      binder,
      sessionKey,
    ),
  };
}

/**
 * The error the responder's side of a swap raises, with the initiator's parked
 * receive released so the test does not hang.
 */
async function swapRefusal(
  initiatorInputs: SignedReceiptExchangeInputs,
  responderInputs: SignedReceiptExchangeInputs,
): Promise<unknown> {
  const [connInit, connResp] = createMessagePipe();
  const initiator = exchangeSignedReceipt(
    connInit,
    "initiator",
    initiatorInputs,
  ).catch(() => undefined);
  const refusal = await exchangeSignedReceipt(
    connResp,
    "responder",
    responderInputs,
  ).then(
    () => {
      throw new Error("expected the responder to refuse the receipt frame");
    },
    (reason: unknown) => reason,
  );
  await connInit.close();
  await connResp.close();
  await initiator;
  return refusal;
}

// --- The arms that observe a mismatch ----------------------------------------

describe("a record states the certificate mismatch its run observed", () => {
  test("a presented fingerprint that is not the pinned one", async () => {
    // The responder pins fingerprintB for a partner that presents certificate
    // A: the fingerprint comparison itself refuses.
    const refusal = await swapRefusal(
      await receiptInputs(identityA, fingerprintB, "Party B"),
      await receiptInputs(identityB, fingerprintB, "Party A"),
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(true);
    expect(await terminatedRecordFor(refusal)).toBe(true);
  });

  test("a pinned certificate that does not authorize the agreed identity", async () => {
    // The pin and the self-signature both pass; the certificate is bound to a
    // name other than the one its holder agreed terms under, so it is not the
    // identity this run pinned for that partner.
    const refusal = await swapRefusal(
      await receiptInputs(identityA, fingerprintB, "Party B"),
      await receiptInputs(identityB, fingerprintA, "Not Party A"),
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(true);
    expect(await terminatedRecordFor(refusal)).toBe(true);
  });

  test("a presented certificate whose self-signature does not verify", async () => {
    // The fingerprint covers the certificate BODY alone, so a certificate
    // carrying A's body under another party's signature still matches the pin
    // and is caught at the swap, where the signature beside that body is
    // weighed. It is not the pinned identity: nothing holding A's key signed it.
    const unsigned: SigningIdentity = {
      ...identityA,
      certificate: {
        ...identityA.certificate,
        signature: identityB.certificate.signature,
      },
    };
    const refusal = await swapRefusal(
      await receiptInputs(unsigned, fingerprintB, "Party B"),
      await receiptInputs(identityB, fingerprintA, "Party A"),
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(true);
    expect(await terminatedRecordFor(refusal)).toBe(true);
  });
});

// --- The arms that observe none ----------------------------------------------

describe("a record states no mismatch where the run observed none", () => {
  test("a receipt signature that failed over a certificate that DID match", async () => {
    // The initiator signs content this exchange does not hold, so its signature
    // does not verify -- over a certificate that reached that check by matching
    // the pin. What failed is the signature, not the identity behind it.
    const initiatorInputs = await receiptInputs(
      identityA,
      fingerprintB,
      "Party B",
    );
    const refusal = await swapRefusal(
      {
        ...initiatorInputs,
        content: { ...initiatorInputs.content, termsHash: "b3RoZXI" },
      },
      await receiptInputs(identityB, fingerprintA, "Party A"),
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("no partner fingerprint pinned at all", async () => {
    // A gap in this party's own configuration. Nothing was compared, so nothing
    // was found: inferring a mismatch here would put a finding about the
    // partner in a record over a local omission.
    const refusal = await swapRefusal(
      await receiptInputs(identityA, fingerprintB, "Party B"),
      await receiptInputs(identityB, undefined, "Party A"),
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("a received payload outside the set this party consented to", async () => {
    const refusal = (() => {
      try {
        reconcileReceivedPayload(
          { columns: ["diagnosis"], rowIndices: [0], rows: [["x"]] },
          ["status"],
        );
      } catch (err: unknown) {
        return err;
      }
      throw new Error("expected the reconciliation to refuse");
    })();

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("a transport drop in the swap", async () => {
    const refusal = new ConnectionError("peer closed", "transport");

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("an unsigned run terminated past its disclosure", async () => {
    // No signing identity, so no certificate was presented and no pin
    // consulted: the run cannot have observed anything about either.
    const refusal = new ConnectionError("receive timed out", "closed");

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("a completed run", async () => {
    const { record } = await buildExchangeRecord({
      ...baseInputs,
      outcome: "completed",
      certificateMismatchObserved: false,
    });

    expect(record.certificateMismatchObserved).toBe(false);
  });
});

// --- What the predicate reads ------------------------------------------------

describe("the marker is read from a condition, never from message text", () => {
  test("a failure whose message names a fingerprint mismatch observes none", async () => {
    // The wording a genuine refusal uses, on an error that carries no condition:
    // a classifier matching on text would read this as a mismatch, and putting
    // a finding about the partner into a disclosure record on a string a
    // transport or a caller composed is what the condition exists to stop.
    const refusal = new Error(
      "partner certificate fingerprint does not match the pinned value",
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });

  test("a refusal re-raised behind another error is still read", async () => {
    const refusal = await swapRefusal(
      await receiptInputs(identityA, fingerprintB, "Party B"),
      await receiptInputs(identityB, fingerprintB, "Party A"),
    );
    const rewrapped = new Error("the run failed", { cause: refusal });

    expect(observedPartnerCertificateMismatch(rewrapped)).toBe(true);
    expect(await terminatedRecordFor(rewrapped)).toBe(true);
  });

  test.each(["toString", "constructor", "hasOwnProperty", "__proto__"])(
    "a tag naming the inherited member %s observes none",
    async (inherited) => {
      // Every one of these is a member of the condition table's PROTOTYPE, so a
      // membership test that walked the chain would take the tag for a
      // condition and answer with that member rather than a boolean -- which
      // the record schema refuses, losing a record the run owes.
      const refusal = withPartnerCertificateCondition(
        new Error("the swap refused"),
        inherited as PartnerCertificateCondition,
      );

      expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
      expect(await terminatedRecordFor(refusal)).toBe(false);
    },
  );

  test("a tag that is not a string observes none", async () => {
    const refusal = withPartnerCertificateCondition(
      new Error("the swap refused"),
      7 as unknown as PartnerCertificateCondition,
    );

    expect(observedPartnerCertificateMismatch(refusal)).toBe(false);
    expect(await terminatedRecordFor(refusal)).toBe(false);
  });
});
