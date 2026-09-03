import { expect, test, describe, afterEach, vi } from "vitest";

import {
  runPipeline,
  resolveFieldColumns,
  buildStandardizedDataset,
  buildKeyStrings,
  validateStandardizationAgainstTerms,
  assertFanOutImplemented,
  assertStandardizationMatchesTerms,
  FAN_OUT_FUNCTION_NAMES,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  describeTransformCoercions,
  dateFormatComponents,
  unsatisfiedLinkageFields,
  assessLinkageSatisfiability,
  assertLinkageTermsSatisfiable,
  decideLinkageTermsVerdict,
  summarizeLinkageShortfall,
  checkValueConstraints,
  summarizeDatasetConstraintViolations,
  StandardizedField,
  StandardizedDataset,
  accumulationFateAtCharge,
  canProduceMultipleValues,
  coalesceSubstitutesConstant,
  substringCollapsesParsedDateToConstant,
  substringRunDropsEveryParsedDate,
  substringWindowDropsEveryValue,
  LAYOUT_DETERMINED_FUNCTION_NAMES,
  DATE_COLLAPSE_PROBES,
  CONSENT_VERDICT_PARAM_NAMES,
  stepCanEmptyRealizedValue,
  pipelineAlwaysDrops,
  parseDateInputDropsEveryRecord,
  STANDARDIZATION_FUNCTION_NAMES,
  type FieldValue,
} from "../src/standardization";
import * as standardizationModule from "../src/standardization";
import { ESC, PRINTABLE_ASCII, RLO } from "../src/displayEscapingFixtures";
import {
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  UnknownStandardizationFunctionError,
  UsageError,
} from "../src/errors";
import * as linearRegex from "../src/utils/linearRegex";
import { getLogger } from "../src/utils/logger";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { inferMetadata } from "../src/config/metadata";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  linkageTermsFromRuleSet,
} from "../src/defaults/linkageTerms";
import { getDefaultStandardization } from "../src/defaults/standardization";
import {
  MAX_KEY_ELEMENTS,
  MAX_TRANSFORM_PARAM_LENGTH,
  safeParseLinkageTerms,
} from "../src/config/linkageTerms";
import type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  TransformStep,
} from "../src/config/linkageTerms";
import type { ColumnMetadata, Metadata } from "../src/config/metadata";
import {
  StandardizationSchema,
  type Standardization,
} from "../src/config/standardization";
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
    // The input factory resolves either year token to a four-digit year, so a
    // YY-carrying input reports the year exactly as a YYYY-carrying one does.
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

  test("an output YY carries no year (it is an unsubstituted literal)", () => {
    // The factory substitutes only YYYY/MM/DD into the output; a YY in the output
    // emits literally, so it carries no year component and the year has collapsed.
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
    // ceiling deliberately does not reach it. A strict lower bound, so a
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

// --- coalesceSubstitutesConstant ---------------------------------------------

describe("coalesceSubstitutesConstant", () => {
  // The fallback a coalesce declares, distinctive enough that its presence in a
  // pipeline's output can only be the substitution.
  const FALLBACK = "ZZZ_FALLBACK";
  const fallbackStep = {
    function: "coalesce",
    params: { default: FALLBACK },
  };
  // One step per core function, with params that let it do its job. The values
  // below are chosen so every function that CAN empty a value does so for at
  // least one of them.
  const PARAMS: Record<string, Record<string, unknown> | undefined> = {
    substring: { start: 1, length: 3 },
    pad_left: { length: 9 },
    parse_date: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
    null_if: { values: ["EXCLUDED"] },
    replace_regex: { pattern: "[A-Z]+", replacement: "" },
    extract_regex: { pattern: "([0-9]+)" },
    filter_regex: { pattern: "^[0-9]+$" },
    split_on: { delimiter: " " },
    coalesce: { default: FALLBACK },
  };
  const stepFor = (fn: string) => ({
    function: fn,
    ...(PARAMS[fn] && { params: PARAMS[fn] }),
  });
  const VALUES = [
    "SMITH",
    "",
    "   ",
    "!!!",
    "12/31/1999",
    "EXCLUDED",
    "123",
    "Ana-Maria",
    "0",
    "a b",
  ];
  const realized = (result: ReturnType<typeof runPipeline>): string[] =>
    result === null ? [] : result instanceof Set ? [...result] : [result];

  test("the value-emptying classification matches what each function does", () => {
    // The classification decides whether a coalesce after a step can ever
    // substitute, so hold it to the real functions rather than to a reading of
    // them: each is driven alone over the value corpus, and a function classified
    // value-preserving that returns null for any of them fails here. One
    // direction is exact -- a witness proves a function can empty a value -- and
    // the other is corpus-bounded: it is a backstop against a misclassification,
    // not a proof that no input anywhere empties a preserved function's value.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES) {
      const step = stepFor(fn);
      const emptiesSomeValue = VALUES.some(
        (value) => runPipeline(value, [step]) === null,
      );
      expect(emptiesSomeValue, fn).toBe(stepCanEmptyRealizedValue(step));
    }
    // A pattern rule that erases the whole value is NOT emptying it: the coalesce
    // branch fires on a null value or an empty candidate set, and the empty string
    // is neither -- the case the name-only classification would get wrong if it
    // reasoned from "removes characters".
    expect(runPipeline("SMITH", [stepFor("replace_regex")])).toBe("");
    // A name this build does not recognize is read as able to empty a value: the
    // fail-safe direction on a consent surface, where understating a coalesce's
    // reach is the harmful one.
    expect(stepCanEmptyRealizedValue({ function: "not_a_real_function" })).toBe(
      true,
    );
  });

  test("the verdict matches whether the declared fallback is ever substituted", () => {
    // The predicate against the runtime, for every core function in front of a
    // coalesce: the fallback reaches the output exactly where the predicate says
    // the step substitutes. The coalesce is last so the constant is observable
    // rather than transformed by a later step.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES) {
      const preceding = [stepFor(fn)];
      const substituted = VALUES.some((value) =>
        realized(runPipeline(value, [...preceding, fallbackStep])).includes(
          FALLBACK,
        ),
      );
      expect(substituted, fn).toBe(
        coalesceSubstitutesConstant(fallbackStep, preceding),
      );
    }
    // As the FIRST step it substitutes for nothing: a pipeline is handed a value,
    // so the branch that substitutes is never reached.
    expect(coalesceSubstitutesConstant(fallbackStep, [])).toBe(false);
    for (const value of VALUES)
      expect(realized(runPipeline(value, [fallbackStep])), value).not.toContain(
        FALLBACK,
      );
  });

  test("a default core cannot substitute is no substitution at any position", () => {
    // Wire params are z.unknown(), so a partner can declare `default` as any JSON
    // value or omit it; every non-string runs as an absent default.
    const emptying = [stepFor("substring")];
    for (const badDefault of [null, 42, [], {}, true]) {
      const step = { function: "coalesce", params: { default: badDefault } };
      expect(
        coalesceSubstitutesConstant(step, emptying),
        JSON.stringify(badDefault),
      ).toBe(false);
    }
    expect(
      coalesceSubstitutesConstant({ function: "coalesce" }, emptying),
    ).toBe(false);
    // And no other function is ever the substituting step, whatever precedes it.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES.filter(
      (name) => name !== "coalesce",
    ))
      expect(coalesceSubstitutesConstant(stepFor(fn), emptying), fn).toBe(
        false,
      );
  });

  test("the real builder substitutes for no absent or blank field (differential)", () => {
    // The position half's premise, held to the key builder rather than asserted:
    // a record whose field is missing or blank never reaches the coalesce, so its
    // declared fallback appears in no key string. buildKeyStrings drops the row
    // for the key when the field realizes no value, and an element pipeline runs
    // on the value the field DID realize.
    const terms: LinkageTerms = {
      version: "1.0.0",
      identity: "Party",
      date: "2025-01-01",
      algorithm: "psi",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: false },
      deduplicate: false,
      linkageFields: [{ name: "last_name", type: "last_name" }],
      linkageKeys: [
        {
          name: "LN",
          elements: [{ field: "last_name", transform: [fallbackStep] }],
        },
      ],
    };
    const rows = [{ last_name: "Smith" }, { last_name: "" }, {}];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      inferMetadata(["last_name"]),
      terms,
    );
    const keyStrings = rows.flatMap((_, index) => [
      ...(buildKeyStrings(terms.linkageKeys[0], dataset, index) ?? []),
    ]);
    // Not vacuous: the record that carries a value does key, unsubstituted.
    expect(keyStrings.length).toBeGreaterThan(0);
    expect(keyStrings.some((key) => key.includes(FALLBACK))).toBe(false);
  });

  test("the dead-pipeline rescue reads the same verdicts through the predicate", () => {
    // pipelineAlwaysDrops shares the predicate, and its rescue is unmoved by the
    // position half: wherever it asks, the parse_date that emptied every record is
    // itself a step ahead of the coalesce.
    const dead = { function: "parse_date", params: { inputFormat: "MM/DD" } };
    expect(pipelineAlwaysDrops([dead])).toBe(true);
    expect(pipelineAlwaysDrops([dead, fallbackStep])).toBe(false);
    expect(pipelineAlwaysDrops([fallbackStep, dead])).toBe(true);
    expect(pipelineAlwaysDrops([dead, { function: "coalesce" }])).toBe(true);
    expect(
      pipelineAlwaysDrops([dead, { function: "coalesce" }, fallbackStep]),
    ).toBe(false);
    expect(pipelineAlwaysDrops([dead, fallbackStep, dead])).toBe(true);
    expect(pipelineAlwaysDrops([fallbackStep])).toBe(false);
  });
});

// --- substringCollapsesParsedDateToConstant ----------------------------------

describe("substringCollapsesParsedDateToConstant", () => {
  // The oracle corpus. Its first two dates differ in EVERY digit of every
  // rendered component -- 1971 against 2068 in all four year digits, 01 against
  // 12 in both month digits, 02 against 31 in both day digits -- so a window
  // reading even one character the DATE supplied renders differently for them,
  // and one reading only the format's own characters renders identically. That
  // makes "every output is the same non-null value" exactly the property the
  // predicate claims. The corpus is deliberately WIDER than the probe set the
  // predicate measures over, so a probe set too narrow to discriminate is a
  // failure here rather than an agreement with itself.
  const DATES = [
    "01/02/1971",
    "12/31/2068",
    "05/13/1990",
    "11/24/2007",
    "03/04/2021",
    "07/28/1985",
  ];
  const parseDate = (
    outputFormat: unknown,
    inputFormat: unknown = "MM/DD/YYYY",
  ): TransformStep => ({
    function: "parse_date",
    params: { inputFormat, outputFormat },
  });
  const slice = (start: unknown, length: unknown): TransformStep => ({
    function: "substring",
    params: { start, length },
  });
  // What the shipped pipeline does with the whole corpus: the value every date
  // leaves behind, or undefined where they differ or any date is dropped.
  const collapsedValue = (
    steps: ReadonlyArray<TransformStep>,
  ): string | undefined => {
    const outputs = DATES.map((date) => runPipeline(date, [...steps]));
    const first = outputs[0];
    if (typeof first !== "string") return undefined;
    return outputs.every((output) => output === first) ? first : undefined;
  };
  const verdictAt = (steps: ReadonlyArray<TransformStep>, index: number) =>
    substringCollapsesParsedDateToConstant(steps, index);
  const anyVerdict = (steps: ReadonlyArray<TransformStep>) =>
    steps.some((_step, index) => verdictAt(steps, index));

  test("the oracle corpus carries dates the predicate does not probe", () => {
    // The wider-corpus claim above, as a check: were the probe set widened to
    // the whole corpus, every differential below would compare the predicate to
    // its own inputs and pass whatever it decided.
    const probed = new Set(
      DATE_COLLAPSE_PROBES.map(
        (probe) => `${probe.month}/${probe.day}/${probe.year}`,
      ),
    );
    expect(DATES.filter((date) => !probed.has(date)).length).toBeGreaterThan(0);
  });

  test("the verdict matches whether the real slice is one constant (differential)", () => {
    // Every combination of an output format and a slice window, against the
    // shipped pipeline: the predicate says "collapses to a constant" exactly
    // where every date leaves the same non-null value behind.
    const OUTPUT_FORMATS = [
      // A literal region ahead of the date, the motivating shape.
      "ACME-YYYYMMDD",
      // Separators between the components, so a window can land on one alone.
      "YYYY-MM-DD",
      // The plain default layout, which has no literal to land in.
      "YYYYMMDD",
      // Reordered and repeated tokens: the factory substitutes EVERY occurrence,
      // so the layout carries five component spans around four literals.
      "MM-MM-YYYY-DD-DD",
      // Tokens the greedy scan must not mis-split: a fifth Y is literal after
      // YYYY, a third M is literal after MM, and a bare YY in an OUTPUT format is
      // literal text rather than a year.
      "YYYYY",
      "YYYYYY",
      "MMM",
      "MM/DD/YY",
      // No token at all -- every window is constant, the case the tokenless rule
      // already names.
      "registered",
    ];
    const WINDOWS: Array<[number, number]> = [
      [1, 1],
      [1, 4],
      [1, 5],
      [1, 6],
      [2, 3],
      [4, 2],
      [5, 1],
      [5, 2],
      [6, 1],
      [7, 2],
      [1, 40],
      [14, 3],
      [-1, 1],
      [-2, 2],
      [-4, 3],
      [-40, 2],
      // A negative length is not an empty window: it drives slice's end argument
      // below zero, where it counts back from the end of the value instead.
      [1, -3],
      [1, -9],
      [1, -13],
      [2, -8],
      [-5, -2],
    ];
    const collapsed: string[] = [];
    for (const outputFormat of OUTPUT_FORMATS)
      for (const [start, length] of WINDOWS) {
        const steps = [parseDate(outputFormat), slice(start, length)];
        const value = collapsedValue(steps);
        if (value !== undefined) collapsed.push(outputFormat);
        expect(
          verdictAt(steps, 1),
          `${outputFormat} [${start}, ${length}] -> ${JSON.stringify(value)}`,
        ).toBe(value !== undefined);
      }
    // Not vacuous, and not carried by the tokenless format alone: a layout that
    // does render the date still has windows that read none of it.
    expect(
      new Set(collapsed.filter((format) => format !== "registered")).size,
    ).toBeGreaterThan(1);
    expect(collapsed.length).toBeLessThan(
      OUTPUT_FORMATS.length * WINDOWS.length,
    );
  });

  test("a window that reads nothing is a drop, not a collapse", () => {
    // substringFactory compiles a non-integer bound, a `start` of 0, a zero
    // length, and a window that starts past the end into a step that returns null
    // for every value: the element matches NOTHING, the opposite of collapsing
    // onto a constant.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    for (const [start, length] of [
      [0, 3],
      [1, 0],
      [14, 3],
      [1, -13],
      [1.5, 3],
      [1, 2.5],
    ] as Array<[unknown, unknown]>) {
      const steps = [literalRegion, slice(start, length)];
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(verdictAt(steps, 1), `${JSON.stringify([start, length])}`).toBe(
        false,
      );
    }
    for (const bound of [null, "1", [], {}, true])
      expect(
        verdictAt([literalRegion, slice(bound, 3)], 1),
        JSON.stringify(bound),
      ).toBe(false);
  });

  test("the verdict is a property of the position, not of either step alone", () => {
    const literalRegion = parseDate("ACME-YYYYMMDD");
    const firstFour = slice(1, 4);
    expect(verdictAt([literalRegion, firstFour], 1)).toBe(true);
    // Only a substring reads a window; no other function is the sliced step.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES.filter(
      (name) => name !== "substring",
    ))
      expect(verdictAt([literalRegion, { function: fn }], 1), fn).toBe(false);
    // With no parse_date ahead of it the window slices whatever the identifier
    // composed, so the layout establishes nothing.
    expect(verdictAt([firstFour], 0)).toBe(false);
    // A step BEFORE the parse_date is unconstrained: it can change whether a
    // value parses, never the layout a parsed date renders to.
    expect(
      verdictAt([{ function: "to_upper_case" }, literalRegion, firstFour], 2),
    ).toBe(true);
    // The nearest parse_date is the one that laid out the value: a plain layout
    // in front of the literal-region one does not withdraw the collapse, and the
    // reverse order does not confer it.
    expect(
      verdictAt([parseDate("YYYYMMDD"), literalRegion, firstFour], 2),
    ).toBe(true);
    expect(
      verdictAt(
        [literalRegion, parseDate("YYYYMMDD", "YYYYMMDD"), firstFour],
        2,
      ),
    ).toBe(false);
  });

  test("a parse_date that yields no value at all collapses nothing", () => {
    // An input format that core cannot assemble a date from drops every record, so
    // there is no rendered layout to slice -- a narrowing the dead-key advisory
    // surfaces, not a collapse. Held to the runtime as well as to the predicate.
    const firstFour = slice(1, 4);
    for (const inputFormat of ["MM/DD", 7] as unknown[]) {
      const steps = [parseDate("ACME-YYYYMMDD", inputFormat), firstFour];
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(verdictAt(steps, 1), JSON.stringify(inputFormat)).toBe(false);
    }
    // An ABSENT input format is not a dead one: the factory falls back to the
    // complete default layout, so the window still lands in the literal region.
    const absentInput = parseDate("ACME-YYYYMMDD", null);
    expect(verdictAt([absentInput, firstFour], 1)).toBe(true);
    expect(runPipeline(DATES[0], [absentInput, firstFour])).toBe("ACME");
  });

  test("an unusable output format falls back to the layout the factory renders", () => {
    // A non-string outputFormat is not text the window reads: the factory falls
    // back to the plain default layout, which has no literal region, so no window
    // collapses. Pinned against the runtime rather than the coercion's source.
    for (const outputFormat of [undefined, null, 7, [], {}] as unknown[])
      for (const [start, length] of [
        [1, 4],
        [5, 2],
        [1, 8],
        [-2, 2],
      ] as Array<[number, number]>) {
        const steps = [parseDate(outputFormat), slice(start, length)];
        expect(
          collapsedValue(steps),
          JSON.stringify(outputFormat),
        ).toBeUndefined();
        expect(verdictAt(steps, 1), JSON.stringify(outputFormat)).toBe(false);
      }
  });

  test("a run of substrings is read as the one window it ends on (differential)", () => {
    // Each link slices a contiguous range of the link before it, so a run of
    // substrings after a parse_date reads ONE window of the rendered layout. Every
    // chain below goes through the shipped pipeline: the predicate at the LAST
    // link says "collapses to a constant" exactly where every date leaves the same
    // non-null value behind, whatever the chain's intermediate windows did.
    const OUTPUT_FORMATS = [
      // The motivating shape: a literal region the composed window can land in.
      "ACME-YYYYMMDD",
      // Separators a composed window can land on alone.
      "YYYY-MM-DD",
      // No literal at all, so no chain over it may collapse.
      "YYYYMMDD",
      // No token at all, so every non-empty chain over it collapses.
      "registered",
    ];
    const CHAINS: Array<Array<[number, number]>> = [
      // A wide first window narrowed onto the literal region: neither link reads
      // only the format's own characters by itself.
      [
        [1, 13],
        [1, 4],
      ],
      [
        [1, 13],
        [2, 3],
      ],
      // The first link already lands in the literal region.
      [
        [1, 5],
        [1, 4],
      ],
      [
        [1, 5],
        [5, 1],
      ],
      // The first link straddles the literal and the date; the second retreats
      // into the literal.
      [
        [1, 6],
        [1, 4],
      ],
      // ... and the second stays on the date.
      [
        [1, 6],
        [6, 1],
      ],
      [
        [6, 8],
        [1, 4],
      ],
      // A window landing on a bare separator between two components.
      [
        [1, 10],
        [5, 1],
      ],
      [
        [5, 3],
        [1, 1],
      ],
      [
        [5, 3],
        [2, 2],
      ],
      // Negative starts, which resolve against the length the run holds at that
      // point rather than against the layout.
      [
        [-9, 9],
        [1, 4],
      ],
      [
        [1, 13],
        [-4, 2],
      ],
      // Negative lengths: an end argument below zero counts back from the end of
      // the value the link is handed, so the link reads a real window.
      [
        [1, -9],
        [1, 4],
      ],
      [
        [1, -8],
        [1, 4],
      ],
      [
        [1, 13],
        [1, -9],
      ],
      [
        [1, 5],
        [1, -4],
      ],
      // A second link reaching past the end of the first, which clamps.
      [
        [1, 4],
        [1, 10],
      ],
      // A link that reads nothing: the value is emptied and the rest of the run
      // null-propagates, so the chain drops rather than collapses.
      [
        [1, 4],
        [5, 2],
      ],
      [
        [1, 5],
        [1, 0],
      ],
      [
        [1, 5],
        [0, 3],
      ],
      // Three links.
      [
        [1, 13],
        [1, 6],
        [1, 4],
      ],
      [
        [1, 13],
        [6, 8],
        [1, 4],
      ],
      [
        [1, 13],
        [1, 5],
        [5, 1],
      ],
      [
        [1, 13],
        [1, 4],
        [5, 2],
      ],
    ];
    const collapsedBy: Array<{ outputFormat: string; links: number }> = [];
    for (const outputFormat of OUTPUT_FORMATS)
      for (const chain of CHAINS) {
        const steps = [
          parseDate(outputFormat),
          ...chain.map(([start, length]) => slice(start, length)),
        ];
        const value = collapsedValue(steps);
        if (value !== undefined)
          collapsedBy.push({ outputFormat, links: chain.length });
        // The whole element is asked, exactly as the consent header asks it: no
        // link of the run may announce a collapse the run does not deliver.
        expect(
          anyVerdict(steps),
          `${outputFormat} ${JSON.stringify(chain)} -> ${JSON.stringify(value)}`,
        ).toBe(value !== undefined);
      }
    // Not vacuous: chains collapse over more than one layout that does render a
    // date, and at both chain lengths, while plenty of them do not collapse.
    expect(
      new Set(
        collapsedBy
          .filter((c) => c.outputFormat !== "registered")
          .map((c) => c.outputFormat),
      ).size,
    ).toBeGreaterThan(1);
    expect(new Set(collapsedBy.map((c) => c.links))).toEqual(new Set([2, 3]));
    expect(collapsedBy.length).toBeLessThan(
      OUTPUT_FORMATS.length * CHAINS.length,
    );
  });

  test("the collapse verdict lands on the last link of a chain, not an earlier one", () => {
    // Neither link reads only literal characters on its own, so a rule reading
    // one window at a time would see a truncation, while the run reads "ACME"
    // out of every date. The verdict belongs to the link the run ends at.
    const steps = [parseDate("ACME-YYYYMMDD"), slice(1, 13), slice(1, 4)];
    expect(collapsedValue(steps)).toBe("ACME");
    expect(steps.map((_step, index) => verdictAt(steps, index))).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("a mid-run collapse the run then slices out of range is not announced", () => {
    // The first link reads the literal region, so a verdict taken THERE says
    // "any date"; the second link then composes out of that four-character
    // window and reads nothing, so the element matches no record at all. A
    // verdict is taken only where the run ends, which is what parts the two.
    const steps = [parseDate("ACME-YYYYMMDD"), slice(1, 4), slice(5, 2)];
    for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
    expect(steps.map((_step, index) => verdictAt(steps, index))).toEqual([
      false,
      false,
      false,
    ]);
    // The truncated element -- the same first link with nothing after it -- is
    // the collapse the mid-run verdict would have been reporting.
    expect(anyVerdict(steps.slice(0, 2))).toBe(true);
  });

  test("a value-preserving step between the two keeps the verdict", () => {
    // Each step below leaves the characters the window reads exactly where the
    // runtime leaves them, so every record still ends on one constant. A rule
    // that ended its walk at the first non-substring would call each of these a
    // truncation while the runtime collapsed -- which is the reading measuring
    // the steps replaces.
    const intervening: TransformStep[] = [
      { function: "to_upper_case" },
      { function: "to_lower_case" },
      { function: "trim_whitespace" },
      { function: "squash_spaces" },
      { function: "remove_accents" },
      { function: "remove_non_ascii" },
      { function: "remove_affixes" },
      { function: "remove_punctuation" },
      { function: "remove_dashes" },
      { function: "replace_separators_with_spaces" },
      { function: "null_if", params: { values: ["no such value"] } },
      { function: "filter_regex", params: { pattern: "ACME" } },
      { function: "coalesce", params: { default: "FALLBACK" } },
      { function: "pad_left", params: { length: 20, char: "0" } },
      { function: "replace_regex", params: { pattern: "E", replacement: "3" } },
    ];
    for (const step of intervening) {
      const steps = [parseDate("ACME-YYYYMMDD"), step, slice(1, 4)];
      expect(collapsedValue(steps), step.function).not.toBeUndefined();
      expect(verdictAt(steps, 2), step.function).toBe(true);
    }
    // Several links after the intervening step compose the same way a run
    // directly after the parse_date does.
    expect(
      verdictAt(
        [
          parseDate("ACME-YYYYMMDD"),
          { function: "remove_dashes" },
          slice(1, 12),
          slice(1, 4),
        ],
        3,
      ),
    ).toBe(true);
  });

  test("whether a step preserves the window is a property of the window too", () => {
    // Why a function-name allowlist cannot decide this. `remove_dashes` closes
    // the gap the format's own separator held, so a four-character window still
    // reads only the format's characters while a five-character one pulls the
    // year's first digit into it -- the same function, opposite verdicts.
    const dashRemoved = (start: number, length: number) => [
      parseDate("ACME-YYYYMMDD"),
      { function: "remove_dashes" },
      slice(start, length),
    ];
    expect(collapsedValue(dashRemoved(1, 4))).toBe("ACME");
    expect(verdictAt(dashRemoved(1, 4), 2)).toBe(true);
    expect(collapsedValue(dashRemoved(1, 5))).toBeUndefined();
    expect(verdictAt(dashRemoved(1, 5), 2)).toBe(false);
    // Without the step the fifth character is the format's own dash, so the
    // wider window collapses; the step is what moves the verdict, not the window
    // alone.
    expect(verdictAt([parseDate("ACME-YYYYMMDD"), slice(1, 5)], 1)).toBe(true);
  });

  test("a step that drops the collapsed value AFTER the run withholds the verdict", () => {
    // An element that matches nothing is not one that matches every date. A
    // dropping step after the run drops the constant every record holds by then,
    // which drops every record -- determinate with no probing, since there is
    // only one value left to drop.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    const neverMatches: TransformStep = {
      function: "filter_regex",
      params: { pattern: "NOTHING-MATCHES-THIS" },
    };
    const dropsTheConstant: TransformStep = {
      function: "null_if",
      params: { values: ["ACME"] },
    };
    for (const steps of [
      [literalRegion, slice(1, 4), neverMatches],
      [literalRegion, slice(1, 4), dropsTheConstant],
    ]) {
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(anyVerdict(steps), JSON.stringify(steps)).toBe(false);
    }
    // A `coalesce` after the drop puts every record back on one constant, so the
    // collapse stands: the tail is run, not assumed.
    const rescued = [
      literalRegion,
      slice(1, 4),
      { function: "null_if", params: { values: ["ACME"] } },
      { function: "coalesce", params: { default: "UNKNOWN" } },
    ];
    expect(collapsedValue(rescued)).toBe("UNKNOWN");
    expect(anyVerdict(rescued)).toBe(true);
    // A tail that expands the constant into candidates still keys every record,
    // and on the same values, so the collapse stands. The header never reads
    // this shape -- a declared fan-out outranks the collapse tier there -- but
    // the predicate must not call it a drop.
    const expanded = [
      literalRegion,
      slice(1, 4),
      { function: "split_on", params: { delimiter: "M" } },
    ];
    expect(runPipeline(DATES[0], expanded)).toEqual(new Set(["AC", "E"]));
    expect(anyVerdict(expanded)).toBe(true);
  });

  test("a value-dependent step that drops every probe takes the wider word", () => {
    // A drop BETWEEN the parse_date and the run empties the value before the
    // window reads it, and whether a real record is emptied there is the data's
    // to decide -- the probes settle nothing. The consent direction on an
    // undecided measurement is the wider breadth word, so the verdict stands
    // rather than falling back to the milder truncation the last link looks like.
    // Held against the runtime, which drops every date here: the over-claim is
    // deliberate, and it is the only direction this residual runs in.
    const steps = [
      parseDate("ACME-YYYYMMDD"),
      { function: "filter_regex", params: { pattern: "NOTHING-MATCHES-THIS" } },
      slice(1, 4),
    ];
    for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
    expect(anyVerdict(steps)).toBe(true);
    // The same shape spelled with the other value-dependent dropper, naming
    // every probe's rendered value outright.
    const namesEveryProbe = [
      parseDate("ACME-YYYYMMDD"),
      {
        function: "null_if",
        params: {
          values: DATES.map((date) =>
            runPipeline(date, [parseDate("ACME-YYYYMMDD")]),
          ),
        },
      },
      slice(1, 4),
    ];
    expect(anyVerdict(namesEveryProbe)).toBe(true);
  });

  test("a drop the DATA decides is the limit the verdict keeps", () => {
    // The stated limit, pinned so a change to either half is visible. A
    // `null_if` naming one rendered date that no probe renders passes the
    // measurement, so the element still earns "any date" -- while the record
    // holding that date is dropped rather than collapsed. Reading that from the
    // terms would mean assuming a drop the data decides. Widening the probe set
    // to cover this date narrows the limit and turns this red, which is the
    // reading it is here to make visible.
    const steps = [
      parseDate("ACME-YYYYMMDD"),
      { function: "null_if", params: { values: ["ACME-20330417"] } },
      slice(1, 4),
    ];
    expect(runPipeline("04/17/2033", steps)).toBeNull();
    expect(runPipeline("12/31/2068", steps)).toBe("ACME");
    expect(anyVerdict(steps)).toBe(true);
  });

  test("naming a probe's rendered value does not buy the milder word", () => {
    // The probe dates are baked into shipped public source, so an inviter can
    // read one off and author a step naming exactly its rendered value. Were a
    // dropped probe allowed to defeat the verdict, that one step would return the
    // header to the truncation word while the pipeline still put every other date
    // on "ACME". The surviving probes decide instead. The named values come from
    // the shipped probe list, so no probe here is one this test assumed.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    for (const probe of DATE_COLLAPSE_PROBES) {
      const named = `ACME-${probe.year}${probe.month}${probe.day}`;
      const asInput = `${probe.month}/${probe.day}/${probe.year}`;
      const steps = [
        literalRegion,
        { function: "null_if", params: { values: [named] } },
        slice(1, 4),
      ];
      expect(runPipeline(asInput, steps), named).toBeNull();
      expect(runPipeline("03/04/2021", steps), named).toBe("ACME");
      expect(anyVerdict(steps), named).toBe(true);
    }
    // A step naming a junk sentinel no probe renders drops none of them, so the
    // verdict is measured exactly as it is without the step.
    const sentinel = [
      literalRegion,
      { function: "null_if", params: { values: ["NOT-A-RENDERED-DATE"] } },
      slice(1, 4),
    ];
    expect(collapsedValue(sentinel)).toBe("ACME");
    expect(anyVerdict(sentinel)).toBe(true);
    // ... and a dropped probe grants no collapse of its own: on a window that
    // reads the date itself, the surviving probes still disagree, so the milder
    // word stands.
    const first = DATE_COLLAPSE_PROBES[0];
    const readsTheDate = [
      literalRegion,
      {
        function: "null_if",
        params: { values: [`ACME-${first.year}${first.month}${first.day}`] },
      },
      slice(6, 8),
    ];
    expect(
      runPipeline(`${first.month}/${first.day}/${first.year}`, readsTheDate),
    ).toBeNull();
    expect(runPipeline("03/04/2021", readsTheDate)).toBe("20210304");
    expect(anyVerdict(readsTheDate)).toBe(false);
  });

  test("a run that reads no content and drops every probe is dead, not a collapse", () => {
    // The composed window falls back out of the rendered layout, and every step
    // between the parse_date and the run's end reads the layout rather than the
    // value -- so what the probes did is what every date does. That is a
    // value-INDEPENDENT drop, which pipelineAlwaysDrops reports and the collapse
    // verdict declines.
    for (const steps of [
      [parseDate("ACME-YYYYMMDD"), slice(1, 4), slice(5, 2)],
      [parseDate("ACME-YYYYMMDD"), { function: "to_upper_case" }, slice(20, 2)],
      [parseDate("YYYYMMDD"), slice(1, 4), slice(1, 0)],
    ]) {
      for (const date of DATES)
        expect(runPipeline(date, steps), JSON.stringify(steps)).toBeNull();
      expect(anyVerdict(steps), JSON.stringify(steps)).toBe(false);
      expect(pipelineAlwaysDrops(steps), JSON.stringify(steps)).toBe(true);
    }
    // A value-dependent step in the run withdraws the DEAD claim as well as the
    // milder word: the data decides that drop, so the pipeline is not reported
    // self-defeating.
    const valueDependent = [
      parseDate("ACME-YYYYMMDD"),
      { function: "filter_regex", params: { pattern: "NOTHING-MATCHES-THIS" } },
      slice(1, 4),
    ];
    expect(pipelineAlwaysDrops(valueDependent)).toBe(false);
    // A rescuing `coalesce` after the dead run puts every record on its default,
    // so the pipeline is not dead at all.
    expect(
      pipelineAlwaysDrops([
        parseDate("ACME-YYYYMMDD"),
        slice(1, 4),
        slice(5, 2),
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toBe(false);
  });

  test("every layout-determined function leaves the dates it is handed alike", () => {
    // What holds the classification the dead claim rests on: a function listed
    // there must map any two dates rendered under one output format to values of
    // the same length that are null together, since that is what makes the
    // probes' fate every date's. Driven through the shipped pipeline rather than
    // read off the factories. One params shape per function, so this catches a
    // listed function that starts reading content -- not one whose reading only
    // some other params shape exposes, which stays the review call the constant's
    // own doc records.
    const OUTPUT_FORMATS = [
      "ACME-YYYYMMDD",
      "YYYY-MM-DD",
      "YYYYMMDD",
      "MM/DD/YY",
      "DD.MM.YYYY",
    ];
    // Params for the listed functions that take them, chosen so the step does
    // something rather than compiling to a pass-through or an always-null.
    const PARAMS: Record<string, Array<Record<string, unknown>>> = {
      substring: [
        { start: 1, length: 4 },
        { start: 5, length: 3 },
        { start: -4, length: 2 },
        { start: 1, length: -3 },
      ],
      pad_left: [{ length: 20, char: "0" }],
      coalesce: [{ default: "FALLBACK" }],
    };
    // `coalesce` passes a value it is handed straight through, so its
    // substituting branch is reached only behind a step that empties the value.
    const PREFIX: Record<string, TransformStep[]> = {
      coalesce: [slice(40, 2)],
    };
    const WIDE_DATES = [...DATES, "02/29/2024", "10/09/1999", "01/01/2000"];
    for (const name of LAYOUT_DETERMINED_FUNCTION_NAMES) {
      expect(STANDARDIZATION_FUNCTION_NAMES, name).toContain(name);
      for (const params of PARAMS[name] ?? [undefined])
        for (const outputFormat of OUTPUT_FORMATS) {
          const steps = [
            parseDate(outputFormat),
            ...(PREFIX[name] ?? []),
            { function: name, ...(params ? { params } : {}) },
          ];
          const outputs = WIDE_DATES.map((date) => runPipeline(date, steps));
          const shape = (value: FieldValue) =>
            typeof value === "string" ? value.length : value;
          expect(
            new Set(outputs.map(shape)).size,
            `${name} ${JSON.stringify(params)} ${outputFormat}`,
          ).toBe(1);
        }
    }
  });

  test("a step this build cannot run takes the wider word, not the milder one", () => {
    // The function name is partner free text, so a name core does not recognize
    // reaches the predicate. The measurement cannot compile it, so the window's
    // breadth is unknown -- and on a consent surface an unknown breadth resolves
    // UP to the collapse word, never down to the truncation the last link looks
    // like. Were it to decline the verdict, an inviter would drop the marker from
    // "any date" to "partial" by naming one step core cannot run.
    const unknownInRun = [
      parseDate("ACME-YYYYMMDD"),
      { function: "no_such_function" },
      slice(1, 4),
    ];
    expect(() => runPipeline(DATES[0], unknownInRun)).toThrow(
      UnknownStandardizationFunctionError,
    );
    expect(anyVerdict(unknownInRun)).toBe(true);
    // The same, with the unrecognized step in the TAIL after a run that already
    // collapsed to one constant: the collapse stands rather than falling to the
    // milder word because the tail could not be measured.
    const unknownInTail = [
      parseDate("ACME-YYYYMMDD"),
      slice(1, 4),
      { function: "no_such_function" },
    ];
    expect(verdictAt(unknownInTail, 1)).toBe(true);
  });

  test("a probe inflated past the value ceiling takes the wider word", () => {
    // The round-2 evasion: a replace_regex expands a probe date past the per-value
    // ceiling, so the measured run returns "unread" before it can read the window.
    // The consent marker must resolve that up to the collapse word rather than to
    // the reassuring "pattern replacement" the step would otherwise name, since an
    // inviter could inflate one probe while every real date still collapses onto
    // one constant. 5000 fill characters carry the rendered probe well over the
    // 4096-character ceiling.
    const inflated = [
      parseDate("ACME-YYYYMMDD"),
      {
        function: "replace_regex",
        params: { pattern: "ACME", replacement: "X".repeat(5000) },
      },
      slice(1, 4),
    ];
    // Every date really does collapse onto one constant here -- the slice reads
    // fill the replacement supplied -- which is the breadth the marker must name.
    // runPipeline does not enforce the ceiling (the exchange path does, and would
    // refuse the over-length intermediate), so the collapse is visible directly.
    for (const date of DATES) expect(runPipeline(date, inflated)).toBe("XXXX");
    expect(anyVerdict(inflated)).toBe(true);
    // A run measured clean still keeps its true milder word: a plain slice of the
    // date itself reads distinct values across the probes, so the verdict declines
    // the collapse and the header shows "partial" (see the differential above).
    const cleanPartial = [parseDate("YYYYMMDD"), slice(1, 4)];
    expect(collapsedValue(cleanPartial)).toBeUndefined();
    expect(anyVerdict(cleanPartial)).toBe(false);
  });
});

// --- CONSENT_VERDICT_PARAM_NAMES ---------------------------------------------

describe("CONSENT_VERDICT_PARAM_NAMES", () => {
  // What holds the table to real verdicts: every param it lists is moved here,
  // and the predicate that reads it must move with it. The cases are driven from
  // the shipped constant, so a name added there without one is a failure rather
  // than a silently unheld entry. The other direction -- a NEW verdict param
  // arriving with no entry in the constant -- no test can see; it is the review
  // call the constant's own doc records.
  const parseDate = (outputFormat: string): TransformStep => ({
    function: "parse_date",
    params: { inputFormat: "MM/DD/YYYY", outputFormat },
  });
  const slicedLiteralRegion = (
    outputFormat: string,
    start: number,
    length: number,
  ): boolean =>
    substringCollapsesParsedDateToConstant(
      [
        parseDate(outputFormat),
        { function: "substring", params: { start, length } },
      ],
      1,
    );
  const emptyingStep: TransformStep = {
    function: "null_if",
    params: { values: ["ACME"] },
  };
  const coalesceWithDefault = (declared: unknown): boolean =>
    coalesceSubstitutesConstant(
      { function: "coalesce", params: { default: declared } },
      [emptyingStep],
    );

  // Each case declares two values for its param whose verdicts must differ.
  const VERDICT_MOVES: Record<
    string,
    Record<string, () => [boolean, boolean]>
  > = {
    parse_date: {
      inputFormat: () => [
        parseDateInputDropsEveryRecord({ inputFormat: "MM/DD" }),
        parseDateInputDropsEveryRecord({ inputFormat: "MM/DD/YYYY" }),
      ],
      outputFormat: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("YYYYMMDD", 1, 4),
      ],
    },
    substring: {
      start: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("ACME-YYYYMMDD", 6, 4),
      ],
      length: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 6),
      ],
    },
    coalesce: {
      default: () => [
        coalesceWithDefault("SUBSTITUTED"),
        coalesceWithDefault(7),
      ],
    },
  };

  test("every listed param moves the verdict that reads it", () => {
    expect(Object.keys(VERDICT_MOVES).sort()).toEqual(
      Object.keys(CONSENT_VERDICT_PARAM_NAMES).sort(),
    );
    for (const [functionName, params] of Object.entries(
      CONSENT_VERDICT_PARAM_NAMES,
    )) {
      const moves = VERDICT_MOVES[functionName];
      expect(Object.keys(moves).sort(), functionName).toEqual(
        [...params].sort(),
      );
      for (const [param, move] of Object.entries(moves))
        expect(move(), `${functionName}.${param}`).toEqual([true, false]);
    }
  });
});

// --- pipelineAlwaysDrops rescue equivalence ----------------------------------

describe("pipelineAlwaysDrops rescue equivalence", () => {
  // pipelineAlwaysDrops rescues a dropped value through the shared predicate,
  // whose position half -- some earlier step can empty the value -- is inert on
  // that path: every rescue the loop reaches already has an emptying step ahead
  // of it. This sweep is what holds that claim, rather than a comment asserting
  // it. Each pipeline the alphabet below spells goes through the shipped function
  // and through a rescue testing the declared default alone, and any pipeline
  // whose verdicts differ is reported.
  //
  // Two changes make it red, both wanting a fresh look at the rescue. A THIRD
  // source of `dropped` -- a value-independent drop the two below do not carry --
  // would reach the rescue from a position the weaker rescue does not model. And
  // allowlisting a function that sets `dropped` withholds the position half from
  // a coalesce that would otherwise rescue, turning a live pipeline into a dead
  // one on the consent surface. Allowlisting a function that never sets
  // `dropped` leaves this sweep green; that misclassification is the
  // value-emptying classification test's to catch.
  const FALLBACK_DEFAULT = "ZZZ_FALLBACK";

  // The rescue with no position half: the declared default's shape alone. The
  // rescue is what this compares, so the DROP sources are held equal -- the
  // measured substring run and the degenerate declared window are asked of core,
  // whose readings of them are not what is under test, while the rest is a local
  // transcription rather than a call into the shipped predicate, which would
  // compare it to itself.
  const dropsUnderDefaultShapeRescue = (
    steps: ReadonlyArray<TransformStep>,
  ): boolean => {
    let dropped = false;
    for (const [index, step] of steps.entries()) {
      if (step.function === "coalesce") {
        if (dropped && typeof step.params?.default === "string")
          dropped = false;
        continue;
      }
      if (dropped) continue;
      if (
        (step.function === "parse_date" &&
          parseDateInputDropsEveryRecord(step.params)) ||
        (step.function === "substring" &&
          substringWindowDropsEveryValue(step.params)) ||
        substringRunDropsEveryParsedDate(steps, index)
      )
        dropped = true;
    }
    return dropped;
  };

  // Every function core knows, bare, plus the parse_date and coalesce shapes the
  // two formulations turn on: a wire step's params are z.unknown(), so the
  // non-string and null spellings are reachable from a partner's terms.
  const ALPHABET: ReadonlyArray<TransformStep> = [
    ...STANDARDIZATION_FUNCTION_NAMES.map((fn) => ({ function: fn })),
    { function: "parse_date", params: {} },
    { function: "parse_date", params: { inputFormat: "MM/DD" } },
    { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
    { function: "parse_date", params: { inputFormat: null } },
    { function: "parse_date", params: { inputFormat: 42 } },
    { function: "coalesce", params: {} },
    { function: "coalesce", params: { default: FALLBACK_DEFAULT } },
    { function: "coalesce", params: { default: 42 } },
    { function: "coalesce", params: { default: null } },
    { function: "not_a_real_function" },
  ];
  const MAX_PIPELINE_LENGTH = 4;

  const forEachPipeline = (
    visit: (pipeline: TransformStep[]) => void,
  ): void => {
    const extend = (prefix: TransformStep[]): void => {
      if (prefix.length === MAX_PIPELINE_LENGTH) return;
      for (const step of ALPHABET) {
        const pipeline = [...prefix, step];
        visit(pipeline);
        extend(pipeline);
      }
    };
    extend([]);
  };

  test("the position half withholds no rescue the prior formulation makes", () => {
    const divergent: string[] = [];
    let examined = 0;
    let deadVerdicts = 0;
    forEachPipeline((pipeline) => {
      examined += 1;
      const drops = pipelineAlwaysDrops(pipeline);
      if (drops) deadVerdicts += 1;
      if (drops !== dropsUnderDefaultShapeRescue(pipeline))
        divergent.push(JSON.stringify(pipeline));
    });
    // Two assertions so a failure carries witnesses as well as its scale: the
    // whole divergent list is elided in the diff once it runs to thousands.
    expect(divergent.slice(0, 3)).toEqual([]);
    expect(divergent).toHaveLength(0);
    // Not vacuous: the sweep is the full enumeration and reaches both verdicts.
    const enumeratedPipelines = Array.from(
      { length: MAX_PIPELINE_LENGTH },
      (_, index) => ALPHABET.length ** (index + 1),
    ).reduce((total, count) => total + count, 0);
    expect(examined).toBe(enumeratedPipelines);
    expect(deadVerdicts).toBeGreaterThan(0);
    expect(deadVerdicts).toBeLessThan(examined);
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
  // element-transform one carries partner-authored steps.
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
    // reaching the comparison step is genuinely non-NFC.
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
    // length-sensitive step such as substring then operates on -- the Option-1
    // residual. This is cross-party-safe: the intermediate is deterministic from
    // the NFC-normalized input, so the same logical value authored as NFC
    // (U+0390) vs NFD (U+03B9 U+0308 U+0301) converges before to_upper_case and
    // yields an identical key. substring(1,1) returns the lone leading iota,
    // confirming it sees the non-NFC intermediate.
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
  // Restore the compileLinearRegex spy after every test, even one that throws
  // mid-body: a per-test `spy.mockRestore()` is skipped when an assertion throws,
  // and a vi.spyOn on the still-installed spy returns the same object carrying the
  // failed test's stale call count -- inflating the next test's count (a real
  // regression would then cascade as 50/100/160 instead of clean independent
  // failures). afterEach restores regardless, so each count stands alone.
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

  // The per-element compile-once is a security control, not just a perf win: a
  // hostile-but-schema-valid terms set can carry more distinct patterns than the
  // linear-time engine's own compile cache holds, so per-row recompilation would
  // thrash that cache into an unbounded per-row CPU cost over a large dataset.
  // "Compilation does not happen per row" is therefore a runtime invariant, and a
  // comment asserting it would rot silently; these spy on the compile entry point
  // so the invariant is a check instead. compileLinearRegex is the entry point
  // every regex/parse_date factory calls exactly once at closure-build time, so
  // its call count over a build IS the element-transform compile count.
  //
  // The spy reaches standardization.ts's static `compileLinearRegex` import
  // through Vitest's module transform; under a future native-ESM pool (e.g.
  // `vmForks`) the namespace spy could stop intercepting that binding. The
  // failure mode is safe either way: the first row always compiles exactly once,
  // so a working spy sees >= 1 and a broken one sees 0 -- a 0 count fails these
  // assertions loudly, it never lets a per-row regression pass as green.
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
    // The single-transform tests above pin the bound for one transform across
    // rows; this pins the invariant the security comment actually rests on --
    // total compiles equal the number of DISTINCT element transforms, flat in the
    // row count -- by building several at once. The schema bounds that distinct
    // count (MAX_LINKAGE_ENTRIES * MAX_KEY_ELEMENTS), far below the rows a real
    // dataset carries, which is why per-element rather than per-row compilation is
    // the bound that matters. Mixes regex and parse_date transforms.
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
    // The other compile-count tests use single-step transforms, so they pin "one
    // transform array -> one compile" but not "every STEP of the array compiles
    // once". The WeakMap caches the whole compiled step array under the array's
    // identity, so each regex-bearing step must compile once and be reused across
    // rows. Without this case, a regression that re-ran compileSteps per row only
    // for multi-step arrays (e.g. a `steps.length > 1` carve-out) would pass every
    // single-step test while recompiling up to MAX_TRANSFORM_STEPS (256) patterns
    // per row -- the same fail-open per-row compile cost the control bounds. The
    // real bound is distinct-transforms * regex-steps-per-transform, flat in rows.
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

  test("short row omitting a prototype-member input column reads as absent, not the inherited function", () => {
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
    // The shadowing guard must not swallow a real value: a row carrying a
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

  test("a field carrying several candidates is crossed, one key string each", () => {
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
    // run from the parties' record counts rather than carried by the terms, so a
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
    // disagreeing on case -- which is what the transform is there to settle.
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
    // drop is warned. It is deliberately not a run refusal -- a partner-authored
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
    // The executable form of the claim that the width bound and the assembly cap
    // bind fan-out alone in this build: fuzzy expansion, the other candidate
    // producer, does not expand while APPLIED_SETTINGS.fuzzyComparisons is false,
    // so a fan-out-free row contributes exactly one key string however many fuzzy
    // elements its key declares. Three edit-distance elements over
    // eight-character values would assemble 9 x 9 x 9 = 729 key strings once that
    // gate opens -- over the bound and under the cap -- so this fails there
    // rather than leaving fuzzy's own width behavior to be settled unnoticed.
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
  // records than the terms describe, where carrying the candidate set through
  // reaches the strategy refusal that covers exactly this omission
  // (fanOutReachedMatchingRefusal, pinned at the strategies in psiLink.test.ts).

  test("an unlisted producer over the width bound is carried, not dropped", () => {
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
    // the width this key declares, so it is carried to the strategy that refuses
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

  test("an unlisted producer in an element transform is carried too", () => {
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
    // step's output, before anything downstream carries it.
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
    // The shape carrying no substitution sequence at all: replaceRegexFactory
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
    // declares no transform at all carries its whole value into the key string,
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
    // free text, so the message carries neither: the issue path locates the
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
  // what they carry, because every combination replicates each element's whole
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

  test("a row whose key strings would carry too many bytes is dropped for a declared fan-out", () => {
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
  // live: what a duplicate collapses into is never carried into a key string,
  // and what earlier elements retained is still held when a later one runs.

  test("an amplifying step over a split cell settles as the candidates accumulate", () => {
    // A cell of 1000 comma-separated tokens, split and then amplified twice: no
    // single candidate the first amplification produces is over the per-value
    // ceiling, so nothing fires until the second runs element-wise over all 1000
    // of them -- and its outputs accumulate into one set the ceiling reads only
    // once the last of them exists. The running total settles the row on the
    // second of them instead. A declared producer is what expanded the values
    // the amplifier is running over, so the row is dropped for this key even
    // though the step charging the crossing is the amplifier.
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

  test("an element transform amplifying each of a field's values settles as they accumulate", () => {
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
    // so a shared array would carry one compilation into the other listing.
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

    // The same shape refused, which is the other fate this seam takes: the
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
    // values, each carrying 2000 characters the row would have to hold if they
    // survived, mapped by a digit-stripping step onto four candidates. The four
    // are what the row assembles and what the total charges.
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

  // --- the declared fan-out's fate at the accumulating seam ------------------
  // Dropping an over-bound row is normative for the DECLARED fan-out producers
  // (docs/spec/PROTOCOL.md, Fan-out matching), and the accumulating limb takes
  // that fate at both its charges for a key whose multiplicity only they can
  // realize. The fate is read from the key's compiled steps before any element
  // runs, so a crossing keeps the refusal where a producer OUTSIDE the list can
  // expand the key, and where none can expand it at all.

  // A cell of distinct single-character tokens, each amplified to 1,939
  // characters and then split on a separator the amplifier itself wrote, keeping
  // the original -- which is what makes a split RETAIN more than it was handed.
  // Each candidate charges its own 1,939 characters plus the 969 of the part
  // carrying its token, 2,908 in all, and the shared prefix and suffix parts
  // land once for 968 more: at 1,442 tokens the element accumulates exactly
  // MAX_ASSEMBLED_KEY_LENGTH_PER_ROW, and each further token is 2,908 past it.
  // The last step collapses every candidate onto one string, so a row that
  // survives the seam assembles one key string rather than meeting the count cap
  // -- which is what a row exactly at the cap has to do to be accepted, the cap
  // being the count cap times the per-value ceiling.
  const tokenCell = (tokens: number) =>
    Array.from({ length: tokens }, (_unused, i) =>
      String.fromCodePoint(0x4e00 + i),
    ).join(",");

  const collapsedCandidate = "x".repeat(MAX_TRANSFORM_PARAM_LENGTH);

  // Built fresh per call: the compiled steps capture their fan-out membership,
  // so a shared array would carry one compilation into the other listing.
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
  // MAX_ASSEMBLED_KEY_LENGTH_PER_ROW, so the 1025th carries the row 4,096
  // characters past it. Splitting those candidates between the key's two
  // elements or holding them all in the first is what moves the crossing across
  // the seam the fate turns on.
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
    // whole point of settling it before the elements run.
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
  // from the first element to the last and across the seam between the two
  // charges; none of that reaches the fate.

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
  // aggregate in buildKeyStrings; an element carrying the expansion in its own
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
    // The fail-closed backstop under the classification. A step that expands a
    // value while unlisted cannot reach a key classified for the drop -- the
    // classification would have refused for it -- so this pairing is what a
    // Set-returning function left out of the multi-value classification would
    // produce, and it settles on the refusal rather than dropping a row whose
    // fan-out nothing declared.
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
    // The premise: this row is excluded at the first element, so the second
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
    // The converse of the drift test above, and the direction that carries the
    // classification's guarantee: a function able to return several candidates
    // for one value, left out of the classification, leaves the keys it feeds
    // classified as producing no multiplicity, and the runtime backstop catches
    // that only where the expansion lands before the row's crossing.
    //
    // One step per name core admits, with params that let the function do its
    // job, driven alone over values chosen so a function able to expand one
    // value into several does so for at least one of them. Every name carries
    // an entry, including the functions taking no params, so a function added
    // to the registry is given probe params here rather than driven paramless
    // past the witness below.
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
    // default rather than a fate a row reaches (docs/spec/CHANNEL_SECURITY.md):
    // nothing expands a value there, so what holds such a key is the per-value
    // ceiling on each element it carries, and the most one row can accumulate
    // under it is that ceiling once per element -- at most MAX_KEY_ELEMENTS of
    // them, which is where the terms schema bounds a key. Driven rather than
    // computed, so an edit to the ceiling or to the row's key-string cap, both
    // module-private, moves this row instead of leaving it pinned to a stale
    // arithmetic identity.
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
    // One key string carrying every element's whole value: the row was neither
    // refused, which is the fate a crossing takes for such a key, nor dropped.
    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toHaveLength(MAX_KEY_ELEMENTS * largestCarried);
  });

  test("the accumulation drop signal reaches no caller", () => {
    // It is a plain Error whose message reports no fault an operator could act
    // on, raised only to stop an expansion that is already settled. Unexported,
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
    // The one partner-authored text on these paths, at the one sink that carries
    // it: a name carrying CR/LF for log-line spoofing, an ESC that drives ANSI,
    // and a bidi override reaches the operator escaped rather than raw.
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

    // The cross-product advisory, the other sink on this path that carries the
    // name: an unlisted producer's row is not dropped for width, so it is warned
    // about instead.
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
  // and the position that declares it are different ones there. The fixtures
  // below declare a transform on ONE position of the pair, which is what tells
  // the two positions apart in a refusal's issue path; the terms schema binds an
  // authored pair to one transform, so this is a locator fixture rather than an
  // admissible document, and these cases hold this layer's attribution honest
  // for whatever key it is handed.

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

// --- validateStandardizationAgainstTerms -------------------------------------

describe("validateStandardizationAgainstTerms", () => {
  test("valid standardization returns no errors", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(
      validateStandardizationAgainstTerms(standardization, minimalTerms),
    ).toEqual([]);
  });

  test("unknown output field is reported", () => {
    const standardization = [{ output: "nonexistent_field", input: "X" }];
    const errors = validateStandardizationAgainstTerms(
      standardization,
      minimalTerms,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/nonexistent_field/);
  });

  test("unknown function name is reported", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "does_not_exist" }],
      },
    ];
    const errors = validateStandardizationAgainstTerms(
      standardization,
      minimalTerms,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does_not_exist/);
  });

  test("coalesce is not reported as unknown", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "coalesce", params: { default: "UNKNOWN" } }],
      },
    ];
    expect(
      validateStandardizationAgainstTerms(standardization, minimalTerms),
    ).toEqual([]);
  });

  // The output/function names are interpolated raw into the returned messages,
  // which assertStandardizationMatchesTerms composes into a
  // StandardizationTermsError; a control character in a name must reach the
  // operator only in its escaped form, and that escape happens once where the
  // error is rendered. Asserted THERE, never on the raw message: a raw assertion
  // would pass equally on a value escaped twice, which is what this convention
  // exists to catch. ASCII-only names (the other cases here) are a no-op for the
  // escape, so they cannot pin this -- these two do.
  const renderedRefusal = (
    standardization: Standardization,
    terms: LinkageTerms,
  ): string =>
    sanitizeErrorForDisplay(
      ((): unknown => {
        try {
          assertStandardizationMatchesTerms(standardization, terms);
        } catch (err) {
          return err;
        }
        throw new Error("expected assertStandardizationMatchesTerms to throw");
      })(),
    );

  test("an output name with a control character is escaped in the message", () => {
    const raw = "last\u0000name"; // a null byte; not a declared field name
    const rendered = renderedRefusal(
      [{ output: raw, input: "X" }],
      minimalTerms,
    );
    // The membership test used the raw value (so it was correctly flagged), but
    // the operator sees only the escaped form, never the raw control character.
    expect(rendered).not.toContain(raw);
    expect(rendered).toContain(sanitizeForDisplay(raw));
  });

  test("an unknown function name with a control character is escaped in the message", () => {
    const raw = "bad\u0000fn"; // a null byte; not a known function name
    const rendered = renderedRefusal(
      [{ output: "last_name", input: "LN", steps: [{ function: raw }] }],
      minimalTerms,
    );
    expect(rendered).not.toContain(raw);
    expect(rendered).toContain(sanitizeForDisplay(raw));
  });

  // The reachability the OperatorConfigError doc rests on: the accept side derives
  // its standardization from the (partner-authored) adopted terms via
  // getDefaultStandardization, whose outputs are exactly those terms' field names --
  // so the derived spec is consistent with the terms by construction, and this
  // fail-closed error (whose message the web surfaces) is unreachable on the accept
  // side. A partner-chosen field name therefore cannot reach the operator's alert
  // through it. Pin that with a hostile name that WOULD be alarming if surfaced.
  test("getDefaultStandardization is consistent with the terms it derives from, even for a hostile field name", () => {
    const hostileName = "call 1-800-EVIL now";
    const hostileTerms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: hostileName, type: "first_name" }],
      linkageKeys: [{ name: "k", elements: [{ field: hostileName }] }],
    };
    const md: Metadata = [
      { name: "c", type: "first_name", role: "linkage", isPayload: false },
    ];
    const std = getDefaultStandardization(md, hostileTerms);
    expect(validateStandardizationAgainstTerms(std, hostileTerms)).toEqual([]);
  });
});

describe("assertStandardizationMatchesTerms", () => {
  test("throws StandardizationTermsError, carrying the inconsistency, on a contradiction", () => {
    const standardization = [{ output: "nonexistent_field", input: "X" }];
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).toThrow(StandardizationTermsError);
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).toThrow(/nonexistent_field/);
  });

  test("is a no-op on a standardization consistent with its terms", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).not.toThrow();
  });
});

describe("assertFanOutImplemented", () => {
  const fanOutStep = { function: "split_on", params: { delimiter: "-" } };
  const elementFanOutKeys: LinkageTerms["linkageKeys"] = [
    {
      name: "LN+DOB",
      elements: [
        { field: "last_name", transform: [fanOutStep] },
        { field: "date_of_birth" },
      ],
    },
  ];

  test("refuses a standardization declaring a fan-out step, naming it", () => {
    // A standardization is only ever this party's own -- no invitation carries
    // one, and the derived default declares no fan-out step -- so the refusal is
    // an OperatorConfigError, which both front ends surface as the actionable
    // config category.
    const standardization = [
      { output: "last_name", input: "LN", steps: [fanOutStep] },
    ];
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).toThrow(OperatorConfigError);
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).toThrow(/split_on/);
  });

  test("refuses a linkage-key element transform declaring a fan-out step", () => {
    // The element transform is adopted verbatim from the partner's invitation on
    // the accept path, so this half stays a plain UsageError: not provably this
    // operator's own content, and its message stays swallowed by the generic
    // alert.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: elementFanOutKeys,
    };
    expect(() => assertFanOutImplemented(terms)).toThrow(UsageError);
    expect(() => assertFanOutImplemented(terms)).toThrow(/split_on/);
    expect(() => assertFanOutImplemented(terms)).not.toThrow(
      OperatorConfigError,
    );
  });

  test("admits both authoring surfaces under single-pass, the strategy that matches a candidate set", () => {
    // The narrowed rule's other half: fan-out matching is specified for
    // single-pass alone (docs/spec/PROTOCOL.md, Fan-out runs under single-pass
    // only), so the same two configurations the cascade refuses above run there.
    const singlePassTerms: LinkageTerms = {
      ...minimalTerms,
      linkageStrategy: "single-pass",
    };
    const standardization = [
      { output: "last_name", input: "LN", steps: [fanOutStep] },
    ];
    expect(() =>
      assertFanOutImplemented(singlePassTerms, standardization),
    ).not.toThrow();
    expect(() =>
      assertFanOutImplemented({
        ...singlePassTerms,
        linkageKeys: elementFanOutKeys,
      }),
    ).not.toThrow();
  });

  test("refuses a strategy this build does not recognize, rather than admitting it", () => {
    // An allowlist, not a cascade-named denylist: a strategy added to the schema
    // refuses a fan-out until it too realizes one. Cast because no such member
    // exists yet -- which is the case this pins.
    const futureStrategyTerms = {
      ...minimalTerms,
      linkageStrategy: "two-pass",
      linkageKeys: elementFanOutKeys,
    } as unknown as LinkageTerms;
    expect(() => assertFanOutImplemented(futureStrategyTerms)).toThrow(
      UsageError,
    );
  });

  test("the refusal names the strategy rule and the two ways out of it", () => {
    // What an operator does about it: agree single-pass terms, or drop the step.
    // Neither remedy is derivable from the function name alone, so both are
    // pinned rather than left to the message's shape.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: elementFanOutKeys,
    };
    expect(() => assertFanOutImplemented(terms)).toThrow(/single-pass/);
    expect(() => assertFanOutImplemented(terms)).toThrow(
      /Agree linkage terms whose linkage_strategy is single-pass/,
    );
    expect(() => assertFanOutImplemented(terms)).toThrow(
      /remove the "split_on" step/,
    );
  });

  test("covers every function that fans out, not the literal split_on alone", () => {
    // The refusal reads FAN_OUT_FUNCTION_NAMES, so a fan-out function added there
    // is refused with no second edit here.
    for (const name of FAN_OUT_FUNCTION_NAMES) {
      const standardization = [
        { output: "last_name", input: "LN", steps: [{ function: name }] },
      ];
      expect(() =>
        assertFanOutImplemented(minimalTerms, standardization),
      ).toThrow(UsageError);
    }
  });

  test("is a no-op on transforms that declare no fan-out step", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).not.toThrow();
    expect(() => assertFanOutImplemented(minimalTerms)).not.toThrow();
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
    // protects an ignored column now protects payload/identifier, so a column the
    // operator marked sent-to-partner is never dragged onto the match axis.
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

// --- getDefaultLinkageTerms: role: ignored -----------------------------------

describe("getDefaultLinkageTerms — ignored columns", () => {
  const linkageCol = (
    name: string,
    type: ColumnMetadata["type"],
  ): ColumnMetadata => ({ name, type, role: "linkage", isPayload: false });

  test("a type supplied only by an ignored column is excluded from the keys", () => {
    // ssn is present in the input but marked ignored; every other linkage type is
    // a normal linkage column. No surviving key may reference ssn/ssn4, and ssn
    // must not appear among the derived linkage fields.
    const metadata: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "ignored", isPayload: false },
      linkageCol("FN", "first_name"),
      linkageCol("LN", "last_name"),
      linkageCol("DOB", "date_of_birth"),
    ];
    const terms = getDefaultLinkageTerms("Agency A", metadata);

    const referencesSsn = terms.linkageKeys.some((k) =>
      k.elements.some((el) => el.field === "ssn" || el.field === "ssn4"),
    );
    expect(referencesSsn).toBe(false);
    expect(terms.linkageFields.some((f) => f.name === "ssn")).toBe(false);
    // The pure-name key (LN + FN + DOB) needs no ssn, so it still survives.
    expect(terms.linkageKeys.length).toBeGreaterThan(0);
  });

  test("marking a type ignored drops the keys an equivalent linkage column would keep", () => {
    const base: ColumnMetadata[] = [
      linkageCol("FN", "first_name"),
      linkageCol("LN", "last_name"),
      linkageCol("DOB", "date_of_birth"),
    ];
    const withSsnLinkage = getDefaultLinkageTerms("Agency A", [
      linkageCol("SSN", "ssn"),
      ...base,
    ]);
    const withSsnIgnored = getDefaultLinkageTerms("Agency A", [
      { name: "SSN", type: "ssn", role: "ignored", isPayload: false },
      ...base,
    ]);
    expect(withSsnIgnored.linkageKeys.length).toBeLessThan(
      withSsnLinkage.linkageKeys.length,
    );
  });
});

// --- unsatisfiedLinkageFields ------------------------------------------------

// Fixture: columns that cover first_name, last_name, date_of_birth, ssn.
const FULL_COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const fullTerms = getDefaultLinkageTerms(
  "Agency A",
  inferMetadata(FULL_COLUMNS),
);

describe("unsatisfiedLinkageFields", () => {
  test("names the fields whose type no input column provides", () => {
    const unsatisfied = unsatisfiedLinkageFields(["first_name"], fullTerms);
    const names = unsatisfied.map((f) => f.name).sort();
    expect(names).toContain("last_name");
    expect(names).toContain("date_of_birth");
    expect(names).toContain("ssn");
    expect(names).not.toContain("first_name");
  });

  test("a column of the right type but different name still satisfies", () => {
    // `fname` and `dob` are aliases inferred as first_name / date_of_birth.
    const unsatisfied = unsatisfiedLinkageFields(
      ["fname", "lname", "dob", "ssn"],
      fullTerms,
    );
    expect(unsatisfied).toEqual([]);
  });

  test("an explicit standardization mapping a present role:linkage column satisfies a field its type does not", () => {
    // `tax_id` is not inferred as ssn; an explicit mapping makes it so, but only
    // when the column is roled `linkage`. With name-inferred metadata `tax_id`
    // infers as `role: identifier`, so the mapping is refused (role wins) and ssn
    // stays unsatisfiable; roling it `linkage` in explicit metadata satisfies it.
    const columns = ["first_name", "last_name", "dob", "tax_id"];
    expect(
      unsatisfiedLinkageFields(columns, fullTerms, [
        { output: "ssn", input: "tax_id" },
      ]).map((f) => f.name),
    ).toContain("ssn");
    expect(
      unsatisfiedLinkageFields(
        columns,
        fullTerms,
        [{ output: "ssn", input: "tax_id" }],
        [
          {
            name: "first_name",
            type: "first_name",
            role: "linkage",
            isPayload: false,
          },
          {
            name: "last_name",
            type: "last_name",
            role: "linkage",
            isPayload: false,
          },
          {
            name: "dob",
            type: "date_of_birth",
            role: "linkage",
            isPayload: false,
          },
          { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
        ],
      ),
    ).toEqual([]);
  });

  test("an explicit standardization with an absent input preempts the type fallback", () => {
    // The config maps ssn from `tax_id` (absent) even though an `ssn` column is
    // present. The explicit mapping preempts the type fallback, so ssn is still
    // unsatisfiable -- the exchange would bind it to the missing column.
    const unsatisfied = unsatisfiedLinkageFields(
      ["first_name", "last_name", "dob", "ssn"],
      fullTerms,
      [{ output: "ssn", input: "tax_id" }],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("explicit metadata types the fallback, satisfying a field a column name would not infer", () => {
    // `tax_id` does not infer to ssn, but the config's metadata types it as ssn --
    // the exchange resolves the type fallback against that metadata, so ssn is
    // producible.
    const columns = ["first_name", "last_name", "dob", "tax_id"];
    expect(
      unsatisfiedLinkageFields(columns, fullTerms, undefined, [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
      ]),
    ).toEqual([]);
  });

  test("explicit metadata that retypes a present column away makes its field unsatisfiable", () => {
    // The `ssn` column would infer to ssn, but the config retypes it to `other`, so
    // the exchange produces no ssn values; the check follows the metadata, not the
    // name, and reports ssn unsatisfiable.
    const columns = ["first_name", "last_name", "dob", "ssn"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "ssn", type: "other", role: "payload", isPayload: true },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("metadata declaring a column absent from the input does not count as coverage", () => {
    // The metadata describes an `ssn` column, but the actual input lacks it (a CSV
    // swapped since the config was written). The exchange would read no values for
    // that column, so the type fallback must not treat ssn as covered -- the present
    // restriction is what prevents stale metadata from masking the gap.
    const columns = ["first_name", "last_name", "dob"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("an absent same-typed metadata column ordered before a present one is unsatisfiable", () => {
    // Two ssn-typed columns, the absent one listed first. The exchange binds the
    // field to the FIRST match (getDefaultStandardization / buildStandardizedDataset
    // both use metadata.find) and reads that absent column, producing nothing -- so
    // the check must follow the same first-match selection and not merely ask whether
    // any same-typed column is present.
    const columns = ["first_name", "last_name", "dob", "present_ssn"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "absent_ssn", type: "ssn", role: "linkage", isPayload: false },
        { name: "present_ssn", type: "ssn", role: "linkage", isPayload: false },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });
});

describe("assessLinkageSatisfiability", () => {
  test("a full input satisfies every field and every key", () => {
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      fullTerms,
    );
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(fullTerms.linkageKeys.length);
  });

  test("an input covering no complete key reports zero satisfiable keys", () => {
    // Only first_name is present. Every default key has at least one other
    // required field (ssn, last_name, or date_of_birth), so no key can match.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["first_name"],
      fullTerms,
    );
    expect(satisfiableKeyCount).toBe(0);
    const names = unsatisfied.map((f) => f.name);
    expect(names).toContain("ssn");
    expect(names).toContain("last_name");
    expect(names).toContain("date_of_birth");
  });

  test("an input missing one field keeps the keys that do not need it", () => {
    // No ssn column, but first/last name and dob are present. Keys that require
    // ssn become unsatisfiable; the name+dob keys survive, so the count is
    // positive but short of the declared total.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["last_name", "first_name", "dob"],
      fullTerms,
    );
    expect(unsatisfied.map((f) => f.name)).toEqual(["ssn"]);
    expect(satisfiableKeyCount).toBeGreaterThan(0);
    expect(satisfiableKeyCount).toBeLessThan(fullTerms.linkageKeys.length);
  });

  // Built without metadata so it keeps every default key -- including the ssn4
  // keys and the swap key -- that the type-filtered `fullTerms` fixture drops.
  const allKeyTerms = getDefaultLinkageTerms("Agency A");

  test("an ssn column does not satisfy an ssn4 field (distinct semantic types)", () => {
    // The full default terms reference both ssn and ssn4. An `ssn` column infers
    // as ssn only, never ssn4, so ssn4 stays unsatisfiable -- matching runtime,
    // where the absence of an ssn4-typed column collapses the ssn4 keys.
    const { unsatisfied } = assessLinkageSatisfiability(
      ["first_name", "last_name", "dob", "ssn"],
      allKeyTerms,
    );
    const names = unsatisfied.map((f) => f.name);
    expect(names).toContain("ssn4");
    expect(names).not.toContain("ssn");
  });

  test("a swap key is assessed by its element fields, so an absent swapped field excludes it", () => {
    // The default terms include "swap(LN, FN) + DOB". swap only permutes which
    // slot holds which field at receive time; it does not change which fields the
    // key needs. With first_name absent, the swap key references an unproducible
    // field and must be excluded from the satisfiable count, identically to the
    // non-swap LN+FN+DOB key.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["last_name", "dob", "ssn"],
      allKeyTerms,
    );
    const unsatNames = new Set(unsatisfied.map((f) => f.name));
    expect(unsatNames.has("first_name")).toBe(true);
    // ssn+last_name+dob keys survive, so this is a partial (warn) case, proving the
    // swap key's exclusion is not just the whole set collapsing to zero.
    expect(satisfiableKeyCount).toBeGreaterThan(0);
    expect(satisfiableKeyCount).toBeLessThan(allKeyTerms.linkageKeys.length);
    const swapKey = allKeyTerms.linkageKeys.find((k) => k.swap !== undefined);
    expect(swapKey).toBeDefined();
    if (swapKey === undefined) return;
    // The detector reads e.field on the stored (unswapped) elements; the swap key
    // needs first_name, which is unsatisfiable, so it is correctly excluded.
    expect(swapKey.elements.some((e) => unsatNames.has(e.field))).toBe(true);
  });

  test("a key referencing an undeclared field is unsatisfiable even when no declared field is missing", () => {
    // The schema does not require a key element's `field` to name a declared
    // linkage field. A key referencing an undeclared field resolves to no values
    // at exchange time (buildStandardizedDataset only builds declared fields), so
    // it must be counted unsatisfiable -- otherwise an incoherent or hostile terms
    // set defeats the block and runs to a silent empty result. Build such terms by
    // dropping ssn from the declared fields while keeping the keys that use it.
    const base = getDefaultLinkageTerms(
      "Agency A",
      inferMetadata(FULL_COLUMNS),
    );
    const keysUsingSsn = base.linkageKeys.filter((k) =>
      k.elements.some((e) => e.field === "ssn"),
    ).length;
    expect(keysUsingSsn).toBeGreaterThan(0);
    const undeclaredTerms: LinkageTerms = {
      ...base,
      linkageFields: base.linkageFields.filter((f) => f.name !== "ssn"),
    };
    // FULL_COLUMNS carries an ssn column, so no DECLARED field is unproducible...
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      undeclaredTerms,
    );
    expect(unsatisfied).toEqual([]);
    // ...yet the keys that reference the now-undeclared ssn are excluded.
    expect(satisfiableKeyCount).toBe(base.linkageKeys.length - keysUsingSsn);
    expect(satisfiableKeyCount).toBeLessThan(base.linkageKeys.length);
  });

  test("terms whose every key references an undeclared field report zero satisfiable keys (the block signal)", () => {
    // The strong form of the above: if all keys reference undeclared fields, the
    // count is 0 and the caller blocks, even though `unsatisfied` (declared but
    // unproducible) is empty.
    const base = getDefaultLinkageTerms(
      "Agency A",
      inferMetadata(FULL_COLUMNS),
    );
    const firstNameField = base.linkageFields.find(
      (f) => f.name === "first_name",
    );
    expect(firstNameField).toBeDefined();
    if (firstNameField === undefined) return;
    const phantomTerms: LinkageTerms = {
      ...base,
      linkageFields: [firstNameField],
      linkageKeys: [{ name: "needs ssn", elements: [{ field: "ssn" }] }],
    };
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      phantomTerms,
    );
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(0);
  });
});

// --- assessLinkageSatisfiability: dead keys (self-defeating standardization) --

describe("assessLinkageSatisfiability dead keys", () => {
  // A single date_of_birth field bound to a present "dob" column, so the key is
  // always SHAPE-satisfiable; the element transform decides whether it is dead.
  const dobTerms = (
    transform?: LinkageKeyElement["transform"],
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "dob", type: "date_of_birth" }],
    linkageKeys: [
      {
        name: "DOB",
        elements: [{ field: "dob", ...(transform && { transform }) }],
      },
    ],
  });
  const columns = ["dob"];

  test("a parse_date element transform whose input omits a component is a dead key", () => {
    // input_format "MM/DD" (no year): core's parseDateFactory requires all of
    // YYYY/MM/DD, so it drops every record -- the key can never match.
    const { unsatisfied, satisfiableKeyCount, deadKeys } =
      assessLinkageSatisfiability(
        columns,
        dobTerms([
          { function: "parse_date", params: { inputFormat: "MM/DD" } },
        ]),
      );
    // The column is present, so the field is satisfiable and the key passes the
    // column-SHAPE verdict -- the silent gap this fills: the count alone reads
    // all-clear.
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(1);
    // ...yet the key is reported dead.
    expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
  });

  test("the real builder also produces no key string for that element (differential)", () => {
    // Pin the detector's "dead" verdict against an actual builder run, so a future
    // parse_date change that the predicate fails to mirror turns red here rather
    // than silently letting a silent-empty config through.
    const terms = dobTerms([
      { function: "parse_date", params: { inputFormat: "MM/DD" } },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/1990" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toBeNull();
  });

  test("a non-string parse_date input format is a dead key, without crashing the check", () => {
    // Wire params are z.unknown(), so a partner can supply a non-string input
    // format. None yields a value at runtime (every non-string tokenizes to an
    // all-dropping pattern), so each is dead -- and assessLinkageSatisfiability
    // must report it without ever tokenizing the non-string itself.
    for (const inputFormat of [5, true, ["MM"], { x: 1 }]) {
      const { deadKeys } = assessLinkageSatisfiability(
        columns,
        dobTerms([{ function: "parse_date", params: { inputFormat } }]),
      );
      expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
    }
  });

  test("the builder also drops every record for a non-string input format (differential)", () => {
    for (const inputFormat of [5, ["MM"], { x: 1 }, true]) {
      const terms = dobTerms([
        { function: "parse_date", params: { inputFormat } },
      ]);
      const dataset = buildStandardizedDataset(
        undefined,
        [{ dob: "01/15/1990" }],
        inferMetadata(columns),
        terms,
      );
      expect(
        buildKeyStrings(terms.linkageKeys[0], dataset, 0),
        JSON.stringify(inputFormat),
      ).toBeNull();
    }
  });

  test("a complete parse_date input format is not a dead key", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a bare parse_date (defaulted complete input) is not a dead key", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([{ function: "parse_date" }]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a two-digit-year parse_date element transform is not a dead key", () => {
    // The YY token supplies the year component, so the format tokenizes a full
    // date and the key is not self-defeating.
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD/YY" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a YY parse_date in a key ELEMENT transform resolves via the fixed constant (differential)", () => {
    const terms = dobTerms([
      {
        function: "parse_date",
        params: { inputFormat: "MM/DD/YY", outputFormat: "YYYYMMDD" },
      },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/90" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toEqual(
      new Set(["19900115"]),
    );
  });

  test("the builder produces a key string for a two-digit-year format (differential)", () => {
    // Pin the "not dead" verdict for MM/DD/YY against an actual builder run: a
    // two-digit-year DOB column yields a non-empty key on the default path.
    const terms = dobTerms([
      { function: "parse_date", params: { inputFormat: "MM/DD/YY" } },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/90" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).not.toBeNull();
  });

  test("a later coalesce default rescues a dead parse_date to a constant (not dead)", () => {
    // The element yields the constant "X" for every row -- a producible, if
    // low-cardinality, key the linkage layer treats as benign, so it is not dead.
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD" } },
        { function: "coalesce", params: { default: "X" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a coalesce with no string default does not rescue a dead parse_date", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD" } },
        { function: "coalesce" },
      ]),
    );
    expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
  });

  test("a shape-unsatisfiable key is not double-reported as dead", () => {
    // The column is absent, so the key fails the SHAPE verdict (satisfiableKeyCount
    // 0); even with a dead element transform it is surfaced by the count, not also
    // listed in deadKeys, which is scoped to shape-satisfiable keys.
    const { satisfiableKeyCount, deadKeys } = assessLinkageSatisfiability(
      ["other_column"],
      dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
    );
    expect(satisfiableKeyCount).toBe(0);
    expect(deadKeys).toEqual([]);
  });

  test("the recommended default setup reports no dead keys", () => {
    // The default date_of_birth parse_date lives in the field standardization with
    // a complete input, and the default keys carry no element transforms, so no key
    // is dead -- the no-signal-on-the-default-setup guarantee.
    const { deadKeys } = assessLinkageSatisfiability(FULL_COLUMNS, fullTerms);
    expect(deadKeys).toEqual([]);
  });

  test("a predicate-dead parse_date yields no key across a generated input-format corpus (differential)", () => {
    const permute = (a: string[]): string[][] =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) =>
            permute([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [
              x,
              ...p,
            ]),
          );
    const subsets: string[][] = [
      [],
      ["YYYY"],
      ["MM"],
      ["DD"],
      ["YYYY", "MM"],
      ["YYYY", "DD"],
      ["MM", "DD"],
      ["YYYY", "MM", "DD"],
    ];
    const formats = new Set<string>(["", "x", "---", "12"]);
    for (const subset of subsets)
      for (const ordering of permute(subset))
        for (const sep of ["", "-", "/", ".", " "])
          formats.add(ordering.join(sep));

    for (const inputFormat of formats) {
      const terms = dobTerms([
        { function: "parse_date", params: { inputFormat } },
      ]);
      const { deadKeys } = assessLinkageSatisfiability(columns, terms);
      // A format the detector does NOT call dead may legitimately produce a value
      // (data-dependent), which the detector deliberately ignores -- skip it.
      if (deadKeys.length === 0) continue;
      // A value shaped to the declared format, plus other shapes: a dead format
      // must yield no key for ANY of them.
      const shaped = inputFormat
        .replaceAll("YYYY", "2025")
        .replaceAll("MM", "01")
        .replaceAll("DD", "15");
      for (const value of [shaped, "2025", "01", "15", "20250115", "", "x"]) {
        const dataset = buildStandardizedDataset(
          undefined,
          [{ dob: value }],
          inferMetadata(columns),
          terms,
        );
        expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toBeNull();
      }
    }
  });

  // A `substring` whose declared bounds open no window is dead on the bounds
  // alone -- no `parse_date` layout ahead of it, which is the only shape the
  // measured substring-run reading covers.
  //
  // The first six are what the terms schema ADMITS, so they are the ones that
  // reach a minted invitation: the bounds an operator leaves unset or clears
  // mid-edit, and the two zeroes its integer refine cannot express. The last
  // three the schema rejects at parse; they are kept because this grading also
  // runs over terms not built through that schema, the same defense-in-depth
  // `decideLinkageTermsVerdict` keeps for an undeclared field reference.
  const DEGENERATE_WINDOWS: ReadonlyArray<
    [string, Record<string, unknown> | undefined]
  > = [
    ["no params at all", undefined],
    ["empty params", {}],
    ["start unset", { length: 5 }],
    ["length unset", { start: 3 }],
    ["start of 0", { start: 0, length: 5 }],
    ["length of 0", { start: 3, length: 0 }],
    ["fractional start", { start: 1.5, length: 5 }],
    ["string start", { start: "3", length: 5 }],
    ["null length", { start: 3, length: null }],
  ];

  test("a substring whose bounds open no window is a dead key", () => {
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const terms = dobTerms([
        { function: "substring", ...(params !== undefined && { params }) },
      ]);
      const { unsatisfied, satisfiableKeyCount, deadKeys } =
        assessLinkageSatisfiability(columns, terms);
      // The column is present, so the field is satisfiable and the key passes
      // the column-SHAPE verdict -- the silent gap this fills.
      expect([label, unsatisfied]).toEqual([label, []]);
      expect([label, satisfiableKeyCount]).toEqual([label, 1]);
      expect([label, deadKeys.map((k) => k.name)]).toEqual([label, ["DOB"]]);
    }
  });

  test("the builder produces no key string for those bounds, whatever the value (differential)", () => {
    // Pin each "dead" verdict against actual builder runs over values of every
    // length a window under these bounds could open at, so a future change to
    // the slicing convention that the predicate fails to mirror turns red here
    // rather than silently minting terms that match nothing.
    const rows = Array.from({ length: 40 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const key: LinkageKey = {
        name: "DOB",
        elements: [
          {
            field: "dob",
            transform: [
              {
                function: "substring",
                ...(params !== undefined && { params }),
              },
            ],
          },
        ],
      };
      const dataset = new StandardizedDataset(
        [new StandardizedField("dob", "dob", [], rows)],
        [key],
      );
      for (let index = 0; index < rows.length; index++)
        expect([label, index, buildKeyStrings(key, dataset, index)]).toEqual([
          label,
          index,
          null,
        ]);
    }
  });

  test("a substring that reads a window somewhere is not a dead key", () => {
    // The other side of the claim, so the test above is not passing because
    // every substring is called dead: each of these opens a window at some
    // value length, including the negative lengths that count back from the
    // value's end and the window that overshoots every short value, so the drop
    // is the data's to decide and is not claimed.
    const rows = Array.from({ length: 120 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    for (const params of [
      { start: 3, length: 5 },
      { start: 1, length: 1 },
      { start: -2, length: 1 },
      { start: 1, length: -1 },
      { start: -2, length: -1 },
      { start: 3, length: -3 },
      { start: 99, length: 4 },
    ]) {
      const terms = dobTerms([{ function: "substring", params }]);
      const { deadKeys } = assessLinkageSatisfiability(columns, terms);
      expect([params, deadKeys]).toEqual([params, []]);
      // Not vacuous: some value length really does key under these bounds.
      const dataset = new StandardizedDataset(
        [new StandardizedField("dob", "dob", [], rows)],
        terms.linkageKeys,
      );
      const keyed = rows.some(
        (_row, index) =>
          buildKeyStrings(terms.linkageKeys[0], dataset, index) !== null,
      );
      expect([params, keyed]).toEqual([params, true]);
    }
  });

  test("a later coalesce default rescues a degenerate substring window (not dead)", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "substring" },
        { function: "coalesce", params: { default: "X" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("the declared-window verdict matches the builder across a bounds grid (differential)", () => {
    // The verdict reads the slicing convention a second time
    // (substringWindowDropsEveryValue against substringWindow), so this is what
    // holds the two together: every bound pair in the grid, against every value
    // length up to 96 -- comfortably past the |start| + |length| + 1 ceiling any
    // window in this grid can first open at -- and a disagreement in either
    // direction is a failure. Over-claiming would hard-block a producible
    // pipeline at the mint; under-claiming would let one that matches nothing
    // through it.
    const BOUND = 16;
    const rows = Array.from({ length: 97 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    const dataset = new StandardizedDataset(
      [new StandardizedField("dob", "dob", [], rows)],
      [{ name: "DOB", elements: [{ field: "dob" }] }],
    );
    const divergent: string[] = [];
    let claimedDead = 0;
    let pairs = 0;
    for (let start = -BOUND; start <= BOUND; start++) {
      if (start === 0) continue;
      for (let length = -BOUND; length <= BOUND; length++) {
        pairs += 1;
        const params = { start, length };
        const key: LinkageKey = {
          name: "DOB",
          elements: [
            { field: "dob", transform: [{ function: "substring", params }] },
          ],
        };
        const measuredDead = rows.every(
          (_row, index) => buildKeyStrings(key, dataset, index) === null,
        );
        const claimed = substringWindowDropsEveryValue(params);
        if (claimed) claimedDead += 1;
        if (claimed !== measuredDead)
          divergent.push(
            `${JSON.stringify(params)}: claimed=${claimed} measured=${measuredDead}`,
          );
      }
    }
    expect(divergent.slice(0, 3)).toEqual([]);
    expect(divergent).toHaveLength(0);
    // Not vacuous: the grid reaches both verdicts.
    expect(pairs).toBe(2 * BOUND * (2 * BOUND + 1));
    expect(claimedDead).toBeGreaterThan(0);
    expect(claimedDead).toBeLessThan(pairs);
  });
});

// --- decideLinkageTermsVerdict: the grading a run is held to -----------------

describe("decideLinkageTermsVerdict", () => {
  // Two independent keys over two fields, so a case can leave one key short
  // while the other stays live -- the shape the collapsed rule turns on.
  const twoKeyTerms = (
    keyElements: LinkageKey["elements"][] = [
      [{ field: "dob" }],
      [{ field: "ssn" }],
    ],
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: keyElements.map((elements, i) => ({
      name: `KEY${i}`,
      elements,
    })),
  });
  const deadTransform = [
    { function: "parse_date" as const, params: { inputFormat: "MM/DD" } },
  ];

  test("every key satisfiable and live -> the run may proceed", () => {
    const verdict = decideLinkageTermsVerdict(["dob", "ssn"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(true);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "satisfiable",
      "satisfiable",
    ]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.deadKeys).toEqual([]);
    expect(verdict.unsatisfiedFields).toEqual([]);
  });

  test("one unsatisfiable key among satisfiable ones -> refused", () => {
    const verdict = decideLinkageTermsVerdict(["dob"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "satisfiable",
      "unsatisfiable",
    ]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual(["KEY1"]);
    expect(verdict.deadKeys).toEqual([]);
    expect(verdict.unsatisfiedFields.map((f) => f.name)).toEqual(["ssn"]);
  });

  test("one dead key among live ones -> refused", () => {
    // Both keys' columns are present, so the column check passes; KEY0's own
    // element cleaning drops every record regardless of the data.
    const verdict = decideLinkageTermsVerdict(
      ["dob", "ssn"],
      twoKeyTerms([
        [{ field: "dob", transform: deadTransform }],
        [{ field: "ssn" }],
      ]),
    );
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual(["dead", "satisfiable"]);
    expect(verdict.deadKeys.map((k) => k.name)).toEqual(["KEY0"]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.unsatisfiedFields).toEqual([]);
  });

  test("no satisfiable key -> refused", () => {
    const verdict = decideLinkageTermsVerdict(["other_column"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "unsatisfiable",
      "unsatisfiable",
    ]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual([
      "KEY0",
      "KEY1",
    ]);
    expect(verdict.unsatisfiedFields.map((f) => f.name)).toEqual([
      "dob",
      "ssn",
    ]);
  });

  test("every satisfiable key dead -> refused", () => {
    const verdict = decideLinkageTermsVerdict(
      ["dob"],
      twoKeyTerms([
        [{ field: "dob", transform: deadTransform }],
        [{ field: "ssn" }],
      ]),
    );
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "dead",
      "unsatisfiable",
    ]);
    expect(verdict.deadKeys.map((k) => k.name)).toEqual(["KEY0"]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual(["KEY1"]);
  });

  test("terms declaring no linkage key at all -> refused", () => {
    // A key-count threshold passes this vacuously (0 satisfiable of 0 declared),
    // and linkageTermsFromRuleSet reaches it by narrowing the built-in set all
    // the way down when the columns support no key.
    const verdict = decideLinkageTermsVerdict(["dob", "ssn"], twoKeyTerms([]));
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys).toEqual([]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.deadKeys).toEqual([]);
  });

  test("linkageTermsFromRuleSet can derive the keyless terms the verdict refuses", () => {
    // The derived-defaults path, not a hand-built fixture: metadata carrying no
    // linkage-roled column narrows the built-in rule set to no key.
    const derived = linkageTermsFromRuleSet(DEFAULT_LINKAGE_RULE_SET, "Party", [
      {
        name: "row_id",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
    ]);
    expect(derived.linkageKeys).toEqual([]);
    expect(decideLinkageTermsVerdict(["row_id"], derived).fullySatisfied).toBe(
      false,
    );
  });

  test("assessLinkageSatisfiability projects the same grading", () => {
    // The per-key readout and the run's verdict must not drift: the shape count
    // is exactly the keys the verdict does not grade unsatisfiable.
    const columns = ["dob"];
    const terms = twoKeyTerms([
      [{ field: "dob", transform: deadTransform }],
      [{ field: "ssn" }],
    ]);
    const verdict = decideLinkageTermsVerdict(columns, terms);
    const { unsatisfied, satisfiableKeyCount, deadKeys } =
      assessLinkageSatisfiability(columns, terms);
    expect(satisfiableKeyCount).toBe(
      verdict.keys.length - verdict.unsatisfiableKeys.length,
    );
    expect(deadKeys).toEqual(verdict.deadKeys);
    expect(unsatisfied).toEqual(verdict.unsatisfiedFields);
  });
});

// --- assertLinkageTermsSatisfiable: the run-boundary refusal -----------------

describe("assertLinkageTermsSatisfiable", () => {
  const oneKeyTerms = (name: string): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name, elements: [{ field: "ssn" }] }],
  });

  test("a fully satisfied input passes", () => {
    expect(() =>
      assertLinkageTermsSatisfiable(["ssn"], oneKeyTerms("SSN")),
    ).not.toThrow();
  });

  test("a shortfall raises the typed refusal and names it", () => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["other"], oneKeyTerms("SSN"));
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
    expect(raised).toBeInstanceOf(UsageError);
    // Deliberately not an OperatorConfigError: its message carries the agreed
    // terms' names, which are partner-authored on every accept path.
    expect(raised).not.toBeInstanceOf(OperatorConfigError);
    const rendered = sanitizeErrorForDisplay(raised);
    expect(rendered).toContain("out of band");
    expect(rendered).toContain("SSN");
    expect(rendered).toContain("ssn (ssn)");
  });

  test("keyless terms raise the refusal with no name enumeration to make", () => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["ssn"], {
        ...oneKeyTerms("SSN"),
        linkageKeys: [],
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    expect((raised as Error).cause).toBeUndefined();
    expect(sanitizeErrorForDisplay(raised)).toContain("declare no linkage key");
  });

  test("a partner-authored key name spends only its own display budget", () => {
    // The names ride cause links of their own, so a key name packed to the
    // display cap cannot truncate the summary or the remedy sentence.
    const shouting = "K".repeat(4000);
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["other"], oneKeyTerms(shouting));
    } catch (err) {
      raised = err;
    }
    const rendered = sanitizeErrorForDisplay(raised);
    expect(rendered).toContain("out of band");
    expect(rendered).toContain("unsatisfied linkage fields (1)");
  });
});

// --- summarizeLinkageShortfall: the wording both refusals state --------------

describe("summarizeLinkageShortfall", () => {
  const deadTransform = [
    { function: "parse_date", params: { inputFormat: "MM/DD" } },
  ];
  // One key per field, so a case picks each key's grade independently: withhold
  // the column to make it unsatisfiable, give it the dead transform to make it
  // dead.
  const twoKeyTerms = (
    ssnElement: LinkageKeyElement,
    dobElement: LinkageKeyElement,
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "dob", type: "date_of_birth" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [ssnElement] },
      { name: "DOB", elements: [dobElement] },
    ],
  });
  const summarize = (columns: string[], terms: LinkageTerms): string =>
    summarizeLinkageShortfall(decideLinkageTermsVerdict(columns, terms));

  test("a lone declared key is named as the one it is", () => {
    expect(
      summarize(["dob"], {
        ...twoKeyTerms({ field: "ssn" }, { field: "dob" }),
        linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      }),
    ).toBe(
      "the one agreed linkage key cannot be produced from this input's columns",
    );
  });

  test("a shortfall over every declared key is counted as all of them", () => {
    expect(
      summarize(
        ["ssn", "dob"],
        twoKeyTerms(
          { field: "ssn", transform: deadTransform },
          { field: "dob", transform: deadTransform },
        ),
      ),
    ).toBe(
      "the cleaning declared for all 2 agreed linkage keys drops every record",
    );
  });

  test("both shortfall kinds are stated, each counted against the whole set", () => {
    expect(
      summarize(
        ["dob"],
        twoKeyTerms(
          { field: "ssn" },
          { field: "dob", transform: deadTransform },
        ),
      ),
    ).toBe(
      "1 of the 2 agreed linkage keys cannot be produced from this input's " +
        "columns, and the cleaning declared for 1 of the 2 agreed linkage keys " +
        "drops every record",
    );
  });

  test("the run-boundary refusal states the fragment verbatim", () => {
    const terms = twoKeyTerms(
      { field: "ssn" },
      { field: "dob", transform: deadTransform },
    );
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["dob"], terms);
    } catch (err) {
      raised = err;
    }
    expect(sanitizeErrorForDisplay(raised)).toContain(
      summarize(["dob"], terms),
    );
  });
});

// --- assessLinkageSatisfiability vs the real builder (differential) ----------

// assessLinkageSatisfiability is a second, hand-maintained copy of the
// column-to-field resolution buildStandardizedDataset performs at exchange time;
// the guard is sound only while the two agree. This pins the detector's verdict
// against an actual buildStandardizedDataset + buildKeyStrings run, so a future
// change to the builder's resolution that the detector fails to mirror turns red
// here rather than silently letting a silent-empty config through (the failure
// class review caught repeatedly). Each case uses identity standardization (empty
// steps) and a non-empty value in every present column, so a key yields a string
// iff all its element fields resolved to a present column -- isolating the
// resolution the detector models from the documented shape-vs-values residual
// (whether a value survives a pipeline), which the detector deliberately ignores.
describe("assessLinkageSatisfiability matches buildStandardizedDataset", () => {
  // One ssn key and one lastName key, so a case can satisfy both, one, or neither.
  const diffTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "lastname", type: "last_name" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "NAME", elements: [{ field: "lastname" }] },
    ],
  };

  const cases: Array<{
    name: string;
    columns: string[];
    standardization?: Standardization;
    metadata?: ColumnMetadata[];
    expected: number;
  }> = [
    {
      name: "inferred, both keys satisfiable",
      columns: ["ssn", "last_name"],
      expected: 2,
    },
    {
      name: "inferred, only the name key satisfiable",
      columns: ["last_name"],
      expected: 1,
    },
    {
      name: "explicit metadata types a non-inferring column as ssn",
      columns: ["tax_id", "last_name"],
      metadata: [col("tax_id", "ssn"), col("last_name", "last_name")],
      expected: 2,
    },
    {
      name: "explicit metadata retypes the ssn column away",
      columns: ["ssn", "last_name"],
      metadata: [col("ssn", "other"), col("last_name", "last_name")],
      expected: 1,
    },
    {
      name: "absent same-typed metadata column ordered before a present one",
      columns: ["present_ssn", "last_name"],
      metadata: [
        col("absent_ssn", "ssn"),
        col("present_ssn", "ssn"),
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      // The remap target is roled `linkage`, so the explicit mapping binds it
      // even though its type is not `ssn` (the type fallback alone would not).
      name: "explicit standardization remaps to a present role:linkage column",
      columns: ["ssn_src", "last_name"],
      standardization: [{ output: "ssn", input: "ssn_src" }],
      metadata: [col("ssn_src", "other"), col("last_name", "last_name")],
      expected: 2,
    },
    {
      // Same remap, but the target is roled `payload`: matching requires
      // `role: linkage`, so the role wins over the explicit transform and ssn is
      // refused -- builder and checker agree (only the name key survives).
      name: "explicit standardization remaps to a present payload column (refused)",
      columns: ["ssn_src", "last_name"],
      standardization: [{ output: "ssn", input: "ssn_src" }],
      metadata: [
        { name: "ssn_src", type: "ssn", role: "payload", isPayload: true },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      name: "explicit standardization remaps to an absent column",
      columns: ["ssn", "last_name"],
      standardization: [{ output: "ssn", input: "tax_id" }],
      expected: 1,
    },
    {
      // A same-typed ssn column roled `payload` is NOT a default match field:
      // the type fallback binds only `role: linkage`, so ssn is unsatisfiable.
      name: "a payload-roled same-typed column is not a default match field",
      columns: ["ssn", "last_name"],
      metadata: [
        { name: "ssn", type: "ssn", role: "payload", isPayload: true },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      // Likewise a same-typed ssn column roled `identifier`.
      name: "an identifier-roled same-typed column is not a default match field",
      columns: ["ssn", "last_name"],
      metadata: [
        { name: "ssn", type: "ssn", role: "identifier", isPayload: false },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
  ];

  test.each(cases)(
    "$name",
    ({ columns, standardization, metadata, expected }) => {
      const row = Object.fromEntries(columns.map((c) => [c, "x"]));
      const builderMetadata = metadata ?? inferMetadata(columns);
      const dataset = buildStandardizedDataset(
        standardization,
        [row],
        builderMetadata,
        diffTerms,
      );
      const produced = diffTerms.linkageKeys.filter(
        (k) => buildKeyStrings(k, dataset, 0) !== null,
      ).length;
      const { satisfiableKeyCount } = assessLinkageSatisfiability(
        columns,
        diffTerms,
        standardization,
        metadata,
      );
      // The detector must agree with the real builder (the differential), and both
      // must equal the hand-checked count.
      expect(produced).toBe(expected);
      expect(satisfiableKeyCount).toBe(expected);
    },
  );
});

// --- StandardizationSchema ---------------------------------------------------

describe("StandardizationSchema", () => {
  test("parses a valid standardization spec", () => {
    const raw = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(() => StandardizationSchema.parse(raw)).not.toThrow();
  });

  test("rejects duplicate output fields", () => {
    const raw = [
      { output: "last_name", input: "LN" },
      { output: "last_name", input: "LAST_NAME" },
    ];
    expect(() => StandardizationSchema.parse(raw)).toThrow();
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
    // `pattern` carries no fallback (it is used as authored), so even a token
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

// --- checkValueConstraints ---------------------------------------------------

describe("checkValueConstraints", () => {
  test("flags an excluded value across field types and passes one not on the list", () => {
    // `exclude` is shared by every constraint shape, so the denylist is honored
    // for a name as much as for an SSN or an `exclude`-only type (phone_number).
    const name: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { exclude: ["TEST"] },
    };
    const phone: LinkageField = {
      name: "ph",
      type: "phone_number",
      constraints: { exclude: ["0000000000"] },
    };
    expect(checkValueConstraints(name, "TEST").map((v) => v.kind)).toEqual([
      "excluded",
    ]);
    expect(checkValueConstraints(name, "MARY")).toEqual([]);
    expect(
      checkValueConstraints(phone, "0000000000").map((v) => v.kind),
    ).toEqual(["excluded"]);
    expect(checkValueConstraints(phone, "1234567890")).toEqual([]);
  });

  test("flags a name value with a character outside allowedCharacters and passes a conforming one", () => {
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z " },
    };
    // A lowercase residue is outside `A-Z `.
    expect(
      checkValueConstraints(field, "mary").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(checkValueConstraints(field, "MARY JANE")).toEqual([]);
  });

  test("flags an invalid date only under validOnly, and only in canonical YYYYMMDD form", () => {
    const withConstraint: LinkageField = {
      name: "dob",
      type: "date_of_birth",
      constraints: { validOnly: true },
    };
    const withoutConstraint: LinkageField = {
      name: "dob",
      type: "date_of_birth",
    };
    // 2021-02-30 is not a real day.
    expect(
      checkValueConstraints(withConstraint, "20210230").map((v) => v.kind),
    ).toEqual(["invalidDate"]);
    expect(checkValueConstraints(withConstraint, "20210228")).toEqual([]);
    // A value in another output format is not judged (the operator may target it).
    expect(checkValueConstraints(withConstraint, "2021-02-30")).toEqual([]);
    expect(checkValueConstraints(withoutConstraint, "20210230")).toEqual([]);
  });

  test("flags every structurally invalid SSN branch under validOnly, and passes valid forms", () => {
    const field: LinkageField = {
      name: "ssn",
      type: "ssn",
      constraints: { validOnly: true },
    };
    const flaggedSsn = (value: string) =>
      checkValueConstraints(field, value).some((v) => v.kind === "invalidSsn");
    // Each SSA structural rule is its own branch: area 000 / 666 / >= 900, group
    // 00, and serial 0000 are never issued.
    expect(flaggedSsn("000223456")).toBe(true);
    expect(flaggedSsn("666223456")).toBe(true);
    expect(flaggedSsn("900223456")).toBe(true);
    expect(flaggedSsn("123003456")).toBe(true); // group 00
    expect(flaggedSsn("123450000")).toBe(true); // serial 0000
    // A structurally valid 9-digit value, and a non-9-digit value (left to the
    // format-shaping pipeline, not judged here), are not flagged.
    expect(flaggedSsn("123456789")).toBe(false);
    expect(flaggedSsn("12345678")).toBe(false);
  });

  test("flags an ssn4 whose serial is 0000 under validOnly, and passes any other 4-digit value", () => {
    // The last four digits are the SSA serial, whose one structural rule is that
    // it is not 0000; that is the whole judgeable surface for a bare last-four.
    const field: LinkageField = {
      name: "ssn4",
      type: "ssn4",
      constraints: { validOnly: true },
    };
    expect(checkValueConstraints(field, "0000").map((v) => v.kind)).toEqual([
      "invalidSsn4",
    ]);
    expect(checkValueConstraints(field, "0001")).toEqual([]);
    expect(checkValueConstraints(field, "6789")).toEqual([]);
    // Not exactly four digits -> left to the format-shaping pipeline, not judged.
    expect(checkValueConstraints(field, "000")).toEqual([]);
    expect(checkValueConstraints(field, "00000")).toEqual([]);
    // Without validOnly the serial rule does not apply.
    expect(
      checkValueConstraints({ name: "ssn4", type: "ssn4" }, "0000"),
    ).toEqual([]);
  });

  test("does not flag a constraint with no clean value-level test", () => {
    // affixesAllowed is intentionally not checked: a value with a surviving
    // honorific/suffix is not flagged, because affix detection collides with
    // legitimate name values and has no clean value-level test.
    const affix: LinkageField = {
      name: "ln",
      type: "last_name",
      constraints: { affixesAllowed: false },
    };
    expect(checkValueConstraints(affix, "SMITH JR")).toEqual([]);
    expect(checkValueConstraints(affix, "JUDGE")).toEqual([]);
    // An `exclude`-only type with no declared exclusion has nothing to judge.
    expect(
      checkValueConstraints(
        { name: "email", type: "email_address" },
        "a@b.com",
      ),
    ).toEqual([]);
    expect(
      checkValueConstraints(
        { name: "phone", type: "phone_number" },
        "anything",
      ),
    ).toEqual([]);
  });

  test("a partner-crafted allowedCharacters that breaks out of the class cannot stall the check", () => {
    // `allowedCharacters` is partner-controlled and only validated to compile as a
    // `[...]` class body, so this value closes the class and injects a
    // catastrophic-backtracking construct. Matching the whole value against
    // `^[allowed]*$` would have hung the thread (ReDoS); testing one character at a
    // time on the linear-time engine returns promptly and still flags the
    // disallowed input. The test completing under the default timeout is itself the
    // regression guard.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "x](a+)+b[y" },
    };
    const hostile = "x" + "a".repeat(60) + "!";
    expect(
      checkValueConstraints(field, hostile).some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a multi-character match-everything allowedCharacters breakout cannot suppress the warning", () => {
    // `a]|.*[b` breaks the class into match-anything alternation that, applied to
    // the whole value, would never warn. Tested per character, a genuinely
    // disallowed value is still flagged -- a multi-character construct cannot match
    // a single code point, so this breakout family cannot turn the warning off.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "a]|.*[b" },
    };
    expect(
      checkValueConstraints(field, "Z@#$").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a shorthand-in-class allowedCharacters admits the code point (accepted advisory limit, not a hole)", () => {
    // The per-code-point test defeats multi-character breakouts, and the leading-^
    // negation is closed separately (see the caret tests below); neither touches a
    // class that genuinely admits the code point: `]|\w|[` parses (leading `]`
    // literal) as one class admitting every word character, so a "disallowed" letter
    // is not flagged. This is the class behaving as a class; because allowedCharacters
    // is warn-not-enforce, the only effect is a suppressed advisory badge -- never a
    // data-filtering or match-correctness effect. Pinned so the accepted limit in
    // withinAllowedCharacters cannot silently drift, in either direction.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "]|\\w|[" },
    };
    // "Z" is a word character the shorthand admits -> not flagged.
    expect(
      checkValueConstraints(field, "Z").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(false);
    // A non-word character is still outside the class -> still flagged, so the
    // class is genuinely evaluated (not blanket-suppressed).
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a leading-^ negated allowedCharacters no longer inverts the advisory", () => {
    // A leading `^` makes re2js read `[^A-Z]` -- the NEGATION of A-Z -- so the class
    // would admit every character EXCEPT A-Z and suppress the warning on arbitrary
    // disallowed input, the opposite of the plain reading ("allow `^` and A-Z, flag
    // the rest"). withinAllowedCharacters escapes the leading `^` to a literal caret,
    // restoring the plain reading. Distinct from the genuine-admission shorthand
    // limit above: this polarity inversion is CLOSED, not accepted.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^A-Z" },
    };
    // A character the plain reading excludes is now flagged -- the negation admitted
    // it (unflagged) before the escape.
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    // A character the plain reading admits -- an uppercase letter, and the caret
    // itself, now a literal member -- is not flagged.
    expect(checkValueConstraints(field, "A")).toEqual([]);
    expect(checkValueConstraints(field, "^")).toEqual([]);
  });

  test("a non-leading caret in allowedCharacters stays a literal allowed character", () => {
    // `^` is special only as the FIRST character of a class; written non-first it is
    // a literal. The leading-^ neutralization must not disturb that: `A-Z^` allows
    // the caret and still flags a genuine outsider.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z^" },
    };
    expect(checkValueConstraints(field, "^")).toEqual([]);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a leading `^-` reads as a literal allow-list, not a reversed range", () => {
    // Escaping only the caret would turn `^-Z` into `[\^-Z]` -- a range from `^`
    // (0x5E) down to `Z` (0x5A), which re2js rejects; the compile failure fails open
    // and suppresses the advisory on EVERY value, the unsafe direction. Escaping the
    // `-` after the caret too makes `[\^\-Z]` -- the literal set {`^`, `-`, `Z`} the
    // operator meant -- so the class compiles and the leading-^ vector never
    // suppresses. Pinned because the per-code-point escape is the only thing
    // standing between this family and a blanket fail-open.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^-Z" },
    };
    expect(checkValueConstraints(field, "^")).toEqual([]);
    expect(checkValueConstraints(field, "-")).toEqual([]);
    expect(checkValueConstraints(field, "Z")).toEqual([]);
    // Characters outside the literal set are still flagged -- not blanket-suppressed.
    expect(
      checkValueConstraints(field, "A").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("an alternation-breakout allowedCharacters is still flagged (full match, not unanchored find)", () => {
    // `a]*|` compiles `^[a]*|]$`, which re2js reads as `(^[a]*) | (]$)`: the first
    // branch matches the empty string at the start anchor. An UNANCHORED find would
    // then return true for every value and suppress the advisory entirely. The check
    // tests each code point as a FULL match, so a branch matching only a zero-width
    // span does not satisfy it and a disallowed value is still flagged. Pinned so a
    // regression from full-match back to an unanchored find cannot reopen the hole.
    for (const allowedCharacters of ["a]*|", "\\w]*|", "0]?|"]) {
      const field: LinkageField = {
        name: "fn",
        type: "first_name",
        constraints: { allowedCharacters },
      };
      expect(
        checkValueConstraints(field, "!").some(
          (v) => v.kind === "disallowedCharacters",
        ),
      ).toBe(true);
    }
  });

  test("an alternation-breakout class that admits the code point is an accepted limit", () => {
    // `a]|.|[b` compiles `^[a]|.|[b]$` = `(^[a]) | (.) | ([b]$)`: the `.` branch
    // full-matches any single code point, so the class effectively admits everything.
    // Unlike the empty-/zero-width-branch breakout above (closed by full match), a
    // branch that genuinely matches one code point cannot be neutralized without
    // rejecting a legitimately permissive class like `[\s\S]` -- only the top-level
    // `|` a real class never contains distinguishes them, which would take a full
    // class parser, out of proportion to a warn-only advisory. Same accepted-limit
    // category as the `]|\w|[` shorthand smuggle: warn-not-enforce, so the only effect
    // is a suppressed badge. Pinned (the closed/accepted boundary, in both directions).
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "a]|.|[b" },
    };
    expect(checkValueConstraints(field, "!")).toEqual([]);
    expect(checkValueConstraints(field, "Z")).toEqual([]);
  });

  test("an exotic leading-^ class whose escaped form will not compile over-flags, never suppresses", () => {
    // Escaping the leading `^` in `^]A[` to `\^` lets the following `]` close the
    // class, so `[\^]A[]` does not compile. The raw class `[^]A[]` does (a `]` right
    // after `[^` is a literal member), so the escape -- not the partner -- broke it.
    // The check must OVER-flag (the warn-not-enforce safe direction), not fail open
    // and suppress the advisory on every value, which a leading-^ negation would
    // otherwise still achieve for this family. Pinned so the over-flag fallback
    // cannot regress to a blanket fail-open.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^]A[" },
    };
    // Every value is flagged -- the advisory is raised, not suppressed.
    expect(
      checkValueConstraints(field, "A").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("the empty string conforms to any allowedCharacters class", () => {
    // The per-code-point loop is vacuously true on an empty value: there is no code
    // point to fall outside the class. Pinned so a refactor of the iteration cannot
    // start flagging empty values.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z" },
    };
    expect(checkValueConstraints(field, "")).toEqual([]);
  });

  test("an allowedCharacters class that cannot compile fails open (no violation)", () => {
    // A class the linear-time engine cannot compile is treated as "cannot check"
    // rather than throwing -- the advisory reports, never blocks, so an
    // uncheckable class must not crash the run or fabricate violations. `z-a` is a
    // reversed range re2js rejects. (For a decoded token NameConstraintsSchema is
    // the backstop; checkValueConstraints is the last line.)
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "z-a" },
    };
    expect(checkValueConstraints(field, "Q")).toEqual([]);
  });

  test("a Unicode property class admits its code points (accepted advisory limit)", () => {
    // `\p{L}` ("any letter") is the natural allowedCharacters for international names
    // and is indistinguishable at the engine level from a shorthand smuggle, so it is
    // an accepted limit, not a hole: neutralizing it would false-flag real non-Latin
    // names. Also pins that the per-code-point iteration handles astral code points
    // (a surrogate pair is one `for...of` step), which a switch to index-based
    // iteration would silently break.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "\\p{L}" },
    };
    expect(checkValueConstraints(field, "中")).toEqual([]); // CJK letter
    expect(checkValueConstraints(field, "\u{1D4CD}")).toEqual([]); // astral letter
    // A non-letter is still outside the class -> still flagged.
    expect(
      checkValueConstraints(field, "9").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });
});

// --- summarizeDatasetConstraintViolations ------------------------------------

describe("summarizeDatasetConstraintViolations", () => {
  const sweepTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "test",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      {
        name: "last_name",
        type: "last_name",
        constraints: { allowedCharacters: "A-Z " },
      },
      {
        name: "date_of_birth",
        type: "date_of_birth",
        constraints: { validOnly: true },
      },
    ],
    linkageKeys: [
      {
        name: "LN+DOB",
        elements: [{ field: "last_name" }, { field: "date_of_birth" }],
      },
    ],
  };
  const metadata: ColumnMetadata[] = [
    { name: "LN", type: "last_name", role: "linkage", isPayload: false },
    { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
  ];

  test("aggregates per (field, kind) across all rows, counting each violating value", () => {
    const rows = [
      { LN: "SMITH", DOB: "19900115" }, // both conform
      { LN: "lower", DOB: "20210230" }, // disallowed chars + invalid date
      { LN: "Mixed", DOB: "20211301" }, // disallowed chars + invalid date
    ];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      metadata,
      sweepTerms,
    );
    const summaries = summarizeDatasetConstraintViolations(
      sweepTerms,
      dataset,
      rows.length,
    );
    expect(
      summaries.map((s) => ({ field: s.field, kind: s.kind, count: s.count })),
    ).toEqual(
      expect.arrayContaining([
        { field: "last_name", kind: "disallowedCharacters", count: 2 },
        { field: "date_of_birth", kind: "invalidDate", count: 2 },
      ]),
    );
    expect(summaries).toHaveLength(2);
    // The aggregate carries the fixed badge caption for the caller to render.
    expect(summaries.find((s) => s.kind === "invalidDate")?.label).toBe(
      "invalid date",
    );
  });

  test("returns nothing when every produced value conforms", () => {
    const rows = [{ LN: "SMITH", DOB: "19900115" }];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      metadata,
      sweepTerms,
    );
    expect(
      summarizeDatasetConstraintViolations(sweepTerms, dataset, rows.length),
    ).toEqual([]);
  });

  test("aggregates exclude-denylist hits across rows (the memoized membership path)", () => {
    // A denylist field swept over multiple rows exercises the per-row reuse the
    // exclude-Set memoization optimizes: the same field (and its `exclude` array)
    // is checked every row, and the aggregate must credit every hit -- including a
    // repeat of the same excluded value on a later row.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { exclude: ["SMITH", "TEST"] },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const rows = [
      { LN: "SMITH" }, // excluded
      { LN: "JONES" }, // conforms
      { LN: "SMITH" }, // excluded again -- second row against the same memoized set
      { LN: "TEST" }, // excluded
    ];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([
      {
        field: "last_name",
        kind: "excluded",
        label: "excluded value",
        count: 3,
      },
    ]);
  });

  test("a field with no declared constraints, or absent from the dataset, contributes nothing", () => {
    // last_name has no constraints; date_of_birth resolves to no column (its
    // metadata column is missing), so neither contributes a summary.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        { name: "last_name", type: "last_name" },
        {
          name: "date_of_birth",
          type: "date_of_birth",
          constraints: { validOnly: true },
        },
      ],
    };
    const rows = [{ LN: "lower" }];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([]);
  });

  test("judges a fan-out value per candidate", () => {
    // split_on fans "AAAA BBBB" into two name candidates; the lowercase-residue
    // check runs on each, so a two-candidate row contributes two violations.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "split_on", params: { delimiter: " " } }],
      },
    ];
    const rows = [{ LN: "aa bb" }];
    const dataset = buildStandardizedDataset(
      standardization,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    const summaries = summarizeDatasetConstraintViolations(
      terms,
      dataset,
      rows.length,
    );
    expect(summaries).toEqual([
      {
        field: "last_name",
        kind: "disallowedCharacters",
        label: "disallowed characters",
        count: 2,
      },
    ]);
  });

  test("skips a constrained field no linkage key references, still reports a referenced one", () => {
    // Both fields are declared, constrained, resolve to a column, and carry a
    // value that violates their constraints. Only `last_name` is referenced by a
    // linkage key; `first_name` is declared-but-unreferenced, so the exchange
    // never standardizes or consumes it and the sweep must not warn on it.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
        {
          name: "first_name",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const rows = [{ LN: "smith", FN: "jane" }]; // both lowercase -> both violate A-Z
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [
        { name: "LN", type: "last_name", role: "linkage", isPayload: false },
        { name: "FN", type: "first_name", role: "linkage", isPayload: false },
      ],
      terms,
    );
    // The unreferenced first_name DOES resolve to a column (it is present in the
    // dataset), so its exclusion is the referenced-scoping at work, not the
    // resolved-to-no-column path the prior test covers.
    expect(dataset.getField("first_name")).toBeDefined();
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([
      {
        field: "last_name",
        kind: "disallowedCharacters",
        label: "disallowed characters",
        count: 1,
      },
    ]);
  });

  test("sweeps every field a swap key references, unaffected by the swap", () => {
    // Encodes the referenced-set comment's swap-invariance claim as a check: the
    // sweep reads the un-swapped `element.field`, and `swap` only permutes which
    // slot holds which field, so the set of fields it sweeps is identical with or
    // without the swap. Both swapped fields are constrained and violate, so both
    // must be reported -- a field reachable only through the swap is not missed.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "first_name",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z" },
        },
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [
        {
          name: "swap(FN,LN)",
          elements: [{ field: "first_name" }, { field: "last_name" }],
          swap: ["first_name", "last_name"],
        },
      ],
    };
    const rows = [{ FN: "jane", LN: "smith" }]; // both lowercase -> both violate A-Z
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [
        { name: "FN", type: "first_name", role: "linkage", isPayload: false },
        { name: "LN", type: "last_name", role: "linkage", isPayload: false },
      ],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual(
      expect.arrayContaining([
        {
          field: "first_name",
          kind: "disallowedCharacters",
          label: "disallowed characters",
          count: 1,
        },
        {
          field: "last_name",
          kind: "disallowedCharacters",
          label: "disallowed characters",
          count: 1,
        },
      ]),
    );
  });
});
