import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { parse as parseYaml } from "yaml";

import {
  prepareForExchange,
  runExchange,
  resolveLinkageCardinality,
  assertBothSidedDeduplicateImplemented,
  assertDeduplicateImplemented,
  assertMatchedPairsWellFormed,
  matchedPairCount,
  InvitationTermDivergenceError,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY,
  deriveAcceptedLinkageTerms,
  manyToManyIsImplementedForStrategy,
  parseLinkageTerms,
  validateCompatibility,
} from "../src/config/linkageTerms";
import { entityClusters } from "../src/entityClosure";
import { inferMetadata } from "../src/config/metadata";
import { mintExchangeFile } from "../src/config/exchangeFile";
import { parseExchangeSpec } from "../src/config/exchangeSpec";
import { buildOutputTable } from "../src/payloadExchange";
import { UsageError } from "../src/errors";

import type { PreparedExchange, ExchangeResult } from "../src/exchange";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { LinkageStrategy, LinkageTerms } from "../src/config/linkageTerms";
import type { CSVRow } from "../src/file";

// The cardinality runExchange passes to the linkage strategies comes from the
// agreed `deduplicate` settings. Both strategies run the one-sided
// cardinalities; only the cascade runs the both-sided one. The pair single-pass
// cannot match must be refused before the PSI rounds with the actionable
// UsageError -- never silently collapsed onto a narrower cardinality, and never
// left to the generic mid-run cardinality throw in link.ts.

// --- resolveLinkageCardinality: the mapping -----------------------------------

const cardinalityTerms = (
  deduplicate: boolean,
  linkageStrategy: LinkageStrategy = "cascade",
): LinkageTerms =>
  parseLinkageTerms({
    version: "1.0.0",
    identity: "Probe",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy,
    deduplicate,
    output: { expectsOutput: true, shareWithPartner: true },
    linkageFields: [{ name: "firstName", type: "first_name" }],
    linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
  });

const resolveFor = (
  local: boolean,
  partner: boolean,
  strategy: LinkageStrategy = "cascade",
): string =>
  resolveLinkageCardinality(
    cardinalityTerms(local, strategy),
    cardinalityTerms(partner, strategy),
  );

test("the agreed deduplicate pair maps to the per-side cardinality label", () => {
  // The label is read from the CALLING party's own side, so the declaring party
  // resolves many-to-one and its partner one-to-many for the single mirrored
  // procedure they run. The both-sided pair is its own mirror.
  expect(resolveFor(false, false)).toBe("one-to-one");
  expect(resolveFor(true, false)).toBe("many-to-one");
  expect(resolveFor(false, true)).toBe("one-to-many");
  expect(resolveFor(true, true)).toBe("many-to-many");
});

// The refusal's remedy is assembled from the strategy table, so which clauses
// it holds varies with that table. Every sentence after the first still opens
// capitalized, by the convention error messages use, so a dropped clause must
// not leave the next sentence starting on a lowercase verb.
const sentencesAfterTheFirst = (message: string): Array<string> =>
  message.split(". ").slice(1);

test("the both-sided pair under single-pass is refused, naming the strategy", () => {
  let thrown: unknown;
  try {
    resolveFor(true, true, "single-pass");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const message = (thrown as Error).message;
  for (const sentence of sentencesAfterTheFirst(message))
    expect(sentence).toMatch(/^[A-Z]/);
  // What stands in the way is the STRATEGY, not the pair: the message says so,
  // and names the strategy to move to rather than telling the operator the
  // cardinality awaits an implementation.
  expect(message).toMatch(/linkage strategy these terms name/);
  expect(message).toMatch(/does not match a many-to-many cardinality/);
  expect(message).toMatch(/Set linkage_strategy to cascade to run the pair/);
  expect(message).not.toMatch(/no exchange runs that cardinality/);
  // Not the per-party guard's message either: that one answers `true` for
  // single-pass, so it is not the boundary this refusal comes from.
  expect(message).not.toMatch(/deduplicated matching is not implemented/);
  // Not the generic mid-run throw from link.ts.
  expect(message).not.toMatch(/psi for cardinality/);
});

test("single-pass resolves every label except the both-sided one", () => {
  // The strategy decides how a cardinality is matched, and for the both-sided
  // pair whether it is matched at all: single-pass resolves the one-sided
  // labels exactly as the cascade does, and one party's `deduplicate: true`
  // under it stays runnable whichever way round the pair sits.
  expect(resolveFor(false, false, "single-pass")).toBe("one-to-one");
  expect(resolveFor(true, false, "single-pass")).toBe("many-to-one");
  expect(resolveFor(false, true, "single-pass")).toBe("one-to-many");
  expect(() => resolveFor(true, true, "single-pass")).toThrow(
    /linkage strategy these terms name/,
  );
});

test("the both-sided strategy guard reads the pair, not one party's document", () => {
  // The property that makes this a boundary of its own rather than a widening of
  // `assertDeduplicateImplemented`: it fires on the agreed PAIR, so a single-pass
  // party declaring `deduplicate: true` against a partner that does not is left
  // alone -- the run it asks for is the one-sided one single-pass matches.
  for (const [local, partner] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const)
    expect(() =>
      assertBothSidedDeduplicateImplemented(
        cardinalityTerms(local, "single-pass"),
        cardinalityTerms(partner, "single-pass"),
      ),
    ).not.toThrow();
  expect(() =>
    assertBothSidedDeduplicateImplemented(
      cardinalityTerms(true, "single-pass"),
      cardinalityTerms(true, "single-pass"),
    ),
  ).toThrow(UsageError);
  // The strategy that pairs it passes the same pair through.
  expect(() =>
    assertBothSidedDeduplicateImplemented(
      cardinalityTerms(true),
      cardinalityTerms(true),
    ),
  ).not.toThrow();
});

// The strategy table is where a strategy declares whether it pairs the both-sided
// cardinality, and the run boundary reads it rather than naming a strategy. Driven
// to the other verdict here so the read is shown rather than assumed, the shipped
// table admitting only one of the two. Synchronous throughout, so no other test
// observes the flipped entry.
function withManyToManyVerdict<T>(
  strategy: LinkageStrategy,
  verdict: boolean,
  read: () => T,
): T {
  const shipped = MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy];
  MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy] = verdict;
  try {
    return read();
  } finally {
    MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy] = shipped;
  }
}

test("the run boundary reads the strategy table rather than naming a strategy", () => {
  expect(MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY).toStrictEqual({
    cascade: true,
    "single-pass": false,
  });
  for (const strategy of Object.keys(
    MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY,
  ) as LinkageStrategy[])
    expect(manyToManyIsImplementedForStrategy(strategy)).toBe(
      MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy],
    );

  // A cascade that stopped pairing the cardinality is refused on the same pair
  // the shipped table resolves, and the remedy names whichever strategies do
  // pair it -- here single-pass, the entry flipped the other way.
  const message = withManyToManyVerdict("cascade", false, () =>
    withManyToManyVerdict("single-pass", true, () => {
      let thrown: unknown;
      try {
        resolveFor(true, true);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      return (thrown as Error).message;
    }),
  );
  expect(message).toMatch(/Set linkage_strategy to single-pass/);
  // Restored, so the pair the shipped table admits still resolves.
  expect(resolveFor(true, true)).toBe("many-to-many");
});

test("a build where no strategy pairs the cardinality states the remedy left", () => {
  // Both entries driven the other way, which is the one shape that drops the
  // strategy clause: what remains is the remedy that needs no strategy, and it
  // stands as its own sentence rather than trailing the one before it.
  const message = withManyToManyVerdict("cascade", false, () =>
    withManyToManyVerdict("single-pass", false, () => {
      let thrown: unknown;
      try {
        resolveFor(true, true);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      return (thrown as Error).message;
    }),
  );
  expect(message).not.toMatch(/Set linkage_strategy/);
  expect(message).toMatch(
    /Set deduplicate to false on one of the two parties to run a many-to-one match\.$/,
  );
  for (const sentence of sentencesAfterTheFirst(message))
    expect(sentence).toMatch(/^[A-Z]/);
  // Restored, so the pair the shipped table admits still resolves.
  expect(resolveFor(true, true)).toBe("many-to-many");
});

test("resolution is symmetric, so both parties derive the same verdict", () => {
  // Party A computes f(a, b) and party B computes f(b, a) from the same agreed
  // pair. Symmetry is what makes the two verdicts identical by construction: a
  // resolved pair yields the MIRROR label, and a refused one yields the same
  // refusal on both parties -- which is what keeps the lockstep rounds from
  // beginning on one side and aborting on the other.
  const mirrorOf: Record<string, string> = {
    "one-to-one": "one-to-one",
    "many-to-one": "one-to-many",
    "one-to-many": "many-to-one",
    "many-to-many": "many-to-many",
  };
  const outcome = (
    a: boolean,
    b: boolean,
    strategy: LinkageStrategy,
  ): { kind: string; value: string } => {
    try {
      return { kind: "resolved", value: resolveFor(a, b, strategy) };
    } catch (err) {
      return { kind: "refused", value: (err as Error).message };
    }
  };
  for (const strategy of ["cascade", "single-pass"] as const) {
    for (const a of [false, true]) {
      for (const b of [false, true]) {
        const mine = outcome(a, b, strategy);
        const theirs = outcome(b, a, strategy);
        expect(theirs.kind).toBe(mine.kind);
        expect(theirs.value).toBe(
          mine.kind === "resolved" ? mirrorOf[mine.value] : mine.value,
        );
      }
    }
  }
});

test("an accept-derived pair resolves the one-sided cardinality (hostile flip closed)", () => {
  // Acceptance derives the acceptor's own `deduplicate` as false rather than
  // adopting the inviter's, so the pair is one-sided whatever the invitation
  // declares: the inviter is the "many" side and the acceptor the "one". The
  // flip that closes: an inviter declaring `true` and then presenting `false`
  // at the terms exchange cannot make the acceptor the "many" side, since the
  // acceptor's value was never the invitation's to set.
  for (const declared of [false, true]) {
    const inviter = cardinalityTerms(declared);
    const acceptor = deriveAcceptedLinkageTerms(inviter, "Acceptor");
    expect(acceptor.deduplicate).toBe(false);
    expect(resolveLinkageCardinality(acceptor, inviter)).toBe(
      declared ? "one-to-many" : "one-to-one",
    );
    // The mirror label, from the inviter's own side of the same pair.
    expect(resolveLinkageCardinality(inviter, acceptor)).toBe(
      declared ? "many-to-one" : "one-to-one",
    );
  }
  // Whatever the inviter presents at the terms exchange, the acceptor's own side
  // stays the "one" one: the both-sided pair no accept-derived exchange can reach.
  const flipped = cardinalityTerms(false);
  const acceptor = deriveAcceptedLinkageTerms(
    cardinalityTerms(true),
    "Acceptor",
  );
  expect(resolveLinkageCardinality(acceptor, flipped)).toBe("one-to-one");
});

test("assertDeduplicateImplemented passes every strategy this build ships", () => {
  for (const strategy of Object.keys(
    DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  ) as LinkageStrategy[]) {
    expect(DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy]).toBe(true);
    expect(() =>
      assertDeduplicateImplemented(cardinalityTerms(false, strategy)),
    ).not.toThrow();
    expect(() =>
      assertDeduplicateImplemented(cardinalityTerms(true, strategy)),
    ).not.toThrow();
  }
});

// The guard is what a strategy declaring it cannot match a group is stopped at,
// and no shipped strategy declares that -- so the verdict is driven to `false`
// here rather than left as a branch nothing reaches. Synchronous throughout, so
// no other test observes the flipped table.
function withDeduplicateUnimplemented<T>(
  strategy: LinkageStrategy,
  read: () => T,
): T {
  const shipped = DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy] = false;
  try {
    return read();
  } finally {
    DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy] = shipped;
  }
}

test("a strategy declaring no deduplicating match is refused at every boundary", () => {
  const thrownFrom = (read: () => unknown): Error => {
    let thrown: unknown;
    try {
      read();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    return thrown as Error;
  };
  const terms = cardinalityTerms(true, "single-pass");
  const messages = withDeduplicateUnimplemented("single-pass", () => [
    // The run boundary, over both parties' documents ...
    thrownFrom(() => resolveFor(true, false, "single-pass")).message,
    thrownFrom(() => resolveFor(false, true, "single-pass")).message,
    // ... the local prepare step's own reading of one document ...
    thrownFrom(() => assertDeduplicateImplemented(terms)).message,
    // ... and the accept boundary, reading the INVITING party's terms, which the
    // acceptor's derived `deduplicate: false` would otherwise hide.
    thrownFrom(() => deriveAcceptedLinkageTerms(terms, "Acceptor")).message,
  ]);
  // One account of the refusal wherever it is met, naming the remedy rather than
  // the offending document's own value.
  expect(new Set(messages).size).toBe(1);
  expect(messages[0]).toMatch(/deduplicated matching is not implemented/);
  expect(messages[0]).toMatch(/set deduplicate to false/);
  expect(messages[0]).not.toMatch(/psi for cardinality/);
  // Restored, so the pair the shipped table admits still resolves.
  expect(resolveFor(true, false, "single-pass")).toBe("many-to-one");
});

test("acceptance derives every strategy-and-deduplicate pair this build runs", () => {
  // The derived acceptor value is false whatever the invitation declares, and
  // every combination the shipped strategies match derives rather than refuses --
  // the four the two axes give.
  for (const strategy of Object.keys(
    DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  ) as LinkageStrategy[]) {
    for (const deduplicate of [false, true]) {
      expect(
        deriveAcceptedLinkageTerms(
          cardinalityTerms(deduplicate, strategy),
          "Acceptor",
        ).deduplicate,
      ).toBe(false);
    }
  }
});

// --- the matched-pair table: what it admits and refuses ----------------------
// Downstream code reads the table as matched PAIRS: one payload row per
// matched record, one result row per pair, and the attested size the pair
// count. Which multiplicities it may hold follows from the resolved
// cardinality: a repeated local row is the deduplicating shape, refused under
// one-to-one, where each record stands in exactly one pair. An out-of-order
// local half or a repeated pair is refused under every cardinality.

test("a strictly ascending local half is what the consuming seam accepts", () => {
  expect(() =>
    assertMatchedPairsWellFormed([[], []], "one-to-one"),
  ).not.toThrow();
  expect(() =>
    assertMatchedPairsWellFormed([[3], [0]], "one-to-one"),
  ).not.toThrow();
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 2, 5],
        [4, 1, 0],
      ],
      "one-to-one",
    ),
  ).not.toThrow();
});

test("a repeated local row is refused under one-to-one at the consuming seam", () => {
  // One-to-one pairs each matched record of ours exactly once, so the payload rows
  // and the result rows stand one per matched record. A repeat is the
  // deduplicating shape and does not belong under this label.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 1],
        [0, 1, 2],
      ],
      "one-to-one",
    ),
  ).toThrow(/repeats a local row index/);
});

test("a deduplicating table's repeated local row is admitted at the consuming seam", () => {
  // The "one" side of a deduplicating exchange: the partner's rows 0 and 1 both
  // link to this party's row 0.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 1],
        [0, 1, 2],
      ],
      "one-to-many",
    ),
  ).not.toThrow();
  // The both-sides fan admits the same local repeat.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 1],
        [0, 1, 2],
      ],
      "many-to-many",
    ),
  ).not.toThrow();
});

test("the mirror table's repeated partner row is admitted at the consuming seam", () => {
  // The "many" side: this party's rows 0 and 1 both link to the partner's row 4.
  // Its local half is strictly ascending, so one-to-one admits it too -- the
  // multiplicity this label holds sits on the partner half.
  for (const cardinality of ["many-to-one", "one-to-one"] as const) {
    expect(() =>
      assertMatchedPairsWellFormed(
        [
          [0, 1, 2],
          [4, 4, 7],
        ],
        cardinality,
      ),
    ).not.toThrow();
  }
});

test("a descending local half is refused at the consuming seam", () => {
  for (const cardinality of ["one-to-one", "one-to-many"] as const) {
    expect(() =>
      assertMatchedPairsWellFormed(
        [
          [1, 0],
          [0, 1],
        ],
        cardinality,
      ),
    ).toThrow(/not in ascending order/);
  }
});

test("a repeated pair is refused at the consuming seam", () => {
  // One link written twice: the result file would hold the row twice and the
  // attested size would count it twice. Checked under the cardinality that admits
  // the repeated local row at all, so the pair check is what refuses these.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 1],
        [3, 3, 5],
      ],
      "one-to-many",
    ),
  ).toThrow(/repeats a matched pair/);
  // Non-adjacent within the same run of equal local rows.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 0],
        [3, 5, 3],
      ],
      "one-to-many",
    ),
  ).toThrow(/repeats a matched pair/);
  // The same partner row against a DIFFERENT local row is a distinct pair, not a
  // repeat, so the run-scoped check must not fire on it.
  expect(() =>
    assertMatchedPairsWellFormed(
      [
        [0, 0, 1],
        [3, 5, 3],
      ],
      "one-to-many",
    ),
  ).not.toThrow();
});

test("halves of different lengths are refused at the consuming seam", () => {
  expect(() =>
    assertMatchedPairsWellFormed([[0, 1], [0]], "one-to-one"),
  ).toThrow(/different lengths/);
});

test("the attested result size is the pair count, not the matched-record count", () => {
  // The "one" side of a deduplicating exchange: two of the partner's records link
  // to this party's row 0, so two pairs stand against one matched record here.
  const oneSideTable: [Array<number>, Array<number>] = [
    [0, 0, 1],
    [0, 1, 2],
  ];
  expect(matchedPairCount(oneSideTable)).toBe(3);
  expect(new Set(oneSideTable[0]).size).toBe(2);
  // Its mirror holds the same pair count, which is what makes the two parties'
  // records of one exchange agree on the figure.
  expect(
    matchedPairCount([
      [0, 1, 2],
      [0, 0, 1],
    ]),
  ).toBe(3);
});

// --- runExchange: the agreed pair decides the run, in lockstep ----------------

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

// A holds "Carol" twice, so a many-to-one run groups both of its rows onto B's
// single "Carol" where a one-to-one run drops the value as ambiguous. "Henry" is
// the unambiguous shared value beside it: it matches under every cardinality, so
// the one-to-one leg asserts a real match rather than an empty table, and the
// difference the grouping makes is read against a run that also matched
// something.
const rowsA: Array<CSVRow> = [
  { first_name: "Alice" },
  { first_name: "Carol" },
  { first_name: "Carol" },
  { first_name: "Henry" },
];
const rowsB: Array<CSVRow> = [{ first_name: "Carol" }, { first_name: "Henry" }];

// The strategy is set after prepareForExchange rather than through it, so the
// terms it prepares are the same document under both strategies and the only
// difference between two runs of one pair is which strategy runs it.
function preparedWithDeduplicate(
  identity: string,
  rows: Array<CSVRow>,
  deduplicate: boolean,
  linkageStrategy: LinkageStrategy = "cascade",
): PreparedExchange {
  const prepared = prepareForExchange(
    { linkageTerms: { ...termsBase, identity, deduplicate } },
    identity,
    rows,
    ["first_name"],
  );
  prepared.linkageTerms = { ...prepared.linkageTerms, linkageStrategy };
  return prepared;
}

async function runBothWithDeduplicate(
  initiatorDeduplicates: boolean,
  responderDeduplicates: boolean,
  linkageStrategy: LinkageStrategy = "cascade",
  rows: { initiator: Array<CSVRow>; responder: Array<CSVRow> } = {
    initiator: rowsA,
    responder: rowsB,
  },
): Promise<
  [PromiseSettledResult<ExchangeResult>, PromiseSettledResult<ExchangeResult>]
> {
  const [connInitiator, connResponder] = createMessagePipe();
  return await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      preparedWithDeduplicate(
        "A",
        rows.initiator,
        initiatorDeduplicates,
        linkageStrategy,
      ),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      preparedWithDeduplicate(
        "B",
        rows.responder,
        responderDeduplicates,
        linkageStrategy,
      ),
      { psiLibrary },
    ),
  ]);
}

function expectRefusedWith(
  result: PromiseSettledResult<ExchangeResult>,
  named: RegExp,
): void {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as Error;
  expect(reason).toBeInstanceOf(UsageError);
  expect(reason.message).toMatch(named);
  expect(reason.message).not.toMatch(/psi for cardinality/);
}

function fulfilled(
  result: PromiseSettledResult<ExchangeResult>,
): ExchangeResult {
  expect(result.status).toBe("fulfilled");
  return (result as PromiseFulfilledResult<ExchangeResult>).value;
}

// Each single-true orientation runs: the terms exchange completes, both parties
// resolve the mirror labels of one cardinality from the same agreed pair, and the
// cascade produces the one table both of them hold.
test("an agreed many-to-one pair runs end to end and groups the many side's rows", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(true, false);
  const many = fulfilled(initiator);
  const one = fulfilled(responder);

  // A is the "many" side: its rows 1 and 2 both link to B's row 0, and its own
  // half stays ascending while the multiplicity lands on the partner half. Its
  // unambiguous row 3 pairs once, the way it does one-to-one.
  expect(many.associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
  // B holds the mirror of that one table: its row 0 stands in two pairs.
  expect(one.associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);

  // The result file is one row per PAIR on both sides, so the "many" side's
  // partner index repeats down its column and the "one" side's identifier does.
  expect(
    buildOutputTable(
      many.associationTable!,
      rowsA,
      inferMetadata(["first_name"]),
      many.partnerPayload,
    ).rows,
  ).toStrictEqual([
    ["1", "0"],
    ["2", "0"],
    ["3", "1"],
  ]);
  expect(
    buildOutputTable(
      one.associationTable!,
      rowsB,
      inferMetadata(["first_name"]),
      one.partnerPayload,
    ).rows,
  ).toStrictEqual([
    ["0", "1"],
    ["0", "2"],
    ["1", "3"],
  ]);

  // Both records attest the same figure, which is the pair count rather than
  // either party's matched-record count (3 pairs over 3 of A's records and 2 of
  // B's).
  expect(many.audit?.record.resultSize).toBe(3);
  expect(one.audit?.record.resultSize).toBe(3);
  expect(matchedPairCount(many.associationTable!)).toBe(3);
});

test("the mirror orientation runs the same procedure from the other handshake role", async () => {
  // The responder declares it and holds the duplicated rows, so the "many" side
  // is the other handshake role and the other PSI role than above. One procedure,
  // mirrored: the same table reaches both parties.
  const [initiator, responder] = await runBothWithDeduplicate(
    false,
    true,
    "cascade",
    { initiator: rowsB, responder: rowsA },
  );
  expect(fulfilled(initiator).associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
  expect(fulfilled(responder).associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
});

test("an accepted deduplicating invitation runs many-to-one end to end", async () => {
  // The invite-and-accept path rather than two hand-authored configs: the
  // acceptor's terms are the ones core derives from the invitation, so what runs
  // here is the pair an accepted deduplicating invitation actually produces.
  const inviterTerms = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: true,
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "B");
  expect(acceptorTerms.deduplicate).toBe(false);

  const [connInviter, connAcceptor] = createMessagePipe();
  const [inviter, acceptor] = await Promise.allSettled([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: inviterTerms }, "A", rowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
    runExchange(
      connAcceptor,
      "responder",
      prepareForExchange({ linkageTerms: acceptorTerms }, "B", rowsB, [
        "first_name",
      ]),
      { psiLibrary },
    ),
  ]);

  // The inviting party is the "many" side: its duplicate rows group onto the
  // accepting party's single record, and the accepting party holds the mirror of
  // that one table.
  expect(fulfilled(inviter).associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
  expect(fulfilled(acceptor).associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
  expect(fulfilled(inviter).audit?.record.resultSize).toBe(3);
  expect(fulfilled(acceptor).audit?.record.resultSize).toBe(3);
});

// Both files hold a duplicated value, so the deduplicating rules apply on BOTH
// sides: "Carol" stands for a group of two on each, and the pairs it contributes
// are the two groups' product. "Henry" is the unambiguous shared value beside it,
// and "Alice" matches nothing -- so one run holds a multi-record cluster, a
// single-pair cluster, and an unmatched record at once.
const mutualRowsA: Array<CSVRow> = [
  { first_name: "Alice" },
  { first_name: "Carol" },
  { first_name: "Carol" },
  { first_name: "Henry" },
];
const mutualRowsB: Array<CSVRow> = [
  { first_name: "Carol" },
  { first_name: "Carol" },
  { first_name: "Henry" },
];

test("an agreed both-sided pair runs end to end and groups both parties' rows", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(
    true,
    true,
    "cascade",
    { initiator: mutualRowsA, responder: mutualRowsB },
  );
  const a = fulfilled(initiator);
  const b = fulfilled(responder);

  // Each party keeps its own duplicates and attributes the matched value to every
  // record holding it, so the "Carol" value contributes 2 x 2 = 4 pairs and
  // "Henry" one. Both parties hold the one table, mirrored.
  expect(a.associationTable).toStrictEqual([
    [1, 1, 2, 2, 3],
    [0, 1, 0, 1, 2],
  ]);
  expect(b.associationTable).toStrictEqual([
    [0, 0, 1, 1, 2],
    [1, 2, 1, 2, 3],
  ]);

  // The closure both parties run locally over that one table: the two-by-two
  // block and the single pair beside it, each party reading its own side first.
  expect(entityClusters(a.associationTable!)).toStrictEqual([
    { localRows: [1, 2], partnerRows: [0, 1] },
    { localRows: [3], partnerRows: [2] },
  ]);
  expect(entityClusters(b.associationTable!)).toStrictEqual([
    { localRows: [0, 1], partnerRows: [1, 2] },
    { localRows: [2], partnerRows: [3] },
  ]);

  // The result file is one row per PAIR, so a cluster of m of this party's
  // records and n of the partner's writes m x n rows -- 4 for the block, 1 for
  // the pair beside it, in this party's own row order.
  expect(
    buildOutputTable(
      a.associationTable!,
      mutualRowsA,
      inferMetadata(["first_name"]),
      a.partnerPayload,
    ).rows,
  ).toStrictEqual([
    ["1", "0"],
    ["1", "1"],
    ["2", "0"],
    ["2", "1"],
    ["3", "2"],
  ]);
  expect(
    buildOutputTable(
      b.associationTable!,
      mutualRowsB,
      inferMetadata(["first_name"]),
      b.partnerPayload,
    ).rows,
  ).toStrictEqual([
    ["0", "1"],
    ["0", "2"],
    ["1", "1"],
    ["1", "2"],
    ["2", "3"],
  ]);

  // Both records attest the one figure, which is the pair count -- neither
  // party's matched-record count (3 and 3) and neither party's cluster count (2).
  expect(a.audit?.record.resultSize).toBe(5);
  expect(b.audit?.record.resultSize).toBe(5);
  expect(matchedPairCount(a.associationTable!)).toBe(5);
});

test("the same two files match only the unambiguous value without the pair", async () => {
  // Non-vacuity for the run above: with either party's `deduplicate` cleared the
  // duplicated value is ambiguous on at least one side and drops out of the
  // round, so only "Henry" matches. The grouping is what the agreed pair adds.
  for (const [a, b] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    const [initiator, responder] = await runBothWithDeduplicate(
      a,
      b,
      "cascade",
      { initiator: mutualRowsA, responder: mutualRowsB },
    );
    expect(fulfilled(initiator).associationTable).toStrictEqual([[3], [2]]);
    expect(fulfilled(responder).associationTable).toStrictEqual([[2], [3]]);
  }
});

// The refused pair aborts BOTH parties at the post-terms resolution, before any
// PSI frame. Neither side is stranded awaiting a round the other never runs.
test("a both-sided pair under single-pass is refused by both parties before the rounds", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(
    true,
    true,
    "single-pass",
    { initiator: mutualRowsA, responder: mutualRowsB },
  );
  // What the refusal names is the strategy that does not pair the cardinality,
  // and the strategy that does -- not the pair awaiting an implementation.
  for (const result of [initiator, responder]) {
    expectRefusedWith(result, /linkage strategy these terms name/);
    expectRefusedWith(
      result,
      /Set linkage_strategy to cascade to run the pair/,
    );
  }
});

test("an acceptor declaring the setting in its own config runs the both-sided pair", async () => {
  // Acceptance's own route to the pair: it derives the accepting party's
  // `deduplicate` as false, so that party declares its side afterwards in its
  // own config file. Minted and re-parsed as a later invocation loads it, this
  // runs a persisted acceptance, not an in-memory edit -- with the invitation's
  // declaration persisted alongside it, still holding the inviting party to
  // what it declared.
  const inviterTerms = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: true,
  });
  const derived = deriveAcceptedLinkageTerms(inviterTerms, "B");
  expect(derived.deduplicate).toBe(false);
  const persisted = parseExchangeSpec(
    parseYaml(
      mintExchangeFile({
        connection: { channel: "filedrop", path: "/mnt/share/drop" },
        linkageTerms: parseLinkageTerms({ ...derived, deduplicate: true }),
        expectedPartnerDeduplicate: inviterTerms.deduplicate,
      }),
    ),
  );
  expect(persisted.linkageTerms.deduplicate).toBe(true);
  expect(persisted.expectedPartnerDeduplicate).toBe(true);

  const acceptorPrepared = prepareForExchange(
    { linkageTerms: persisted.linkageTerms },
    "B",
    mutualRowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate =
    persisted.expectedPartnerDeduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  const [inviter, acceptor] = await Promise.all([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: inviterTerms }, "A", mutualRowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
    runExchange(connAcceptor, "responder", acceptorPrepared, { psiLibrary }),
  ]);

  // The same table the two authored configs produce: the pair is a property of
  // the agreed values, not of how either party reached them.
  expect(inviter.associationTable).toStrictEqual([
    [1, 1, 2, 2, 3],
    [0, 1, 0, 1, 2],
  ]);
  expect(acceptor.associationTable).toStrictEqual([
    [0, 0, 1, 1, 2],
    [1, 2, 1, 2, 3],
  ]);
  expect(inviter.audit?.record.resultSize).toBe(5);
  expect(acceptor.audit?.record.resultSize).toBe(5);
});

test("both parties receive the output the both-sided pair produces", async () => {
  // The grouping a deduplicating match produces exists only in the output, so
  // every deduplicating party must receive it. Under the both-sided pair that is
  // BOTH parties, and no single check holds the rule alone: each party's own
  // schema refines `expects_output` on its own `deduplicate`, and the cross-party
  // output check then forces the partner to share. The two together leave the
  // pair no runnable shape in which either party goes unserved.
  expect(() =>
    parseLinkageTerms({
      ...termsBase,
      identity: "A",
      deduplicate: true,
      output: { expectsOutput: false, shareWithPartner: true },
    }),
  ).toThrow(/expectsOutput must be true when deduplicate is true/);

  // Both deduplicating parties therefore expect output, and a party withholding
  // the result from a partner that expects it is refused at the terms exchange
  // rather than left to hand one party a multiplicity it cannot resolve.
  const withholding = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: true,
    output: { expectsOutput: true, shareWithPartner: false },
  });
  expect(
    validateCompatibility(withholding, withholding).errors.length,
  ).toBeGreaterThan(0);

  // And on the shape that does run, both parties are handed the table the
  // closure resolves.
  const [initiator, responder] = await runBothWithDeduplicate(
    true,
    true,
    "cascade",
    { initiator: mutualRowsA, responder: mutualRowsB },
  );
  expect(fulfilled(initiator).associationTable).toBeDefined();
  expect(fulfilled(responder).associationTable).toBeDefined();
});

test("the same many-to-one pair under single-pass produces the cascade's table", async () => {
  // The two-strategy equivalence at the exchange level: one agreed pair, one set
  // of inputs, two strategies, and the table both parties hold is the same one
  // the cascade run above pinned -- down to the result rows and the attested pair
  // count the downstream code reads off it.
  const [initiator, responder] = await runBothWithDeduplicate(
    true,
    false,
    "single-pass",
  );
  const many = fulfilled(initiator);
  const one = fulfilled(responder);
  expect(many.associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
  expect(one.associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
  expect(
    buildOutputTable(
      one.associationTable!,
      rowsB,
      inferMetadata(["first_name"]),
      one.partnerPayload,
    ).rows,
  ).toStrictEqual([
    ["0", "1"],
    ["0", "2"],
    ["1", "3"],
  ]);
  expect(many.audit?.record.resultSize).toBe(3);
  expect(one.audit?.record.resultSize).toBe(3);
});

test("the mirror orientation runs the same procedure under single-pass", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(
    false,
    true,
    "single-pass",
    { initiator: rowsB, responder: rowsA },
  );
  expect(fulfilled(initiator).associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
  expect(fulfilled(responder).associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
});

test("a partner presenting a deduplicate its invitation did not declare is refused", async () => {
  // The invitation declares `false`, so the consent surface showed no grouping
  // disclosure at all and the acceptance agreed to a one-to-one run. Its author
  // then presents `true` after the connection opens, which would run the pair
  // many-to-one: more of the accepting party's records match, each disclosing
  // its membership. The acceptance retained what the invitation declared, so the
  // run is refused at the terms exchange -- before any key or payload moves.
  const declared = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: false,
  });
  const presented = parseLinkageTerms({
    ...termsBase,
    identity: "Presented Partner Identity",
    deduplicate: true,
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(declared, "B");

  const acceptorPrepared = prepareForExchange(
    { linkageTerms: acceptorTerms },
    "B",
    rowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate = declared.deduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  // The refusal is ONE-SIDED -- only the accepting party holds the declaration --
  // so the two runs are not awaited together: the presenting party is ended by
  // the abort this side sends it (pinned below), not by a refusal it derives.
  const inviterRun = Promise.allSettled([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: presented }, "A", rowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
  ]);

  const reason = await runExchange(
    connAcceptor,
    "responder",
    acceptorPrepared,
    { psiLibrary },
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  expect(reason).toBeInstanceOf(InvitationTermDivergenceError);
  expect(reason?.message).toMatch(/contradict the invitation/);
  // The refusal names the two booleans and no partner-controlled value: the
  // identity the partner authored is the string most likely to be reached for.
  expect(reason?.message).not.toContain("Presented Partner Identity");
  // The advisory tag the CLI's hint-walker reads: this refusal is terminal
  // against the invitation this party holds, so the generic "retry without
  // re-inviting" line would prescribe a retry that repeats the refusal.
  expect(
    (reason as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBe(true);

  await connAcceptor.close();
  const [inviter] = await inviterRun;
  // Neither party reaches a PSI round: the accepting side refuses before the
  // rounds, and the presenting side is left with a failed exchange rather than
  // the many-to-one result it presented for.
  expect(inviter.status).toBe("rejected");
});

test("the one-sided refusal aborts the partner instead of leaving it parked", async () => {
  // Every refusal inside the terms exchange best-effort sends an abort first so
  // the partner is not left on its own receive timeout. This one fires just past
  // that exchange and is one-sided, so nothing else tells an honest partner to
  // stop: without the abort it waits out its whole peer-inactivity budget -- a
  // full poll budget on a file channel -- for rounds this party will never run.
  const declared = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: false,
  });
  const presented = parseLinkageTerms({
    ...termsBase,
    identity: "Presented Partner Identity",
    deduplicate: true,
  });
  const acceptorPrepared = prepareForExchange(
    { linkageTerms: deriveAcceptedLinkageTerms(declared, "B") },
    "B",
    rowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate = declared.deduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  const sentByAcceptor: unknown[] = [];
  const recordingAcceptorConn: MessageConnection = {
    send: async (data) => {
      sentByAcceptor.push(data);
      await connAcceptor.send(data);
    },
    receive: (timeoutMs) => connAcceptor.receive(timeoutMs),
    close: () => connAcceptor.close(),
  };

  const inviterRun = runExchange(
    connInviter,
    "initiator",
    prepareForExchange({ linkageTerms: presented }, "A", rowsA, ["first_name"]),
    { psiLibrary },
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );

  const reason = await runExchange(
    recordingAcceptorConn,
    "responder",
    acceptorPrepared,
    { psiLibrary },
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  expect(reason).toBeInstanceOf(InvitationTermDivergenceError);

  // The abort is the last thing this party sends, and it holds fixed literals
  // only: no terms, no counts, and nothing the partner authored.
  expect(sentByAcceptor.at(-1)).toStrictEqual({
    decision: "abort",
    abortReasons: [
      "partner presented a deduplicate its invitation did not declare",
    ],
  });
  expect(JSON.stringify(sentByAcceptor.at(-1))).not.toContain(
    "Presented Partner Identity",
  );

  // The partner's run ends on its own: the terms exchange's decision slots
  // already sit behind both parties, so nothing on that side reads the refusal
  // reason, and the fault stays only with the refusing party. Its own run ends
  // instead with the PSI library's raw "Type not convertible to a Uint8Array"
  // error, reaching its binary boundary still awaiting the next round, with no
  // psilink framing attached.
  expect(await inviterRun).toBeInstanceOf(Error);
  await connAcceptor.close();
});

test("a run driven from a PERSISTED config refuses the same contradiction", async () => {
  // The recurring case, which the in-memory binding above does not reach: an
  // acceptance writes its config and stops, and the exchange happens at a later
  // invocation that holds no token. The declaration must survive to disk and back
  // for the refusal to fire, so this sources it from a minted exchange file --
  // serialized to snake_case YAML and re-parsed exactly as a later run loads it --
  // rather than setting the field directly.
  const declared = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: false,
  });
  const presented = parseLinkageTerms({
    ...termsBase,
    identity: "Presented Partner Identity",
    deduplicate: true,
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(declared, "B");
  const persisted = parseExchangeSpec(
    parseYaml(
      mintExchangeFile({
        connection: { channel: "filedrop", path: "/mnt/share/drop" },
        linkageTerms: acceptorTerms,
        expectedPartnerDeduplicate: declared.deduplicate,
      }),
    ),
  );
  // The persisted document states this party's OWN deduplicate as the mirror's
  // false and the partner's declaration separately; reading the binding off the
  // former would refuse the legitimate differing pair instead.
  expect(persisted.linkageTerms.deduplicate).toBe(false);
  expect(persisted.expectedPartnerDeduplicate).toBe(false);

  const acceptorPrepared = prepareForExchange(
    { linkageTerms: persisted.linkageTerms },
    "B",
    rowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate =
    persisted.expectedPartnerDeduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  const inviterRun = Promise.allSettled([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: presented }, "A", rowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
  ]);

  const reason = await runExchange(
    connAcceptor,
    "responder",
    acceptorPrepared,
    { psiLibrary },
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  expect(reason).toBeInstanceOf(InvitationTermDivergenceError);
  expect(reason?.message).toMatch(/contradict the invitation/);
  expect(reason?.message).not.toContain("Presented Partner Identity");

  await connAcceptor.close();
  const [inviter] = await inviterRun;
  expect(inviter.status).toBe("rejected");
});

test("the same run proceeds when the presented value is the declared one", async () => {
  // Non-vacuity for the refusal above, and the property the binding must not
  // break: a deduplicating invitation whose author presents what it declared is
  // exactly the accepted many-to-one run.
  const declared = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: true,
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(declared, "B");
  const acceptorPrepared = prepareForExchange(
    { linkageTerms: acceptorTerms },
    "B",
    rowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate = declared.deduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  const [inviter, acceptor] = await Promise.all([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: declared }, "A", rowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
    runExchange(connAcceptor, "responder", acceptorPrepared, { psiLibrary }),
  ]);
  expect(inviter.associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
  expect(acceptor.associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
});

test("a persisted single-pass acceptance runs the deduplicating pair it bound", async () => {
  // Everything an accepted single-pass deduplicating exchange has to clear at
  // once: the strategy verdict at accept, the declaration persisted through a
  // minted exchange file and re-parsed, the terms-exchange binding of the
  // partner's presented value against it, and then the run itself. The table is
  // the one the cascade produces for these files.
  const declared = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: true,
    linkageStrategy: "single-pass",
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(declared, "B");
  const persisted = parseExchangeSpec(
    parseYaml(
      mintExchangeFile({
        connection: { channel: "filedrop", path: "/mnt/share/drop" },
        linkageTerms: acceptorTerms,
        expectedPartnerDeduplicate: declared.deduplicate,
      }),
    ),
  );
  expect(persisted.linkageTerms.linkageStrategy).toBe("single-pass");
  expect(persisted.expectedPartnerDeduplicate).toBe(true);

  const acceptorPrepared = prepareForExchange(
    { linkageTerms: persisted.linkageTerms },
    "B",
    rowsB,
    ["first_name"],
  );
  acceptorPrepared.expectedPartnerDeduplicate =
    persisted.expectedPartnerDeduplicate;

  const [connInviter, connAcceptor] = createMessagePipe();
  const [inviter, acceptor] = await Promise.all([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: declared }, "A", rowsA, [
        "first_name",
      ]),
      { psiLibrary },
    ),
    runExchange(connAcceptor, "responder", acceptorPrepared, { psiLibrary }),
  ]);
  expect(inviter.associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
  expect(acceptor.associationTable).toStrictEqual([
    [0, 0, 1],
    [1, 2, 3],
  ]);
});

test("prepareForExchange prepares a deduplicating term under single-pass", () => {
  // The local prepare step reads this party's own strategy, which is the agreed
  // one, so a combination it accepts here is one the run boundary accepts too.
  const prepared = prepareForExchange(
    {
      linkageTerms: {
        ...termsBase,
        identity: "A",
        deduplicate: true,
        linkageStrategy: "single-pass",
      },
    },
    "A",
    rowsA,
    ["first_name"],
  );
  expect(prepared.linkageTerms.deduplicate).toBe(true);
  expect(prepared.linkageTerms.linkageStrategy).toBe("single-pass");
});

// --- the accepted invitation's other output shape -----------------------------
// An invitation may declare that it receives the result and shares none of it,
// which acceptance mirrors to a party that expects no output. The pair still
// resolves many-to-one, so the grouping runs -- and lands entirely on the
// inviting party, the accepting party being sent no table to read it from. The
// same two files as above, with a column beside the linkage one so what the
// accepting party transmits is observable rather than inferred.
const payloadRowsA: Array<CSVRow> = rowsA.map((row, index) => ({
  ...row,
  note: `a-${index}`,
}));
const payloadRowsB: Array<CSVRow> = rowsB.map((row, index) => ({
  ...row,
  note: `b-${index}`,
}));

async function runAcceptedInvitation(declaredDeduplicate: boolean): Promise<{
  inviter: ExchangeResult;
  acceptor: ExchangeResult;
}> {
  const inviterTerms = parseLinkageTerms({
    ...termsBase,
    identity: "A",
    deduplicate: declaredDeduplicate,
    output: { expectsOutput: true, shareWithPartner: false },
  });
  const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "B");
  const [connInviter, connAcceptor] = createMessagePipe();
  const [inviter, acceptor] = await Promise.all([
    runExchange(
      connInviter,
      "initiator",
      prepareForExchange({ linkageTerms: inviterTerms }, "A", payloadRowsA, [
        "first_name",
        "note",
      ]),
      { psiLibrary },
    ),
    runExchange(
      connAcceptor,
      "responder",
      prepareForExchange({ linkageTerms: acceptorTerms }, "B", payloadRowsB, [
        "first_name",
        "note",
      ]),
      { psiLibrary },
    ),
  ]);
  return { inviter, acceptor };
}

test("a sole-receiver deduplicating invitation hands the accepting party no table", async () => {
  // The enforced half of what the consent surfaces state for this shape: the
  // entitlement gate hands the accepting party no table, so a consent surface
  // telling it what it learns about the inviting party's groups would name a
  // disclosure this client does not make. It is the gate rather than the wire
  // -- the cascade rounds still deliver the grouping to that party's process --
  // which is the limit the sole-receiver statement goes on to name.
  const { inviter, acceptor } = await runAcceptedInvitation(true);
  expect(acceptor.associationTable).toBeUndefined();
  // The run is the deduplicating one all the same: the inviting party's
  // duplicate rows group onto the accepting party's single record.
  expect(inviter.associationTable).toStrictEqual([
    [1, 2, 3],
    [0, 0, 1],
  ]);
});

test("the accepting party's declared setting is false yet more of its records match", async () => {
  // The widening the consent copy states, measured rather than argued: the
  // accepting party's own `deduplicate` is derived false under both runs and its
  // file is byte-identical between them, so every difference here is the
  // inviting party's declaration alone.
  const oneToOne = await runAcceptedInvitation(false);
  const deduplicating = await runAcceptedInvitation(true);

  // Under one-to-one the inviting party's duplicated "Carol" is ambiguous and
  // drops out of the round, so the accepting party's row 0 goes unmatched and
  // its payload row never leaves. Under the deduplicating run that value matches,
  // and the row's membership and payload column go to the inviting party.
  expect(oneToOne.inviter.partnerPayload.rowIndices).toStrictEqual([1]);
  expect(deduplicating.inviter.partnerPayload.rowIndices).toStrictEqual([0, 1]);
  expect(oneToOne.inviter.partnerPayload.rows).toStrictEqual([["b-1"]]);
  expect(deduplicating.inviter.partnerPayload.rows).toStrictEqual([
    ["b-0"],
    ["b-1"],
  ]);

  // Both runs derive the accepting party's own side as false, so the widening is
  // not that party taking the "many" side: its records are never grouped.
  for (const run of [oneToOne, deduplicating])
    expect(run.acceptor.associationTable).toBeUndefined();
});

test("deduplicate: false on both parties runs the exchange to completion", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(false, false);
  // The one-to-one path is untouched: A's duplicated "Carol" is ambiguous and
  // dropped from the round, while the unambiguous "Henry" matches -- so the
  // grouping is what the deduplicating runs above add, not matching at all.
  expect(fulfilled(initiator).associationTable).toStrictEqual([[3], [1]]);
  expect(fulfilled(responder).associationTable).toStrictEqual([[1], [3]]);
});
