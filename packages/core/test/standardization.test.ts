import { expect, test, describe, vi } from "vitest";

import {
  runPipeline,
  resolveFieldColumns,
  buildStandardizedDataset,
  buildKeyStrings,
  validateStandardizationAgainstTerms,
  describeTransformCoercions,
  unsatisfiedLinkageFields,
  assessLinkageSatisfiability,
  StandardizedField,
  StandardizedDataset,
} from "../src/standardization";
import * as linearRegex from "../src/utils/linearRegex";
import { inferMetadata } from "../src/config/metadata";
import { getDefaultLinkageTerms } from "../src/defaults/linkageTerms";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";
import {
  StandardizationSchema,
  type Standardization,
} from "../src/config/standardization";

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
    // Pins the no-split path: as a derive-type step it returns the normalized
    // form, not the original non-NFC bytes left by to_upper_case. Returning the
    // original (the pre-change behavior) would yield UPPER_NONNFC instead.
    expect(
      runPipeline(GREEK_INPUT, [
        { function: "to_upper_case" },
        { function: "split_on", params: { delimiter: "," } },
      ]),
    ).toEqual(new Set([UPPER_NFC]));
  });

  test("regression: an already-NFC value flows through with unchanged bytes", () => {
    // U+00E9 is already NFC, so the in-step normalize is a no-op and emitted
    // bytes are byte-identical to pre-change behavior; pure ASCII is a subset.
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
    expect(
      runPipeline("SMITH-JONES", [
        { function: "extract_regex", params: { pattern: "^(\\w+)-" } },
      ]),
    ).toBe("SMITH");
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

describe("buildKeyStrings: element-transform compilation reused across rows", () => {
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
    const dataset = new StandardizedDataset([
      new StandardizedField("ssn", "SSN", [], rows),
    ]);
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
    const dataset = new StandardizedDataset([
      new StandardizedField("ssn", "SSN", [], rows),
    ]);

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    // One regex step in one element transform -> one compile, independent of the
    // 50 rows. Pre-memoization this was 50 (one recompile per row).
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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
    const dataset = new StandardizedDataset([
      new StandardizedField("dob", "DOB", [], rows),
    ]);

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i);
    // parse_date builds its input-format regex once at closure-build time; memoized,
    // that build is shared across all 50 rows.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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
    const dataset = new StandardizedDataset([
      new StandardizedField("first", "FIRST", [], rows),
      new StandardizedField("second", "SECOND", [], rows),
    ]);

    const spy = vi.spyOn(linearRegex, "compileLinearRegex");
    for (let i = 0; i < rowCount; i++) buildKeyStrings(key, dataset, i, true);
    // Two distinct element-transform arrays -> two compiles across all 30 rows.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
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

// --- resolveFieldColumns -----------------------------------------------------

// The one binding the dataset builder, the satisfiability checker, and the
// default-standardization derivation all consume. These pin its observable
// resolution result directly, so a future change to the rules cannot pass while
// silently differing from what the builder does. The two named cases below were
// both live divergence bugs in the hand-maintained second copy this primitive
// replaced (see #201001899).
describe("resolveFieldColumns", () => {
  const col = (name: string, type: ColumnMetadata["type"]): ColumnMetadata => ({
    name,
    type,
    role: "linkage",
    isPayload: false,
  });

  // ssn + lastName fields, named by their semantic type for brevity.
  const terms: LinkageTerms = {
    version: "1.0.0",
    identity: "test",
    date: "2025-01-01",
    algorithm: "psi",
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

  test("an explicit mapping binds to its input column", () => {
    const resolution = resolveFieldColumns(
      terms,
      [{ output: "ssn", input: "ssn_src" }],
      inferMetadata(["ssn_src", "last_name"]),
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

  const roledCol = (
    name: string,
    type: ColumnMetadata["type"],
    role: ColumnMetadata["role"],
  ): ColumnMetadata => ({ name, type, role, isPayload: false });

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
      inferMetadata(["first_src", "second_src"]),
    );
    expect(resolution.get("ssn")?.column).toBe("second_src");
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
  test("an input that covers every field type is fully satisfiable", () => {
    expect(unsatisfiedLinkageFields(FULL_COLUMNS, fullTerms)).toEqual([]);
  });

  test("names the fields whose type no input column provides", () => {
    // Only first_name is present; last_name, date_of_birth, and ssn cannot be
    // produced.
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

  test("an explicit standardization mapping a present column satisfies a field its type does not", () => {
    // `tax_id` is not inferred as ssn, but an explicit mapping makes it so.
    const columns = ["first_name", "last_name", "dob", "tax_id"];
    expect(
      unsatisfiedLinkageFields(columns, fullTerms).map((f) => f.name),
    ).toContain("ssn");
    expect(
      unsatisfiedLinkageFields(columns, fullTerms, [
        { output: "ssn", input: "tax_id" },
      ]),
    ).toEqual([]);
  });

  test("an explicit standardization whose input column is absent does not satisfy", () => {
    // The mapping references tax_id, but the input has no tax_id column.
    const unsatisfied = unsatisfiedLinkageFields(
      ["first_name", "last_name", "dob"],
      fullTerms,
      [{ output: "ssn", input: "tax_id" }],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
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

  test("an input covering no complete key reports zero satisfiable keys (the block signal)", () => {
    // Only first_name is present. Every default key has at least one other
    // required field (ssn, last_name, or date_of_birth), so no key can match and
    // the exchange should be blocked rather than run to a silent empty result.
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

  test("an input missing one field keeps the keys that do not need it (partial, warn)", () => {
    // No ssn column, but first/last name and dob are present. Keys that require
    // ssn become unsatisfiable; the name+dob keys survive, so the count is
    // positive-but-not-all -- the warn (not block) case.
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
  const col = (name: string, type: ColumnMetadata["type"]): ColumnMetadata => ({
    name,
    type,
    role: "linkage",
    isPayload: false,
  });

  // One ssn key and one lastName key, so a case can satisfy both, one, or neither.
  const diffTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
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
      name: "explicit standardization remaps to a present column",
      columns: ["ssn_src", "last_name"],
      standardization: [{ output: "ssn", input: "ssn_src" }],
      expected: 2,
    },
    {
      name: "explicit standardization remaps to an absent column",
      columns: ["ssn", "last_name"],
      standardization: [{ output: "ssn", input: "tax_id" }],
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
