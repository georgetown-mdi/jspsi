import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  PAIR_TABLE_ADVISORY_MAX_PAIRS,
  describeResolvedRunShape,
  projectPairTable,
} from "../src/pairTableProjection";
import { MAX_RECORD_COUNT } from "../src/connection/frameSize";
import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { parseLinkageTerms } from "../src/config/linkageTerms";

import type { ResolvedRunShape } from "../src/pairTableProjection";
import type { ExchangeResult, PreparedExchange } from "../src/exchange";
import type { CSVRow } from "../src/file";

// The run's resolved cardinality and its projected pair table are named for the
// operator at the post-terms, pre-round seam. Core composes both strings and
// raises neither: the advisory is a front end's discretion (docs/spec/PROTOCOL.md,
// The both-sided expansion has no ceiling of its own), so what the run path owes a
// front end is the resolved shape, and what this module owes is one composition
// every seat renders.

const shape = (
  cardinality: ResolvedRunShape["cardinality"],
  localRecordCount: number,
  partnerRecordCount: number,
): ResolvedRunShape => ({
  cardinality,
  localRecordCount,
  partnerRecordCount,
});

// --- The projection ----------------------------------------------------------

test("projects the product only for the cardinality that grows quadratically", () => {
  // Both sides keep their duplicates only under many-to-many, which is the one
  // table the returned-list checks bound at a product. Under every other
  // cardinality at most one side keeps them and a single record count bounds the
  // table, so there is no product to project.
  expect(
    projectPairTable(shape("many-to-many", 3000, 4000))?.projectedPairs,
  ).toBe(12_000_000n);
  expect(projectPairTable(shape("many-to-one", 3000, 4000))).toBeUndefined();
  expect(projectPairTable(shape("one-to-many", 3000, 4000))).toBeUndefined();
  expect(projectPairTable(shape("one-to-one", 3000, 4000))).toBeUndefined();
});

test("compares the exact product against the bound at the bound itself", () => {
  const at = projectPairTable(shape("many-to-many", 1000, 10_000));
  expect(at?.projectedPairs).toBe(BigInt(PAIR_TABLE_ADVISORY_MAX_PAIRS));
  expect(at?.exceedsAdvisoryBound).toBe(false);

  const over = projectPairTable(shape("many-to-many", 1000, 10_001));
  expect(over?.exceedsAdvisoryBound).toBe(true);
});

test("keeps the product exact past the safe-integer range the counts admit", () => {
  // Both counts are bounded by MAX_RECORD_COUNT rather than by anything that
  // keeps their product under 2^53, so a number product would be an
  // approximation both in the comparison and in the figure the advisory names.
  const projection = projectPairTable(
    shape("many-to-many", MAX_RECORD_COUNT, MAX_RECORD_COUNT),
  );
  expect(projection?.projectedPairs).toBe(10n ** 24n);
  expect(projection?.exceedsAdvisoryBound).toBe(true);
  expect(Number(projection!.projectedPairs)).toBeGreaterThan(
    Number.MAX_SAFE_INTEGER,
  );
});

test("projects nothing for a count the terms exchange would not have admitted", () => {
  // The bounds are the terms-exchange schema's, which refuses a count outside
  // them as a protocol decode failure. Failing soft here: no projection, while
  // the cardinality is still named, because an advisory is no reason to end an
  // exchange or to withhold the fact beside it.
  for (const count of [-1, 1.5, Number.NaN, MAX_RECORD_COUNT + 1]) {
    const rejected = shape("many-to-many", 10, count);
    expect(projectPairTable(rejected)).toBeUndefined();
    expect(
      describeResolvedRunShape(rejected).pairTableAdvisory,
    ).toBeUndefined();
    expect(describeResolvedRunShape(rejected).cardinalityNotice).toContain(
      "many-to-many",
    );
  }
  expect(projectPairTable(shape("many-to-many", -1, 10))).toBeUndefined();
});

// --- What a front end renders ------------------------------------------------

test("names a deduplicating cardinality and stays silent on one-to-one", () => {
  expect(
    describeResolvedRunShape(shape("many-to-many", 10, 10)).cardinalityNotice,
  ).toContain("many-to-many");
  expect(
    describeResolvedRunShape(shape("many-to-one", 10, 10)).cardinalityNotice,
  ).toContain("many-to-one");
  expect(
    describeResolvedRunShape(shape("one-to-many", 10, 10)).cardinalityNotice,
  ).toContain("one-to-many");
  expect(
    describeResolvedRunShape(shape("one-to-one", 10, 10)).cardinalityNotice,
  ).toBeUndefined();
});

test("a one-sided cardinality names which party keeps its duplicates", () => {
  // The label is read from the resolving party's own side, so the two parties of
  // one exchange render mirror sentences about the single procedure they run --
  // and the copy has to say which of them is the "many" one, since that is what
  // decides whose records repeat.
  const many = describeResolvedRunShape(
    shape("many-to-one", 10, 10),
  ).cardinalityNotice!;
  expect(many).toMatch(/you keep your/);
  expect(many).not.toMatch(/your partner keeps/);

  const one = describeResolvedRunShape(
    shape("one-to-many", 10, 10),
  ).cardinalityNotice!;
  expect(one).toMatch(/your partner keeps/);
  expect(one).not.toMatch(/you keep your/);
});

test("raises no advisory under the bound and names both contributions above it", () => {
  const under = describeResolvedRunShape(shape("many-to-many", 3000, 3000));
  expect(under.cardinalityNotice).toContain("many-to-many");
  expect(under.pairTableAdvisory).toBeUndefined();

  const over = describeResolvedRunShape(shape("many-to-many", 3163, 3164));
  expect(over.cardinalityNotice).toContain("many-to-many");
  // The projection and what each side puts into it, so an operator can tell
  // which side drives it: the product, this party's own count, and the count the
  // partner declared.
  expect(over.pairTableAdvisory).toContain("10,007,732");
  expect(over.pairTableAdvisory).toContain("your 3,163 records");
  expect(over.pairTableAdvisory).toContain("the 3,164 your partner declared");
  expect(over.pairTableAdvisory).toContain("10,000,000");
});

test("composes both notices from ASCII bytes alone", () => {
  // The CLI writes these to a terminal it holds to printable ASCII (the
  // integration console sentinel), so the grouped digits must not pick up a
  // locale-default separator outside that range.
  const { cardinalityNotice, pairTableAdvisory } = describeResolvedRunShape(
    shape("many-to-many", 3163, 3164),
  );
  for (const notice of [cardinalityNotice!, pairTableAdvisory!])
    expect(notice).toMatch(/^[\x20-\x7e]+$/);
});

test("the advisory refuses nothing and says so", () => {
  const advisory = describeResolvedRunShape(
    shape("many-to-many", 5000, 5000),
  ).pairTableAdvisory!;
  expect(advisory).toContain("Nothing refuses on the projection");
});

// --- The seam runExchange hands a front end ----------------------------------

const psiLibrary = await PSI();

const termsBase = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

function preparedFor(
  identity: string,
  rows: Array<CSVRow>,
  deduplicate: boolean,
): PreparedExchange {
  return prepareForExchange(
    {
      linkageTerms: parseLinkageTerms({ ...termsBase, identity, deduplicate }),
    },
    identity,
    rows,
    ["first_name"],
  );
}

/**
 * One party's view of the run: every `onStage` id and the resolved shape the
 * pre-round seam handed it, in arrival order, plus whatever core raised through
 * `onWarning`.
 */
interface SeamCapture {
  events: Array<string>;
  runShape: ResolvedRunShape | undefined;
  warnings: Array<string>;
}

async function runBoth(
  a: PreparedExchange,
  b: PreparedExchange,
): Promise<[ExchangeResult, SeamCapture, ExchangeResult, SeamCapture]> {
  const [connA, connB] = createMessagePipe();
  const captures: [SeamCapture, SeamCapture] = [
    { events: [], runShape: undefined, warnings: [] },
    { events: [], runShape: undefined, warnings: [] },
  ];
  const options = (capture: SeamCapture) => ({
    psiLibrary,
    onStage: (id: string) => capture.events.push(`stage:${id}`),
    onWarning: (msg: string) => capture.warnings.push(msg),
    onProtocolConfirmed: (
      _partnerTerms: unknown,
      _resolvedRole: unknown,
      runShape: ResolvedRunShape,
    ) => {
      capture.runShape = runShape;
      capture.events.push("shape");
    },
  });
  const [resultA, resultB] = await Promise.all([
    runExchange(connA, "initiator", a, options(captures[0])),
    runExchange(connB, "responder", b, options(captures[1])),
  ]);
  return [resultA, captures[0], resultB, captures[1]];
}

// A shares one value with B ("Henry", one row each) and pads the rest of each
// dataset with a party-specific duplicate value. So the declared record counts --
// what the projection multiplies -- are whatever the padding makes them, while
// each party contributes two DISTINCT values to the round and the run matches a
// single pair. That is what makes an over-bound projection runnable here: the
// quadratic term is the derived pair table, never the rounds.
function paddedRows(
  shared: string,
  padding: string,
  rows: number,
): Array<CSVRow> {
  return [
    { first_name: shared },
    ...Array.from({ length: rows - 1 }, () => ({ first_name: padding })),
  ];
}

test("hands the resolved shape to the front end before the first round", async () => {
  const [resultA, captureA, , captureB] = await runBoth(
    preparedFor("A", paddedRows("Henry", "Anna", 4), true),
    preparedFor("B", paddedRows("Henry", "Bruno", 6), true),
  );

  // Both counts, read from this party's own side: the cardinality is the mirror
  // label each party resolves, the local count is its own, and the partner's is
  // the one that rode the terms exchange.
  expect(captureA.runShape).toStrictEqual({
    cardinality: "many-to-many",
    localRecordCount: 4,
    partnerRecordCount: 6,
  });
  expect(captureB.runShape).toStrictEqual({
    cardinality: "many-to-many",
    localRecordCount: 6,
    partnerRecordCount: 4,
  });

  // Before the first PSI key round, so a front end can render it while the
  // operator can still stop the run.
  expect(captureA.events).toStrictEqual([
    "stage:confirming protocol",
    "shape",
    "stage:stage 1 / 1",
  ]);

  // Under the bound: the cardinality is named anyway, and no advisory is
  // composed.
  const notices = describeResolvedRunShape(captureA.runShape!);
  expect(notices.cardinalityNotice).toContain("many-to-many");
  expect(notices.pairTableAdvisory).toBeUndefined();

  expect(resultA.associationTable).toStrictEqual([[0], [0]]);
});

test("a one-sided run names its own side of the cardinality at the seam", async () => {
  const [, captureA, , captureB] = await runBoth(
    preparedFor("A", paddedRows("Henry", "Anna", 4), true),
    preparedFor("B", paddedRows("Henry", "Bruno", 6), false),
  );

  expect(captureA.runShape?.cardinality).toBe("many-to-one");
  expect(captureB.runShape?.cardinality).toBe("one-to-many");
  expect(
    describeResolvedRunShape(captureA.runShape!).cardinalityNotice,
  ).toContain("many-to-one");
  expect(
    describeResolvedRunShape(captureB.runShape!).cardinalityNotice,
  ).toContain("one-to-many");
  // A one-sided table is bounded by the many side's record count rather than by
  // a product, so no projection is offered for it whatever the counts.
  expect(
    describeResolvedRunShape(captureA.runShape!).pairTableAdvisory,
  ).toBeUndefined();
});

test("an over-bound projection warns and the run completes", async () => {
  // 3,163 x 3,163 = 10,004,569 projected pairs, past the 10,000,000 bound. The
  // exchange runs to a result regardless: nothing in the run path refuses on the
  // projection, and core raises no advisory of its own -- the composition below
  // is the front end's to render.
  const rows = 3163;
  const [resultA, captureA, resultB] = await runBoth(
    preparedFor("A", paddedRows("Henry", "Anna", rows), true),
    preparedFor("B", paddedRows("Henry", "Bruno", rows), true),
  );

  expect(captureA.runShape).toStrictEqual({
    cardinality: "many-to-many",
    localRecordCount: rows,
    partnerRecordCount: rows,
  });
  const advisory = describeResolvedRunShape(
    captureA.runShape!,
  ).pairTableAdvisory;
  expect(advisory).toContain("10,004,569");
  expect(advisory).toContain("your 3,163 records");
  expect(advisory).toContain("the 3,163 your partner declared");

  // Warned, and completing: both parties hold the one table the round produced.
  expect(resultA.associationTable).toStrictEqual([[0], [0]]);
  expect(resultB.associationTable).toStrictEqual([[0], [0]]);

  // The run path itself said nothing about it. A warning raised there would
  // decide a front end's discretion for every seat.
  expect(captureA.warnings).toStrictEqual([]);
}, 30_000);
