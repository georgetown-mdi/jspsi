import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";

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

  // Send-gate: the receiver gets the helper's payload; the helper gets none.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(responder.partnerPayload.columns).toEqual([]);
});
