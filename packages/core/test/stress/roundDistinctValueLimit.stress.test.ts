import { expect, test } from "vitest";

import { RoundSetLimitError } from "../../src/errors";
import {
  MAX_ROUND_DISTINCT_VALUES,
  removeDuplicatesAndUndefineds,
} from "../../src/psi/link";

// The round's distinct-value bound at its real size: a V8 Map takes exactly
// MAX_ROUND_DISTINCT_VALUES entries, so the deduplication holds that many and
// refuses the next with its own refusal rather than the Map's RangeError.
// Several GB of heap and tens of seconds, which is why it is the opt-in tier.

test("a raw Map throws on the entry past the bound", () => {
  const map = new Map<number, number>();
  for (let i = 0; i < MAX_ROUND_DISTINCT_VALUES; i++) map.set(i, i);
  expect(() => map.set(MAX_ROUND_DISTINCT_VALUES, 0)).toThrow(RangeError);
});

test("the dropping deduplication holds the bound's worth of distinct values and refuses one more", () => {
  const values = Array.from({ length: MAX_ROUND_DISTINCT_VALUES + 1 }, (_, i) =>
    i.toString(36),
  );
  const last = values.pop()!;
  const [kept] = removeDuplicatesAndUndefineds(values);
  expect(kept.length).toBe(MAX_ROUND_DISTINCT_VALUES);
  values.push(last);
  expect(() => removeDuplicatesAndUndefineds(values)).toThrow(
    RoundSetLimitError,
  );
});
