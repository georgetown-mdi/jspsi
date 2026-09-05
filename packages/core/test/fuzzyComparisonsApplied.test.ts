import { expect, test, describe, afterEach, vi } from "vitest";

// buildKeyStrings gates the expansion on APPLIED_SETTINGS.fuzzyComparisons, which
// is false in the shipped build because no PSI round consumes a candidate set
// yet. This file pins what the expansion does once that flag flips, so the
// key-building half is verified rather than only reachable in review.
vi.mock("../src/consent/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: false, fuzzyComparisons: true },
}));

import {
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";
import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../src/fanOutFunctions";
import { UsageError } from "../src/errors";
import { getLogger } from "../src/utils/logger";
import type { LinkageKey, TransformStep } from "../src/config/linkageTerms";
import { withUnlistedFanOutFunctions } from "./utils/unlistedFanOut";

// A `transpositions` element declares one candidate per PAIR of its value's
// positions, so an element whose transforms bound no width declares a key width
// above MAX_KEY_CANDIDATE_WIDTH and is refused before a row is read. Every key
// below declaring that kind bounds its value with a transform, which is what the
// reference tells an author to do (derivedKeyWidth.test.ts pins the refusal).
const BOUND_TO_TWO_CHARACTERS: TransformStep[] = [
  { function: "substring", params: { start: 1, length: 2 } },
];
const BOUND_TO_THREE_CHARACTERS: TransformStep[] = [
  { function: "substring", params: { start: 1, length: 3 } },
];

describe("buildKeyStrings: fuzzy comparison expansion", () => {
  function makeDataset(fields: Record<string, string>): StandardizedDataset {
    const keyOverEveryField = {
      name: "every field",
      elements: Object.keys(fields).map((field) => ({ field })),
    };
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
      [keyOverEveryField],
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
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
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
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set(["SMITH19900115", "SMITH19890115", "SMITH19910115"]),
    );
  });

  test("two fuzzy elements cross into the product of their candidate sets", () => {
    const key: LinkageKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: BOUND_TO_TWO_CHARACTERS,
          generateFuzzyComparisons: "transpositions",
        },
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
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
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
      new Set(["123", "213", "321", "132"]),
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
    const dataset = new StandardizedDataset(
      [
        new StandardizedField(
          "date_of_birth",
          "date_of_birth",
          [{ function: "null_if", params: { value: "000" } }],
          rows,
        ),
      ],
      [key],
    );
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
  });
});

describe("buildKeyStrings: fuzzy fan-out guardrails", () => {
  const logger = getLogger("cleaning");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function datasetOf(fields: Record<string, string>): StandardizedDataset {
    const keyOverEveryField = {
      name: "every field",
      elements: Object.keys(fields).map((field) => ({ field })),
    };
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
      [keyOverEveryField],
    );
  }

  // The key both width tests below read: a plain element over a field an UNLISTED
  // producer expands, crossed with one fuzzy element. The declared width counts
  // the fuzzy factor alone -- an unlisted producer declares nothing -- so the row
  // can realize more than the width buys it, which is the only way a fuzzy row
  // outgrows a width derived from the ceilings its own expansion obeys.
  const unlistedTimesFuzzyKey: LinkageKey = {
    name: "A+DOB",
    elements: [
      { field: "a" },
      { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
    ],
  };

  function unlistedSplitDataset(
    parts: string[],
    date: string,
  ): StandardizedDataset {
    return withUnlistedFanOutFunctions(
      () =>
        new StandardizedDataset(
          [
            new StandardizedField(
              "a",
              "a",
              [{ function: "split_on", params: { delimiter: "\\|" } }],
              [{ a: parts.join("|") }],
            ),
            new StandardizedField(
              "date_of_birth",
              "date_of_birth",
              [],
              [{ date_of_birth: date }],
            ),
          ],
          [unlistedTimesFuzzyKey],
        ),
    );
  }

  test("the width bound refuses a row the expansion widened past it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Five unlisted candidates crossed with the three an adjacent-years
    // expansion realizes: 15, over the 3 the key's declared width buys it. The
    // row is refused rather than narrowed to a slice of the candidate set the
    // terms declare, and rather than warned and shipped -- 12 of its candidates
    // would have no slot to occupy.
    const dataset = unlistedSplitDataset(
      ["V0", "V1", "V2", "V3", "V4"],
      "19900115",
    );
    expect(() =>
      buildKeyStrings(unlistedTimesFuzzyKey, dataset, 0, true),
    ).toThrow(UsageError);
    expect(() =>
      buildKeyStrings(unlistedTimesFuzzyKey, dataset, 0, true),
    ).toThrow(
      /expands one row into 15 candidate values through fuzzy comparisons, above the 3/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("the width refusal names no local value", () => {
    const dataset = unlistedSplitDataset(
      ["SECRETA", "SECRETB", "SECRETC", "SECRETD", "SECRETE"],
      "19900115",
    );
    expect(() =>
      buildKeyStrings(unlistedTimesFuzzyKey, dataset, 0, true),
    ).toThrow(/^(?!.*SECRET).*$/s);
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
      { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
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

  test("a key whose declared width exceeds the ceiling is refused", () => {
    // Every element's candidates multiply across the key, so four elements
    // each declaring the edit-distance ceiling declare a width no row could
    // be assembled for. The refusal is decided from the TERMS, before any
    // row is read, rather than dropping or refusing every row at the
    // assembly cap.
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
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(UsageError);
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(
      /declares a width of more than the 1024 candidate values/,
    );
    // The refusal reads the terms alone, so it echoes neither this row's values
    // nor the partner's free text.
    expect(() => buildKeyStrings(key, dataset, 0)).toThrow(/^(?!.*SECRET).*$/s);
  });

  test("a row whose expansion replicates too many bytes is refused", () => {
    // The expansion's own input bound (MAX_FUZZY_EXPANSION_INPUT_LENGTH)
    // reaches only the value a fuzzy element expands, never a sibling
    // element's value -- which every candidate of the product holds a copy
    // of. The key's byte limb is what bounds those replicated bytes: this
    // row's candidate COUNT is inside the assembly cap, and its byte total
    // is not.
    const plainFields = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const key: LinkageKey = {
      name: "wide",
      elements: [
        ...plainFields.map((field) => ({ field })),
        { field: "b", generateFuzzyComparisons: "edit_distances" as const },
      ],
    };
    const dataset = datasetOf({
      ...Object.fromEntries(
        plainFields.map((field) => [field, "A".repeat(4096)]),
      ),
      b: Array.from({ length: 128 }, (_unused, i) =>
        String.fromCharCode(65 + (i % 26)),
      ).join(""),
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
    const keyOverEveryField = {
      name: "every field",
      elements: Object.keys(fields).map((field) => ({ field })),
    };
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
      [keyOverEveryField],
    );
  }

  // The receiver-only kind these mixed keys read is `adjacent_years` rather than
  // `transpositions`: the two are classified alike, and its ceiling of three is
  // what leaves room for a both-sided element beside it under the key's declared
  // width ceiling.
  const RECEIVER_ONLY_KIND = "adjacent_years";
  const BOTH_SIDED_KIND = "edit_distances";

  test.each([
    {
      kind: "transpositions" as const,
      field: "last_name",
      transform: BOUND_TO_THREE_CHARACTERS,
      value: "ABC",
      onReceiver: ["ABC", "BAC", "CBA", "ACB"],
    },
    {
      kind: "adjacent_years" as const,
      field: "date_of_birth",
      transform: undefined,
      value: "19900115",
      onReceiver: ["19900115", "19890115", "19910115"],
    },
  ])(
    "$kind expands on the receiver and not on the sender",
    ({ kind, field, transform, value, onReceiver }) => {
      const key: LinkageKey = {
        name: "K",
        elements: [{ field, transform, generateFuzzyComparisons: kind }],
      };
      const dataset = datasetOf({ [field]: value });
      expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
        new Set(onReceiver),
      );
      expect(buildKeyStrings(key, dataset, 0, false)).toEqual(new Set([value]));
    },
  );

  test.each([
    {
      kind: "transpositions" as const,
      field: "last_name",
      transform: BOUND_TO_THREE_CHARACTERS,
      mine: "ABC",
      theirs: "CBA",
    },
    {
      kind: "adjacent_years" as const,
      field: "date_of_birth",
      transform: undefined,
      mine: "19900115",
      theirs: "19910115",
    },
  ])(
    "$kind meets the partner's exact value whichever party is the receiver",
    ({ kind, field, transform, mine, theirs }) => {
      // Role invariance, driven as the round drives it: the expansion is an
      // involution over the pair, so the intersection holds whichever party role
      // resolution designates -- which is what makes a recurring exchange that
      // resolves the opposite role between runs match the same records
      // (docs/notes/one-sided-fuzzy-expansion.md).
      const key: LinkageKey = {
        name: "K",
        elements: [{ field, transform, generateFuzzyComparisons: kind }],
      };
      const asReceiver = (value: string): Set<string> =>
        buildKeyStrings(key, datasetOf({ [field]: value }), 0, true) ??
        new Set();
      const asSender = (value: string): Set<string> =>
        buildKeyStrings(key, datasetOf({ [field]: value }), 0, false) ??
        new Set();
      const meet = (a: Set<string>, b: Set<string>): boolean =>
        [...a].some((value) => b.has(value));

      expect(meet(asReceiver(mine), asSender(theirs))).toBe(true);
      expect(meet(asSender(mine), asReceiver(theirs))).toBe(true);
      // Both parties expanding matches the same pair and contributes strictly
      // more candidate values to the round than one party expanding does.
      expect(meet(asReceiver(mine), asReceiver(theirs))).toBe(true);
      expect(asReceiver(mine).size + asReceiver(theirs).size).toBeGreaterThan(
        asReceiver(mine).size + asSender(theirs).size,
      );
    },
  );

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
      name: "DOB+FN",
      elements: [
        {
          field: "date_of_birth",
          generateFuzzyComparisons: RECEIVER_ONLY_KIND,
        },
        { field: "first_name", generateFuzzyComparisons: BOTH_SIDED_KIND },
      ],
    };
    const dataset = datasetOf({
      date_of_birth: "19900115",
      first_name: "CD",
    });
    // Receiver: {19900115, 19890115, 19910115} x {CD, D, C}.
    // Sender:   {19900115}                     x {CD, D, C}.
    expect(buildKeyStrings(key, dataset, 0, true)?.size).toBe(9);
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(
      new Set(["19900115CD", "19900115D", "19900115C"]),
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
    const dataset = datasetOf({ a: "19900115", b: "20000229" });
    // Swapped, the receiver reads b then a, expanding each: 2000-02-29 has
    // no counterpart in either adjacent (non-leap) year, so it contributes
    // itself alone, while 1990-01-15 contributes both neighbours. The
    // authored order the swap variant assembles beside it holds the same
    // two expansions, in the other position.
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set([
        "2000022919900115",
        "2000022919890115",
        "2000022919910115",
        "1990011520000229",
        "1989011520000229",
        "1991011520000229",
      ]),
    );
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(
      new Set(["1990011520000229"]),
    );
  });
});

describe("buildKeyStrings: the swap's full variant", () => {
  function datasetOf(fields: Record<string, string>): StandardizedDataset {
    const keyOverEveryField = {
      name: "every field",
      elements: Object.keys(fields).map((field) => ({ field })),
    };
    return new StandardizedDataset(
      Object.entries(fields).map(
        ([name, value]) =>
          new StandardizedField(name, name, [], [{ [name]: value }]),
      ),
      [keyOverEveryField],
    );
  }

  const nameKey: LinkageKey = {
    name: "FN+LN",
    elements: [{ field: "first_name" }, { field: "last_name" }],
    swap: ["first_name", "last_name"],
  };
  const keysFor = (
    first: string,
    last: string,
    isReceiver: boolean,
  ): Set<string> =>
    buildKeyStrings(
      nameKey,
      datasetOf({ first_name: first, last_name: last }),
      0,
      isReceiver,
    ) ?? new Set();
  const meet = (a: Set<string>, b: Set<string>): boolean =>
    [...a].some((value) => b.has(value));

  test("the receiver builds both orders and the sender the authored one", () => {
    expect(keysFor("JOHN", "SMITH", true)).toEqual(
      new Set(["JOHNSMITH", "SMITHJOHN"]),
    );
    expect(keysFor("JOHN", "SMITH", false)).toEqual(new Set(["JOHNSMITH"]));
  });

  test("a partner whose two fields are reversed matches, and so does one that agrees", () => {
    // What the swap's coverage text states: the two elements match in EITHER
    // order. Building the exchanged order alone would match the reversed partner
    // and lose the one that agrees.
    expect(
      meet(keysFor("JOHN", "SMITH", true), keysFor("SMITH", "JOHN", false)),
    ).toBe(true);
    expect(
      meet(keysFor("JOHN", "SMITH", true), keysFor("JOHN", "SMITH", false)),
    ).toBe(true);
  });

  test("the intersection is the same whichever party resolves to the receiver", () => {
    // The exchange is an involution, so the pair meets on one party's variant
    // whichever party role resolution designates -- a recurring exchange may
    // resolve the opposite role between runs and match the same records.
    for (const [first, last] of [
      ["JOHN", "SMITH"],
      ["SMITH", "JOHN"],
    ] as const) {
      expect(
        meet(keysFor("JOHN", "SMITH", true), keysFor(first, last, false)),
      ).toBe(meet(keysFor("JOHN", "SMITH", false), keysFor(first, last, true)));
    }
  });

  test("a record whose two values agree realizes one order, not two", () => {
    expect(keysFor("LEE", "LEE", true)).toEqual(new Set(["LEELEE"]));
  });

  test("a swap pair declaring different transforms is refused", () => {
    // The receiver assembles the authored order by exchanging the pair's two
    // candidate lists, which is that order only because the pair declares one
    // transform and one expansion. The terms schema requires it; a key that
    // reached the row build without it is refused rather than matched on a set
    // neither order realizes.
    const mismatched: LinkageKey = {
      name: "FN+LN",
      elements: [
        { field: "first_name" },
        {
          field: "last_name",
          transform: [
            { function: "substring", params: { start: 1, length: 2 } },
          ],
        },
      ],
      swap: ["first_name", "last_name"],
    };
    const dataset = datasetOf({ first_name: "JOHN", last_name: "SMITH" });
    expect(() => buildKeyStrings(mismatched, dataset, 0, true)).toThrow(
      UsageError,
    );
    expect(() => buildKeyStrings(mismatched, dataset, 0, true)).toThrow(
      /swap whose two elements do not declare the same transform/,
    );
    // The sender never assembles the second order, so nothing is refused for it.
    expect(buildKeyStrings(mismatched, dataset, 0, false)).toEqual(
      new Set(["JOHNSM"]),
    );
  });
});
