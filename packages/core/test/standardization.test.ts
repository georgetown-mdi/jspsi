import { expect, test, describe, afterEach, vi } from "vitest";

import {
  runPipeline,
  resolveFieldColumns,
  buildStandardizedDataset,
  buildKeyStrings,
  FAN_OUT_FUNCTION_NAMES,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  describeTransformCoercions,
  dateFormatComponents,
  StandardizedField,
  StandardizedDataset,
  accumulationFateAtCharge,
  canProduceMultipleValues,
  STANDARDIZATION_FUNCTION_NAMES,
} from "../src/standardization";
import * as standardizationModule from "../src/standardization";
import {
  ESC,
  PRINTABLE_ASCII,
  RLO,
} from "../src/consent/displayEscapingFixtures";
import { UnknownStandardizationFunctionError, UsageError } from "../src/errors";
import * as linearRegex from "../src/utils/linearRegex";
import { getLogger } from "../src/utils/logger";
import { inferMetadata } from "../src/config/metadata";
import type { ColumnMetadata } from "../src/config/metadata";
import {
  MAX_KEY_ELEMENTS,
  MAX_TRANSFORM_PARAM_LENGTH,
  safeParseLinkageTerms,
} from "../src/config/linkageTermsSchema";
import type {
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";
import { withUnlistedFanOutFunctions } from "./utils/unlistedFanOut";
import {
  isListedFanOutFunction,
  withNoListedFanOutFunctions,
} from "../src/fanOutFunctions";

const col = (name: string, type: ColumnMetadata["type"]): ColumnMetadata => ({
  name,
  type,
  role: "linkage",
  isPayload: false,
});

const roledCol = (
  name: string,
  type: ColumnMetadata["type"],
  role: ColumnMetadata["role"],
): ColumnMetadata => ({ name, type, role, isPayload: false });

// --- runPipeline: string functions -------------------------------------------

describe("runPipeline — string functions", () => {
  test("to_upper_case", () => {
    expect(runPipeline("smith", [{ function: "to_upper_case" }])).toBe("SMITH");
  });

  test("to_lower_case", () => {
    expect(runPipeline("SMITH", [{ function: "to_lower_case" }])).toBe("smith");
  });

  test("trim_whitespace", () => {
    expect(runPipeline("  Smith  ", [{ function: "trim_whitespace" }])).toBe(
      "Smith",
    );
  });

  test("remove_punctuation strips non-alphanumeric non-space characters", () => {
    expect(
      runPipeline("O'Brien-Smith!", [{ function: "remove_punctuation" }]),
    ).toBe("OBrienSmith");
  });

  test("remove_punctuation preserves spaces", () => {
    expect(runPipeline("O Brien", [{ function: "remove_punctuation" }])).toBe(
      "O Brien",
    );
  });

  test("remove_dashes", () => {
    expect(runPipeline("123-45-6789", [{ function: "remove_dashes" }])).toBe(
      "123456789",
    );
  });

  test("remove_non_ascii removes non-ASCII characters", () => {
    expect(runPipeline("café", [{ function: "remove_non_ascii" }])).toBe("caf");
  });

  test("remove_non_ascii removes emoji", () => {
    expect(runPipeline("hello🌍", [{ function: "remove_non_ascii" }])).toBe(
      "hello",
    );
  });

  test("remove_non_ascii leaves plain ASCII unchanged", () => {
    expect(runPipeline("SMITH", [{ function: "remove_non_ascii" }])).toBe(
      "SMITH",
    );
  });

  test("replace_separators_with_spaces replaces hyphens, apostrophes, ampersands, slashes, and underscores", () => {
    expect(
      runPipeline("O'Brien-Smith & Co/Inc_Ltd", [
        { function: "replace_separators_with_spaces" },
      ]),
    ).toBe("O Brien Smith   Co Inc Ltd");
  });

  test("replace_separators_with_spaces leaves other characters unchanged", () => {
    expect(
      runPipeline("SMITH", [{ function: "replace_separators_with_spaces" }]),
    ).toBe("SMITH");
  });

  test("squash_spaces collapses multiple spaces into one", () => {
    expect(runPipeline("SMITH  JONES", [{ function: "squash_spaces" }])).toBe(
      "SMITH JONES",
    );
  });

  test("squash_spaces leaves single spaces unchanged", () => {
    expect(runPipeline("SMITH JONES", [{ function: "squash_spaces" }])).toBe(
      "SMITH JONES",
    );
  });

  test("remove_accents strips diacritics", () => {
    expect(runPipeline("Héloïse", [{ function: "remove_accents" }])).toBe(
      "Heloise",
    );
  });

  test("remove_accents leaves plain ASCII unchanged", () => {
    expect(runPipeline("SMITH", [{ function: "remove_accents" }])).toBe(
      "SMITH",
    );
  });

  test("remove_affixes removes prefix", () => {
    expect(
      runPipeline("Dr. Jane Smith", [{ function: "remove_affixes" }]),
    ).toBe("Jane Smith");
  });

  test("remove_affixes removes suffix", () => {
    expect(
      runPipeline("John Smith Jr.", [{ function: "remove_affixes" }]),
    ).toBe("John Smith");
  });

  test("remove_affixes leaves plain name unchanged", () => {
    expect(runPipeline("Jane Smith", [{ function: "remove_affixes" }])).toBe(
      "Jane Smith",
    );
  });

  test("remove_affixes collapses the space left by a stripped interior title", () => {
    expect(runPipeline("JOHN MR SMITH", [{ function: "remove_affixes" }])).toBe(
      "JOHN SMITH",
    );
  });

  test("substring extracts the requested slice", () => {
    expect(
      runPipeline("SMITH", [
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("SMI");
  });

  test("substring with negative start counts from end", () => {
    expect(
      runPipeline("SMITH", [
        { function: "substring", params: { start: -3, length: 3 } },
      ]),
    ).toBe("ITH");
  });

  test("substring returns null when start is beyond end", () => {
    expect(
      runPipeline("AB", [
        { function: "substring", params: { start: 5, length: 3 } },
      ]),
    ).toBeNull();
  });

  test("substring returns null when start is zero", () => {
    expect(
      runPipeline("SMITH", [
        { function: "substring", params: { start: 0, length: 3 } },
      ]),
    ).toBeNull();
  });

  test("substring returns null when params are missing", () => {
    expect(runPipeline("SMITH", [{ function: "substring" }])).toBeNull();
  });

  test("substring with a valid integer slice still works", () => {
    expect(
      runPipeline("ABCDEFGHIJ", [
        { function: "substring", params: { start: 3, length: 5 } },
      ]),
    ).toBe("CDEFG");
  });

  test("substring drops a non-integer length without string-concatenating", () => {
    // The wire params are z.unknown(), so a partner can declare `length` as a
    // non-number. An unguarded `startIdx + length` would then concatenate strings
    // -- {start: 3, length: "5"} on "ABCDEFGHIJ" once sliced to "CDEFGHIJ" (from
    // index 2 to "2" + "5" = "25") rather than the intended "CDEFG". The guard
    // drops any non-integer bound to null instead.
    for (const length of ["5", 5.5, true, ["5"]]) {
      expect(
        runPipeline("ABCDEFGHIJ", [
          { function: "substring", params: { start: 3, length } },
        ]),
        JSON.stringify({ length }),
      ).toBeNull();
    }
  });

  test("substring drops a non-integer start without string-concatenating", () => {
    for (const start of ["3", 3.5, true, ["3"]]) {
      expect(
        runPipeline("ABCDEFGHIJ", [
          { function: "substring", params: { start, length: 5 } },
        ]),
        JSON.stringify({ start }),
      ).toBeNull();
    }
  });

  test("pad_left pads a short string with zeros", () => {
    expect(
      runPipeline("123", [{ function: "pad_left", params: { length: 9 } }]),
    ).toBe("000000123");
  });

  test("pad_left leaves a string at the target length unchanged", () => {
    expect(
      runPipeline("123456789", [
        { function: "pad_left", params: { length: 9 } },
      ]),
    ).toBe("123456789");
  });

  test("pad_left leaves a string longer than the target length unchanged", () => {
    expect(
      runPipeline("1234567890", [
        { function: "pad_left", params: { length: 9 } },
      ]),
    ).toBe("1234567890");
  });

  test("pad_left pads an empty string", () => {
    expect(
      runPipeline("", [{ function: "pad_left", params: { length: 9 } }]),
    ).toBe("000000000");
  });

  test("pad_left uses a custom pad character when specified", () => {
    expect(
      runPipeline("AB", [
        { function: "pad_left", params: { length: 4, char: "X" } },
      ]),
    ).toBe("XXAB");
  });

  test("pad_left with a non-string char does not throw and falls back to the default", () => {
    for (const badChar of [42, [], {}, true, null]) {
      const run = () =>
        runPipeline("AB", [
          { function: "pad_left", params: { length: 4, char: badChar } },
        ]);
      expect(run, JSON.stringify(badChar)).not.toThrow();
      expect(run(), JSON.stringify(badChar)).toBe("00AB");
    }
  });

  test("pad_left throws when length is missing", () => {
    expect(() =>
      runPipeline("123", [{ function: "pad_left", params: {} }]),
    ).toThrow('pad_left: "length" must be a positive integer');
  });

  test("pad_left throws when char is not a single character", () => {
    expect(() =>
      runPipeline("123", [
        { function: "pad_left", params: { length: 9, char: "AB" } },
      ]),
    ).toThrow('pad_left: "char" must be exactly one character');
  });

  test("pad_left throws when length is zero", () => {
    expect(() =>
      runPipeline("123", [{ function: "pad_left", params: { length: 0 } }]),
    ).toThrow('pad_left: "length" must be a positive integer');
  });

  test("pad_left throws when length is negative", () => {
    expect(() =>
      runPipeline("123", [{ function: "pad_left", params: { length: -1 } }]),
    ).toThrow('pad_left: "length" must be a positive integer');
  });

  test("pad_left throws when length is a non-integer", () => {
    expect(() =>
      runPipeline("123", [{ function: "pad_left", params: { length: 1.5 } }]),
    ).toThrow('pad_left: "length" must be a positive integer');
  });

  test("pad_left throws when length is not a number", () => {
    expect(() =>
      runPipeline("123", [{ function: "pad_left", params: { length: "9" } }]),
    ).toThrow('pad_left: "length" must be a positive integer');
  });
});

// --- runPipeline: parse_date -------------------------------------------------

describe("runPipeline — parse_date", () => {
  test("MM/DD/YYYY to YYYYMMDD", () => {
    expect(
      runPipeline("01/15/1990", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("19900115");
  });

  test("YYYY-MM-DD to YYYYMMDD", () => {
    expect(
      runPipeline("1990-01-15", [
        {
          function: "parse_date",
          params: { inputFormat: "YYYY-MM-DD", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("19900115");
  });

  test("DD/MM/YYYY to YYYYMMDD", () => {
    expect(
      runPipeline("15/01/1990", [
        {
          function: "parse_date",
          params: { inputFormat: "DD/MM/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("19900115");
  });

  test("single-digit month and day are zero-padded", () => {
    expect(
      runPipeline("1/5/1990", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("19900105");
  });

  test("unparseable date returns null", () => {
    expect(
      runPipeline("not-a-date", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBeNull();
  });

  test("calendar-invalid date returns null", () => {
    expect(
      runPipeline("13/01/1990", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBeNull();
  });

  test("Feb 29 in a non-leap year returns null (rolls over to Mar 1)", () => {
    expect(
      runPipeline("02/29/2021", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBeNull();
  });

  test("Feb 29 in a leap year round-trips", () => {
    expect(
      runPipeline("02/29/2020", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("20200229");
  });

  test("a day exceeding the month's length returns null (rolls over)", () => {
    expect(
      runPipeline("04/31/2021", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBeNull();
  });

  test("a valid ordinary date round-trips", () => {
    expect(
      runPipeline("06/15/2021", [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("20210615");
  });

  test("adjacent literal separators are matched literally, not as regex metacharacters", () => {
    const params = { inputFormat: "YYYY-MM..DD", outputFormat: "YYYYMMDD" };
    expect(
      runPipeline("1990-12..31", [{ function: "parse_date", params }]),
    ).toBe("19901231");
    expect(
      runPipeline("1990-12.x31", [{ function: "parse_date", params }]),
    ).toBeNull();
  });

  test("a non-string output format does not throw and falls back to the default", () => {
    for (const bad of [42, [], {}, true, null]) {
      const badOutput = () =>
        runPipeline("06/15/2021", [
          {
            function: "parse_date",
            params: { inputFormat: "MM/DD/YYYY", outputFormat: bad },
          },
        ]);
      expect(badOutput, JSON.stringify(bad)).not.toThrow();
      expect(badOutput(), JSON.stringify(bad)).toBe("20210615");
    }
  });

  test("a non-string input format drops the record without throwing", () => {
    for (const bad of [42, ["MM"], {}, true]) {
      const badInput = () =>
        runPipeline("06/15/2021", [
          { function: "parse_date", params: { inputFormat: bad } },
        ]);
      expect(badInput, JSON.stringify(bad)).not.toThrow();
      expect(badInput(), JSON.stringify(bad)).toBeNull();
    }
  });

  // A two-digit YY year resolves through the fixed protocol pivot (the 1969-2068
  // POSIX window), a module constant identical on both parties -- there is no
  // reference param, no terms date, and no clock read on this path.
  describe("two-digit year (YY) input fixed-constant pivot", () => {
    const parseYY = (value: string) =>
      runPipeline(value, [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YY", outputFormat: "YYYYMMDD" },
        },
      ]);

    test("68 maps to 2068 (the top of the window)", () => {
      expect(parseYY("06/15/68")).toBe("20680615");
    });

    test("69 maps to 1969 (the bottom of the window)", () => {
      expect(parseYY("06/15/69")).toBe("19690615");
    });

    test("00 maps to 2000", () => {
      expect(parseYY("06/15/00")).toBe("20000615");
    });

    test("99 maps to 1999", () => {
      expect(parseYY("06/15/99")).toBe("19990615");
    });

    test("single-digit month and day still zero-pad under YY", () => {
      expect(parseYY("1/5/90")).toBe("19900105");
    });

    test("a calendar-invalid day under YY returns null", () => {
      expect(parseYY("02/30/90")).toBeNull();
    });

    test("YYYY still wins its shared YY prefix (four-digit year unchanged)", () => {
      expect(
        runPipeline("06/15/2027", [
          {
            function: "parse_date",
            params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
          },
        ]),
      ).toBe("20270615");
    });

    test("the pivot does not read the wall clock", () => {
      // The result must not move with the system year: pin the same input twice
      // under two different mocked clocks and require identical output. This is
      // definitional with a constant pivot, so it also stands as a regression
      // guard against any future clock read sneaking back into the path.
      const under = (fakeYear: number) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(`${fakeYear}-01-01T00:00:00Z`));
        try {
          return parseYY("06/15/40");
        } finally {
          vi.useRealTimers();
        }
      };
      const partyA = under(2010);
      const partyB = under(2099);
      expect(partyA).toBe("20400615");
      expect(partyB).toBe(partyA);
    });
  });

  // In an OUTPUT format a `YY` token is NOT a resolved year: the factory
  // substitutes only YYYY/MM/DD, so a `YY` in the output emits literally and
  // collapses the year to a constant.
  describe("two-digit year (YY) in the output format is a literal", () => {
    const parseWithOutput = (value: string, outputFormat: string) =>
      runPipeline(value, [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat },
        },
      ]);

    test("YY in the output is emitted literally, not the resolved year", () => {
      // The output MM/DD/YY keeps month and day but writes the literal "YY" where
      // the year would go -- the year has collapsed to a constant.
      expect(parseWithOutput("06/15/1990", "MM/DD/YY")).toBe("06/15/YY");
    });

    test('a YY-only output collapses every date to the constant "YY"', () => {
      expect(parseWithOutput("06/15/1990", "YY")).toBe("YY");
      expect(parseWithOutput("01/02/2003", "YY")).toBe("YY");
    });
  });

  test("a repeated output token is substituted at every occurrence", () => {
    const parseWithOutput = (value: string, outputFormat: string) =>
      runPipeline(value, [
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat },
        },
      ]);
    expect(parseWithOutput("06/15/1990", "MM/DD/MM")).toBe("06/15/06");
    expect(parseWithOutput("06/15/1990", "YYYY-YYYY")).toBe("1990-1990");
    expect(parseWithOutput("06/15/1990", "DD.DD.DD")).toBe("15.15.15");
  });
});

// --- dateFormatComponents (context-aware) ------------------------------------

describe("dateFormatComponents", () => {
  test("an input YY collapses to the canonical year component", () => {
    // The input factory resolves either year token to a four-digit year, so an
    // input with a YY token reports the year exactly as one with a YYYY token
    // does.
    expect([...dateFormatComponents("MM/DD/YY", "input")].sort()).toEqual([
      "DD",
      "MM",
      "YYYY",
    ]);
    expect([...dateFormatComponents("MM/DD/YYYY", "input")].sort()).toEqual([
      "DD",
      "MM",
      "YYYY",
    ]);
  });

  test("an output YY has no year (it is an unsubstituted literal)", () => {
    // The factory substitutes only YYYY/MM/DD into the output; a YY in the output
    // emits literally, so it has no year component and the year has collapsed.
    expect([...dateFormatComponents("MM/DD/YY", "output")].sort()).toEqual([
      "DD",
      "MM",
    ]);
    expect([...dateFormatComponents("YY", "output")]).toEqual([]);
  });

  test("YYYY greedily wins its YY prefix in both contexts", () => {
    // A four-digit-year layout is never mis-detected as a two-digit year, so
    // MM/DD/YYYY reports one year component, not a phantom extra.
    expect([...dateFormatComponents("MM/DD/YYYY", "output")].sort()).toEqual([
      "DD",
      "MM",
      "YYYY",
    ]);
  });

  test("MM and DD map to themselves in both contexts", () => {
    for (const context of ["input", "output"] as const)
      expect([...dateFormatComponents("MM-DD", context)].sort()).toEqual([
        "DD",
        "MM",
      ]);
  });
});

// --- runPipeline: phonetic ---------------------------------------------------

describe("runPipeline — phonetic (soundex)", () => {
  test("SMITH -> S530", () => {
    expect(
      runPipeline("SMITH", [
        { function: "phonetic", params: { algorithm: "soundex" } },
      ]),
    ).toBe("S530");
  });

  test("ROBERT -> R163", () => {
    expect(
      runPipeline("ROBERT", [
        { function: "phonetic", params: { algorithm: "soundex" } },
      ]),
    ).toBe("R163");
  });

  test("default algorithm is soundex", () => {
    expect(runPipeline("JONES", [{ function: "phonetic" }])).toBe("J520");
  });

  test("empty string returns null", () => {
    expect(
      runPipeline("", [
        { function: "phonetic", params: { algorithm: "soundex" } },
      ]),
    ).toBeNull();
  });
});

// --- runPipeline: null-producing functions -----------------------------------

describe("runPipeline — null-producing functions", () => {
  test("null_if with value param", () => {
    expect(
      runPipeline("000000000", [
        { function: "null_if", params: { value: "000000000" } },
      ]),
    ).toBeNull();
  });

  test("null_if with values array", () => {
    expect(
      runPipeline("123456789", [
        {
          function: "null_if",
          params: { values: ["000000000", "123456789", "111111111"] },
        },
      ]),
    ).toBeNull();
  });

  test("null_if passes through non-matching value", () => {
    expect(
      runPipeline("987654321", [
        {
          function: "null_if",
          params: { values: ["000000000", "123456789"] },
        },
      ]),
    ).toBe("987654321");
  });

  test("null_if with a non-string value/values param does not throw and excludes nothing", () => {
    const cases: Record<string, unknown>[] = [
      { value: null },
      { values: null },
      { value: 42 },
      { value: {} },
      { values: [null] },
      { values: [42] },
      { values: 42 },
      { values: "SMITH" },
    ];
    for (const params of cases) {
      const run = () => runPipeline("SMITH", [{ function: "null_if", params }]);
      expect(run, JSON.stringify(params)).not.toThrow();
      expect(run(), JSON.stringify(params)).toBe("SMITH");
    }
  });

  test("null_if drops non-string entries but keeps string entries in a mixed array", () => {
    // A mixed array excludes only its string members; the non-string entries are
    // dropped rather than crashing normalization.
    expect(
      runPipeline("SMITH", [
        { function: "null_if", params: { values: [42, "SMITH"] } },
      ]),
    ).toBeNull();
    expect(
      runPipeline("JONES", [
        { function: "null_if", params: { values: [42, "SMITH"] } },
      ]),
    ).toBe("JONES");
  });

  test("filter_regex passes through matching value", () => {
    expect(
      runPipeline("SMITH", [
        { function: "filter_regex", params: { pattern: "^[A-Z]+$" } },
      ]),
    ).toBe("SMITH");
  });

  test("filter_regex returns null on non-match", () => {
    expect(
      runPipeline("Smith123", [
        { function: "filter_regex", params: { pattern: "^[A-Z]+$" } },
      ]),
    ).toBeNull();
  });

  test("extract_regex returns first capture group", () => {
    expect(
      runPipeline("SMITH-JONES", [
        { function: "extract_regex", params: { pattern: "^(\\w+)-" } },
      ]),
    ).toBe("SMITH");
  });

  test("extract_regex returns null on no match", () => {
    expect(
      runPipeline("SMITH", [
        { function: "extract_regex", params: { pattern: "^(\\w+)-" } },
      ]),
    ).toBeNull();
  });

  test("replace_regex substitutes all matches", () => {
    expect(
      runPipeline("  A  B  ", [
        {
          function: "replace_regex",
          params: { pattern: "\\s+", replacement: " " },
        },
      ]),
    ).toBe(" A B ");
  });

  test("replace_regex with no replacement param uses empty string", () => {
    expect(
      runPipeline("A1B2C3", [
        { function: "replace_regex", params: { pattern: "\\d" } },
      ]),
    ).toBe("ABC");
  });

  test("an amplifying replacement runs unbounded on this party's own standardization", () => {
    // The scope boundary of the transformed-value ceiling, which binds the
    // PARTNER-authored element transform (pinned under buildKeyStrings below).
    // This pipeline is the operator's own local configuration over the
    // operator's own data, so nothing partner-influenced sizes it and the
    // ceiling does not reach it. A strict lower bound, so a
    // regex-engine or Unicode-data change cannot satisfy it by drifting a count.
    const cell = "1234567890";
    const trailingContext = "$'".repeat(MAX_TRANSFORM_PARAM_LENGTH / 2);
    const out = runPipeline(cell, [
      {
        function: "replace_regex",
        params: { pattern: "a*", replacement: trailingContext },
      },
    ]);
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeGreaterThan(
      cell.length + (cell.length + 1) * MAX_TRANSFORM_PARAM_LENGTH,
    );
  });

  test("replace_regex with a non-string replacement does not throw and falls back to empty", () => {
    for (const badReplacement of [42, [], {}, true, null]) {
      const run = () =>
        runPipeline("A1B2C3", [
          {
            function: "replace_regex",
            params: { pattern: "\\d", replacement: badReplacement },
          },
        ]);
      expect(run, JSON.stringify(badReplacement)).not.toThrow();
      expect(run(), JSON.stringify(badReplacement)).toBe("ABC");
    }
  });
});

// --- runPipeline: coalesce ---------------------------------------------------

describe("runPipeline — coalesce", () => {
  test("coalesce replaces null with default", () => {
    expect(
      runPipeline("", [
        { function: "null_if", params: { value: "" } },
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toBe("UNKNOWN");
  });

  test("coalesce passes through non-null value unchanged", () => {
    expect(
      runPipeline("SMITH", [
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toBe("SMITH");
  });

  test("coalesce replaces empty set (all values nulled out)", () => {
    expect(
      runPipeline("SMITH-JONES", [
        { function: "split_on", params: { delimiter: "-" } },
        { function: "null_if", params: { values: ["SMITH", "JONES"] } },
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toBe("UNKNOWN");
  });

  test("coalesce with a non-string default does not throw and behaves as absent", () => {
    const absent = runPipeline("", [
      { function: "null_if", params: { value: "" } },
      { function: "coalesce" },
    ]);
    for (const badDefault of [null, 42, [], {}, true]) {
      const run = () =>
        runPipeline("", [
          { function: "null_if", params: { value: "" } },
          { function: "coalesce", params: { default: badDefault } },
        ]);
      expect(run, JSON.stringify(badDefault)).not.toThrow();
      expect(run(), JSON.stringify(badDefault)).toBeNull();
      expect(run(), JSON.stringify(badDefault)).toBe(absent);
    }
  });

  test("coalesce with a non-string default passes a present value through", () => {
    for (const badDefault of [null, 42, [], {}, true]) {
      expect(
        runPipeline("SMITH", [
          { function: "coalesce", params: { default: badDefault } },
        ]),
        JSON.stringify(badDefault),
      ).toBe("SMITH");
    }
  });
});

// --- runPipeline: null propagation -------------------------------------------

describe("runPipeline — null propagation", () => {
  test("null propagates through subsequent steps", () => {
    expect(
      runPipeline("000", [
        { function: "null_if", params: { value: "000" } },
        { function: "to_upper_case" },
        { function: "trim_whitespace" },
      ]),
    ).toBeNull();
  });
});

// --- runPipeline: unknown function -------------------------------------------

test("unknown function name throws", () => {
  expect(() =>
    runPipeline("x", [{ function: "nonexistent_function" }]),
  ).toThrow(
    "unknown standardization function: a function this build does not recognize",
  );
});

test("an unknown function name is refused as a typed usage error", () => {
  // The class, not just the message: the refusal is deterministic in the steps it
  // compiled, so a consumer classifying it -- the CLI's error->exit boundary maps
  // a UsageError to 64 -- must not see a bare Error and read it as the transport
  // having failed. Both surfaces the compiler serves are pinned, since the
  // element-transform one holds partner-authored steps.
  expect(() =>
    runPipeline("x", [{ function: "nonexistent_function" }]),
  ).toThrow(UnknownStandardizationFunctionError);
  expect(() =>
    buildKeyStrings(
      {
        name: "K",
        elements: [{ field: "f", transform: [{ function: "no" }] }],
      },
      new StandardizedDataset(
        [new StandardizedField("f", "F", [], [{ F: "value" }])],
        [{ name: "K", elements: [{ field: "f" }] }],
      ),
      0,
    ),
  ).toThrow(UnknownStandardizationFunctionError);
  expect(new UnknownStandardizationFunctionError("x")).toBeInstanceOf(
    UsageError,
  );
});

// --- runPipeline: fan-out ----------------------------------------------------

describe("runPipeline — split_on fan-out", () => {
  test("split_on on hyphen returns parts", () => {
    expect(
      runPipeline("SMITH-JONES", [
        { function: "split_on", params: { delimiter: "-" } },
      ]),
    ).toEqual(new Set(["SMITH", "JONES"]));
  });

  test("split_on with include_original prepends the original", () => {
    expect(
      runPipeline("SMITH-JONES", [
        {
          function: "split_on",
          params: { delimiter: "-", includeOriginal: true },
        },
      ]),
    ).toEqual(new Set(["SMITH-JONES", "SMITH", "JONES"]));
  });

  test("split_on with no delimiter match returns single-element set", () => {
    expect(
      runPipeline("SMITH", [
        { function: "split_on", params: { delimiter: "-" } },
      ]),
    ).toEqual(new Set(["SMITH"]));
  });

  test("steps after split_on apply element-wise", () => {
    expect(
      runPipeline("smith-jones", [
        { function: "split_on", params: { delimiter: "-" } },
        { function: "to_upper_case" },
      ]),
    ).toEqual(new Set(["SMITH", "JONES"]));
  });

  test("null_if after split_on filters matching elements", () => {
    expect(
      runPipeline("SMITH-UNKNOWN", [
        { function: "split_on", params: { delimiter: "-" } },
        { function: "null_if", params: { value: "UNKNOWN" } },
      ]),
    ).toEqual(new Set(["SMITH"]));
  });

  test("null_if after split_on returns null when all elements filtered", () => {
    expect(
      runPipeline("X-X", [
        { function: "split_on", params: { delimiter: "-" } },
        { function: "null_if", params: { value: "X" } },
      ]),
    ).toBeNull();
  });
});

// --- runPipeline: NFC normalization ------------------------------------------

describe("NFC normalization (unconditional first pipeline step)", () => {
  // "Jose" with an accented e: precomposed NFC (U+00E9) vs decomposed NFD
  // (plain e + combining acute U+0301). Written with \u escapes because the two
  // forms are indistinguishable in a source editor.
  const NFC_JOSE = "Jos\u00e9";
  const NFD_JOSE = "Jose\u0301";

  test("identity pipeline (no steps) collapses NFD to NFC bytes", () => {
    expect(runPipeline(NFD_JOSE, [])).toBe(NFC_JOSE);
    expect(runPipeline(NFC_JOSE, [])).toBe(NFC_JOSE);
  });

  test("custom pipeline that never strips to ASCII still normalizes", () => {
    // to_lower_case only -- no remove_accents, no remove_non_ascii. The accent
    // survives, but the output is NFC regardless of the input's form.
    const steps = [{ function: "to_lower_case" }];
    expect(runPipeline(NFD_JOSE, steps)).toBe("jos\u00e9");
    expect(runPipeline(NFC_JOSE, steps)).toBe("jos\u00e9");
    expect(runPipeline(NFD_JOSE, steps)).toBe(runPipeline(NFC_JOSE, steps));
  });

  test("NFC and NFD inputs collapse to one standardized field value", () => {
    const steps = [{ function: "to_upper_case" }];
    const nfc = new StandardizedField("first_name", "FN", steps, [
      { FN: NFC_JOSE },
    ]);
    const nfd = new StandardizedField("first_name", "FN", steps, [
      { FN: NFD_JOSE },
    ]);
    expect(nfd.get(0)).toEqual(["JOS\u00c9"]);
    expect(nfd.get(0)).toEqual(nfc.get(0));
  });

  test("NFC and NFD inputs yield identical key strings end-to-end", () => {
    const key = { name: "FN", elements: [{ field: "first_name" }] };
    const make = (raw: string) =>
      new StandardizedDataset(
        [
          new StandardizedField(
            "first_name",
            "FN",
            [{ function: "to_upper_case" }],
            [{ FN: raw }],
          ),
        ],
        [key],
      );
    expect(buildKeyStrings(key, make(NFD_JOSE), 0)).toEqual(
      buildKeyStrings(key, make(NFC_JOSE), 0),
    );
  });

  test("non-Latin multi-codepoint grapheme composes (Hangul jamo)", () => {
    // The Hangul syllable U+D55C is the canonical composition of its three
    // jamo U+1112 U+1161 U+11AB; the decomposed form must collapse to it.
    const composed = "\ud55c";
    const decomposed = "\u1112\u1161\u11ab";
    expect(runPipeline(decomposed, [])).toBe(composed);
  });

  test("remove_accents re-normalizes to NFC (no decomposed residue)", () => {
    // U+0622 (Arabic alef with madda above) decomposes to U+0627 + U+0653; the
    // maddah (U+0653) is outside the stripped U+0300-U+036F range and survives,
    // so the re-NFC then recomposes U+0627 + U+0653 back into the single
    // precomposed U+0622. Without that re-NFC, remove_accents would instead emit
    // the two-code-point decomposed sequence.
    const out = runPipeline("\u0622", [{ function: "remove_accents" }]);
    expect(out).toBe("\u0622");
    expect((out as string).length).toBe(1);
  });
});

// --- Config-literal NFC normalization ----------------------------------------

describe("NFC normalization of config literals", () => {
  // Config strings are compared against, or injected into, the now-NFC runtime
  // value, so they must themselves be NFC. "Jose" with an accented e:
  // precomposed (U+00E9) vs decomposed (e + U+0301), as \u escapes.
  const NFC_JOSE = "Jos\u00e9";
  const NFD_JOSE = "Jose\u0301";

  test("null_if matches an NFD exclusion value against the NFC runtime value", () => {
    expect(
      runPipeline(NFC_JOSE, [
        { function: "null_if", params: { value: NFD_JOSE } },
      ]),
    ).toBeNull();
  });

  test("coalesce normalizes its default to NFC", () => {
    expect(
      runPipeline("", [
        { function: "null_if", params: { value: "" } },
        { function: "coalesce", params: { default: NFD_JOSE } },
      ]),
    ).toBe(NFC_JOSE);
  });

  test("replace_regex normalizes its replacement to NFC", () => {
    expect(
      runPipeline("X", [
        {
          function: "replace_regex",
          params: { pattern: "X", replacement: NFD_JOSE },
        },
      ]),
    ).toBe(NFC_JOSE);
  });

  test("pad_left normalizes its pad character to NFC", () => {
    // U+2126 (Ohm sign) is one code unit whose NFC form is U+03A9 (Omega).
    expect(
      runPipeline("AB", [
        { function: "pad_left", params: { length: 4, char: "\u2126" } },
      ]),
    ).toBe("\u03a9\u03a9AB");
  });

  test("pad_left rejects a pad character that NFC-expands to multiple units", () => {
    // U+0344 is one code unit but NFC-decomposes to U+0308 U+0301; a multi-unit
    // pad would corrupt the output via padStart's cycling, so it is rejected
    // rather than silently padded.
    expect(() =>
      runPipeline("AB", [
        { function: "pad_left", params: { length: 4, char: "\u0344" } },
      ]),
    ).toThrow('pad_left: "char" must be exactly one character');
  });
});

// --- Mid-pipeline NFC-safe comparisons ---------------------------------------

describe("NFC-safe mid-pipeline comparisons (null_if / filter_regex / extract_regex)", () => {
  // U+0390 (GREEK SMALL LETTER IOTA WITH DIALYTIKA AND TONOS) is itself valid
  // NFC, but to_upper_case emits the non-NFC sequence U+0399 U+0308 U+0301,
  // whose NFC form is U+03AA U+0301 -- the form an exclusion or pattern is
  // authored in. The comparison steps read this value before the final
  // key-string NFC pass, so each must normalize the value it inspects or an
  // authored-NFC comparison silently misses.
  const GREEK_INPUT = "\u0390";
  const UPPER_NONNFC = "\u0399\u0308\u0301"; // to_upper_case output, non-NFC
  const UPPER_NFC = "\u03aa\u0301"; // its NFC form (authored)

  test("sanity: the case-folded value is non-NFC and differs from its NFC form", () => {
    // Guards the constants below and documents the bug precondition: the value
    // reaching the comparison step is non-NFC.
    expect(GREEK_INPUT.toUpperCase()).toBe(UPPER_NONNFC);
    expect(UPPER_NONNFC.normalize("NFC")).toBe(UPPER_NFC);
    expect(UPPER_NONNFC).not.toBe(UPPER_NFC);
  });

  test("null_if drops a case-folded value via an NFC-authored exclusion", () => {
    // Without the in-step normalize the non-NFC runtime value survives.
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        { function: "null_if", params: { value: UPPER_NFC } },
      ]),
    ).toBeNull();
  });

  test("filter_regex matches a case-folded value via an NFC-authored pattern", () => {
    // The pattern matches the NFC form; a match returns the original
    // (pre-normalize) value, leaving downstream bytes untouched.
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        { function: "filter_regex", params: { pattern: "^\u03aa\u0301$" } },
      ]),
    ).toBe(UPPER_NONNFC);
  });

  test("extract_regex matches a case-folded value and returns the NFC capture", () => {
    // The capture is sliced from the normalized value: the non-NFC original has
    // no U+03AA at all (its diaeresis is a separate U+0308), so a capture taken
    // from the original would misalign.
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        { function: "extract_regex", params: { pattern: "^(\u03aa)\u0301$" } },
      ]),
    ).toBe("\u03aa");
  });

  test("replace_regex matches a case-folded value via an NFC-authored pattern", () => {
    // Without the in-step normalize the non-NFC runtime value never matches, so
    // the substitution silently does not fire and the value passes through.
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        {
          function: "replace_regex",
          params: { pattern: UPPER_NFC, replacement: "X" },
        },
      ]),
    ).toBe("X");
  });

  test("split_on splits on an NFC-authored delimiter after a case-fold", () => {
    // The delimiter is the case-folded letter in NFC form; without the in-step
    // normalize it would not match the non-NFC value and the split would not
    // happen.
    expect(
      runPipeline(`A${GREEK_INPUT}B`, [
        { function: "to_upper_case" },
        { function: "split_on", params: { delimiter: UPPER_NFC } },
      ]),
    ).toEqual(new Set(["A", "B"]));
  });

  test("split_on with no delimiter match returns the NFC-normalized value", () => {
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        { function: "split_on", params: { delimiter: "," } },
      ]),
    ).toEqual(new Set([UPPER_NFC]));
  });

  test("regression: an already-NFC value flows through with unchanged bytes", () => {
    const NFC_JOSE = "Jos\u00e9";
    expect(
      runPipeline(NFC_JOSE, [{ function: "null_if", params: { value: "X" } }]),
    ).toBe(NFC_JOSE);
    expect(
      runPipeline(NFC_JOSE, [
        { function: "filter_regex", params: { pattern: "\u00e9$" } },
      ]),
    ).toBe(NFC_JOSE);
    expect(
      runPipeline(NFC_JOSE, [
        { function: "extract_regex", params: { pattern: "^(Jos\u00e9)$" } },
      ]),
    ).toBe(NFC_JOSE);
    expect(
      runPipeline(NFC_JOSE, [
        {
          function: "replace_regex",
          params: { pattern: "Z", replacement: "Q" },
        },
      ]),
    ).toBe(NFC_JOSE);
    expect(
      runPipeline(NFC_JOSE, [
        { function: "split_on", params: { delimiter: "," } },
      ]),
    ).toEqual(new Set([NFC_JOSE]));
  });

  test("length-sensitive step after a case-fold is cross-party-safe (NFC == NFD input)", () => {
    // to_upper_case leaves a non-NFC intermediate (U+0399 U+0308 U+0301) that a
    // length-sensitive step such as substring then operates on. This is
    // cross-party-safe: the intermediate is deterministic from the
    // NFC-normalized input, so the same logical value authored as NFC (U+0390)
    // vs NFD (U+03B9 U+0308 U+0301) converges before to_upper_case and yields
    // an identical key. substring(1,1) confirms it sees the non-NFC intermediate.
    const nfc = "\u0390";
    const nfd = "\u03b9\u0308\u0301";
    const steps = [
      { function: "to_upper_case" },
      { function: "substring", params: { start: 1, length: 1 } },
    ];
    expect(runPipeline(nfd, steps)).toBe(runPipeline(nfc, steps));
    expect(runPipeline(nfc, steps)).toBe("\u0399");
  });
});

// --- Key-string NFC normalization --------------------------------------------

describe("buildKeyStrings: NFC normalization of the assembled key", () => {
  const NFC_JOSE = "Jos\u00e9";
  const NFD_JOSE = "Jose\u0301";

  test("element-transform replacement literal is NFC in the key", () => {
    const key = {
      name: "FN",
      elements: [
        {
          field: "first_name",
          transform: [
            {
              function: "replace_regex",
              params: { pattern: "^.*$", replacement: NFD_JOSE },
            },
          ],
        },
      ],
    };
    const dataset = new StandardizedDataset(
      [new StandardizedField("first_name", "FN", [], [{ FN: "anything" }])],
      [key],
    );
    expect(buildKeyStrings(key, dataset, 0)).toEqual(new Set([NFC_JOSE]));
  });

  test("key is NFC when concatenation crosses a combining-mark boundary", () => {
    // Element a is a base letter and element b is a lone combining acute; each
    // value is NFC on its own, but the joined "e" + U+0301 composes, so the
    // final NFC pass recomposes it to the precomposed U+00E9.
    const key = { name: "AB", elements: [{ field: "a" }, { field: "b" }] };
    const rows = [{ a: "e", b: "\u0301" }];
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("a", "a", [], rows),
        new StandardizedField("b", "b", [], rows),
      ],
      [key],
    );
    expect(buildKeyStrings(key, dataset, 0)).toEqual(new Set(["\u00e9"]));
  });
});

describe("buildKeyStrings: element-transform compilation reused across rows", () => {
  // afterEach restores the compileLinearRegex spy even after a test throws
  // mid-body: a skipped per-test restore would leave a stale spy whose call
  // count carries into the next test, inflating its assertion and masking a
  // real regression instead of a clean independent failure.
  afterEach(() => vi.restoreAllMocks());

  // The element transform compiles once and is memoized by the step array's
  // identity, then reused for every row. A memoization bug would cross-contaminate
  // rows or stale a result, so build several rows through one regex element
  // transform and assert each is independently correct.
  test("a regex element transform yields the correct key for each row", () => {
    const key = {
      name: "SSN4",
      elements: [
        {
          field: "ssn",
          transform: [
            { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
          ],
        },
      ],
    };
    const rows = [{ SSN: "111223333" }, { SSN: "444556666" }, { SSN: "abc" }];
    const dataset = new StandardizedDataset(
      [new StandardizedField("ssn", "SSN", [], rows)],
      [key],
    );
    expect(buildKeyStrings(key, dataset, 0)).toEqual(new Set(["3333"]));
    expect(buildKeyStrings(key, dataset, 1)).toEqual(new Set(["6666"]));
    // No 4-digit tail -> the element produces no value -> the key collapses.
    expect(buildKeyStrings(key, dataset, 2)).toBeNull();
  });

  // Compile-once per element is a security control, not just a perf win: a
  // schema-valid but hostile terms set can hold more distinct patterns than
  // the linear-time engine's compile cache, so per-row recompilation would
  // thrash it into unbounded CPU cost. Spying on compileLinearRegex -- the
  // one entry point every regex/parse_date factory calls at closure-build
  // time -- turns "no per-row recompile" into a check.
  test("a regex element transform compiles once across many rows, not per row", () => {
    const key = {
      name: "SSN4",
      elements: [
        {
          field: "ssn",
          transform: [
            { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
          ],
        },
      ],
    };
    const rowCount = 50;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      SSN: `${100000000 + i}`,
    }));
    const dataset = new StandardizedDataset(
      [new StandardizedField("ssn", "SSN", [], rows)],
      [key],
    );

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("a parse_date element transform compiles once across many rows, not per row", () => {
    const key = {
      name: "DOB",
      elements: [
        {
          field: "dob",
          transform: [
            {
              function: "parse_date",
              params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
            },
          ],
        },
      ],
    };
    const rowCount = 50;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      DOB: `01/${String((i % 28) + 1).padStart(2, "0")}/2020`,
    }));
    const dataset = new StandardizedDataset(
      [new StandardizedField("dob", "DOB", [], rows)],
      [key],
    );

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    // parse_date builds its input-format regex once at closure-build time; memoized,
    // that build is shared across all 50 rows.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("the swap path preserves the per-element compile cache (compiles per element, not per row)", () => {
    // swapElements rebuilds the element wrapper objects on every receiver row but
    // preserves each element's own `transform` array reference, so the WeakMap keyed
    // on that array still hits across rows under swap. A swap that copied the steps
    // would silently reintroduce per-row recompilation; pin that it does not.
    const key = {
      name: "SWAP",
      swap: ["a", "b"] as [string, string],
      elements: [
        {
          name: "a",
          field: "first",
          transform: [
            { function: "extract_regex", params: { pattern: "(\\d{2})$" } },
          ],
        },
        {
          name: "b",
          field: "second",
          transform: [
            { function: "extract_regex", params: { pattern: "^(\\d{2})" } },
          ],
        },
      ],
    };
    const rowCount = 30;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      FIRST: `${1000 + i}`,
      SECOND: `${2000 + i}`,
    }));
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("first", "FIRST", [], rows),
        new StandardizedField("second", "SECOND", [], rows),
      ],
      [key],
    );

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i, true);
    // Two distinct element-transform arrays -> two compiles across all 30 rows.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("compile count tracks distinct element transforms, not row count", () => {
    // Pins the invariant the security comment above rests on: total compiles
    // equal the number of DISTINCT element transforms, flat in the row count,
    // by building several at once. The schema bounds that distinct count
    // (MAX_LINKAGE_ENTRIES * MAX_KEY_ELEMENTS), far below the rows a real
    // dataset holds, which is why per-element rather than per-row compilation
    // is the bound that matters. Mixes regex and parse_date transforms.
    const key = {
      name: "MULTI",
      elements: [
        {
          field: "f1",
          transform: [
            { function: "extract_regex", params: { pattern: "(\\d{2})$" } },
          ],
        },
        {
          field: "f2",
          transform: [
            { function: "extract_regex", params: { pattern: "^(\\d{2})" } },
          ],
        },
        {
          field: "f3",
          transform: [
            { function: "extract_regex", params: { pattern: "(\\d{3})" } },
          ],
        },
        {
          field: "f4",
          transform: [
            { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
          ],
        },
      ],
    };
    const rowCount = 50;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      F1: `${1000 + i}`,
      F2: `${2000 + i}`,
      F3: `${3000 + i}`,
      F4: `01/${String((i % 28) + 1).padStart(2, "0")}/2020`,
    }));
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("f1", "F1", [], rows),
        new StandardizedField("f2", "F2", [], rows),
        new StandardizedField("f3", "F3", [], rows),
        new StandardizedField("f4", "F4", [], rows),
      ],
      [key],
    );

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  test("a multi-step element transform compiles every step once, not per row", () => {
    // The other compile-count tests pin "one transform array -> one compile"
    // but not "every STEP of the array compiles once". The WeakMap caches the
    // whole compiled array by identity, so each regex-bearing step compiles
    // once and is reused across rows -- a multi-step carve-out that recompiled
    // per row would still pass every single-step test. The real bound is
    // distinct-transforms * regex-steps-per-transform, flat in rows.
    const key = {
      name: "MULTI_STEP",
      elements: [
        {
          field: "ssn",
          transform: [
            { function: "filter_regex", params: { pattern: "\\d" } },
            { function: "extract_regex", params: { pattern: "(\\d{2})$" } },
          ],
        },
      ],
    };
    const rowCount = 50;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      SSN: `${100000000 + i}`,
    }));
    const dataset = new StandardizedDataset(
      [new StandardizedField("ssn", "SSN", [], rows)],
      [key],
    );

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    // Two regex steps in one transform array -> two compiles total (the array is
    // compiled once and reused), flat in the 50 rows. A per-row recompile of a
    // multi-step transform would be 2 * 50.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("regex factories fail closed (no fallback to new RegExp)", () => {
  // A pattern outside the linear-time dialect -- a backreference or lookaround,
  // which new RegExp would accept and run -- must throw, never silently fall back
  // to the backtracking engine (which would reopen the ReDoS hole). This encodes
  // the no-fallback invariant as a check rather than relying on absent code. The
  // factory compiles eagerly, so runPipeline throws when it builds the step.
  test("an out-of-dialect pattern throws instead of running", () => {
    const cases: Array<{ function: string; params: Record<string, unknown> }> =
      [
        { function: "filter_regex", params: { pattern: "(a)\\1" } },
        { function: "replace_regex", params: { pattern: "a(?=b)" } },
        { function: "extract_regex", params: { pattern: "(?<=a)b" } },
        { function: "split_on", params: { delimiter: "(a)\\1" } },
      ];
    for (const step of cases) {
      expect(() => runPipeline("anything", [step])).toThrow();
    }
  });
});

// --- StandardizedField -------------------------------------------------------

describe("StandardizedField", () => {
  const rows = [
    { LAST_NAME: "smith", SSN: "123-45-6789" },
    { LAST_NAME: "jones", SSN: "987-65-4321" },
  ];

  test("applies steps and returns a value set", () => {
    const field = new StandardizedField(
      "last_name",
      "LAST_NAME",
      [{ function: "to_upper_case" }],
      rows,
    );
    expect(field.get(0)).toEqual(["SMITH"]);
    expect(field.get(1)).toEqual(["JONES"]);
  });

  test("returns empty array when pipeline produces null", () => {
    const field = new StandardizedField(
      "ssn",
      "SSN",
      [{ function: "null_if", params: { value: "000000000" } }],
      [{ SSN: "000000000" }],
    );
    expect(field.get(0)).toEqual([]);
  });

  test("returns multiple values from split_on fan-out", () => {
    const field = new StandardizedField(
      "last_name",
      "LAST_NAME",
      [{ function: "split_on", params: { delimiter: "-" } }],
      [{ LAST_NAME: "SMITH-JONES" }],
    );
    expect(field.get(0)).toEqual(["SMITH", "JONES"]);
  });

  test("caches result: returns the same array reference on repeated access", () => {
    const field = new StandardizedField(
      "last_name",
      "LAST_NAME",
      [{ function: "to_upper_case" }],
      rows,
    );
    expect(field.get(0)).toBe(field.get(0));
  });

  test("missing input column returns empty array (excluded from linkage)", () => {
    const field = new StandardizedField("last_name", "MISSING", [], [{}]);
    expect(field.get(0)).toEqual([]);
  });

  test("short row omitting a prototype-member input column is treated as absent, not the inherited function", () => {
    // The input column is named exactly an Object.prototype member and the row
    // omits it: a bare row[inputColumn] would read the INHERITED function off the
    // prototype chain, which then flows into the pipeline where a string is
    // expected. The own-property read excludes the record instead.
    for (const proto of [
      "toString",
      "valueOf",
      "constructor",
      "hasOwnProperty",
    ]) {
      const field = new StandardizedField(
        "last_name",
        proto,
        [],
        [{ other: "x" }],
      );
      expect(field.get(0)).toEqual([]);
    }
  });

  test("present prototype-member input column standardizes its real value", () => {
    // The shadowing guard must not swallow a real value: a row holding a
    // 'toString' column standardizes that value as any other column would.
    const field = new StandardizedField(
      "last_name",
      "toString",
      [{ function: "to_upper_case" }],
      [{ toString: "smith" }],
    );
    expect(field.get(0)).toEqual(["SMITH"]);
  });

  test("out-of-bounds index returns empty array (excluded from linkage)", () => {
    const field = new StandardizedField(
      "last_name",
      "LAST_NAME",
      [],
      [{ LAST_NAME: "SMITH" }],
    );
    expect(field.get(99)).toEqual([]);
  });
});

// --- StandardizedDataset / buildStandardizedDataset --------------------------

const minimalTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "LN+DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    },
  ],
};

describe("buildStandardizedDataset", () => {
  const rows = [{ LAST_NAME: "smith", DOB: "19900115" }];

  test("explicit standardization takes precedence over metadata", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LAST_NAME",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    const metadata: ColumnMetadata[] = [
      {
        name: "LAST_NAME",
        type: "last_name",
        role: "linkage",
        isPayload: false,
      },
    ];
    const dataset = buildStandardizedDataset(
      standardization,
      rows,
      metadata,
      minimalTerms,
    );
    expect(dataset.getField("last_name")?.get(0)).toEqual(["SMITH"]);
  });

  test("metadata fallback resolves uncovered linkage fields", () => {
    const metadata: ColumnMetadata[] = [
      { name: "LN", type: "last_name", role: "linkage", isPayload: false },
      { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
    ];
    const dataset = buildStandardizedDataset(
      undefined,
      [{ LN: "SMITH", DOB: "19900115" }],
      metadata,
      minimalTerms,
    );
    expect(dataset.getField("last_name")?.get(0)).toEqual(["SMITH"]);
    expect(dataset.getField("date_of_birth")?.get(0)).toEqual(["19900115"]);
  });

  // The fan-out declaration is scoped to the fields a linkage key READS: cleaning
  // that fans out a field no key reads widens no candidate set, so it declares
  // neither extra records (localFanOutFactor) nor extra width.
  describe("declaresFanOut", () => {
    const fanningRows = [{ LAST_NAME: "smith jones", DOB: "19900115" }];
    const metadata: ColumnMetadata[] = [
      {
        name: "LAST_NAME",
        type: "last_name",
        role: "linkage",
        isPayload: false,
      },
      { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
    ];
    const splitLastName = [
      {
        output: "last_name",
        input: "LAST_NAME",
        steps: [{ function: "split_on", params: { delimiter: " " } }],
      },
    ];

    test("a fan-out on a field a linkage key reads declares", () => {
      const dataset = buildStandardizedDataset(
        splitLastName,
        fanningRows,
        metadata,
        minimalTerms,
      );
      expect(dataset.declaresFanOut).toBe(true);
    });

    test("a fan-out on a field no linkage key reads declares nothing", () => {
      const dobKeyOnly: LinkageTerms = {
        ...minimalTerms,
        linkageKeys: [{ name: "DOB", elements: [{ field: "date_of_birth" }] }],
      };
      const dataset = buildStandardizedDataset(
        splitLastName,
        fanningRows,
        metadata,
        dobKeyOnly,
      );
      // Not vacuous: the field is in the dataset and its row really does realize
      // two values. No key reads it, so nothing it realizes reaches a round.
      expect(dataset.getField("last_name")?.get(0)).toEqual(["smith", "jones"]);
      expect(dataset.declaresFanOut).toBe(false);
    });

    test("terms whose keys read nothing declare nothing", () => {
      const dataset = buildStandardizedDataset(
        splitLastName,
        fanningRows,
        metadata,
        { ...minimalTerms, linkageKeys: [] },
      );
      expect(dataset.declaresFanOut).toBe(false);
    });
  });

  test("field absent from both standardization and metadata is not in dataset", () => {
    const dataset = buildStandardizedDataset(undefined, rows, [], minimalTerms);
    expect(dataset.getField("last_name")).toBeUndefined();
  });

  test("fieldNames lists all provided fields", () => {
    const standardization = [
      { output: "last_name", input: "LAST_NAME", steps: [] },
    ];
    const dataset = buildStandardizedDataset(
      standardization,
      rows,
      [],
      minimalTerms,
    );
    expect(dataset.fieldNames).toEqual(new Set(["last_name"]));
  });

  test("fields are lazily evaluated: accessing only one index does not compute others", () => {
    let callCount = 0;
    const trackingRows = new Proxy(
      [{ LAST_NAME: "SMITH" }, { LAST_NAME: "JONES" }],
      {
        get(target, prop) {
          if (typeof prop === "string" && !isNaN(Number(prop))) callCount++;
          return Reflect.get(target, prop);
        },
      },
    );
    const standardization = [
      { output: "last_name", input: "LAST_NAME", steps: [] },
    ];
    const dataset = buildStandardizedDataset(
      standardization,
      trackingRows,
      [],
      minimalTerms,
    );
    dataset.getField("last_name")?.get(0);
    expect(callCount).toBe(1);
  });
});

describe("StandardizedDataset", () => {
  test("fieldNames reflects all fields passed to constructor", () => {
    const rows = [{ A: "x", B: "y" }];
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("alpha", "A", [], rows),
        new StandardizedField("beta", "B", [], rows),
      ],
      [{ name: "A+B", elements: [{ field: "alpha" }, { field: "beta" }] }],
    );
    expect(dataset.fieldNames).toEqual(new Set(["alpha", "beta"]));
  });

  test("getField returns undefined for unknown field", () => {
    const dataset = new StandardizedDataset([], []);
    expect(dataset.getField("nonexistent")).toBeUndefined();
  });
});

// --- buildKeyStrings ---------------------------------------------------------

describe("buildKeyStrings", () => {
  // Build a dataset from a single synthetic row where each entry in `fields`
  // is either a plain string (identity) or a string already split on "|".
  function makeDataset(
    fields: Record<string, string | string[]>,
  ): StandardizedDataset {
    const standardizedFields = Object.entries(fields).map(([name, value]) => {
      if (Array.isArray(value)) {
        const raw = value.join("|");
        return new StandardizedField(
          name,
          name,
          [{ function: "split_on", params: { delimiter: "\\|" } }],
          [{ [name]: raw }],
        );
      }
      return new StandardizedField(name, name, [], [{ [name]: value }]);
    });
    const keyOverEveryField = {
      name: "every field",
      elements: Object.keys(fields).map((field) => ({ field })),
    };
    return new StandardizedDataset(standardizedFields, [keyOverEveryField]);
  }

  const key = {
    name: "LN+DOB",
    elements: [{ field: "last_name" }, { field: "date_of_birth" }],
  };

  const logger = getLogger("cleaning");

  afterEach(() => vi.restoreAllMocks());

  test("empty field value set (null) returns null", () => {
    const rows = [{ last_name: "SMITH", date_of_birth: "000" }];
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("last_name", "last_name", [], rows),
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

  test("missing field in dataset returns null", () => {
    const dataset = makeDataset({ last_name: "SMITH" });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
  });

  test("a field holding several candidates is crossed, one key string each", () => {
    // Every candidate the record realizes reaches the key's candidate set: one
    // fanning field yields one key string per candidate, and two multiply into
    // the cross-product (docs/spec/PROTOCOL.md, Fan-out matching).
    const oneFansOut = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(key, oneFansOut, 0)).toEqual(
      new Set(["SMITH19900115", "JONES19900115"]),
    );

    const bothFanOut = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: ["19900115", "19900116"],
    });
    expect(buildKeyStrings(key, bothFanOut, 0)).toEqual(
      new Set([
        "SMITH19900115",
        "SMITH19900116",
        "JONES19900115",
        "JONES19900116",
      ]),
    );
  });

  test("an element transform filtering a candidate narrows the candidate set", () => {
    // Steps after a fan-out apply element-wise, and a null-producing step drops
    // the individual candidate it filters rather than the record: the surviving
    // candidate builds its key.
    const dataset = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: "19750716",
    });
    const filteringKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "null_if", params: { value: "JONES" } }],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(filteringKey, dataset, 0)).toEqual(
      new Set(["SMITH19750716"]),
    );
  });

  test("every candidate of an element being filtered excludes the record", () => {
    // The null realization reached through a fan-out: each candidate is filtered
    // element-wise, leaving the element with nothing, which excludes the record
    // from this key round exactly as an absent value does.
    const dataset = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: "19750716",
    });
    const filteringKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [
            { function: "null_if", params: { values: ["SMITH", "JONES"] } },
          ],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(filteringKey, dataset, 0)).toBeNull();
  });

  test("candidates that standardize to the same string count once", () => {
    // A record contributes each DISTINCT candidate once: two candidates that
    // survive their element transform as the SAME string are one candidate value,
    // not two entries in the round.
    const dataset = makeDataset({
      last_name: ["Smith", "SMITH"],
      date_of_birth: "19750716",
    });
    const foldingKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "to_upper_case" }],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(foldingKey, dataset, 0)).toEqual(
      new Set(["SMITH19750716"]),
    );
  });

  test("a field whose fan-out step yields one candidate builds its key", () => {
    // The sibling of the refusal, and what keeps it from swallowing a legitimate
    // row: split_on emits a one-element set when its delimiter is absent, which is
    // one match candidate, so the same filtering transform runs and the key builds.
    const dataset = makeDataset({
      last_name: ["SMITH"],
      date_of_birth: "19750716",
    });
    const filteringKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "null_if", params: { value: "JONES" } }],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(filteringKey, dataset, 0)).toEqual(
      new Set(["SMITH19750716"]),
    );
  });

  test("element transform is applied before concatenation", () => {
    const keyWithTransform = {
      name: "LN4+DOB",
      elements: [
        {
          field: "last_name",
          transform: [
            { function: "substring", params: { start: 1, length: 4 } },
          ],
        },
        { field: "date_of_birth" },
      ],
    };
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(keyWithTransform, dataset, 0)).toEqual(
      new Set(["SMIT19900115"]),
    );
  });

  test("element transform returning null excludes the record", () => {
    const keyWithNullTransform = {
      name: "SSN+LN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: "null_if", params: { value: "000000000" } }],
        },
        { field: "last_name" },
      ],
    };
    const dataset = makeDataset({ ssn: "000000000", last_name: "SMITH" });
    expect(buildKeyStrings(keyWithNullTransform, dataset, 0)).toBeNull();
  });

  test("element transform coalesce with a non-string default does not crash the key build", () => {
    const keyWith = (params: Record<string, unknown> | undefined) => ({
      name: "SSN+LN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: "coalesce", ...(params ? { params } : {}) }],
        },
        { field: "last_name" },
      ],
    });
    const dataset = makeDataset({ ssn: "000000000", last_name: "SMITH" });
    const absent = buildKeyStrings(keyWith(undefined), dataset, 0);
    for (const badDefault of [null, 42, [], {}, true]) {
      const key = keyWith({ default: badDefault });
      expect(
        () => buildKeyStrings(key, dataset, 0),
        JSON.stringify(badDefault),
      ).not.toThrow();
      expect(
        buildKeyStrings(key, dataset, 0),
        JSON.stringify(badDefault),
      ).toEqual(absent);
      expect(
        buildKeyStrings(key, dataset, 0),
        JSON.stringify(badDefault),
      ).toEqual(new Set(["000000000SMITH"]));
    }
  });

  test("element transform null_if / replace_regex / pad_left with non-string params do not crash the key build", () => {
    const dataset = makeDataset({ ssn: "123456789", last_name: "SMITH" });
    const key = (
      transform: Array<{ function: string; params?: Record<string, unknown> }>,
    ) => ({
      name: "SSN+LN",
      elements: [{ field: "ssn", transform }, { field: "last_name" }],
    });
    const cases: Array<{
      function: string;
      params: Record<string, unknown>;
    }> = [
      { function: "null_if", params: { values: [null] } },
      { function: "null_if", params: { value: 42 } },
      { function: "null_if", params: { values: 42 } },
      {
        function: "replace_regex",
        params: { pattern: "\\d", replacement: 42 },
      },
      { function: "pad_left", params: { length: 9, char: 42 } },
    ];
    for (const step of cases) {
      const built = () => buildKeyStrings(key([step]), dataset, 0);
      expect(built, JSON.stringify(step)).not.toThrow();
      expect(built(), JSON.stringify(step)).not.toBeNull();
    }
    // null_if with non-string entries excludes nothing: the SSN survives.
    expect(
      buildKeyStrings(
        key([{ function: "null_if", params: { values: [null] } }]),
        dataset,
        0,
      ),
    ).toEqual(new Set(["123456789SMITH"]));
    // replace_regex non-string replacement falls back to empty: digits stripped.
    expect(
      buildKeyStrings(
        key([
          {
            function: "replace_regex",
            params: { pattern: "\\d", replacement: 42 },
          },
        ]),
        dataset,
        0,
      ),
    ).toEqual(new Set(["SMITH"]));
    // pad_left non-string char falls back to "0": already 9 long, unchanged.
    expect(
      buildKeyStrings(
        key([{ function: "pad_left", params: { length: 9, char: 42 } }]),
        dataset,
        0,
      ),
    ).toEqual(new Set(["123456789SMITH"]));
  });

  test("swap is applied when isReceiver is true", () => {
    const swapKey = {
      name: "FN+LN swapped",
      elements: [{ field: "first_name" }, { field: "last_name" }],
      swap: ["first_name", "last_name"] as [string, string],
    };
    const dataset = makeDataset({ first_name: "JANE", last_name: "SMITH" });
    expect(buildKeyStrings(swapKey, dataset, 0, false)).toEqual(
      new Set(["JANESMITH"]),
    );
    expect(buildKeyStrings(swapKey, dataset, 0, true)).toEqual(
      new Set(["SMITHJANE"]),
    );
  });

  test("an empty transform is the identity, the same as declaring none", () => {
    // What lets the terms schema read an omitted `transform` and an empty one as
    // one pipeline when it holds a swap pair to a single transform.
    const dataset = makeDataset({ first_name: "JANE", last_name: "SMITH" });
    const withKey = (transform?: LinkageKeyElement["transform"]) => ({
      name: "FN+LN",
      elements: [{ field: "first_name", transform }, { field: "last_name" }],
    });
    expect(buildKeyStrings(withKey([]), dataset, 0)).toEqual(
      buildKeyStrings(withKey(), dataset, 0),
    );
    expect(buildKeyStrings(withKey([]), dataset, 0)).toEqual(
      new Set(["JANESMITH"]),
    );
  });

  test("a swap pair the terms admit matches the same whichever party receives", () => {
    // Only the receiver swaps, so a pair's two transforms have to agree for the
    // swapped round to compare like with like: the terms schema binds them, and
    // this is the property that binding buys. Role resolution is re-derived per
    // run from the parties' record counts rather than held by the terms, so a
    // pair without it would move the match set between runs of one agreed
    // document.
    const swapKey = {
      name: "swap(FN, LN)",
      elements: [
        { field: "first_name", transform: [{ function: "to_upper_case" }] },
        { field: "last_name", transform: [{ function: "to_upper_case" }] },
      ],
      swap: ["first_name", "last_name"] as [string, string],
    };
    // The reversed-entry record the swap exists to catch, the two parties also
    // disagreeing on case -- which is what the transform is there to decide.
    const partyA = makeDataset({ first_name: "John", last_name: "smith" });
    const partyB = makeDataset({ first_name: "smith", last_name: "john" });
    // The two roles concatenate the pair in opposite orders, so the key STRING a
    // match lands on differs between them; what must not differ is whether the
    // record pair matches at all.
    const matches = (
      key: LinkageKey,
      sender: StandardizedDataset,
      receiver: StandardizedDataset,
    ): boolean => {
      const sent = buildKeyStrings(key, sender, 0, false) ?? new Set();
      const received = buildKeyStrings(key, receiver, 0, true) ?? new Set();
      return [...received].some((candidate) => sent.has(candidate));
    };
    expect(matches(swapKey, partyA, partyB)).toBe(
      matches(swapKey, partyB, partyA),
    );
    // And the two agree on a MATCH, not on a shared miss.
    expect(matches(swapKey, partyA, partyB)).toBe(true);

    // The same pair with its transforms differing is what role resolution would
    // otherwise decide -- the given-name comparison runs under the transform of
    // whichever position the receiver's swap feeds it.
    const differing = {
      ...swapKey,
      elements: [swapKey.elements[0], { field: "last_name" }],
    };
    expect(matches(differing, partyA, partyB)).not.toBe(
      matches(differing, partyB, partyA),
    );
    // It does not reach this layer: the terms refuse it.
    const refused = safeParseLinkageTerms({
      version: "2.1.0",
      date: "2025-06-01",
      algorithm: "psi",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields: [
        { name: "first_name", type: "first_name" },
        { name: "last_name", type: "last_name" },
      ],
      linkageKeys: [differing],
    });
    expect(refused.success).toBe(false);
    if (refused.success) return;
    // Refused by THIS rule, not by some other gap in the document above.
    expect(refused.error.issues.map((issue) => issue.message)).toContainEqual(
      expect.stringMatching(/same transform/),
    );
  });

  test("an element transform that fans out contributes each part, not a join", () => {
    // The element-transform authoring surface fans out exactly as the field path
    // does -- one semantics and one width bound across both. Joining the parts
    // into one string instead would match on a value neither party's data holds,
    // which is not the several-independent-candidates behavior the terms declare.
    const dataset = makeDataset({
      last_name: "SMITH-JONES",
      date_of_birth: "19900115",
    });
    const fanningKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "split_on", params: { delimiter: "-" } }],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(fanningKey, dataset, 0)).toEqual(
      new Set(["SMITH19900115", "JONES19900115"]),
    );
  });

  test("a step after an element-transform fan-out runs on every part", () => {
    // Later steps apply element-wise across the parts, the same execution the
    // field-level pipeline uses, so an element transform's fan-out is not a
    // pipeline terminator.
    const dataset = makeDataset({
      last_name: "Smith-Jones",
      date_of_birth: "19900115",
    });
    const fanningKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [
            { function: "split_on", params: { delimiter: "-" } },
            { function: "to_upper_case" },
          ],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(fanningKey, dataset, 0)).toEqual(
      new Set(["SMITH19900115", "JONES19900115"]),
    );
  });

  test("an element transform whose fan-out step does not split yields its value", () => {
    // split_on emits a one-element set when its delimiter is absent: that is one
    // match candidate, not several, so the element yields the unsplit value and
    // the key builds -- the same size test StandardizedKeyIterable.valueAt
    // applies to the row it assembles.
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    const nonSplittingKey = {
      name: "LN+DOB",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "split_on", params: { delimiter: "-" } }],
        },
        { field: "date_of_birth" },
      ],
    };
    expect(buildKeyStrings(nonSplittingKey, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
  });

  test("uses the provided row index to look up field values", () => {
    const rows = [
      { last_name: "SMITH", date_of_birth: "19900115" },
      { last_name: "JONES", date_of_birth: "19850701" },
    ];
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("last_name", "last_name", [], rows),
        new StandardizedField("date_of_birth", "date_of_birth", [], rows),
      ],
      [key],
    );
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
    expect(buildKeyStrings(key, dataset, 1)).toEqual(
      new Set(["JONES19850701"]),
    );
  });

  test("a row at the width bound keeps every candidate", () => {
    // The bound's lower side: a record realizing exactly
    // FAN_OUT_CANDIDATES_PER_ELEMENT candidate values contributes all of them and is
    // not warned about.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: Array.from(
        { length: FAN_OUT_CANDIDATES_PER_ELEMENT },
        (_unused, i) => `NAME${i}`,
      ),
      date_of_birth: "19750716",
    });
    const built = buildKeyStrings(key, dataset, 0);
    expect(built?.size).toBe(FAN_OUT_CANDIDATES_PER_ELEMENT);
    expect(built?.has("NAME019750716")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a row one candidate over the width bound sits the key round out", () => {
    // The bound's upper side: the record contributes NOTHING to this key rather
    // than a truncated candidate set, exactly as an absent value does, and the
    // drop is warned. By design, it is not a run refusal -- a partner-authored
    // delimiter that shatters one local value must not end the exchange
    // (docs/spec/PROTOCOL.md, The width bound).
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: Array.from(
        { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
        (_unused, i) => `NAME${i}`,
      ),
      date_of_birth: "19750716",
    });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/realizes 21 candidate values/);
  });

  test("the width bound counts the assembled set, not the raw candidates", () => {
    // The count that decides the drop is the record's DISTINCT assembled values:
    // a cross-product of 5 x 5 whose combinations collapse to 9 distinct strings
    // is under the bound and contributes them all, where counting the raw
    // per-element candidates (25) would have dropped the record.
    const parts = ["a", "aa", "aaa", "aaaa", "aaaaa"];
    const dataset = makeDataset({ last_name: parts, date_of_birth: parts });
    const built = buildKeyStrings(key, dataset, 0);
    expect(built?.size).toBe(9);
  });

  test("a fan-out too wide to assemble drops the row instead of refusing", () => {
    // MAX_KEY_STRINGS_PER_ROW is a resource refusal on the cross-product, and it
    // stays unreachable through fan-out: a fanning row above it is dropped and
    // warned like any other over-width row, so a partner cannot end the exchange
    // by authoring a delimiter that shatters one local value.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const wide = Array.from({ length: 33 }, (_unused, i) => `V${i}`);
    const dataset = makeDataset({ last_name: wide, date_of_birth: wide });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /expands into 1089 key-string combinations/,
    );
  });

  test("no key this build admits reaches the width bound without a fan-out", () => {
    // Fuzzy expansion, the other candidate producer, does not expand while
    // APPLIED_SETTINGS.fuzzyComparisons is false, so the width bound and
    // assembly cap bind fan-out alone in this build and a fan-out-free row
    // contributes exactly one key string however many fuzzy elements its key
    // declares. Three edit-distance elements over eight-character values would
    // assemble 729 key strings once that gate opens, over the bound.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: "ABCDEFGH",
      first_name: "JKLMNOPQ",
      street_address: "RSTUVWXY",
    });
    const fuzzyKey = {
      name: "LN+FN+ADDR",
      elements: ["last_name", "first_name", "street_address"].map((field) => ({
        field,
        generateFuzzyComparisons: "edit_distances" as const,
      })),
    };
    expect(buildKeyStrings(fuzzyKey, dataset, 0)?.size).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  // --- multiplicity no declared producer accounts for ------------------------
  // The drop is normative for the listed producers alone, so a Set-producing
  // function that never made it into FAN_OUT_FUNCTION_NAMES must not inherit it:
  // dropping such a row would run the exchange to completion matching fewer
  // records than the terms describe, where passing the candidate set through
  // reaches the strategy refusal that covers exactly this omission
  // (fanOutReachedMatchingRefusal, pinned at the strategies in psiLink.test.ts).

  test("an unlisted producer over the width bound is kept, not dropped", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const built = withUnlistedFanOutFunctions(() => {
      const dataset = makeDataset({
        last_name: Array.from(
          { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
          (_unused, i) => `NAME${i}`,
        ),
        date_of_birth: "19750716",
      });
      return buildKeyStrings(key, dataset, 0);
    });
    expect(built?.size).toBe(FAN_OUT_CANDIDATES_PER_ELEMENT + 1);
    expect(built?.has("NAME2019750716")).toBe(true);
    expect(warn.mock.calls[0][0]).toMatch(
      /cross-product produced 21 key strings/,
    );
  });

  test("two candidates on a width-1 key raise no advisory", () => {
    // The advisory's threshold is the fan-out cap, not the key's declared width.
    // A row a producer outside the listed set widened to two candidates is over
    // the width this key declares, so it is passed to the strategy that refuses
    // it -- but two candidates is not the wide expansion the advisory speaks
    // about, and warning per row here would put one privacy line in front of the
    // operator for every row of the file.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const built = withUnlistedFanOutFunctions(() => {
      const dataset = makeDataset({
        last_name: ["SMITH", "JONES"],
        date_of_birth: "19750716",
      });
      return buildKeyStrings(key, dataset, 0);
    });
    expect(built?.size).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unlisted producer in an element transform is kept too", () => {
    // The second authoring surface: an element transform's candidates reach the
    // same two bounds, so the producer travels with them from there as well.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const built = withUnlistedFanOutFunctions(() => {
      const dataset = makeDataset({
        last_name: Array.from(
          { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
          (_unused, i) => `NAME${i}`,
        ).join("-"),
        date_of_birth: "19750716",
      });
      const splittingKey = {
        name: "LN+DOB",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: "-" } }],
          },
          { field: "date_of_birth" },
        ],
      };
      return buildKeyStrings(splittingKey, dataset, 0);
    });
    expect(built?.size).toBe(FAN_OUT_CANDIDATES_PER_ELEMENT + 1);
    expect(warn.mock.calls[0][0]).toMatch(
      /cross-product produced 21 key strings/,
    );
  });

  test("an unlisted producer too wide to assemble refuses the run", () => {
    // The row cannot reach a strategy at all -- assembling its cross-product is
    // what the cap exists to prevent -- so the fail-closed answer here is the
    // refusal the cap already raises, never the drop.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(() =>
      withUnlistedFanOutFunctions(() => {
        const wide = Array.from({ length: 33 }, (_unused, i) => `V${i}`);
        const dataset = makeDataset({ last_name: wide, date_of_birth: wide });
        return buildKeyStrings(key, dataset, 0);
      }),
    ).toThrow(UsageError);
    expect(warn).not.toHaveBeenCalled();
  });

  test("the unlisted-producer stand-in is restored by a throwing body", () => {
    // The stand-in moves the compile-time capture, and the refusal above leaves
    // it through a throw, so a step compiled afterwards must still see the
    // declared producer -- otherwise every later drop silently becomes a refusal.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(() =>
      withUnlistedFanOutFunctions(() => {
        throw new UsageError("refused inside the stand-in");
      }),
    ).toThrow(UsageError);
    const wide = Array.from({ length: 33 }, (_unused, i) => `V${i}`);
    const dataset = makeDataset({ last_name: wide, date_of_birth: wide });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a nested call restores its caller's override, not the full list", () => {
    withNoListedFanOutFunctions(() => {
      expect(isListedFanOutFunction("split_on")).toBe(false);
      withNoListedFanOutFunctions(() => {});
      expect(isListedFanOutFunction("split_on")).toBe(false);
    });
    expect(isListedFanOutFunction("split_on")).toBe(true);
  });

  test("an async body is refused and the listing restored", () => {
    expect(() => withNoListedFanOutFunctions(() => Promise.resolve())).toThrow(
      /synchronous bodies only/,
    );
    expect(isListedFanOutFunction("split_on")).toBe(true);
  });

  test("the cap refusal names the producer this row expanded through", () => {
    // The refusal covers fuzzy expansion and an unlisted producer alike, and the
    // count distinguishes them for nobody, so a message naming fuzzy comparisons
    // as the cause would send an operator to a term this key does not declare.
    expect(() =>
      withUnlistedFanOutFunctions(() => {
        const wide = Array.from({ length: 33 }, (_unused, i) => `V${i}`);
        const dataset = makeDataset({ last_name: wide, date_of_birth: wide });
        return buildKeyStrings(key, dataset, 0);
      }),
    ).toThrow(/turns one value into several candidates/);
  });

  test("a cell above the engine's argument limit refuses on the value ceiling", () => {
    // A cell this wide never reaches the element's candidate assembly at all:
    // the magnitude ceiling refuses the value the element reads, which is what
    // holds a single cell's realization below the count at which a spread of the
    // candidates would fail (between 125,000 and 150,000 arguments on this
    // build's Node, lower wherever the stack is smaller) and raise a RangeError
    // reporting a fault the row does not have.
    const wideCell = Array.from(
      { length: 150_000 },
      (_unused, i) => `V${i}`,
    ).join("-");
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() => {
        const dataset = makeDataset({
          last_name: wideCell,
          date_of_birth: "19750716",
        });
        const splittingKey = {
          name: "LN+DOB",
          elements: [
            {
              field: "last_name",
              transform: [{ function: "split_on", params: { delimiter: "-" } }],
            },
            { field: "date_of_birth" },
          ],
        };
        return buildKeyStrings(splittingKey, dataset, 0);
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /reads a 1088889-character value from row 0/,
    );
  });

  test("a row realizing more candidates than a spread accepts refuses on the cap", () => {
    // The other route to that width, which the value ceiling does not bound: the
    // candidates come from the FIELD's own realization, one short value each, so
    // the element reads 150,000 in-ceiling values rather than one wide cell.
    // Appending them one at a time is what keeps the cap the thing that refuses.
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() => {
        const dataset = makeDataset({
          last_name: Array.from({ length: 150_000 }, (_unused, i) => `V${i}`),
          date_of_birth: "19750716",
        });
        return buildKeyStrings(key, dataset, 0);
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /expands one row into 150000 key strings/,
    );
  });

  test("the same row's fan-out cap refusal locates the offending key", () => {
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() => {
        const dataset = makeDataset({
          last_name: Array.from({ length: 150_000 }, (_unused, i) => `V${i}`),
          date_of_birth: "19750716",
        });
        return buildKeyStrings(key, dataset, 0, false, 1);
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /linkageKeys\[1\] expands one row into 150000 key strings/,
    );
  });

  // --- the transformed-value ceiling -----------------------------------------
  // One magnitude invariant on the partner-authored path, checked on what an
  // element READS and on what each of its steps PRODUCES. The three
  // amplification shapes measured in docs/spec/CHANNEL_SECURITY.md (Unbounded
  // transform-parameter rejection) are pinned here as BOUNDED: the schema's
  // param bound accepts each of these replacements, and none of them assembles.

  const amplifyingKey = (steps: LinkageKeyElement["transform"]) => ({
    name: "LN+DOB",
    elements: [
      { field: "last_name", transform: steps },
      { field: "date_of_birth" },
    ],
  });

  const substitutingReplacement = "$'".repeat(MAX_TRANSFORM_PARAM_LENGTH / 2);

  test("the trailing-context substitution is refused, not assembled", () => {
    // Quadratic in this party's own cell: `$'` re-inserts the match's trailing
    // context and `a*` matches between every character. The refusal lands on the
    // step's output, before anything downstream propagates it.
    const dataset = makeDataset({
      last_name: "1".repeat(200),
      date_of_birth: "19750716",
    });
    expect(() =>
      buildKeyStrings(
        amplifyingKey([
          {
            function: "replace_regex",
            params: { pattern: "a*", replacement: substitutingReplacement },
          },
        ]),
        dataset,
        0,
      ),
    ).toThrow(/transform step produced a \d+-character value/);
  });

  test("a composed pipeline is refused at the step that crosses the ceiling", () => {
    // Each step is fed the previous step's output, so checking every step's
    // output is what keeps every step's INPUT bounded: the first step's 2,210
    // characters are inside the ceiling and run, and the second crosses it.
    const dataset = makeDataset({
      last_name: "1234567890",
      date_of_birth: "19750716",
    });
    const step = {
      function: "replace_regex",
      params: { pattern: "a*", replacement: "x".repeat(200) },
    };
    expect(() =>
      buildKeyStrings(amplifyingKey([step, step]), dataset, 0, false, 2),
    ).toThrow(/linkageKeys\[2\]\.elements\[0\]\.transform\[1\]/);
  });

  test("an NFC-lengthening replacement is refused", () => {
    // The shape with no substitution sequence at all: replaceRegexFactory
    // NFC-normalizes the replacement before substituting it, and U+0344
    // normalizes to two code units, so a 1000-character param substitutes 2000.
    const combining = String.fromCodePoint(0x0344).repeat(
      MAX_TRANSFORM_PARAM_LENGTH,
    );
    const dataset = makeDataset({
      last_name: "1234567890",
      date_of_birth: "19750716",
    });
    expect(() =>
      buildKeyStrings(
        amplifyingKey([
          {
            function: "replace_regex",
            params: { pattern: "a*", replacement: combining },
          },
        ]),
        dataset,
        0,
      ),
    ).toThrow(/transform step produced a 22010-character value/);
  });

  test("a value at the ceiling builds; one character over is refused", () => {
    // The base case, checked before the no-steps early return: an element that
    // declares no transform at all passes its whole value into the key string,
    // so the ceiling binds what it reads as well as what a step produces.
    const atCeiling = "A".repeat(4096);
    expect(
      buildKeyStrings(
        key,
        makeDataset({ last_name: atCeiling, date_of_birth: "19750716" }),
        0,
      ),
    ).toEqual(new Set([`${atCeiling}19750716`]));
    expect(() =>
      buildKeyStrings(
        key,
        makeDataset({ last_name: "A".repeat(4097), date_of_birth: "19750716" }),
        0,
      ),
    ).toThrow(/reads a 4097-character value from row 0/);
  });

  test("the refusal locates element and step by issue path, echoing no value", () => {
    // The value is this party's own PII and the key's name is partner-authored
    // free text, so the message holds neither: the issue path locates the
    // offender, the row index locates the record, and the step's function name
    // is narrowed to a literal this build recognizes.
    const cell = `${"S3CRET".repeat(700)}`;
    const dataset = makeDataset({
      last_name: cell,
      date_of_birth: "19750716",
    });
    const raise = (transform: LinkageKeyElement["transform"]) => {
      try {
        buildKeyStrings(
          transform === undefined ? key : amplifyingKey(transform),
          dataset,
          0,
          false,
          2,
        );
      } catch (err) {
        return err as UsageError;
      }
      return undefined;
    };

    const onRead = raise(undefined);
    expect(onRead).toBeInstanceOf(UsageError);
    expect(onRead?.message).toContain("linkageKeys[2].elements[0]");
    expect(onRead?.message).toContain("row 0");
    expect(onRead?.message).not.toContain("S3CRET");

    const shortDataset = makeDataset({
      last_name: "S3CRET",
      date_of_birth: "19750716",
    });
    let onStep: UsageError | undefined;
    try {
      buildKeyStrings(
        amplifyingKey([
          {
            function: "replace_regex",
            params: { pattern: "a*", replacement: substitutingReplacement },
          },
        ]),
        shortDataset,
        0,
        false,
        2,
      );
    } catch (err) {
      onStep = err as UsageError;
    }
    expect(onStep?.message).toContain(
      'linkageKeys[2].elements[0].transform[0], "replace_regex"',
    );
    expect(onStep?.message).not.toContain("S3CRET");
  });

  // --- the row's assembled key-string bytes ----------------------------------
  // The count cap bounds how MANY key strings a row assembles; this limb bounds
  // what they hold, because every combination replicates each element's whole
  // value. Both are measured on the projection, before the cross-product is
  // materialized, and a row takes the same fate from either.

  // Candidates at the per-value ceiling, and one fewer of them than the count
  // cap allows: the row RETAINS 4,190,216 characters, inside the per-row total
  // the accumulation bound holds, and it is the date replicated across all 1023
  // combinations that takes the ASSEMBLED total past the cap. Which is what puts
  // this row in the assembled limbs' hands rather than the accumulation bound's.
  const wideAndLong = () =>
    Array.from(
      { length: 1023 },
      (_unused, i) => `${"A".repeat(4090)}${String(i).padStart(6, "0")}`,
    );

  test("a row whose key strings would hold too many bytes is dropped for a declared fan-out", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: wideAndLong(),
      date_of_birth: "19750716",
    });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /assembles 4198392 characters of key strings/,
    );
  });

  test("the same row refuses the run when no declared producer expanded it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() => {
        const dataset = makeDataset({
          last_name: wideAndLong(),
          date_of_birth: "19750716",
        });
        return buildKeyStrings(key, dataset, 0, false, 1);
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /linkageKeys\[1\] assembles 4198392 characters of key strings/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  // 1024 distinct candidates whose lengths, replicated across the row's key
  // strings beside the 8-character date, assemble to exactly the byte cap.
  // `extra` pushes one candidate -- and so the row -- one code unit past it.
  const atByteCap = (extra = 0) =>
    Array.from(
      { length: 1024 },
      (_unused, i) =>
        `${"A".repeat(4082 + (i === 0 ? extra : 0))}${String(i).padStart(6, "0")}`,
    );

  test("a row assembling exactly the byte cap builds", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const built = withUnlistedFanOutFunctions(() =>
      buildKeyStrings(
        key,
        makeDataset({
          last_name: atByteCap(),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    );
    expect(built?.size).toBe(1024);
    // The only warning is the candidate cap's advisory, which is not a fate: the
    // row assembled every one of its key strings.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /cross-product produced 1024 key strings/,
    );
  });

  test("one code unit past the byte cap refuses, and drops for a declared fan-out", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(
          key,
          makeDataset({ last_name: atByteCap(1), date_of_birth: "19750716" }),
          0,
          false,
          1,
        ),
      );
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /linkageKeys\[1\] assembles 4194305 characters of key strings/,
    );

    warn.mockClear();
    const dataset = makeDataset({
      last_name: atByteCap(1),
      date_of_birth: "19750716",
    });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(
      /assembles 4194305 characters of key strings/,
    );
  });

  test("a row crossing both limbs takes the count limb's fate", () => {
    // The limbs are checked in order and a row over both is reported by the
    // count, so an operator reading the refusal is not sent to shorten values on
    // a row whose combinations are what it has too many of.
    const wideAndHeavy = () => ({
      last_name: Array.from({ length: 2000 }, (_unused, i) =>
        String(i).padStart(4, "0"),
      ),
      date_of_birth: "9".repeat(4096),
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(buildKeyStrings(key, makeDataset(wideAndHeavy()), 0)).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(
      /expands into 2000 key-string combinations/,
    );

    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(key, makeDataset(wideAndHeavy()), 0, false, 1),
      );
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /linkageKeys\[1\] expands one row into 2000 key strings/,
    );
  });

  // --- the candidates as they accumulate -------------------------------------
  // The same magnitude invariant the limbs above measure on the projection,
  // enforced where the candidates are actually allocated. A projection is only
  // reachable once every candidate exists, so on its own it bounds the assembled
  // key strings and not the set they are assembled from. The total is the ROW's
  // and counts what each element RETAINS, so it measures what the row holds
  // live: what a duplicate collapses into is never included in a key string,
  // and what earlier elements retained is still held when a later one runs.

  test("an amplifying step over a split cell is decided as the candidates accumulate", () => {
    // A cell of 1000 comma-separated tokens, split and then amplified twice: no
    // single candidate from the first amplification crosses the per-value
    // ceiling, so nothing fires until the second amplification's outputs
    // accumulate into one set the ceiling reads only once the last exists. A
    // declared producer expanded the values the amplifier runs over, so the
    // row drops for this key even though the amplifier crosses the ceiling.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const cell = Array.from({ length: 1000 }, (_unused, i) =>
      String(i).padStart(3, "0"),
    ).join(",");
    const amplify = {
      function: "replace_regex",
      params: {
        pattern: "a*",
        replacement: "x".repeat(MAX_TRANSFORM_PARAM_LENGTH),
      },
    };
    expect(
      buildKeyStrings(
        amplifyingKey([
          { function: "split_on", params: { delimiter: "," } },
          amplify,
          amplify,
        ]),
        makeDataset({ last_name: cell, date_of_birth: "19750716" }),
        0,
        false,
        1,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /row 0, key "LN\+DOB": accumulates \d+ characters of candidate values as a step runs over the values this key's declared fan-out expands/,
    );
  });

  test("an element transform amplifying each of a field's values is decided as they accumulate", () => {
    // The element's own accumulation, which no step's candidate set sees: the
    // transform runs once per realized field value, so a step amplifying a short
    // value produces one in-ceiling candidate per call and expands none of them.
    // The multiplicity it is amplifying is the FIELD's declared `split_on`, so
    // the row takes that producer's drop here exactly as it would at the
    // assembled limbs.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const amplify = {
      function: "replace_regex",
      params: { pattern: "a*", replacement: "x".repeat(800) },
    };
    expect(
      buildKeyStrings(
        amplifyingKey([amplify]),
        makeDataset({
          last_name: Array.from({ length: 2000 }, (_unused, i) =>
            String(i).padStart(4, "0"),
          ),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /accumulates \d+ characters of candidate values across the key's elements/,
    );
  });

  test("the accumulation outcome echoes no value and leaves the local pipeline alone", () => {
    const secretCell = "S3CRET0,S3CRET1,S3CRET2";
    // Built fresh per call: the compiled steps capture their fan-out membership,
    // so a shared array would leak one compilation into the other listing.
    const amplifyingSteps = () => [
      { function: "split_on", params: { delimiter: "," } },
      {
        function: "replace_regex",
        params: { pattern: "a*", replacement: "x".repeat(500) },
      },
      {
        function: "replace_regex",
        params: { pattern: "a*", replacement: "x".repeat(500) },
      },
    ];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      buildKeyStrings(
        amplifyingKey(amplifyingSteps()),
        makeDataset({ last_name: secretCell, date_of_birth: "19750716" }),
        0,
      ),
    ).toBeNull();
    expect(warn.mock.calls[0][0]).toContain("characters of candidate values");
    expect(warn.mock.calls[0][0]).toContain("row 0");
    expect(warn.mock.calls[0][0]).not.toContain("S3CRET");

    // The same shape refused, which is the other fate this boundary takes: the
    // producer expanding the cell is unlisted, so the crossing ends the
    // exchange. That message names no value of the row either.
    let raised: UsageError | undefined;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(
          amplifyingKey(amplifyingSteps()),
          makeDataset({ last_name: secretCell, date_of_birth: "19750716" }),
          0,
        ),
      );
    } catch (err) {
      raised = err as UsageError;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect(raised?.message).toContain("characters of candidate values");
    expect(raised?.message).toContain("row 0");
    expect(raised?.message).not.toContain("S3CRET");

    // The bound is the partner-authored path's. The operator's own
    // standardization runs the identical steps over the identical cell without
    // it, past the same total (docs/notes/bound-transformed-value.md).
    const local = runPipeline(secretCell, amplifyingSteps());
    expect(local).toBeInstanceOf(Set);
    expect(
      [...(local as Set<string>)].reduce((sum, v) => sum + v.length, 0),
    ).toBeGreaterThan(4_194_304);
  });

  test("a transform collapsing a multi-value cell to one candidate builds", () => {
    // The row a per-candidate charge would refuse: a partner-authored transform
    // that maps every value of the operator's cell to the SAME string. The cell
    // realizes 2200 values and the element retains one 2000-character candidate,
    // so the key the row really assembles is a single 2008-character string --
    // charging each realized candidate would total 4,400,000 and refuse a row
    // whose live candidate set is one value.
    const collapsed = "x".repeat(MAX_TRANSFORM_PARAM_LENGTH);
    const built = buildKeyStrings(
      amplifyingKey([
        {
          function: "replace_regex",
          params: { pattern: ".*", replacement: collapsed },
        },
      ]),
      makeDataset({
        last_name: Array.from({ length: 2200 }, (_unused, i) =>
          String(i).padStart(4, "0"),
        ),
        date_of_birth: "19750716",
      }),
      0,
      false,
      1,
    );
    expect(built).toEqual(new Set([`${collapsed.repeat(2)}19750716`]));
  });

  test("a transform collapsing many long values to a few candidates builds", () => {
    // The same collapse from the other direction: 2200 DISTINCT in-ceiling
    // values, each contributing 2000 characters the row would have to hold if
    // they survived, mapped by a digit-stripping step onto four candidates. The
    // four are what the row assembles and what the total charges.
    const stem = (letter: string) => `${letter}${"A".repeat(2000)}`;
    const built = buildKeyStrings(
      amplifyingKey([
        {
          function: "replace_regex",
          params: { pattern: "\\d", replacement: "" },
        },
      ]),
      makeDataset({
        last_name: Array.from(
          { length: 2200 },
          (_unused, i) => `${stem("BCDE"[i % 4])}${String(i).padStart(4, "0")}`,
        ),
        date_of_birth: "19750716",
      }),
      0,
      false,
      1,
    );
    expect(built).toEqual(
      new Set([..."BCDE"].map((letter) => `${stem(letter)}19750716`)),
    );
  });

  // Eleven elements over the same 100-value cell: each retains 409,400
  // characters, an order of magnitude below the cap, so a total restarted per
  // element never fires however many elements the key declares (up to
  // MAX_KEY_ELEMENTS) -- and the row holds every one of them live at once. The
  // crossing lands on the eleventh, at a total no single element retains.
  const oneLargeFieldCell = () =>
    Array.from(
      { length: 100 },
      (_unused, i) => `${"Q".repeat(4084)}S3CRET${String(i).padStart(4, "0")}`,
    );

  const manyElements = {
    name: "LN x11",
    elements: Array.from({ length: 11 }, () => ({ field: "last_name" })),
  };

  test("elements binding one large field settle on the row's total, not each element's", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      buildKeyStrings(
        manyElements,
        makeDataset({ last_name: oneLargeFieldCell() }),
        0,
        false,
        1,
      ),
    ).toBeNull();
    const dropped = Number(
      /accumulates (\d+) characters/.exec(warn.mock.calls[0][0])?.[1],
    );
    expect(dropped).toBeGreaterThan(4_194_304);
    // Above what any one element retains, which is what makes the total the
    // row's rather than the offending element's.
    expect(dropped).toBeGreaterThan(10 * 409_400);
    expect(warn.mock.calls[0][0]).not.toContain("S3CRET");
  });

  test("the same row's refusal names the element it was accumulating at", () => {
    // The fate the row takes once an unlisted producer realized its
    // multiplicity, which is where the accumulation refusal's locator is
    // observable: the drop above logs the row and the key, never an issue path.
    let raised: UsageError | undefined;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(
          manyElements,
          makeDataset({ last_name: oneLargeFieldCell() }),
          0,
          false,
          1,
        ),
      );
    } catch (err) {
      raised = err as UsageError;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect(raised?.message).toMatch(/\(linkageKeys\[1\]\.elements\[10\]\)/);
    expect(raised?.message).not.toContain("S3CRET");
    const accumulated = Number(
      /accumulated (\d+) characters/.exec(raised?.message ?? "")?.[1],
    );
    expect(accumulated).toBeGreaterThan(4_194_304);
    expect(accumulated).toBeGreaterThan(10 * 409_400);
  });

  // --- the declared fan-out's fate at the accumulation boundary --------------
  // Dropping an over-bound row is normative for the DECLARED fan-out producers
  // (docs/spec/PROTOCOL.md, Fan-out matching), and the accumulating limb takes
  // that fate at both its charges for a key whose multiplicity only they can
  // realize. The fate is read from the key's compiled steps before any element
  // runs, so a crossing keeps the refusal where a producer OUTSIDE the list can
  // expand the key, and where none can expand it at all.

  // A cell of distinct single-character tokens, each amplified to 1,939
  // characters and split (with the original retained) on a separator the
  // amplifier itself wrote, so each candidate charges 2,908 characters plus
  // 968 more from the shared prefix/suffix landing once: at 1,442 tokens the
  // element accumulates exactly MAX_ASSEMBLED_KEY_LENGTH_PER_ROW, and each
  // further token is 2,908 past it.
  const tokenCell = (tokens: number) =>
    Array.from({ length: tokens }, (_unused, i) =>
      String.fromCodePoint(0x4e00 + i),
    ).join(",");

  const collapsedCandidate = "x".repeat(MAX_TRANSFORM_PARAM_LENGTH);

  // Built fresh per call: the compiled steps capture their fan-out membership,
  // so a shared array would leak one compilation into the other listing.
  const splitRetainingSteps = () => [
    { function: "split_on", params: { delimiter: "," } },
    {
      function: "replace_regex",
      params: {
        pattern: "a*",
        replacement: `${"y".repeat(484)}Q${"z".repeat(484)}`,
      },
    },
    { function: "split_on", params: { delimiter: "Q", includeOriginal: true } },
    {
      function: "replace_regex",
      params: { pattern: ".*", replacement: collapsedCandidate },
    },
  ];

  const dobKey = { name: "DOB", elements: [{ field: "date_of_birth" }] };

  test("a declared fan-out crossing as it expands drops the row for that key", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: tokenCell(1443),
      date_of_birth: "19750716",
    });
    expect(
      buildKeyStrings(
        amplifyingKey(splitRetainingSteps()),
        dataset,
        0,
        false,
        1,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /accumulates 4197212 characters of candidate values as a step runs over the values this key's declared fan-out expands/,
    );
    // Neither the row's own token nor the bytes the transform derived from it.
    expect(warn.mock.calls[0][0]).not.toContain(String.fromCodePoint(0x4e00));
    expect(warn.mock.calls[0][0]).not.toContain("y".repeat(10));
    // The row sits out this key's round alone.
    expect(buildKeyStrings(dobKey, dataset, 0, false, 2)).toEqual(
      new Set(["19750716"]),
    );
  });

  test("a declared fan-out expansion exactly at the cap builds", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      buildKeyStrings(
        amplifyingKey(splitRetainingSteps()),
        makeDataset({
          last_name: tokenCell(1442),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    ).toEqual(new Set([`${collapsedCandidate.repeat(2)}19750716`]));
    expect(warn).not.toHaveBeenCalled();
  });

  test("the same crossing from an unlisted producer refuses", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(
          amplifyingKey(splitRetainingSteps()),
          makeDataset({
            last_name: tokenCell(1443),
            date_of_birth: "19750716",
          }),
          0,
          false,
          1,
        ),
      );
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /accumulated 4197212 characters of candidate values from row 0 of this party's data \(linkageKeys\[1\]\.elements\[0\]\)/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("a listed producer's crossing refuses when an unlisted one expanded the row", () => {
    // The provenance the fate reads is the ROW's rather than the charging step's,
    // as it is at the assembled limbs. One steps array serves both calls, so the
    // element's compiled steps and their fan-out membership are identical and the
    // two fates differ on the row's own provenance alone -- here the field's
    // standardization, compiled with nothing listed, expanding the row before the
    // element's declared producers charge anything.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const steps = splitRetainingSteps();
    const unlistedField = withUnlistedFanOutFunctions(() =>
      makeDataset({
        last_name: [tokenCell(1443), "Z"],
        date_of_birth: "19750716",
      }),
    );
    let raised: unknown;
    try {
      buildKeyStrings(amplifyingKey(steps), unlistedField, 0, false, 1);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /accumulated 4197212 characters of candidate values from row 0/,
    );
    expect(warn).not.toHaveBeenCalled();

    expect(
      buildKeyStrings(
        amplifyingKey(steps),
        makeDataset({
          last_name: tokenCell(1443),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // The row's aggregate charge, which no one step is expanding: distinct
  // candidates at the per-value ceiling, 1024 of which are exactly
  // MAX_ASSEMBLED_KEY_LENGTH_PER_ROW, so the 1025th pushes the row 4,096
  // characters past it. Splitting those candidates between the key's two
  // elements or holding them all in the first is what moves the crossing
  // across the boundary the fate turns on.
  const ceilingCandidates = (count: number) =>
    Array.from(
      { length: count },
      (_unused, i) => `${"A".repeat(4090)}${String(i).padStart(6, "0")}`,
    );

  const secondElementPair = () => ["9".repeat(4096), "8".repeat(4096)];

  test("an aggregate crossing on a declared fan-out row drops it for that key", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: ceilingCandidates(1023),
      date_of_birth: secondElementPair(),
    });
    expect(buildKeyStrings(key, dataset, 0, false, 1)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /accumulates 4198400 characters of candidate values across the key's elements/,
    );
    // The row sits out this key's round alone.
    expect(buildKeyStrings(dobKey, dataset, 0, false, 2)).toEqual(
      new Set(secondElementPair()),
    );
  });

  test("the same aggregate crossing refuses when an unlisted producer expanded the row", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let raised: unknown;
    try {
      withUnlistedFanOutFunctions(() =>
        buildKeyStrings(
          key,
          makeDataset({
            last_name: ceilingCandidates(1023),
            date_of_birth: secondElementPair(),
          }),
          0,
          false,
          1,
        ),
      );
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as UsageError).message).toMatch(
      /accumulated 4198400 characters of candidate values from row 0 of this party's data \(linkageKeys\[1\]\.elements\[1\]\)/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("an aggregate crossing before any element fanned out still drops", () => {
    // The same total from the same producer, charged while the element realizing
    // the multiplicity is still being built. What binds the drop is the
    // producer the key DECLARES rather than one the row has been observed to
    // run, so a crossing this early takes the identical fate -- which is the
    // whole point of deciding it before the elements run.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = makeDataset({
      last_name: ceilingCandidates(1025),
      date_of_birth: "19750716",
    });
    expect(buildKeyStrings(key, dataset, 0, false, 1)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /accumulates 4198400 characters of candidate values across the key's elements/,
    );
    // The row sits out this key's round alone.
    expect(buildKeyStrings(dobKey, dataset, 0, false, 2)).toEqual(
      new Set(["19750716"]),
    );
  });

  // --- one fate per (row, key), wherever the crossing lands -------------------
  // The property the pre-run classification buys: for ONE row and ONE key the
  // fate at an accumulation crossing does not depend on which element the
  // crossing lands in, nor on the order the partner wrote the elements in.
  // Splitting the same candidates across the key's elements moves the crossing
  // from the first element to the last and across the boundary between the
  // two charges; none of that reaches the fate.

  const splitField = (name: string, values: string[]) =>
    new StandardizedField(
      name,
      name,
      [{ function: "split_on", params: { delimiter: "\\|" } }],
      [{ [name]: values.join("|") }],
    );

  const plainField = (name: string, value: string) =>
    new StandardizedField(name, name, [], [{ [name]: value }]);

  const orderedKey = (...fields: string[]) => ({
    name: "ordered",
    elements: fields.map((field) => ({ field })),
  });

  test("a declared fan-out row takes the drop wherever the crossing lands", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 1025 ceiling-sized candidates cross the cap; 513 of them do not, so a key
    // holding them in one element crosses while that element is still building
    // and a key splitting them across two crosses at the second.
    const dataset = new StandardizedDataset(
      [
        splitField("whole", ceilingCandidates(1025)),
        splitField("half_one", ceilingCandidates(513)),
        splitField("half_two", ceilingCandidates(513)),
        plainField("short_one", "19750716"),
        plainField("short_two", "19750717"),
      ],
      [orderedKey("whole", "half_one", "half_two", "short_one", "short_two")],
    );
    for (const fields of [
      ["whole", "short_one"],
      ["short_one", "whole"],
      ["short_one", "short_two", "whole"],
      ["half_one", "half_two"],
      ["half_two", "half_one"],
      ["half_one", "short_one", "half_two"],
    ]) {
      warn.mockClear();
      expect(
        buildKeyStrings(orderedKey(...fields), dataset, 0, false, 1),
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /accumulates \d+ characters of candidate values/,
      );
    }
  });

  test("an unlisted producer's row refuses wherever it sits in the key", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // The unlisted producer contributes four characters and expands nothing the
    // crossing is made of: it is the key DECLARING it that fixes the fate, so
    // the element it sits in -- including one the crossing never reaches --
    // makes no difference.
    const dataset = new StandardizedDataset(
      [
        splitField("half_one", ceilingCandidates(513)),
        splitField("half_two", ceilingCandidates(513)),
        withUnlistedFanOutFunctions(() => splitField("unlisted", ["Y", "Z"])),
      ],
      [orderedKey("half_one", "half_two", "unlisted")],
    );
    for (const fields of [
      ["half_one", "half_two", "unlisted"],
      ["unlisted", "half_one", "half_two"],
      ["half_one", "unlisted", "half_two"],
    ]) {
      warn.mockClear();
      let raised: unknown;
      try {
        buildKeyStrings(orderedKey(...fields), dataset, 0, false, 1);
      } catch (err) {
        raised = err;
      }
      expect(raised).toBeInstanceOf(UsageError);
      expect((raised as UsageError).message).toMatch(
        /accumulated \d+ characters of candidate values from row 0/,
      );
      expect(warn).not.toHaveBeenCalled();
    }
  });

  // The same property with the crossing at the OTHER charge. The cases above
  // build their multiplicity on the fields, so every crossing lands on the row's
  // aggregate in buildKeyStrings; an element holding the expansion in its own
  // transform crosses inside applyStep instead, while the row's aggregate stays
  // far below the cap.
  const inStepElement = (): LinkageKeyElement => ({
    field: "tokens",
    transform: splitRetainingSteps(),
  });

  const permutedKeys = (): LinkageKey[] =>
    [
      [inStepElement(), { field: "short_one" }],
      [{ field: "short_one" }, inStepElement()],
      [{ field: "short_one" }, inStepElement(), { field: "short_two" }],
    ].map((elements) => ({ name: "ordered", elements }));

  const inStepDataset = () =>
    new StandardizedDataset(
      [
        plainField("tokens", tokenCell(1443)),
        plainField("short_one", "19750716"),
        plainField("short_two", "19750717"),
      ],
      permutedKeys(),
    );

  test("a declared fan-out row drops wherever the expanding element sits", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dataset = inStepDataset();
    for (const key of permutedKeys()) {
      warn.mockClear();
      expect(buildKeyStrings(key, dataset, 0, false, 1)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /accumulates 4197212 characters of candidate values as a step runs over the values this key's declared fan-out expands/,
      );
    }
  });

  test("an unlisted producer's in-step crossing refuses wherever it sits", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    for (const key of permutedKeys()) {
      warn.mockClear();
      let raised: unknown;
      try {
        // The element's steps compile on their first use, so the listing the
        // lever moves is the one this key's producer is read against.
        withUnlistedFanOutFunctions(() =>
          buildKeyStrings(key, inStepDataset(), 0, false, 1),
        );
      } catch (err) {
        raised = err;
      }
      expect(raised).toBeInstanceOf(UsageError);
      expect((raised as UsageError).message).toMatch(
        /accumulated 4197212 characters of candidate values from row 0/,
      );
      expect(warn).not.toHaveBeenCalled();
    }
  });

  test("multiplicity no classified producer accounts for refuses", () => {
    // The fail-closed safety check under the classification. A step that
    // expands a value while unlisted cannot reach a key classified for the drop
    // -- the classification would have refused for it -- so this pairing is
    // what a Set-returning function left out of the multi-value classification
    // would produce, and it decides on the refusal rather than dropping a row
    // whose fan-out nothing declared.
    expect(accumulationFateAtCharge("drop", true)).toBe("refuse");
    expect(accumulationFateAtCharge("drop", false)).toBe("drop");
    expect(accumulationFateAtCharge("refuse", true)).toBe("refuse");
    expect(accumulationFateAtCharge("refuse", false)).toBe("refuse");
  });

  test("an unrecognized function name reaches the operator as a literal", () => {
    // Classifying the key compiles every element's transform before the first
    // element is read, so terms naming a function this build does not have end
    // the exchange at the key's first row even where that row realizes no value
    // for the element declaring it. The name is partner-authored free text on
    // this path, so it is narrowed to a literal rather than echoed: neither the
    // control sequence nor the bidi override in the name reaches the operator.
    const hostileFunction = `nope${ESC}[31m${RLO}evil`;
    const key = {
      name: "LN+DOB",
      elements: [
        { field: "last_name" },
        { field: "date_of_birth", transform: [{ function: hostileFunction }] },
      ],
    };
    const rows = [{ last_name: "000", date_of_birth: "19750716" }];
    const firstElementRealizesNothing = new StandardizedDataset(
      [
        new StandardizedField(
          "last_name",
          "last_name",
          [{ function: "null_if", params: { value: "000" } }],
          rows,
        ),
        new StandardizedField("date_of_birth", "date_of_birth", [], rows),
      ],
      [key],
    );
    // The assumption: this row is excluded at the first element, so the second
    // element's transform is one no row runs.
    expect(
      buildKeyStrings(
        { ...key, elements: [key.elements[0], { field: "date_of_birth" }] },
        firstElementRealizesNothing,
        0,
        false,
        1,
      ),
    ).toBeNull();
    let raised: unknown;
    try {
      buildKeyStrings(key, firstElementRealizesNothing, 0, false, 1);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    expect(message).toContain("unknown standardization function");
    expect(message).not.toContain("nope");
    expect(message).toMatch(PRINTABLE_ASCII);
  });

  test("every declared fan-out producer is classified as expanding a value", () => {
    // A listed producer the classification does not know can expand leaves its
    // keys classified as producing no multiplicity at all, which costs them the
    // drop the width bound specifies for that producer.
    for (const name of FAN_OUT_FUNCTION_NAMES)
      expect(canProduceMultipleValues(name)).toBe(true);
    expect(
      runPipeline("A,B", [
        { function: "split_on", params: { delimiter: "," } },
      ]),
    ).toBeInstanceOf(Set);
  });

  test("every function that can expand a value is classified as expanding", () => {
    // The converse of the drift test above, and the direction that holds the
    // classification's guarantee: a function able to expand a value, left out
    // of the classification, leaves its keys classified as no multiplicity, and
    // the runtime safety check catches that only where the expansion lands
    // before the row's crossing. One step per function, with params letting it
    // do its job, is driven alone over values chosen to witness the expansion.
    const PROBE_PARAMS: Record<string, Record<string, unknown> | undefined> = {
      remove_non_ascii: undefined,
      replace_separators_with_spaces: undefined,
      squash_spaces: undefined,
      remove_punctuation: undefined,
      remove_dashes: undefined,
      trim_whitespace: undefined,
      to_upper_case: undefined,
      to_lower_case: undefined,
      remove_accents: undefined,
      remove_affixes: undefined,
      substring: { start: 1, length: 3 },
      parse_date: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
      pad_left: { length: 9 },
      phonetic: { algorithm: "soundex" },
      null_if: { values: ["EXCLUDED"] },
      replace_regex: { pattern: "[A-Z]+", replacement: "" },
      extract_regex: { pattern: "([0-9]+)" },
      filter_regex: { pattern: "^[0-9]+$" },
      split_on: { delimiter: "[ ,-]" },
      coalesce: { default: "ZZZ_FALLBACK" },
    };
    const PROBE_VALUES = [
      "SMITH",
      "SMITH,JONES",
      "Ana-Maria",
      "a b",
      "12/31/1999",
      "EXCLUDED",
      "123 456",
      "",
    ];
    expect([...STANDARDIZATION_FUNCTION_NAMES].sort()).toEqual(
      Object.keys(PROBE_PARAMS).sort(),
    );
    // A step that returned several candidates for ONE input value is the
    // producer of that multiplicity -- the same reading the run charges a
    // producer by. Exact in this direction, since a witness proves the function
    // can expand; the absence of one proves nothing, so a function this corpus
    // never expands is not held to the classification's other side.
    const expanding = STANDARDIZATION_FUNCTION_NAMES.filter((fn) => {
      const params = PROBE_PARAMS[fn];
      const step =
        params === undefined ? { function: fn } : { function: fn, params };
      return PROBE_VALUES.some((value) => {
        const result = runPipeline(value, [step]);
        return result instanceof Set && result.size > 1;
      });
    });
    expect(
      expanding.length,
      "the corpus witnesses no expansion",
    ).toBeGreaterThan(0);
    for (const fn of expanding)
      expect(canProduceMultipleValues(fn), fn).toBe(true);
  });

  test("the widest key no producer can expand assembles rather than crossing", () => {
    // The no-producer arm of the accumulation classification is a fail-closed
    // default (docs/spec/CHANNEL_SECURITY.md): nothing expands a value there, so
    // what holds such a key is the per-value ceiling on each element, at most
    // MAX_KEY_ELEMENTS of them (where the terms schema bounds a key). Driven
    // rather than computed, so an edit to the ceiling or the row's key-string
    // cap moves this row instead of leaving it pinned to a stale identity.
    const carriesValueOfLength = (length: number): boolean => {
      try {
        buildKeyStrings(
          { name: "LN", elements: [{ field: "last_name" }] },
          makeDataset({ last_name: "A".repeat(length) }),
          0,
          false,
          1,
        );
        return true;
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        return false;
      }
    };
    // The bracket is asserted rather than assumed: a ceiling outside it fails
    // here rather than being silently mis-measured.
    let largestCarried = 1;
    let smallestRefused = 1 << 20;
    expect(carriesValueOfLength(largestCarried)).toBe(true);
    expect(carriesValueOfLength(smallestRefused)).toBe(false);
    while (smallestRefused - largestCarried > 1) {
      const middle = Math.floor((largestCarried + smallestRefused) / 2);
      if (carriesValueOfLength(middle)) largestCarried = middle;
      else smallestRefused = middle;
    }

    const assembled = [
      ...(buildKeyStrings(
        {
          name: "every element at the ceiling",
          elements: Array.from({ length: MAX_KEY_ELEMENTS }, () => ({
            field: "last_name",
          })),
        },
        makeDataset({ last_name: "A".repeat(largestCarried) }),
        0,
        false,
        1,
      ) ?? []),
    ];
    // One key string holding every element's whole value: the row was neither
    // refused, which is the fate a crossing takes for such a key, nor dropped.
    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toHaveLength(MAX_KEY_ELEMENTS * largestCarried);
  });

  test("the accumulation drop signal reaches no caller", () => {
    // It is a plain Error whose message reports no fault an operator could act
    // on, raised only to stop an expansion that is already decided. Unexported,
    // it cannot be caught by type outside the module, and the shapes that raise
    // it return a dropped row rather than propagating.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      buildKeyStrings(
        amplifyingKey(splitRetainingSteps()),
        makeDataset({
          last_name: tokenCell(1443),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    const surface: Record<string, unknown> = standardizationModule;
    expect(
      Object.entries(surface).flatMap(([name, value]) =>
        typeof value === "function" ? [name, value.name] : [name],
      ),
    ).not.toContain("AccumulatedCandidatesDrop");
  });

  test("a partner-authored key name is escaped where a drop is warned", () => {
    // The one partner-authored text on these paths, at the one sink that passes
    // it along: a name holding CR/LF for log-line spoofing, an ESC that drives
    // ANSI, and a bidi override reaches the operator escaped rather than raw.
    const hostileName = `LN${ESC}[31m\r\nDOB${RLO}`;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      buildKeyStrings(
        { name: hostileName, elements: key.elements },
        makeDataset({
          last_name: ceilingCandidates(1025),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    ).toBeNull();

    // The cross-product advisory, the other sink on this path that passes along
    // the name: an unlisted producer's row is not dropped for width, so it is
    // warned about instead.
    withUnlistedFanOutFunctions(() =>
      buildKeyStrings(
        { name: hostileName, elements: key.elements },
        makeDataset({
          last_name: Array.from({ length: 21 }, (_unused, i) => `V${i}`),
          date_of_birth: "19750716",
        }),
        0,
        false,
        1,
      ),
    );

    expect(warn).toHaveBeenCalledTimes(2);
    for (const [warned] of warn.mock.calls) {
      expect(warned).toMatch(PRINTABLE_ASCII);
      expect(warned).toContain("LN\\x1b[31m\\x0d\\x0aDOB\\u202e");
    }
  });

  // --- the receiver's swapped locators ---------------------------------------
  // A key declaring `swap` moves the two named elements' FIELDS on the receiver
  // and leaves their transforms in place, so the position that reads a column
  // differs there from the position that declares it. The fixtures below
  // declare a transform on only ONE position of the pair, to tell the two
  // positions apart in a refusal's issue path -- not an admissible document
  // (the terms schema binds a pair to one transform), but a locator fixture.

  const swapKey = (transform?: LinkageKeyElement["transform"]) => ({
    name: "FN+LN swapped",
    elements: [{ field: "first_name", transform }, { field: "last_name" }],
    swap: ["first_name", "last_name"] as [string, string],
  });

  test("a swapped receiver's read refusal names the element declaring the column", () => {
    const dataset = makeDataset({
      first_name: "JANE",
      last_name: "A".repeat(4097),
    });
    // The sender reads last_name at its own declared position.
    expect(() => buildKeyStrings(swapKey(), dataset, 0, false, 3)).toThrow(
      /linkageKeys\[3\]\.elements\[1\]/,
    );
    // The receiver reads it at elements[0], but elements[1] is the position
    // whose `field` names the column -- which is what the refusal's remedy,
    // binding the element to a shorter column, has to point at.
    expect(() => buildKeyStrings(swapKey(), dataset, 0, true, 3)).toThrow(
      /linkageKeys\[3\]\.elements\[1\]/,
    );
  });

  // The accumulation locators are observable on the refusing fate alone -- a
  // dropped row logs the row and the key, never an issue path -- so the two
  // below drive the multi-value cell through an unlisted producer.

  test("a swapped receiver's accumulation refusal names the element declaring the column", () => {
    // No step produced these candidates -- the element declares no transform, so
    // they are the field's own realized values -- which puts the refusal on the
    // same footing as the value-read one above: it names the position whose
    // `field` is the offending column, so sender and receiver name the same
    // position for the same column.
    const dataset = withUnlistedFanOutFunctions(() =>
      makeDataset({
        first_name: "JANE",
        last_name: Array.from(
          { length: 1100 },
          (_unused, i) => `${"A".repeat(4000)}${String(i).padStart(4, "0")}`,
        ),
      }),
    );
    const named =
      /accumulated \d+ characters of candidate values from row 0 of this party's data \(linkageKeys\[3\]\.elements\[1\]\)/;
    expect(() => buildKeyStrings(swapKey(), dataset, 0, false, 3)).toThrow(
      named,
    );
    expect(() => buildKeyStrings(swapKey(), dataset, 0, true, 3)).toThrow(
      named,
    );
  });

  test("a swapped receiver's accumulation refusal names the step that produced the candidates", () => {
    // The other half: an element transform amplified each of the field's values,
    // and the swap leaves a transform where it is declared, so the refusal names
    // the element declaring it rather than the one declaring the column it read.
    const amplifying = swapKey([
      {
        function: "replace_regex",
        params: { pattern: "a*", replacement: "x".repeat(800) },
      },
    ]);
    const dataset = withUnlistedFanOutFunctions(() =>
      makeDataset({
        first_name: "JANE",
        last_name: Array.from({ length: 2000 }, (_unused, i) =>
          String(i).padStart(4, "0"),
        ),
      }),
    );
    expect(() => buildKeyStrings(amplifying, dataset, 0, true, 3)).toThrow(
      /accumulated \d+ characters of candidate values from row 0 of this party's data \(linkageKeys\[3\]\.elements\[0\]\)/,
    );
  });

  test("a swapped receiver's step refusal names the element declaring the step", () => {
    // The swap does not move a transform, so the step's position is the
    // element's own on both sides -- only the column it is fed changes.
    const dataset = makeDataset({
      first_name: "J",
      last_name: "S".repeat(200),
    });
    const amplifying = swapKey([
      {
        function: "replace_regex",
        params: { pattern: "a*", replacement: substitutingReplacement },
      },
    ]);
    expect(buildKeyStrings(amplifying, dataset, 0, false, 3)).not.toBeNull();
    expect(() => buildKeyStrings(amplifying, dataset, 0, true, 3)).toThrow(
      /linkageKeys\[3\]\.elements\[0\]\.transform\[0\]/,
    );
  });
});

// --- FAN_OUT_FUNCTION_NAMES --------------------------------------------------

describe("FAN_OUT_FUNCTION_NAMES", () => {
  test("is frozen, so no consumer can retune the drop-versus-refuse line", () => {
    // Each compiled step captures its membership in this list, which decides
    // whether an over-width row is dropped or the run refused. `readonly` is a
    // compile-time constraint that erases, so the freeze is the guarantee.
    const listed = [...FAN_OUT_FUNCTION_NAMES];
    const mutable = FAN_OUT_FUNCTION_NAMES as string[];
    expect(Object.isFrozen(FAN_OUT_FUNCTION_NAMES)).toBe(true);
    expect(() => mutable.push("to_upper_case")).toThrow(TypeError);
    expect(() => (mutable.length = 0)).toThrow(TypeError);
    expect(FAN_OUT_FUNCTION_NAMES).toEqual(listed);
  });
});

// --- resolveFieldColumns -----------------------------------------------------

// The one binding the dataset builder, the satisfiability checker, and the
// default-standardization derivation all consume. These pin its observable
// resolution result directly, so a future change to the rules cannot pass while
// silently differing from what the builder does.
describe("resolveFieldColumns", () => {
  // ssn + lastName fields, named by their semantic type for brevity.
  const terms: LinkageTerms = {
    version: "1.0.0",
    identity: "test",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  };

  test("explicit mapping preempts the type fallback even when a same-typed column is present", () => {
    // An ssn column is present, but the explicit mapping points ssn at tax_id.
    // The binding follows the explicit input, not the present same-typed column,
    // so an absent tax_id leaves ssn bound to a missing column. (The live bug:
    // honoring the present ssn column would have wrongly satisfied the field.)
    const resolution = resolveFieldColumns(
      terms,
      [{ output: "ssn", input: "tax_id" }],
      inferMetadata(["ssn", "last_name"]),
    );
    expect(resolution.get("ssn")?.column).toBe("tax_id");
    expect(resolution.get("ssn")?.transform).toEqual({
      output: "ssn",
      input: "tax_id",
    });
    // lastName has no explicit mapping, so it type-falls-back to last_name.
    expect(resolution.get("lastName")?.column).toBe("last_name");
    expect(resolution.get("lastName")?.transform).toBeUndefined();
  });

  test("type fallback binds to the FIRST same-typed column, not any present one", () => {
    // Two ssn-typed columns with the absent one listed first. The binding is the
    // first match (metadata.find), so ssn binds to absent_ssn even though
    // present_ssn is a present same-typed column -- the first-match-vs-set-
    // membership divergence, made observable on the resolution itself.
    const resolution = resolveFieldColumns(terms, undefined, [
      col("absent_ssn", "ssn"),
      col("present_ssn", "ssn"),
      col("last_name", "last_name"),
    ]);
    expect(resolution.get("ssn")?.column).toBe("absent_ssn");
  });

  test("an explicit mapping binds to its (role: linkage) input column", () => {
    // ssn_src is typed `other` and roled linkage, so the type fallback cannot bind
    // it to the ssn field -- only the explicit mapping does, isolating rule 1. (A
    // non-linkage input would be refused; see the role tests below.)
    const resolution = resolveFieldColumns(
      terms,
      [{ output: "ssn", input: "ssn_src" }],
      [col("ssn_src", "other"), col("last_name", "last_name")],
    );
    expect(resolution.get("ssn")?.column).toBe("ssn_src");
  });

  test("a field with neither an explicit mapping nor a same-typed column resolves to no column", () => {
    const resolution = resolveFieldColumns(
      terms,
      undefined,
      inferMetadata(["last_name"]),
    );
    expect(resolution.get("ssn")?.column).toBeUndefined();
    expect(resolution.get("lastName")?.column).toBe("last_name");
  });

  test("inferred metadata types the fallback by column name", () => {
    const resolution = resolveFieldColumns(
      terms,
      undefined,
      inferMetadata(["ssn", "last_name"]),
    );
    expect(resolution.get("ssn")?.column).toBe("ssn");
  });

  test("explicit metadata that retypes a column away unbinds its field", () => {
    // The ssn column would infer as ssn, but explicit metadata types it `other`,
    // so the type fallback finds no ssn column and the field resolves to nothing.
    const resolution = resolveFieldColumns(terms, undefined, [
      col("ssn", "other"),
      col("last_name", "last_name"),
    ]);
    expect(resolution.get("ssn")?.column).toBeUndefined();
  });

  test("an ignored column never binds a linkage field, even as the only one of its type", () => {
    // The linkage path keys on `type`, not `role`, so an ignored ssn column would
    // otherwise type-fall-back into the ssn field. It must resolve to no column.
    const resolution = resolveFieldColumns(terms, undefined, [
      roledCol("ssn", "ssn", "ignored"),
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBeUndefined();
    expect(resolution.get("lastName")?.column).toBe("last_name");
  });

  test("an explicit standardization naming an ignored column does not bind it into linkage", () => {
    // role: ignored wins over a contradictory explicit transform -- the field
    // resolves to no column (surfacing as unsatisfiable) rather than silently
    // linking a column the operator marked excluded. Without this, the explicit
    // binding (rule 1) would bypass the type-fallback ignored guard.
    const resolution = resolveFieldColumns(
      terms,
      [{ output: "ssn", input: "secret_ssn" }],
      [
        roledCol("secret_ssn", "ssn", "ignored"),
        roledCol("last_name", "last_name", "linkage"),
      ],
    );
    expect(resolution.get("ssn")?.column).toBeUndefined();
    expect(resolution.get("ssn")?.transform).toBeUndefined();
  });

  test("the type fallback skips an ignored column to bind a later non-ignored one", () => {
    // First-match would pick the ignored column; the ignored exclusion makes the
    // fallback bind the non-ignored same-typed column listed after it.
    const resolution = resolveFieldColumns(terms, undefined, [
      roledCol("ignored_ssn", "ssn", "ignored"),
      roledCol("real_ssn", "ssn", "linkage"),
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBe("real_ssn");
  });

  test("a duplicate explicit output binds to the last one", () => {
    // Not reachable through the schema (it forbids duplicate outputs) but pinned
    // so the builder's field map and the checker stay in agreement on the rule.
    const resolution = resolveFieldColumns(
      terms,
      [
        { output: "ssn", input: "first_src" },
        { output: "ssn", input: "second_src" },
      ],
      [col("first_src", "ssn"), col("second_src", "ssn")],
    );
    expect(resolution.get("ssn")?.column).toBe("second_src");
  });

  // --- matching participation requires role: linkage ------------------------
  // The narrowing: a column roled identifier/payload does NOT participate in
  // matching, even when its semantic type matches the field. Asserted here on the
  // one resolution the builder, the checker, and the default derivation share, so
  // a single chokepoint test covers all three (the differential `test.each` above
  // pins builder-vs-checker agreement on the same rule).

  test("a payload column is not linkage-eligible by type, even as the only one of its type", () => {
    // Its type matches the ssn field, but `role: payload` means "sent to the
    // partner", not "matched" -- so it must resolve to no column rather than be
    // silently hashed into a PSI key.
    const resolution = resolveFieldColumns(terms, undefined, [
      { name: "ssn", type: "ssn", role: "payload", isPayload: true },
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBeUndefined();
    expect(resolution.get("lastName")?.column).toBe("last_name");
  });

  test("an identifier column is not linkage-eligible by type, even as the only one of its type", () => {
    const resolution = resolveFieldColumns(terms, undefined, [
      roledCol("ssn", "ssn", "identifier"),
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBeUndefined();
  });

  test("the type fallback skips a payload column to bind a later linkage one", () => {
    // First-match would pick the payload column; the role narrowing makes the
    // fallback bind the `role: linkage` same-typed column listed after it.
    const resolution = resolveFieldColumns(terms, undefined, [
      { name: "sent_ssn", type: "ssn", role: "payload", isPayload: true },
      roledCol("real_ssn", "ssn", "linkage"),
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBe("real_ssn");
  });

  test("an explicit standardization naming a payload column does not bind it into linkage", () => {
    // role wins over a contradictory explicit transform -- the same guard that
    // protects an ignored column also protects payload/identifier, so a column
    // the operator marked sent-to-partner is never dragged onto the match axis.
    const resolution = resolveFieldColumns(
      terms,
      [{ output: "ssn", input: "sent_ssn" }],
      [
        { name: "sent_ssn", type: "ssn", role: "payload", isPayload: true },
        roledCol("last_name", "last_name", "linkage"),
      ],
    );
    expect(resolution.get("ssn")?.column).toBeUndefined();
    expect(resolution.get("ssn")?.transform).toBeUndefined();
  });

  test("a role: linkage column with isPayload still binds (match-and-send)", () => {
    // The documented way to both match and transmit a column: role linkage +
    // isPayload true. The narrowing leaves this unchanged -- it binds for matching
    // (transmission is the separate isDisclosedToPartner axis).
    const resolution = resolveFieldColumns(terms, undefined, [
      { name: "ssn", type: "ssn", role: "linkage", isPayload: true },
      roledCol("last_name", "last_name", "linkage"),
    ]);
    expect(resolution.get("ssn")?.column).toBe("ssn");
  });
});

describe("describeTransformCoercions", () => {
  // Each row is a param the descriptor claims a function coerces from a declared
  // `null` to `executed`, plus the other params and an input needed to run the
  // function. The behavior assertion below proves the claim against the real
  // factory; keep this list in step with TRANSFORM_PARAM_FALLBACKS.
  const coercingCases: Array<{
    fn: string;
    param: string;
    executed: unknown;
    otherParams: Record<string, unknown>;
    input: string;
  }> = [
    {
      fn: "replace_regex",
      param: "replacement",
      executed: "",
      otherParams: { pattern: "x" },
      input: "axbx",
    },
    {
      fn: "parse_date",
      param: "inputFormat",
      executed: "MM/DD/YYYY",
      otherParams: {},
      input: "01/02/2020",
    },
    {
      fn: "parse_date",
      param: "outputFormat",
      executed: "YYYYMMDD",
      otherParams: { inputFormat: "MM/DD/YYYY" },
      input: "01/02/2020",
    },
    {
      fn: "pad_left",
      param: "char",
      executed: "0",
      otherParams: { length: 5 },
      input: "12",
    },
    {
      fn: "phonetic",
      param: "algorithm",
      executed: "soundex",
      otherParams: {},
      input: "Smith",
    },
    {
      fn: "split_on",
      param: "includeOriginal",
      executed: false,
      otherParams: { delimiter: "," },
      input: "a,b",
    },
  ];

  test.each(coercingCases)(
    "$fn declares the executed value for a coerced $param and matches the factory",
    ({ fn, param, executed, otherParams, input }) => {
      // The descriptor reports the coercion for a declared-null param ...
      expect(
        describeTransformCoercions({
          function: fn,
          params: { ...otherParams, [param]: null },
        }),
      ).toContainEqual({ param, executed });

      // ... and that claim holds against the real factory: declaring the param
      // null produces the same result as declaring it as the claimed executed
      // value, so the descriptor cannot drift from what core runs.
      const withNull = runPipeline(input, [
        { function: fn, params: { ...otherParams, [param]: null } },
      ]);
      const withExecuted = runPipeline(input, [
        { function: fn, params: { ...otherParams, [param]: executed } },
      ]);
      expect(withNull).toEqual(withExecuted);
    },
  );

  test("does not report a param declared with a real value", () => {
    // A declared, non-null replacement is applied verbatim, so nothing is
    // coerced -- the screen must show it as written, not as the empty-string
    // default.
    expect(
      describeTransformCoercions({
        function: "replace_regex",
        params: { pattern: "x", replacement: "Y" },
      }),
    ).toEqual([]);
  });

  test("does not report a param the function does not coerce", () => {
    // `pattern` has no fallback (it is used as authored), so even a token
    // that somehow declared it null is not annotated as coerced.
    expect(
      describeTransformCoercions({
        function: "replace_regex",
        params: { pattern: null },
      }),
    ).toEqual([]);
  });

  test("reports nothing for a function with no coerced params", () => {
    expect(describeTransformCoercions({ function: "to_upper_case" })).toEqual(
      [],
    );
    expect(
      describeTransformCoercions({ function: "not_a_real_function" }),
    ).toEqual([]);
  });
});
