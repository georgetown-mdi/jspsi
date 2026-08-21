import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
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
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";
import { fanOutFreeBounds } from "./utils/singlePassBounds";

// The cascade's deduplicating half: a "many" party keeps a value several of its
// own records hold, contributes it to the round once, and re-expands a match on it
// onto every record holding it, while its partner's within-round uniqueness rule
// is unchanged (docs/spec/PROTOCOL.md, Deduplicating cardinalities). The two
// parties hold MIRROR labels for the one procedure -- the declaring party runs
// many-to-one and its partner one-to-many -- so every run here drives both sides
// and asserts they reconstruct the same pairing.
//
// This path is dark in production: exchange.ts still refuses any deduplicate: true
// at the exchange boundary, so only these tests and a direct linkViaPSI caller
// reach it. The other strategy reads the same labels differently -- single-pass
// implements no deduplicating match at all -- which the last section pins.

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
    /the partner's mapped-element list carries 3 entries, expected 1/,
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
      /the returned mapped-element list carries 2 entries, expected 3/,
    );
    // ...and the one side's comes back EXPANDED, to the count its partner's
    // inbound list already implied.
    await expectProtocolRefusal(
      oneSide,
      onMappedElementList(2, (list) => list.slice(0, -1)),
      /the returned mapped-element list carries 2 entries, expected 3/,
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
// Single-pass implements no deduplicating match: it refuses one-to-many and
// many-to-many outright, and accepts many-to-one as an alias that runs the
// unchanged one-to-one matching. Both halves of that accept-list are pinned here,
// so lifting the exchange-boundary refusal without teaching single-pass the
// cardinality trips a test rather than silently matching one-to-one under a
// consented many-cardinality term.

const singlePassStarterData = [["E1", "E1", "E2", "E3"]];
const singlePassJoinerData = [["E1", "E2", "X"]];

async function runSinglePass(
  cardinality: LinkageCardinality,
): Promise<[AssociationTable, AssociationTable]> {
  const [starterConn, joinerConn] = createMessagePipe();
  return await Promise.all([
    linkViaSinglePassPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      singlePassStarterData,
      fanOutFreeBounds(
        singlePassStarterData.length,
        singlePassJoinerData[0].length,
      ),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality },
      makeParticipant("joiner"),
      joinerConn,
      singlePassJoinerData,
      fanOutFreeBounds(
        singlePassJoinerData.length,
        singlePassStarterData[0].length,
      ),
      false,
      -1,
    ),
  ]);
}

test("single-pass runs many-to-one as an alias for one-to-one", async () => {
  const [oneToOneStarter, oneToOneJoiner] = await runSinglePass("one-to-one");
  const [starter, joiner] = await runSinglePass("many-to-one");

  // Table for table with the one-to-one run on the same inputs: the starter's
  // duplicated "E1" is dropped as ambiguous rather than kept and expanded onto
  // both of its rows, which is what the cascade's many-to-one makes of this same
  // data in the first test of this file.
  expect(starter).toStrictEqual(oneToOneStarter);
  expect(joiner).toStrictEqual(oneToOneJoiner);
  expect(starter).toStrictEqual([[2], [1]]);
});

for (const cardinality of ["one-to-many", "many-to-many"] as const) {
  test(`single-pass refuses ${cardinality}`, async () => {
    // Refused before any frame moves, so the unread other end of the pipe is not a
    // partner this ever reaches.
    const [conn] = createMessagePipe();
    await expect(
      linkViaSinglePassPSI(
        { cardinality },
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
    ).rejects.toThrow(
      `psi for cardinality '${cardinality}' not yet implemented`,
    );
  });
}
