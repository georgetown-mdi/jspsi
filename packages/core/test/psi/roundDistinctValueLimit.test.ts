import { expect, test } from "vitest";

import { RoundSetLimitError } from "../../src/errors";
import {
  groupDuplicatesAndRemoveUndefineds,
  MAX_ROUND_DISTINCT_VALUES,
  removeDuplicatesAndUndefineds,
} from "../../src/psi/link";

import type { KeyCandidates } from "../../src/standardization";

// The round's deduplication refuses the distinct value past its bound rather
// than letting the Map behind it throw. The bound is lowered here; the run at
// the real bound is test/stress/roundDistinctValueLimit.stress.test.ts.

const LIMIT = 4;

// LIMIT distinct values, each held by two rows, one row holding a set.
const atLimit: Array<KeyCandidates> = [
  "a",
  "b",
  undefined,
  "a",
  "c",
  "b",
  new Set(["d", "c"]),
  "d",
];

test("the bound is the V8 Map entry limit", () => {
  expect(MAX_ROUND_DISTINCT_VALUES).toBe(2 ** 24);
});

test("dropping deduplication admits the bound's worth of distinct values and refuses one more", () => {
  expect(removeDuplicatesAndUndefineds(atLimit, undefined, LIMIT)).toEqual([
    [],
    [],
  ]);
  expect(() =>
    removeDuplicatesAndUndefineds([...atLimit, "e"], undefined, LIMIT),
  ).toThrow(RoundSetLimitError);
});

test("grouping deduplication admits the bound's worth of distinct values and refuses one more", () => {
  const [values] = groupDuplicatesAndRemoveUndefineds(
    atLimit,
    undefined,
    LIMIT,
  );
  expect(values).toEqual(["a", "b", "c", "d"]);
  expect(() =>
    groupDuplicatesAndRemoveUndefineds([...atLimit, "e"], undefined, LIMIT),
  ).toThrow(RoundSetLimitError);
});

test("the refusal names the bound and the remedy", () => {
  let refusal: unknown;
  try {
    removeDuplicatesAndUndefineds(["a", "b", "c"], undefined, 2);
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as Error).message).toMatch(
    /more than 2 distinct values in one round.*Split the input into smaller files/,
  );
});
