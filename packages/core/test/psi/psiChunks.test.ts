import { expect, test } from "vitest";

import {
  PSI_CHUNK_MIN_ELEMENTS,
  PSI_CHUNK_TARGET_COUNT,
  chunkRanges,
  chunkRangesOfSize,
  psiChunkCount,
  psiChunkRanges,
} from "../../src/psi/psiChunks";

// The sizing policy the engine splits an operation on. The two constants it
// derives from answer to costs outside this tree (psiChunks.ts states each),
// so what is pinned here is the shape they have to produce: a set small enough
// to finish quickly runs as the one call it always was, no chunk ever falls
// under the native addon's thread floor, and no operation is split more ways
// than the association table's per-chunk setup re-read can afford.

const coversEveryItemOnce = (
  total: number,
  ranges: ReturnType<typeof chunkRanges>,
): void => {
  expect(ranges[0]!.start).toBe(0);
  expect(ranges.at(-1)!.end).toBe(total);
  for (let index = 1; index < ranges.length; index += 1)
    expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
};

test.each([0, 1, 1000, PSI_CHUNK_MIN_ELEMENTS - 1, PSI_CHUNK_MIN_ELEMENTS])(
  "a set of %i takes one chunk, so it runs the single call unchanged",
  (total) => {
    expect(psiChunkCount(total)).toBe(1);
    expect(psiChunkRanges(total)).toStrictEqual([{ start: 0, end: total }]);
  },
);

test("no chunk ever falls below the native addon's thread floor", () => {
  for (const total of [
    PSI_CHUNK_MIN_ELEMENTS + 1,
    2 * PSI_CHUNK_MIN_ELEMENTS,
    3 * PSI_CHUNK_MIN_ELEMENTS - 1,
    41_000,
    100_000,
    3_000_000,
  ]) {
    const ranges = psiChunkRanges(total);
    coversEveryItemOnce(total, ranges);
    expect(ranges.length).toBeLessThanOrEqual(PSI_CHUNK_TARGET_COUNT);
    for (const range of ranges)
      expect(range.end - range.start).toBeGreaterThanOrEqual(
        PSI_CHUNK_MIN_ELEMENTS,
      );
  }
});

test("a set large enough to split takes the target chunk count", () => {
  expect(psiChunkRanges(100_000)).toHaveLength(PSI_CHUNK_TARGET_COUNT);
  expect(psiChunkRanges(2 * PSI_CHUNK_MIN_ELEMENTS)).toHaveLength(2);
});

test("a split covers every item exactly once, in sizes differing by one at most", () => {
  for (const count of [1, 2, 3, 5]) {
    const ranges = chunkRanges(23, count);
    expect(ranges).toHaveLength(count);
    coversEveryItemOnce(23, ranges);
    const sizes = ranges.map((range) => range.end - range.start);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  }
});

test("a caller-set chunk size splits into chunks no larger than it", () => {
  const ranges = chunkRangesOfSize(200, 40);
  expect(ranges).toHaveLength(5);
  coversEveryItemOnce(200, ranges);
  for (const range of ranges)
    expect(range.end - range.start).toBeLessThanOrEqual(40);
  expect(chunkRangesOfSize(7, 40)).toStrictEqual([{ start: 0, end: 7 }]);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "a chunk size of %p is refused by name rather than silently clamped",
  (size) => {
    // NaN survives Math.max and Math.ceil, so an unrefused one leaves the
    // split covering nothing and the engine serializing an empty message.
    expect(() => chunkRangesOfSize(200, size)).toThrow(/chunkElements/);
  },
);
