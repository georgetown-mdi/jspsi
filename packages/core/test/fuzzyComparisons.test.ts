import { expect, test, describe } from "vitest";

import {
  adjacentYearCandidates,
  dayMonthSwapCandidates,
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
import { APPLIED_SETTINGS } from "../src/consent/appliedSettings";
import { UsageError } from "../src/errors";
import type {
  GenerateFuzzyComparisons,
  LinkageKey,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";

const FUZZY_KINDS: readonly GenerateFuzzyComparisons[] = [
  "transpositions",
  "edit_distances",
  "adjacent_years",
  "day_month_swaps",
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
  test("emits every two-position swap, not the adjacent ones alone", () => {
    // All six pairs of a four-character value, in position order: the three
    // non-adjacent ones ("3214", "4231", "1432") are what an adjacent-only
    // enumeration misses, and what a value transposed across a separator needs.
    expect(transpositionCandidates("1234")).toEqual([
      "2134",
      "3214",
      "4231",
      "1324",
      "1432",
      "1243",
    ]);
  });

  test("the emitted set is the whole one-transposition neighbourhood", () => {
    // The full-variant property one-sided expansion rests on: every value one
    // transposition from "1234" is here, so a partner holding any of them meets
    // this value without expanding its own (docs/notes/one-sided-fuzzy-expansion.md).
    const points = Array.from("1234");
    const neighbourhood = new Set<string>();
    for (let i = 0; i < points.length; i++)
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        const swapped = [...points];
        swapped[i] = points[j];
        swapped[j] = points[i];
        const candidate = swapped.join("");
        if (candidate !== "1234") neighbourhood.add(candidate);
      }
    expect(new Set(transpositionCandidates("1234"))).toEqual(neighbourhood);
  });

  test("a pair of identical characters transposes to the original, so emits nothing", () => {
    // "AAB": swapping positions 0/1 reproduces "AAB", so only the two A/B swaps
    // are real candidates.
    expect(transpositionCandidates("AAB")).toEqual(["BAA", "ABA"]);
    expect(transpositionCandidates("AAAA")).toEqual([]);
  });

  test("no two pairs emit the same candidate", () => {
    // A swap of differing characters changes the value at exactly its own two
    // positions, so the pairs cannot collide -- which is what lets the ceiling be
    // the pair count rather than an over-declaration above it.
    for (const value of ["ABABAB", "AABBCC", "ABCABC", "AAB"]) {
      const candidates = transpositionCandidates(value);
      expect(new Set(candidates).size).toBe(candidates.length);
      expect(candidates).not.toContain(value);
    }
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

describe("dayMonthSwapCandidates", () => {
  test("emits the date read the other way round, keeping the year", () => {
    expect(dayMonthSwapCandidates("19900112")).toEqual(["19901201"]);
    expect(dayMonthSwapCandidates("19901201")).toEqual(["19900112"]);
  });

  test("drops an exchange that is not a real calendar date", () => {
    // A day above 12 names no month, so the exchange is dropped rather than
    // emitted as a month-15 or month-31 candidate no partner's date can hold.
    expect(dayMonthSwapCandidates("19900115")).toEqual([]);
    expect(dayMonthSwapCandidates("19901231")).toEqual([]);
    // Feb 29 of a leap year is a real date, and 29 is still no month.
    expect(dayMonthSwapCandidates("20000229")).toEqual([]);
  });

  test("emits nothing for a date whose day and month agree", () => {
    expect(dayMonthSwapCandidates("19900101")).toEqual([]);
    expect(dayMonthSwapCandidates("19901212")).toEqual([]);
  });

  test("refuses a value that is not a canonical YYYYMMDD date", () => {
    for (const value of ["1990-01-12", "12/01/1990", "SMITH", "199001120"]) {
      expect(() => dayMonthSwapCandidates(value)).toThrow(UsageError);
      expect(() => dayMonthSwapCandidates(value)).toThrow(/day_month_swaps/);
    }
  });

  test("the refusal names neither the value nor a partner string", () => {
    // The standardized value is the local PII the exchange keeps local.
    expect(() => dayMonthSwapCandidates("19900112X")).toThrow(
      /^(?!.*19900112).*$/s,
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
    expect(expandFuzzyComparisons("19900112", "day_month_swaps")[0]).toBe(
      "19900112",
    );
  });

  test("adjacent_years yields the value and one year either side", () => {
    expect(expandFuzzyComparisons("19900115", "adjacent_years")).toEqual([
      "19900115",
      "19890115",
      "19910115",
    ]);
  });

  test("day_month_swaps yields the value and the exchanged reading", () => {
    expect(expandFuzzyComparisons("19900112", "day_month_swaps")).toEqual([
      "19900112",
      "19901201",
    ]);
  });

  test("a value whose expansion is empty is still its own candidate", () => {
    expect(expandFuzzyComparisons("20000229", "adjacent_years")).toEqual([
      "20000229",
    ]);
    expect(expandFuzzyComparisons("19900115", "day_month_swaps")).toEqual([
      "19900115",
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
    for (const kind of FUZZY_KINDS) {
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
    expect(expandsOnReceiverOnly("day_month_swaps")).toBe(true);
    expect(expandsOnReceiverOnly("edit_distances")).toBe(false);
  });

  test("reads the kind alone, so both parties classify identically", () => {
    for (const kind of FUZZY_KINDS)
      expect(expandsOnReceiverOnly(kind)).toBe(expandsOnReceiverOnly(kind));
  });
});

describe("what each side's expansion buys, as an intersection", () => {
  // The two strategies, driven as the round drives them: one party's candidate
  // set against the other's, meeting when they share a value. `expanded` is what
  // a party that runs the expansion contributes and `[value]` what one that does
  // not, so each case below is a whole round in miniature.
  function meet(mine: string[], theirs: string[]): boolean {
    const set = new Set(mine);
    return theirs.some((value) => set.has(value));
  }
  const exact = (value: string): string[] => [value];
  const expanded = (value: string, kind: GenerateFuzzyComparisons): string[] =>
    expandFuzzyComparisons(value, kind);

  test("edit_distances needs BOTH sides to expand", () => {
    // A substitution: neither party's value is a deletion of the other's, so a
    // deletion neighbourhood on one side alone reaches nothing. The two meet at
    // "SMTH", which is a deletion of each.
    const mine = "SMITH";
    const theirs = "SMYTH";
    expect(meet(expanded(mine, "edit_distances"), exact(theirs))).toBe(false);
    expect(meet(exact(mine), expanded(theirs, "edit_distances"))).toBe(false);
    expect(
      meet(
        expanded(mine, "edit_distances"),
        expanded(theirs, "edit_distances"),
      ),
    ).toBe(true);
  });

  test.each([
    { kind: "transpositions" as const, mine: "123456789", theirs: "923456781" },
    { kind: "adjacent_years" as const, mine: "19900115", theirs: "19910115" },
    { kind: "day_month_swaps" as const, mine: "19900112", theirs: "19901201" },
  ])(
    "$kind meets on ONE side's expansion, whichever side that is",
    ({ kind, mine, theirs }) => {
      expect(meet(expanded(mine, kind), exact(theirs))).toBe(true);
      expect(meet(exact(mine), expanded(theirs, kind))).toBe(true);
    },
  );

  test.each([
    { kind: "transpositions" as const, mine: "123456789", theirs: "923456781" },
    { kind: "adjacent_years" as const, mine: "19900115", theirs: "19910115" },
    { kind: "day_month_swaps" as const, mine: "19900112", theirs: "19901201" },
  ])(
    "$kind on both sides adds candidates and no match the one side missed",
    ({ kind, mine, theirs }) => {
      // The cost of the symmetric reading: the pair already meets one-sided, so
      // the second party's candidates buy nothing but their own count -- work,
      // wire slots, and values that can collide with a THIRD record.
      const oneSided = expanded(mine, kind).length + exact(theirs).length;
      const symmetric =
        expanded(mine, kind).length + expanded(theirs, kind).length;
      expect(symmetric).toBeGreaterThan(oneSided);
      expect(meet(expanded(mine, kind), expanded(theirs, kind))).toBe(
        meet(expanded(mine, kind), exact(theirs)),
      );
    },
  );
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

  // Guards the assumption the rest of this file's expectations rest on. If
  // the flag is flipped without the PSI round that consumes a candidate set,
  // this fails rather than letting the gated-off expectations below silently
  // describe a behavior the build no longer has.
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

  test("a swapped key builds the exchanged order alone, not both orders", () => {
    // The swap's full variant is gated with the expansion beside it: a second key
    // string per row is a candidate set, which the cascade and the count-only
    // round refuse, so it lands with the round that consumes one.
    const dataset = makeDataset({ first_name: "JOHN", last_name: "SMITH" });
    const key: LinkageKey = {
      name: "FN+LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
      swap: ["first_name", "last_name"],
    };
    expect(buildKeyStrings(key, dataset, 0, true)).toEqual(
      new Set(["SMITHJOHN"]),
    );
    expect(buildKeyStrings(key, dataset, 0, false)).toEqual(
      new Set(["JOHNSMITH"]),
    );
    expect(
      declaredEffectiveKeyCount({ linkageKeys: [key] } as LinkageTerms),
    ).toBe(1);
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
