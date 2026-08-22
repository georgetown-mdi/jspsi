import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  resolveLinkageCardinality,
  assertDeduplicateImplemented,
  assertMatchedPairsWellFormed,
  matchedPairCount,
  InvitationTermDivergenceError,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  deriveAcceptedLinkageTerms,
  parseLinkageTerms,
} from "../src/config/linkageTerms";
import { inferMetadata } from "../src/config/metadata";
import { buildOutputTable } from "../src/payloadExchange";
import { UsageError } from "../src/errors";

import type { PreparedExchange, ExchangeResult } from "../src/exchange";
import type { LinkageStrategy, LinkageTerms } from "../src/config/linkageTerms";
import type { CSVRow } from "../src/file";

// The cardinality runExchange passes to the linkage strategies is derived from
// the two parties' agreed `deduplicate` settings by resolveLinkageCardinality.
// The cascade runs the one-sided cardinalities; the both-sided pair and any
// deduplicating term under single-pass must be refused BEFORE the PSI rounds with
// the actionable UsageError, never silently collapsed onto one-to-one and never
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
  // procedure they run.
  expect(resolveFor(false, false)).toBe("one-to-one");
  expect(resolveFor(true, false)).toBe("many-to-one");
  expect(resolveFor(false, true)).toBe("one-to-many");
});

test("the both-sided pair is refused, naming many-to-many and the missing closure", () => {
  let thrown: unknown;
  try {
    resolveFor(true, true);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const message = (thrown as Error).message;
  // Names the pair it resolved ...
  expect(message).toMatch(/many-to-many/);
  // ... the step that is actually missing, since the pairing itself is specified ...
  expect(message).toMatch(/transitive closure/);
  // ... and the remedy.
  expect(message).toMatch(/deduplicate to false on one of the two parties/);
  // Not the generic mid-run throw from link.ts.
  expect(message).not.toMatch(/psi for cardinality/);
});

for (const [local, partner] of [
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(
    `a deduplicating term under single-pass (local: ${local}, partner: ` +
      `${partner}) is refused, naming the strategy`,
    () => {
      let thrown: unknown;
      try {
        resolveFor(local, partner, "single-pass");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      const message = (thrown as Error).message;
      expect(message).toMatch(/single-pass/);
      expect(message).toMatch(/linkage_strategy to cascade/);
      expect(message).not.toMatch(/psi for cardinality/);
    },
  );
}

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
  // adopting the inviter's, so the accepted pair is one-sided whatever the
  // invitation declares: the inviter is the "many" side and the acceptor the "one".
  // What that closes is the flip -- an inviter carrying `true` and then presenting
  // `false` at the terms exchange cannot make the acceptor the "many" side,
  // because the acceptor's value was never the invitation's to set.
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

test("assertDeduplicateImplemented refuses only the strategy that cannot match", () => {
  expect(() =>
    assertDeduplicateImplemented(cardinalityTerms(false, "cascade")),
  ).not.toThrow();
  expect(() =>
    assertDeduplicateImplemented(cardinalityTerms(true, "cascade")),
  ).not.toThrow();
  expect(() =>
    assertDeduplicateImplemented(cardinalityTerms(false, "single-pass")),
  ).not.toThrow();
  expect(() =>
    assertDeduplicateImplemented(cardinalityTerms(true, "single-pass")),
  ).toThrow(UsageError);
});

test("acceptance refuses the pair the run refuses, with the run's own message", () => {
  // The derived acceptor value is false whatever the invitation declares, so the
  // pair the exchange boundary refuses is invisible in the DERIVED document: the
  // accept path reads the inviter's terms to catch it. The strategy is a
  // mandatory-consistency term, so the invitation's value is the agreed one and
  // the verdict is readable from the invitation alone.
  let thrown: unknown;
  try {
    deriveAcceptedLinkageTerms(
      cardinalityTerms(true, "single-pass"),
      "Acceptor",
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  // The same refusal the exchange-time path gives, not a second account of it.
  let atExchange: unknown;
  try {
    assertDeduplicateImplemented(cardinalityTerms(true, "single-pass"));
  } catch (err) {
    atExchange = err;
  }
  expect((thrown as Error).message).toBe((atExchange as Error).message);

  // The other three combinations still derive: a cascade invitation either way,
  // and a single-pass invitation that declares no deduplication.
  for (const [deduplicate, strategy] of [
    [false, "cascade"],
    [true, "cascade"],
    [false, "single-pass"],
  ] as Array<[boolean, LinkageStrategy]>) {
    expect(
      deriveAcceptedLinkageTerms(
        cardinalityTerms(deduplicate, strategy),
        "Acceptor",
      ).deduplicate,
    ).toBe(false);
  }
});

// --- the table shapes the consuming seam admits and refuses -------------------
// Everything downstream of the table reads it as matched PAIRS: one payload row
// per distinct matched record, one result row per pair, and the attested result
// size the pair count. Which multiplicities those readings admit follows from the
// cardinality the run resolved, so the seam is given it: a repeated local row is
// the deduplicating shape and is refused under one-to-one, where each of this
// party's records stands in exactly one pair. An out-of-order local half and a
// repeated pair stay refused under every cardinality, neither being a shape any of
// them produces or any consumer could read.

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
  // multiplicity this label carries sits on the partner half.
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
  // One link written twice: the result file would carry the row twice and the
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
  // Its mirror carries the same pair count, which is what makes the two parties'
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

// prepareForExchange refuses a deduplicating term under single-pass itself, so
// build the prepared exchange on the strategy it accepts and overwrite
// afterwards -- the way a caller that skipped prepareForExchange could --
// leaving the run-side resolution as the guard under test.
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

// The refused pairs abort BOTH parties at the post-terms resolution, before any
// PSI frame. Neither side is stranded awaiting a round the other never runs.
test("a both-sided deduplicating pair is refused by both parties before the PSI rounds", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(true, true);
  expectRefusedWith(initiator, /many-to-many/);
  expectRefusedWith(responder, /many-to-many/);
});

test("a deduplicating term under single-pass is refused by both parties before the PSI rounds", async () => {
  const [initiator, responder] = await runBothWithDeduplicate(
    true,
    false,
    "single-pass",
  );
  expectRefusedWith(initiator, /single-pass/);
  expectRefusedWith(responder, /single-pass/);
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
  // so the two runs are not awaited together: the presenting party stays parked
  // on the round that never comes until its connection is closed, which is what
  // a caller does when the run throws.
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

  await connAcceptor.close();
  const [inviter] = await inviterRun;
  // Neither party reaches a PSI round: the accepting side refuses before the
  // rounds, and the presenting side is left with a failed exchange rather than
  // the many-to-one result it presented for.
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

test("prepareForExchange refuses a deduplicating term under single-pass", () => {
  // The local prepare step, before any credential, terms, or data are sent: this
  // party's own strategy is the agreed one, so it does not need the partner's.
  expect(() =>
    prepareForExchange(
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
    ),
  ).toThrow(UsageError);
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
  // entitlement gate hands the accepting party no table, so a surface telling it
  // what it learns about the inviting party's groups would name a disclosure
  // this client does not make. It is the gate rather than the wire -- the
  // cascade rounds carry the grouping to that party's process -- which is the
  // limit the sole-receiver statement goes on to name.
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
