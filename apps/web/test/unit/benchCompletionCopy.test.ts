import { describe, expect, test } from "vitest";

import {
  RECEIPT_MISSING_LEAD,
  RECEIPT_MISSING_NOTICE,
  completionOutcome,
} from "@bench/BenchRunSurface";

import type { RunOutputs } from "@bench/runOutputs";

const matched = (matchedRecordCount?: number): RunOutputs => ({
  kind: "matched",
  resultsUrl: "blob:results",
  matchedRecordCount,
});

const counted = (intersectionCount: number): RunOutputs => ({
  kind: "counted",
  intersectionCount,
  countReportedByPartner: false,
});

describe("completionOutcome", () => {
  test("names matched records only for a run that produced a matched table", () => {
    expect(completionOutcome(matched(1847))).toEqual({
      count: 1847,
      label: "matched records",
    });
    // The console's server-job path holds the result on the appliance and counts
    // no rows, so the headline states completion without inventing a figure.
    expect(completionOutcome(matched(undefined))).toBeUndefined();
  });

  test("names the count-only mode and leaves the figure to the inset", () => {
    // The count is the run's whole result and belongs where the result would be.
    // Stating it in the headline as well would print one number twice, and stating
    // it ONLY there would lose it on the recovery panel, which has no headline.
    const outcome = completionOutcome(counted(1847));
    expect(outcome).toEqual({ label: "count only" });
    expect(outcome?.count).toBeUndefined();
  });

  test("distinguishes a count-only run from a withheld one in the headline", () => {
    // A helper received nothing and a count-only party received exactly what its
    // terms promised, so the two must not read alike here either.
    expect(completionOutcome({ kind: "withheld" })).toBeUndefined();
    expect(completionOutcome(counted(0))).toEqual({ label: "count only" });
  });

  test("names nothing for a run with no outputs at all", () => {
    expect(completionOutcome(undefined)).toBeUndefined();
  });
});

describe("the missing-receipt copy", () => {
  test("states the absent artifact without unsettling the exchange", () => {
    expect(RECEIPT_MISSING_LEAD).toContain("no signed receipt");
    expect(RECEIPT_MISSING_NOTICE).toContain("holds none for it");
    // The exchange completed: the copy must not read as a failed run, and must
    // not send the operator to run it again for a receipt a re-run cannot
    // produce.
    expect(RECEIPT_MISSING_NOTICE).toContain("The exchange itself completed");
    expect(RECEIPT_MISSING_NOTICE).toContain("would not recover this receipt");
    expect(RECEIPT_MISSING_NOTICE).toContain("neither party can recreate one");
  });
});
