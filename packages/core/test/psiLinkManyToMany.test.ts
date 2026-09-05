import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { entityClusters } from "../src/entityClosure";
import { matchedPairCount } from "../src/exchange";
import { buildOutputTable, preparePayload } from "../src/payloadExchange";
import type { Metadata } from "../src/config/metadata";
import type { CSVRow } from "../src/file";
import type { AssociationTable } from "../src/types";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// Both-sided deduplicating matching at the cascade boundary: each party keeps a
// value several of its own records hold, contributes it once, and attributes a
// match on it to every record holding it -- the "many" rule applied to both
// parties (docs/spec/PROTOCOL.md, The per-side rules). A matched value stands
// for a GROUP on each side and contributes the two groups' product; every run
// here drives both parties and checks they reconstruct the same pair set.
//
// `many-to-many` is its own mirror, so both parties hold the one label. An
// exchange resolves it from the agreed pair (`resolveLinkageCardinality`) and
// the runs it produces are driven in linkageCardinality.test.ts; every case
// here calls linkViaPSI directly, which is what lets a partner's frames deviate
// at the boundary under test.

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

// Interpose on one party's INBOUND frames, leaving both parties' own behavior
// untouched, so a deviation stands in for a partner that computes the protocol
// correctly right up to the frame under test. Mirrors psiLinkManyToOne.test.ts.
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
// come back translated -- as runs, one per record this party matched.
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
      { cardinality: "many-to-many" },
      makeParticipant("starter"),
      connFor("starter", starterConn),
      starterKeys,
      joinerKeys[0].length,
      -1,
    ),
  );
  const joinerRun = settle(
    linkViaPSI(
      { cardinality: "many-to-many" },
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
// are read as sets of (starter row, joiner row) pairs.
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

// --- the block a matched value forms -----------------------------------------

test("a value both sides hold twice links every one of its records to every one of the partner's", async () => {
  // The whole of the widening: "E1" stands for a group of two on each side, so the
  // round contributes the 2x2 block of pairs between them rather than the one pair
  // one-to-one would take or the two a one-sided cardinality would.
  const run = await runCascade([["E1", "E1", "E2"]], [["E1", "E1", "E2"]]);
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 0, 1, 1, 2],
    [0, 1, 0, 1, 2],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 2],
    [0, 1, 0, 1, 2],
  ]);
  expectAgreement(starter, joiner);
});

test("groups of different sizes contribute their product", async () => {
  // The block is |group| x |partner group|, not the larger or the sum of the two:
  // two starter records and three joiner records on one value make six pairs, and
  // each party's own half repeats its rows the other's group size many times.
  const run = await runCascade([["E1", "E1", "E2"]], [["E1", "E1", "E1"]]);
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 0, 0, 1, 1, 1],
    [0, 1, 2, 0, 1, 2],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 2, 2],
    [0, 1, 0, 1, 0, 1],
  ]);
  expectAgreement(starter, joiner);
});

test("the same block forms with the roles swapped", async () => {
  // Nothing in the rule is role-derived: the two datasets above change hands and
  // the pairing is the mirror image, each party's table the other's transposed.
  const run = await runCascade([["E1", "E1", "E1"]], [["E1", "E1", "E2"]]);
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 0, 1, 1, 2, 2],
    [0, 1, 0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 0, 1, 1, 1],
    [0, 1, 2, 0, 1, 2],
  ]);
  expectAgreement(starter, joiner);
});

// --- multiplicity is still within-round ---------------------------------------

test("two keys form two blocks, and no pair crosses them", async () => {
  // Each round's block stands alone: rows 0 and 1 pair off on key 0 and leave
  // candidacy, rows 2 and 3 pair off on key 1. A table that linked the two blocks
  // -- the cross-round accumulation the within-round rule does not take
  // (docs/spec/PROTOCOL.md, Multiplicity is within-round) -- would hold pairs
  // between {0,1} and {2,3}, and none is here.
  const run = await runCascade(
    [
      ["A", "A", undefined, undefined],
      [undefined, undefined, "B", "B"],
    ],
    [
      ["A", "A", undefined, undefined],
      [undefined, undefined, "B", "B"],
    ],
  );
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([
    [0, 0, 1, 1, 2, 2, 3, 3],
    [0, 1, 0, 1, 2, 3, 2, 3],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 2, 2, 3, 3],
    [0, 1, 0, 1, 2, 3, 2, 3],
  ]);
  const crosses = ([local, partner]: [number, number]): boolean =>
    local < 2 !== partner < 2;
  expect(pairsOf(starter, false).filter(crosses)).toStrictEqual([]);
  expectAgreement(starter, joiner);
});

test("a partner record that matched on an earlier key does not join a later key's group", async () => {
  // The chain that does not form: the starter's row 1 shares "N1" with the joiner's
  // row 0, but that row appeared in key 0's candidate pairs and has left candidacy,
  // so key 1 has nothing on the joiner's side to match. Both parties are
  // deduplicating and it makes no difference -- the rule is candidacy, not
  // uniqueness.
  const run = await runCascade(
    [
      ["S1", undefined],
      ["N1", "N1"],
    ],
    [["S1"], ["N1"]],
  );
  const [starter, joiner] = expectTables(run);

  expect(starter).toStrictEqual([[0], [0]]);
  expect(starter[0]).not.toContain(1);
  expect(joiner).toStrictEqual([[0], [0]]);
  expectAgreement(starter, joiner);
});

// --- the expansion ordering ---------------------------------------------------

test("each group expands in ascending record order, groups in the translated list's order", async () => {
  // The ordering decides the table here, and on both sides at once: each party's
  // two groups interleave across its own rows, and their first-occurrence set
  // orders are reverses of each other ("Y" then "X" for the starter, "X" then "Y"
  // for the joiner). Each party's returned list therefore arrives grouped by the
  // PARTNER's matched records; an implementation that expanded in any other order
  // reconstructs a different pairing and fails here.
  const run = await runCascade([["Y", "X", "Y", "X"]], [["X", "Y", "X"]]);
  const [starter, joiner] = expectTables(run);

  // The starter's "Y" rows (0 and 2) take the joiner's single "Y" row 1; its "X"
  // rows (1 and 3) take the joiner's "X" rows 0 and 2, ascending.
  expect(starter).toStrictEqual([
    [0, 1, 1, 2, 3, 3],
    [1, 0, 2, 1, 0, 2],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1, 1, 2, 2],
    [1, 3, 0, 2, 1, 3],
  ]);
  expectAgreement(starter, joiner);
});

// --- the entity closure --------------------------------------------------------
// The step that makes a both-sided table mean something: each party resolves its
// own copy into entity clusters, locally and with no further frame
// (docs/spec/PROTOCOL.md, The many-to-many entity closure). The tables here are the
// ones real runs produce; entityClosure.test.ts drives the block check on
// hand-built tables, where it can be shown to refuse.

interface CrossPartyCluster {
  starterRows: ReadonlyArray<number>;
  joinerRows: ReadonlyArray<number>;
}

// One party's clusters read in the shared (starter rows, joiner rows) frame, so
// the two parties' answers compare term for term. Each party orders its own
// clusters by its own lowest row, so the joiner's order is re-taken here rather
// than assumed to coincide.
function crossPartyClusters(
  table: AssociationTable,
  swap: boolean,
): Array<CrossPartyCluster> {
  return entityClusters(table)
    .map((cluster) =>
      swap
        ? { starterRows: cluster.partnerRows, joinerRows: cluster.localRows }
        : { starterRows: cluster.localRows, joinerRows: cluster.partnerRows },
    )
    .sort((a, b) => a.starterRows[0] - b.starterRows[0]);
}

test("a chain across two keys never forms, and both parties cluster the same way", async () => {
  // The chain the closure could otherwise form: the starter's row 0 and the
  // joiner's row 0 share "K1" on the first key, and the joiner's row 0 shares
  // "K2" with the starter's row 1 on the second. It does not form, since the
  // joiner's row 0 already left candidacy in the first round's pairs -- so the
  // starter's row 1 takes the joiner's row 1 instead, and the two clusters stay
  // apart.
  const run = await runCascade(
    [
      ["K1", undefined],
      [undefined, "K2"],
    ],
    [
      ["K1", undefined],
      ["K2", "K2"],
    ],
  );
  const [starter, joiner] = expectTables(run);

  expect(crossPartyClusters(starter, false)).toStrictEqual([
    { starterRows: [0], joinerRows: [0] },
    { starterRows: [1], joinerRows: [1] },
  ]);
  expect(crossPartyClusters(joiner, true)).toStrictEqual(
    crossPartyClusters(starter, false),
  );
});

test("duplicates on both sides resolve to the same clusters on the two parties", async () => {
  // A mixed dataset: one value two starter records and three joiner records hold,
  // one held once on each side, one row of each party matching only on the second
  // key, and one row of each party never matching at all.
  const run = await runCascade(
    [
      ["E1", "E1", "E2", undefined, "S"],
      [undefined, undefined, undefined, "T", undefined],
    ],
    [
      ["E1", "E1", "E1", "E2", undefined, "J"],
      [undefined, undefined, undefined, undefined, "T", undefined],
    ],
  );
  const [starter, joiner] = expectTables(run);

  const clusters = crossPartyClusters(starter, false);
  expect(clusters).toStrictEqual([
    { starterRows: [0, 1], joinerRows: [0, 1, 2] },
    { starterRows: [2], joinerRows: [3] },
    { starterRows: [3], joinerRows: [4] },
  ]);
  expect(crossPartyClusters(joiner, true)).toStrictEqual(clusters);
  // Each cluster is one matched value's whole block, so its members are the rows
  // that shared that value and nothing reaches it from another round.
  for (const cluster of clusters)
    expect(
      pairsOf(starter, false).filter(
        ([local, partner]) =>
          cluster.starterRows.includes(local) ||
          cluster.joinerRows.includes(partner),
      ).length,
    ).toBe(cluster.starterRows.length * cluster.joinerRows.length);
});

// --- what a cluster costs the result file and the record -----------------------

const outputMeta: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
  { name: "dose", type: "first_name", role: "payload", isPayload: true },
];
const starterInput: CSVRow[] = [
  { pid: "S0", dose: "10mg" },
  { pid: "S1", dose: "20mg" },
];
const joinerInput: CSVRow[] = [
  { pid: "J0", dose: "1mg" },
  { pid: "J1", dose: "2mg" },
  { pid: "J2", dose: "3mg" },
];

test("a value m and n records hold writes m x n result rows and attests m x n", async () => {
  // The accounting the cluster case takes, which is the accounting every other
  // cardinality takes: one result row per association PAIR, one payload row per
  // matched RECORD, and a recorded result size that is the pair count. With m = 2
  // and n = 3 all three figures differ, so none of them can stand in for another.
  const run = await runCascade([["E1", "E1"]], [["E1", "E1", "E1"]]);
  const [starter, joiner] = expectTables(run);

  const [cluster] = entityClusters(starter);
  expect(cluster).toStrictEqual({ localRows: [0, 1], partnerRows: [0, 1, 2] });

  // Both parties derive one figure from the one table, which is why the record
  // holds the pair count rather than either party's matched-record count.
  expect(matchedPairCount(starter)).toBe(6);
  expect(matchedPairCount(joiner)).toBe(6);
  expect(matchedPairCount(starter)).toBe(
    cluster.localRows.length * cluster.partnerRows.length,
  );

  // The payload frame is unmoved by the multiplicity: one row per record each
  // party matched, addressed by that party's own row index.
  const joinerPayload = preparePayload(joinerInput, outputMeta, joiner);
  const starterPayload = preparePayload(starterInput, outputMeta, starter);
  expect(joinerPayload.hasData && joinerPayload.rowIndices).toStrictEqual([
    0, 1, 2,
  ]);
  expect(starterPayload.hasData && starterPayload.rowIndices).toStrictEqual([
    0, 1,
  ]);

  const { headers, rows } = buildOutputTable(
    starter,
    starterInput,
    outputMeta,
    joinerPayload.hasData
      ? {
          columns: joinerPayload.columns,
          rowIndices: joinerPayload.rowIndices,
          rows: joinerPayload.rows,
        }
      : { columns: [], rowIndices: [], rows: [] },
  );
  expect(headers).toStrictEqual(["pid", "row_id", "dose"]);
  // One row per pair: each of this party's two records against each of the
  // partner's three, holding that partner record's own payload row.
  expect(rows).toStrictEqual([
    ["S0", "0", "1mg"],
    ["S0", "1", "2mg"],
    ["S0", "2", "3mg"],
    ["S1", "0", "1mg"],
    ["S1", "1", "2mg"],
    ["S1", "2", "3mg"],
  ]);
  expect(rows.length).toBe(matchedPairCount(starter));
});

// --- a partner that does not apply the rule ------------------------------------
// Only a partner that keeps neither its duplicates nor the round's uniqueness rule
// -- one contributing its whole dataset verbatim -- puts a value in the round
// twice, so it is played by hand from the PSI primitives: identifyIntersection's
// starter branch without the association-table check that refuses the ambiguity
// upstream, then the two mapped-element legs a starter sends first.

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

  const [joinerPositions, sortedRows] = (await conn.receive()) as [
    Array<number>,
    Array<number>,
  ];
  await conn.send(sortedRows.map((slot) => permutation[slot]));
  await conn.receive();

  // A party contributing its dataset verbatim has one round position per record,
  // so its translation of the joiner's list is the identity and its own entries
  // hold the joiner's positions as the round reported them.
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
    { cardinality: "many-to-many" },
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

test("a value the non-conforming starter contributed twice is dropped, not paired both ways", async () => {
  // Keeping a value a group of this party's records holds is not keeping a value
  // the PARTNER contributed twice: the second is a partner that applied no rule at
  // all, and its position pair is unattributable however wide this party's own
  // cardinality is. The whole "A" group leaves the round; "B" is contributed once
  // on both sides and matches.
  const outcome = await runAgainstNonConformingStarter(
    ["A", "A", "B"],
    [["A", "A", "B"]],
  );

  expect(outcome).toStrictEqual([[2], [2]]);
});

test("a non-conforming starter naming the dropped group is refused by the joiner", async () => {
  // A dropped position names no record the joiner matched, so a starter that names
  // it is refused where the list is translated rather than reinstating the group.
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

test("a non-conforming starter naming every pair the round produced is refused too", async () => {
  // Volume does not restore the group either: the extra entries name the dropped
  // position, which this side attributed to nothing. Under a both-sided
  // multiplicity a repeated naming is legitimate in general -- one per record of
  // the partner's own group -- so it is the naming rule rather than the count that
  // holds here.
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
    /names a record this side did not match on that round/,
  );
});

// --- the generalized index checks ---------------------------------------------
// Every one aborts as a classified protocol error with no result. Both parties are
// "many" here, so each holds its partner's list to the coverage rule and its own
// returned list to the run rule; nothing is role-derived, and the block runs under
// both parties.

// One shared group of two, one shared single record, and one row of each party's
// own: the last leaves a candidate position that exists and did not match, which
// several of the deviations below aim at.
const starterBlockKeys: Keys = [["E1", "E1", "E2", "S"]];
const joinerBlockKeys: Keys = [["E1", "E1", "E2", "J"]];

for (const party of ["starter", "joiner"] as const) {
  const under = ` (deviating party: ${party})`;

  const expectProtocolRefusal = async (
    deviation: Deviation,
    detail: RegExp,
  ): Promise<void> => {
    const run = await runCascade(starterBlockKeys, joinerBlockKeys, {
      party,
      deviation,
    });
    const outcome = run[party];
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as ConnectionError).kind).toBe("protocol");
    expect((outcome as Error).message).toMatch(detail);
  };

  test(`a partner list naming a position this party did not match is refused${under}`, async () => {
    // Position 2 is this party's own unshared value: a real candidate position, and
    // one no pair of the round reached.
    await expectProtocolRefusal(
      onMappedElementList(1, (list) => [
        ...list.slice(0, -1),
        { ...list[list.length - 1], theirIndex: 2 },
      ]),
      /names a record this side did not match on that round/,
    );
  });

  test(`a partner list leaving a matched position unnamed is refused${under}`, async () => {
    await expectProtocolRefusal(
      onMappedElementList(1, (list) => list.slice(0, -1)),
      /does not name every record this side matched/,
    );
  });

  test(`a partner list longer than the partner's counted rows is refused${under}`, async () => {
    // Coverage and the naming rule admit a repeated entry here -- one per record of
    // the partner's own group -- so the partner's authenticated row count is what
    // caps the list, and it is checked before any entry is translated.
    await expectProtocolRefusal(
      onMappedElementList(1, (list) => [...list, list[0], list[0]]),
      /more than the 4 record\(s\) the partner counted/,
    );
  });

  test(`a returned list merging two of this party's groups is refused${under}`, async () => {
    // Which of this party's records share a partner row is ITS grouping, not the
    // returning party's to decide. Pointing the "E2" record's run at a row the
    // "E1" group already took merges two groups this side sent, which flat
    // distinctness cannot catch on a side where a repeat is admitted.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => [
        ...list.slice(0, -1),
        { ...list[list.length - 1], theirIndex: list[0].theirIndex },
      ]),
      /names one partner row for two positions this side matched/,
    );
  });

  test(`a returned list splitting one of this party's groups is refused${under}`, async () => {
    // The mirror deviation: the two records that named ONE position come back with
    // different runs, so the partner splits a group this side's own data formed.
    // Every entry stays in range and the count is untouched.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => [
        ...list.slice(0, 2),
        { ...list[2], theirIndex: list[1].theirIndex },
        ...list.slice(3),
      ]),
      /names two partner rows for one position this side matched/,
    );
  });

  test(`a returned list naming one partner row twice in a run is refused${under}`, async () => {
    // Distinctness survives WITHIN a run: the run answering one of this party's
    // records is the partner's group behind the position it named, whose rows are
    // its own and distinct. A row named twice there is a repeated pair.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => [
        list[0],
        { ...list[1], theirIndex: list[0].theirIndex },
        ...list.slice(2),
      ]),
      /names one partner row twice for one record this side matched/,
    );
  });

  test(`a returned list containing other than the accumulated entry count is refused${under}`, async () => {
    // The count is the sum of the per-record run lengths this party accumulated
    // over the partner's own list, so a returned list of any other length is
    // refused before its entries are read.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => list.slice(0, -1)),
      /the returned mapped-element list has 4 entries, expected 5/,
    );
  });

  test(`the expected count follows the partner's own list, not the returned one${under}`, async () => {
    // What pins the returned list's length is a quantity this party computed from a
    // frame it had already checked: repeating an entry of the PARTNER's list adds
    // that record's whole group to the tally, so the correct returned list that
    // follows is then too short. Nothing about the deviating party's own data
    // changes, and the repeat stays inside the partner's counted rows.
    await expectProtocolRefusal(
      onMappedElementList(1, (list) => [...list, list[list.length - 1]]),
      /the returned mapped-element list has 5 entries, expected 6/,
    );
  });
}
