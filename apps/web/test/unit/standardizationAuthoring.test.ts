import { describe, expect, test } from "vitest";

import { STANDARDIZATION_FUNCTION_DESCRIPTORS } from "@psilink/core";

import {
  STANDARDIZATION_FUNCTION_GROUPS,
  authorableFunctionNames,
  checkValueConstraints,
  describeParamFields,
  functionDisplay,
  isStepValid,
  validateParamValue,
} from "../../src/psi/standardizationAuthoring.js";

import type { LinkageField } from "@psilink/core";

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

  test("flags a structurally invalid SSN under validOnly", () => {
    const field: LinkageField = {
      name: "ssn",
      type: "ssn",
      constraints: { validOnly: true },
    };
    // Area 000 is never issued.
    expect(checkValueConstraints(field, "000123456").length).toBe(1);
    expect(checkValueConstraints(field, "123456789")).toEqual([]);
  });

  test("returns nothing for a field with no declared constraints", () => {
    const field: LinkageField = { name: "phone", type: "phone_number" };
    expect(checkValueConstraints(field, "anything")).toEqual([]);
  });
});
