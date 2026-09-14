import { describe, expect, test } from "vitest";

import {
  NO_PARKED_RESULTS_NOTE,
  PARKED_RESULTS_RETENTION_NOTE,
  PARKED_RESULTS_SCHEDULE_NOTE,
  UNREADABLE_PARKED_RESULTS_NOTE,
  parkedResultsRows,
} from "../../../src/recurring/parkedResultsModel.js";
import {
  PARKED_RESULTS_RETENTION_DAYS,
  PARKED_RESULTS_VERSION,
} from "../../../src/psi/parkedResults.js";
import { dateTimeLabel } from "../../../src/psi/formatting.js";

import type { ParkedResults } from "../../../src/psi/parkedResults.js";

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

describe("what the operator is told about keeping results here", () => {
  const days = `${String(PARKED_RESULTS_RETENTION_DAYS)} days`;

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
    expect(UNREADABLE_PARKED_RESULTS_NOTE).toContain("Deleting the exchange");
  });

  test("the empty state says nothing was left, not that nothing is known", () => {
    expect(NO_PARKED_RESULTS_NOTE).toContain(
      "No scheduled run has left results",
    );
  });
});
