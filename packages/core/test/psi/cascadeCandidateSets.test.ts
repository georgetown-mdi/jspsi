import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// The cascade's realization of a candidate set is built but not lit: the
// strategy allowlist answers false for it, so the refusals standing at
// authoring, prepare, and the run boundary have nothing to slip past
// (CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY, linkageTermsPolicy.ts). This file
// pins the resolution behind that entry, exactly as the fuzzy-expansion tests
// pin the key-building half behind APPLIED_SETTINGS.
vi.mock("../../src/linkageTermsPolicy", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/linkageTermsPolicy")>();
  return { ...original, candidateSetIsImplementedForStrategy: () => true };
});

import { PSIParticipant } from "../../src/psi/participant";
import {
  groupDuplicatesAndRemoveUndefineds,
  linkViaPSI,
  removeDuplicatesAndUndefineds,
  type LinkageCardinality,
} from "../../src/psi/link";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import type { AssociationTable } from "../../src/types";
import { sortAssociationTable } from "../../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { recordingConnection } from "../utils/recordingConnection";
import {
  candidateSetBounds,
  declaredKeyWidths,
  mirrorCardinality,
  type Column,
} from "../utils/candidateSetBounds";

const psiLibrary = await PSI();

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

interface CascadeRun {
  starter: AssociationTable;
  joiner: AssociationTable;
}

async function runCascade(
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
  starterCardinality: LinkageCardinality = "one-to-one",
  wrap?: {
    party: "starter" | "joiner";
    conn: (conn: MessageConnection) => MessageConnection;
  },
): Promise<CascadeRun> {
  const [starterConn, joinerConn] = createMessagePipe();
  const connFor = (party: "starter" | "joiner", conn: MessageConnection) =>
    wrap?.party === party ? wrap.conn(conn) : conn;
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const [starter, joiner] = await Promise.all([
    linkViaPSI(
      { cardinality: starterCardinality },
      makeParticipant("starter"),
      connFor("starter", starterConn),
      starterKeys,
      candidateSetBounds(joinerKeys[0].length, keyWidths),
      -1,
    ),
    linkViaPSI(
      { cardinality: mirrorCardinality(starterCardinality) },
      makeParticipant("joiner"),
      connFor("joiner", joinerConn),
      joinerKeys,
      candidateSetBounds(starterKeys[0].length, keyWidths),
      -1,
    ),
  ]);
  return {
    starter: sortAssociationTable(starter),
    joiner: sortAssociationTable(joiner, true),
  };
}

// Both parties reach the same table by different routes, each resolving its
// own round from the two groupings the round's frames hold, so a test that
// read one party's table alone would miss exactly the divergence the grouping
// exists to prevent.
function expectAgreement(run: CascadeRun): void {
  expect(run.starter[0]).toStrictEqual(run.joiner[1]);
  expect(run.starter[1]).toStrictEqual(run.joiner[0]);
}

// --- row-major candidate lists ------------------------------------------------
// The whole sweep rests on one property of the round's construction: one
// record's candidates are contiguous and records ascend, so ascending position
// order is ascending own-row order and a run's rank is its record's rank
// (docs/spec/PROTOCOL.md, The round's candidate list is row-major).

test("a record's candidates are contiguous and records ascend", () => {
  const [values, rows] = removeDuplicatesAndUndefineds([
    new Set(["b", "a"]),
    "c",
    new Set(["e", "d"]),
  ]);
  expect(values).toStrictEqual(["b", "a", "c", "e", "d"]);
  expect(rows).toStrictEqual([0, 0, 1, 2, 2]);
});

test("row-major order survives a value a later row would have led with", () => {
  // First-appearance order over the flat value stream is row-major only
  // because the walk is by row: a value row 1 also holds takes row 0's slot,
  // and a fixture where the two orders differ is what catches a construction
  // that kept deduplication and lost contiguity.
  const [values, rows] = removeDuplicatesAndUndefineds([
    new Set(["z", "a"]),
    new Set(["y", "b"]),
  ]);
  expect(values).toStrictEqual(["z", "a", "y", "b"]);
  expect(rows).toStrictEqual([0, 0, 1, 1]);
});

test("a carried-forward round maps its rows back through the permutation", () => {
  const [values, rows] = removeDuplicatesAndUndefineds(
    [new Set(["a", "b"]), "c"],
    [3, 7],
  );
  expect(values).toStrictEqual(["a", "b", "c"]);
  expect(rows).toStrictEqual([3, 3, 7]);
});

// A randomized corpus over the property itself: whatever the fixture, the row
// list a round is built with is non-decreasing, and the runs it breaks into
// are one per record.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small value alphabet against a widish row count, so values recur across
// rows rather than by luck, and some rows sit the round out.
function randomRounds(count: number): Array<Column> {
  const rand = mulberry32(0x5eed4321);
  const rounds: Array<Column> = [];
  for (let c = 0; c < count; ++c) {
    const numRecords = 1 + Math.floor(rand() * 6);
    const alphabet = 1 + Math.floor(rand() * 5);
    const column: Column = [];
    for (let row = 0; row < numRecords; ++row) {
      const width = Math.floor(rand() * 4);
      if (width === 0) {
        column.push(undefined);
        continue;
      }
      const chosen = new Set<string>();
      for (let k = 0; k < width; ++k)
        chosen.add(`V${Math.floor(rand() * alphabet)}`);
      column.push(chosen.size === 1 ? [...chosen][0] : chosen);
    }
    rounds.push(column);
  }
  return rounds;
}

test("every round a randomized corpus builds is row-major", () => {
  let widened = 0;
  for (const column of randomRounds(400)) {
    const [, rows] = removeDuplicatesAndUndefineds(column);
    for (let k = 1; k < rows.length; ++k)
      expect(rows[k]).toBeGreaterThanOrEqual(rows[k - 1]);
    // One run per record: a construction that deduplicated but lost
    // contiguity would break a record's positions into two runs here, and
    // the run's rank would stop being its record's.
    const runs: Array<number> = [];
    for (let k = 0; k < rows.length; ++k)
      if (k === 0 || rows[k] !== rows[k - 1]) runs.push(rows[k]);
    expect(runs.length).toBe(new Set(rows).size);
    if (runs.length < rows.length) ++widened;

    // The deduplicating layout's counterpart: positions ascend with their
    // first owner row, and each group's rows ascend.
    const [, candidates] = groupDuplicatesAndRemoveUndefineds(column);
    const starts = candidates.groupStarts!;
    let previousFirst = -1;
    for (let position = 0; position + 1 < starts.length; ++position) {
      const group = candidates.rows.slice(
        starts[position],
        starts[position + 1],
      );
      expect(group.length).toBeGreaterThan(0);
      expect([...group].sort((a, b) => a - b)).toStrictEqual(group);
      expect(group[0]).toBeGreaterThan(previousFirst - 1);
      previousFirst = group[0];
    }
  }
  // Non-vacuity: the corpus reaches rounds a candidate set widened.
  expect(widened).toBeGreaterThan(50);
});

test("a deduplicating party's positions ascend with their first owner", () => {
  const [values, candidates] = groupDuplicatesAndRemoveUndefineds([
    new Set(["a", "b"]),
    new Set(["b", "c"]),
  ]);
  expect(values).toStrictEqual(["a", "b", "c"]);
  expect(candidates.groupStarts).toStrictEqual([0, 1, 3, 4]);
  expect(candidates.rows).toStrictEqual([0, 0, 1, 1]);
});

// --- the within-round uniqueness rule, per value ------------------------------

test("a value two of this party's records hold leaves the round, its record's others staying", () => {
  const [values, rows] = removeDuplicatesAndUndefineds([
    new Set(["shared", "mine"]),
    new Set(["shared", "yours"]),
  ]);
  expect(values).toStrictEqual(["mine", "yours"]);
  expect(rows).toStrictEqual([0, 1]);
});

test("a record whose every candidate is a within-round duplicate participates with nothing", () => {
  const [values, rows] = removeDuplicatesAndUndefineds([
    new Set(["a", "b"]),
    new Set(["a", "b"]),
    "c",
  ]);
  expect(values).toStrictEqual(["c"]);
  expect(rows).toStrictEqual([2]);
});

test("the shared-value drop is per value, so a fanning record still matches on its own", async () => {
  // Both starter rows hold "shared", which leaves the round on the starter;
  // row 0's "only-mine" is unique and still matches. A rule applied per RECORD
  // would have dropped row 0 entirely.
  const run = await runCascade(
    [[new Set(["shared", "only-mine"]), new Set(["shared", "unmatched"])]],
    [["only-mine", "shared"]],
  );
  expect(run.starter).toStrictEqual([[0], [0]]);
  expectAgreement(run);
});

// --- removal on a potential match ---------------------------------------------

test("a record the sweep discards ends unmatched and out of candidacy", async () => {
  // Round 1: the starter's row 0 fans out and is a candidate for both joiner
  // rows; the sweep accepts the lower and discards the other pair. Round 2
  // would match the joiner's discarded row uniquely, and must not: it left
  // candidacy on the potential match.
  const run = await runCascade(
    [
      [new Set(["p", "q"]), undefined],
      [undefined, "late"],
    ],
    [
      ["p", "q"],
      [undefined, "late"],
    ],
  );
  expect(run.starter).toStrictEqual([[0], [0]]);
  expectAgreement(run);
});

test("the discarded record is in no mapped-element list and no later round", async () => {
  // The same shape with the later key held by BOTH parties' discarded rows, so
  // a round that failed to remove them would produce a second pair rather than
  // a silent no-op.
  const run = await runCascade(
    [
      [new Set(["p", "q"]), "z"],
      ["late", "late"],
    ],
    [
      ["p", "q"],
      ["late", "other"],
    ],
  );
  expect(run.starter).toStrictEqual([[0], [0]]);
  expectAgreement(run);
});

// --- the normative double-match case ------------------------------------------
// docs/spec/PROTOCOL.md, The normative double-match case. S0 = {ab, cd},
// S1 = {ef}; R0 = {ab}, R1 = {cd, ef}. Every value occurs once within its own
// party's round, so none is dropped for ambiguity, and the candidate pairs are
// (S0, R0), (S0, R1), (S1, R1).

const DOUBLE_MATCH_S: Array<Column> = [
  [new Set(["ab", "cd"]), new Set(["ef"])],
];
const DOUBLE_MATCH_R: Array<Column> = [["ab", new Set(["cd", "ef"])]];

test("both parties produce the same table with S as the sender", async () => {
  const run = await runCascade(DOUBLE_MATCH_S, DOUBLE_MATCH_R);
  expect(run.starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expectAgreement(run);
});

test("both parties produce the same table with S as the receiver", async () => {
  // The sweep's order is role-derived, so the case runs in both role
  // assignments and must reach the same records either way.
  const run = await runCascade(DOUBLE_MATCH_R, DOUBLE_MATCH_S);
  expect(run.starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expectAgreement(run);
});

test("the tiebreak is decided by rank, not by the order values enter the round", async () => {
  // S0's two candidates swapped in its realized set, which moves "cd" ahead of
  // "ab" in the round's candidate list. The table is unchanged: the order is
  // the records' ranks, and a resolution reading list order would invert here.
  const run = await runCascade(
    [[new Set(["cd", "ab"]), new Set(["ef"])]],
    [["ab", new Set(["ef", "cd"])]],
  );
  expect(run.starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expectAgreement(run);
});

// --- the grouping on the wire -------------------------------------------------

async function recordedStarterFrames(
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
  cardinality: LinkageCardinality = "one-to-one",
): Promise<Array<unknown>> {
  let sent: Array<unknown> = [];
  await runCascade(starterKeys, joinerKeys, cardinality, {
    party: "starter",
    conn: (conn) => {
      const recorder = recordingConnection(conn);
      sent = recorder.sent;
      return recorder.conn;
    },
  });
  return sent;
}

test("a widened round adds no frame", async () => {
  // The grouping rides frames the round already sends, so a round a candidate
  // set widened moves exactly as many frames as one it did not, for the same
  // key count.
  const widened = await recordedStarterFrames(DOUBLE_MATCH_S, DOUBLE_MATCH_R);
  const plain = await recordedStarterFrames([["a", "b"]], [["a", "b"]]);
  expect(widened.length).toBe(plain.length);
});

test("a round no producer widened puts the single-valued cascade's bytes on the wire", async () => {
  // Same key count, same matches, no candidate set: every frame is what the
  // fan-out-free cascade sends, the grouping being omitted on both frames.
  const plain = await recordedStarterFrames([["a", "b"]], [["a", "b"]]);
  const groupingFrames = plain.filter(
    (frame) => Array.isArray(frame) && Array.isArray(frame[1]),
  );
  expect(groupingFrames).toStrictEqual([]);
  // Frame 5 is the bare original-index list a single-valued round sends.
  expect(
    plain.some((frame) => Array.isArray(frame) && frame.every(Number.isFinite)),
  ).toBe(true);
});

test("a widened round states run lengths beside its original-index list", async () => {
  const sent = await recordedStarterFrames(DOUBLE_MATCH_S, DOUBLE_MATCH_R);
  const grouped = sent.find(
    (frame) => Array.isArray(frame) && Array.isArray(frame[1]),
  ) as [Array<number>, Array<number>];
  // S0 owns two of the round's three matched positions and S1 the third.
  expect(grouped[1]).toStrictEqual([2, 1]);
});

test("a deduplicating party states an owner list per matched position", async () => {
  // The starter is the "many" side and fans out: one record owns several
  // matched positions while one position is owned by several records, which
  // run lengths cannot state.
  const sent = await recordedStarterFrames(
    [[new Set(["shared", "own"]), "shared"]],
    [["shared", "own"]],
    "many-to-one",
  );
  const grouped = sent.find(
    (frame) => Array.isArray(frame) && Array.isArray(frame[1]),
  ) as [Array<number>, Array<Array<number>>];
  expect(grouped[1]).toStrictEqual([[0, 1], [0]]);
});

test("a deduplicating party no producer widened still omits its grouping", async () => {
  // Each of its records owns exactly one matched position, whatever the group
  // behind that position, so the round stays byte-identical to today's.
  const sent = await recordedStarterFrames(
    [["shared", "shared"]],
    [["shared"]],
    "many-to-one",
  );
  const grouped = sent.filter(
    (frame) => Array.isArray(frame) && Array.isArray(frame[1]),
  );
  expect(grouped).toStrictEqual([]);
});

// --- rounds no mapped-element list can state ----------------------------------
// A cascade round reports one partner match per record, naming one candidate
// group of the partner's, and a candidate set can produce accepted pairs that
// form does not hold. Each shape below is refused AT THE ROUND, on both parties
// -- they resolve the same accepted pairs from the same two groupings -- rather
// than reaching the post-round pass, where one party would abort blaming a
// conforming partner after its own list had gone out.

// One record accepted against records in two DIFFERENT matched groups: the
// sweep accepts a record against every member of a group whatever it has
// already taken, and its candidates may reach two of them.
const CROSS_GROUP_ONE_SIDE: Array<Column> = [[new Set(["a", "b"])]];
const CROSS_GROUP_MANY_SIDE: Array<Column> = [["a", "b"]];

// Two accepted records of the deduplicating side sharing one canonical
// position: "V2" is the lowest matched position of both records, so the "one"
// side's list names that one position once per accepted record.
const SHARED_CANONICAL_MANY_SIDE: Array<Column> = [
  [new Set(["V2", "V1"]), new Set(["V0", "V2"])],
];
const SHARED_CANONICAL_ONE_SIDE: Array<Column> = [["V1", "V0", "V2"]];

// The same collision as the randomized corpus first reached it: rows that sit
// the round out, and a value two of the "one" side's records hold, which that
// side therefore drops.
const MINIMAL_MANY_SIDE: Array<Column> = [
  [undefined, new Set(["V2", "V1"]), new Set(["V0", "V2"]), undefined],
];
const MINIMAL_ONE_SIDE: Array<Column> = [["V1", "V0", "V0", "V2"]];

// The sibling shape: no two accepted records share a canonical position, but
// one record's group holds a record canonicalized at a lower position, so the
// two named groups overlap and the pass would count that record twice.
const OVERLAPPING_MANY_SIDE: Array<Column> = [[new Set(["V0", "V2"]), "V2"]];
const OVERLAPPING_ONE_SIDE: Array<Column> = [["V0", "V2"]];

async function settledCascade(
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
  starterCardinality: LinkageCardinality,
): Promise<Array<unknown>> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const settle = (run: Promise<unknown>): Promise<unknown> =>
    run.then(
      (table) => table,
      (err: unknown) => err,
    );
  const outcomes = await Promise.all([
    settle(
      linkViaPSI(
        { cardinality: starterCardinality },
        makeParticipant("starter"),
        starterConn,
        starterKeys,
        candidateSetBounds(joinerKeys[0].length, keyWidths),
        -1,
      ),
    ),
    settle(
      linkViaPSI(
        { cardinality: mirrorCardinality(starterCardinality) },
        makeParticipant("joiner"),
        joinerConn,
        joinerKeys,
        candidateSetBounds(starterKeys[0].length, keyWidths),
        -1,
      ),
    ),
  ]);
  await starterConn.close();
  return outcomes;
}

function expectRoundRefusal(outcome: unknown): void {
  expect(outcome).toBeInstanceOf(ConnectionError);
  expect((outcome as ConnectionError).kind).toBe("protocol");
  expect((outcome as ConnectionError).message).toMatch(
    /matched records a cascade exchange cannot report one at a time/,
  );
}

// Each shape in both role assignments: the sweep's order is role-derived, so a
// refusal decided by the resolved pairs has to land whichever party holds the
// PSI sender role.
async function expectBothPartiesRefuse(
  manySide: Array<Column>,
  oneSide: Array<Column>,
): Promise<void> {
  for (const outcome of await settledCascade(manySide, oneSide, "many-to-one"))
    expectRoundRefusal(outcome);
  for (const outcome of await settledCascade(oneSide, manySide, "one-to-many"))
    expectRoundRefusal(outcome);
}

test("both parties refuse a record reaching two of the partner's groups", async () => {
  await expectBothPartiesRefuse(CROSS_GROUP_MANY_SIDE, CROSS_GROUP_ONE_SIDE);
});

test("both parties refuse two accepted records sharing a canonical position", async () => {
  await expectBothPartiesRefuse(
    SHARED_CANONICAL_MANY_SIDE,
    SHARED_CANONICAL_ONE_SIDE,
  );
});

test("both parties refuse the collision the randomized corpus first reached", async () => {
  await expectBothPartiesRefuse(MINIMAL_MANY_SIDE, MINIMAL_ONE_SIDE);
});

test("both parties refuse two named groups that overlap", async () => {
  await expectBothPartiesRefuse(OVERLAPPING_MANY_SIDE, OVERLAPPING_ONE_SIDE);
});
