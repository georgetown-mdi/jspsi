import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { verifyCommitmentOpening } from "../src/exchangeRecord";
import { toCommittedPayload } from "../src/payloadExchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";
import { LinkageTermsUnsatisfiableError, UsageError } from "../src/errors";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";

import type { Algorithm } from "../src/types";
import type { BuiltExchangeRecord } from "../src/exchangeRecord";
import type { Output } from "../src/config/linkageTerms";
import type { ExchangeResult } from "../src/exchange";

// End-to-end coverage of the record boundary in runExchange: two parties run
// a full exchange over an in-memory pipe (real PSI), and we assert the
// record each side produces. This is where the result-size and
// association-table gating is exercised against the live both-output /
// single-output cases, complementing the isolated record-build unit tests
// in exchangeRecord.test.ts.

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

function built(result: ExchangeResult): BuiltExchangeRecord {
  expect(result.audit).toBeDefined();
  return result.audit!;
}

test("run boundary: an algorithm with no run path is refused before anything goes on the wire", async () => {
  // The run-side half of the record-integrity guarantee: a PreparedExchange
  // holding an algorithm outside the implemented allowlist -- constructed
  // here by overriding the prepared terms, as a caller that skipped
  // prepareForExchange could -- is refused at the run boundary, so no round
  // runs under whichever path the dispatch would otherwise fall through to,
  // and no record attests a disclosure the run did not make.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const unimplementedPrepared = prepared("Initiator Co", both, clientRows);
  unimplementedPrepared.linkageTerms = {
    ...unimplementedPrepared.linkageTerms,
    // The enum admits no such member, so the cast reaches the shape a member
    // later added to AlgorithmSchema takes here before a run path exists for it.
    algorithm: "psi-x" as Algorithm,
  };
  const [conn] = createMessagePipe();
  // Every connection call throws, so a frame the refusal failed to stop shows
  // up as this distinct error rather than parking on a pipe with no partner.
  const unusableConnection = new Proxy(conn, {
    get: () => {
      throw new Error("the connection was used past the algorithm refusal");
    },
  });
  const run = runExchange(
    unusableConnection,
    "initiator",
    unimplementedPrepared,
    {
      psiLibrary,
    },
  );
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(/not yet implemented/);
});

test("run boundary: a psi-c run whose metadata transmits a column is refused before anything goes on the wire", async () => {
  // The fixtures' inferred metadata makes the non-linkage `note` column a
  // disclosed payload column, but a count-only exchange transmits no payload
  // in either direction. Overriding the prepared terms to pair `psi-c` with
  // that metadata is refused by the metadata rule at the run boundary: no
  // linkage runs and no record is produced. The refusal fires before the
  // first await, so runExchange rejects without a partner on the pipe.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const psiCPrepared = prepared("Initiator Co", both, clientRows);
  psiCPrepared.linkageTerms = {
    ...psiCPrepared.linkageTerms,
    algorithm: "psi-c",
  };
  const [conn] = createMessagePipe();
  const run = runExchange(conn, "initiator", psiCPrepared, { psiLibrary });
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(/transmits no data columns/);
});

test("terms exchange: an out-of-shape psi-c document is refused on receipt, rejecting both parties' runs with no linkage and no record", async () => {
  // The same override, minus the metadata rule: rows and columns holding
  // only the linkage column transmit nothing, so the out-of-shape document
  // (two linkage keys) reaches the wire, where the terms exchange parses the
  // PARTNER's terms under the schema's count-only shape rules -- upstream of
  // the agreed-terms boundary that countOnlyRun.test.ts drives directly.
  // Both parties hold the same document, so both sides refuse, unnarrowed.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const linkageOnly = (identity: string, rows: typeof serverRows) => {
    const spec = prepareForExchange(
      { linkageTerms: { ...firstNameTerms, identity, output: both } },
      identity,
      rows.map(({ first_name }) => ({ first_name })),
      ["first_name"],
    );
    spec.linkageTerms = {
      ...spec.linkageTerms,
      algorithm: "psi-c",
      linkageKeys: [
        ...spec.linkageTerms.linkageKeys,
        { name: "firstNameAgain", elements: [{ field: "firstName" }] },
      ],
    };
    return spec;
  };
  // Every PSI call throws, so any linkage the refusal failed to stop shows up
  // as this distinct error rather than the terms refusal asserted below.
  const unusablePsiLibrary = new Proxy(psiLibrary, {
    get: () => {
      throw new Error("the PSI library was used past the terms refusal");
    },
  });
  const [connInitiator, connResponder] = createMessagePipe();
  const outcomes = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      linkageOnly("Initiator Co", clientRows),
      {
        psiLibrary: unusablePsiLibrary,
      },
    ),
    runExchange(
      connResponder,
      "responder",
      linkageOnly("Responder Co", serverRows),
      {
        psiLibrary: unusablePsiLibrary,
      },
    ),
  ]);

  // Both sides reject, so neither returns an ExchangeResult and neither builds the
  // record a completed run holds.
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  for (const outcome of outcomes) {
    const refusal = (outcome as PromiseRejectedResult).reason as Error;
    // Each party's failure is the count-only rule the document breaks -- the
    // one that refuses it, preserved through the abort so both ends name it
    // -- and not the unusable PSI library, so no round ran on either side.
    expect(refusal.message).toMatch(/exactly one linkage key/);
    expect(refusal.message).not.toMatch(/PSI library/);
  }
});

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

  // Governance metadata is derived from the agreed terms on both sides and
  // agrees on the cross-party-consistent fields. firstNameTerms configure no
  // payload dictionary or legal agreement, but inferred metadata makes the
  // non-linkage 'note' column a disclosed payload column that flows for the
  // two matched rows and is committed. The payload categories read from that
  // disclosure, so both sides report a bare 'note' rather than as empty.
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

  // Each party's association-table commitment opens against the live returned
  // table, re-supplied at verify time (the keys hold only salts, never a data
  // snapshot).
  expect(
    await verifyCommitmentOpening(
      "associationTable",
      init.keys.salts.associationTable!,
      initiator.associationTable!,
      init.record.commitments.associationTable!,
    ),
  ).toBe(true);
  expect(
    await verifyCommitmentOpening(
      "associationTable",
      resp.keys.salts.associationTable!,
      responder.associationTable!,
      resp.record.commitments.associationTable!,
    ),
  ).toBe(true);

  // The received-payload commitment also opens against the LIVE payload each
  // party got (re-canonicalized via toCommittedPayload). This is the end-to-end
  // guard: a regression that swapped the sent/received payloads or corrupted the
  // committed rows -- while leaving the column names intact -- would fail here even
  // though the governance-name assertions above would not. localPayloadSent is not
  // exposed on the result, so only the received side is checkable live.
  expect(
    await verifyCommitmentOpening(
      "partnerPayloadReceived",
      init.keys.salts.partnerPayloadReceived,
      toCommittedPayload(initiator.partnerPayload),
      init.record.commitments.partnerPayloadReceived,
    ),
  ).toBe(true);
  expect(
    await verifyCommitmentOpening(
      "partnerPayloadReceived",
      resp.keys.salts.partnerPayloadReceived,
      toCommittedPayload(responder.partnerPayload),
      resp.record.commitments.partnerPayloadReceived,
    ),
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

  // Both parties' agreed terms hold the same legal agreement, so both records
  // hold the cross-validated reference, purpose, and expiration verbatim.
  expect(init.record.governance.legalAgreement).toEqual(legalAgreement);
  expect(resp.record.governance.legalAgreement).toEqual(legalAgreement);
  // The agreement is part of the agreed terms, so both parties still hash to one
  // value.
  expect(init.record.termsHash).toBe(resp.record.termsHash);
});

test("retention/disposition pointer is per-party and self-facing end-to-end", async () => {
  // The pointer is sourced from each party's own exchange config (a sibling of
  // linkageTerms, NOT part of the agreed terms). Only the party that configures
  // one holds it; it is never exchanged with the partner and never folded into
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

  // The configuring party holds its own pointer verbatim...
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
  // its match count during the clean cascade, but by design the record does not
  // expose it.
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

  // Only the entitled party (the initiator) commits the association table; its
  // commitment opens against the live returned table, re-supplied at verify time.
  // The responder is the sender/helper and binds no table (asserted above), so
  // there is nothing to open on that side.
  expect(
    await verifyCommitmentOpening(
      "associationTable",
      init.keys.salts.associationTable!,
      initiator.associationTable!,
      init.record.commitments.associationTable!,
    ),
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
  // partner entitled to the result, closing the one-sided disclosure
  // (docs/notes/one-sided-disclosure.md). The committed records reflect it.
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
// received-column set (a fresh acceptor's disclosedPayloadColumns, or a
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
  // The record-count exchange runs immediately before linkage on every
  // exchange. This verifies it composes into a lockstep full exchange
  // across both strategies and every output orientation: Promise.all
  // resolving proves no deadlock, and the role and intersection assertions
  // pin the outcome. The in-memory pipe has no send gate, so this skips the
  // file-sync backpressure boundary covered in docs/spec/FILE_SYNC.md.
  const both: Output = { expectsOutput: true, shareWithPartner: true };
  const receiver: Output = { expectsOutput: true, shareWithPartner: false };
  const sender: Output = { expectsOutput: false, shareWithPartner: true };
  // Equal-sized inputs for the tie case (clientRows has 3 rows).
  const equalRows = serverRows.slice(0, clientRows.length);

  for (const strategy of ["cascade", "single-pass"] as const) {
    // Both-output: the smaller-row party is the receiver. The initiator holds
    // clientRows (3), the responder serverRows (4), so the initiator receives.
    const [bothInit, bothResp] = await runBoth(both, both, strategy);
    expect(bothInit.resolvedRole).toBe("receiver");
    expect(bothResp.resolvedRole).toBe("sender");
    // Result correctness end to end (both strategies): Carol and Elizabeth
    // overlap, so both parties record an intersection of two.
    expect(built(bothInit).record.resultSize).toBe(2);
    expect(built(bothResp).record.resultSize).toBe(2);

    // Equal counts -> deterministic tie-break: initiator becomes the receiver,
    // responder the sender. Both sides must agree (a both-receiver outcome would
    // deadlock the exchange, not just mislabel it), which only a full exchange
    // exercises.
    const [connTieInit, connTieResp] = createMessagePipe();
    const [tieInit, tieResp] = await Promise.all([
      runExchange(
        connTieInit,
        "initiator",
        prepared("Initiator Co", both, clientRows, strategy),
        { psiLibrary },
      ),
      runExchange(
        connTieResp,
        "responder",
        prepared("Responder Co", both, equalRows, strategy),
        { psiLibrary },
      ),
    ]);
    expect(tieInit.resolvedRole).toBe("receiver");
    expect(tieResp.resolvedRole).toBe("sender");

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

// --- Terms the input cannot fully satisfy ------------------------------------
// governance.matchingBasis is derived from the AGREED terms (pinned above), so
// it names every linkage field those terms declare, regardless of what this
// party's columns actually supplied. A party whose columns cannot produce one
// of the agreed keys must be stopped before the run, or its record would name
// a field it contributed nothing for.

// clientRows hold first_name and note, never a last_name column, so the second
// agreed key here can produce no key string for any of this party's records.
const partlySatisfiedTerms = {
  ...firstNameTerms,
  identity: "Initiator Co",
  output: bothOut,
  linkageFields: [
    { name: "firstName", type: "first_name" as const },
    { name: "lastName", type: "last_name" as const },
  ],
  linkageKeys: [
    { name: "firstName", elements: [{ field: "firstName" }] },
    {
      name: "firstName + lastName",
      elements: [{ field: "firstName" }, { field: "lastName" }],
    },
  ],
};

const preparePartlySatisfied = () =>
  prepareForExchange(
    { linkageTerms: partlySatisfiedTerms },
    "Initiator Co",
    clientRows,
    ["first_name", "note"],
  );

test("terms the input only partly satisfies stop the run before any record is built", async () => {
  const records: Array<BuiltExchangeRecord> = [];
  const [conn] = createMessagePipe();
  const run = (async () => {
    records.push(
      built(
        await runExchange(conn, "initiator", preparePartlySatisfied(), {
          psiLibrary,
        }),
      ),
    );
  })();

  await expect(run).rejects.toBeInstanceOf(LinkageTermsUnsatisfiableError);
  expect(records).toEqual([]);
});

test("the refusal names the shortfall and the out-of-band remedy", () => {
  let raised: unknown;
  try {
    preparePartlySatisfied();
  } catch (err) {
    raised = err;
  }
  expect(raised).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
  expect(raised).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(raised);
  expect(rendered).toContain("1 of the 2 agreed linkage keys");
  expect(rendered).toContain("out of band");
  // The names ride cause links of their own, so both the unsatisfied field and
  // the key it collapses are reachable in the rendered chain.
  expect(rendered).toContain("lastName (last_name)");
  expect(rendered).toContain("firstName + lastName");
});
