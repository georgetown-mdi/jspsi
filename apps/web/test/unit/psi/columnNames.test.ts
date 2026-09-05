import { describe, expect, test } from "vitest";

import { MAX_NAME_LENGTH } from "@psilink/core";

import {
  emptyColumnPositions,
  overlongColumnsAlert,
  unnameableColumnsAlert,
} from "../../../src/psi/columnNames.js";

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

describe("overlongColumnsAlert", () => {
  test("names a single column position in the singular, with the ceiling", () => {
    const alert = overlongColumnsAlert([3]);
    expect(alert.title).toBe("This column name is too long to send");
    expect(alert.message).toContain("Column 3");
    expect(alert.message).toContain("its name is");
    expect(alert.message).toContain(`${MAX_NAME_LENGTH} characters`);
  });

  test("pluralizes the title and message for multiple positions", () => {
    const alert = overlongColumnsAlert([1, 3]);
    expect(alert.title).toBe("These column names are too long to send");
    expect(alert.message).toContain("Columns 1, 3");
    expect(alert.message).toContain("their names are");
  });

  test("offers both remedies, since the seats differ in which they have", () => {
    // A seat with a disclosure control clears this by unmarking the column; one
    // without it (the direct-exchange spine) by shortening the header.
    const alert = overlongColumnsAlert([2]);
    expect(alert.message).toContain("Shorten the header");
    expect(alert.message).toContain("not sent");
  });
});
