import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";

import type { BuiltExchangeRecord } from "../src/exchangeRecord";
import type { LinkageStrategy, Output } from "../src/config/linkageTerms";
import type { ExchangeResult } from "../src/exchange";

// Integration coverage of the linkageStrategy dispatch in runExchange: a
// single-pass exchange must flow through the full path -- role resolution, the
// payload exchange, the one-sided-output gate, and the audit record -- to the same
// result the cascade produces. linkViaSinglePassPSI's byte-identical parity with the
// cascade is pinned at the unit level (psiLink.test.ts); these tests pin that the
// exchange.ts dispatch and every downstream consumer treat a single-pass result
// identically, which the unit path never exercises.

const psiLibrary = await PSI();

// firstName-only terms: the default key templates need SSN/DOB, so an explicit key
// gives both parties valid matching terms for a firstName-only dataset (same shape
// as exchangeRecordEndToEnd.test.ts), parameterized by strategy.
const baseTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
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
  strategy: LinkageStrategy,
  identity: string,
  output: Output,
  rows: typeof serverRows,
) {
  return prepareForExchange(
    {
      linkageTerms: {
        ...baseTerms,
        linkageStrategy: strategy,
        identity,
        output,
      },
    },
    identity,
    rows,
    ["first_name", "note"],
  );
}

async function runBoth(
  strategy: LinkageStrategy,
  outInitiator: Output,
  outResponder: Output,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared(strategy, "Initiator Co", outInitiator, clientRows),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared(strategy, "Responder Co", outResponder, serverRows),
      { psiLibrary },
    ),
  ]);
}

function built(result: ExchangeResult): BuiltExchangeRecord {
  expect(result.audit).toBeDefined();
  return result.audit!;
}

const sortByIndex = (p: ExchangeResult["partnerPayload"]) =>
  p.rowIndices
    .map((idx, i) => ({ idx, row: p.rows[i] }))
    .sort((a, b) => a.idx - b.idx);

const both: Output = { expectsOutput: true, shareWithPartner: true };

test("single-pass dispatch: a full runExchange yields the correct matched table", async () => {
  const [initiator, responder] = await runBoth("single-pass", both, both);

  // Carol and Elizabeth overlap. The dispatch must route single-pass and surface
  // the same table cascade would, from each party's local perspective: client rows
  // 0,1 <-> server rows 2,3.
  expect(initiator.associationTable).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(responder.associationTable).toEqual([
    [2, 3],
    [0, 1],
  ]);
  expect(built(initiator).record.resultSize).toBe(2);
  expect(built(responder).record.resultSize).toBe(2);
});

test("single-pass delivers the partner payload for the matched rows", async () => {
  const [initiator, responder] = await runBoth("single-pass", both, both);

  // `note` is an inferred payload column; under single-pass it must flow for exactly
  // the matched rows, keyed by the partner's row indices. This drives preparePayload
  // over a single-pass association table -- the path the unit tests never reach.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(sortByIndex(initiator.partnerPayload)).toEqual([
    { idx: 2, row: ["s-c"] }, // server Carol
    { idx: 3, row: ["s-e"] }, // server Elizabeth
  ]);

  expect(responder.partnerPayload.columns).toEqual(["note"]);
  expect(sortByIndex(responder.partnerPayload)).toEqual([
    { idx: 0, row: ["c-c"] }, // client Carol
    { idx: 1, row: ["c-e"] }, // client Elizabeth
  ]);
});

test("single-pass carries a larger dataset to completion under the derived cap", async () => {
  // A dataset far above the toy examples above, well within the single-pass
  // ceiling, must flow through the full runExchange path to completion without the
  // derived frame cap rejecting it -- the regression the row-count-derived cap is
  // meant to AVOID (single-pass now carries datasets larger than the old fixed
  // ceiling). 600 rows per side over one key is 600 (key, record) cells per
  // party, orders of magnitude below MAX_SINGLE_PASS_CELLS, yet large enough
  // that the derived byte cap is far tighter than the static frame cap.
  const n = 600;
  const overlap = 200;
  const bigServer = Array.from({ length: n }, (_, i) => ({
    first_name: `srv-${i}`,
    note: `s-${i}`,
  }));
  // The first `overlap` client rows share a value with the server; the rest are
  // disjoint, so the intersection size is exactly `overlap`.
  const bigClient = Array.from({ length: n }, (_, i) => ({
    first_name: i < overlap ? `srv-${i}` : `cli-${i}`,
    note: `c-${i}`,
  }));

  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator, responder] = await Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared("single-pass", "Initiator Co", both, bigClient),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("single-pass", "Responder Co", both, bigServer),
      { psiLibrary },
    ),
  ]);

  expect(initiator.associationTable?.[0]).toHaveLength(overlap);
  expect(responder.associationTable?.[0]).toHaveLength(overlap);
  expect(built(initiator).record.resultSize).toBe(overlap);
  expect(built(responder).record.resultSize).toBe(overlap);
});

test("single-pass one-sided output: only the receiver gets the table and payload", async () => {
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(
    "single-pass",
    receiverOut,
    senderOut,
  );

  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");

  // The receiver gets the table and binds it; the no-output helper gets neither --
  // the same gate cascade uses, holding for a single-pass result too.
  expect(initiator.associationTable).toBeDefined();
  expect(responder.associationTable).toBeUndefined();
  expect(built(initiator).record.commitments.associationTable).toBeDefined();
  expect(built(responder).record.commitments.associationTable).toBeUndefined();

  // Send-gate: the receiver gets the helper's payload; the helper gets none. That
  // the helper's `note` payload arrives ALSO proves the payload-disclosing helper
  // still received its association-table half (preparePayload reads it to build the
  // enrichment) -- the table is withheld only from a helper disclosing no payload,
  // exercised by the blind-helper test below.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(responder.partnerPayload.columns).toEqual([]);
});

// Run a one-sided single-pass exchange (receiver expects output, helper does not)
// end to end, capturing every frame the HELPER's process receives so a test can
// assert -- at the wire -- whether the association-table frame (the only
// Array-shaped frame) reaches it. `helperDiscloses` gives the helper a payload
// column (so it is NOT blinded); `helperIsInitiator` swaps the handshake-role
// assignment so BOTH payload-exchange orderings are exercised (resolveRole makes
// the output party the PSI receiver regardless, so this only reorders the payload
// phase, which is where an untested permutation could hide a frame-desync hang).
async function runOneSidedSinglePass(opts: {
  helperDiscloses: boolean;
  helperIsInitiator: boolean;
}): Promise<{
  receiver: ExchangeResult;
  helper: ExchangeResult;
  helperInbound: Array<unknown>;
}> {
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const helperOut: Output = { expectsOutput: false, shareWithPartner: true };

  // Carol and Elizabeth overlap. Receiver rows are first-name-only; the helper's
  // gain a `note` payload column only when it discloses.
  const receiverRows = [
    { first_name: "Carol" },
    { first_name: "Elizabeth" },
    { first_name: "Henry" },
  ];
  const helperRows: Array<Record<string, string>> = opts.helperDiscloses
    ? [
        { first_name: "Alice", note: "h-a" },
        { first_name: "Bob", note: "h-b" },
        { first_name: "Carol", note: "h-c" },
        { first_name: "Elizabeth", note: "h-e" },
      ]
    : [
        { first_name: "Alice" },
        { first_name: "Bob" },
        { first_name: "Carol" },
        { first_name: "Elizabeth" },
      ];

  const prepare = (
    identity: string,
    output: Output,
    rows: Array<Record<string, string>>,
    columnNames: Array<string>,
  ) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...baseTerms,
          linkageStrategy: "single-pass",
          identity,
          output,
        },
      },
      identity,
      rows,
      columnNames,
    );

  const [connReceiver, connHelper] = createMessagePipe();
  const helperInbound: Array<unknown> = [];
  const capturingHelper: MessageConnection = {
    send: (m: unknown) => connHelper.send(m),
    receive: async (timeoutMs?: number) => {
      const frame = await connHelper.receive(timeoutMs);
      helperInbound.push(frame);
      return frame;
    },
    close: () => connHelper.close(),
    setInboundFrameCap: connHelper.setInboundFrameCap?.bind(connHelper),
  };

  // The pipe is symmetric, so the two parties can sit on either end; the handshake
  // role (which orders the payload phase) is set independently per opts.
  const [helper, receiver] = await Promise.all([
    runExchange(
      capturingHelper,
      opts.helperIsInitiator ? "initiator" : "responder",
      prepare(
        "Helper Co",
        helperOut,
        helperRows,
        opts.helperDiscloses ? ["first_name", "note"] : ["first_name"],
      ),
      { psiLibrary },
    ),
    runExchange(
      connReceiver,
      opts.helperIsInitiator ? "responder" : "initiator",
      prepare("Receiver Co", receiverOut, receiverRows, ["first_name"]),
      { psiLibrary },
    ),
  ]);
  return { receiver, helper, helperInbound };
}

test("single-pass one-sided, no-payload helper is blinded: table withheld, no hang", async () => {
  // The closeable case: a non-receiving helper whose data discloses no payload needs
  // nothing back, so the receiver withholds its association-table half at the source
  // -- the helper's process never receives, and so never learns, which of its own
  // records matched. The exchange still completes and the receiver gets its table.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: false,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");

  // The receiver still resolves and receives its table; the helper gets none (gated
  // as before). Carol and Elizabeth overlap -> two matches for the receiver.
  expect(receiver.associationTable).toBeDefined();
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helper.associationTable).toBeUndefined();

  // Neither side discloses payload, so both payload halves are empty.
  expect(receiver.partnerPayload.columns).toEqual([]);
  expect(helper.partnerPayload.columns).toEqual([]);

  // The blindness: no association-table frame ever reached the helper's process, and
  // the exchange completed without hanging (Promise.all resolved).
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("single-pass blind helper stays blind and hang-free with the helper as initiator", async () => {
  // The reverse handshake-role assignment: the blind helper is the INITIATOR, so it
  // sends first in the post-linkage payload phase (the other frame ordering the
  // primary test does not cover). The withholding and the no-hang guarantee must
  // hold in this permutation too.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: true,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helper.associationTable).toBeUndefined();
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("single-pass one-sided, payload-disclosing helper still receives its table at the wire", async () => {
  // The other side of the gate: a non-receiving helper that DOES disclose payload
  // needs its matched rows to build the enrichment it sends, so the table is NOT
  // withheld -- its process receives the association-table frame. Asserted at the
  // wire (the frame arrives), not merely inferred from the receiver's payload.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: true,
    helperIsInitiator: false,
  });

  expect(helper.resolvedRole).toBe("sender");
  // Still gated from the emitted result -- the helper is not entitled to output.
  expect(helper.associationTable).toBeUndefined();
  // The receiver gets the helper's disclosed payload for the matched rows...
  expect(receiver.partnerPayload.columns).toEqual(["note"]);
  // ...which is only possible because the helper received its association-table half:
  // the table frame (the only Array-shaped frame) DID reach the helper's process.
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(true);
});
