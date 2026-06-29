import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { verifyRecordCommitments } from "../src/exchangeRecord";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";

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
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
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

function prepared(
  identity: string,
  output: Output,
  rows: typeof serverRows,
  linkageStrategy: "cascade" | "single-pass" = "cascade",
) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output, linkageStrategy } },
    identity,
    rows,
    ["first_name", "note"],
  );
}

/** Run a full exchange between an initiator and a responder over a pipe. */
async function runBoth(
  outInitiator: Output,
  outResponder: Output,
  linkageStrategy: "cascade" | "single-pass" = "cascade",
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", outInitiator, clientRows, linkageStrategy),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", outResponder, serverRows, linkageStrategy),
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

  // Both are entitled to output, so the exchange returns the result table to each
  // -- the returned-result gate is the same entitlement predicate as the record
  // gate above.
  expect(initiator.associationTable).toBeDefined();
  expect(responder.associationTable).toBeDefined();

  // Governance metadata is derived from the agreed terms on both sides and agrees
  // on the cross-party-consistent fields. firstNameTerms configure no payload data
  // dictionary and no legal agreement, but inferred metadata makes the non-linkage
  // 'note' column a disclosed payload column, so it flows for the two matched rows
  // and is committed. The payload categories read from the committed disclosure, so
  // both directions report 'note' -- with a bare name, since no dictionary supplies
  // a description -- rather than under-reporting it as empty.
  expect(init.record.governance.algorithm).toBe("psi");
  expect(resp.record.governance.algorithm).toBe("psi");
  expect(init.record.governance.matchingBasis).toEqual([
    { name: "firstName", type: "first_name" },
  ]);
  expect(resp.record.governance.matchingBasis).toEqual([
    { name: "firstName", type: "first_name" },
  ]);
  expect("legalAgreement" in init.record.governance).toBe(false);
  expect(init.record.governance.payloadSent).toEqual([{ name: "note" }]);
  expect(init.record.governance.payloadReceived).toEqual([{ name: "note" }]);
  // The payload categories are each party's own-direction view (send/receive),
  // not a cross-party-validated field, so assert the responder's independently
  // rather than inferring it from the initiator's.
  expect("legalAgreement" in resp.record.governance).toBe(false);
  expect(resp.record.governance.payloadSent).toEqual([{ name: "note" }]);
  expect(resp.record.governance.payloadReceived).toEqual([{ name: "note" }]);

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

  // The privacy gate this work adds: the exchange RETURNS the result table only to
  // the entitled party. The receiver (initiator) gets it; the sender/helper
  // (responder) gets undefined -- withheld at the return on the same entitlement
  // predicate as the record's committed table, so neither front end can write a
  // result the helper is not entitled to.
  expect(initiator.associationTable).toBeDefined();
  expect(responder.associationTable).toBeUndefined();

  // Terms hash still matches across parties.
  expect(init.record.termsHash).toBe(resp.record.termsHash);

  expect(
    (await verifyRecordCommitments(init.record, init.opening)).allValid,
  ).toBe(true);
  expect(
    (await verifyRecordCommitments(resp.record, resp.opening)).allValid,
  ).toBe(true);
});

test("single-output (responder receives): the gate withholds from the initiator", async () => {
  // The mirror of the test above, exercising the OTHER one-sided direction live:
  // the responder is the sole receiver and the initiator is the sender/helper. This
  // covers the partner-only direction at the gate, which the test above (initiator
  // receives) does not -- so the withholding is asserted for both directions, not
  // just by predicate argument.
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(senderOut, receiverOut);

  expect(initiator.resolvedRole).toBe("sender");
  expect(responder.resolvedRole).toBe("receiver");

  // The entitled party (responder) gets the table; the helper (initiator) gets
  // undefined -- withheld at the return.
  expect(responder.associationTable).toBeDefined();
  expect(initiator.associationTable).toBeUndefined();

  // And the record gate matches: only the entitled responder commits the table.
  expect(built(responder).record.commitments.associationTable).toBeDefined();
  expect(built(initiator).record.commitments.associationTable).toBeUndefined();
});

test("single-output: the no-output helper is sent no payload (one-sided disclosure closed)", async () => {
  // Both parties' metadata discloses `note`. The receiver (initiator) gets the
  // helper's disclosed payload, as it should. But the no-output helper (responder)
  // is sent NONE of the receiver's disclosed payload, even though the receiver's
  // own metadata discloses `note`: the send-gate transmits payload only to a
  // partner entitled to the result, closing the one-sided disclosure (203012150 /
  // docs/notes/one-sided-disclosure.md). The committed records reflect it.
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(receiverOut, senderOut);

  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");

  // The receiver receives the helper's payload; the helper receives nothing.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(responder.partnerPayload.columns).toEqual([]);

  // Both records still commit a partnerPayloadReceived (the helper's is a
  // commitment to the empty payload it correctly received).
  expect(
    built(initiator).record.commitments.partnerPayloadReceived,
  ).toBeDefined();
  expect(
    built(responder).record.commitments.partnerPayloadReceived,
  ).toBeDefined();
});

// --- Acceptor payload lock-in (live) -----------------------------------------

// The responder's inferred metadata discloses `note` (role: other -> payload),
// so for the matched rows it transmits exactly ["note"]. These two tests pin the
// runtime lock-in end to end: when the initiator has locked in an expected
// received-column set (a fresh acceptor's carried disclosedPayloadColumns, or a
// recurring party's payload.receive, both threaded as prepared.expectedPayload-
// Columns), runExchange enforces it after the payload exchange.

const bothOut: Output = { expectsOutput: true, shareWithPartner: true };

test("lock-in: a received payload diverging from the consented set aborts the exchange", async () => {
  const initiatorPrepared = prepared("Initiator Co", bothOut, clientRows);
  // The initiator consented to receive a column the responder will never send.
  initiatorPrepared.expectedPayloadColumns = ["a_column_not_sent"];
  const [connInitiator, connResponder] = createMessagePipe();
  const [initResult, respResult] = await Promise.allSettled([
    runExchange(connInitiator, "initiator", initiatorPrepared, { psiLibrary }),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", bothOut, serverRows),
      { psiLibrary },
    ),
  ]);
  // The locked-in party aborts as a protocol error; the lazy responder, which
  // locked in nothing, completes its own half (the abort is local to the receiver
  // and fires after the payload exchange itself finished).
  expect(initResult.status).toBe("rejected");
  const reason = (initResult as PromiseRejectedResult).reason;
  expect(reason).toBeInstanceOf(ConnectionError);
  expect((reason as ConnectionError).kind).toBe("protocol");
  expect(respResult.status).toBe("fulfilled");
});

test("lock-in: a received payload matching the consented set completes", async () => {
  const initiatorPrepared = prepared("Initiator Co", bothOut, clientRows);
  // Exactly what the responder's metadata discloses for the matched rows.
  initiatorPrepared.expectedPayloadColumns = ["note"];
  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator] = await Promise.all([
    runExchange(connInitiator, "initiator", initiatorPrepared, { psiLibrary }),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", bothOut, serverRows),
      { psiLibrary },
    ),
  ]);
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
});

// --- Universal count exchange: deadlock-free ordering ------------------------

test("the unconditional count exchange composes into a deadlock-free full exchange for every (handshake-role x strategy) combination", async () => {
  // The record-count exchange now runs on every exchange, immediately before
  // linkage. Verify it composes into a complete, lockstep full exchange for both
  // linkage strategies and in every output orientation: both-output, and each
  // one-sided direction (which handshake role is the sole output party). Each
  // await resolving is the no-deadlock check; the role assertions pin the outcome.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const receiver: Output = { expectsOutput: true, shareWithPartner: false };
  const sender: Output = { expectsOutput: false, shareWithPartner: true };

  for (const strategy of ["cascade", "single-pass"] as const) {
    // Both-output: the smaller-row party is the receiver. The initiator holds
    // clientRows (3), the responder serverRows (4), so the initiator receives.
    const [bothInit, bothResp] = await runBoth(both, both, strategy);
    expect(bothInit.resolvedRole).toBe("receiver");
    expect(bothResp.resolvedRole).toBe("sender");

    // One-sided, initiator the sole output party -> initiator is the receiver
    // regardless of the (smaller) row counts.
    const [initRecvInit, initRecvResp] = await runBoth(
      receiver,
      sender,
      strategy,
    );
    expect(initRecvInit.resolvedRole).toBe("receiver");
    expect(initRecvResp.resolvedRole).toBe("sender");

    // One-sided, responder the sole output party -> responder is the receiver.
    const [respRecvInit, respRecvResp] = await runBoth(
      sender,
      receiver,
      strategy,
    );
    expect(respRecvInit.resolvedRole).toBe("sender");
    expect(respRecvResp.resolvedRole).toBe("receiver");
  }
});
