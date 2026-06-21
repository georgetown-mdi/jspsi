import { describe, expect, test } from "vitest";

import {
  transformPatternIsUnsafe,
  linkageTermsHaveUnsafeTransformRegex,
  REGEX_STEP_PATTERN_PARAM,
  KNOWN_SAFE_TRANSFORM_PATTERNS,
  MAX_ANALYZED_PATTERN_LENGTH,
  REGEX_ANALYSIS_PER_PATTERN_MS,
} from "../src/config/transformRegexSafety";
import type { LinkageTerms, TransformStep } from "../src/config/linkageTerms";
import {
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  STANDARDIZATION_FUNCTION_NAMES,
} from "../src/standardization";
import { getDefaultStandardization } from "../src/defaults/standardization";
import { SEMANTIC_TYPES } from "../src/types";
import type { Metadata } from "../src/config/metadata";
import { isSafePattern } from "redos-detector";

// A budget generous enough that timing never decides a correctness assertion.
const BUDGET = { totalBudgetMs: 10000, perPatternMaxMs: 1000 };

// Build the minimal terms shape the analyzer reads: one key, one element holding
// the given transform steps.
function termsWith(steps: TransformStep[]): Pick<LinkageTerms, "linkageKeys"> {
  return {
    linkageKeys: [{ name: "k", elements: [{ field: "f", transform: steps }] }],
  };
}

// ─── Per-pattern analysis: transformPatternIsUnsafe ──────────────────────────

describe("transformPatternIsUnsafe", () => {
  // The catastrophic patterns the heuristic must catch. The star-height-1
  // exponential and quadratic cases (the bottom four) are the ones a naive
  // nesting check would miss; the path-enumeration analyzer catches them.
  test.each([
    "(a+)+$",
    "(.*a){20}",
    "([a-z]+)*$",
    "(a|aa)+$",
    "(a|a)*$",
    "\\s*\\s*$",
    "a*a*$",
  ])("rejects catastrophic pattern %j", (pattern) => {
    expect(
      transformPatternIsUnsafe(pattern, REGEX_ANALYSIS_PER_PATTERN_MS),
    ).toBe(true);
  });

  test.each([
    "[^0-9]",
    "^\\d{9}$",
    "(\\d{4})$",
    "[A-Z]",
    "^1(\\d{10})$",
    "abc",
    "[a-z]+",
    "\\d{3}-\\d{4}",
  ])("accepts safe pattern %j", (pattern) => {
    expect(
      transformPatternIsUnsafe(pattern, REGEX_ANALYSIS_PER_PATTERN_MS),
    ).toBe(false);
  });

  test("passes a pattern that does not compile so the runtime SyntaxError boundary handles it", () => {
    // An invalid pattern is not a backtracking risk here: the standardization
    // factory's own new RegExp(...) throws on it at runtime and the exchange
    // aborts through the existing sanitized error boundary. The analyzer must not
    // pre-empt that, so it reports the pattern as not-unsafe (false).
    for (const invalid of ["(", "[", "\\", "(?<=", "*"]) {
      let compiles = true;
      try {
        new RegExp(invalid);
      } catch {
        compiles = false;
      }
      expect(compiles).toBe(false); // guard: these really are invalid
      expect(
        transformPatternIsUnsafe(invalid, REGEX_ANALYSIS_PER_PATTERN_MS),
      ).toBe(false);
    }
  });

  test("rejects a compilable pattern the analyzer cannot parse (named groups), fail closed", () => {
    // V8 accepts a named capture group but redos-detector's parser throws on it;
    // an unanalyzable pattern is rejected closed rather than waved through.
    expect(new RegExp("(?<name>a)b").source).toBe("(?<name>a)b"); // V8-valid
    expect(
      transformPatternIsUnsafe("(?<name>a)b", REGEX_ANALYSIS_PER_PATTERN_MS),
    ).toBe(true);
  });

  test("rejects an over-length pattern before analyzing it", () => {
    const longSafe = "a".repeat(MAX_ANALYZED_PATTERN_LENGTH + 1);
    expect(new RegExp(longSafe).source.length).toBe(
      MAX_ANALYZED_PATTERN_LENGTH + 1,
    );
    expect(
      transformPatternIsUnsafe(longSafe, REGEX_ANALYSIS_PER_PATTERN_MS),
    ).toBe(true);
  });

  test("rejects a pattern the analyzer cannot certify within budget (fail closed on resource limit)", () => {
    // 100 nested optional groups. V8 runs this in microseconds -- it is NOT
    // catastrophic -- but redos-detector's path enumeration cannot clear its state
    // space within any small budget and returns a resource-limit verdict
    // (`timedOut`, safe:false) rather than certifying it. The whole control's
    // fail-closed property rests on a "could not certify" verdict mapping to
    // reject, not accept; this pins both the library's resource-limit -> unsafe
    // contract and the wrapper's reject on it, so a future redos-detector that maps
    // a timeout to safe:true (a silent fail-open) fails this test rather than
    // shipping. The pattern times out even at a multi-second budget, so the tiny
    // budget here makes the verdict machine-independent.
    const uncertifiable = "(?:".repeat(100) + "a" + ")?".repeat(100);
    expect(uncertifiable.length).toBeLessThanOrEqual(
      MAX_ANALYZED_PATTERN_LENGTH,
    );
    const verdict = isSafePattern(uncertifiable, {
      maxScore: 200,
      maxSteps: 20000,
      timeout: 1,
    });
    expect(verdict.safe).toBe(false); // library cannot certify -> unsafe
    expect(transformPatternIsUnsafe(uncertifiable, 1)).toBe(true); // wrapper rejects
  });
});

// ─── Whole-terms walk: linkageTermsHaveUnsafeTransformRegex ──────────────────

describe("linkageTermsHaveUnsafeTransformRegex", () => {
  // Every regex-based function, with the catastrophic pattern under its own
  // pattern-carrying param (split_on reads `delimiter`, not `pattern`).
  test.each([
    ["replace_regex", { pattern: "(a+)+$", replacement: "" }],
    ["extract_regex", { pattern: "(a+)+$" }],
    ["filter_regex", { pattern: "(a+)+$" }],
    ["split_on", { delimiter: "(a+)+$" }],
  ])("rejects a catastrophic pattern in %s", (fn, params) => {
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: fn, params }]),
        BUDGET,
      ),
    ).toBe(true);
  });

  test("accepts the bundled email default via the allowlist", () => {
    const email = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
    expect(KNOWN_SAFE_TRANSFORM_PATTERNS.has(email)).toBe(true);
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: "filter_regex", params: { pattern: email } }]),
        BUDGET,
      ),
    ).toBe(false);
  });

  test("accepts a non-regex transform step (substring) untouched", () => {
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: "substring", params: { start: 1, length: 3 } }]),
        BUDGET,
      ),
    ).toBe(false);
  });

  test("treats an absent pattern as safe (compiles to the empty regex)", () => {
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: "filter_regex" }]),
        BUDGET,
      ),
    ).toBe(false);
  });

  test("coerces a non-string pattern as new RegExp would, so a dangerous array cannot slip past", () => {
    // new RegExp(["(a+)+$"]) compiles /(a+)+$/, so the array value is exactly as
    // dangerous as the string and must be rejected the same way.
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([
          { function: "filter_regex", params: { pattern: ["(a+)+$"] } },
        ]),
        BUDGET,
      ),
    ).toBe(true);
  });

  test("rejects closed when the analysis budget is exhausted before vetting a pattern", () => {
    // A non-allowlisted, compilable, genuinely-safe pattern: it is rejected only
    // because the zero budget is exhausted before it can be analyzed.
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: "filter_regex", params: { pattern: "abc" } }]),
        { totalBudgetMs: 0 },
      ),
    ).toBe(true);
    // The same pattern under a normal budget is accepted, proving the rejection
    // above is the budget, not the pattern.
    expect(
      linkageTermsHaveUnsafeTransformRegex(
        termsWith([{ function: "filter_regex", params: { pattern: "abc" } }]),
        BUDGET,
      ),
    ).toBe(false);
  });
});

// ─── Registry parity and bundled-default drift guards ────────────────────────

test("REGEX_STEP_PATTERN_PARAM matches exactly the regex-tier function descriptors", () => {
  const regexTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "regex")
    .map((d) => d.name)
    .sort();
  expect(Object.keys(REGEX_STEP_PATTERN_PARAM).sort()).toEqual(regexTierNames);
  // Each mapped param is a real param on the function's descriptor schema.
  for (const [fn, param] of Object.entries(REGEX_STEP_PATTERN_PARAM)) {
    expect(
      Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS[fn].params.shape),
    ).toContain(param);
  }
});

test("every regex pattern in the bundled default standardization is allowlisted", () => {
  // Build the default standardization across every semantic type, then collect
  // the raw pattern strings its regex steps carry. If a future default adds a
  // regex pattern that is not on the allowlist, this fails -- the guard against an
  // over-aggressive heuristic rejecting a pattern the project itself ships.
  const types = SEMANTIC_TYPES.filter(
    (t) => t !== "identifier" && t !== "other",
  );
  const metadata: Metadata = types.map((type) => ({
    name: `col_${type}`,
    type,
    role: "linkage",
    isPayload: false,
  }));
  const terms = {
    version: "1.0.0",
    identity: "drift-test",
    date: "2025-01-01",
    algorithm: "psi" as const,
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: types.map((type) => ({ name: type, type })),
    linkageKeys: [
      { name: "k", elements: types.map((type) => ({ field: type })) },
    ],
  } as LinkageTerms;

  const standardization = getDefaultStandardization(metadata, terms);
  const bundledPatterns = new Set<string>();
  for (const transform of standardization) {
    for (const step of transform.steps ?? []) {
      const paramKey = REGEX_STEP_PATTERN_PARAM[step.function];
      if (paramKey === undefined) continue;
      const value = step.params?.[paramKey];
      if (typeof value === "string") bundledPatterns.add(value);
    }
  }

  // Sanity: the build really did surface the regex defaults (e.g. the SSN and
  // email filters), so an empty walk cannot vacuously pass.
  expect(bundledPatterns.size).toBeGreaterThan(0);
  for (const pattern of bundledPatterns) {
    expect(KNOWN_SAFE_TRANSFORM_PATTERNS.has(pattern)).toBe(true);
  }
  // Coverage check: STANDARDIZATION_FUNCTION_NAMES includes the regex functions,
  // so the parity map is non-empty and this drift test is meaningful.
  expect(STANDARDIZATION_FUNCTION_NAMES).toContain("filter_regex");
});
