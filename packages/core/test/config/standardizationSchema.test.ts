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
