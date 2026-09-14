import { describe, expect, test } from "vitest";

import { MAX_CSV_FILE_BYTES } from "../../../src/components/csvIntake.js";

import {
  MAX_PARKED_RESULT_BYTES,
  RESULT_BYTES_PER_PAIR,
  projectedPairs,
  projectedResultBytes,
  projectionOverParkedBound,
  resultFitsParkedBound,
} from "../../../src/psi/resultSizeProjection.js";

/**
 * The size a scheduled run's results are projected at, and the size above which
 * this browser keeps none of them. What matters here is that both follow from
 * figures held elsewhere -- the intake cap and the writer's measured cost per
 * pair -- rather than from literals of their own.
 */

describe("the size a parked result is bounded by", () => {
  test("is the CSV intake cap itself, not a second figure", () => {
    // The derivation, pinned: raising what this app will read raises what it
    // will keep, in the same edit. A bound restated as a literal fails here even
    // where the two happen to be equal today.
    expect(MAX_PARKED_RESULT_BYTES).toBe(MAX_CSV_FILE_BYTES);
  });

  test("keeps a result at the bound and refuses one past it", () => {
    expect(resultFitsParkedBound(MAX_PARKED_RESULT_BYTES)).toBe(true);
    expect(resultFitsParkedBound(MAX_PARKED_RESULT_BYTES + 1)).toBe(false);
    expect(resultFitsParkedBound(0)).toBe(true);
  });
});

describe("the cost a projection multiplies", () => {
  test("is inside the widest result shape docs/spec/PROTOCOL.md measures", () => {
    // 32 to 41 bytes per pair for a result holding a UUID identifier or three
    // payload columns ("The both-sided expansion has no ceiling of its own").
    // The projection takes the widest of the measured shapes, so it reaches the
    // bound while a narrower result of the same pair count still fits.
    expect(RESULT_BYTES_PER_PAIR).toBeGreaterThanOrEqual(32);
    expect(RESULT_BYTES_PER_PAIR).toBeLessThanOrEqual(41);
  });
});

describe("what two declared record counts project", () => {
  test("multiplies the counts and then the cost per pair", () => {
    const factors = { local: 12_000, partner: 9_000 };
    expect(projectedPairs(factors)).toBe(108_000_000n);
    expect(projectedResultBytes(factors)).toBe(
      108_000_000n * BigInt(RESULT_BYTES_PER_PAIR),
    );
  });

  test("holds a product past the safe-integer range exactly", () => {
    // Both counts are bounded by what the terms exchange admits, and their
    // product runs past what a `number` represents, which is why the projection
    // is arithmetic over `bigint`.
    const huge = { local: 1_000_000_000_000, partner: 1_000_000_000_000 };
    expect(projectedPairs(huge)).toBe(10n ** 24n);
    expect(projectionOverParkedBound(huge)).toBe(true);
  });

  test("warns exactly where the projected file passes the bound", () => {
    const pairsAtBound = Math.floor(
      MAX_PARKED_RESULT_BYTES / RESULT_BYTES_PER_PAIR,
    );
    expect(projectionOverParkedBound({ local: pairsAtBound, partner: 1 })).toBe(
      false,
    );
    expect(
      projectionOverParkedBound({ local: pairsAtBound + 1, partner: 1 }),
    ).toBe(true);
  });

  test("puts no projection on a run whose counts multiply to nothing", () => {
    expect(projectionOverParkedBound({ local: 0, partner: 5_000_000 })).toBe(
      false,
    );
  });
});
