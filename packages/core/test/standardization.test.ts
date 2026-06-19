import { expect, test, describe } from "vitest";

import {
  runPipeline,
  buildStandardizedDataset,
  buildKeyStrings,
  validateStandardizationAgainstTerms,
  describeTransformCoercions,
  unsatisfiedLinkageFields,
  assessLinkageSatisfiability,
  StandardizedField,
  StandardizedDataset,
} from "../src/standardization";
import { inferMetadata } from "../src/config/metadata";
import { getDefaultLinkageTerms } from "../src/defaults/linkageTerms";
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

// --- unsatisfiedLinkageFields ------------------------------------------------

// Fixture: columns that cover firstName, lastName, dateOfBirth, ssn.
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
    // Only first_name is present; lastName, dateOfBirth, and ssn cannot be
    // produced.
    const unsatisfied = unsatisfiedLinkageFields(["first_name"], fullTerms);
    const names = unsatisfied.map((f) => f.name).sort();
    expect(names).toContain("lastName");
    expect(names).toContain("dateOfBirth");
    expect(names).toContain("ssn");
    expect(names).not.toContain("firstName");
  });

  test("a column of the right type but different name still satisfies", () => {
    // `fname` and `dob` are aliases inferred as firstName / dateOfBirth.
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
    // required field (ssn, lastName, or dateOfBirth), so no key can match and
    // the exchange should be blocked rather than run to a silent empty result.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["first_name"],
      fullTerms,
    );
    expect(satisfiableKeyCount).toBe(0);
    const names = unsatisfied.map((f) => f.name);
    expect(names).toContain("ssn");
    expect(names).toContain("lastName");
    expect(names).toContain("dateOfBirth");
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
    // key needs. With firstName absent, the swap key references an unproducible
    // field and must be excluded from the satisfiable count, identically to the
    // non-swap LN+FN+DOB key.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["last_name", "dob", "ssn"],
      allKeyTerms,
    );
    const unsatNames = new Set(unsatisfied.map((f) => f.name));
    expect(unsatNames.has("firstName")).toBe(true);
    // ssn+lastName+dob keys survive, so this is a partial (warn) case, proving the
    // swap key's exclusion is not just the whole set collapsing to zero.
    expect(satisfiableKeyCount).toBeGreaterThan(0);
    expect(satisfiableKeyCount).toBeLessThan(allKeyTerms.linkageKeys.length);
    const swapKey = allKeyTerms.linkageKeys.find((k) => k.swap !== undefined);
    expect(swapKey).toBeDefined();
    if (swapKey === undefined) return;
    // The detector reads e.field on the stored (unswapped) elements; the swap key
    // needs firstName, which is unsatisfiable, so it is correctly excluded.
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
      (f) => f.name === "firstName",
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
