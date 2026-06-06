import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { verifyRecordCommitments } from "../src/exchangeRecord";
import { createMessagePipe } from "../src/connection/messageConnection";

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

test("both-output: both records agree on terms and carry the result size", async () => {
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const [initiator, responder] = await runBoth(both, both);

  // Carol and Elizabeth overlap -> two matches.
  expect(initiator.record.resultSize).toBe(2);
  expect(responder.record.resultSize).toBe(2);

  // Both parties hash the same agreed terms to the same value.
  expect(initiator.record.termsHash).toBe(responder.record.termsHash);

  // Identities are recorded from each side's point of view.
  expect(initiator.record.localIdentity).toBe("Initiator Co");
  expect(initiator.record.partnerIdentity).toBe("Responder Co");
  expect(responder.record.localIdentity).toBe("Responder Co");
  expect(responder.record.partnerIdentity).toBe("Initiator Co");

  // Both hold the association table, so both commit to it.
  expect(initiator.record.commitments.associationTable).toBeDefined();
  expect(responder.record.commitments.associationTable).toBeDefined();

  // Each record's commitments verify against its own opening data.
  expect(
    (await verifyRecordCommitments(initiator.record, initiator.recordOpening))
      .allValid,
  ).toBe(true);
  expect(
    (await verifyRecordCommitments(responder.record, responder.recordOpening))
      .allValid,
  ).toBe(true);
});

test("single-output: result size omitted; only the receiver commits the table", async () => {
  // Initiator receives output; responder only sends. resolveRole makes the
  // initiator the receiver (it expects output and the partner does not).
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(receiverOut, senderOut);

  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");

  // Neither party records the result size: the sender never learns it, so it is
  // not "learned by both".
  expect("resultSize" in initiator.record).toBe(false);
  expect("resultSize" in responder.record).toBe(false);

  // Only the receiver holds a meaningful association table, so only it commits.
  expect(initiator.record.commitments.associationTable).toBeDefined();
  expect(responder.record.commitments.associationTable).toBeUndefined();

  // Terms hash still matches across parties.
  expect(initiator.record.termsHash).toBe(responder.record.termsHash);

  expect(
    (await verifyRecordCommitments(initiator.record, initiator.recordOpening))
      .allValid,
  ).toBe(true);
  expect(
    (await verifyRecordCommitments(responder.record, responder.recordOpening))
      .allValid,
  ).toBe(true);
});
