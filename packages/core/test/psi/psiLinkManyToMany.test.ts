import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// The closure check, counted and given round labels on demand. A run of the two
// datasets below cannot produce a table the check refuses -- the replay derives
// the table and the blocks from the same rounds -- so the one way to drive the
// refusal through the strategy is to relabel the rounds on their way in.
const closureCheck = vi.hoisted(() => ({
  calls: 0,
  relabelRounds: false,
  returned: undefined as unknown,
}));

vi.mock("../../src/psi/entityClosure", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/psi/entityClosure")>();
  const counted: typeof original.assertRoundDiagonalClosure = (
    id,
    table,
    roundOfPair,
    blocks,
  ) => {
    closureCheck.calls += 1;
    closureCheck.returned = original.assertRoundDiagonalClosure(
      id,
      table,
      closureCheck.relabelRounds
        ? roundOfPair.map((round, i) => (i === 0 ? round : round + 1))
        : roundOfPair,
      blocks,
    );
    return closureCheck.returned as EntityClusterSummary;
  };
  return { ...original, assertRoundDiagonalClosure: counted };
});

async function withRelabeledRounds<T>(run: () => Promise<T>): Promise<T> {
  closureCheck.relabelRounds = true;
  try {
    return await run();
  } finally {
    closureCheck.relabelRounds = false;
  }
}

import { PSIParticipant } from "../../src/psi/participant";
import { linkViaPSI, linkViaSinglePassPSI } from "../../src/psi/link";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { entityClusters } from "../../src/psi/entityClosure";
import type { EntityClusterSummary } from "../../src/psi/entityClosure";
import { InternalConsistencyError } from "../../src/errors";
import { matchedPairCount } from "../../src/exchange";
import { buildOutputTable, preparePayload } from "../../src/payloadExchange";
import type { Metadata } from "../../src/config/metadata";
import type { CSVRow } from "../../src/file";
import type { AssociationTable } from "../../src/types";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

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

type Keys = Array<Array<string | Set<string> | undefined>>;

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
  // What each party's run reported through linkViaPSI's cluster callback, or
  // undefined where it reported none.
  starterClusters?: EntityClusterSummary;
  joinerClusters?: EntityClusterSummary;
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

  const reported: Partial<Record<"starter" | "joiner", EntityClusterSummary>> =
    {};
  const starterRun = settle(
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant("starter"),
      connFor("starter", starterConn),
      starterKeys,
      fanOutFreeBounds(starterKeys.length, joinerKeys[0].length),
      -1,
      undefined,
      (summary) => (reported.starter = summary),
    ),
  );
  const joinerRun = settle(
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant("joiner"),
      connFor("joiner", joinerConn),
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, starterKeys[0].length),
      -1,
      undefined,
      (summary) => (reported.joiner = summary),
    ),
  );
  // A party that aborts leaves the other parked on a frame it will never send, so
  // close the pipe once the party under test has settled.
  const first = deviate?.party === "joiner" ? joinerRun : starterRun;
  await first;
  await starterConn.close();
  return {
    starter: await starterRun,
    joiner: await joinerRun,
    starterClusters: reported.starter,
    joinerClusters: reported.joiner,
  };
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

  // One block, so the cluster the whole run produced formed on one value: the
  // figure that separates a shared value from a chain.
  expect(run.starterClusters).toStrictEqual({
    clusterCount: 1,
    localRows: 2,
    partnerRows: 3,
    shapes: [{ localRows: 2, partnerRows: 3, distinctValues: 1, clusters: 1 }],
  });

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
    fanOutFreeBounds(joinerKeys.length, starterValues.length),
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
    // distinctness cannot catch on a side where a repeat is admitted: what
    // catches it is that no group this round accepted holds those records
    // together.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => [
        ...list.slice(0, -1),
        { ...list[list.length - 1], theirIndex: list[0].theirIndex },
      ]),
      /names one partner row for a set of this side's records the round did not accept together/,
    );
  });

  test(`a returned list splitting one of this party's groups is refused${under}`, async () => {
    // The mirror deviation: the two records that named ONE position come back with
    // runs sharing no row, so the partner splits a group this side's own data
    // formed. Every entry stays in range and the count is untouched.
    await expectProtocolRefusal(
      onMappedElementList(2, (list) => [
        ...list.slice(0, 2),
        { ...list[2], theirIndex: 2 },
        { ...list[3], theirIndex: 3 },
        ...list.slice(4),
      ]),
      /names one partner row for a set of this side's records the round did not accept together/,
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

// --- the index checks over a round a candidate set widened ---------------------
// The same rules where one record contributes several of a round's values, which
// is what leaves two of this party's entries accepted with overlapping sets of
// the partner's records rather than with one group each (docs/spec/PROTOCOL.md,
// What this resolution owes). The starter's row 0 reaches both of the
// joiner's records through its two candidates and its row 1 reaches one of them,
// so the four records stand in one chained cluster over two blocks.
const chainedStarterKeys: Keys = [[new Set(["E1", "E2"]), "E2", "E3", "S"]];
const chainedJoinerKeys: Keys = [["E1", "E2", "E3", "J"]];

for (const party of ["starter", "joiner"] as const) {
  const under = ` (deviating party: ${party})`;

  const expectChainedRefusal = async (
    deviation: Deviation,
    detail: RegExp,
  ): Promise<void> => {
    const run = await runCascade(chainedStarterKeys, chainedJoinerKeys, {
      party,
      deviation,
    });
    const outcome = run[party];
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as ConnectionError).kind).toBe("protocol");
    expect((outcome as Error).message).toMatch(detail);
  };

  test(`a widened round's chained cluster resolves on both parties${under}`, async () => {
    // The undeviated run, so each refusal below is read against a round that
    // otherwise completes.
    const run = await runCascade(chainedStarterKeys, chainedJoinerKeys);
    const [starter, joiner] = expectTables(run);
    expect(pairsOf(starter, false)).toStrictEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 2],
    ]);
    expectAgreement(starter, joiner);
    expect(entityClusters(starter)).toStrictEqual([
      { localRows: [0, 1], partnerRows: [0, 1] },
      { localRows: [2], partnerRows: [2] },
    ]);

    // The diagnostic over those clusters: the chained one formed on the two
    // values the starter's candidate set reached, the one beside it on a single
    // value. Both parties count the same two blocks against the chained
    // cluster, each reading its own side as the first figure.
    const chained = {
      clusterCount: 2,
      localRows: 3,
      partnerRows: 3,
      shapes: [
        { localRows: 2, partnerRows: 2, distinctValues: 2, clusters: 1 },
        { localRows: 1, partnerRows: 1, distinctValues: 1, clusters: 1 },
      ],
    };
    expect(run.starterClusters).toStrictEqual(chained);
    expect(run.joinerClusters).toStrictEqual(chained);
  });

  test(`a returned run naming a row the round did not pair with its entry is refused${under}`, async () => {
    // The amplification the run rule exists to stop: pointing one entry's run at
    // a partner row another entry's record was paired with -- and its own was
    // not -- would merge two of this party's records into one cluster its own
    // resolution kept apart. Every entry stays in range and the count is
    // untouched.
    await expectChainedRefusal(
      onMappedElementList(2, (list) => [
        ...list.slice(0, -1),
        { ...list[list.length - 1], theirIndex: list[0].theirIndex },
      ]),
      /names one partner row for a set of this side's records the round did not accept together/,
    );
  });

  test(`a partner entry naming a position this party did not match is refused${under}`, async () => {
    // The widened entry names a SET of positions here, and every one of them is
    // held to the same rule a single-position entry is: a position this party
    // matched in that round.
    await expectChainedRefusal(
      onMappedElementList(1, (list) => [
        ...list.slice(0, -1),
        { ...list[list.length - 1], theirIndex: [2, 3] },
      ]),
      party === "starter"
        ? // The joiner omits its own grouping here, so the starter reads its
          // entries as position sets against its own round output.
          /names a record this side did not match on that round/
        : // The starter states its grouping, so the joiner holds its entries to
          // the pairing both parties computed, position for position.
          /names positions other than the ones that round's accepted pairs rest on/,
    );
  });
}

// --- a row named in two key rounds ---------------------------------------------
// Removal on a potential match takes a record matched in one round out of every
// later round's candidate set (docs/spec/PROTOCOL.md, Removal on a potential
// match), so no partner row stands in two rounds' runs. Each round's pairing is
// read on its own above, which leaves this one a rule over the whole list.
const twoRoundKeys: Keys = [
  ["A", undefined],
  [undefined, "B"],
];

test("two key rounds pair off a row each, and the run completes", async () => {
  const run = await runCascade(twoRoundKeys, twoRoundKeys);
  const [starter, joiner] = expectTables(run);
  expect(pairsOf(starter, false)).toStrictEqual([
    [0, 0],
    [1, 1],
  ]);
  expectAgreement(starter, joiner);
});

for (const party of ["starter", "joiner"] as const) {
  test(`a returned list naming one partner row in two key rounds is refused (deviating party: ${party})`, async () => {
    // Round 1's entry comes back holding the row round 0's entry took. Every
    // entry stays in range, the count is untouched, and each round on its own
    // still hands its single accepted group a row -- what refuses it is the
    // row standing in two rounds.
    const run = await runCascade(twoRoundKeys, twoRoundKeys, {
      party,
      deviation: onMappedElementList(2, (list) => [
        list[0],
        { ...list[1], theirIndex: list[0].theirIndex },
      ]),
    });
    const outcome = run[party];
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as ConnectionError).kind).toBe("protocol");
    expect((outcome as Error).message).toMatch(
      /names one partner row in two key rounds/,
    );
  });
}

// --- the same cardinality under single-pass ------------------------------------
// The receiver replays the whole cascade locally and hands the sender the
// resolved table, so the sender holds neither a round nor a block to check it
// against. What it holds instead is the pair-count bound its own row count and
// the partner's declared record count give -- the most pairs an honest run of
// the two datasets can produce (docs/spec/PROTOCOL.md, The both-sided table's
// bound under single-pass).

// The sender's inbound association-table frame, told apart from the client
// request that precedes it (a binary frame) by its shape.
const isAssociationTable = (frame: unknown): frame is AssociationTable =>
  Array.isArray(frame) && frame.length === 2 && Array.isArray(frame[0]);

function replacingResolvedTable(replacement: AssociationTable): Deviation {
  return (frame) => (isAssociationTable(frame) ? replacement : frame);
}

interface SinglePassRun {
  /** A deviation on the sender's inbound frames -- the starter plays it here. */
  deviation?: Deviation;
  /**
   * Drive the receiver with no cluster callback, the way a caller outside
   * runExchange reaches the strategy.
   */
  withoutClusterCallback?: boolean;
  /** The party expected to settle first, which the pipe is closed on. */
  settlesFirst?: "starter" | "joiner";
}

async function runSinglePass(
  starterKeys: Keys,
  joinerKeys: Keys,
  options: SinglePassRun = {},
): Promise<{
  starter: AssociationTable | Error;
  joiner: AssociationTable | Error;
  joinerClusters?: EntityClusterSummary;
}> {
  const { deviation, withoutClusterCallback, settlesFirst } = options;
  const [starterConn, joinerConn] = createMessagePipe();
  const settle = (
    run: Promise<AssociationTable>,
  ): Promise<AssociationTable | Error> =>
    run.then(
      (table) => table,
      (err: unknown) => err as Error,
    );
  let joinerClusters: EntityClusterSummary | undefined;
  const starterRun = settle(
    linkViaSinglePassPSI(
      { cardinality: "many-to-many" },
      makeParticipant("starter"),
      deviation === undefined
        ? starterConn
        : deviatingInbound(starterConn, deviation),
      starterKeys,
      fanOutFreeBounds(starterKeys.length, joinerKeys[0].length),
      false,
      -1,
    ),
  );
  const joinerRun = settle(
    linkViaSinglePassPSI(
      { cardinality: "many-to-many" },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, starterKeys[0].length),
      false,
      -1,
      undefined,
      withoutClusterCallback === true
        ? undefined
        : (summary) => (joinerClusters = summary),
    ),
  );
  // A party that aborts leaves the other parked on a frame it will never send,
  // so close the pipe once the party under test has settled.
  await (settlesFirst === "joiner" ? joinerRun : starterRun);
  await starterConn.close();
  return {
    starter: await starterRun,
    joiner: await joinerRun,
    joinerClusters,
  };
}

// Three records a side, so an honest table holds four of the nine pairs the
// bound admits and a deviation has room to reach the bound and pass it.
const spStarterKeys: Keys = [["E1", "E1", "S"]];
const spJoinerKeys: Keys = [["E1", "E1", "J"]];

test("single-pass pairs the cardinality, both parties holding the one table", async () => {
  const { starter, joiner, joinerClusters } = await runSinglePass(
    spStarterKeys,
    spJoinerKeys,
  );
  expect(starter).toStrictEqual([
    [0, 0, 1, 1],
    [0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual(starter);
  expectAgreement(starter as AssociationTable, joiner as AssociationTable);
  // The receiver holds the rounds and their blocks, so the cluster diagnostic
  // is composed there; the sender is handed the table alone.
  expect(joinerClusters).toStrictEqual({
    clusterCount: 1,
    localRows: 2,
    partnerRows: 2,
    shapes: [{ localRows: 2, partnerRows: 2, distinctValues: 1, clusters: 1 }],
  });
});

test("a resolved table at the derived bound is accepted", async () => {
  // Every pair between the two datasets: three of this party's rows times the
  // three the partner declared. The bound is what an honest run of two
  // duplicate-rich datasets can actually reach, so it admits this.
  const wholeProduct: AssociationTable = [
    [0, 0, 0, 1, 1, 1, 2, 2, 2],
    [0, 1, 2, 0, 1, 2, 0, 1, 2],
  ];
  const { starter } = await runSinglePass(spStarterKeys, spJoinerKeys, {
    deviation: replacingResolvedTable(wholeProduct),
  });
  expect(starter).toStrictEqual(wholeProduct);
});

test("a resolved table one pair past the bound is refused", async () => {
  // One more than the product admits. The length is checked before any entry
  // is read, so the refusal names the bound rather than the repeated pair the
  // tenth entry must also be.
  const { starter } = await runSinglePass(spStarterKeys, spJoinerKeys, {
    deviation: replacingResolvedTable([
      [0, 0, 0, 1, 1, 1, 2, 2, 2, 2],
      [0, 1, 2, 0, 1, 2, 0, 1, 2, 0],
    ]),
  });
  expect(starter).toBeInstanceOf(ConnectionError);
  expect((starter as ConnectionError).kind).toBe("protocol");
  expect((starter as Error).message).toMatch(
    /has 10 entries, more than the 9 pair\(s\) the two parties' record counts admit/,
  );
});

test("a resolved table naming one pair twice is refused", async () => {
  // Within the bound, so the length check passes and what refuses it is the
  // pair rule: a pair named twice is one link every consumer of the table
  // counts and writes twice.
  const { starter } = await runSinglePass(spStarterKeys, spJoinerKeys, {
    deviation: replacingResolvedTable([
      [0, 0, 1],
      [1, 1, 0],
    ]),
  });
  expect(starter).toBeInstanceOf(ConnectionError);
  expect((starter as ConnectionError).kind).toBe("protocol");
  expect((starter as Error).message).toMatch(
    /names one row twice for one record of the other side/,
  );
});

test("a resolved table whose local half descends is refused", async () => {
  // Non-decreasing is what the repeating half keeps, and the result rows, the
  // payload rows and the re-supply path all read the table in that order.
  const { starter } = await runSinglePass(spStarterKeys, spJoinerKeys, {
    deviation: replacingResolvedTable([
      [1, 0],
      [0, 0],
    ]),
  });
  expect(starter).toBeInstanceOf(ConnectionError);
  expect((starter as Error).message).toMatch(/is not in ascending order/);
});

test("a resolved table naming a row neither party counted is refused", async () => {
  const { starter } = await runSinglePass(spStarterKeys, spJoinerKeys, {
    deviation: replacingResolvedTable([[0], [3]]),
  });
  expect(starter).toBeInstanceOf(ConnectionError);
  expect((starter as Error).message).toMatch(/has an index outside \[0, 3\)/);
});

// --- the receiver's closure check, with and without the cluster callback -------
// The callback is optional and runExchange always supplies one, so the check
// stands on its own: the differential vectors, the bench, and any other direct
// caller drive the strategy without one and are entitled to the same refusal
// (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).

test("a table the closure check refuses aborts the receiver with no callback", async () => {
  closureCheck.calls = 0;
  const { joiner } = await withRelabeledRounds(() =>
    runSinglePass(spStarterKeys, spJoinerKeys, {
      withoutClusterCallback: true,
      settlesFirst: "joiner",
    }),
  );
  expect(closureCheck.calls).toBe(1);
  expect(joiner).toBeInstanceOf(InternalConsistencyError);
  expect((joiner as Error).message).toMatch(
    /joins pairs matched on two different linkage keys/,
  );
});

test("the cluster callback is handed the summary the check returned", async () => {
  closureCheck.calls = 0;
  const { joiner, joinerClusters } = await runSinglePass(
    spStarterKeys,
    spJoinerKeys,
  );
  expect(joiner).not.toBeInstanceOf(Error);
  expect(closureCheck.calls).toBe(1);
  expect(joinerClusters).toBe(closureCheck.returned);
});
