import { describe, expect, test } from "vitest";

import {
  REGEX_STEP_PATTERN_PARAM,
  linkageTermsHaveNonConformantTransformRegex,
} from "../src/config/transformRegexDialect";
import { STANDARDIZATION_FUNCTION_DESCRIPTORS } from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";

// A terms shape carrying a single element transform, enough for the gate walk.
const termsWith = (
  transform: Array<{ function: string; params?: Record<string, unknown> }>,
): Pick<LinkageTerms, "linkageKeys"> => ({
  linkageKeys: [{ name: "k", elements: [{ field: "ssn", transform }] }],
});

// --- Parity with the regex-tier descriptors ----------------------------------

test("REGEX_STEP_PATTERN_PARAM matches exactly the regex-tier function descriptors", () => {
  const regexTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "regex")
    .map((d) => d.name)
    .sort();
  expect(Object.keys(REGEX_STEP_PATTERN_PARAM).sort()).toEqual(regexTierNames);

  // Each mapped param name is a real (camelCase) param of that function's
  // descriptor, so the gate reads the param the factory actually compiles.
  for (const [fn, param] of Object.entries(REGEX_STEP_PATTERN_PARAM)) {
    const descriptor = STANDARDIZATION_FUNCTION_DESCRIPTORS[fn];
    expect(descriptor).toBeDefined();
    expect(Object.keys(descriptor.params.shape)).toContain(param);
  }
});

// --- Dialect-conformance walk ------------------------------------------------

describe("linkageTermsHaveNonConformantTransformRegex", () => {
  test("returns false for in-dialect raw patterns (including a former-ReDoS one)", () => {
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([
          { function: "filter_regex", params: { pattern: "^\\d{9}$" } },
          { function: "replace_regex", params: { pattern: "[^0-9]" } },
          { function: "split_on", params: { delimiter: "[;,]" } },
          { function: "filter_regex", params: { pattern: "(a+)+$" } },
        ]),
      ),
    ).toBe(false);
  });

  test("returns true for a pattern outside the dialect (backreference)", () => {
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([
          { function: "filter_regex", params: { pattern: "(a)\\1" } },
        ]),
      ),
    ).toBe(true);
  });

  test("returns true for a split_on delimiter outside the dialect (lookahead)", () => {
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([{ function: "split_on", params: { delimiter: "a(?=b)" } }]),
      ),
    ).toBe(true);
  });

  test("does not screen parse_date (its generated regex is always in-dialect)", () => {
    // A format that expands to 24 adjacent `(\d{1,2})` groups -- a backtracking
    // bomb on new RegExp -- is NOT a raw-pattern step, so the gate ignores it; its
    // safety comes from running on the linear-time engine, not this screen.
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([
          { function: "parse_date", params: { inputFormat: "MM".repeat(24) } },
        ]),
      ),
    ).toBe(false);
  });

  test("skips a raw-pattern step with no pattern param", () => {
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([{ function: "filter_regex", params: {} }]),
      ),
    ).toBe(false);
  });

  test("coerces a non-string pattern before checking, matching the factory", () => {
    // String(5) === "5", an in-dialect literal -> conformant, as the factory runs.
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([{ function: "filter_regex", params: { pattern: 5 } }]),
      ),
    ).toBe(false);
  });

  test("returns true for a single in-dialect pattern over the per-pattern program-size cap", () => {
    // `(.*){1000}` compiles (~4000 instructions) but exceeds the per-pattern cap, so
    // it is rejected on program size, not on an unsupported feature.
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([
          { function: "filter_regex", params: { pattern: "(.*){1000}" } },
        ]),
      ),
    ).toBe(true);
  });

  test("returns true when many under-cap patterns exceed the aggregate program-size cap", () => {
    // Each `(b*b*){42}` is ~254 instructions -- under the per-pattern cap -- but
    // chaining enough of them exceeds the aggregate cap across the whole terms set,
    // the step-count amplification the per-pattern cap alone does not bound. ~8 such
    // steps fit under the 2048 budget; 16 do not.
    const amp = {
      function: "replace_regex",
      params: { pattern: "(b*b*){42}" },
    };
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith(Array.from({ length: 8 }, () => amp)),
      ),
    ).toBe(false);
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith(Array.from({ length: 16 }, () => amp)),
      ),
    ).toBe(true);
  });

  test("rejects (fail closed) when the conformance budget is exhausted", () => {
    // A zero budget exhausts before the first pattern is checked, so any terms set
    // with a raw-pattern step rejects closed -- the DoS bound against a terms set
    // packed with patterns.
    expect(
      linkageTermsHaveNonConformantTransformRegex(
        termsWith([
          { function: "filter_regex", params: { pattern: "^\\d+$" } },
        ]),
        { totalBudgetMs: 0 },
      ),
    ).toBe(true);
  });
});
