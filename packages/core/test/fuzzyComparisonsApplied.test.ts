import { expect, test, describe, afterEach, vi } from "vitest";

// buildKeyStrings gates the expansion on APPLIED_SETTINGS.fuzzyComparisons, which
// is false in the shipped build because no PSI round consumes a candidate set
// yet. This file pins what the expansion does once that flag flips, so the
// key-building half is verified rather than only reachable in review.
vi.mock("../src/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: false, fuzzyComparisons: true },
}));

import {
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";
import { UsageError } from "../src/errors";
import { getLogger } from "../src/utils/logger";
import type { LinkageKey, TransformStep } from "../src/config/linkageTerms";

describe("buildKeyStrings: fuzzy comparison expansion", () => {
  function makeDataset(fields: Record<string, string>): StandardizedDataset {
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
    );
  }

  test("an element with no fuzzy rule produces exactly today's single key", () => {
    const key: LinkageKey = {
      name: "LN+DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    };
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
  });

  test("a fuzzy element contributes every candidate to the key", () => {
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    const dataset = makeDataset({ date_of_birth: "19900115" });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["19900115", "19890115", "19910115"]),
    );
  });

  test("expansion multiplies across the element cross-product", () => {
    const key: LinkageKey = {
      name: "LN+DOB",
      elements: [
        { field: "last_name" },
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115", "SMITH19890115", "SMITH19910115"]),
    );
  });

  test("two fuzzy elements cross into the product of their candidate sets", () => {
    const key: LinkageKey = {
      name: "LN+DOB",
      elements: [
        { field: "last_name", generateFuzzyComparisons: "transpositions" },
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    const dataset = makeDataset({
      last_name: "AB",
      date_of_birth: "19900115",
    });
    // "AB" -> {AB, BA}; the date -> 3 candidates.
    expect(buildKeyStrings(key, dataset, 0)?.size).toBe(6);
  });

  test("the element transform runs BEFORE the expansion", () => {
    // The raw value is MM/DD/YYYY, which adjacentYearCandidates refuses. It only
    // reaches the expansion as a canonical YYYYMMDD, so a passing expansion is
    // itself the evidence the transform ran first.
    const transform: TransformStep[] = [
      {
        function: "parse_date",
        params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
      },
    ];
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        {
          field: "date_of_birth",
          transform,
          generateFuzzyComparisons: "adjacent_years",
        },
      ],
    };
    const dataset = makeDataset({ date_of_birth: "01/15/1990" });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["19900115", "19890115", "19910115"]),
    );
  });

  test("the expansion widens the transform's output, not the raw value", () => {
    // The leading three characters, then transpositions: expanding the raw
    // "1234" first would produce candidates whose transposed characters live
    // outside the retained prefix (a "1243" candidate truncates back to "124",
    // which the transform-first order never emits).
    const transform: TransformStep[] = [
      { function: "substring", params: { start: 1, length: 3 } },
    ];
    const key: LinkageKey = {
      name: "ID",
      elements: [
        { field: "id", transform, generateFuzzyComparisons: "transpositions" },
      ],
    };
    const dataset = makeDataset({ id: "1234" });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["123", "213", "132"]),
    );
  });

  test("every candidate passes through the final NFC pass", () => {
    // "e" + combining acute composes to a single NFC code point once the parts
    // are joined, so a candidate that is not normalized would leak through as a
    // distinct key string.
    const key: LinkageKey = {
      name: "AB",
      elements: [
        { field: "a" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    const dataset = makeDataset({ a: "e", b: "́X" });
    const keys = buildKeyStrings(key, dataset, 0);
    for (const built of keys ?? []) expect(built.normalize("NFC")).toBe(built);
    expect(keys).toContain("éX");
  });

  test("a transform that nulls the value still excludes the row", () => {
    const rows = [{ date_of_birth: "000" }];
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    const dataset = new StandardizedDataset([
      new StandardizedField(
        "date_of_birth",
        "date_of_birth",
        [{ function: "null_if", params: { value: "000" } }],
        rows,
      ),
    ]);
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
  });
});

describe("buildKeyStrings: fuzzy fan-out guardrails", () => {
  const logger = getLogger("cleaning");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function datasetOf(fields: Record<string, string>): StandardizedDataset {
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
    );
  }

  test("the fan-out warning measures the EXPANDED count", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const key: LinkageKey = {
      name: "A+B",
      elements: [
        { field: "a", generateFuzzyComparisons: "edit_distances" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    // Each 8-character value expands to itself plus 8 deletions: 9 x 9 = 81.
    const built = buildKeyStrings(
      key,
      datasetOf({ a: "ABCDEFGH", b: "JKLMNOPQ" }),
      0,
    );
    expect(built?.size).toBe(81);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/81 key strings \(>20\)/);
  });

  test("no warning fires below the threshold", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    buildKeyStrings(key, datasetOf({ date_of_birth: "19900115" }), 0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a row fanning out past the hard cap is refused, not built", () => {
    const key: LinkageKey = {
      name: "wide",
      elements: ["a", "b", "c", "d"].map((field) => ({
        field,
        generateFuzzyComparisons: "edit_distances" as const,
      })),
    };
    // Six-character values expand to 7 candidates each: 7^4 = 2401 > 1024.
    const dataset = datasetOf({
      a: "ABCDEF",
      b: "GHIJKL",
      c: "MNOPQR",
      d: "STUVWX",
    });
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(UsageError);
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(/2401 key strings/);
    // The cap has two openings and the count tells them apart for nobody, so the
    // message names both. This row's is fuzzy expansion; the other opening, an
    // unlisted producer, is pinned in standardization.test.ts.
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(/fuzzy comparisons/);
  });

  test("the cap refusal names no local value", () => {
    const key: LinkageKey = {
      name: "wide",
      elements: ["a", "b", "c", "d"].map((field) => ({
        field,
        generateFuzzyComparisons: "edit_distances" as const,
      })),
    };
    const dataset = datasetOf({
      a: "SECRETA",
      b: "SECRETB",
      c: "SECRETC",
      d: "SECRETD",
    });
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(/^(?!.*SECRET).*$/s);
  });

  test("the cap does not bind on the non-fuzzy path", () => {
    const key: LinkageKey = {
      name: "many",
      elements: ["a", "b", "c", "d"].map((field) => ({ field })),
    };
    const dataset = datasetOf({
      a: "ABCDEF",
      b: "GHIJKL",
      c: "MNOPQR",
      d: "STUVWX",
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["ABCDEFGHIJKLMNOPQRSTUVWX"]),
    );
  });
});
