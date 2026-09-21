import { describe, expect, test } from "vitest";

import {
  CLEAR_PARKED_RESULTS_NOTE,
  NO_PARKED_RESULTS_NOTE,
  PARKED_RESULTS_RETENTION_NOTE,
  PARKED_RESULTS_SCHEDULE_NOTE,
  UNREADABLE_PARKED_RESULTS_NOTE,
  parkedResultsRows,
  projectedResultSizeWarning,
} from "../../../src/recurring/parkedResultsModel.js";
import {
  MAX_PARKED_RESULT_BYTES,
  RESULT_BYTES_PER_PAIR,
} from "../../../src/psi/resultSizeProjection.js";
import {
  PARKED_RESULTS_RETENTION_DAYS,
  PARKED_RESULTS_VERSION,
} from "../../../src/psi/parkedResults.js";
import { dateTimeLabel } from "../../../src/psi/formatting.js";

import type {
  ParkedResults,
  ParkedResultsFallback,
} from "../../../src/psi/parkedResults.js";

const DAY_MS = 86_400_000;

/**
 * What the operator reads about results a scheduled run left here: the row per
 * run, and the two statements the app owes them -- one before they schedule, one
 * where they collect.
 */

const EARLIER = "2026-03-01T09:00:00.000Z";
const LATER = "2026-03-08T09:00:00.000Z";

function results(): ParkedResults {
  return {
    version: PARKED_RESULTS_VERSION,
    entries: [
      {
        kind: "results",
        runAt: EARLIER,
        fileName: "psilink-results-earlier.csv",
        csv: new Blob(["id\n1\n"], { type: "text/csv" }),
        matchedRecordCount: 42,
      },
      { kind: "storage-refused", runAt: LATER },
    ],
  };
}

describe("the rows a returning operator reads", () => {
  test("put the most recent run first", () => {
    expect(parkedResultsRows(results()).map((row) => row.runAt)).toEqual([
      LATER,
      EARLIER,
    ]);
  });

  test("state the matched count of results that are there", () => {
    const row = parkedResultsRows(results())[1];
    expect(row.summary).toContain("42 matched records");
    expect(row.entry.kind).toBe("results");
  });

  test("state a refusal as the run standing and the results gone, not a failed run", () => {
    const row = parkedResultsRows(results())[0];
    expect(row.summary).toContain("would not store");
    expect(row.summary).toContain("completed and filed its disclosure");
  });

  test("show each run's own removal date, the retention counted from its run", () => {
    const [refused, parked] = parkedResultsRows(results());
    // A week between the runs is a week between their removals: the retention is
    // per entry, not one date for the whole set.
    expect(parked.until).toBe(
      dateTimeLabel(
        new Date(Date.parse(EARLIER) + PARKED_RESULTS_RETENTION_DAYS * DAY_MS),
      ),
    );
    expect(refused.until).toBe(
      dateTimeLabel(
        new Date(Date.parse(LATER) + PARKED_RESULTS_RETENTION_DAYS * DAY_MS),
      ),
    );
  });

  test("count one matched record as one", () => {
    const rows = parkedResultsRows({
      version: PARKED_RESULTS_VERSION,
      entries: [
        {
          kind: "results",
          runAt: EARLIER,
          fileName: "psilink-results-earlier.csv",
          csv: new Blob(["id\n1\n"]),
          matchedRecordCount: 1,
        },
      ],
    });
    expect(rows[0].summary).toContain("1 matched record,");
  });
});

describe("the row shown for a run written to the granted folder", () => {
  function written(fallback?: "ungranted" | "write-failed"): ParkedResults {
    return {
      version: PARKED_RESULTS_VERSION,
      entries: [
        fallback === undefined
          ? {
              kind: "written",
              runAt: EARLIER,
              fileName: "psilink-results-earlier.csv",
              directoryName: "Riverbend results",
              matchedRecordCount: 42,
            }
          : {
              kind: "results",
              runAt: EARLIER,
              fileName: "psilink-results-earlier.csv",
              csv: new Blob(["id\n1\n"], { type: "text/csv" }),
              matchedRecordCount: 42,
              fallback,
            },
      ],
    };
  }

  test("says where the results went, and that none of them are kept here", () => {
    const row = parkedResultsRows(written())[0];
    expect(row.summary).toContain("42 matched records");
    expect(row.summary).toContain("psilink-results-earlier.csv");
    expect(row.summary).toContain("Riverbend results");
    expect(row.summary).toContain("Nothing of them is kept in this browser");
  });

  test("states a sentence where the run reported no count", () => {
    const row = parkedResultsRows({
      version: PARKED_RESULTS_VERSION,
      entries: [
        {
          kind: "written",
          runAt: EARLIER,
          fileName: "psilink-results-earlier.csv",
          directoryName: "Riverbend results",
        },
      ],
    })[0];
    expect(row.summary).toBe(
      "Results were written to psilink-results-earlier.csv in the folder you " +
        "granted (Riverbend results). Nothing of them is kept in this browser.",
    );
  });

  test("names why a granted folder did not take them, rather than reading as a plain success", () => {
    const ungranted = parkedResultsRows(written("ungranted"))[0].summary;
    expect(ungranted).toContain("ready to download");
    expect(ungranted).toContain("without asking you");
    expect(ungranted).toContain("Granting the folder again");

    const failed = parkedResultsRows(written("write-failed"))[0].summary;
    expect(failed).toContain("Writing to the folder you granted failed");
    expect(failed).toContain("still exists");
  });

  test("says nothing about a folder for results kept here with no grant held", () => {
    const row = parkedResultsRows(results())[1];
    expect(row.summary).toBe("42 matched records, ready to download.");
  });
});

describe("the row shown for a run too large to keep", () => {
  function tooLarge(
    matchedRecordCount?: number,
    fallback?: ParkedResultsFallback,
  ): ParkedResults {
    return {
      version: PARKED_RESULTS_VERSION,
      entries: [
        {
          kind: "too-large",
          runAt: EARLIER,
          resultBytes: 210 * 1024 ** 2,
          ...(matchedRecordCount !== undefined ? { matchedRecordCount } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
        },
      ],
    };
  }

  test("names the size, that nothing was kept or cut down, and the folder", () => {
    const summary = parkedResultsRows(tooLarge(4_000_000))[0].summary;
    expect(summary).toContain("4,000,000 matched records");
    expect(summary).toContain("210.0 MB");
    expect(summary).toContain("100.0 MB this browser keeps");
    expect(summary).toContain("none of them were kept here");
    expect(summary).toContain("none were cut down to fit");
    expect(summary).toContain("Choose a folder");
  });

  test("states no folder chosen yet where the run held no grant", () => {
    const summary = parkedResultsRows(tooLarge())[0].summary;
    expect(summary).toContain("No folder is granted");
    expect(summary).toContain("Choose a folder");
  });

  test("states a grant the run could not use unattended, and asks for it again", () => {
    const summary = parkedResultsRows(tooLarge(undefined, "ungranted"))[0]
      .summary;
    expect(summary).toContain("could not be written to without asking you");
    expect(summary).toContain("Grant the folder again");
    expect(summary).not.toContain("No folder is granted");
  });

  test("states a write that failed, and what to check about the folder", () => {
    const summary = parkedResultsRows(tooLarge(undefined, "write-failed"))[0]
      .summary;
    expect(summary).toContain("Writing to the folder you granted failed");
    expect(summary).toContain("still exists and has room");
    expect(summary).not.toContain("Choose a folder");
  });

  test("states the run itself as standing, so it is not read as a failed run", () => {
    expect(parkedResultsRows(tooLarge())[0].summary).toContain(
      "The run itself completed and filed its disclosure",
    );
  });

  test("offers no download, the entry holding no part of the results", () => {
    expect(parkedResultsRows(tooLarge())[0].entry.kind).toBe("too-large");
  });
});

describe("the warning a projected result size raises", () => {
  /** A set of parked results whose newest entry holds the counts a run declared,
   * which is what a projection of the next run's result size is drawn from. */
  function declaring(local: number, partner: number): ParkedResults {
    return {
      version: PARKED_RESULTS_VERSION,
      entries: [
        {
          kind: "results",
          runAt: EARLIER,
          fileName: "psilink-results-earlier.csv",
          csv: new Blob(["id\n1\n"], { type: "text/csv" }),
          pairTableFactors: { local, partner },
        },
        { kind: "storage-refused", runAt: LATER },
      ],
    };
  }

  /** Two counts whose product projects a result past the bound. */
  const over = Math.ceil(
    Math.sqrt(MAX_PARKED_RESULT_BYTES / RESULT_BYTES_PER_PAIR) + 1,
  );

  test("names both declared counts, the pairs they project, and the bound", () => {
    const warning = projectedResultSizeWarning(declaring(12_000, 9_000), false);
    expect(warning).toContain("12,000 records");
    expect(warning).toContain("9,000");
    expect(warning).toContain("108,000,000 matched pairs");
    expect(warning).toContain("100.0 MB this browser keeps");
    expect(warning).toContain("nothing here");
  });

  test("states the figure as the most the terms allow, not what the run will match", () => {
    // The projection is the worst case: it reaches the bound while a narrower
    // result of the same pair count still fits, so the warning may not read as
    // a prediction of the next run.
    const warning = projectedResultSizeWarning(declaring(12_000, 9_000), false);
    expect(warning).toContain("the most these terms allow");
    expect(warning).toContain("may leave a result that fits");
  });

  test("offers the folder grant as the remedy, and names the grant where one is held", () => {
    expect(projectedResultSizeWarning(declaring(over, over), false)).toContain(
      "Choose a folder for this exchange's results",
    );
    const granted = projectedResultSizeWarning(declaring(over, over), true);
    expect(granted).toContain("folder you granted");
    expect(granted).not.toContain("Choose a folder");
  });

  test("is silent where the projection is inside the bound", () => {
    expect(
      projectedResultSizeWarning(declaring(over - 2, over - 2), false),
    ).toBeUndefined();
  });

  test("is silent where no run left counts to project from", () => {
    expect(projectedResultSizeWarning(results(), false)).toBeUndefined();
    expect(projectedResultSizeWarning(undefined, false)).toBeUndefined();
  });

  test("reads the most recent run that declared counts, not the oldest", () => {
    const stale = declaring(over, over);
    const fresh: ParkedResults = {
      version: PARKED_RESULTS_VERSION,
      entries: [
        ...stale.entries,
        {
          kind: "too-large",
          runAt: "2026-03-15T09:00:00.000Z",
          resultBytes: 210 * 1024 ** 2,
          pairTableFactors: { local: 2, partner: 2 },
        },
      ],
    };
    expect(projectedResultSizeWarning(fresh, false)).toBeUndefined();
  });
});

describe("what the operator is told about keeping results here", () => {
  const days = `${String(PARKED_RESULTS_RETENTION_DAYS)} days`;

  test("the schedule-entry statement states keeping results here as what happens without a folder", () => {
    // The grant is the path the surface offers first; this statement is what
    // happens without one, and whenever the granted folder cannot be written to.
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain("Without a folder");
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain(
      "the folder you granted cannot be written to",
    );
  });

  test("the schedule-entry statement names the content, the reach, and both removals", () => {
    // Every existing statement about what a managed exchange keeps at rest says
    // "never a row value". This one is the exception, so it has to say what it
    // is rather than leaning on that.
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain("matched rows");
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain("unencrypted");
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain(
      "any script running on this site",
    );
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain("disk");
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain(days);
    expect(PARKED_RESULTS_SCHEDULE_NOTE).toContain("deleting the exchange");
  });

  test("the collection statement names the same retention the store enforces", () => {
    expect(PARKED_RESULTS_RETENTION_NOTE).toContain(days);
    expect(PARKED_RESULTS_RETENTION_NOTE).toContain("deleting this exchange");
  });

  test.each([
    ["the schedule-entry statement", PARKED_RESULTS_SCHEDULE_NOTE],
    ["the collection statement", PARKED_RESULTS_RETENTION_NOTE],
  ])("%s names the clear as a removal the operator can take now", (_, note) => {
    // The control stands beside both statements, so a list of what removes
    // these results that omitted it would send the operator to the retention or
    // to deleting the exchange for something one click does.
    expect(note).toContain("Clearing what is kept here");
  });

  test.each([
    ["the schedule-entry statement", PARKED_RESULTS_SCHEDULE_NOTE],
    ["the collection statement", PARKED_RESULTS_RETENTION_NOTE],
  ])(
    "%s names a run that leaves results as the removal, not any run at all",
    (_name, note) => {
      // Only a run that writes to this exchange's kept results applies the
      // retention to them; a run that parks nothing leaves them where they are.
      expect(note).toContain("your next visit to this page");
      expect(note).toContain("a later run that leaves results of its own");
    },
  );

  test("the unreadable statement says what is stored is unknown, not that results are", () => {
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain(
      "this browser cannot read",
    );
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain(
      "whether any results are in it",
    );
    expect(UNREADABLE_PARKED_RESULTS_NOTE).not.toContain("Results are stored");
  });

  test("the unreadable statement says later runs can leave nothing while it is here", () => {
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain(
      "cannot leave its results or record that it could not",
    );
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain(
      "complete and file their disclosures",
    );
  });

  test("the unreadable statement names the clear, which is offered in that state", () => {
    // The clear control renders directly below this statement and removes the
    // value without reading it, so the statement may not send the operator to
    // the exchange delete as the only way out.
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain(
      "Clearing what is kept here removes it",
    );
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain("deleting the exchange");
    expect(UNREADABLE_PARKED_RESULTS_NOTE).not.toContain("only way");
  });

  test("the clear statement names everything that goes and what stays", () => {
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain("results kept in this browser");
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain("notes saying where results");
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain(
      "states recorded where results",
    );
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain("stay there");
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain("accounting of disclosures");
    expect(CLEAR_PARKED_RESULTS_NOTE).toContain("cannot be undone");
  });

  test("the empty state says nothing was left, not that nothing is known", () => {
    expect(NO_PARKED_RESULTS_NOTE).toContain(
      "No scheduled run has left anything here",
    );
    // Both routes a run's results can take, so the empty state is read against
    // what a run would do rather than as a bare blank.
    expect(NO_PARKED_RESULTS_NOTE).toContain("folder you granted");
    expect(NO_PARKED_RESULTS_NOTE).toContain("leaves the results here");
  });
});
