import type { LinkageTerms } from "./linkageTermsSchema.js";
import {
  coerceToPatternString,
  patternConformsToDialect,
} from "../utils/linearRegex.js";

// --- Transform-regex dialect conformance -------------------------------------
//
// A linkage-key transform step (replace_regex, extract_regex, filter_regex,
// split_on) compiles a partner-supplied pattern and runs it per row (see
// standardization.ts). The pattern arrives in the invitation token, which
// carries a transcription checksum only, not an authenticity guarantee.
//
// Patterns run on the linear-time engine (utils/linearRegex.ts), which
// closes catastrophic backtracking. What remains is dialect conformance: a
// pattern outside the engine's dialect must be rejected at terms
// validation, before either party commits to terms it cannot evaluate
// identically. Fail closed. Normative dialect: docs/spec/PROTOCOL.md
// ("Transform regular-expression dialect").
//
// parse_date is not screened: its regex is library-generated and always
// in-dialect; its own backtracking exposure is closed by the same engine.

/**
 * Which `params` key carries the raw partner-controlled pattern for each
 * raw-pattern standardization function. These are exactly the functions whose
 * descriptor in {@link STANDARDIZATION_FUNCTION_DESCRIPTORS} carries
 * `tier: "regex"`; a parity test pins the two together so neither can gain or
 * lose a member without the other.
 */
export const REGEX_STEP_PATTERN_PARAM: Readonly<Record<string, string>> = {
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
};

/**
 * The `params` key holding the raw pattern of a step naming `functionName`, or
 * `undefined` where the function has none. Read through this rather than by a
 * bare index: the function name is partner-authored free text, and the table is
 * a total `Record`, so an index answers a name reaching only `Object.prototype`
 * (`constructor`, `toString`) with an inherited member instead of `undefined`.
 */
export function regexStepPatternParam(
  functionName: string,
): string | undefined {
  return Object.hasOwn(REGEX_STEP_PATTERN_PARAM, functionName)
    ? REGEX_STEP_PATTERN_PARAM[functionName]
    : undefined;
}

/**
 * Total wall-clock budget, in milliseconds, for checking dialect
 * conformance across all transform patterns in one linkage-terms
 * validation. Each collection caps at 256 entries, but their product (keys
 * x elements x steps) is large enough that a hostile counterparty could
 * make compilation itself a denial of service. Once exhausted, remaining
 * patterns are rejected closed (see
 * {@link linkageTermsHaveNonConformantTransformRegex}). A legitimate terms
 * set finishes in well under a millisecond.
 */
const REGEX_DIALECT_TOTAL_BUDGET_MS = 2000;

/** Optional overrides for the conformance walk; both defaulted. Exposed so tests
 * can drive the budget-exhaustion path deterministically, and so the schema can
 * pass the source-length bound the gate rejects at. */
interface RegexDialectBudget {
  /** Total wall-clock budget across all patterns; see
   * {@link REGEX_DIALECT_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /**
   * Upper bound on the coerced source length (coerceToPatternString) of any
   * one pattern; a longer source is rejected on length alone, without
   * compiling, since an in-dialect source can compile in time super-linear
   * in its length (a ~150 KB pattern takes seconds) and the wall-clock
   * budget above cannot interrupt mid-compile. The schema passes its own
   * MAX_TRANSFORM_PATTERN_LENGTH here so both reject at the same threshold;
   * omitted (unit tests only), every coerced source is compiled.
   */
  maxPatternLength?: number;
}

/**
 * Whether any linkage-key transform in `terms` uses a raw-pattern step
 * whose pattern is outside the linear-time dialect, or the conformance
 * budget runs out before a pattern is checked (fail closed). Returns
 * `true` to reject. Checks the pattern the factory would compile, coerced
 * the same way ({@link coerceToPatternString}), so the verdict matches
 * what executes; a source longer than `budget.maxPatternLength` is
 * rejected on length alone, before compiling. An omitted pattern is
 * skipped (compiles to an in-dialect literal); `parse_date` is not
 * screened (its generated regex is always in-dialect).
 *
 * The caller's message names no partner-controlled value: the offending
 * pattern is located by inspection, not echoed.
 */
export function linkageTermsHaveNonConformantTransformRegex(
  terms: Pick<LinkageTerms, "linkageKeys">,
  budget: RegexDialectBudget = {},
): boolean {
  const totalBudgetMs = budget.totalBudgetMs ?? REGEX_DIALECT_TOTAL_BUDGET_MS;
  const maxPatternLength = budget.maxPatternLength ?? Infinity;
  const startedAt = Date.now();

  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      for (const step of element.transform ?? []) {
        const paramKey = regexStepPatternParam(step.function);
        if (paramKey === undefined) continue;
        const raw = step.params?.[paramKey];
        // An omitted pattern compiles to a degenerate, in-dialect literal at
        // runtime, so there is nothing to reject (matches the factory).
        if (raw === undefined) continue;

        if (Date.now() - startedAt >= totalBudgetMs) return true;
        const source = coerceToPatternString(raw);
        // Reject an oversized source on length alone, before compiling: an
        // in-dialect source compiles in time super-linear in its length, and
        // the wall-clock budget above cannot interrupt one in-flight compile.
        // The per-step length refine reports the same rejection with a
        // precise over-length message (MAX_TRANSFORM_PATTERN_LENGTH).
        if (source.length > maxPatternLength) return true;
        if (!patternConformsToDialect(source)) return true;
      }
    }
  }
  return false;
}
