import { expect, test, describe } from "vitest";
import YAML from "yaml";

import { MAX_NAME_LENGTH } from "../../src/config/linkageTermsSchema";
import {
  safeParseStandardization,
  StandardizationSchema,
} from "../../src/config/standardizationSchema";

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

  test("a list param whose every entry is wrong yields one issue, naming the first", () => {
    // A safe parse contracts to RETURN failure. Zod accumulates one issue per
    // addIssue and spreads that array up through each nested frame, so an issue
    // per wrong entry overflows the call stack past roughly 130,000 issues and
    // throws out of safeParse instead. This block is the operator's own and
    // takes no count bound, so the per-param bound is what holds the contract
    // at any width the file can hold.
    const raw = stepSpec(
      { values: Array.from({ length: 200_000 }, () => 0) },
      "null_if",
    );
    let result: ReturnType<typeof safeParseStandardization> | undefined;
    expect(() => {
      result = safeParseStandardization(raw);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    if (!result || result.success) return;
    expect(
      result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
    ).toEqual([
      [
        "0.steps.0.params.values.0",
        "null_if values must hold only text, not a number",
      ],
    ]);
  });

  // A pattern this schema admits is read by the same factories the wire schema
  // feeds, and neither reads one by rendering it to a string: an object can
  // declare `toString` as a value that is not callable, so rendering it throws
  // out of a parse contracted to return failure. The declared type answers
  // every non-text pattern instead, here and on the wire schema
  // (linkageTermsSchema.test.ts).
  test.each([
    ["replace_regex", "pattern", "an object", { toString: "x" }],
    ["split_on", "delimiter", "an object", { toString: "x" }],
    ["replace_regex", "pattern", "a list", ["a", "b"]],
    ["split_on", "delimiter", "a list", ["a", "b"]],
  ] as Array<[string, string, string, unknown]>)(
    "refuses %s %s declared as %s by type, without rendering it",
    (fn, param, label, value) => {
      let result: ReturnType<typeof safeParseStandardization> | undefined;
      expect(() => {
        result = safeParseStandardization(stepSpec({ [param]: value }, fn));
      }).not.toThrow();
      expect(result?.success).toBe(false);
      if (!result || result.success) return;
      expect(result.error.issues.map((i) => i.message)).toEqual([
        `${fn} ${param} must be text, not ${label}; quote the value, or omit the key to leave the param unset`,
      ]);
    },
  );
});

// --- safeParseStandardization ------------------------------------------------
// The on-disk read. A document writes its keys in snake_case, so the block is
// camelized before the schema and the function library see it: the one spelling
// the declared-type check and the factory that reads the param both look up.

describe("safeParseStandardization", () => {
  const document = (params: string) =>
    YAML.parse(
      [
        "- output: dob",
        "  input: DOB",
        "  steps:",
        "    - function: parse_date",
        "      params:",
        params,
      ].join("\n"),
    );

  test("camelizes a step's params", () => {
    const result = safeParseStandardization(
      document(
        "        input_format: DD/MM/YYYY\n        output_format: YYYYMMDD",
      ),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].steps?.[0].params).toEqual({
      inputFormat: "DD/MM/YYYY",
      outputFormat: "YYYYMMDD",
    });
  });

  test("refuses a param the document mistyped, locating it in the step", () => {
    const result = safeParseStandardization(
      document("        input_format: 7"),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
    ).toContainEqual([
      "0.steps.0.params.inputFormat",
      "parse_date inputFormat must be text, not a number; quote the value, or " +
        "omit the key to leave the param unset",
    ]);
  });

  // Nothing of the declared value reaches the refusal here either: the message
  // names its TYPE and the issue path locates it. The operator's own block, so
  // a text param's refusal names the remedy the terms schema's does not.
  const stepSpec = (params: Record<string, unknown>, fn: string) => [
    { output: "last_name", input: "LN", steps: [{ function: fn, params }] },
  ];
  const MARKER = "unrepeatable-param-marker";
  const longMarkerText = MARKER.padEnd(720, "x");
  const QUOTE_REMEDY =
    "; quote the value, or omit the key to leave the param unset";

  test.each([
    {
      name: "a long string in an integer param",
      fn: "substring",
      params: { start: longMarkerText, length: 3 },
      param: "start",
      message: "substring start must be a whole number, not text",
    },
    {
      name: "a long string in a text param, refused for its neighbour",
      fn: "replace_regex",
      params: { pattern: longMarkerText, replacement: 42 },
      param: "replacement",
      message:
        "replace_regex replacement must be text, not a number" + QUOTE_REMEDY,
    },
    {
      name: "an object carrying a marker",
      fn: "coalesce",
      params: { default: { note: MARKER } },
      param: "default",
      message: "coalesce default must be text, not an object" + QUOTE_REMEDY,
    },
    {
      name: "an array carrying a marker",
      fn: "coalesce",
      params: { default: [MARKER] },
      param: "default",
      message: "coalesce default must be text, not a list" + QUOTE_REMEDY,
    },
    {
      name: "a NaN in an integer param",
      fn: "substring",
      params: { start: Number.NaN, length: 3 },
      param: "start",
      message:
        "substring start must be a whole number, not a non-finite number",
    },
    {
      name: "an infinity in an integer param",
      fn: "substring",
      params: { start: Number.NEGATIVE_INFINITY, length: 3 },
      param: "start",
      message:
        "substring start must be a whole number, not a non-finite number",
    },
  ])("$name is refused by type, echoing no part of it", (testCase) => {
    const result = safeParseStandardization(
      stepSpec(testCase.params, testCase.fn),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
    ).toContainEqual([`0.steps.0.params.${testCase.param}`, testCase.message]);
    for (const issue of result.error.issues)
      expect(issue.message).not.toContain(MARKER);
  });

  // YAML writes NaN and the infinities as `.nan` and `.inf`. Neither is a whole
  // number and neither is a fraction, so the refusal names what disqualifies
  // them rather than calling them fractional.
  test.each([[".nan"], [".inf"], ["-.inf"]])(
    "names %s for what it is",
    (written) => {
      const result = safeParseStandardization(
        YAML.parse(
          [
            "- output: dob",
            "  input: DOB",
            "  steps:",
            "    - function: substring",
            "      params:",
            `        start: ${written}`,
            "        length: 3",
          ].join("\n"),
        ),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "substring start must be a whole number, not a non-finite number",
      );
    },
  );
});
