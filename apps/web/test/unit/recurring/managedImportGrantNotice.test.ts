import { describe, expect, test } from "vitest";

import { managedImportGrantNotice } from "@recurring/managedImportGrantNotice";

// What an import tells the operator about the grants it could not bring. The
// notice names only the grants the import is actually missing: an import that
// brought everything its source had says nothing at all, and one missing a single
// grant does not describe the other.

describe("the import grant notice", () => {
  test("names both grants and what a run with nobody present does without each", () => {
    const notice = managedImportGrantNotice(["input-file", "output-folder"]);
    expect(notice?.title).toBe(
      "Choose this exchange's input file and the results folder again",
    );
    expect(notice?.lead).toContain(
      "This browser does not have the input file and the results folder",
    );
    expect(notice?.lead).toContain("Open the exchange to choose them now.");
    expect(notice?.consequences).toEqual([
      "Without an input file, a run that happens with nobody present stops.",
      "Without a results folder, a run that happens with nobody present keeps its results in the browser.",
    ]);
  });

  test("a missing input file alone says nothing about a results folder", () => {
    const notice = managedImportGrantNotice(["input-file"]);
    expect(notice?.title).toBe("Choose this exchange's input file again");
    expect(notice?.lead).toContain("Open the exchange to choose it now.");
    expect(notice?.consequences).toHaveLength(1);
    expect(`${notice?.title ?? ""} ${notice?.lead ?? ""}`).not.toContain(
      "folder",
    );
  });

  test("a missing results folder alone says nothing about an input file", () => {
    const notice = managedImportGrantNotice(["output-folder"]);
    expect(notice?.title).toBe("Choose this exchange's results folder again");
    expect(notice?.consequences).toEqual([
      "Without a results folder, a run that happens with nobody present keeps its results in the browser.",
    ]);
    expect(`${notice?.title ?? ""} ${notice?.lead ?? ""}`).not.toContain(
      "input",
    );
  });

  test("nothing missing shows no notice at all", () => {
    // The revive-in-place case: the record kept the grants it already had, so an
    // import that says anything here would be saying it about nothing.
    expect(managedImportGrantNotice([])).toBeUndefined();
  });
});
