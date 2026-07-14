import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  resolveLinkageCardinality,
  assertDeduplicateImplemented,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { UsageError } from "../src/errors";

import type { PreparedExchange } from "../src/exchange";
import type { CSVRow } from "../src/file";

// The cardinality runExchange passes to the linkage strategies is derived from
// the two parties' agreed `deduplicate` settings by resolveLinkageCardinality.
// Only one-to-one (both parties deduplicate: false) is implemented; any
// deduplicating term must be refused BEFORE the PSI rounds with the actionable
// UsageError, never silently collapsed onto one-to-one and never left to the
// generic mid-run cardinality throw in link.ts.

// --- resolveLinkageCardinality: the mapping -----------------------------------

test("both parties deduplicate: false resolves to one-to-one", () => {
  expect(resolveLinkageCardinality(false, false)).toBe("one-to-one");
});

const refusedPairs: Array<[boolean, boolean]> = [
  [true, false],
  [false, true],
  [true, true],
];

for (const [localDeduplicate, partnerDeduplicate] of refusedPairs) {
  test(
    `deduplicate (local: ${localDeduplicate}, partner: ${partnerDeduplicate}) ` +
      "is refused with the actionable error",
    () => {
      let thrown: unknown;
      try {
        resolveLinkageCardinality(localDeduplicate, partnerDeduplicate);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      const message = (thrown as Error).message;
      // Names the field and the remedy...
      expect(message).toMatch(/deduplicate/);
      expect(message).toMatch(/deduplicate to false/);
      // ...and is not the generic mid-run throw from link.ts.
      expect(message).not.toMatch(/psi for cardinality/);
    },
  );
}

test("resolution is symmetric, so both parties derive the same verdict", () => {
  // Party A computes f(a, b) and party B computes f(b, a) from the same agreed
  // pair; symmetry is what makes the two verdicts identical by construction.
  const outcome = (a: boolean, b: boolean): string => {
    try {
      return `resolved:${resolveLinkageCardinality(a, b)}`;
    } catch (err) {
      return `refused:${(err as Error).message}`;
    }
  };
  for (const a of [false, true]) {
    for (const b of [false, true]) {
      expect(outcome(a, b)).toBe(outcome(b, a));
    }
  }
});

test("assertDeduplicateImplemented passes false and refuses true", () => {
  expect(() => assertDeduplicateImplemented(false)).not.toThrow();
  expect(() => assertDeduplicateImplemented(true)).toThrow(UsageError);
});

// --- runExchange: both parties refuse a deduplicating term in lockstep --------

const psiLibrary = await PSI();

const termsBase = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const rowsA: Array<CSVRow> = [{ first_name: "Alice" }, { first_name: "Carol" }];
const rowsB: Array<CSVRow> = [{ first_name: "Carol" }, { first_name: "Henry" }];

// prepareForExchange refuses deduplicate: true itself, so build the prepared
// exchange with the implemented terms and overwrite afterwards -- the way a
// caller that skipped prepareForExchange could -- leaving the run-side
// resolution as the guard under test.
function preparedWithDeduplicate(
  identity: string,
  rows: Array<CSVRow>,
  deduplicate: boolean,
): PreparedExchange {
  const prepared = prepareForExchange(
    { linkageTerms: { ...termsBase, identity } },
    identity,
    rows,
    ["first_name"],
  );
  prepared.linkageTerms = { ...prepared.linkageTerms, deduplicate };
  return prepared;
}

async function runBothWithDeduplicate(
  initiatorDeduplicates: boolean,
  responderDeduplicates: boolean,
): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> {
  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator, responder] = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      preparedWithDeduplicate("A", rowsA, initiatorDeduplicates),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      preparedWithDeduplicate("B", rowsB, responderDeduplicates),
      { psiLibrary },
    ),
  ]);
  return [initiator, responder];
}

function expectRefusedWithDeduplicateError(
  result: PromiseSettledResult<unknown>,
): void {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as Error;
  expect(reason).toBeInstanceOf(UsageError);
  expect(reason.message).toMatch(/deduplicate/);
  expect(reason.message).not.toMatch(/psi for cardinality/);
}

// Each single-true orientation: the terms exchange completes (the deduplicating
// party's terms parse on the partner -- expectsOutput is true -- and are
// compatible), then BOTH parties refuse at the post-terms resolution, before any
// PSI frame. Neither side is stranded awaiting a round the other never runs.
test("an initiator's deduplicating term is refused by both parties before the PSI rounds", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(true, false);
  expectRefusedWithDeduplicateError(initiator);
  expectRefusedWithDeduplicateError(responder);
});

test("a responder's deduplicating term is refused by both parties before the PSI rounds", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(false, true);
  expectRefusedWithDeduplicateError(initiator);
  expectRefusedWithDeduplicateError(responder);
});

test("deduplicate: false on both parties runs the exchange to completion", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(false, false);
  // The one-to-one path is untouched: the shared "Carol" matches.
  expect(initiator.status).toBe("fulfilled");
  expect(responder.status).toBe("fulfilled");
  const table = (
    initiator as PromiseFulfilledResult<{
      associationTable: [number[], number[]] | undefined;
    }>
  ).value.associationTable;
  expect(table).toStrictEqual([[1], [0]]);
});
