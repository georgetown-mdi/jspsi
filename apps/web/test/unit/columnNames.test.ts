import { describe, expect, test } from "vitest";

import {
  emptyColumnPositions,
  unnameableColumnsAlert,
} from "../../src/psi/columnNames.js";

describe("emptyColumnPositions", () => {
  test("returns the 1-based positions of empty-named columns, in order", () => {
    expect(emptyColumnPositions(["ssn", "", "first_name", ""])).toEqual([2, 4]);
  });

  test("is empty for a fully-named header", () => {
    expect(emptyColumnPositions(["ssn", "first_name"])).toEqual([]);
  });

  test("treats only zero-length names as empty (a blank-but-present name is kept)", () => {
    // Matches the .min(1) the schemas floor at: " " has length 1, so it is not an
    // empty name and is left to the (non-empty) downstream handling.
    expect(emptyColumnPositions([" "])).toEqual([]);
  });
});

describe("unnameableColumnsAlert", () => {
  test("names a single column position in the singular", () => {
    const alert = unnameableColumnsAlert([3]);
    expect(alert.title).toBe("This file has an unnamed column");
    expect(alert.message).toContain("Column 3");
    expect(alert.message).toContain("has no name");
  });

  test("pluralizes the title and message for multiple positions", () => {
    const alert = unnameableColumnsAlert([2, 4]);
    expect(alert.title).toBe("This file has unnamed columns");
    expect(alert.message).toContain("Columns 2, 4");
    expect(alert.message).toContain("have no name");
  });
});
