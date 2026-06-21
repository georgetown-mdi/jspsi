import { describe, expect, test } from "vitest";

import {
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  getDefaultStandardization,
} from "@psilink/core";

import {
  STANDARDIZATION_FUNCTION_GROUPS,
  applyStepOverrides,
  authorableFunctionNames,
  checkValueConstraints,
  describeParamFields,
  descriptorFor,
  functionDisplay,
  isStepValid,
  validateParamValue,
} from "../../src/psi/standardizationAuthoring.js";

import type {
  ColumnMetadata,
  LinkageField,
  LinkageTerms,
  Standardization,
} from "@psilink/core";

import type { FieldStepOverride } from "../../src/psi/standardizationAuthoring.js";

describe("function grouping parity with the descriptor table", () => {
  // The grouping is the add menu's source of truth; pin it to core's descriptor
  // table in both directions so a standard-tier function added to core cannot ship
  // without a group, and a regex-tier (deferred expert tier) function cannot leak
  // into the menu.
  const standardTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "standard")
    .map((d) => d.name);

  test("offers exactly the standard-tier functions", () => {
    expect([...authorableFunctionNames].sort()).toEqual(
      [...standardTierNames].sort(),
    );
  });

  test("excludes every regex-tier function (deferred expert tier)", () => {
    const regexTier = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
      .filter((d) => d.tier === "regex")
      .map((d) => d.name);
    expect(regexTier.length).toBeGreaterThan(0);
    for (const name of regexTier)
      expect(authorableFunctionNames.has(name)).toBe(false);
  });

  test("lists each function in exactly one group", () => {
    const flat = STANDARDIZATION_FUNCTION_GROUPS.flatMap(
      (g) => g.functionNames,
    );
    expect(flat.length).toBe(new Set(flat).size);
  });

  test("coalesce is presented in plain language, not the SQL term", () => {
    const display = functionDisplay("coalesce");
    expect(display.label.toLowerCase()).toContain("substitute a default");
    expect(display.label).not.toBe("Coalesce");
  });
});

describe("descriptor-driven typed param fields", () => {
  test("classifies each param into its widget kind from the Zod type", () => {
    const fields = (name: string) =>
      describeParamFields(STANDARDIZATION_FUNCTION_DESCRIPTORS[name]);

    // substring: two numeric inputs.
    const substring = fields("substring");
    expect(substring.map((f) => [f.key, f.kind])).toEqual([
      ["start", "number"],
      ["length", "number"],
    ]);

    // phonetic: a single enum, defaulted to soundex.
    const [algorithm] = fields("phonetic");
    expect(algorithm.kind).toBe("enum");
    expect(algorithm.enumOptions).toEqual(["soundex"]);
    expect(algorithm.defaultValue).toBe("soundex");

    // parse_date: two strings, each carrying its declared default.
    const parseDate = fields("parse_date");
    expect(parseDate.map((f) => f.kind)).toEqual(["string", "string"]);
    expect(parseDate.find((f) => f.key === "inputFormat")?.defaultValue).toBe(
      "MM/DD/YYYY",
    );

    // null_if: an optional string and an optional string-array.
    const nullIf = fields("null_if");
    expect(nullIf.find((f) => f.key === "value")).toMatchObject({
      kind: "string",
      optional: true,
    });
    expect(nullIf.find((f) => f.key === "values")).toMatchObject({
      kind: "stringArray",
      optional: true,
    });
  });

  test("a no-param function yields no fields", () => {
    expect(
      describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS["squash_spaces"],
      ),
    ).toEqual([]);
  });

  test("every param field carries a non-empty plain-language label", () => {
    for (const name of authorableFunctionNames)
      for (const field of describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS[name],
      )) {
        expect(field.label.length).toBeGreaterThan(0);
        // A camelCase key (the raw snake-free runtime key) must be relabeled, not
        // shown verbatim.
        if (/[A-Z]/.test(field.key)) expect(field.label).not.toBe(field.key);
      }
  });

  test("classifies every authorable descriptor's params into a known widget kind, resolving the deepest wrapper chains", () => {
    // The earlier test samples four descriptors; this proves the Zod unwrapping
    // holds for ALL standard-tier descriptors, so a Zod-internals change cannot
    // silently mis-render a descriptor the sample misses.
    for (const name of authorableFunctionNames)
      for (const field of describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS[name],
      )) {
        expect(["number", "string", "enum", "stringArray"]).toContain(
          field.kind,
        );
        if (field.kind === "enum")
          expect((field.enumOptions ?? []).length).toBeGreaterThan(0);
      }
    // The two deepest wrapper chains: `pad_left.char` is a refine folded under a
    // default (must surface the "0" default as a string), and `coalesce.default` is
    // an optional string (must surface as optional, not required).
    const padChar = describeParamFields(
      STANDARDIZATION_FUNCTION_DESCRIPTORS["pad_left"],
    ).find((f) => f.key === "char");
    expect(padChar).toMatchObject({ kind: "string", defaultValue: "0" });
    const coalesceDefault = describeParamFields(
      STANDARDIZATION_FUNCTION_DESCRIPTORS["coalesce"],
    ).find((f) => f.key === "default");
    expect(coalesceDefault).toMatchObject({ kind: "string", optional: true });
  });
});

describe("every reachable pipeline function is descriptor-backed", () => {
  // `isStepValid` treats a step whose function has no descriptor as valid (it is
  // not authored through this surface). That is only safe because no descriptor-
  // less function can reach the gate: the add menu offers only standard-tier
  // descriptors (parity-tested above) and the recommended default pipelines use
  // only catalogued functions. Pin the second half so a future default step that
  // referenced an uncatalogued function (which would slip the gate and throw at
  // compile) is caught here instead.
  test("every function a default standardization emits has a descriptor", () => {
    const fieldTypes = [
      "first_name",
      "last_name",
      "date_of_birth",
      "ssn",
      "ssn4",
      "phone_number",
      "email_address",
    ] as const;
    const metadata: Array<ColumnMetadata> = fieldTypes.map((type, i) => ({
      name: `c${i}`,
      type,
      role: "linkage",
      isPayload: false,
    }));
    const terms: LinkageTerms = {
      version: "1.0.0",
      identity: "x",
      date: "2026-01-01",
      algorithm: "psi",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields: fieldTypes.map((type, i) => ({ name: `f${i}`, type })),
      linkageKeys: fieldTypes.map((_, i) => ({
        name: `k${i}`,
        elements: [{ field: `f${i}` }],
      })),
    };
    const functions = new Set(
      getDefaultStandardization(metadata, terms).flatMap((t) =>
        (t.steps ?? []).map((s) => s.function),
      ),
    );
    expect(functions.size).toBeGreaterThan(0);
    for (const name of functions) expect(descriptorFor(name)).toBeDefined();
  });
});

describe("param value validation per the descriptor's declared type", () => {
  const substring = STANDARDIZATION_FUNCTION_DESCRIPTORS["substring"];
  const padLeft = STANDARDIZATION_FUNCTION_DESCRIPTORS["pad_left"];

  test("accepts a value matching the param type", () => {
    expect(validateParamValue(substring, "start", 3).ok).toBe(true);
    expect(validateParamValue(substring, "length", 4).ok).toBe(true);
    expect(validateParamValue(padLeft, "char", "0").ok).toBe(true);
  });

  test("rejects a value the descriptor's type forbids", () => {
    // A fractional start, a zero start (positions are 1-indexed), a non-positive
    // length, and a multi-character fill all fail -- exactly as core's factory would.
    expect(validateParamValue(substring, "start", 2.5).ok).toBe(false);
    expect(validateParamValue(substring, "start", 0).ok).toBe(false);
    expect(validateParamValue(substring, "length", 0).ok).toBe(false);
    expect(validateParamValue(padLeft, "char", "ab").ok).toBe(false);
  });

  test("rejects an unknown parameter key", () => {
    expect(validateParamValue(substring, "nope", 1).ok).toBe(false);
  });
});

describe("isStepValid (the launch gate's basis)", () => {
  test("a fully-specified or no-param step is valid", () => {
    expect(
      isStepValid({ function: "substring", params: { start: 1, length: 3 } }),
    ).toBe(true);
    expect(isStepValid({ function: "to_upper_case" })).toBe(true);
    // null_if's value/values are both optional, so an empty step is valid.
    expect(isStepValid({ function: "null_if" })).toBe(true);
  });

  test("a step missing or clearing a required param is invalid", () => {
    // start is required and absent.
    expect(isStepValid({ function: "substring", params: { length: 3 } })).toBe(
      false,
    );
    // start cleared in the NumberInput stores undefined; an empty string is also
    // rejected (defends the runtime even if a "" ever reaches here).
    expect(
      isStepValid({ function: "substring", params: { start: "", length: 3 } }),
    ).toBe(false);
    // pad_left needs a length; a fresh step (char defaulted, no length) is invalid.
    expect(isStepValid({ function: "pad_left", params: { char: "0" } })).toBe(
      false,
    );
  });

  test("a regex-tier default step is valid (its params are not authored here)", () => {
    expect(
      isStepValid({
        function: "replace_regex",
        params: { pattern: "[^0-9]", replacement: "" },
      }),
    ).toBe(true);
    expect(
      isStepValid({
        function: "filter_regex",
        params: { pattern: "^\\d{9}$" },
      }),
    ).toBe(true);
  });

  test("a function core does not recognize is treated as valid", () => {
    expect(isStepValid({ function: "totally_unknown" })).toBe(true);
  });
});

describe("applyStepOverrides (per-field override layer)", () => {
  const base: Standardization = [
    { output: "fn", input: "fname", steps: [{ function: "to_upper_case" }] },
    { output: "ln", input: "lname", steps: [{ function: "to_upper_case" }] },
  ];

  test("applies an override while its input column still matches the binding", () => {
    const overrides = new Map<string, FieldStepOverride>([
      ["fn", { input: "fname", steps: [{ function: "trim_whitespace" }] }],
    ]);
    const result = applyStepOverrides(base, overrides);
    expect(result.find((t) => t.output === "fn")?.steps).toEqual([
      { function: "trim_whitespace" },
    ]);
    // An unrelated field is untouched.
    expect(result.find((t) => t.output === "ln")?.steps).toEqual([
      { function: "to_upper_case" },
    ]);
  });

  test("drops a stale override after the field re-binds to a different column", () => {
    // The field now binds to `notes`, but the override was authored against `fname`.
    const rebased: Standardization = [
      { output: "fn", input: "notes", steps: [{ function: "to_upper_case" }] },
    ];
    const overrides = new Map<string, FieldStepOverride>([
      ["fn", { input: "fname", steps: [{ function: "trim_whitespace" }] }],
    ]);
    // Falls back to the re-derived recommended steps, not the stale override -- so
    // steps authored to clean `fname` never silently drive `notes`.
    expect(applyStepOverrides(rebased, overrides)[0].steps).toEqual([
      { function: "to_upper_case" },
    ]);
  });

  test("no override leaves the base unchanged", () => {
    expect(applyStepOverrides(base, new Map())).toEqual(base);
  });
});

describe("value-level constraint check", () => {
  test("flags a cleaned value that violates a field constraint and passes one that meets it", () => {
    const field: LinkageField = {
      name: "first_name",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z ", exclude: ["TEST"] },
    };
    // A lowercase residue violates allowedCharacters: "A-Z ".
    expect(checkValueConstraints(field, "mary").length).toBeGreaterThan(0);
    // A value on the exclude list violates it.
    expect(
      checkValueConstraints(field, "TEST").some(
        (v) => v.label === "excluded value",
      ),
    ).toBe(true);
    // A conforming cleaned value passes.
    expect(checkValueConstraints(field, "MARY JANE")).toEqual([]);
  });

  test("flags an invalid date only under validOnly", () => {
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
    expect(checkValueConstraints(withConstraint, "20210230").length).toBe(1);
    expect(checkValueConstraints(withConstraint, "20210228")).toEqual([]);
    // No constraint declared -> nothing is flagged.
    expect(checkValueConstraints(withoutConstraint, "20210230")).toEqual([]);
  });

  test("flags every structurally invalid SSN branch under validOnly, and passes valid forms", () => {
    const field: LinkageField = {
      name: "ssn",
      type: "ssn",
      constraints: { validOnly: true },
    };
    const flagged = (value: string) =>
      checkValueConstraints(field, value).some(
        (v) => v.label === "invalid SSN",
      );
    // Each SSA structural rule is its own branch: area 000 / 666 / >= 900, group
    // 00, and serial 0000 are never issued.
    expect(flagged("000223456")).toBe(true);
    expect(flagged("666223456")).toBe(true);
    expect(flagged("900223456")).toBe(true);
    expect(flagged("123003456")).toBe(true); // group 00
    expect(flagged("123450000")).toBe(true); // serial 0000
    // A structurally valid 9-digit value, and a non-9-digit value (left to the
    // format-shaping pipeline, not judged here), are not flagged.
    expect(flagged("123456789")).toBe(false);
    expect(flagged("12345678")).toBe(false);
  });

  test("a partner-crafted allowedCharacters that breaks out of the class cannot stall the check", () => {
    // `allowedCharacters` is partner-controlled and only validated to compile as a
    // `[...]` class body, so this value closes the class and injects a
    // catastrophic-backtracking construct (`^[x](a+)+b[y]...`). Matching the whole
    // value against `^[allowed]*$` would have hung the thread (ReDoS); the check
    // tests one character at a time, so a long crafted value returns promptly and
    // still flags the disallowed input. The test completing under the default
    // timeout is itself the regression guard.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "x](a+)+b[y" },
    };
    const hostile = "x" + "a".repeat(60) + "!";
    expect(
      checkValueConstraints(field, hostile).some(
        (v) => v.label === "disallowed characters",
      ),
    ).toBe(true);
  });

  test("a partner-crafted allowedCharacters cannot silently suppress the disallowed-characters warning", () => {
    // `a]|.*[b` breaks the class into `^[a]|.*[b]$`-shaped alternation that, matched
    // against the whole value, matches anything and would never warn. Tested per
    // character, a genuinely disallowed value is still flagged -- the warning the
    // operator relies on cannot be turned off by class breakout.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "a]|.*[b" },
    };
    expect(
      checkValueConstraints(field, "Z@#$").some(
        (v) => v.label === "disallowed characters",
      ),
    ).toBe(true);
  });

  test("returns nothing for a field with no declared constraints", () => {
    const field: LinkageField = { name: "phone", type: "phone_number" };
    expect(checkValueConstraints(field, "anything")).toEqual([]);
  });
});
