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
import { MAX_KEY_CANDIDATES_PER_ROW } from "../src/fanOutFunctions";
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
    // "AB" -> {AB, BA}; the date -> 3 candidates. Read as the receiver, the role
    // every declared expansion runs under.
    expect(buildKeyStrings(key, dataset, 0, true)?.size).toBe(6);
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
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
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

  test("the width bound refuses a row the expansion widened past it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const key: LinkageKey = {
      name: "A+B",
      elements: [
        { field: "a", generateFuzzyComparisons: "edit_distances" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    // Each 8-character value expands to itself plus 8 deletions: 9 x 9 = 81, over
    // the 20 the key's declared width buys it. The row is refused rather than
    // narrowed to a slice of the candidate set the terms declare, and rather than
    // warned and shipped -- 61 of its candidates would have no slot to occupy.
    const dataset = datasetOf({ a: "ABCDEFGH", b: "JKLMNOPQ" });
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(UsageError);
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(
      /expands one row into 81 candidate values through fuzzy comparisons, above the 20/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("the width refusal names no local value", () => {
    const key: LinkageKey = {
      name: "A+B",
      elements: [
        { field: "a", generateFuzzyComparisons: "edit_distances" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    const dataset = datasetOf({ a: "SECRETAB", b: "SECRETCD" });
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(/^(?!.*SECRET).*$/s);
  });

  test("a declared fan-out keeps the warned drop at the same bound", () => {
    // The two producers take different fates at one bound, so a row a declared
    // fan-out widened must still be dropped and warned rather than swept into the
    // fuzzy refusal beside it.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const key: LinkageKey = {
      name: "split",
      elements: [
        {
          field: "a",
          transform: [{ function: "split_on", params: { delimiter: "/" } }],
        },
      ],
    };
    const parts = Array.from(
      { length: MAX_KEY_CANDIDATES_PER_ROW + 1 },
      (_unused, i) => `V${i}`,
    ).join("/");
    expect(buildKeyStrings(key, datasetOf({ a: parts }), 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/realizes 21 candidate values/);
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

  test("a row whose expansion replicates too many bytes is refused", () => {
    // The expansion's own input bound (MAX_FUZZY_EXPANSION_INPUT_LENGTH) reaches
    // only the value a fuzzy element expands, never a sibling element's value --
    // which every candidate of the product carries a copy of. The key's byte
    // limb is what bounds those replicated bytes: this row's candidate COUNT is
    // inside the assembly cap, and its byte total is not.
    const key: LinkageKey = {
      name: "wide",
      elements: [
        { field: "a" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
        { field: "c", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    const dataset = datasetOf({
      a: "A".repeat(4096),
      b: Array.from({ length: 100 }, (_unused, i) =>
        String.fromCharCode(65 + (i % 26)),
      ).join(""),
      c: "ABCDEFGHI",
    });
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(UsageError);
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(
      /assembles \d+ characters of key strings/,
    );
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

describe("buildKeyStrings: the expanding side", () => {
  function datasetOf(fields: Record<string, string>): StandardizedDataset {
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
    );
  }

  const RECEIVER_ONLY_KIND = "transpositions";
  const BOTH_SIDED_KIND = "edit_distances";

  test("a receiver-only kind expands on the receiver and not on the sender", () => {
    const key: LinkageKey = {
      name: "LN",
      elements: [
        { field: "last_name", generateFuzzyComparisons: RECEIVER_ONLY_KIND },
      ],
    };
    const dataset = datasetOf({ last_name: "ABC" });
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set(["ABC", "BAC", "ACB"]),
    );
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(new Set(["ABC"]));
  });

  test("the both-sided kind expands identically for either role", () => {
    const key: LinkageKey = {
      name: "LN",
      elements: [
        { field: "last_name", generateFuzzyComparisons: BOTH_SIDED_KIND },
      ],
    };
    const dataset = datasetOf({ last_name: "ABC" });
    const expected = new Set(["ABC", "BC", "AC", "AB"]);
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(expected);
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(expected);
  });

  test("the sender of a mixed key still expands the both-sided element", () => {
    const key: LinkageKey = {
      name: "LN+FN",
      elements: [
        { field: "last_name", generateFuzzyComparisons: RECEIVER_ONLY_KIND },
        { field: "first_name", generateFuzzyComparisons: BOTH_SIDED_KIND },
      ],
    };
    const dataset = datasetOf({ last_name: "AB", first_name: "CD" });
    // Receiver: {AB, BA} x {CD, D, C}. Sender: {AB} x {CD, D, C}.
    expect(buildKeyStrings(key, dataset, 0, true)?.size).toBe(6);
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(
      new Set(["ABCD", "ABD", "ABC"]),
    );
  });

  test("the receiver applies a swapped position's own expansion", () => {
    // `swap` moves the field references and leaves each position's expansion
    // where it is, so the receiver expands the column its sibling declared. The
    // terms schema requires both positions to declare the same expansion, which
    // is what keeps that from being a second reading of the same terms.
    const key: LinkageKey = {
      name: "swapped",
      elements: [
        { field: "a", generateFuzzyComparisons: RECEIVER_ONLY_KIND },
        { field: "b", generateFuzzyComparisons: RECEIVER_ONLY_KIND },
      ],
      swap: ["a", "b"],
    };
    const dataset = datasetOf({ a: "AB", b: "CD" });
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set(["CDAB", "DCAB", "CDBA", "DCBA"]),
    );
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(new Set(["ABCD"]));
  });
});
