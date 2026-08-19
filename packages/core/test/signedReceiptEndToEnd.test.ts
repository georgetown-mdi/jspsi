import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  ReceiptVerificationError,
  SIGNED_RECEIPT_VERSION,
  verifyReceiptSignature,
} from "../src/signedReceipt";
import { verifyDualSignedRecord } from "../src/signedReceiptVerification";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/signingIdentity";

import type { Output } from "../src/config/linkageTerms";
import type { ExchangeRecord } from "../src/exchangeRecord";
import type { ExchangeResult } from "../src/exchange";
import type { RunExchangeOptions } from "../src/exchange";
import type { DualSignedRecordVerificationInputs } from "../src/signedReceiptVerification";

// End-to-end coverage of the signed-receipt seam in runExchange: two parties run a
// full exchange over an in-memory pipe (real PSI) with signing identities and a
// session key, and we assert the dual-signed record each side produces. This
// complements the isolated wire/sign/verify unit tests in signedReceipt.test.ts by
// exercising the gate and the content-from-record wiring in runExchange itself.

const psiLibrary = await PSI();

const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const serverRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];
const clientRows = [{ first_name: "Carol" }, { first_name: "Elizabeth" }];

function prepared(identity: string, output: Output, rows: typeof serverRows) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output } },
    identity,
    rows,
    ["first_name"],
  );
}

const both: Output = { expectsOutput: true, shareWithPartner: true };

// Fixed keys and a fixed session key so both parties derive the same binder.
const identityA = await generateSigningIdentity("Initiator Co", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "GVQtflhIdfyWtA4RGHj1T0I9SSp06yAE1StWzYqyOgc",
    y: "9aIOTbxzjvOD_-qU-bR7fvyonZyFmNRUYARsDEronE4",
    d: "Cw4RFBcaHSAjJiksLzI1ODs-QURHSk1QU1ZZXF9iZWg",
  },
});
const identityB = await generateSigningIdentity("Responder Co", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "BTjKXg73U-P7scjs7x2b4PTBObeQCmUWxRZUphXgOco",
    y: "vrypj5auTCXlpWtQ7dzQVRiLOO5FYAFEK2N6hkO_fnQ",
    d: "yM3S19zh5uvw9fr_BAkOExgdIicsMTY7QEVKT1RZXmM",
  },
});
const fingerprintA = await computeCertificateFingerprint(identityA.certificate);
const fingerprintB = await computeCertificateFingerprint(identityB.certificate);
const sessionKey = new Uint8Array(32).fill(11) as Uint8Array<ArrayBuffer>;

/** Run a full exchange, threading each party's signing options. */
async function runBoth(
  initiatorSigning: Partial<RunExchangeOptions>,
  responderSigning: Partial<RunExchangeOptions>,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        ...initiatorSigning,
      },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", both, serverRows),
      {
        psiLibrary,
        ...responderSigning,
      },
    ),
  ]);
}

test("both parties produce one dual-signed record with mutual verification", async () => {
  const [resInit, resResp] = await runBoth(
    {
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
    {
      signingIdentity: identityB,
      partnerFingerprint: fingerprintA,
      sessionKey,
    },
  );

  // Both sides return the same dual-signed record (roles fixed by the handshake).
  expect(resInit.signedReceipt).toBeDefined();
  expect(resResp.signedReceipt).toBeDefined();
  expect(resInit.signedReceipt).toEqual(resResp.signedReceipt);

  const receipt = resInit.signedReceipt!;
  expect(receipt.version).toBe(SIGNED_RECEIPT_VERSION);
  // The receipt content commits to the SAME agreed-terms hash the self-attested
  // record carries.
  expect(receipt.content.termsHash).toBe(resInit.audit!.record.termsHash);
  // It carries the two directional payload MACs (session-keyed), not the salted
  // record commitments.
  expect(receipt.content.initiatorToResponderPayload).toEqual(
    expect.any(String),
  );
  expect(receipt.content.responderToInitiatorPayload).toEqual(
    expect.any(String),
  );
  // Both signatures verify against the shared content bound to their roles.
  expect(
    await verifyReceiptSignature(
      receipt.initiator.certificate,
      receipt.content,
      receipt.initiator.signature,
      "initiator",
    ),
  ).toBe(true);
  expect(
    await verifyReceiptSignature(
      receipt.responder.certificate,
      receipt.content,
      receipt.responder.signature,
      "responder",
    ),
  ).toBe(true);
  expect(receipt.initiator.certificate).toEqual(identityA.certificate);
  expect(receipt.responder.certificate).toEqual(identityB.certificate);
});

test("the negative path: no signing config leaves the record path unchanged", async () => {
  // Neither party supplies a signing identity, so the signing step is skipped
  // entirely and the self-attested record path runs unchanged.
  const [resInit, resResp] = await runBoth({}, {});
  expect(resInit.signedReceipt).toBeUndefined();
  expect(resResp.signedReceipt).toBeUndefined();
  // The unsigned record is still produced.
  expect(resInit.audit).toBeDefined();
  expect(resResp.audit).toBeDefined();
});

test("one party without signing config skips the step (no half-signed exchange)", async () => {
  // The responder has no signing identity, so IT skips the step. The initiator has
  // one but its partner never sends a receipt frame; a real transport surfaces this
  // as a peer-silence timeout. Here we assert the responder simply returns no
  // signed receipt while the initiator parks -- close to release it, modeling the
  // caller tearing down the terminated exchange.
  const [connInitiator, connResponder] = createMessagePipe();
  const initiator = runExchange(
    connInitiator,
    "initiator",
    prepared("Initiator Co", both, clientRows),
    {
      psiLibrary,
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
  ).catch(() => undefined);
  const responder = await runExchange(
    connResponder,
    "responder",
    prepared("Responder Co", both, serverRows),
    { psiLibrary },
  );
  expect(responder.signedReceipt).toBeUndefined();
  await connInitiator.close();
  await connResponder.close();
  await initiator;
});

test("a fingerprint-pin mismatch terminates the exchange fail-closed", async () => {
  // The responder pins the WRONG fingerprint for the initiator, so the initiator's
  // presented certificate fails the pin BEFORE its signature is checked. The
  // responder rejects with a ReceiptVerificationError; the initiator is released by
  // a close (it parks on the responder's terminal frame that never comes).
  const [connInitiator, connResponder] = createMessagePipe();
  const initiator = runExchange(
    connInitiator,
    "initiator",
    prepared("Initiator Co", both, clientRows),
    {
      psiLibrary,
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
  ).catch(() => undefined);
  const responderResult = await runExchange(
    connResponder,
    "responder",
    prepared("Responder Co", both, serverRows),
    {
      psiLibrary,
      signingIdentity: identityB,
      // WRONG pin: fingerprintB instead of fingerprintA.
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
  ).then(
    () => {
      throw new Error("expected the responder to reject on the pin mismatch");
    },
    (reason: unknown) => reason,
  );
  expect(responderResult).toBeInstanceOf(ReceiptVerificationError);
  expect((responderResult as Error).message).toMatch(/not trusted/);
  await connInitiator.close();
  await connResponder.close();
  await initiator;
});

// --- Pairing a receipt to one run --------------------------------------------

/** A signed run of the one partnership, under the session key `key`. */
function runSigned(
  key: Uint8Array<ArrayBuffer>,
): Promise<[ExchangeResult, ExchangeResult]> {
  return runBoth(
    {
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey: key,
    },
    {
      signingIdentity: identityB,
      partnerFingerprint: fingerprintA,
      sessionKey: key,
    },
  );
}

// Two runs of ONE partnership over identical terms, identities, and data, differing
// only in the session key their key exchanges produced -- the recurring-exchange
// shape a receipt's signed content cannot tell apart on its own: the terms hash and
// both certificates repeat byte for byte, and the payload MACs that do differ are
// not recomputable by any verifier.
const firstRun = await runSigned(sessionKey);
const secondRun = await runSigned(
  new Uint8Array(32).fill(22) as Uint8Array<ArrayBuffer>,
);
const firstRecord = firstRun[0].audit!.record;
const secondRecord = secondRun[0].audit!.record;
const firstReceipt = firstRun[0].signedReceipt!;

/**
 * What the initiator holds when it re-verifies its own receipt offline: the partner
 * pinned out-of-band, its own certificate as the other anchor, and the identities,
 * terms hash, and run binder its exchange record carries. Everything but the
 * pairing is identical for either run's record, which is the point -- the pairing is
 * the only check that can separate them.
 */
function heldByInitiator(
  record: ExchangeRecord,
): DualSignedRecordVerificationInputs {
  return {
    pinnedFingerprints: [fingerprintB],
    localIdentity: { fingerprint: fingerprintA, source: "named" },
    expectedIdentities: [record.localIdentity, record.partnerIdentity],
    expectedTermsHash: record.termsHash,
    recordReceiptBinder: record.receiptBinder ?? null,
  };
}

describe("the run binder pairs a receipt to one exchange run", () => {
  test("both parties' records carry the run's receipt binder", async () => {
    expect(firstRecord.receiptBinder).toBe(firstReceipt.content.binder);
    expect(firstRun[1].audit!.record.receiptBinder).toBe(
      firstRecord.receiptBinder,
    );
  });

  test("two runs of one partnership under identical terms carry distinct binders", async () => {
    // Every signed value an offline verifier can CHECK is equal across the two
    // runs: the terms hash (recomputable from both parties' terms) and the two
    // certificates. The directional payload MACs do vary with the session key, but
    // a verifier cannot recompute them either, so they separate nothing. The binder
    // is the one per-run value the record also carries.
    expect(secondRecord.termsHash).toBe(firstRecord.termsHash);
    expect(secondRun[0].signedReceipt!.content.termsHash).toBe(
      firstReceipt.content.termsHash,
    );
    expect(secondRun[0].signedReceipt!.initiator.certificate).toEqual(
      firstReceipt.initiator.certificate,
    );
    expect(secondRecord.receiptBinder).not.toBe(firstRecord.receiptBinder);
  });

  test("a matched receipt/record pair verifies", async () => {
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(firstRecord),
    );
    expect(report.runBinding).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("one run's receipt beside another run's record is a mismatch", async () => {
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(secondRecord),
    );
    expect(report.runBinding).toBe("mismatch");
    expect(report.outcome).toBe("failed");
    // Every other check still passes: the two runs share the partnership and the
    // terms, so the pairing is the only thing that separates them.
    expect(report.termsHash).toBe("verified");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("local-identity");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
  });

  test("a record of a run that produced no receipt reports the receipt as unpaired", async () => {
    const [unsigned] = await runBoth({}, {});
    const unsignedRecord = unsigned.audit!.record;
    expect(unsignedRecord.receiptBinder).toBeUndefined();
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(unsignedRecord),
    );
    expect(report.runBinding).toBe("unpaired");
    expect(report.outcome).toBe("failed");
    expect(report.termsHash).toBe("verified");
  });

  test("a receipt held without any record leaves the pairing unchecked, short of verified", async () => {
    // The holder of one artifact is not accused of anything: with no record beside
    // it there is nothing to pair, and the verdict says so rather than failing.
    const report = await verifyDualSignedRecord(firstReceipt, {
      ...heldByInitiator(firstRecord),
      recordReceiptBinder: undefined,
    });
    expect(report.runBinding).toBe("not-checked");
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.signature).toBe("verified");
  });
});
