import { describe, expect, test } from "vitest";

import { MAX_NAME_LENGTH } from "@psilink/core";

import {
  emptyColumnPositions,
  overlongColumnsAlert,
  sanitizedColumnsAlert,
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

  test("blames the removal, not a blank cell, when the read emptied the name", () => {
    // A header made only of text-direction characters is neither a trailing
    // comma nor a blank cell, so the stated cause and remedy must not be those.
    const alert = unnameableColumnsAlert([2], [2]);
    expect(alert.message).toContain("invisible text-direction characters");
    expect(alert.message).toContain("ordinary characters");
    expect(alert.message).not.toContain("trailing comma");
  });

  test("states both causes when only some empty names came from the removal", () => {
    const alert = unnameableColumnsAlert([2, 5], [2]);
    expect(alert.message).toContain("Columns 2, 5");
    expect(alert.message).toContain("Column 2 held");
    expect(alert.message).toContain("invisible text-direction characters");
    expect(alert.message).toContain("trailing comma");
  });

  test("keeps the blank-cell cause when the removal touched other columns only", () => {
    const alert = unnameableColumnsAlert([4], [2]);
    expect(alert.message).toContain("trailing comma");
    expect(alert.message).not.toContain("text-direction");
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

describe("sanitizedColumnsAlert", () => {
  test("names a single column position in the singular", () => {
    const alert = sanitizedColumnsAlert([3]);
    expect(alert.title).toBe(
      "A formatting character was removed from a column name",
    );
    expect(alert.message).toContain("Column 3");
    expect(alert.message).toContain("had a name that held");
  });

  test("pluralizes the title and message for multiple positions", () => {
    const alert = sanitizedColumnsAlert([2, 5]);
    expect(alert.title).toBe("Formatting characters removed from column names");
    expect(alert.message).toContain("Columns 2, 5");
    expect(alert.message).toContain("had names that held");
  });

  test("states what was done and how to act on it", () => {
    const alert = sanitizedColumnsAlert([1]);
    expect(alert.message).toContain("removed");
    expect(alert.message).toContain("sent to your partner");
    expect(alert.message).toContain("edit the header row");
  });

  test("states the numbering instead of claiming the name is the rest of the header", () => {
    // Measured on the real parser in packages/core/test/file.test.ts: a header
    // whose two names differ only by a removed character comes back as `name`
    // and `name_1`, so the name a collided column keeps is not its own header
    // and can be the untouched column's.
    const alert = sanitizedColumnsAlert([2]);
    expect(alert.message).toContain("two columns with the same name");
    expect(alert.message).toContain("the later one was numbered");
    expect(alert.message).not.toContain("rest of the header");
  });
});
