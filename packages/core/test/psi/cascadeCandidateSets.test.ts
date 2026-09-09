import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// This file drives the cascade's resolution of a candidate set at the link
// boundary, below every terms-level refusal, with the strategy allowlist held
// open so a fixture reads the resolution rather than an entry
// (CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY, linkageTermsPolicy.ts).
vi.mock("../../src/linkageTermsPolicy", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/linkageTermsPolicy")>();
  return { ...original, candidateSetIsImplementedForStrategy: () => true };
});

import { PSIParticipant } from "../../src/psi/participant";
import {
  groupDuplicatesAndRemoveUndefineds,
  linkViaPSI,
  linkViaSinglePassPSI,
  removeDuplicatesAndUndefineds,
  type LinkageCardinality,
} from "../../src/psi/link";
import {
  createMessagePipe,
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

test("a round no producer widened puts the single-valued cascade's frames on the wire", async () => {
  // Same key count, same matches, no candidate set: the grouping is omitted on
  // both frames, leaving each the shape the fan-out-free cascade sends. The
  // property is identity entry for entry once each frame's own order is
  // canonicalized, the library returning an intersection in no fixed order.
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
  // behind that position, so the round puts no grouping on either frame.
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

// --- the shapes the widened mapped-element entry exists for -------------------
// A cascade round states, per accepted record, the SET of the partner's
// positions that record's accepted pairs rest on, so an accepted pair set no
// single canonical position could name is reported rather than refused
// (docs/spec/PROTOCOL.md, The final mapped-element entry names the positions
// its record's pairs rest on). Each shape below reaches one of those forms, and
// each is asserted to resolve on BOTH parties, to the same pairs, in both role
// assignments.

// One record accepted against records in two DIFFERENT matched groups: the
// sweep accepts a record against every member of a group whatever it has
// already taken, and its candidates may reach two of them.
const CROSS_GROUP_ONE_SIDE: Array<Column> = [[new Set(["a", "b"])]];
const CROSS_GROUP_MANY_SIDE: Array<Column> = [["a", "b"]];

// Two accepted records of the deduplicating side sharing one lowest matched
// position: "V2" is the lowest of both records, so one canonical position per
// accepted record could not tell them apart.
const SHARED_CANONICAL_MANY_SIDE: Array<Column> = [
  [new Set(["V2", "V1"]), new Set(["V0", "V2"])],
];
const SHARED_CANONICAL_ONE_SIDE: Array<Column> = [["V1", "V0", "V2"]];

// The same shape as the randomized corpus first reached it: rows that sit the
// round out, and a value two of the "one" side's records hold, which that side
// therefore drops.
const MINIMAL_MANY_SIDE: Array<Column> = [
  [undefined, new Set(["V2", "V1"]), new Set(["V0", "V2"]), undefined],
];
const MINIMAL_ONE_SIDE: Array<Column> = [["V1", "V0", "V0", "V2"]];

// A group split across two of the "one" side's records: the many side's
// position for "V2" is owned by both its records, and each is accepted with a
// different partner record.
const OVERLAPPING_MANY_SIDE: Array<Column> = [[new Set(["V0", "V2"]), "V2"]];
const OVERLAPPING_ONE_SIDE: Array<Column> = [["V0", "V2"]];

async function runSinglePass(
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
  starterCardinality: LinkageCardinality,
): Promise<CascadeRun> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const [starter, joiner] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: starterCardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      {
        ...candidateSetBounds(joinerKeys[0].length, keyWidths),
        localFanOutFactor: 1,
      },
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: mirrorCardinality(starterCardinality) },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      {
        ...candidateSetBounds(starterKeys[0].length, keyWidths),
        localFanOutFactor: 1,
      },
      false,
      -1,
    ),
  ]);
  return { starter, joiner };
}

// Each shape in both role assignments: the sweep's order is role-derived, so a
// pairing decided by the resolved ranks has to land whichever party holds the
// PSI sender role. The table single-pass computes is what each is held to.
async function expectBothPartiesResolveAsSinglePass(
  manySide: Array<Column>,
  oneSide: Array<Column>,
): Promise<void> {
  for (const [starterKeys, joinerKeys, cardinality] of [
    [manySide, oneSide, "many-to-one"],
    [oneSide, manySide, "one-to-many"],
  ] as Array<[Array<Column>, Array<Column>, LinkageCardinality]>) {
    const cascade = await runCascade(starterKeys, joinerKeys, cardinality);
    const single = await runSinglePass(starterKeys, joinerKeys, cardinality);
    expect(sortAssociationTable(cascade.starter)).toStrictEqual(
      sortAssociationTable(single.starter),
    );
    expect(sortAssociationTable(cascade.joiner)).toStrictEqual(
      sortAssociationTable(single.joiner),
    );
  }
}

test("a record reaching two of the partner's groups resolves as single-pass does", async () => {
  await expectBothPartiesResolveAsSinglePass(
    CROSS_GROUP_MANY_SIDE,
    CROSS_GROUP_ONE_SIDE,
  );
});

test("two accepted records sharing a lowest position resolve as single-pass does", async () => {
  await expectBothPartiesResolveAsSinglePass(
    SHARED_CANONICAL_MANY_SIDE,
    SHARED_CANONICAL_ONE_SIDE,
  );
});

test("the shape the randomized corpus first reached resolves as single-pass does", async () => {
  await expectBothPartiesResolveAsSinglePass(
    MINIMAL_MANY_SIDE,
    MINIMAL_ONE_SIDE,
  );
});

test("a group split across two of the one side's records resolves as single-pass does", async () => {
  await expectBothPartiesResolveAsSinglePass(
    OVERLAPPING_MANY_SIDE,
    OVERLAPPING_ONE_SIDE,
  );
});
