import { describe, expect, test } from "vitest";

import { consoleAcquiredCsv } from "../../src/bench/consoleAcquiredCsv.js";

describe("consoleAcquiredCsv", () => {
  const profile = {
    fileName: "clients.csv",
    sizeBytes: 4096,
    columns: ["first_name", "last_name", "dob"],
    rowCount: 12408,
    dateInputFormat: "YYYY-MM-DD",
  };

  test("carries the profiled facts an authoring session needs, without the rows", () => {
    const acquired = consoleAcquiredCsv(profile);
    expect(acquired.fileName).toBe("clients.csv");
    expect(acquired.sizeBytes).toBe(4096);
    expect(acquired.columns).toEqual(["first_name", "last_name", "dob"]);
    expect(acquired.rowCount).toBe(12408);
    expect(acquired.dateInputFormat).toBe("YYYY-MM-DD");
  });

  test("a stray rawRows read throws in dev/test rather than reading empty", () => {
    const acquired = consoleAcquiredCsv(profile);
    // The throwing getter is the runtime half of the backstop: a consumer that has
    // not been moved onto the profile fails loud here instead of silently rendering
    // an empty preview or zero coverage.
    expect(() => acquired.rawRows).toThrow(/rawRows/);
  });
});
