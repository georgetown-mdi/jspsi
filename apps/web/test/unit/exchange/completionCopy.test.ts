import { describe, expect, test } from "vitest";

import {
  CERTIFICATE_MISMATCH_RECORD_NOTICE,
  COMPLETED_RECORD_NOTICE,
  COMPLETED_RECORD_PAGE_NOTICE,
  RECORD_UNANSWERED_LEAD,
  RECORD_UNANSWERED_NOTICE,
  TERMINATED_RECORD_KEYS_NOTICE,
  TERMINATED_RECORD_LEAD,
  TERMINATED_RECORD_NOTICE,
  TERMINATED_RECORD_PAGE_NOTICE,
  UNDESCRIBABLE_RECORD_LEAD,
  UNDESCRIBABLE_RECORD_NOTICE,
  recordPanelCopy,
} from "@exchange/RecordDownload";
import {
  PENDING_RECORD_CONFIRM_BODY,
  UNDESCRIBABLE_RECORD_CONFIRM_BODY,
  UNDESCRIBABLE_RECORD_CONFIRM_TITLE,
  UNKNOWN_RECORD_CONFIRM_BODY,
  UNKNOWN_RECORD_CONFIRM_TITLE,
  UNTAKEN_RECORD_CONFIRM_BODY,
  UNTAKEN_RECORD_CONFIRM_TITLE,
  completionClusterReport,
  completionOutcome,
  untakenRecordConfirm,
} from "@exchange/RunSurface";
import {
  RECEIPT_MISSING_LEAD,
  RECEIPT_MISSING_NOTICE,
  RECEIPT_UNANSWERED_LEAD,
  RECEIPT_UNANSWERED_NOTICE,
} from "@exchange/ReceiptDownload";

import { EXCHANGE_RECORD_OUTCOMES, describeEntityClusters } from "@alcove/core";

import type { ExchangeRecordOutcome } from "@alcove/core";
import type { RunOutputs } from "@psi/runOutputs";

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

const CLUSTERS = {
  clusterCount: 2,
  localRows: 3,
  partnerRows: 3,
  shapes: [
    { localRows: 2, partnerRows: 2, distinctValues: 2, clusters: 1 },
    { localRows: 1, partnerRows: 1, distinctValues: 1, clusters: 1 },
  ],
};

describe("completionClusterReport", () => {
  test("states core's own sentence for a run that grouped its result", () => {
    const grouped: RunOutputs = {
      kind: "matched",
      resultsUrl: "blob:results",
      matchedRecordCount: 5,
      entityClusters: CLUSTERS,
    };
    expect(completionClusterReport(grouped)).toBe(
      describeEntityClusters(CLUSTERS),
    );
  });

  test("states nothing where the run reported no grouping", () => {
    // A matched run under any cardinality but the both-sided one, the
    // server-job path that reads no table, a count-only run and a withheld one
    // all reach the panel with no summary, and it stays silent rather than
    // standing in a figure.
    expect(completionClusterReport(matched(5))).toBeUndefined();
    expect(completionClusterReport(counted(12))).toBeUndefined();
    expect(completionClusterReport({ kind: "withheld" })).toBeUndefined();
    expect(completionClusterReport(undefined)).toBeUndefined();
  });
});

describe("completionOutcome", () => {
  test("names matched records only for a run that produced a matched table", () => {
    expect(completionOutcome(matched(1847))).toEqual({
      count: 1847,
      label: "matched records",
    });
    // The console's server-job path holds the result locally and counts
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
    // terms promised, so the two must not look alike here either.
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

describe("the exchange-record copy", () => {
  test("the terminated lead leads with the disclosure, not the failure", () => {
    // The alert above already says the run stopped. What the operator would not
    // otherwise know -- and what the record is FOR -- is that this party's own data
    // had already gone out, whether or not anything came back, so the lead must not
    // be treated as one more restatement of the failure.
    expect(TERMINATED_RECORD_LEAD).toContain("already disclosed your data");
    expect(TERMINATED_RECORD_LEAD).toContain("record of that disclosure");
  });

  test("the terminated notice names the accounting use and the destruction", () => {
    // Two things the operator can act on: what the file is good for, and that
    // every control on this surface removes it.
    expect(TERMINATED_RECORD_NOTICE).toContain("disclosure accounting");
    expect(TERMINATED_RECORD_NOTICE).toContain("Download it now");
    expect(TERMINATED_RECORD_NOTICE).toContain("removes this run's files");
    expect(TERMINATED_RECORD_NOTICE).toContain("still happened");
    // It stands on the run seats and on the compact recovery panel, whose controls
    // are worded differently, so it names no control by its label.
    expect(TERMINATED_RECORD_NOTICE).not.toMatch(/"Try again"|"Discard"/);
  });

  test("the terminated keys notice states what the pair cannot do", () => {
    // A terminated run wrote no result file, and all three of the record's
    // commitments re-supply from one, so the keys beside it open nothing. The pair
    // otherwise looks exactly like a completed run's, which is why this is said at
    // the download rather than left to be discovered.
    expect(TERMINATED_RECORD_KEYS_NOTICE).toContain("nothing");
    expect(TERMINATED_RECORD_KEYS_NOTICE).toContain("to open");
    expect(TERMINATED_RECORD_KEYS_NOTICE).toContain("result");
    // What it does NOT do is write the record off: it still states the disclosure
    // and still pairs with a receipt the partner holds.
    expect(TERMINATED_RECORD_KEYS_NOTICE).toContain("still states what");
    expect(TERMINATED_RECORD_KEYS_NOTICE).toContain("keys private");
    // And the completed run's copy must not state the limitation, which does not
    // hold for it.
    expect(COMPLETED_RECORD_NOTICE).not.toContain("nothing to open");
  });

  test("the mismatch notice states the finding, not a cause of the stop", () => {
    // The record states the finding about the certificate and the outcome
    // separately, so the copy states what the run observed and leaves how the run
    // ended to the lead above it.
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).toContain(
      "not the one pinned for them",
    );
    // The doubt is over who received the disclosure, which is stronger than the
    // merely-unverified partner every other termination leaves, and the copy says
    // what to do about it.
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).toContain(
      "in doubt rather than simply unconfirmed",
    );
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).toContain(
      "possibly disclosed to someone other than the partner you pinned",
    );
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).toContain(
      "which certificate they hold",
    );
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).not.toMatch(
      /stopped|failed|ended|because/i,
    );
    // It names no certificate, no fingerprint, and no party the panel does not
    // already name, so the seat states nothing the record's marker does not.
    expect(CERTIFICATE_MISMATCH_RECORD_NOTICE).not.toMatch(
      /SHA256|fingerprint/i,
    );
  });

  test("the mismatch notice stands only where the record states one", () => {
    // It is read off the marker, on either outcome: a completed record that
    // states one says so too, and a record that states none leaves the panel
    // saying nothing about the partner's certificate -- a "no mismatch" line
    // would read as a confirmation the run never made.
    const offered = (
      outcome: ExchangeRecordOutcome,
      recordCertificateMismatchObserved: boolean,
    ) =>
      ({
        kind: "available",
        outcome,
        recordCertificateMismatchObserved,
        downloads: {
          recordUrl: "/api/jobs/job-1/record",
          recordFileName: "alcove-record.json",
          keysUrl: "/api/jobs/job-1/keys",
          keysFileName: "alcove-record.keys.json",
        },
      }) as const;

    for (const outcome of EXCHANGE_RECORD_OUTCOMES) {
      expect(recordPanelCopy(offered(outcome, true)).certificateMismatch).toBe(
        CERTIFICATE_MISMATCH_RECORD_NOTICE,
      );
      expect(
        recordPanelCopy(offered(outcome, false)).certificateMismatch,
      ).toBeUndefined();
    }
    // The states with no record reading behind them have no marker to state.
    expect(
      recordPanelCopy({ kind: "undescribable" }).certificateMismatch,
    ).toBeUndefined();
    expect(
      recordPanelCopy({ kind: "unanswered" }).certificateMismatch,
    ).toBeUndefined();
  });

  test("a record this page holds names the page, not a console, as what discards it", () => {
    // An in-browser run that failed holding a record offers it in the same panel
    // a console run's takes; the page is the only place that pair lives, so the
    // copy names leaving or re-running on the page as what discards it.
    const offered = (outcome: ExchangeRecordOutcome) =>
      ({
        kind: "available",
        outcome,
        recordCertificateMismatchObserved: false,
        downloads: {
          recordUrl: "blob:record",
          recordFileName: "alcove-record.json",
          keysUrl: "blob:keys",
          keysFileName: "alcove-record.keys.json",
        },
      }) as const;

    const terminated = recordPanelCopy(
      offered("receipt-swap-terminated"),
      "page",
    );
    expect(terminated.lead).toBe(TERMINATED_RECORD_LEAD);
    expect(terminated.notice).toBe(TERMINATED_RECORD_PAGE_NOTICE);
    const completed = recordPanelCopy(offered("completed"), "page");
    expect(completed.notice).toBe(COMPLETED_RECORD_PAGE_NOTICE);
    for (const copy of [terminated, completed]) {
      expect(copy.lead + copy.notice).not.toMatch(/console/i);
      expect(copy.notice).toContain("disclosure accounting");
      expect(copy.notice).toContain("leaving the page discards it");
    }
    expect(TERMINATED_RECORD_PAGE_NOTICE).toContain("Download it now");
    expect(TERMINATED_RECORD_PAGE_NOTICE).toContain("still happened");
    // The console default is unchanged.
    expect(recordPanelCopy(offered("receipt-swap-terminated")).notice).toBe(
      TERMINATED_RECORD_NOTICE,
    );
  });

  test("the unanswered copy states the silence conditionally", () => {
    // There is no "a record was requested" field to state an absence against --
    // whether one is owed depends on how far the run got -- so the copy states the
    // condition rather than asserting a record exists, and names what to avoid
    // meanwhile.
    expect(RECORD_UNANSWERED_LEAD).toContain("stopped answering");
    expect(RECORD_UNANSWERED_NOTICE).toContain("stopped asking");
    expect(RECORD_UNANSWERED_NOTICE).toContain("If this run got as far as");
    expect(RECORD_UNANSWERED_NOTICE).toContain("reload");
    expect(RECORD_UNANSWERED_NOTICE).toContain("keep the run");
  });

  test("the undescribable copy states the file, not what it records", () => {
    // The console holds a file it cannot read as a record, so the panel may
    // claim its presence and nothing else -- and since no download stands under
    // this copy, it has to say where the file is and that going on removes it.
    expect(UNDESCRIBABLE_RECORD_LEAD).toContain("cannot read as an exchange");
    expect(UNDESCRIBABLE_RECORD_NOTICE).toContain("working directory");
    expect(UNDESCRIBABLE_RECORD_NOTICE).toContain("No download is offered");
    expect(UNDESCRIBABLE_RECORD_NOTICE).toContain("removes this run's files");
    // What it must not do is assert the run's disclosure the way the offered
    // record's copy does: that reading is exactly what failed.
    expect(UNDESCRIBABLE_RECORD_NOTICE).not.toContain(
      "what this run disclosed",
    );
  });

  test("the untaken-record confirm names the loss and the way to avoid it", () => {
    // The confirm fires on a recovery the operator has already pressed, so it
    // earns its interruption only by naming what that press destroys and where the
    // file still is.
    expect(UNTAKEN_RECORD_CONFIRM_TITLE).toContain("exchange record");
    expect(UNTAKEN_RECORD_CONFIRM_BODY).toContain("disclosed your data before");
    expect(UNTAKEN_RECORD_CONFIRM_BODY).toContain("removes the run");
    expect(UNTAKEN_RECORD_CONFIRM_BODY).toContain(
      "neither party can recreate it",
    );
    expect(UNTAKEN_RECORD_CONFIRM_BODY).toContain("Download it");
  });

  test("the unknown-record confirm claims only what the silence supports", () => {
    // This one fires where nothing established a record at all, so it must not
    // borrow the copy that asserts one. It names the silence, the same
    // irreversibility, and the one move that turns the unknown back into an
    // answer.
    expect(UNKNOWN_RECORD_CONFIRM_TITLE).toContain("possible exchange record");
    expect(UNKNOWN_RECORD_CONFIRM_BODY).toContain("stopped answering");
    expect(UNKNOWN_RECORD_CONFIRM_BODY).toContain(
      "neither party can recreate it",
    );
    expect(UNKNOWN_RECORD_CONFIRM_BODY).toContain("Reload this page");
    expect(UNKNOWN_RECORD_CONFIRM_BODY).not.toContain("this console holds");
  });

  test("the undescribable confirm points at the file, having no download to point at", () => {
    // The other confirm that names a record points the operator at the panel's
    // download; there is none here, so this one has to name where the file sits.
    // And it claims only that a file is there -- not what it records, which is
    // the part the console could not read.
    expect(UNDESCRIBABLE_RECORD_CONFIRM_TITLE).toContain("exchange record");
    expect(UNDESCRIBABLE_RECORD_CONFIRM_BODY).toContain("cannot read");
    expect(UNDESCRIBABLE_RECORD_CONFIRM_BODY).toContain(
      "neither party can recreate it",
    );
    expect(UNDESCRIBABLE_RECORD_CONFIRM_BODY).toContain("working directory");
    expect(UNDESCRIBABLE_RECORD_CONFIRM_BODY).not.toContain("Download it");
  });

  test("the pending confirm says the asking is still running", () => {
    // Nothing has stopped answering while the ask is in flight, and the answer is
    // on its way to this page: the copy must not borrow the exhausted ask's
    // account of the silence, nor send the operator to a reload that would only
    // start the asking over.
    expect(PENDING_RECORD_CONFIRM_BODY).toContain("has not yet answered");
    expect(PENDING_RECORD_CONFIRM_BODY).toContain(
      "neither party can recreate it",
    );
    expect(PENDING_RECORD_CONFIRM_BODY).toContain("Wait for the answer");
    expect(PENDING_RECORD_CONFIRM_BODY).not.toContain("stopped answering");
    expect(PENDING_RECORD_CONFIRM_BODY).not.toContain("Reload this page");
    expect(PENDING_RECORD_CONFIRM_BODY).not.toContain("this console holds");
  });
});

describe("untakenRecordConfirm", () => {
  const downloads = {
    recordUrl: "/api/jobs/job-1/record",
    recordFileName: "alcove-record.json",
    keysUrl: "/api/jobs/job-1/keys",
    keysFileName: "alcove-record.keys.json",
  };

  test("confirms over a record the console says it holds", () => {
    expect(
      untakenRecordConfirm({
        kind: "available",
        outcome: "receipt-swap-terminated",
        recordCertificateMismatchObserved: false,
        downloads,
      }),
    ).toEqual({
      title: UNTAKEN_RECORD_CONFIRM_TITLE,
      body: UNTAKEN_RECORD_CONFIRM_BODY,
    });
  });

  test("confirms over a record the console holds and cannot read", () => {
    // Nothing downloads in this state, so the confirm is the only place the
    // operator is told a record file is standing in the folder they are about to
    // remove. Reading the console's denial as an absence here is the loss this
    // state exists to prevent.
    expect(untakenRecordConfirm({ kind: "undescribable" })).toEqual({
      title: UNDESCRIBABLE_RECORD_CONFIRM_TITLE,
      body: UNDESCRIBABLE_RECORD_CONFIRM_BODY,
    });
  });

  test("confirms over an ask that never answered, under its own copy", () => {
    // An exhausted ask established nothing, and a run that got as far as
    // sending its data owes a record whether or not the console said so -- so
    // the silence still buys a confirm, just not the one that asserts a record.
    expect(untakenRecordConfirm({ kind: "unanswered" })).toEqual({
      title: UNKNOWN_RECORD_CONFIRM_TITLE,
      body: UNKNOWN_RECORD_CONFIRM_BODY,
    });
  });

  test("confirms while the ask is still in flight, saying so", () => {
    // The window between a failure alert appearing and its record ask landing is
    // the whole of the ask's bound on the failure this exists for -- a console
    // that stopped answering -- and every recovery in that window DELETEs the
    // run's folder. An unresolved ask has established no less than an exhausted
    // one, so it confirms too, under copy about the asking rather than a silence.
    expect(untakenRecordConfirm({ kind: "asking" })).toEqual({
      title: UNKNOWN_RECORD_CONFIRM_TITLE,
      body: PENDING_RECORD_CONFIRM_BODY,
    });
  });

  test("does not confirm over the console's own not-available answer", () => {
    // `none` is the one definitive absence there is: the console answered and
    // holds no record, which is what a run that failed before disclosing looks
    // like. Interrupting there would spend the confirm on nothing.
    expect(untakenRecordConfirm({ kind: "none" })).toBeUndefined();
  });

  test("does not confirm where the seat put no ask at all", () => {
    // A browser run has no console job, so its recoveries destroy no record
    // anywhere and nothing was ever asked about one.
    expect(untakenRecordConfirm(undefined)).toBeUndefined();
  });
});
