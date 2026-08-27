import { describe, expect, test } from "vitest";

import {
  RECEIPT_MISSING_LEAD,
  RECEIPT_MISSING_NOTICE,
  RECEIPT_UNANSWERED_LEAD,
  RECEIPT_UNANSWERED_NOTICE,
} from "@bench/ReceiptDownload";
import { completionOutcome } from "@bench/BenchRunSurface";

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
  test("states the absent artifact without claiming an outcome", () => {
    expect(RECEIPT_MISSING_LEAD).toContain("no signed receipt");
    expect(RECEIPT_MISSING_NOTICE).toContain("holds none for it");
    // The control renders on any settled run, so the copy must hold for a run
    // that stopped before the signature swap as well as one that completed and
    // lost the file: it names when a receipt is written rather than asserting
    // this exchange finished.
    expect(RECEIPT_MISSING_NOTICE).not.toMatch(/exchange itself completed/);
    expect(RECEIPT_MISSING_NOTICE).toContain(
      "once both parties have exchanged signatures",
    );
    expect(RECEIPT_MISSING_NOTICE).toContain("stopped before that point");
    // It must not send the operator to run the exchange again for a receipt a
    // re-run cannot produce.
    expect(RECEIPT_MISSING_NOTICE).toContain(
      "produces a receipt for that run, not this one",
    );
    expect(RECEIPT_MISSING_NOTICE).toContain("neither party can recreate one");
  });

  test("the unanswered copy states the silence rather than the receipt", () => {
    // What the operator is owed at the bound is the fact that asking stopped --
    // an unanswered ask never said whether this run has a receipt, so the seat
    // can neither claim one nor report one absent, and it must name the action
    // that would destroy a receipt it cannot see.
    expect(RECEIPT_UNANSWERED_LEAD).toContain("stopped answering");
    expect(RECEIPT_UNANSWERED_NOTICE).toContain("stopped asking");
    expect(RECEIPT_UNANSWERED_NOTICE).toContain("may still be");
    expect(RECEIPT_UNANSWERED_NOTICE).toContain("reload");
    expect(RECEIPT_UNANSWERED_NOTICE).toContain("keep the run");
    expect(RECEIPT_UNANSWERED_NOTICE).not.toContain(RECEIPT_MISSING_LEAD);
    expect(RECEIPT_UNANSWERED_NOTICE).not.toContain("holds none");
  });
});
