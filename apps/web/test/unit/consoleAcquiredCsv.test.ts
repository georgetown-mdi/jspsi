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

  test("rawRows is non-enumerable so framework reflection skips the throwing getter", () => {
    const acquired = consoleAcquiredCsv(profile);
    // React's dev-mode render logging enumerates prop values; a non-enumerable getter
    // is skipped by Object.keys/spreads/that reflection yet still throws on an explicit
    // read, so the backstop catches real consumers without firing on introspection.
    expect(Object.keys(acquired)).not.toContain("rawRows");
    expect(
      Object.prototype.propertyIsEnumerable.call(acquired, "rawRows"),
    ).toBe(false);
  });

  test("rowsWithheld is an enumerable true flag the seed gate reads", () => {
    const acquired = consoleAcquiredCsv(profile);
    // The structural signal the draft reconciliations branch on to feed an empty row
    // set to the seed helpers instead of touching the throwing getter; it must be a
    // plain enumerable property, unlike rawRows.
    expect(acquired.rowsWithheld).toBe(true);
    expect(
      Object.prototype.propertyIsEnumerable.call(acquired, "rowsWithheld"),
    ).toBe(true);
  });
});
