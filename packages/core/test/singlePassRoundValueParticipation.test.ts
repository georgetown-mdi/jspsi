import { describe, expect, test } from "vitest";

import { roundValueFirstRows } from "../src/link";

// The single-pass replay asks the sender's side of each round one question -- does
// the row the sweep has reached take part with this value (replaySinglePassCascade,
// packages/core/src/link.ts) -- and a sender that KEEPS its duplicates has a single
// answer to it. The sweep reads each value off the candidate row it has reached,
// and the round's first pass walked exactly those rows' cells, so every value it
// can ask about is one that side's round kept. A deduplicating sender therefore
// builds no participation form at all.
//
// That is a claim about what happens at runtime, so it is checked here rather than
// written down. Below is the question in the general form a side that must ask it
// builds -- both answers the incidence defines, over the first pass link.ts itself
// runs -- required to answer yes for every (row, value) pair the sweep can ask
// about, across a corpus of round shapes. A control asks the same corpus the OTHER
// side's answer, which must be no somewhere: a corpus that could not tell the two
// apart would pass the differential without saying anything.
//
// The other half -- that the sweep asks only about values read off rows still in
// candidacy -- is end to end, and psiLinkManyToOne.test.ts carries it: its
// single-pass cases drive both arrangements a deduplicating party can take through
// the real replay and require the table to match the cascade's.

// One round's cells for one party, the shape the sweep reads them through.
interface RoundCells {
  count(row: number): number;
  valueAt(row: number, k: number): number;
}

interface Round {
  readonly cells: RoundCells;
  readonly numRecords: number;
  readonly outOfCandidacy: Uint8Array;
}

// The participation question in the form that carries both answers: a side that
// keeps its duplicates takes part with every value the round kept, and a side that
// drops them only where it is the one candidate row holding the value
// (docs/spec/PROTOCOL.md, Value-level round participation).
class ParticipationQuestion {
  private constructor(
    private readonly firstRow: Map<number, number>,
    private readonly keepsDuplicates: boolean,
  ) {}

  static forRound(
    round: Round,
    keepsDuplicates: boolean,
  ): ParticipationQuestion {
    const { firstRow, recurring } = roundValueFirstRows(
      round.cells,
      round.numRecords,
      round.outOfCandidacy,
    );
    if (!keepsDuplicates) for (const value of recurring) firstRow.delete(value);
    return new ParticipationQuestion(firstRow, keepsDuplicates);
  }

  holds(value: number, row: number): boolean {
    return this.keepsDuplicates
      ? this.firstRow.has(value)
      : this.firstRow.get(value) === row;
  }
}

// Every (row, value) pair the sweep can ask about: it walks the rows still in
// candidacy, ascending, and reads each one's own cells.
function* askedPairs(round: Round): Generator<{ row: number; value: number }> {
  for (let row = 0; row < round.numRecords; ++row) {
    if (round.outOfCandidacy[row]) continue;
    const width = round.cells.count(row);
    for (let k = 0; k < width; ++k)
      yield { row, value: round.cells.valueAt(row, k) };
  }
}

function roundOf(
  cells: Array<Array<number>>,
  outOfCandidacy: Array<number> = [],
): Round {
  const out = new Uint8Array(cells.length);
  for (const row of outOfCandidacy) out[row] = 1;
  return {
    cells: {
      count: (row) => cells[row].length,
      valueAt: (row, k) => cells[row][k],
    },
    numRecords: cells.length,
    outOfCandidacy: out,
  };
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
    const cells: Array<Array<number>> = [];
    const outOfCandidacy: Array<number> = [];
    for (let row = 0; row < numRecords; ++row) {
      const chosen = new Set<number>();
      const width = Math.floor(rand() * 4);
      for (let k = 0; k < width; ++k) chosen.add(Math.floor(rand() * alphabet));
      const cell = [...chosen].sort((a, b) => a - b);
      // A candidate producer whose set did not collapse its repeats: a row can
      // hold one value twice.
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

function countAnsweredNo(keepsDuplicates: boolean): {
  asked: number;
  answeredNo: number;
} {
  let asked = 0;
  let answeredNo = 0;
  for (const round of CORPUS) {
    const question = ParticipationQuestion.forRound(round, keepsDuplicates);
    for (const { row, value } of askedPairs(round)) {
      asked += 1;
      if (!question.holds(value, row)) answeredNo += 1;
    }
  }
  return { asked, answeredNo };
}

describe("the round-value participation question a deduplicating sender does not ask", () => {
  test("answers yes for every pair the sweep can ask it", () => {
    const { asked, answeredNo } = countAnsweredNo(true);
    expect(answeredNo).toBe(0);
    expect(asked).toBeGreaterThan(10000);
  });

  test("the corpus tells the two answers apart, so the agreement above is not vacuous", () => {
    // The same pairs asked what a sender that DROPS its duplicates gets: no
    // wherever a value sits on more than one candidate row.
    const { answeredNo } = countAnsweredNo(false);
    expect(answeredNo).toBeGreaterThan(0);
  });

  test("the corpus carries the shapes that question was built for", () => {
    let withRecurringValue = 0;
    let withRowOutOfCandidacy = 0;
    let withMultiValuedRow = 0;
    for (const round of CORPUS) {
      const seen = new Set<number>();
      let recurring = false;
      let multiValued = false;
      for (let row = 0; row < round.numRecords; ++row) {
        const width = round.cells.count(row);
        if (width > 1) multiValued = true;
        if (round.outOfCandidacy[row]) continue;
        for (let k = 0; k < width; ++k) {
          const value = round.cells.valueAt(row, k);
          if (seen.has(value)) recurring = true;
          seen.add(value);
        }
      }
      if (recurring) withRecurringValue += 1;
      if (multiValued) withMultiValuedRow += 1;
      if (round.outOfCandidacy.includes(1)) withRowOutOfCandidacy += 1;
    }
    expect(withRecurringValue).toBeGreaterThan(1000);
    expect(withRowOutOfCandidacy).toBeGreaterThan(1000);
    expect(withMultiValuedRow).toBeGreaterThan(1000);
  });
});
