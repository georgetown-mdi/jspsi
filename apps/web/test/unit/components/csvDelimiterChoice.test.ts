import { describe, expect, test } from "vitest";

import { CSV_DELIMITER_DETECT, csvDelimiterRefusal } from "@alcove/core";

import {
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  CSV_DELIMITER_SINGLE_COLUMN_REMEDY,
  INITIAL_CSV_DELIMITER_CHOICE,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";

// The delimiter choice the intake surfaces offer, resolved to the value a read
// and a result write take. The accepted set and its refusal are core's; what is
// pinned here is that this surface reaches for them rather than restating them,
// that the surface starts on the comma, and that a refused choice yields no
// delimiter at all.

describe("resolving the delimiter choice", () => {
  test("the starting choice is the comma, not detection", () => {
    expect(resolveCsvDelimiter(INITIAL_CSV_DELIMITER_CHOICE)).toEqual({
      ok: true,
      delimiter: ",",
    });
  });

  test("detection is an option of its own, resolving to core's reserved value", () => {
    expect(CSV_DELIMITER_OPTIONS.map((option) => option.value)).toContain(
      CSV_DELIMITER_DETECT,
    );
    expect(
      resolveCsvDelimiter({ option: CSV_DELIMITER_DETECT, other: "" }),
    ).toEqual({ ok: true, delimiter: CSV_DELIMITER_DETECT });
  });

  test("each named option resolves to its own character", () => {
    for (const option of CSV_DELIMITER_OPTIONS) {
      if (option.value === CSV_DELIMITER_DETECT) continue;
      if (option.value === CSV_DELIMITER_OTHER) continue;
      expect(resolveCsvDelimiter({ option: option.value, other: "" })).toEqual({
        ok: true,
        delimiter: option.value,
      });
    }
  });

  test("the named options are the four common characters", () => {
    const named = CSV_DELIMITER_OPTIONS.map((option) => option.value).filter(
      (value) =>
        value !== CSV_DELIMITER_DETECT && value !== CSV_DELIMITER_OTHER,
    );
    expect(named.sort()).toEqual([",", ";", "\t", "|"].sort());
  });

  test("a typed character outside the named options is taken", () => {
    expect(
      resolveCsvDelimiter({ option: CSV_DELIMITER_OTHER, other: "^" }),
    ).toEqual({ ok: true, delimiter: "^" });
  });

  test("the tab spellings the command line takes resolve here too", () => {
    for (const spelling of ["tab", "TAB", " tab ", "\\t"])
      expect(
        resolveCsvDelimiter({ option: CSV_DELIMITER_OTHER, other: spelling }),
      ).toEqual({ ok: true, delimiter: "\t" });
  });

  test("the detect word typed into the field is the detect choice", () => {
    // The refusal offers the word, so the field it sends the operator to takes
    // it: typing it there is the same choice the select's own entry makes.
    for (const spelling of ["detect", "DETECT", " Detect "])
      expect(
        resolveCsvDelimiter({ option: CSV_DELIMITER_OTHER, other: spelling }),
      ).toEqual({ ok: true, delimiter: CSV_DELIMITER_DETECT });
  });

  test("a word that is not the detect choice is still refused", () => {
    const resolution = resolveCsvDelimiter({
      option: CSV_DELIMITER_OTHER,
      other: "ab",
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok)
      expect(resolution.refusal).toBe(csvDelimiterRefusal("ab"));
  });

  test("a refused character yields the rule's own words and no delimiter", () => {
    for (const value of ['"', "", "::", "\n", "§"]) {
      const resolution = resolveCsvDelimiter({
        option: CSV_DELIMITER_OTHER,
        other: value,
      });
      expect(resolution.ok).toBe(false);
      if (!resolution.ok)
        expect(resolution.refusal).toBe(csvDelimiterRefusal(value));
      // A refused choice holds no delimiter at all: a surface has only the
      // refusal to show, so it cannot read a file by a value the rule rejects.
      expect(resolution).not.toHaveProperty("delimiter");
    }
  });
});

describe("the single-column remedy", () => {
  test("names the control and its detect option", () => {
    expect(CSV_DELIMITER_SINGLE_COLUMN_REMEDY).toBe(
      'This file read as a single column, so its fields may be separated by a character other than the one it was read with. Set "How your file separates fields" to your file\'s separator, or choose Detect to take it from the file.',
    );
    // The option it names is one the control offers, so the copy sends the
    // operator to a choice that is on the screen.
    expect(
      CSV_DELIMITER_OPTIONS.some((option) => option.label.startsWith("Detect")),
    ).toBe(true);
  });

  test("sends nobody off the screen, since every file step offers the control", () => {
    // One wording for every surface: the console's Direct exchange step offers
    // the control as its invitation steps do, so no refusal sends an operator to
    // a route off the screen for a file separated another way.
    expect(CSV_DELIMITER_SINGLE_COLUMN_REMEDY).not.toContain("command line");
    expect(CSV_DELIMITER_SINGLE_COLUMN_REMEDY).not.toContain("csv_delimiter");
  });
});
