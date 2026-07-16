import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  ReceiptVerificationError,
  SIGNED_RECEIPT_VERSION,
  verifyReceiptSignature,
} from "../src/signedReceipt";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/signingIdentity";

import type { Output } from "../src/config/linkageTerms";
import type { ExchangeResult } from "../src/exchange";
import type { RunExchangeOptions } from "../src/exchange";

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

// Deterministic identities and a fixed session key so both parties derive the
// same binder.
const identityA = generateSigningIdentity("Initiator Co", {
  seed: new Uint8Array(32).map((_, i) => i),
});
const identityB = generateSigningIdentity("Responder Co", {
  seed: new Uint8Array(32).map((_, i) => (i + 50) & 0xff),
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
  // It carries the two directional payload digests (salt-free), not the salted
  // record commitments.
  expect(receipt.content.initiatorToResponderPayload).toEqual(
    expect.any(String),
  );
  expect(receipt.content.responderToInitiatorPayload).toEqual(
    expect.any(String),
  );
  // Both signatures verify against the shared content under their certificates.
  expect(
    verifyReceiptSignature(
      receipt.initiator.certificate,
      receipt.content,
      receipt.initiator.signature,
    ),
  ).toBe(true);
  expect(
    verifyReceiptSignature(
      receipt.responder.certificate,
      receipt.content,
      receipt.responder.signature,
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
