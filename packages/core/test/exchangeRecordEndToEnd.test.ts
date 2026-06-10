import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { verifyRecordCommitments } from "../src/exchangeRecord";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { BuiltExchangeRecord } from "../src/exchangeRecord";
import type { Output } from "../src/config/linkageTerms";
import type { ExchangeResult } from "../src/exchange";

// End-to-end coverage of the record seam in runExchange: two parties run a full
// exchange over an in-memory pipe (real PSI), and we assert the record each side
// produces. This is where the result-size and association-table gating is
// exercised against the live both-output / single-output cases, complementing
// the isolated record-build unit tests in exchangeRecord.test.ts.

const psiLibrary = await PSI();

// firstName-only terms: the default linkage-key templates all need SSN/DOB, so
// none survive filtering for a firstName-only dataset; an explicit key gives
// both parties valid, matching terms. (Same approach as the web browser suite.)
const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "firstName" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const serverRows = [
  { first_name: "Alice", note: "s-a" },
  { first_name: "Bob", note: "s-b" },
  { first_name: "Carol", note: "s-c" },
  { first_name: "Elizabeth", note: "s-e" },
];
const clientRows = [
  { first_name: "Carol", note: "c-c" },
  { first_name: "Elizabeth", note: "c-e" },
  { first_name: "Henry", note: "c-h" },
];

function prepared(identity: string, output: Output, rows: typeof serverRows) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output } },
    identity,
    rows,
    ["first_name", "note"],
  );
}

/** Run a full exchange between an initiator and a responder over a pipe. */
async function runBoth(
  outInitiator: Output,
  outResponder: Output,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", outInitiator, clientRows),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", outResponder, serverRows),
      { psiLibrary },
    ),
  ]);
}

/** A successful exchange always builds the record; narrow the now-optional
 * audit pair (or fail loudly) so the assertions below read cleanly. */
function built(result: ExchangeResult): BuiltExchangeRecord {
  expect(result.audit).toBeDefined();
  return result.audit!;
}

test("both-output: both records agree on terms and carry the result size", async () => {
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const [initiator, responder] = await runBoth(both, both);
  const init = built(initiator);
  const resp = built(responder);

  // Carol and Elizabeth overlap -> two matches.
  expect(init.record.resultSize).toBe(2);
  expect(resp.record.resultSize).toBe(2);

  // Each party records its own input row count -- the size of its own input,
  // independent of the partner and of the result.
  expect(init.record.recordsExposed).toBe(clientRows.length);
  expect(resp.record.recordsExposed).toBe(serverRows.length);

  // Both parties hash the same agreed terms to the same value.
  expect(init.record.termsHash).toBe(resp.record.termsHash);

  // Identities are recorded from each side's point of view.
  expect(init.record.localIdentity).toBe("Initiator Co");
  expect(init.record.partnerIdentity).toBe("Responder Co");
  expect(resp.record.localIdentity).toBe("Responder Co");
  expect(resp.record.partnerIdentity).toBe("Initiator Co");

  // Both hold the association table, so both commit to it.
  expect(init.record.commitments.associationTable).toBeDefined();
  expect(resp.record.commitments.associationTable).toBeDefined();

  // Governance metadata is derived from the agreed terms on both sides and agrees
  // on the cross-party-consistent fields. firstNameTerms configure no payload and
  // no legal agreement, so the payload categories are explicitly empty.
  expect(init.record.governance.algorithm).toBe("psi");
  expect(resp.record.governance.algorithm).toBe("psi");
  expect(init.record.governance.matchingBasis).toEqual([
    { name: "firstName", type: "firstName" },
  ]);
  expect(resp.record.governance.matchingBasis).toEqual([
    { name: "firstName", type: "firstName" },
  ]);
  expect("legalAgreement" in init.record.governance).toBe(false);
  expect(init.record.governance.payloadSent).toEqual([]);
  expect(init.record.governance.payloadReceived).toEqual([]);
  // The payload categories are each party's own-direction view (send/receive),
  // not a cross-party-validated field, so assert the responder's independently
  // rather than inferring it from the initiator's.
  expect("legalAgreement" in resp.record.governance).toBe(false);
  expect(resp.record.governance.payloadSent).toEqual([]);
  expect(resp.record.governance.payloadReceived).toEqual([]);

  // Each record's commitments verify against its own opening data.
  expect(
    (await verifyRecordCommitments(init.record, init.opening)).allValid,
  ).toBe(true);
  expect(
    (await verifyRecordCommitments(resp.record, resp.opening)).allValid,
  ).toBe(true);
});

test("both-output: a legal-agreement purpose flows end-to-end into both records", async () => {
  // The isolated unit tests cover governanceFromTerms and the purpose-mismatch
  // check separately; this exercises the integrated live path -- prepareForExchange
  // -> runExchange (validateCompatibility passes on matching purposes, then
  // buildExchangeRecord) -- so the mandatory purpose reaches both audit records.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const legalAgreement = {
    reference: "DUA-2026-0007",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-06-30",
  };
  const withAgreement = (identity: string, rows: typeof serverRows) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...firstNameTerms,
          identity,
          output: both,
          legalAgreement,
        },
      },
      identity,
      rows,
      ["first_name", "note"],
    );
  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator, responder] = await Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      withAgreement("Initiator Co", clientRows),
      {
        psiLibrary,
      },
    ),
    runExchange(
      connResponder,
      "responder",
      withAgreement("Responder Co", serverRows),
      {
        psiLibrary,
      },
    ),
  ]);
  const init = built(initiator);
  const resp = built(responder);

  // Both parties' agreed terms carry the same legal agreement, so both records
  // carry the cross-validated reference, purpose, and expiration verbatim.
  expect(init.record.governance.legalAgreement).toEqual(legalAgreement);
  expect(resp.record.governance.legalAgreement).toEqual(legalAgreement);
  // The agreement is part of the agreed terms, so both parties still hash to one
  // value.
  expect(init.record.termsHash).toBe(resp.record.termsHash);
});

test("retention/disposition pointer is per-party and self-facing end-to-end", async () => {
  // The pointer is sourced from each party's own exchange config (a sibling of
  // linkageTerms, NOT part of the agreed terms). Only the party that configures
  // one carries it; it is never exchanged with the partner and never folded into
  // the agreed-terms hash. Set it on the initiator alone and assert the asymmetry.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const note =
    "Result filed in Initiator Co association DB; retained 6 years per RM-7.";
  const withPointer = (
    identity: string,
    rows: typeof serverRows,
    retentionDisposition?: string,
  ) =>
    prepareForExchange(
      {
        linkageTerms: { ...firstNameTerms, identity, output: both },
        ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
      },
      identity,
      rows,
      ["first_name", "note"],
    );
  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator, responder] = await Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      withPointer("Initiator Co", clientRows, note),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      withPointer("Responder Co", serverRows),
      { psiLibrary },
    ),
  ]);
  const init = built(initiator);
  const resp = built(responder);

  // The configuring party carries its own pointer verbatim...
  expect(init.record.retentionDisposition).toBe(note);
  // ...and the partner, which configured none, omits it entirely -- the pointer is
  // never put on the wire, so it cannot leak into the partner's record.
  expect("retentionDisposition" in resp.record).toBe(false);
  // It is not part of the agreed terms, so both parties still hash to one value
  // despite the asymmetry.
  expect(init.record.termsHash).toBe(resp.record.termsHash);
});

test("single-output: result size omitted, but each party records its own exposure", async () => {
  // Initiator receives output; responder only sends. resolveRole makes the
  // initiator the receiver (it expects output and the partner does not).
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(receiverOut, senderOut);
  const init = built(initiator);
  const resp = built(responder);

  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");

  // Neither party records the result size: it is recorded only when both
  // parties' terms have them both receive output, and here only the receiver
  // does. The gate is the terms agreement (entitlement), not whether a party can
  // observe the size during the protocol -- the single-output sender does observe
  // its match count during the clean cascade, but the record deliberately does not
  // surface it.
  expect("resultSize" in init.record).toBe(false);
  expect("resultSize" in resp.record).toBe(false);

  // Each party still records its own input row count: a per-direction figure
  // known from its own input, independent of entitlement to the result.
  expect(init.record.recordsExposed).toBe(clientRows.length);
  expect(resp.record.recordsExposed).toBe(serverRows.length);

  // Only the party entitled to the result commits the association table. The
  // sender holds a table from the clean cascade too, but -- like the match count --
  // the record does not bind it.
  expect(init.record.commitments.associationTable).toBeDefined();
  expect(resp.record.commitments.associationTable).toBeUndefined();

  // Terms hash still matches across parties.
  expect(init.record.termsHash).toBe(resp.record.termsHash);

  expect(
    (await verifyRecordCommitments(init.record, init.opening)).allValid,
  ).toBe(true);
  expect(
    (await verifyRecordCommitments(resp.record, resp.opening)).allValid,
  ).toBe(true);
});
