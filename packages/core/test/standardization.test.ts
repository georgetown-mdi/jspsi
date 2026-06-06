import { expect, test, describe } from "vitest";

import {
  runPipeline,
  buildStandardizedDataset,
  buildKeyStrings,
  validateStandardizationAgainstTerms,
  StandardizedField,
  StandardizedDataset,
} from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";
import { StandardizationSchema } from "../src/config/standardization";

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
  ).toThrow('unknown standardization function: "nonexistent_function"');
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
      new StandardizedDataset([
        new StandardizedField(
          "first_name",
          "FN",
          [{ function: "to_upper_case" }],
          [{ FN: raw }],
        ),
      ]);
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
    const dataset = new StandardizedDataset([
      new StandardizedField("first_name", "FN", [], [{ FN: "anything" }]),
    ]);
    expect(buildKeyStrings(key, dataset, 0)).toEqual(new Set([NFC_JOSE]));
  });

  test("key is NFC when concatenation crosses a combining-mark boundary", () => {
    // Element a is a base letter and element b is a lone combining acute; each
    // value is NFC on its own, but the joined "e" + U+0301 composes, so the
    // final NFC pass recomposes it to the precomposed U+00E9.
    const key = { name: "AB", elements: [{ field: "a" }, { field: "b" }] };
    const rows = [{ a: "e", b: "\u0301" }];
    const dataset = new StandardizedDataset([
      new StandardizedField("a", "a", [], rows),
      new StandardizedField("b", "b", [], rows),
    ]);
    expect(buildKeyStrings(key, dataset, 0)).toEqual(new Set(["\u00e9"]));
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
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "lastName" },
    { name: "date_of_birth", type: "dateOfBirth" },
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
        type: "lastName",
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
      { name: "LN", type: "lastName", role: "linkage", isPayload: false },
      { name: "DOB", type: "dateOfBirth", role: "linkage", isPayload: false },
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
    const dataset = new StandardizedDataset([
      new StandardizedField("alpha", "A", [], rows),
      new StandardizedField("beta", "B", [], rows),
    ]);
    expect(dataset.fieldNames).toEqual(new Set(["alpha", "beta"]));
  });

  test("getField returns undefined for unknown field", () => {
    const dataset = new StandardizedDataset([]);
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
        // Encode the array as a "|"-delimited raw value and split it back.
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
    return new StandardizedDataset(standardizedFields);
  }

  const key = {
    name: "LN+DOB",
    elements: [{ field: "last_name" }, { field: "date_of_birth" }],
  };

  test("single-value fields concatenate", () => {
    const dataset = makeDataset({
      last_name: "SMITH",
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
  });

  test("empty field value set (null) returns null", () => {
    const rows = [{ last_name: "SMITH", date_of_birth: "000" }];
    const dataset = new StandardizedDataset([
      new StandardizedField("last_name", "last_name", [], rows),
      new StandardizedField(
        "date_of_birth",
        "date_of_birth",
        [{ function: "null_if", params: { value: "000" } }],
        rows,
      ),
    ]);
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
  });

  test("missing field in dataset returns null", () => {
    const dataset = makeDataset({ last_name: "SMITH" });
    expect(buildKeyStrings(key, dataset, 0)).toBeNull();
  });

  test("fan-out field produces cross-product with single-value field", () => {
    const dataset = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: "19900115",
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115", "JONES19900115"]),
    );
  });

  test("cross-product over two fan-out fields", () => {
    const dataset = makeDataset({
      last_name: ["SMITH", "JONES"],
      date_of_birth: ["19900115", "19900116"],
    });
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set([
        "SMITH19900115",
        "SMITH19900116",
        "JONES19900115",
        "JONES19900116",
      ]),
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

  test("swap is applied when isReceiver is true", () => {
    const swapKey = {
      name: "FN+LN swapped",
      elements: [{ field: "first_name" }, { field: "last_name" }],
      swap: ["first_name", "last_name"] as [string, string],
    };
    const dataset = makeDataset({ first_name: "JANE", last_name: "SMITH" });
    // Sender: first_name then last_name = "JANESMITH"
    expect(buildKeyStrings(swapKey, dataset, 0, false)).toEqual(
      new Set(["JANESMITH"]),
    );
    // Receiver: swapped = last_name then first_name = "SMITHJANE"
    expect(buildKeyStrings(swapKey, dataset, 0, true)).toEqual(
      new Set(["SMITHJANE"]),
    );
  });

  test("uses the provided row index to look up field values", () => {
    const rows = [
      { last_name: "SMITH", date_of_birth: "19900115" },
      { last_name: "JONES", date_of_birth: "19850701" },
    ];
    const dataset = new StandardizedDataset([
      new StandardizedField("last_name", "last_name", [], rows),
      new StandardizedField("date_of_birth", "date_of_birth", [], rows),
    ]);
    expect(buildKeyStrings(key, dataset, 0)).toEqual(
      new Set(["SMITH19900115"]),
    );
    expect(buildKeyStrings(key, dataset, 1)).toEqual(
      new Set(["JONES19850701"]),
    );
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
