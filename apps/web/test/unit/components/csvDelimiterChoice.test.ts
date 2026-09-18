import { describe, expect, test } from "vitest";

import { csvDelimiterRefusal } from "@psilink/core";

import {
  CSV_DELIMITER_AUTO,
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  csvDelimiterChoiceFor,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";

// The delimiter choice the intake surfaces offer, resolved to the character a
// read and a result write take. The accepted set and its refusal are core's; what
// is pinned here is that this surface reaches for them rather than restating
// them, and that a refused choice yields no delimiter at all.

describe("resolving the delimiter choice", () => {
  test("the starting choice reads by detection, naming no delimiter", () => {
    const resolution = resolveCsvDelimiter({
      option: CSV_DELIMITER_AUTO,
      other: "",
    });
    expect(resolution).toEqual({ ok: true, delimiter: undefined });
  });

  test("each named option resolves to its own character", () => {
    for (const option of CSV_DELIMITER_OPTIONS) {
      if (option.value === CSV_DELIMITER_AUTO) continue;
      if (option.value === CSV_DELIMITER_OTHER) continue;
      expect(resolveCsvDelimiter({ option: option.value, other: "" })).toEqual({
        ok: true,
        delimiter: option.value,
      });
    }
  });

  test("the four named characters are the ones detection considers", () => {
    const named = CSV_DELIMITER_OPTIONS.map((option) => option.value).filter(
      (value) => value !== CSV_DELIMITER_AUTO && value !== CSV_DELIMITER_OTHER,
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

describe("showing a stored delimiter", () => {
  test("an absent delimiter shows as detection", () => {
    expect(csvDelimiterChoiceFor(undefined)).toEqual({
      option: CSV_DELIMITER_AUTO,
      other: "",
    });
  });

  test("a stored delimiter round-trips through the choice it shows as", () => {
    for (const delimiter of [",", "\t", "|", ";", "^"])
      expect(resolveCsvDelimiter(csvDelimiterChoiceFor(delimiter))).toEqual({
        ok: true,
        delimiter,
      });
  });

  test("a delimiter no option names shows in the free-text field", () => {
    expect(csvDelimiterChoiceFor("^")).toEqual({
      option: CSV_DELIMITER_OTHER,
      other: "^",
    });
  });
});
