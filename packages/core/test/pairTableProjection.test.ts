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

// The entitlements default to the ordinary run -- this party receives the result
// and its partner reads its own half of the table -- so a test naming one of them
// is a test about that configuration.
const shape = (
  cardinality: ResolvedRunShape["cardinality"],
  localRecordCount: number,
  partnerRecordCount: number,
  entitlements: Partial<
    Pick<
      ResolvedRunShape,
      "localExpectsOutput" | "partnerAssociationTableWithheld"
    >
  > = {},
): ResolvedRunShape => ({
  cardinality,
  localRecordCount,
  localDeclaredRecordCount: localRecordCount,
  partnerRecordCount,
  localExpectsOutput: true,
  partnerAssociationTableWithheld: false,
  ...entitlements,
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

// A party whose own cleaning fans out declares its rows times the factor, and
// that declared figure is the only one its partner ever holds -- the raw count
// crosses no wire. Constructed shapes rather than a driven exchange because the
// combination is unreachable through prepareForExchange today: a fan-out runs
// under single-pass alone, which refuses the both-sided cardinality this
// projection is the only consumer of. The public shape admits it, so the
// projection is pinned over it here.
const fanned = (
  rows: number,
  factor: number,
  partnerRecordCount: number,
): ResolvedRunShape => ({
  ...shape("many-to-many", rows, partnerRecordCount),
  localDeclaredRecordCount: rows * factor,
});

test("both parties project one total when either side's cleaning fans out", () => {
  // 100 rows fanned by 20 declare 2,000; the partner holds 500 rows and declares
  // them. Each party multiplies the two DECLARED counts, so both project
  // 1,000,000 -- where multiplying a raw local count by a declared partner one
  // gives 50,000 on one side and 1,000,000 on the other for the same run, which
  // is a bound one of them would cross and the other would not.
  const fanningSide = projectPairTable(fanned(100, 20, 500));
  const plainSide = projectPairTable(shape("many-to-many", 500, 2000));
  expect(fanningSide?.projectedPairs).toBe(1_000_000n);
  expect(plainSide?.projectedPairs).toBe(fanningSide?.projectedPairs);

  // The same figure whichever seat fans out, including with both of them at it.
  const bothA = projectPairTable(fanned(100, 20, 10_000));
  const bothB = projectPairTable(fanned(500, 20, 2000));
  expect(bothA?.projectedPairs).toBe(20_000_000n);
  expect(bothB?.projectedPairs).toBe(bothA?.projectedPairs);
});

test("the advisory names the fanning party's own rows beside its declared count", () => {
  // The declared figure is the one both parties multiply, so it is what the
  // sentence leads with -- and on the fanning side it is a record count the
  // operator cannot find in its own file, so the rows behind it are named too.
  const advisory = describeResolvedRunShape(
    fanned(1000, 20, 1000),
  ).pairTableAdvisory!;
  expect(advisory).toContain("20,000,000");
  expect(advisory).toContain("the 20,000 records you declared");
  expect(advisory).toContain("the 1,000 your partner declared");
  expect(advisory).toContain("stands for your 1,000 records");
  expect(advisory).toMatch(/^[\x20-\x7e]+$/);
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
  // The declared count is a factor now, so it is held to the same bounds.
  expect(projectPairTable(fanned(MAX_RECORD_COUNT, 2, 10))).toBeUndefined();
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

test("names no result file of this party's where the terms give it none", () => {
  // The contradiction this closes: the cardinality label says nothing about who
  // receives the result, and only the declaring "many" party is required to
  // expect output -- so a "one" party with expects_output false is one a notice
  // naming "your result file" would send to a file the run never writes for it.
  const withheldFromUs = describeResolvedRunShape(
    shape("one-to-many", 10, 10, { localExpectsOutput: false }),
  ).cardinalityNotice!;
  expect(withheldFromUs).toContain("you receive no result from this run");
  expect(withheldFromUs).toContain("your partner's result file");
  expect(withheldFromUs).not.toContain("Your result file");

  // And the entitled reading of the same cardinality still names it.
  const heldByUs = describeResolvedRunShape(
    shape("one-to-many", 10, 10),
  ).cardinalityNotice!;
  expect(heldByUs).toContain("Your result file has one row per matched pair");
  expect(heldByUs).not.toContain("you receive no result");
});

test("attributes a both-sided run's pairs to whichever party the terms entitle", () => {
  // Same mechanism as the one-sided reading above, held at the branch that
  // carries the largest table: the entitlement is a field of the resolved shape,
  // so this branch reads it rather than resting its copy on the schema refinement
  // that makes a deduplicating party expect output.
  const withheldFromUs = describeResolvedRunShape(
    shape("many-to-many", 10, 10, { localExpectsOutput: false }),
  ).cardinalityNotice!;
  expect(withheldFromUs).toContain("you receive no result from this run");
  expect(withheldFromUs).toContain("your partner's result file");
  expect(withheldFromUs).not.toContain("Your result file");

  const heldByUs = describeResolvedRunShape(
    shape("many-to-many", 10, 10),
  ).cardinalityNotice!;
  expect(heldByUs).toContain("Your result file has one row per matched pair");
});

test("claims no partner disclosure where the run withholds the partner's half", () => {
  // The single-pass blind-helper configuration: the "one" party is the resolved
  // sender, expects no output, and discloses no payload, so its half of the table
  // is suppressed entirely and it reads neither the group sizes nor its own
  // membership (docs/spec/PROTOCOL.md, The disclosure delta a deduplicating match
  // pays). Telling the "many" party its partner learns the group sizes there
  // overstates what the run discloses.
  const withheld = describeResolvedRunShape(
    shape("many-to-one", 10, 10, { partnerAssociationTableWithheld: true }),
  ).cardinalityNotice!;
  expect(withheld).toContain("withholds your partner's half");
  expect(withheld).toContain("learns neither which of its own records matched");
  expect(withheld).not.toContain("your partner learns how many");

  // Every other many-to-one configuration does disclose it, which is the delta
  // the cardinality pays and the reason the notice exists.
  const disclosed = describeResolvedRunShape(
    shape("many-to-one", 10, 10),
  ).cardinalityNotice!;
  expect(disclosed).toContain("your partner learns how many of yours share");
  expect(disclosed).not.toContain("withholds");
});

test("the advisory claims no result file for a party that may hold none", () => {
  // The advisory rides the same shape, so it takes the same rule: it names the
  // run's cost without asserting which party ends up writing the file.
  const advisory = describeResolvedRunShape(
    shape("many-to-many", 3163, 3164),
  ).pairTableAdvisory!;
  expect(advisory).toContain("expect a large result and a long run");
  expect(advisory).not.toContain("your result file");
  expect(advisory).not.toContain("the result file");
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
  expect(over.pairTableAdvisory).toContain("the 3,163 records you declared");
  expect(over.pairTableAdvisory).toContain("the 3,164 your partner declared");
  // Nothing about a fan-out for a party whose declared count is its rows.
  expect(over.pairTableAdvisory).not.toContain("stands for your");
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

// `overrides` carries the terms a configuration under test differs by -- the
// output entitlement pair and the linkage strategy -- which the two parties must
// still mirror between them, `validateCompatibility` refusing an unmirrored pair
// at the terms exchange.
function preparedFor(
  identity: string,
  rows: Array<CSVRow>,
  deduplicate: boolean,
  overrides: Record<string, unknown> = {},
): PreparedExchange {
  return prepareForExchange(
    {
      linkageTerms: parseLinkageTerms({
        ...termsBase,
        identity,
        deduplicate,
        ...overrides,
      }),
    },
    identity,
    rows,
    ["first_name"],
  );
}

/** The mirrored `output` pair of a one-sided exchange: only the party this is
 * `true` for receives the result, which is what makes the other one a helper. */
const outputFor = (expectsOutput: boolean) => ({
  output: { expectsOutput, shareWithPartner: !expectsOutput },
});

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
  // label each party resolves, the local count is its own rows, and the
  // partner's is the one that rode the terms exchange. Neither party's cleaning
  // fans out here, so what each declared is what it holds.
  expect(captureA.runShape).toStrictEqual({
    cardinality: "many-to-many",
    localRecordCount: 4,
    localDeclaredRecordCount: 4,
    partnerRecordCount: 6,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  });
  expect(captureB.runShape).toStrictEqual({
    cardinality: "many-to-many",
    localRecordCount: 6,
    localDeclaredRecordCount: 6,
    partnerRecordCount: 4,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
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

test("a non-receiving party's own seam says so, on the cascade", async () => {
  // The "one" party is the helper here: it contributes its records, receives no
  // table of its own, and its notice must not promise it a result file. The
  // cascade withholds no half from anyone, so the "many" party's notice keeps the
  // disclosure sentence -- the withholding gate is single-pass's alone.
  const [resultA, captureA, resultB, captureB] = await runBoth(
    preparedFor("A", paddedRows("Henry", "Anna", 4), true, outputFor(true)),
    preparedFor("B", paddedRows("Henry", "Bruno", 6), false, outputFor(false)),
  );

  expect(captureA.runShape).toStrictEqual({
    cardinality: "many-to-one",
    localRecordCount: 4,
    localDeclaredRecordCount: 4,
    partnerRecordCount: 6,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  });
  expect(captureB.runShape).toStrictEqual({
    cardinality: "one-to-many",
    localRecordCount: 6,
    localDeclaredRecordCount: 6,
    partnerRecordCount: 4,
    localExpectsOutput: false,
    partnerAssociationTableWithheld: false,
  });

  // What the run then does with each party's result is what the helper's notice
  // has to agree with: a table for the entitled party, none for the helper.
  expect(resultA.associationTable).toStrictEqual([[0], [0]]);
  expect(resultB.associationTable).toBeUndefined();
  expect(
    describeResolvedRunShape(captureB.runShape!).cardinalityNotice,
  ).toContain("you receive no result from this run");
  expect(
    describeResolvedRunShape(captureA.runShape!).cardinalityNotice,
  ).toContain("your partner learns how many of yours share");
});

test("a single-pass blind helper is named as reading nothing back", async () => {
  // The one configuration in which the "many" party's partner learns nothing: the
  // "one" party is the resolved sender, expects no output, and discloses no
  // payload (its only column is a linkage column), so the receiver suppresses its
  // half of the table entirely. Only the "many" side's seam carries the fact --
  // the helper's own partner is the entitled one and reads its table as usual.
  const singlePass = { linkageStrategy: "single-pass" };
  const [, captureA, resultB, captureB] = await runBoth(
    preparedFor("A", paddedRows("Henry", "Anna", 4), true, {
      ...singlePass,
      ...outputFor(true),
    }),
    preparedFor("B", paddedRows("Henry", "Bruno", 6), false, {
      ...singlePass,
      ...outputFor(false),
    }),
  );

  expect(captureA.runShape).toStrictEqual({
    cardinality: "many-to-one",
    localRecordCount: 4,
    localDeclaredRecordCount: 4,
    partnerRecordCount: 6,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: true,
  });
  expect(captureB.runShape?.partnerAssociationTableWithheld).toBe(false);
  expect(resultB.associationTable).toBeUndefined();

  const many = describeResolvedRunShape(captureA.runShape!).cardinalityNotice!;
  expect(many).toContain("withholds your partner's half");
  expect(many).not.toContain("your partner learns how many");
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
    localDeclaredRecordCount: rows,
    partnerRecordCount: rows,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  });
  const advisory = describeResolvedRunShape(
    captureA.runShape!,
  ).pairTableAdvisory;
  expect(advisory).toContain("10,004,569");
  expect(advisory).toContain("the 3,163 records you declared");
  expect(advisory).toContain("the 3,163 your partner declared");

  // Warned, and completing: both parties hold the one table the round produced.
  expect(resultA.associationTable).toStrictEqual([[0], [0]]);
  expect(resultB.associationTable).toStrictEqual([[0], [0]]);

  // The run path itself said nothing about it. A warning raised there would
  // decide a front end's discretion for every seat.
  expect(captureA.warnings).toStrictEqual([]);
}, 30_000);
