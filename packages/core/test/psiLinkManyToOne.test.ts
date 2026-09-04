import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
  associationAndIterationArray,
  attributableRoundMatches,
  candidatePositionCount,
  groupDuplicatesAndRemoveUndefineds,
  linkViaPSI,
  linkViaSinglePassPSI,
  removeDuplicatesAndUndefineds,
  type LinkageCardinality,
} from "../src/link";
import {
  createMessagePipe,
  receiveParsed,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";
import { singlePassReplyByteCap } from "../src/connection/frameSize";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";
import { fanOutFreeBounds } from "./utils/singlePassBounds";

// Deduplicating matching, driven at the strategy seam: a "many" party keeps a
// value several of its own records hold, contributes it to the round once, and
// attributes a match on it to every record holding it, while its partner's
// within-round uniqueness rule is unchanged (docs/spec/PROTOCOL.md, Deduplicating
// cardinalities). The two parties hold MIRROR labels for the one procedure -- the
// declaring party runs many-to-one and its partner one-to-many -- so every run
// here drives both sides and asserts they reconstruct the same pairing.
//
// The first sections are the cascade's realization, which derives the table from
// the exchanged mapped-element lists; the equivalence section then drives the same
// inputs through single-pass, whose receiver derives it alone from the index
// table, and requires the two to agree table for table.

const psiLibrary = await PSI();

type Keys = Array<Array<string | undefined>>;

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

function cardinalityFor(
  party: "starter" | "joiner",
  manySide: "starter" | "joiner",
): LinkageCardinality {
  return party === manySide ? "many-to-one" : "one-to-many";
}

// Interpose on one party's INBOUND frames, leaving both parties' own behavior
// untouched, so a deviation stands in for a partner that computes the protocol
// honestly right up to the frame under test. Mirrors partnerIndexValidation.ts.
type Deviation = (frame: unknown) => unknown;

function deviatingInbound(
  conn: MessageConnection,
  deviate: Deviation,
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) =>
      deviate(await conn.receive(timeoutMs)),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}

type MappedElement = { theirIndex: number; iteration: number };

const isMappedElementList = (frame: unknown): frame is Array<MappedElement> =>
  Array.isArray(frame) &&
  frame.length > 0 &&
  typeof frame[0] === "object" &&
  frame[0] !== null &&
  !Array.isArray(frame[0]);

// Whichever role a party plays, its first inbound mapped-element list is the
// partner's list of THIS party's records and its second is this party's own list
// come back translated.
function onMappedElementList(
  occurrence: 1 | 2,
  transform: (list: Array<MappedElement>) => unknown,
): Deviation {
  let seen = 0;
  return (frame) => {
    if (!isMappedElementList(frame)) return frame;
    seen += 1;
    return seen === occurrence ? transform(frame) : frame;
  };
}

interface CascadeRun {
  starter: AssociationTable | Error;
  joiner: AssociationTable | Error;
}

async function runCascade(
  manySide: "starter" | "joiner",
  starterKeys: Keys,
  joinerKeys: Keys,
  deviate?: { party: "starter" | "joiner"; deviation: Deviation },
): Promise<CascadeRun> {
  const [starterConn, joinerConn] = createMessagePipe();
  const connFor = (party: "starter" | "joiner", conn: MessageConnection) =>
    deviate?.party === party ? deviatingInbound(conn, deviate.deviation) : conn;

  const settle = (
    run: Promise<AssociationTable>,
  ): Promise<AssociationTable | Error> =>
    run.then(
      (table) => table,
      (err: unknown) => err as Error,
    );

  const starterRun = settle(
    linkViaPSI(
      { cardinality: cardinalityFor("starter", manySide) },
      makeParticipant("starter"),
      connFor("starter", starterConn),
      starterKeys,
      joinerKeys[0].length,
      -1,
    ),
  );
  const joinerRun = settle(
    linkViaPSI(
      { cardinality: cardinalityFor("joiner", manySide) },
      makeParticipant("joiner"),
      connFor("joiner", joinerConn),
      joinerKeys,
      starterKeys[0].length,
      -1,
    ),
  );
  // A party that aborts leaves the other parked on a frame it will never send, so
  // close the pipe once the party under test has settled.
  const first = deviate?.party === "joiner" ? joinerRun : starterRun;
  await first;
  await starterConn.close();
  return { starter: await starterRun, joiner: await joinerRun };
}

function expectTables(run: CascadeRun): [AssociationTable, AssociationTable] {
  expect(run.starter).not.toBeInstanceOf(Error);
  expect(run.joiner).not.toBeInstanceOf(Error);
  return [run.starter as AssociationTable, run.joiner as AssociationTable];
}

// Each party's local half is the other's partner half, pair for pair, once the two
// are read as sets of (starter row, joiner row) pairs. Asserted alongside the
// pinned tables so a change that desyncs the two sides fails even where both
// tables individually look plausible.
function pairsOf(
  table: AssociationTable,
  swap: boolean,
): Array<[number, number]> {
  const pairs = table[0].map((local, i): [number, number] =>
    swap ? [table[1][i], local] : [local, table[1][i]],
  );
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function expectAgreement(
  starter: AssociationTable,
  joiner: AssociationTable,
): void {
  expect(pairsOf(starter, false)).toStrictEqual(pairsOf(joiner, true));
}

// --- the widening itself ------------------------------------------------------

test("a matched value several of the many side's records hold links them all to the one partner record", async () => {
  // The starter deduplicates: its rows 0 and 1 are one entity recorded twice.
  const run = await runCascade(
    "starter",
    [["E1", "E1", "E2", "E3"]],
    [["E1", "E2", "X"]],
  );
  const [starter, joiner] = expectTables(run);

  // Both of the starter's "E1" rows link to the joiner's single "E1" row, where
  // one-to-one would have dropped the value as a within-dataset duplicate.
  expect(starter).toStrictEqual([
    [0, 1, 2],
    [0, 0, 1],
  ]);
  // The "one" side's half repeats its own row 0 instead: several of the partner's
  // records link to it.
  expect(joiner).toStrictEqual([
    [0, 0, 1],
    [0, 1, 2],
  ]);
  expectAgreement(starter, joiner);
});

test("the same widening runs with the roles swapped", async () => {
  // Nothing in the rule is role-derived: the deduplicating party is the joiner
  // here and the pairing is the mirror image of the run above.
  const run = await runCascade(
    "joiner",
    [["E1", "E2", "X"]],
    [["E1", "E1", "E2", "E3"]],
  );
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 0, 1],
    [0, 1, 2],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1, 2],
    [0, 0, 1],
  ]);
  expectAgreement(starter, joiner);
});

test("the one side still excludes its own within-round duplicate values", async () => {
  // The joiner does NOT deduplicate, so its two "D" rows are ambiguous and leave
  // the round -- the many side keeping its own duplicates does not relax that.
  // Its unique "U" still matches, and both of the starter's "U" rows link to it.
  const run = await runCascade("starter", [["D", "U", "U"]], [["D", "D", "U"]]);
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [1, 2],
    [2, 2],
  ]);
  expect(joiner).toStrictEqual([
    [2, 2],
    [1, 2],
  ]);
  expectAgreement(starter, joiner);
});

// --- the expansion ordering ---------------------------------------------------

test("a group expands in ascending record order, groups in the translated list's order", async () => {
  // The ordering decides the table here: the starter's two groups interleave
  // across its rows ("Y" at 0, 2, 4 and "X" at 1, 3), and its first-occurrence set
  // order ("Y" then "X") is the reverse of the joiner's ("X" at row 0, "Y" at row
  // 1). The joiner's returned list therefore arrives grouped by the JOINER's own
  // matched records, not by starter row order; an implementation that expanded in
  // any other order reconstructs a different pairing and fails here.
  const run = await runCascade(
    "starter",
    [["Y", "X", "Y", "X", "Y"]],
    [["X", "Y"]],
  );
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 1, 2, 3, 4],
    [1, 0, 1, 0, 1],
  ]);
  // The joiner's row 0 ("X") takes the starter's rows 1 and 3; its row 1 ("Y")
  // takes 0, 2 and 4. Expanding in ascending position order instead would have
  // given row 0 the starter's rows 0 and 2.
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 1],
    [1, 3, 0, 2, 4],
  ]);
  expectAgreement(starter, joiner);
});

// --- multiplicity is within-round ---------------------------------------------

test("a group forms on one key: a partial duplicate whose keys land in different rounds does not join it", async () => {
  // Starter row 2 shares the joiner row 0's name but holds no SSN, so its only
  // route into the group is the second round -- which the joiner's row has already
  // left, having appeared in round 0's candidate pairs. The cost the spec names
  // plainly: multi-key deduplication groups on one key per group.
  const run = await runCascade(
    "starter",
    [
      ["S1", "S1", undefined],
      ["N1", "N2", "N1"],
    ],
    [["S1"], ["N1"]],
  );
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 1],
    [0, 0],
  ]);
  expect(starter[0]).not.toContain(2);
  expect(joiner).toStrictEqual([
    [0, 0],
    [0, 1],
  ]);
  expectAgreement(starter, joiner);
});

// --- the round's set, and the bounds that rest on it --------------------------

test("the many side contributes each distinct value once", () => {
  const values = ["b", undefined, "a", "b", "", "a", "b"];
  const [data, candidates] = groupDuplicatesAndRemoveUndefineds(values);

  // One entry per distinct value, in first-occurrence order, "" among them.
  expect(data).toStrictEqual(["b", "a", ""]);
  expect(candidatePositionCount(candidates)).toBe(3);
  // Each position stands for its rows, ascending.
  expect(candidates.groupStarts).toStrictEqual([0, 3, 5, 6]);
  expect(candidates.rows).toStrictEqual([0, 3, 6, 2, 5, 4]);

  // The set is bounded by this party's row count exactly as a one-to-one party's
  // is -- which is why the widening moves no derived frame or dataset bound. A
  // one-to-one party's set is a subset of it: the same values, less the ambiguous.
  expect(data.length).toBeLessThanOrEqual(values.length);
  const [singletons] = removeDuplicatesAndUndefineds(values);
  expect(singletons.every((value) => data.includes(value))).toBe(true);
});

test("a carried-forward round maps its groups back to original rows", () => {
  // Later rounds run over the survivors, so the permutation is what puts a group's
  // rows back in the dataset's own numbering -- still ascending.
  const [data, candidates] = groupDuplicatesAndRemoveUndefineds(
    ["x", "y", "x"],
    [4, 7, 9],
  );
  expect(data).toStrictEqual(["x", "y"]);
  expect(candidates.rows).toStrictEqual([4, 9, 7]);
  expect(candidates.groupStarts).toStrictEqual([0, 2, 3]);
});

// --- the single-resolver obligation -------------------------------------------

test("the many side drops a value two or more of the partner's records hold", () => {
  // Where the "one" side does not apply its own uniqueness rule, its duplicate
  // reaches the resolver as one of this party's positions matching two partner
  // positions. The rule is applied on the partner's behalf: the value leaves the
  // round entirely rather than being resolved to either partner record, so the
  // exchange cannot silently deliver many-to-many.
  expect([
    ...attributableRoundMatches([0, 0, 1], [5, 6, 7]).entries(),
  ]).toStrictEqual([[1, 7]]);
  // A round in which every value the partner contributed is its own is untouched.
  expect([
    ...attributableRoundMatches([0, 1, 2], [5, 6, 7]).entries(),
  ]).toStrictEqual([
    [0, 5],
    [1, 6],
    [2, 7],
  ]);
});

test("a partner contributing one value twice is refused by the round's own table check", async () => {
  // The other half of the same obligation, on the path that reaches it first: a
  // round whose association table names one position twice is refused where the
  // table is validated, so a partner that does not deduplicate cannot widen the
  // exchange past the resolver either. Driven on the primitive, since no linkViaPSI
  // cardinality contributes a value twice.
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRound = makeParticipant("starter")
    .identifyIntersection(starterConn, ["V", "V", "W"])
    .then(
      (table) => table,
      (err: unknown) => err,
    );
  const joinerRound = makeParticipant("joiner")
    .identifyIntersection(joinerConn, ["V", "W"])
    .then(
      (table) => table,
      (err: unknown) => err,
    );

  const outcome = await starterRound;
  await starterConn.close();
  const joinerOutcome = await joinerRound;

  expect(outcome).toBeInstanceOf(ConnectionError);
  expect((outcome as ConnectionError).kind).toBe("protocol");
  expect((outcome as Error).message).toMatch(/repeats an index/);
  // The refusal ends the round for BOTH parties: the joiner, which computed the
  // ambiguous table and would otherwise be the one to resolve it, takes no
  // matches from it either.
  expect(joinerOutcome).toBeInstanceOf(Error);
});

// --- the resolver, end to end -------------------------------------------------

// Builds the mapped-element list the starter sends, from the joiner position each
// of the starter's matched records paired with, in its own record order.
type StarterRoundReport = (
  joinerPositions: Array<number>,
) => Array<MappedElement>;

// The joiner's resolver drops a position two or more of the starter's records
// matched, so a starter naming one at all names a record the joiner did not match.
// This is the list a non-conforming starter that had resolved the round the same
// way would send.
const attributableMatches: StarterRoundReport = (joinerPositions) => {
  const timesMatched = new Map<number, number>();
  for (const position of joinerPositions)
    timesMatched.set(position, (timesMatched.get(position) ?? 0) + 1);
  return joinerPositions
    .filter((position) => timesMatched.get(position) === 1)
    .map((position) => ({ theirIndex: position, iteration: 0 }));
};

// A starter that does NOT apply its own within-round uniqueness rule: it
// contributes its whole dataset to the round, duplicates and all, which is the
// variant the joiner's resolver exists for. No cardinality produces such a party,
// so it is played by hand from the PSI primitives -- identifyIntersection's
// starter branch without the association-table check that refuses the ambiguity
// upstream, then the two mapped-element legs a starter sends first.
async function runNonConformingStarter(
  conn: MessageConnection,
  values: Array<string>,
  report: StarterRoundReport = attributableMatches,
): Promise<void> {
  const participant = makeParticipant("starter");
  const { setup, permutation } = await participant.createServerSetup(values);
  await conn.send(setup);
  const request = (await conn.receive()) as Uint8Array;
  await conn.send(await participant.processClientRequest(request));

  // The joiner computes the round's table and sends it as [its own positions,
  // ours in the library's sorted order]; the starter's half of the round is to put
  // ours back in input order and return them.
  const [joinerPositions, sortedRows] = (await conn.receive()) as [
    Array<number>,
    Array<number>,
  ];
  await conn.send(sortedRows.map((slot) => permutation[slot]));
  await conn.receive();

  // A party contributing its dataset verbatim has one round position per record,
  // so its translation of the joiner's list is the identity and its own entries
  // carry the joiner's positions as the round reported them.
  await conn.send(report(joinerPositions));
  const joinerList = (await conn.receive()) as Array<MappedElement>;
  await conn.send(joinerList);
  await conn.receive();
}

async function runAgainstNonConformingStarter(
  starterValues: Array<string>,
  joinerKeys: Keys,
  report?: StarterRoundReport,
): Promise<AssociationTable | Error> {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRun = runNonConformingStarter(
    starterConn,
    starterValues,
    report,
  ).catch(() => undefined);
  const outcome = await linkViaPSI(
    { cardinality: "many-to-one" },
    makeParticipant("joiner"),
    joinerConn,
    joinerKeys,
    starterValues.length,
    -1,
  ).then(
    (table) => table,
    (err: unknown) => err as Error,
  );
  await starterConn.close();
  await starterRun;
  return outcome;
}

test("the joiner drops a value two or more of a non-conforming starter's records hold", async () => {
  // The starter holds "A" twice and keeps both in the round, so the joiner's own
  // "A" position pairs with two of the starter's records. The joiner applies the
  // starter's uniqueness rule on its behalf: the whole "A" group leaves the round
  // -- neither of the joiner's own "A" rows is attributed to either of the
  // starter's -- rather than the exchange delivering the many-to-many table
  // neither party's terms declared. "B" is unambiguous on both sides and matches.
  const outcome = await runAgainstNonConformingStarter(
    ["A", "A", "B"],
    [["A", "A", "B"]],
  );

  expect(outcome).toStrictEqual([[2], [2]]);
});

test("a non-conforming starter naming the dropped group is refused by the joiner", async () => {
  // The consequence of the drop on the wire: a dropped position names no record
  // the joiner matched, so a starter that names it -- one entry, exactly the count
  // the joiner's own attribution leaves it holding -- is refused where the list is
  // translated rather than reinstating the group.
  const outcome = await runAgainstNonConformingStarter(
    ["A", "A", "B"],
    [["A", "A", "B"]],
    (joinerPositions) => {
      const ambiguous = joinerPositions.filter(
        (position, _, all) =>
          all.filter((other) => other === position).length > 1,
      );
      return [{ theirIndex: ambiguous[0], iteration: 0 }];
    },
  );

  expect(outcome).toBeInstanceOf(ConnectionError);
  expect((outcome as ConnectionError).kind).toBe("protocol");
  expect((outcome as Error).message).toMatch(
    /names a record this side did not match on that round/,
  );
});

test("a non-conforming starter reinstating the dropped group is refused on the count", async () => {
  // The same drop seen by the count check: the joiner holds the partner's list to
  // the positions IT attributed, so a starter naming every pair the round produced
  // -- the three its own records matched -- cannot restore the group by volume
  // either.
  const outcome = await runAgainstNonConformingStarter(
    ["A", "A", "B"],
    [["A", "A", "B"]],
    (joinerPositions) =>
      joinerPositions.map((position) => ({
        theirIndex: position,
        iteration: 0,
      })),
  );

  expect(outcome).toBeInstanceOf(ConnectionError);
  expect((outcome as ConnectionError).kind).toBe("protocol");
  expect((outcome as Error).message).toMatch(
    /the partner's mapped-element list has 3 entries, expected 1/,
  );
});

// --- the generalized index checks ---------------------------------------------
// Every one aborts as a classified protocol error with no result. A list reaching
// the "one" side comes from the "many" side (each matched position at least once,
// and no other) and a list reaching the "many" side comes from the "one" side
// (each matched position exactly once). Nothing in the checks is role-derived, so
// the whole block runs under both assignments of the "many" side.

const manyKeys: Keys = [["E1", "E1", "E2", "E3"]];
const oneKeys: Keys = [["E1", "E2", "X"]];

for (const manySide of ["starter", "joiner"] as const) {
  const oneSide = manySide === "starter" ? "joiner" : "starter";
  const [starterKeys, joinerKeys] =
    manySide === "starter" ? [manyKeys, oneKeys] : [oneKeys, manyKeys];
  const under = ` (many side: ${manySide})`;

  const expectProtocolRefusal = async (
    party: "starter" | "joiner",
    deviation: Deviation,
    detail: RegExp,
  ): Promise<void> => {
    const run = await runCascade(manySide, starterKeys, joinerKeys, {
      party,
      deviation,
    });
    const outcome = run[party];
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as ConnectionError).kind).toBe("protocol");
    expect((outcome as Error).message).toMatch(detail);
  };

  test(
    "a list from the many side naming a position this party did not match is " +
      `refused${under}`,
    async () => {
      await expectProtocolRefusal(
        oneSide,
        onMappedElementList(1, (list) => [
          ...list.slice(0, -1),
          { ...list[list.length - 1], theirIndex: 2 },
        ]),
        /names a record this side did not match on that round/,
      );
    },
  );

  test(
    "a list from the many side that leaves a matched position unnamed is " +
      `refused${under}`,
    async () => {
      await expectProtocolRefusal(
        oneSide,
        onMappedElementList(1, (list) => list.slice(0, -1)),
        /does not name every record this side matched/,
      );
    },
  );

  test(
    "a list from the many side longer than the partner's counted rows is " +
      `refused${under}`,
    async () => {
      await expectProtocolRefusal(
        oneSide,
        onMappedElementList(1, (list) => [...list, list[0], list[0]]),
        /more than the 4 record\(s\) the partner counted/,
      );
    },
  );

  test(`a list from the one side naming a position twice is refused${under}`, async () => {
    await expectProtocolRefusal(
      manySide,
      onMappedElementList(1, (list) => [list[0], list[0]]),
      /names one record twice/,
    );
  });

  test(`a returned list carrying other than the computed entry count is refused${under}`, async () => {
    // The many side's own list comes back one entry per record it matched...
    await expectProtocolRefusal(
      manySide,
      onMappedElementList(2, (list) => list.slice(0, -1)),
      /the returned mapped-element list has 2 entries, expected 3/,
    );
    // ...and the one side's comes back EXPANDED, to the count its partner's
    // inbound list already implied.
    await expectProtocolRefusal(
      oneSide,
      onMappedElementList(2, (list) => list.slice(0, -1)),
      /the returned mapped-element list has 2 entries, expected 3/,
    );
  });

  test(`a returned list merging two of the many side's groups is refused${under}`, async () => {
    // The many side's own list comes back with each entry translated into a
    // partner row, and which of its records share a row is ITS grouping, not the
    // returning party's to decide. A "one" partner naming one row for every entry
    // merges the two groups this side sent -- rows 0 and 1 matched one position,
    // row 2 another -- which flat distinctness cannot catch on the side where a
    // repeat is admitted.
    await expectProtocolRefusal(
      manySide,
      onMappedElementList(2, (list) =>
        list.map((entry) => ({ ...entry, theirIndex: list[0].theirIndex })),
      ),
      /names one partner row for two positions this side matched/,
    );
  });

  test(`a returned list splitting one of the many side's groups is refused${under}`, async () => {
    // The mirror deviation: the two entries that named ONE position come back
    // carrying different partner rows, so the partner splits a group this side's
    // own data formed. Every entry stays in range and the count is untouched.
    await expectProtocolRefusal(
      manySide,
      onMappedElementList(2, (list) => [
        list[0],
        { ...list[1], theirIndex: list[2].theirIndex },
        ...list.slice(2),
      ]),
      /names two partner rows for one position this side matched/,
    );
  });

  test(`a returned list repeating a partner row is refused on the one side${under}`, async () => {
    // Distinctness is relaxed only where THIS party is the "many" side, several of
    // its records legitimately naming one partner row. The "one" side's own records
    // each take a distinct partner row, so a repeat there is still a fault.
    await expectProtocolRefusal(
      oneSide,
      onMappedElementList(2, (list) => [
        list[0],
        { ...list[1], theirIndex: list[0].theirIndex },
        ...list.slice(2),
      ]),
      /repeats an index/,
    );
  });
}

// --- the same labels under single-pass ----------------------------------------
// Single-pass matches the same deduplicating cardinalities, over the frames it
// already ships: the index table names which of a party's records hold one value
// whatever the cardinality, so the widening is two clauses of the receiver's local
// replay. The strategies must therefore agree table for table, which is what the
// equivalence block below drives; `many-to-many` is refused by single-pass alone
// (psiLink.test.ts pins the divergence).

const singlePassStarterData = [["E1", "E1", "E2", "E3"]];
const singlePassJoinerData = [["E1", "E2", "X"]];

async function runSinglePass(
  cardinality: LinkageCardinality,
  starterKeys: Keys = singlePassStarterData,
  joinerKeys: Keys = singlePassJoinerData,
): Promise<[AssociationTable, AssociationTable]> {
  const [starterConn, joinerConn] = createMessagePipe();
  return await Promise.all([
    linkViaSinglePassPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      fanOutFreeBounds(starterKeys.length, joinerKeys[0].length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: mirrorCardinality(cardinality) },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, starterKeys[0].length),
      false,
      -1,
    ),
  ]);
}

function mirrorCardinality(
  cardinality: LinkageCardinality,
): LinkageCardinality {
  if (cardinality === "many-to-one") return "one-to-many";
  if (cardinality === "one-to-many") return "many-to-one";
  return cardinality;
}

test("single-pass runs one-to-one, dropping the value a group would have kept", async () => {
  const [starter, joiner] = await runSinglePass("one-to-one");
  // The starter's duplicated "E1" is dropped as ambiguous rather than kept and
  // expanded onto both of its rows, which is what many-to-one makes of this same
  // data in the first test of this file and in the equivalence block below.
  expect(starter).toStrictEqual([[2], [1]]);
  expect(joiner).toStrictEqual([[1], [2]]);
});

test("single-pass refuses many-to-many", async () => {
  // Refused before any frame moves, so the unread other end of the pipe is not a
  // partner this ever reaches -- and refused for this strategy's own reason: its
  // seam pins the resolved table's length to the half that keeps its distinctness,
  // and a both-sided multiplicity leaves neither half distinct.
  const [conn] = createMessagePipe();
  await expect(
    linkViaSinglePassPSI(
      { cardinality: "many-to-many" },
      makeParticipant("starter"),
      conn,
      singlePassStarterData,
      fanOutFreeBounds(
        singlePassStarterData.length,
        singlePassJoinerData[0].length,
      ),
      false,
      -1,
    ),
  ).rejects.toThrow("psi for cardinality 'many-to-many' not yet implemented");
});

// --- the two strategies agree, table for table --------------------------------
// The equivalence property the cascade and single-pass hold under `one-to-one`
// (psiLink.test.ts), extended to the cardinality where multiplicity governs the
// outcome. Every case below is a dataset whose table DIFFERS from the one-to-one
// table for the same inputs, so a replay that quietly matched one-to-one under a
// deduplicating label would fail here rather than pass vacuously.

async function expectStrategiesAgree(
  manySide: "starter" | "joiner",
  starterKeys: Keys,
  joinerKeys: Keys,
): Promise<[AssociationTable, AssociationTable]> {
  const [cascadeStarter, cascadeJoiner] = expectTables(
    await runCascade(manySide, starterKeys, joinerKeys),
  );
  const [singlePassStarter, singlePassJoiner] = await runSinglePass(
    cardinalityFor("starter", manySide),
    starterKeys,
    joinerKeys,
  );
  expect(singlePassStarter).toStrictEqual(cascadeStarter);
  expect(singlePassJoiner).toStrictEqual(cascadeJoiner);
  expectAgreement(singlePassStarter, singlePassJoiner);
  // Non-vacuity: the same inputs matched one-to-one produce a different table, so
  // each case is one the multiplicity decides.
  const [oneToOneStarter] = await runSinglePass(
    "one-to-one",
    starterKeys,
    joinerKeys,
  );
  expect(oneToOneStarter).not.toStrictEqual(singlePassStarter);
  return [singlePassStarter, singlePassJoiner];
}

test("single-pass links a kept value to every record of the group holding it", async () => {
  const [starter, joiner] = await expectStrategiesAgree(
    "starter",
    [["E1", "E1", "E2", "E3"]],
    [["E1", "E2", "X"]],
  );
  expect(starter).toStrictEqual([
    [0, 1, 2],
    [0, 0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1],
    [0, 1, 2],
  ]);
});

test("single-pass runs the widening from either side", async () => {
  // Nothing in the replay is role-derived either: the deduplicating party is the
  // PSI receiver here rather than the sender, which is the other of the two
  // arrangements a single-pass exchange can put a "many" side in.
  const [starter, joiner] = await expectStrategiesAgree(
    "joiner",
    [["E1", "E2", "X"]],
    [["E1", "E1", "E2", "E3"]],
  );
  expect(starter).toStrictEqual([
    [0, 0, 1],
    [0, 1, 2],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1, 2],
    [0, 0, 1],
  ]);
});

test("single-pass keeps the one side's own uniqueness rule", async () => {
  // The many side keeping its duplicates does not relax the other side's rule:
  // the joiner's two "D" rows are ambiguous and leave the round, while both of the
  // starter's "U" rows link to the joiner's single "U".
  const [starter] = await expectStrategiesAgree(
    "starter",
    [["D", "U", "U"]],
    [["D", "D", "U"]],
  );
  expect(starter).toStrictEqual([
    [1, 2],
    [2, 2],
  ]);
});

test("single-pass groups on one key, the round the group formed in", async () => {
  // Multiplicity is within-round on both sides: the starter's row 2 shares the
  // joiner row 0's name but holds no SSN, and the joiner's row has left candidacy
  // on the first round, so the second cannot add row 2 to the group.
  const [starter] = await expectStrategiesAgree(
    "starter",
    [
      ["S1", "S1", undefined],
      ["N1", "N2", "N1"],
    ],
    [["S1"], ["N1"]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 0],
  ]);
});

test("single-pass reproduces the expansion ordering across interleaved groups", async () => {
  // The case that decides the ordering in the cascade, where the two parties'
  // set orders are reverses of each other. Single-pass reconstructs the pairing
  // from the index table rather than from an exchanged list, so agreeing here is
  // what says the two derivations of the same table coincide.
  const [starter, joiner] = await expectStrategiesAgree(
    "starter",
    [["Y", "X", "Y", "X", "Y"]],
    [["X", "Y"]],
  );
  expect(starter).toStrictEqual([
    [0, 1, 2, 3, 4],
    [1, 0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 1],
    [1, 3, 0, 2, 4],
  ]);
});

test("single-pass carries the survivor-relative rule into a group", async () => {
  // Candidacy, not the whole dataset, decides what is ambiguous, and the two
  // rules meet here. The joiner's "Z" sits on rows 0 and 1, so the whole dataset
  // makes it ambiguous; row 0 matches on key 0 and leaves, which leaves "Z"
  // unique among key 1's survivors. Both of the starter's "Z" rows then group
  // onto the joiner's row 1 -- a match a full-dataset reading of uniqueness
  // would have dropped on the one side and the one-to-one rule drops on the many.
  const [starter, joiner] = await expectStrategiesAgree(
    "starter",
    [
      ["A", undefined, undefined],
      [undefined, "Z", "Z"],
    ],
    [
      ["A", "X", "Y"],
      ["Z", "Z", "Q"],
    ],
  );
  expect(starter).toStrictEqual([
    [0, 1, 2],
    [0, 1, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1, 1],
    [0, 1, 2],
  ]);
});

test("a group in a later round forms from the deduplicating sender's survivors alone", async () => {
  // The mirror of the case above, on the side that ships the index table: the
  // starter is the PSI sender as well as the "many" side, so the replay resolves
  // its rounds without asking its side anything, and candidacy is the whole of
  // what keeps a matched row out of a later round's group.
  //
  // The starter's rows 0 and 1 are one entity on "S1" and pair with the joiner's
  // row 0 in round 0, leaving candidacy. All four of its rows hold "N1", so a
  // sweep reading past candidacy would group all four onto the joiner's row 1;
  // the two survivors alone form that group.
  const [starter, joiner] = await expectStrategiesAgree(
    "starter",
    [
      ["S1", "S1", undefined, undefined],
      ["N1", "N1", "N1", "N1"],
    ],
    [
      ["S1", "X"],
      ["Q", "N1"],
    ],
  );
  expect(starter).toStrictEqual([
    [0, 1, 2, 3],
    [0, 0, 1, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1],
    [0, 1, 2, 3],
  ]);
});

// --- the single-pass bounds under multiplicity --------------------------------
// Every single-pass bound rests on the premise that a party's (key, record) cell
// count upper-bounds its distinct-value count. A deduplicating party contributes
// each DISTINCT value once, so duplication can only lower that count -- which the
// note behind the specification claims and this measures, by driving the real
// strategy and reading the reply frame it actually builds against the cap both
// parties derive from their declared sizes. Every fixture here fills every cell,
// so the sender's own slot-bound check (built slots against declared width) is
// exercised at its limit rather than under it.

async function singlePassReplyBytes(
  cardinality: LinkageCardinality,
  starterKeys: Keys,
  joinerKeys: Keys,
): Promise<number> {
  const [starterConn, joinerConn] = createMessagePipe();
  let replyBytes = 0;
  const measuringJoinerConn: MessageConnection = {
    send: (data) => joinerConn.send(data),
    receive: async (timeoutMs?: number) => {
      const frame = await joinerConn.receive(timeoutMs);
      if (frame instanceof Uint8Array) replyBytes = frame.byteLength;
      return frame;
    },
    close: () => joinerConn.close(),
    setInboundFrameCap: joinerConn.setInboundFrameCap?.bind(joinerConn),
  };
  await Promise.all([
    linkViaSinglePassPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      fanOutFreeBounds(starterKeys.length, joinerKeys[0].length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: mirrorCardinality(cardinality) },
      makeParticipant("joiner"),
      measuringJoinerConn,
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, starterKeys[0].length),
      false,
      -1,
    ),
  ]);
  return replyBytes;
}

test("a deduplicating sender's reply stays within the cap its declared size derives", async () => {
  const joinerKeys: Keys = [["E1", "E2", "X"]];
  // Same shape either way -- one key over four filled rows -- so the two parties'
  // declared sizes, and every bound derived from them, are the same pair.
  const duplicated: Keys = [["E1", "E1", "E1", "E2"]];
  const distinct: Keys = [["E1", "E2", "E3", "E4"]];
  const cap = singlePassReplyByteCap(
    1,
    { effectiveKeyCount: 1, recordCount: 4 },
    { effectiveKeyCount: 1, recordCount: 3 },
  );

  const duplicatedBytes = await singlePassReplyBytes(
    "many-to-one",
    duplicated,
    joinerKeys,
  );
  const distinctBytes = await singlePassReplyBytes(
    "one-to-one",
    distinct,
    joinerKeys,
  );
  expect(duplicatedBytes).toBeLessThanOrEqual(cap);
  expect(distinctBytes).toBeLessThanOrEqual(cap);
  // The deduplicating reply is the SMALLER of the two: its index table is the
  // same one word per (key, record), and its setup carries two masked values
  // where the distinct-valued one carries four.
  expect(duplicatedBytes).toBeLessThan(distinctBytes);
});

// --- the grouping is snapshotted before the send ------------------------------
// The grouping the returned list is held to is copied out of the "many" side's own
// outbound list BEFORE that list is sent. What makes the ordering load-bearing
// rather than incidental is a transport that hands the partner the array itself
// rather than a serialization of it: the partner's translation writes each entry's
// index IN PLACE, over the sender's own entries, so a grouping read after the send
// is the returned list compared against itself and the merge the check exists to
// refuse passes. The merge deviations in the block above build fresh entries and
// leave the sent list intact, which is the other half of the same wire fault.

test("the pipe hands the partner the sent mapped elements themselves", async () => {
  // The premise the deviation below rests on, as a check rather than a claim: the
  // in-memory pipe passes the array by reference and the wire schema validates it
  // where it lies rather than rebuilding it, so a partner writing over a received
  // entry writes over the sender's.
  const [sender, receiver] = createMessagePipe();
  const sent = [{ theirIndex: 3, iteration: 0 }];
  await sender.send(sent);
  const received = await receiveParsed(receiver, associationAndIterationArray);
  expect(received[0]).toBe(sent[0]);
});

for (const manySide of ["starter", "joiner"] as const) {
  const [starterKeys, joinerKeys] =
    manySide === "starter" ? [manyKeys, oneKeys] : [oneKeys, manyKeys];

  test(
    "a returned list merging the many side's groups IN PLACE is refused " +
      `(many side: ${manySide})`,
    async () => {
      const run = await runCascade(manySide, starterKeys, joinerKeys, {
        party: manySide,
        deviation: onMappedElementList(2, (list) => {
          const merged = list[0].theirIndex;
          for (const entry of list) entry.theirIndex = merged;
          return list;
        }),
      });
      const outcome = run[manySide];
      expect(outcome).toBeInstanceOf(ConnectionError);
      expect((outcome as ConnectionError).kind).toBe("protocol");
      expect((outcome as Error).message).toMatch(
        /names one partner row for two positions this side matched/,
      );
    },
  );
}

// --- the dropped group's later-key eligibility --------------------------------
// A group the single-resolver rule drops is attributed nothing, so its rows are
// still candidates on the next key -- the one carve-out from a record leaving
// candidacy once it appears in a round's candidate pairs. Only a partner that does
// not deduplicate produces the drop, so the harness plays the same one the single
// round above does, over two keys: it contributes each column verbatim, one round
// position per record, so its translation of the joiner's list stays the identity.

// One PSI round of that starter, returning the joiner positions the round paired
// it with -- the round's own view of the ambiguity, before the joiner resolves it.
async function runNonConformingStarterRound(
  participant: PSIParticipant,
  conn: MessageConnection,
  values: Array<string>,
): Promise<Array<number>> {
  const { setup, permutation } = await participant.createServerSetup(values);
  await conn.send(setup);
  const request = (await conn.receive()) as Uint8Array;
  await conn.send(await participant.processClientRequest(request));
  const [joinerPositions, sortedRows] = (await conn.receive()) as [
    Array<number>,
    Array<number>,
  ];
  await conn.send(sortedRows.map((slot) => permutation[slot]));
  await conn.receive();
  return joinerPositions;
}

interface MultiKeyRun {
  outcome: AssociationTable | Error;
  // Each round's joiner positions, as that round paired them.
  positionsByRound: Array<Array<number>>;
  // The key round each of the joiner's own matched records was attributed on, in
  // the order the joiner sent them -- its row order.
  roundsSent: Array<number>;
}

async function runManyKeysAgainstNonConformingStarter(
  starterColumns: Array<Array<string>>,
  joinerKeys: Keys,
): Promise<MultiKeyRun> {
  const [starterConn, joinerConn] = createMessagePipe();
  const positionsByRound: Array<Array<number>> = [];
  const roundsSent: Array<number> = [];

  const starterRun = (async () => {
    const participant = makeParticipant("starter");
    for (const values of starterColumns)
      positionsByRound.push(
        await runNonConformingStarterRound(participant, starterConn, values),
      );
    // Its own matched records: one entry per (round, joiner position) the round
    // paired it with exactly once, which is what the joiner's resolver keeps.
    await starterConn.send(
      positionsByRound.flatMap((positions, iteration) =>
        attributableMatches(positions).map((entry) => ({
          ...entry,
          iteration,
        })),
      ),
    );
    const joinerList = (await starterConn.receive()) as Array<MappedElement>;
    for (const entry of joinerList) roundsSent.push(entry.iteration);
    await starterConn.send(joinerList);
    await starterConn.receive();
  })().catch(() => undefined);

  const outcome = await linkViaPSI(
    { cardinality: "many-to-one" },
    makeParticipant("joiner"),
    joinerConn,
    joinerKeys,
    starterColumns[0].length,
    -1,
  ).then(
    (table) => table,
    (err: unknown) => err as Error,
  );
  await starterConn.close();
  await starterRun;
  return { outcome, positionsByRound, roundsSent };
}

test("rows of a group the resolver dropped stay eligible for a later key", async () => {
  const run = await runManyKeysAgainstNonConformingStarter(
    [
      ["A", "A", "B"],
      ["Q", "P", "S"],
    ],
    [
      ["A", "A", "B"],
      ["P", "Q", "Z"],
    ],
  );

  // Key 0 paired the joiner's one "A" position with two of the starter's records,
  // which is the drop: the joiner's rows 0 and 1 are attributed nothing there. A
  // single-key run of this same data leaves them unmatched altogether ("the joiner
  // drops a value two or more of a non-conforming starter's records hold").
  expect([...run.positionsByRound[0]].sort((a, b) => a - b)).toStrictEqual([
    0, 0, 1,
  ]);
  // Both take a key-1 match instead, while row 2 -- matched on key 0 -- left
  // candidacy with that match and is not re-matched.
  expect(run.roundsSent).toStrictEqual([1, 1, 0]);
  // The partner half is the pairing only key 1 produces: the starter holds "P" at
  // its row 1 and "Q" at its row 0, crossing the row order key 0's "A" group would
  // have given them.
  expect(run.outcome).toStrictEqual([
    [0, 1, 2],
    [1, 0, 2],
  ]);
});
