import { expect, test, describe } from "vitest";

import { MAX_NAME_LENGTH } from "../../src/config/linkageTermsSchema";
import { StandardizationSchema } from "../../src/config/standardizationSchema";

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

  // The pair is held at MAX_NAME_LENGTH rather than at a round number of its
  // own: that is the ceiling every other declared name has, so a length one of
  // these accepts is a length a linkage field or a CSV header also holds.
  // Driven at the boundary and one past it, in both fields.
  test("accepts an output and an input at the name-length boundary", () => {
    const atBound = "n".repeat(MAX_NAME_LENGTH);
    expect(() =>
      StandardizationSchema.parse([{ output: atBound, input: atBound }]),
    ).not.toThrow();
  });

  test.each([["output"], ["input"]])(
    "rejects a %s one character past the name-length bound",
    (field) => {
      const raw = [
        {
          output: "last_name",
          input: "LN",
          [field]: "n".repeat(MAX_NAME_LENGTH + 1),
        },
      ];
      expect(() => StandardizationSchema.parse(raw)).toThrow();
    },
  );
});

// --- Declared step param types -----------------------------------------------
// A cleaning step is the operator's own, and an unquoted number or a bare
// `null` is the way a YAML document mistypes one. The schema reads each param
// as the type its function reads, so the mistake is reported where the config
// is decoded rather than changing what the run matches on.

describe("StandardizationSchema declared param types", () => {
  const stepSpec = (params: Record<string, unknown>, fn = "replace_regex") => [
    { output: "last_name", input: "LN", steps: [{ function: fn, params }] },
  ];

  test.each([
    [
      "a numeric replace_regex replacement",
      stepSpec({ pattern: "-", replacement: 42 }),
      /replace_regex replacement must be text, not a number/,
    ],
    [
      "a numeric pad_left char",
      stepSpec({ length: 9, char: 5 }, "pad_left"),
      /pad_left char must be text, not a number/,
    ],
    [
      "a null coalesce default",
      stepSpec({ default: null }, "coalesce"),
      /coalesce default must be text, not null/,
    ],
  ])("refuses %s", (_name, raw, message) => {
    const result = StandardizationSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => message.test(i.message))).toBe(true);
  });

  test("a param written as text parses unchanged", () => {
    const result = StandardizationSchema.safeParse(
      stepSpec({ pattern: "-", replacement: "42" }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].steps?.[0].params).toEqual({
      pattern: "-",
      replacement: "42",
    });
  });

  test("an omitted param parses, since that is how a step takes the default", () => {
    expect(
      StandardizationSchema.safeParse(stepSpec({ pattern: "-" })).success,
    ).toBe(true);
  });
});
