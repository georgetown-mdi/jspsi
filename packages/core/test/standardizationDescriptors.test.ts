import { expect, test, describe } from "vitest";

import {
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  STANDARDIZATION_FUNCTION_NAMES,
  runPipeline,
} from "../src/standardization";

import {
  MAX_DATE_FORMAT_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
} from "../src/config/linkageTerms";

// --- Descriptor / registry parity --------------------------------------------

// STANDARDIZATION_FUNCTION_NAMES is derived from the STANDARDIZING_FUNCTIONS
// registry (its keys, plus `coalesce`), so asserting descriptor/name parity is
// equivalent to asserting descriptor/registry parity: a registry function added
// without a descriptor surfaces as a name with no descriptor, and a descriptor
// for a dropped function surfaces as a descriptor with no name. Either fails CI.
describe("descriptor / registry parity", () => {
  test("every recognized function name has a descriptor", () => {
    const described = new Set(
      Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS),
    );
    const missing = STANDARDIZATION_FUNCTION_NAMES.filter(
      (name) => !described.has(name),
    );
    expect(missing).toEqual([]);
  });

  test("every descriptor names a recognized function", () => {
    const recognized = new Set(STANDARDIZATION_FUNCTION_NAMES);
    const extra = Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS).filter(
      (name) => !recognized.has(name),
    );
    expect(extra).toEqual([]);
  });

  test("the descriptor key set equals the recognized-name set exactly", () => {
    expect(Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
  });
});

// --- Descriptor shape --------------------------------------------------------

describe("descriptor fields", () => {
  test("each descriptor's name matches its table key", () => {
    for (const [key, descriptor] of Object.entries(
      STANDARDIZATION_FUNCTION_DESCRIPTORS,
    )) {
      expect(descriptor.name).toBe(key);
    }
  });

  test("each descriptor has a non-empty label and blurb", () => {
    for (const descriptor of Object.values(
      STANDARDIZATION_FUNCTION_DESCRIPTORS,
    )) {
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.blurb.length).toBeGreaterThan(0);
    }
  });

  test("the regex family is the danger tier and nothing else is", () => {
    const regexTier = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
      .filter((d) => d.tier === "regex")
      .map((d) => d.name)
      .sort();
    expect(regexTier).toEqual([
      "extract_regex",
      "filter_regex",
      "replace_regex",
      "split_on",
    ]);
  });

  test("every tier is one of the known values", () => {
    for (const descriptor of Object.values(
      STANDARDIZATION_FUNCTION_DESCRIPTORS,
    )) {
      expect(["standard", "regex"]).toContain(descriptor.tier);
    }
  });
});

// --- Param-schema validation -------------------------------------------------

// Each descriptor's param schema must accept the param shapes its factory
// accepts and reject malformed ones, so a descriptor cannot disagree with the
// function it describes. Representative coverage below; the pad_left and phonetic
// cases also assert the agreement directly against runPipeline (the factory).
describe("param schemas", () => {
  const schemaFor = (name: string) =>
    STANDARDIZATION_FUNCTION_DESCRIPTORS[name].params;

  test("a no-param function accepts an empty params object", () => {
    expect(schemaFor("to_upper_case").safeParse({}).success).toBe(true);
  });

  // The no-param functions share one `noParams` schema; the factory ignores
  // params entirely, so the schema must strip unexpected keys rather than reject
  // them -- otherwise it would disagree with a factory that accepts anything.
  test("a no-param function strips unexpected keys (matching the factory)", () => {
    const parsed = schemaFor("trim_whitespace").safeParse({ unexpected: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({});
  });

  describe("pad_left", () => {
    const schema = schemaFor("pad_left");

    test("accepts a positive length and fills the char default", () => {
      const parsed = schema.safeParse({ length: 9 });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ length: 9, char: "0" });
    });

    test("accepts an explicit single-character char", () => {
      expect(schema.safeParse({ length: 4, char: "X" }).success).toBe(true);
    });

    test("rejects a missing length", () => {
      expect(schema.safeParse({}).success).toBe(false);
    });

    test("rejects a non-positive length", () => {
      expect(schema.safeParse({ length: 0 }).success).toBe(false);
      expect(schema.safeParse({ length: -1 }).success).toBe(false);
    });

    test("rejects a non-integer length", () => {
      expect(schema.safeParse({ length: 1.5 }).success).toBe(false);
    });

    test("rejects a multi-character char", () => {
      expect(schema.safeParse({ length: 9, char: "AB" }).success).toBe(false);
    });

    // The schema and the factory agree on what is malformed: a value the schema
    // rejects also makes the factory throw, and a value it accepts does not.
    test("agrees with the factory on length validity", () => {
      expect(schema.safeParse({ length: 0 }).success).toBe(false);
      expect(() =>
        runPipeline("1", [{ function: "pad_left", params: { length: 0 } }]),
      ).toThrow('pad_left: "length" must be a positive integer');

      expect(schema.safeParse({ length: 9 }).success).toBe(true);
      expect(() =>
        runPipeline("1", [{ function: "pad_left", params: { length: 9 } }]),
      ).not.toThrow();
    });

    test("agrees with the factory on char validity", () => {
      expect(schema.safeParse({ length: 4, char: "AB" }).success).toBe(false);
      expect(() =>
        runPipeline("1", [
          { function: "pad_left", params: { length: 4, char: "AB" } },
        ]),
      ).toThrow('pad_left: "char" must be exactly one character');
    });
  });

  describe("substring", () => {
    const schema = schemaFor("substring");

    test("accepts a positive start and length", () => {
      expect(schema.safeParse({ start: 1, length: 3 }).success).toBe(true);
    });

    test("accepts a negative start (counts from the end)", () => {
      expect(schema.safeParse({ start: -3, length: 3 }).success).toBe(true);
    });

    test("rejects a zero start", () => {
      expect(schema.safeParse({ start: 0, length: 3 }).success).toBe(false);
    });

    test("rejects a missing length", () => {
      expect(schema.safeParse({ start: 1 }).success).toBe(false);
    });

    // The factory does not throw on start=0; it returns an always-null function.
    // The schema rejects exactly the value the factory renders useless, and the
    // shapes it accepts produce the slice the factory computes (positive from the
    // front, negative from the end).
    test("agrees with the factory on the start it rejects and accepts", () => {
      expect(schema.safeParse({ start: 0, length: 3 }).success).toBe(false);
      expect(
        runPipeline("ABCDE", [
          { function: "substring", params: { start: 0, length: 3 } },
        ]),
      ).toBeNull();

      expect(schema.safeParse({ start: 1, length: 3 }).success).toBe(true);
      expect(
        runPipeline("ABCDE", [
          { function: "substring", params: { start: 1, length: 3 } },
        ]),
      ).toBe("ABC");
      expect(
        runPipeline("ABCDE", [
          { function: "substring", params: { start: -2, length: 2 } },
        ]),
      ).toBe("DE");
    });
  });

  describe("phonetic", () => {
    const schema = schemaFor("phonetic");

    test("defaults the algorithm to soundex when omitted", () => {
      const parsed = schema.safeParse({});
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ algorithm: "soundex" });
    });

    test("accepts the soundex algorithm", () => {
      expect(schema.safeParse({ algorithm: "soundex" }).success).toBe(true);
    });

    // The schema rejects an unimplemented algorithm, exactly as the factory
    // throws on one -- the descriptor admits only what the function supports.
    test("rejects an unimplemented algorithm, agreeing with the factory", () => {
      expect(schema.safeParse({ algorithm: "metaphone" }).success).toBe(false);
      expect(() =>
        runPipeline("x", [
          { function: "phonetic", params: { algorithm: "metaphone" } },
        ]),
      ).toThrow('unsupported phonetic algorithm: "metaphone"');
    });
  });

  describe("null_if", () => {
    const schema = schemaFor("null_if");

    test("accepts a single value", () => {
      expect(schema.safeParse({ value: "000000000" }).success).toBe(true);
    });

    test("accepts a values array", () => {
      expect(schema.safeParse({ values: ["a", "b"] }).success).toBe(true);
    });

    test("rejects a non-string value", () => {
      expect(schema.safeParse({ value: 5 }).success).toBe(false);
    });

    test("rejects a non-string element in values", () => {
      expect(schema.safeParse({ values: ["a", 5] }).success).toBe(false);
    });

    // Neither field is required: the factory reads an absent value/values as an
    // empty exclusion list and passes the value through, so the schema accepts
    // an empty object to mirror that no-op rather than disagree with it.
    test("accepts an empty object (the factory's no-op shape)", () => {
      expect(schema.safeParse({}).success).toBe(true);
    });
  });

  describe("parse_date", () => {
    const schema = schemaFor("parse_date");

    test("defaults both formats when omitted", () => {
      const parsed = schema.safeParse({});
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({
        inputFormat: "MM/DD/YYYY",
        outputFormat: "YYYYMMDD",
      });
    });

    test("accepts custom input and output formats", () => {
      expect(
        schema.safeParse({
          inputFormat: "YYYY-MM-DD",
          outputFormat: "DD/MM/YYYY",
        }).success,
      ).toBe(true);
    });

    test("rejects an empty format string", () => {
      expect(schema.safeParse({ inputFormat: "" }).success).toBe(false);
    });

    test("rejects a non-string format", () => {
      expect(schema.safeParse({ outputFormat: 5 }).success).toBe(false);
    });

    // The schema bounds the format strings to non-empty only, not their token
    // content: a tokenless format like "garbage" is accepted, mirroring the
    // factory, which accepts any string (it then matches little and yields null
    // rather than throwing). Token presence is editor guidance, not a
    // factory-agreement concern.
    test("accepts a tokenless format string, agreeing with the factory", () => {
      expect(schema.safeParse({ inputFormat: "garbage" }).success).toBe(true);
      expect(() =>
        runPipeline("01/15/1990", [
          { function: "parse_date", params: { inputFormat: "garbage" } },
        ]),
      ).not.toThrow();
    });

    // The format schema caps length at MAX_DATE_FORMAT_LENGTH (the same bound the
    // linkage-terms gate applies to wire formats), so an over-length format -- which
    // the factory would expand into a regex and compile under the linear-time engine,
    // paying a super-linear compile cost on the editor's live-preview thread -- is
    // rejected at authoring, the same defense regexPatternSchema gives the raw-regex
    // family through a sibling param.
    test("rejects a format longer than MAX_DATE_FORMAT_LENGTH", () => {
      const atLimit = "Y".repeat(MAX_DATE_FORMAT_LENGTH);
      const overLimit = "Y".repeat(MAX_DATE_FORMAT_LENGTH + 1);
      expect(schema.safeParse({ inputFormat: atLimit }).success).toBe(true);
      expect(schema.safeParse({ inputFormat: overLimit }).success).toBe(false);
      expect(schema.safeParse({ outputFormat: overLimit }).success).toBe(false);
    });
  });

  describe("regex family", () => {
    test("accepts a valid pattern and defaults the replacement", () => {
      const parsed = schemaFor("replace_regex").safeParse({ pattern: "\\d" });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ pattern: "\\d", replacement: "" });
    });

    test("rejects a missing pattern", () => {
      expect(schemaFor("replace_regex").safeParse({}).success).toBe(false);
      expect(schemaFor("extract_regex").safeParse({}).success).toBe(false);
      expect(schemaFor("filter_regex").safeParse({}).success).toBe(false);
    });

    test("accepts a valid pattern for extract_regex and filter_regex", () => {
      expect(
        schemaFor("extract_regex").safeParse({ pattern: "^(\\w+)-" }).success,
      ).toBe(true);
      expect(
        schemaFor("filter_regex").safeParse({ pattern: "^[A-Z]+$" }).success,
      ).toBe(true);
    });

    // The schema's compile-check rejects the same invalid pattern the factory's
    // `new RegExp(pattern)` throws on at construction, so the descriptor cannot
    // admit a pattern the function would reject.
    test("rejects an invalid pattern, agreeing with the factory", () => {
      expect(
        schemaFor("extract_regex").safeParse({ pattern: "(" }).success,
      ).toBe(false);
      expect(() =>
        runPipeline("x", [
          { function: "extract_regex", params: { pattern: "(" } },
        ]),
      ).toThrow();
    });

    test("split_on accepts a delimiter and defaults includeOriginal", () => {
      const parsed = schemaFor("split_on").safeParse({ delimiter: "-" });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ delimiter: "-", includeOriginal: false });
    });

    // The pattern schema rejects out-of-dialect syntax (backreferences, lookaround)
    // -- exactly what the linear-time engine cannot compile and the runtime gate
    // rejects -- so the editor never accepts a pattern an exchange would refuse.
    test("rejects an out-of-dialect pattern (lookaround / backreference)", () => {
      expect(
        schemaFor("filter_regex").safeParse({ pattern: "a(?=b)" }).success,
      ).toBe(false);
      expect(
        schemaFor("replace_regex").safeParse({ pattern: "(a)\\1" }).success,
      ).toBe(false);
    });

    // The pattern schema caps length at MAX_TRANSFORM_PATTERN_LENGTH (the same bound
    // the linkage-terms gate applies to wire patterns), checked before the dialect
    // compile, so a pathological-length pattern is rejected without the editor
    // paying the super-linear compile cost on its live-preview thread.
    test("rejects a pattern longer than MAX_TRANSFORM_PATTERN_LENGTH", () => {
      const atLimit = "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH);
      const overLimit = "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1);
      expect(
        schemaFor("filter_regex").safeParse({ pattern: atLimit }).success,
      ).toBe(true);
      expect(
        schemaFor("filter_regex").safeParse({ pattern: overLimit }).success,
      ).toBe(false);
      expect(
        schemaFor("split_on").safeParse({ delimiter: overLimit }).success,
      ).toBe(false);
    });
  });

  describe("coalesce", () => {
    const schema = schemaFor("coalesce");

    test("accepts a string default", () => {
      expect(schema.safeParse({ default: "UNKNOWN" }).success).toBe(true);
    });

    // `default` is optional: the factory reads an absent default as "no
    // substitution" (the field stays null), so the schema must accept an empty
    // object to mirror that, not require a default.
    test("accepts an empty object (no default substitution)", () => {
      expect(schema.safeParse({}).success).toBe(true);
    });

    test("rejects a non-string default", () => {
      expect(schema.safeParse({ default: 5 }).success).toBe(false);
    });
  });
});
