import { describe, expect, test } from "vitest";

import {
  replaySinglePassCascade,
  RoundValueParticipation,
  roundValueFirstRows,
} from "../src/link";

// The single-pass replay asks the sender's side of each round one question -- does
// the row the sweep has reached take part with this value (replaySinglePassCascade,
// packages/core/src/link.ts) -- and a sender that KEEPS its duplicates has a single
// answer to it, so the replay builds it no form at all. That is a claim about what
// happens at runtime, so it is checked here rather than written down.
//
// The check drives the REAL sweep. Each round of the corpus below is replayed as
// the SECOND of two rounds through replaySinglePassCascade, with the sender's cells
// wrapped so that every read the sweep makes is recorded; the first round pairs off
// exactly the rows the corpus round wants out of candidacy, so the cascade's own
// removal step rather than a hand-set flag is what puts them there. Nothing here
// models the sweep's read pattern: a change to which rows or cells it reaches moves
// the recorded pairs.
//
// The recorded pairs are then put to the form the elided branch would have built,
// over the round's REAL first pass (roundValueFirstRows): a sender that keeps its
// duplicates takes part with every value the round kept, so its answer is
// `firstRow.has(value)` and must be yes throughout. A control puts the same pairs to
// the real form the OTHER side does build (RoundValueParticipation), which must
// answer no somewhere -- a corpus that could not tell the two apart would pass the
// differential without saying anything.
//
// The sides driven are `{localKeepsDuplicates: false, partnerKeepsDuplicates: true}`,
// the receiver's own label for a sender that keeps its duplicates, which is the one
// combination the elided branch belongs to. `{true, true}` is not among the
// combinations left unswept here: it is the many-to-many label, which this strategy
// refuses before a round begins, so no replay of it runs under those sides.
// psiLinkManyToOne.test.ts ("single-pass refuses many-to-many"), psiLink.test.ts
// ("many-to-many pairs in the cascade and is refused by single-pass") and
// linkageCardinality.test.ts ("single-pass resolves every label except the
// both-sided one") carry that.
//
// A row holding one value twice is in the corpus defensively rather than as a
// reachable shape: a local cell realizes a ReadonlySet, and a partner's ragged cell
// is refused unless its indices strictly ascend (singlePassFanOut.test.ts, "the
// ragged table is refused for repeating a value index inside one cell").
//
// The other half -- that the resolved table is what the elided premises imply, over
// a whole exchange -- is end to end, and psiLinkManyToOne.test.ts and
// singlePassFanOut.test.ts carry it: their deduplicating-sender cases drive the
// fixed-width and the ragged layout through the real strategy and pin the table.

// One round's cells for one party: each row's candidate value indices, in the order
// the round reads them.
type RoundCells = Array<Array<number>>;

interface Round {
  readonly cells: RoundCells;
  readonly numRecords: number;
  readonly outOfCandidacy: Array<number>;
}

// What the sweep did to the sender's cells: the rows it asked a width of (which it
// does for every row still in candidacy, and no other), and every (row, value) pair
// it read off them.
interface SweepReads {
  readonly countedRows: Set<number>;
  readonly pairs: Array<{ row: number; value: number }>;
}

function cellsView(cells: RoundCells) {
  return {
    count: (row: number) => cells[row].length,
    valueAt: (row: number, k: number) => cells[row][k],
  };
}

function recordingView(cells: RoundCells, into: SweepReads) {
  return {
    count: (row: number) => {
      into.countedRows.add(row);
      return cells[row].length;
    },
    valueAt: (row: number, k: number) => {
      const value = cells[row][k];
      into.pairs.push({ row, value });
      return value;
    },
  };
}

function emptyCells(numRecords: number): RoundCells {
  return Array.from({ length: numRecords }, () => []);
}

function candidacyFlags(round: Round): Uint8Array {
  const out = new Uint8Array(round.numRecords);
  for (const row of round.outOfCandidacy) out[row] = 1;
  return out;
}

// Value indices reserved for the knockout round, disjoint from the corpus alphabet
// so nothing it matches can collide with the round under test.
const KNOCKOUT_BASE = 1000;

/**
 * Replay `round` as the second round of a real single-pass cascade whose sender
 * keeps its duplicates, and return what the sweep read off the sender's cells.
 *
 * The first round hands each row the corpus wants out of candidacy a value of its
 * own that the receiver also holds, so the sweep pairs it and the cascade's removal
 * step takes it out; a row the corpus leaves in candidacy contributes nothing to
 * that round and survives it. The second round's receiver is empty, so it resolves
 * nothing -- the sweep still walks the sender's rows and reads their cells, which is
 * the whole of what this measures.
 */
function sweepReadsOf(round: Round): SweepReads {
  const knocked = new Set(round.outOfCandidacy);
  const knockoutSender: RoundCells = [];
  const knockoutReceiver: RoundCells = [];
  const matchedValues = new Map<number, number>();
  for (let row = 0; row < round.numRecords; ++row) {
    const value = KNOCKOUT_BASE + row;
    knockoutSender.push(knocked.has(row) ? [value] : []);
    knockoutReceiver.push(knocked.has(row) ? [value] : []);
    matchedValues.set(value, value);
  }
  const reads: SweepReads = { countedRows: new Set(), pairs: [] };
  replaySinglePassCascade(
    [cellsView(knockoutReceiver), cellsView(emptyCells(round.numRecords))],
    [cellsView(knockoutSender), recordingView(round.cells, reads)],
    matchedValues,
    round.numRecords,
    round.numRecords,
    { localKeepsDuplicates: false, partnerKeepsDuplicates: true },
  );
  return reads;
}

function roundOf(cells: RoundCells, outOfCandidacy: Array<number> = []): Round {
  return { cells, numRecords: cells.length, outOfCandidacy };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small value alphabet against a widish row count, so values recur across rows
// rather than by luck, and a fifth of the rows sit the round out.
function randomRounds(count: number): Array<Round> {
  const rand = mulberry32(0x5eed1234);
  const rounds: Array<Round> = [];
  for (let c = 0; c < count; ++c) {
    const numRecords = 1 + Math.floor(rand() * 6);
    const alphabet = 1 + Math.floor(rand() * 5);
    const cells: RoundCells = [];
    const outOfCandidacy: Array<number> = [];
    for (let row = 0; row < numRecords; ++row) {
      const chosen = new Set<number>();
      const width = Math.floor(rand() * 4);
      for (let k = 0; k < width; ++k) chosen.add(Math.floor(rand() * alphabet));
      const cell = [...chosen].sort((a, b) => a - b);
      if (cell.length > 0 && rand() < 0.1) cell.push(cell[cell.length - 1]);
      cells.push(cell);
      if (rand() < 0.2) outOfCandidacy.push(row);
    }
    rounds.push(roundOf(cells, outOfCandidacy));
  }
  return rounds;
}

const CORPUS: Array<Round> = [
  // The shapes worth naming, ahead of the generated ones.
  roundOf([[0], [0], [1]]), // a value on two candidate rows
  roundOf([[0, 0]]), // one row holding one value twice
  roundOf([[], [3]]), // a row contributing nothing to the round
  roundOf([[0], [0]], [0]), // the row that made a value recur has left candidacy
  roundOf([[0], [1]], [0, 1]), // no row left in candidacy at all
  ...randomRounds(4000),
];

const SWEEPS = CORPUS.map((round) => ({ round, reads: sweepReadsOf(round) }));

describe("the round-value participation question a deduplicating sender does not ask", () => {
  test("the sweep reaches exactly the rows the round leaves in candidacy", () => {
    // The premise the differential rests on: the candidacy each round below is
    // measured against is the one the cascade itself resolved, so a sweep that
    // reached past it -- an out-of-candidacy row's cells, a row list the round did
    // not put it in -- fails here rather than passing unnoticed.
    const disagreeing: Array<{
      cells: RoundCells;
      inCandidacy: Array<number>;
      widthAsked: Array<number>;
      valuesReadFrom: Array<number>;
    }> = [];
    for (const { round, reads } of SWEEPS) {
      const out = candidacyFlags(round);
      const inCandidacy: Array<number> = [];
      for (let row = 0; row < round.numRecords; ++row)
        if (!out[row]) inCandidacy.push(row);
      const widthAsked = [...reads.countedRows].sort((a, b) => a - b);
      const valuesReadFrom = [
        ...new Set(reads.pairs.map(({ row }) => row)),
      ].sort((a, b) => a - b);
      if (
        widthAsked.join() !== inCandidacy.join() ||
        valuesReadFrom.some((row) => out[row] === 1)
      )
        disagreeing.push({
          cells: round.cells,
          inCandidacy,
          widthAsked,
          valuesReadFrom,
        });
    }
    expect(disagreeing).toStrictEqual([]);
  });

  test("answers yes for every pair the sweep reads", () => {
    let asked = 0;
    let answeredNo = 0;
    for (const { round, reads } of SWEEPS) {
      // The form the elided branch would have built: the round's own first pass,
      // asked only whether ANY candidate row holds the value, since a sender that
      // keeps its duplicates deletes none of them.
      const { firstRow } = roundValueFirstRows(
        cellsView(round.cells),
        round.numRecords,
        candidacyFlags(round),
      );
      for (const { value } of reads.pairs) {
        asked += 1;
        if (!firstRow.has(value)) answeredNo += 1;
      }
    }
    expect(answeredNo).toBe(0);
    expect(asked).toBeGreaterThan(10000);
  });

  test("the corpus tells the two answers apart, so the agreement above is not vacuous", () => {
    // The same pairs put to the form a sender that DROPS its duplicates builds: no
    // wherever a value sits on more than one candidate row.
    let answeredNo = 0;
    for (const { round, reads } of SWEEPS) {
      const participation = RoundValueParticipation.forRound(
        cellsView(round.cells),
        round.numRecords,
        candidacyFlags(round),
      );
      for (const { row, value } of reads.pairs)
        if (!participation.holds(value, row)) answeredNo += 1;
    }
    expect(answeredNo).toBeGreaterThan(0);
  });

  test("the corpus carries the shapes that question was built for", () => {
    // Counted over what the sweep actually reached rather than over the fixtures,
    // so a round whose shape never reaches the sweep counts for nothing.
    let withRecurringValue = 0;
    let withRowOutOfCandidacy = 0;
    let withMultiValuedRow = 0;
    for (const { round, reads } of SWEEPS) {
      if (reads.pairs.length === 0) continue;
      const { recurring } = roundValueFirstRows(
        cellsView(round.cells),
        round.numRecords,
        candidacyFlags(round),
      );
      if (recurring.size > 0) withRecurringValue += 1;
      if (round.outOfCandidacy.length > 0) withRowOutOfCandidacy += 1;
      const readsPerRow = new Map<number, number>();
      for (const { row } of reads.pairs)
        readsPerRow.set(row, (readsPerRow.get(row) ?? 0) + 1);
      if ([...readsPerRow.values()].some((count) => count > 1))
        withMultiValuedRow += 1;
    }
    expect(withRecurringValue).toBeGreaterThan(1000);
    expect(withRowOutOfCandidacy).toBeGreaterThan(1000);
    expect(withMultiValuedRow).toBeGreaterThan(1000);
  });
});
