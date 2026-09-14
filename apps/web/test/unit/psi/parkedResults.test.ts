import { describe, expect, test } from "vitest";

import {
  PARKED_RESULTS_RETENTION_DAYS,
  PARKED_RESULTS_VERSION,
  appendParkedResults,
  parkedResultsExpiryMs,
  parkedResultsFileName,
  parseParkedResults,
  retainParkedResults,
} from "../../../src/psi/parkedResults.js";

import type {
  ParkedResults,
  ParkedRunResults,
} from "../../../src/psi/parkedResults.js";

/**
 * The shape, the retention rule, and the append of what a scheduled run leaves
 * for the operator's next visit. The IndexedDB half that applies these is
 * exercised against real Chromium in test/browser/managedExchangeStore.test.ts.
 */

const DAY_MS = 86_400_000;
const RUN_AT = "2026-03-01T09:00:00.000Z";

function parked(runAt = RUN_AT): ParkedRunResults {
  return {
    kind: "results",
    runAt,
    fileName: parkedResultsFileName(runAt),
    csv: new Blob(["id,value\n1,a\n"], { type: "text/csv" }),
    matchedRecordCount: 1,
  };
}

function results(...entries: ParkedResults["entries"]): ParkedResults {
  return { version: PARKED_RESULTS_VERSION, entries };
}

describe("what a stored set of parked results admits", () => {
  test("round-trips a parked run and a refused one", () => {
    const value = results(parked(), {
      kind: "storage-refused",
      runAt: "2026-03-08T09:00:00.000Z",
    });
    expect(parseParkedResults(value)).toEqual(value);
  });

  test("rejects an unrecognized version rather than migrating it", () => {
    expect(() =>
      parseParkedResults({
        version: "psilink-parked-results/v2",
        entries: [],
      }),
    ).toThrow();
  });

  test("rejects an unknown key, in the envelope and in an entry", () => {
    expect(() =>
      parseParkedResults({ ...results(), retainedUntil: "whenever" }),
    ).toThrow();
    expect(() =>
      parseParkedResults(
        results({ ...parked(), partnerName: "Riverbend" } as never),
      ),
    ).toThrow();
  });

  test("rejects an entry whose results are not bytes this build can hand over", () => {
    // The stored CSV is a Blob and nothing else: a string would download as a
    // file of the word rather than the results, and there is no reading of it
    // that recovers the run.
    expect(() =>
      parseParkedResults(results({ ...parked(), csv: "id,value" } as never)),
    ).toThrow();
  });

  test("rejects a run instant that is not one, so nothing unplaceable is offered", () => {
    expect(() =>
      parseParkedResults(results({ ...parked(), runAt: "last Tuesday" })),
    ).toThrow();
  });
});

describe("the retention the surface states", () => {
  const runAtMs = Date.parse(RUN_AT);

  test("is counted from the run itself", () => {
    expect(parkedResultsExpiryMs(parked())).toBe(
      runAtMs + PARKED_RESULTS_RETENTION_DAYS * DAY_MS,
    );
  });

  test("keeps an entry up to it and drops it past it, on every application", () => {
    const value = results(parked());
    const expiry = runAtMs + PARKED_RESULTS_RETENTION_DAYS * DAY_MS;
    expect(retainParkedResults(value, expiry - 1).entries).toHaveLength(1);
    expect(retainParkedResults(value, expiry).entries).toHaveLength(0);
    expect(retainParkedResults(value, expiry + DAY_MS).entries).toHaveLength(0);
  });

  test("holds the refused state exactly as long as results themselves", () => {
    // The state is what the operator meets in place of the results, so it goes
    // when they would have: leaving it longer would report a run as unstored
    // after every other run had aged out.
    const refusal = results({ kind: "storage-refused", runAt: RUN_AT });
    const expiry = runAtMs + PARKED_RESULTS_RETENTION_DAYS * DAY_MS;
    expect(retainParkedResults(refusal, expiry - 1).entries).toHaveLength(1);
    expect(retainParkedResults(refusal, expiry).entries).toHaveLength(0);
  });

  test("drops an entry whose run instant can be held to no retention at all", () => {
    // A bare-offset instant is read differently on every machine, so the schema
    // admits only a UTC designator; a value that slipped past it is content at
    // rest nothing bounds, which is the one outcome the rule exists to prevent.
    const undatable = results({
      ...parked(),
      runAt: "2026-03-01T09:00:00.000+05:00",
    });
    expect(retainParkedResults(undatable, Date.parse(RUN_AT)).entries).toEqual(
      [],
    );
  });

  test("returns the same set untouched when nothing has aged out", () => {
    const value = results(parked());
    expect(retainParkedResults(value, runAtMs + DAY_MS)).toBe(value);
  });
});

describe("adding a run's entry", () => {
  test("starts a set where there is none, and keeps run order", () => {
    const first = appendParkedResults(undefined, parked());
    const second = appendParkedResults(
      first,
      parked("2026-03-08T09:00:00.000Z"),
    );
    expect(second.entries.map((entry) => entry.runAt)).toEqual([
      RUN_AT,
      "2026-03-08T09:00:00.000Z",
    ]);
  });

  test("replaces the entry for a run already recorded, so one run leaves one row", () => {
    const parkedRun = appendParkedResults(undefined, parked());
    const refused = appendParkedResults(parkedRun, {
      kind: "storage-refused",
      runAt: RUN_AT,
    });
    expect(refused.entries).toEqual([
      { kind: "storage-refused", runAt: RUN_AT },
    ]);
  });
});

describe("the name a parked result downloads under", () => {
  test("stamps the run, so two runs' results do not collide", () => {
    expect(parkedResultsFileName(RUN_AT)).toBe(
      "psilink-results-2026-03-01T09-00-00-000Z.csv",
    );
    expect(parkedResultsFileName("2026-03-08T09:00:00.000Z")).not.toBe(
      parkedResultsFileName(RUN_AT),
    );
  });
});
