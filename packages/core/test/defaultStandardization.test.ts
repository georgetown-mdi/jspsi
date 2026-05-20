import { expect, test, describe } from "vitest";

import { getDefaultStandardization } from "../src/defaults/standardization";
import {
  inferDateFormat,
  CANDIDATE_DATE_FORMATS,
  INFER_DATE_SCAN_CAP,
} from "../src/utils/date";
import { runPipeline } from "../src/standardization";
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
    { name: "ssn", semanticType: "ssn" },
    { name: "ssn4", semanticType: "ssn4" },
    { name: "firstName", semanticType: "firstName" },
    { name: "lastName", semanticType: "lastName" },
    { name: "dateOfBirth", semanticType: "dateOfBirth" },
    { name: "phoneNumber", semanticType: "phoneNumber" },
    { name: "emailAddress", semanticType: "emailAddress" },
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
  { name: "FIRST_NAME", type: "firstName", role: "linkage", isPayload: false },
  { name: "LAST_NAME", type: "lastName", role: "linkage", isPayload: false },
  { name: "DOB", type: "dateOfBirth", role: "linkage", isPayload: false },
  { name: "PHONE", type: "phoneNumber", role: "linkage", isPayload: false },
  { name: "EMAIL", type: "emailAddress", role: "linkage", isPayload: false },
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
    expect(outputs).toContain("firstName");
    expect(outputs).toContain("lastName");
    expect(outputs).toContain("dateOfBirth");
    expect(outputs).toContain("phoneNumber");
    expect(outputs).toContain("emailAddress");
  });

  test("input names come from metadata column names", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    const byOutput = Object.fromEntries(result.map((t) => [t.output, t.input]));
    expect(byOutput["ssn"]).toBe("SSN");
    expect(byOutput["firstName"]).toBe("FIRST_NAME");
    expect(byOutput["lastName"]).toBe("LAST_NAME");
    expect(byOutput["dateOfBirth"]).toBe("DOB");
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
      linkageFields: [{ name: "ssn", semanticType: "ssn" }],
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
      linkageFields: [{ name: "social_security", semanticType: "ssn" }],
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
});

// --- SSN pipeline ------------------------------------------------------------

describe("default SSN pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "ssn", semanticType: "ssn" }],
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
        linkageFields: [{ name: "ssn4", semanticType: "ssn4" }],
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

describe("default name pipeline (firstName / lastName)", () => {
  function runFirst(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "FN", type: "firstName", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "firstName", semanticType: "firstName" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  function runLast(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "LN", type: "lastName", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "lastName", semanticType: "lastName" }],
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

  test("firstName and lastName use the same pipeline", () => {
    expect(runFirst("O'Brien-Smith")).toBe(runLast("O'Brien-Smith"));
  });
});

// --- Date of birth pipeline --------------------------------------------------

describe("default dateOfBirth pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "DOB", type: "dateOfBirth", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "dateOfBirth", semanticType: "dateOfBirth" }],
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

describe("default phoneNumber pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "PHONE",
          type: "phoneNumber",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "phoneNumber", semanticType: "phoneNumber" }],
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

describe("default emailAddress pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "EMAIL",
          type: "emailAddress",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "emailAddress", semanticType: "emailAddress" }],
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
});

// --- getDefaultStandardization — dateInputFormat option ----------------------

describe("getDefaultStandardization — dateInputFormat option", () => {
  const dobTerms: LinkageTerms = {
    ...minimalTerms,
    linkageFields: [{ name: "dateOfBirth", semanticType: "dateOfBirth" }],
  };
  const dobMeta = [
    {
      name: "DOB",
      type: "dateOfBirth" as const,
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
      linkageFields: [{ name: "ssn", semanticType: "ssn" }],
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
