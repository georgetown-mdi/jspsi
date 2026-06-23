import { expect, test, describe } from "vitest";

import { getDefaultStandardization } from "../src/defaults/standardization";
import {
  inferDateFormat,
  columnValues,
  CANDIDATE_DATE_FORMATS,
  INFER_DATE_SCAN_CAP,
} from "../src/utils/date";
import { runPipeline } from "../src/standardization";
import {
  coerceToPatternString,
  patternConformsToDialect,
} from "../src/utils/linearRegex";
import { REGEX_STEP_PATTERN_PARAM } from "../src/config/transformRegexDialect";
import type { ColumnMetadata } from "../src/config/metadata";
import type { LinkageTerms } from "../src/config/linkageTerms";

// --- Fixtures ----------------------------------------------------------------

const minimalTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "ssn4", type: "ssn4" },
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
    { name: "phone_number", type: "phone_number" },
    { name: "email_address", type: "email_address" },
  ],
  linkageKeys: [
    {
      name: "test",
      elements: [{ field: "ssn" }],
    },
  ],
};

const fullMetadata: ColumnMetadata[] = [
  { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
  { name: "SSN4", type: "ssn4", role: "linkage", isPayload: false },
  { name: "FIRST_NAME", type: "first_name", role: "linkage", isPayload: false },
  { name: "LAST_NAME", type: "last_name", role: "linkage", isPayload: false },
  { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
  { name: "PHONE", type: "phone_number", role: "linkage", isPayload: false },
  { name: "EMAIL", type: "email_address", role: "linkage", isPayload: false },
];

// --- getDefaultStandardization -----------------------------------------------

describe("getDefaultStandardization — structure", () => {
  test("returns one transformation per matching linkage field", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    expect(result).toHaveLength(7);
  });

  test("output names match linkage field names", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    const outputs = result.map((t) => t.output);
    expect(outputs).toContain("ssn");
    expect(outputs).toContain("ssn4");
    expect(outputs).toContain("first_name");
    expect(outputs).toContain("last_name");
    expect(outputs).toContain("date_of_birth");
    expect(outputs).toContain("phone_number");
    expect(outputs).toContain("email_address");
  });

  test("input names come from metadata column names", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    const byOutput = Object.fromEntries(result.map((t) => [t.output, t.input]));
    expect(byOutput["ssn"]).toBe("SSN");
    expect(byOutput["first_name"]).toBe("FIRST_NAME");
    expect(byOutput["last_name"]).toBe("LAST_NAME");
    expect(byOutput["date_of_birth"]).toBe("DOB");
  });

  test("skips linkage fields whose type is absent from metadata", () => {
    const metadata: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
    ];
    const result = getDefaultStandardization(metadata, minimalTerms);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe("ssn");
  });

  test("returns empty array when metadata is empty", () => {
    const result = getDefaultStandardization([], minimalTerms);
    expect(result).toHaveLength(0);
  });

  test("skips identifier and other semantic types", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "ssn", type: "ssn" }],
    };
    const metadata: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
      { name: "ID", type: "identifier", role: "identifier", isPayload: true },
    ];
    const result = getDefaultStandardization(metadata, terms);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe("ssn");
  });

  test("uses the linkage field name, not the semantic type, as output", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "social_security", type: "ssn" }],
    };
    const result = getDefaultStandardization(
      [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
      terms,
    );
    expect(result[0].output).toBe("social_security");
  });

  test("each transformation has a non-empty steps array", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    for (const t of result) {
      expect(t.steps).toBeDefined();
      expect((t.steps ?? []).length).toBeGreaterThan(0);
    }
  });

  test("every raw-pattern step in every default pipeline is in the linear-time dialect", () => {
    // The dialect gate rejects out-of-dialect partner patterns at terms validation;
    // a SHIPPED default that drifted out of dialect would only surface as a remote
    // exchange failing to validate the bundled terms. Pin it here directly
    // (CONTRIBUTING: encode a runtime fact as a check) so a new default the engine
    // cannot compile trips this test, not a counterparty.
    const transformations = getDefaultStandardization(
      fullMetadata,
      minimalTerms,
    );
    const patterns: string[] = [];
    for (const t of transformations) {
      for (const step of t.steps ?? []) {
        const paramKey = REGEX_STEP_PATTERN_PARAM[step.function];
        if (paramKey === undefined) continue;
        const raw = step.params?.[paramKey];
        if (raw === undefined) continue;
        patterns.push(coerceToPatternString(raw));
      }
    }
    // Guard: the defaults DO exercise regex steps, so this is not a vacuous pass.
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(patternConformsToDialect(pattern), `pattern: ${pattern}`).toBe(
        true,
      );
    }
  });
});

// --- Default chains never emit the empty string ------------------------------

describe('default chains: a blank input yields null, never ""', () => {
  // The empty-string-as-matchable-key change (link.ts removeDuplicatesAndUndefineds
  // now drops only undefined, not every falsy value) rests on the premise that the
  // default per-type cleaning maps a blank value to null, so a fully-default
  // exchange never emits "" as a key and is unaffected. docs/spec/PROTOCOL.md (Key
  // input data) and the CHANGELOG state this as prose; pin it as a check here so a
  // future default chain that let a blank fall through to "" trips this test rather
  // than silently widening default matching (CONTRIBUTING: encode a runtime fact as
  // a check). null (record excluded) and "" (a matchable key) are now distinct
  // outcomes downstream, so toBeNull also asserts the value is not "".
  const blanks = ["", " ", "   ", "\t", " \t\n "];
  const transformations = getDefaultStandardization(fullMetadata, minimalTerms);

  // Guard: every default linkage field is exercised, so this is not a vacuous pass.
  test("covers all seven default linkage fields", () => {
    expect(transformations).toHaveLength(7);
  });

  for (const t of transformations) {
    test(`${t.output}: every blank input maps to null`, () => {
      for (const blank of blanks) {
        expect(
          runPipeline(blank, t.steps!),
          `input ${JSON.stringify(blank)}`,
        ).toBeNull();
      }
    });
  }

  // A non-blank "junk" cell that CLEANS to empty (separators or punctuation a
  // type strips entirely) is the other half of "blank/'' cleaned value" in item
  // 203074970: it never arrives as whitespace but reduces to "" partway through.
  // Every default type drops these characters, so each maps to null for the same
  // reason a literal blank does; pin it so a chain that let a cleaned-empty value
  // survive trips this test.
  const cleansToEmpty = ["---", "...", "!!!", "@@@"];
  for (const t of transformations) {
    test(`${t.output}: a non-blank value that cleans to empty maps to null`, () => {
      for (const junk of cleansToEmpty) {
        expect(
          runPipeline(junk, t.steps!),
          `input ${JSON.stringify(junk)}`,
        ).toBeNull();
      }
    });
  }
});

// --- SSN / SSN4 explicit blank-drop ------------------------------------------

describe("default SSN / SSN4 pipelines: explicit blank-drop before pad_left", () => {
  // Item 203074970: SSN/SSN4 pad a cleaned value to a fixed width, so a value
  // that cleaned to empty would pad into an all-zeros placeholder ("000000000" /
  // "0000") before reaching any null-mapping step -- dropped only as a side
  // effect of the terminal placeholder null_if happening to list that value. An
  // explicit `null_if ""` placed BEFORE pad_left drops the empty value as empty,
  // so the blank-cell footgun (live since item 203074741 stopped dropping "" at
  // the linkage layer) is prevented here and stays prevented even if an operator
  // edits the placeholder list. Pin the step's presence, its position, and the
  // fact that it -- not the placeholder null_if -- carries the blank-drop.
  const cases: Array<{ type: "ssn" | "ssn4"; column: string }> = [
    { type: "ssn", column: "SSN" },
    { type: "ssn4", column: "SSN4" },
  ];

  function stepsFor(type: "ssn" | "ssn4", column: string) {
    const [t] = getDefaultStandardization(
      [{ name: column, type, role: "linkage", isPayload: false }],
      { ...minimalTerms, linkageFields: [{ name: type, type }] },
    );
    return t.steps ?? [];
  }

  for (const { type, column } of cases) {
    test(`${type}: an explicit null_if "" precedes pad_left`, () => {
      const steps = stepsFor(type, column);
      const emptyDropIdx = steps.findIndex(
        (s) => s.function === "null_if" && s.params?.value === "",
      );
      const padIdx = steps.findIndex((s) => s.function === "pad_left");
      expect(emptyDropIdx).toBeGreaterThanOrEqual(0);
      expect(padIdx).toBeGreaterThan(emptyDropIdx);
    });

    test(`${type}: a blank or cleaned-empty value still drops with the placeholder null_if removed`, () => {
      // Prove the explicit empty-drop is load-bearing, not redundant with the
      // terminal placeholder null_if: strip the placeholder step (the null_if
      // listing all-zeros/sequential placeholders via `values`) and a value that
      // is blank ("", "   ") OR cleans to empty through the chain ("abc", "----"
      // lose every non-digit) must still map to null. Without the explicit
      // `null_if ""`, such a value would pad to an all-zeros value and survive as
      // a matchable key.
      const withoutPlaceholder = stepsFor(type, column).filter(
        (s) => !(s.function === "null_if" && s.params?.values !== undefined),
      );
      for (const input of ["", "   ", "abc", "----"]) {
        expect(
          runPipeline(input, withoutPlaceholder),
          `input ${JSON.stringify(input)}`,
        ).toBeNull();
      }
    });
  }
});

// --- SSN pipeline ------------------------------------------------------------

describe("default SSN pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "ssn", type: "ssn" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("strips dashes from dashed format", () => {
    expect(run("987-65-4321")).toBe("987654321");
  });

  test("strips spaces from space-separated format", () => {
    expect(run("987 65 4321")).toBe("987654321");
  });

  test("strips other non-digit characters", () => {
    expect(run("987.65.4321")).toBe("987654321");
  });

  test("trims surrounding whitespace", () => {
    expect(run("  987654321  ")).toBe("987654321");
  });

  test("passes through a bare 9-digit string unchanged", () => {
    expect(run("987654321")).toBe("987654321");
  });

  test("zero-pads an 8-digit SSN missing a leading zero", () => {
    expect(run("23456789")).toBe("023456789");
  });

  test("returns null for more than 9 digits", () => {
    expect(run("1234567890")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(run("")).toBeNull();
  });

  test("returns null for alphabetic input", () => {
    expect(run("abcdefghi")).toBeNull();
  });

  test("returns null for placeholder value", () => {
    expect(run("123456789")).toBeNull();
  });
});

// --- SSN4 pipeline -----------------------------------------------------------

describe("default SSN4 pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "SSN4", type: "ssn4", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "ssn4", type: "ssn4" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("passes through a bare 4-digit value", () => {
    expect(run("6789")).toBe("6789");
  });

  test("extracts last 4 digits from a full dashed SSN", () => {
    expect(run("123-45-6789")).toBe("6789");
  });

  test("extracts last 4 digits from a bare 9-digit SSN", () => {
    expect(run("123456789")).toBe("6789");
  });

  test("strips non-digit characters before extracting", () => {
    expect(run("12 34")).toBe("1234");
  });

  test("zero-pads a 3-digit SSN4 missing a leading zero", () => {
    expect(run("123")).toBe("0123");
  });

  test("returns null for empty input", () => {
    expect(run("")).toBeNull();
  });

  test("returns null for alphabetic input", () => {
    expect(run("abcd")).toBeNull();
  });
});

// --- Name pipelines ----------------------------------------------------------

describe("default name pipeline (first_name / last_name)", () => {
  function runFirst(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "FN", type: "first_name", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "first_name", type: "first_name" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  function runLast(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "last_name", type: "last_name" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("uppercases a plain name", () => {
    expect(runLast("smith")).toBe("SMITH");
  });

  test("trims leading and trailing whitespace", () => {
    expect(runLast("  Jones  ")).toBe("JONES");
  });

  test("normalizes accented characters", () => {
    expect(runLast("Héloïse")).toBe("HELOISE");
  });

  test("removes title prefix", () => {
    expect(runFirst("Dr. Jane")).toBe("JANE");
  });

  test("removes suffix", () => {
    expect(runLast("Smith Jr.")).toBe("SMITH");
  });

  test("removes both title and suffix", () => {
    expect(runFirst("Dr. Jane Smith Jr.")).toBe("JANE SMITH");
  });

  test("converts hyphen to space in hyphenated name", () => {
    expect(runLast("Smith-Jones")).toBe("SMITH JONES");
  });

  test("converts apostrophe to space", () => {
    expect(runLast("O'Brien")).toBe("O BRIEN");
  });

  test("squashes multiple spaces", () => {
    expect(runLast("Smith  Jones")).toBe("SMITH JONES");
  });

  test("returns null for a string that is only an affix", () => {
    expect(runFirst("Dr.")).toBeNull();
  });

  test("first_name and last_name use the same pipeline", () => {
    expect(runFirst("O'Brien-Smith")).toBe(runLast("O'Brien-Smith"));
  });
});

// --- Date of birth pipeline --------------------------------------------------

describe("default date_of_birth pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "DOB",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("converts MM/DD/YYYY to YYYYMMDD", () => {
    expect(run("01/15/1990")).toBe("19900115");
  });

  test("pads single-digit month and day", () => {
    expect(run("1/5/1990")).toBe("19900105");
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(run("  01/15/1990  ")).toBe("19900115");
  });

  test("returns null for a non-date string", () => {
    expect(run("not-a-date")).toBeNull();
  });

  test("returns null for a calendar-invalid date", () => {
    expect(run("13/01/1990")).toBeNull();
  });

  test("returns null for ISO 8601 format (YYYY-MM-DD)", () => {
    // Default pipeline assumes MM/DD/YYYY; other formats need explicit config.
    expect(run("1990-01-15")).toBeNull();
  });
});

// --- Phone number pipeline ---------------------------------------------------

describe("default phone_number pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "PHONE",
          type: "phone_number",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "phone_number", type: "phone_number" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("strips formatting to 10 digits", () => {
    expect(run("(123) 456-7890")).toBe("1234567890");
  });

  test("passes a bare 10-digit number through unchanged", () => {
    expect(run("1234567890")).toBe("1234567890");
  });

  test("strips dots used as separators", () => {
    expect(run("123.456.7890")).toBe("1234567890");
  });

  test("strips leading 1 from 11-digit US number", () => {
    expect(run("11234567890")).toBe("1234567890");
  });

  test("strips +1 country code prefix", () => {
    expect(run("+11234567890")).toBe("1234567890");
  });

  test("strips +1 country code from formatted number", () => {
    expect(run("+1 (123) 456-7890")).toBe("1234567890");
  });

  test("strips 1- country code from dashed format", () => {
    expect(run("1-123-456-7890")).toBe("1234567890");
  });

  test("returns null for 11-digit number not starting with 1", () => {
    expect(run("21234567890")).toBeNull();
  });

  test("returns null for fewer than 10 digits", () => {
    expect(run("123456789")).toBeNull();
  });

  test("returns null for alphabetic input", () => {
    expect(run("not-a-phone")).toBeNull();
  });
});

// --- Email address pipeline --------------------------------------------------

describe("default email_address pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "EMAIL",
          type: "email_address",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "email_address", type: "email_address" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("lowercases a mixed-case address", () => {
    expect(run("John.Doe@Example.COM")).toBe("john.doe@example.com");
  });

  test("trims surrounding whitespace", () => {
    expect(run("  user@example.com  ")).toBe("user@example.com");
  });

  test("passes a lowercase address through unchanged", () => {
    expect(run("user@example.com")).toBe("user@example.com");
  });

  test("returns null for a string without an @ sign", () => {
    expect(run("notanemail")).toBeNull();
  });

  test("returns null for a string without a domain dot", () => {
    expect(run("user@nodot")).toBeNull();
  });

  test("strips non-ASCII before the @-pattern filter (CHANNEL_SECURITY ordering claim)", () => {
    // The RE2 dialect's `\s` is ASCII-only, narrower than JavaScript's. The
    // email filter pattern uses `[^\s@]`, so CHANNEL_SECURITY.md relies on
    // `remove_non_ascii` running before this filter_regex, so no non-ASCII code
    // point ever reaches that class. Pin the ordering so the doc's runtime claim
    // cannot rot silently (CONTRIBUTING: encode a runtime fact as a check).
    const [t] = getDefaultStandardization(
      [
        {
          name: "EMAIL",
          type: "email_address",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "email_address", type: "email_address" }],
      },
    );
    const steps = t.steps ?? [];
    const asciiIdx = steps.findIndex((s) => s.function === "remove_non_ascii");
    const emailFilterIdx = steps.findIndex(
      (s) =>
        s.function === "filter_regex" &&
        typeof s.params?.pattern === "string" &&
        s.params.pattern.includes("@"),
    );
    expect(asciiIdx).toBeGreaterThanOrEqual(0);
    expect(emailFilterIdx).toBeGreaterThan(asciiIdx);
  });
});

// --- inferDateFormat ---------------------------------------------------------

describe("inferDateFormat — format identification", () => {
  test("identifies MM/DD/YYYY", () => {
    expect(inferDateFormat(["01/15/1990", "12/31/2000", "06/28/1975"])).toBe(
      "MM/DD/YYYY",
    );
  });

  test("identifies YYYY-MM-DD", () => {
    expect(inferDateFormat(["1990-01-15", "2000-12-31", "1975-06-28"])).toBe(
      "YYYY-MM-DD",
    );
  });

  test("identifies YYYYMMDD", () => {
    expect(inferDateFormat(["19900115", "20001231", "19750628"])).toBe(
      "YYYYMMDD",
    );
  });

  test("identifies MM-DD-YYYY", () => {
    expect(inferDateFormat(["01-15-1990", "12-31-2000", "06-28-1975"])).toBe(
      "MM-DD-YYYY",
    );
  });

  test("identifies MM/DD/YY", () => {
    expect(inferDateFormat(["01/15/90", "12/31/00", "06/28/75"])).toBe(
      "MM/DD/YY",
    );
  });

  test("identifies YYYY/MM/DD", () => {
    expect(inferDateFormat(["1990/01/15", "2000/12/31", "1975/06/28"])).toBe(
      "YYYY/MM/DD",
    );
  });

  test("identifies DD/MM/YYYY when day > 12 disambiguates from MM/DD/YYYY", () => {
    expect(inferDateFormat(["13/05/1990", "21/03/1985", "28/12/2000"])).toBe(
      "DD/MM/YYYY",
    );
  });

  test("identifies DD-MM-YYYY when day > 12 disambiguates", () => {
    expect(inferDateFormat(["13-05-1990", "21-03-1985", "28-12-2000"])).toBe(
      "DD-MM-YYYY",
    );
  });

  test("prefers MM/DD/YYYY over DD/MM/YYYY when both are consistent (all days ≤ 12)", () => {
    expect(inferDateFormat(["01/05/1990", "03/12/1985", "06/08/2000"])).toBe(
      "MM/DD/YYYY",
    );
  });
});

describe("inferDateFormat — edge cases", () => {
  test("returns undefined for an empty array", () => {
    expect(inferDateFormat([])).toBeUndefined();
  });

  test("returns undefined when all values are empty strings", () => {
    expect(inferDateFormat(["", "  ", ""])).toBeUndefined();
  });

  test("returns undefined when no format reaches the parse threshold", () => {
    expect(
      inferDateFormat(["foo", "bar", "baz", "qux", "quux"]),
    ).toBeUndefined();
  });

  test("ignores empty strings when computing the parse fraction", () => {
    const values = ["01/15/1990", "", "12/31/2000", "  ", "06/28/1975"];
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("handles whitespace-padded values", () => {
    expect(inferDateFormat(["  01/15/1990  ", "  12/31/2000  "])).toBe(
      "MM/DD/YYYY",
    );
  });

  test("rejects calendar-invalid dates, not just format mismatches", () => {
    // Month 13 is syntactically MM/DD/YYYY-like but not a valid date.
    expect(inferDateFormat(["13/32/1990", "14/29/2000"])).toBeUndefined();
  });

  test("YYYYMMDD requires exactly 8 digits — 7-digit values do not match", () => {
    // Would ambiguously match if variable-width tokens were used for adjacent
    // tokens.
    expect(inferDateFormat(["1990115", "2000631"])).toBeUndefined();
  });
});

describe("inferDateFormat — scanning", () => {
  test("returns the correct format for a column larger than the scan cap", () => {
    const values = Array.from({ length: INFER_DATE_SCAN_CAP * 4 }, (_, i) => {
      const year = 1950 + (i % 50);
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      return `${month}/${day}/${year}`;
    });
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("skips non-date values and continues scanning", () => {
    // Leading non-date rows are skipped (no candidate matches them); valid
    // dates that follow still narrow the candidate set normally.
    const junk = Array.from({ length: 100 }, () => "not-a-date");
    const dates = Array.from({ length: 100 }, (_, i) => {
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      return `${month}/${day}/2000`;
    });
    expect(inferDateFormat([...junk, ...dates])).toBe("MM/DD/YYYY");
  });

  test("covers all formats in CANDIDATE_DATE_FORMATS", () => {
    // Smoke-test that every exported candidate can be identified from clean
    // data.
    const samples: Record<string, string[]> = {
      "MM/DD/YYYY": ["01/15/1990", "06/28/1975", "12/31/2000"],
      "YYYY-MM-DD": ["1990-01-15", "1975-06-28", "2000-12-31"],
      YYYYMMDD: ["19900115", "19750628", "20001231"],
      "MM-DD-YYYY": ["01-15-1990", "06-28-1975", "12-31-2000"],
      "MM/DD/YY": ["01/15/90", "06/28/75", "12/31/00"],
      "YYYY/MM/DD": ["1990/01/15", "1975/06/28", "2000/12/31"],
      "DD/MM/YYYY": ["15/01/1990", "28/06/1975", "31/12/2000"],
      "DD-MM-YYYY": ["15-01-1990", "28-06-1975", "31-12-2000"],
    };
    for (const fmt of CANDIDATE_DATE_FORMATS) {
      expect(inferDateFormat(samples[fmt]), `format: ${fmt}`).toBe(fmt);
    }
  });

  test("interleaved empties do not consume the scan budget", () => {
    // Empties are skipped lazily and must not spend the cap: a run of empty
    // values longer than INFER_DATE_SCAN_CAP, followed by real dates, must still
    // infer. If empties counted toward the cap the budget would be exhausted
    // before any date was reached and the result would be undefined.
    const values = [
      ...Array.from({ length: INFER_DATE_SCAN_CAP * 2 }, () => ""),
      "01/15/1990",
      "12/31/2000",
      "06/28/1975",
    ];
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("consumes the source lazily, stopping at the scan cap", () => {
    // All days and months <= 12 keep both MM/DD/YYYY and DD/MM/YYYY alive, so the
    // candidate set never narrows to one and the cap alone governs how far we
    // scan. The generator can yield far past the cap; inferDateFormat must stop
    // pulling at INFER_DATE_SCAN_CAP rather than draining the whole source -- the
    // property that lets a large file be scanned without materializing its column.
    let yielded = 0;
    function* ambiguousDates(): Generator<string> {
      for (let i = 0; i < INFER_DATE_SCAN_CAP * 3; i++) {
        yielded++;
        yield "01/05/1990";
      }
    }
    expect(inferDateFormat(ambiguousDates())).toBe("MM/DD/YYYY");
    expect(yielded).toBeLessThanOrEqual(INFER_DATE_SCAN_CAP + 1);
  });
});

describe("columnValues", () => {
  test("yields each row's value for the named column", () => {
    expect([...columnValues([{ dob: "a" }, { dob: "b" }], "dob")]).toEqual([
      "a",
      "b",
    ]);
  });

  test("yields the empty string for a row missing the column", () => {
    expect([
      ...columnValues([{ dob: "a" }, { other: "x" }, { dob: "c" }], "dob"),
    ]).toEqual(["a", "", "c"]);
  });

  test("is lazy: pulls a row only as the consumer advances", () => {
    let yielded = 0;
    function* rows(): Generator<Record<string, string>> {
      for (let i = 0; i < 100; i++) {
        yielded++;
        yield { dob: "01/15/1990" };
      }
    }
    const gen = columnValues(rows(), "dob");
    gen.next();
    gen.next();
    expect(yielded).toBe(2);
  });
});

// --- getDefaultStandardization — dateInputFormat option ----------------------

describe("getDefaultStandardization — dateInputFormat option", () => {
  const dobTerms: LinkageTerms = {
    ...minimalTerms,
    linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
  };
  const dobMeta = [
    {
      name: "DOB",
      type: "date_of_birth" as const,
      role: "linkage" as const,
      isPayload: false,
    },
  ];

  test("defaults to MM/DD/YYYY when no option is provided", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms);
    expect(runPipeline("01/15/1990", t.steps!)).toBe("19900115");
    expect(runPipeline("1990-01-15", t.steps!)).toBeNull();
  });

  test("uses the provided dateInputFormat", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat: "YYYY-MM-DD",
    });
    expect(runPipeline("1990-01-15", t.steps!)).toBe("19900115");
    expect(runPipeline("01/15/1990", t.steps!)).toBeNull();
  });

  test("YYYYMMDD input format round-trips correctly", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat: "YYYYMMDD",
    });
    expect(runPipeline("19900115", t.steps!)).toBe("19900115");
  });

  test("non-date types are unaffected by dateInputFormat", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "ssn", type: "ssn" }],
    };
    const meta = [
      {
        name: "SSN",
        type: "ssn" as const,
        role: "linkage" as const,
        isPayload: false,
      },
    ];
    const withOpt = getDefaultStandardization(meta, terms, {
      dateInputFormat: "YYYY-MM-DD",
    });
    const withoutOpt = getDefaultStandardization(meta, terms);
    expect(withOpt).toEqual(withoutOpt);
  });
});
