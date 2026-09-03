import { expect, test, describe } from "vitest";

import {
  adjacentYearCandidates,
  deletionCandidates,
  expandFuzzyComparisons,
  expandsOnReceiverOnly,
  transpositionCandidates,
  MAX_FUZZY_EXPANSION_INPUT_LENGTH,
} from "../src/fuzzyComparisons";
import {
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";
import { declaredEffectiveKeyCount } from "../src/fanOutFunctions";
import { APPLIED_SETTINGS } from "../src/appliedSettings";
import { UsageError } from "../src/errors";
import type {
  GenerateFuzzyComparisons,
  LinkageKey,
  LinkageTerms,
} from "../src/config/linkageTerms";

const FUZZY_KINDS: readonly GenerateFuzzyComparisons[] = [
  "transpositions",
  "edit_distances",
  "adjacent_years",
];

// The one-key terms a width assertion reads: the key declares the expansion and
// nothing else, so its effective key count is the plain 1 or the fuzzy factor.
function fuzzyTerms(kind: GenerateFuzzyComparisons): LinkageTerms {
  return {
    linkageKeys: [
      {
        name: "one",
        elements: [{ field: "last_name", generateFuzzyComparisons: kind }],
      },
    ],
  } as LinkageTerms;
}

// The expansion primitives are pure and always exercised. buildKeyStrings gates
// calling them on APPLIED_SETTINGS.fuzzyComparisons; this file pins the behavior
// while that flag is false, and fuzzyComparisonsApplied.test.ts pins the
// expansion the flag turns on.

describe("transpositionCandidates", () => {
  test("emits every adjacent swap and never the original", () => {
    expect(transpositionCandidates("1234")).toEqual(["2134", "1324", "1243"]);
  });

  test("a repeated adjacent pair transposes to the original, so emits nothing", () => {
    // "AAB": swapping positions 0/1 reproduces "AAB", so only the A/B swap is a
    // real candidate.
    expect(transpositionCandidates("AAB")).toEqual(["ABA"]);
    expect(transpositionCandidates("AAAA")).toEqual([]);
  });

  test("values too short to transpose emit nothing", () => {
    expect(transpositionCandidates("")).toEqual([]);
    expect(transpositionCandidates("A")).toEqual([]);
  });

  test("swaps whole code points rather than UTF-16 units", () => {
    // A naive index swap over "A<emoji>" would split the surrogate pair and emit
    // two lone surrogates -- a string no standardized value can equal.
    const value = "A\u{1F600}";
    expect(transpositionCandidates(value)).toEqual(["\u{1F600}A"]);
    for (const candidate of transpositionCandidates(value))
      expect(candidate.normalize("NFC")).toBe(candidate);
  });
});

describe("deletionCandidates", () => {
  test("emits every single-character deletion and never the original", () => {
    expect(deletionCandidates("ABC")).toEqual(["BC", "AC", "AB"]);
  });

  test("deletions that collide are emitted once", () => {
    // Deleting either "A" of "AAB" yields "AB".
    expect(deletionCandidates("AAB")).toEqual(["AB", "AA"]);
  });

  test("a one-character value deletes to the empty string", () => {
    expect(deletionCandidates("A")).toEqual([""]);
    expect(deletionCandidates("")).toEqual([]);
  });

  test("deletes whole code points rather than UTF-16 units", () => {
    expect(deletionCandidates("A\u{1F600}")).toEqual(["\u{1F600}", "A"]);
  });
});

describe("adjacentYearCandidates", () => {
  test("emits the year either side, keeping month and day", () => {
    expect(adjacentYearCandidates("19900115")).toEqual([
      "19890115",
      "19910115",
    ]);
  });

  test("spans a year boundary at both ends of the year", () => {
    expect(adjacentYearCandidates("20000101")).toEqual([
      "19990101",
      "20010101",
    ]);
    expect(adjacentYearCandidates("19991231")).toEqual([
      "19981231",
      "20001231",
    ]);
  });

  test("drops a shifted date that is not a real calendar date", () => {
    // Feb 29 2000 is a leap day; neither 1999 nor 2001 has one, so both shifts
    // are dropped rather than rolled over to Mar 1.
    expect(adjacentYearCandidates("20000229")).toEqual([]);
    // 2004 and 2000 are both leap years, so a shift from 2003/2005 lands on a
    // valid Feb 28 either way.
    expect(adjacentYearCandidates("20040228")).toEqual([
      "20030228",
      "20050228",
    ]);
  });

  test("drops a shift off the four-digit year range", () => {
    expect(adjacentYearCandidates("00000101")).toEqual(["00010101"]);
    expect(adjacentYearCandidates("99991231")).toEqual(["99981231"]);
  });

  test("refuses a value that is not a canonical YYYYMMDD date", () => {
    for (const value of ["1990-01-15", "01/15/1990", "SMITH", "199001150"]) {
      expect(() => adjacentYearCandidates(value)).toThrow(UsageError);
      expect(() => adjacentYearCandidates(value)).toThrow(/adjacent_years/);
    }
  });

  test("the refusal names neither the value nor a partner string", () => {
    // The standardized value is the local PII the exchange keeps local.
    expect(() => adjacentYearCandidates("19900115X")).toThrow(
      /^(?!.*19900115).*$/s,
    );
  });
});

describe("expandFuzzyComparisons", () => {
  test("leads with the value itself for every kind", () => {
    expect(expandFuzzyComparisons("19900115", "transpositions")[0]).toBe(
      "19900115",
    );
    expect(expandFuzzyComparisons("19900115", "edit_distances")[0]).toBe(
      "19900115",
    );
    expect(expandFuzzyComparisons("19900115", "adjacent_years")[0]).toBe(
      "19900115",
    );
  });

  test("adjacent_years yields the value and one year either side", () => {
    expect(expandFuzzyComparisons("19900115", "adjacent_years")).toEqual([
      "19900115",
      "19890115",
      "19910115",
    ]);
  });

  test("a value whose expansion is empty is still its own candidate", () => {
    expect(expandFuzzyComparisons("20000229", "adjacent_years")).toEqual([
      "20000229",
    ]);
    expect(expandFuzzyComparisons("AAAA", "transpositions")).toEqual(["AAAA"]);
  });

  test("candidates are deduplicated against the value and each other", () => {
    const candidates = expandFuzzyComparisons("AAB", "edit_distances");
    expect(candidates).toEqual(["AAB", "AB", "AA"]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("expands a value exactly at the length cap", () => {
    const value = "A".repeat(MAX_FUZZY_EXPANSION_INPUT_LENGTH);
    expect(() => expandFuzzyComparisons(value, "edit_distances")).not.toThrow();
  });

  test("refuses a value above the length cap rather than passing it through", () => {
    const value = "A".repeat(MAX_FUZZY_EXPANSION_INPUT_LENGTH + 1);
    for (const kind of [
      "transpositions",
      "edit_distances",
      "adjacent_years",
    ] as const) {
      expect(() => expandFuzzyComparisons(value, kind)).toThrow(UsageError);
      expect(() => expandFuzzyComparisons(value, kind)).toThrow(
        new RegExp(`${MAX_FUZZY_EXPANSION_INPUT_LENGTH}-character limit`),
      );
    }
  });
});

describe("expandsOnReceiverOnly", () => {
  test("classifies every kind the schema admits", () => {
    // Total over the enum: a kind added without an arm fails to compile, and this
    // pins that each existing one is classified rather than defaulted.
    expect(expandsOnReceiverOnly("transpositions")).toBe(true);
    expect(expandsOnReceiverOnly("adjacent_years")).toBe(true);
    expect(expandsOnReceiverOnly("edit_distances")).toBe(false);
  });

  test("reads the kind alone, so both parties classify identically", () => {
    for (const kind of FUZZY_KINDS)
      expect(expandsOnReceiverOnly(kind)).toBe(expandsOnReceiverOnly(kind));
  });
});

describe("the declared width of a fuzzy key", () => {
  // Read under the shipped flag (false) here; the widths the flag buys are pinned
  // in fuzzyExpansionWidth.test.ts, which mocks it on.
  test("a fuzzy element raises no width while the expansion is inert", () => {
    for (const kind of FUZZY_KINDS)
      expect(declaredEffectiveKeyCount(fuzzyTerms(kind))).toBe(1);
  });
});

describe("buildKeyStrings while fuzzy expansion is not applied", () => {
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

  // Guards the premise the rest of this file's expectations rest on. If the flag
  // is flipped without the PSI round that consumes a candidate set, this fails
  // rather than letting the gated-off expectations below silently describe a
  // behavior the build no longer has.
  test("the applied-settings flag is still off", () => {
    expect(APPLIED_SETTINGS.fuzzyComparisons).toBe(false);
  });

  test("a fuzzy element builds the same single key as one without", () => {
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    const plain: LinkageKey = {
      name: "LN+DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    };
    const fuzzy: LinkageKey = {
      name: "LN+DOB",
      elements: [
        { field: "last_name", generateFuzzyComparisons: "transpositions" },
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    };
    expect(buildKeyStrings(plain, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
    expect(buildKeyStrings(fuzzy, dataset, 0)).toEqual(
      buildKeyStrings(plain, dataset, 0),
    );
  });

  test("a value the expansion would refuse still builds its exact key", () => {
    // adjacent_years refuses a non-canonical date, and the length cap refuses a
    // long value; neither refusal is reachable while the gate is closed.
    const dataset = makeDataset({
      date_of_birth: "01/15/1990",
      long: "A".repeat(MAX_FUZZY_EXPANSION_INPUT_LENGTH + 1),
    });
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
        { field: "long", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    expect(() => buildKeyStrings(key, dataset, 0)).not.toThrow(UsageError);
    expect(buildKeyStrings(key, dataset, 0)?.size).toBe(1);
  });

  test("the two roles build the same key for every kind", () => {
    // The expansion is what the role keys, so with it inert a fuzzy element is
    // role-blind: the receiver and the sender realize one identical value, and no
    // width, refusal, or advisory separates them.
    const dataset = makeDataset({ last_name: "SMITH" });
    for (const kind of FUZZY_KINDS) {
      const key: LinkageKey = {
        name: "LN",
        elements: [{ field: "last_name", generateFuzzyComparisons: kind }],
      };
      expect(buildKeyStrings(key, dataset, 0, false)).toEqual(
        new Set(["SMITH"]),
      );
      expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
        new Set(["SMITH"]),
      );
    }
  });

  test("a row the expansion would widen past the width bound still builds one key", () => {
    // With the flag on this row is refused (fuzzyComparisonsApplied.test.ts); the
    // refusal is reachable only through the expansion, so the gate closes it too.
    const dataset = makeDataset({ a: "ABCDEFGH", b: "JKLMNOPQ" });
    const key: LinkageKey = {
      name: "A+B",
      elements: [
        { field: "a", generateFuzzyComparisons: "edit_distances" },
        { field: "b", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set(["ABCDEFGHJKLMNOPQ"]),
    );
  });
});
