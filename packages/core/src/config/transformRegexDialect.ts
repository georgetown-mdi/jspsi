import type { LinkageTerms } from "./linkageTerms.js";
import {
  coerceToPatternString,
  patternConformsToDialect,
} from "../utils/linearRegex.js";

// --- Transform-regex dialect conformance -------------------------------------
//
// A linkage-key element transform whose function is a raw-pattern step
// (`replace_regex`, `extract_regex`, `filter_regex`, `split_on`) compiles a
// partner-supplied pattern and runs it per row inside the key-building pipeline
// (see standardization.ts). The pattern arrives inside the inviter's invitation
// token, which is attacker-influenceable -- the token carries only a transcription
// checksum, not an authenticity guarantee (see invitation.ts).
//
// Those patterns execute under the linear-time engine (utils/linearRegex.ts), so
// a catastrophic-backtracking pattern can no longer hang the single JavaScript
// thread: backtracking blow-up is impossible by construction. What remains is a
// dialect-conformance gate: a pattern OUTSIDE the engine's dialect (one re2js
// cannot compile -- a backreference, a lookaround, an unsupported escape) must be
// rejected at terms validation, before any per-row execution and before both
// parties commit to terms they could not evaluate identically. This is fail
// closed and BY CONSTRUCTION -- a pattern that compiles cannot backtrack
// catastrophically -- superseding the best-effort `redos-detector` static screen
// this module replaced. The normative dialect is pinned in docs/spec/PROTOCOL.md
// ("Transform regular-expression dialect").
//
// `parse_date` is deliberately NOT screened here: it is not a raw-pattern step,
// and the regex it builds from its format (parseDateFormat) is library-generated
// and always in-dialect, so there is nothing to reject. Its catastrophic-
// backtracking exposure -- the adjacent `(\d{1,2})` groups its MM/DD tokens expand
// into -- is closed by running it on the same linear-time engine, not by a screen.

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
 * Total wall-clock budget, in milliseconds, for checking dialect conformance
 * across all transform patterns in one linkage-terms validation. The count bounds
 * cap each collection at 256 entries, but their product (keys x elements x steps)
 * is large, so a hostile counterparty could pack enough distinct patterns to make
 * compilation itself a denial of service even though each compile is linear and
 * internally bounded. When the budget is exhausted the remaining patterns are
 * rejected closed (see {@link linkageTermsHaveNonConformantTransformRegex}),
 * bounding total validation cost regardless of pattern count. A legitimate terms
 * set holds a handful of short patterns and finishes in well under a millisecond.
 */
export const REGEX_DIALECT_TOTAL_BUDGET_MS = 2000;

/** Optional overrides for the conformance walk; both defaulted. Exposed so tests
 * can drive the budget-exhaustion path deterministically, and so the schema can
 * pass the source-length bound the gate rejects at. */
export interface RegexDialectBudget {
  /** Total wall-clock budget across all patterns; see
   * {@link REGEX_DIALECT_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /**
   * Upper bound on the COERCED source length (coerceToPatternString) of any one
   * pattern. A source longer than this is rejected on length alone, WITHOUT
   * compiling: an in-dialect source compiles in time super-linear in its length
   * (a ~150 KB pattern takes seconds), a cost a single pattern can incur before
   * the per-step length refine reports it and that the wall-clock budget above
   * cannot interrupt mid-compile. The schema passes its own
   * MAX_TRANSFORM_PATTERN_LENGTH here so the gate rejects at the same threshold
   * the refine does; when omitted (the dialect/budget unit tests) no length
   * bound applies and every coerced source is compiled.
   */
  maxPatternLength?: number;
}

/**
 * Whether any linkage-key element transform in `terms` uses a raw-pattern step
 * whose pattern is OUTSIDE the linear-time dialect (the engine cannot compile it),
 * or whether the conformance budget is exhausted before a pattern is checked
 * (fail closed). Returns `true` to reject. Walks every transform step across all
 * keys and elements; for each raw-pattern step ({@link REGEX_STEP_PATTERN_PARAM})
 * it checks the pattern the factory would compile -- coerced to a string exactly
 * as the factory coerces it ({@link coerceToPatternString}), so the verdict here
 * matches what executes. A coerced source longer than `budget.maxPatternLength`
 * is rejected on length alone, before compiling, so an oversized source cannot
 * make the compile itself a denial of service. An omitted pattern is skipped (the
 * factory compiles it to a degenerate but in-dialect literal); `parse_date` is not
 * a raw-pattern step and is not screened (its generated regex is always
 * in-dialect).
 *
 * The message the caller attaches names no partner-controlled value -- the
 * offending pattern is located by inspection, not echoed -- consistent with the
 * unsanitized parse-error path the referential-integrity refines rely on.
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
        const paramKey = REGEX_STEP_PATTERN_PARAM[step.function];
        if (paramKey === undefined) continue;
        const raw = step.params?.[paramKey];
        // An omitted pattern compiles to a degenerate, in-dialect literal at
        // runtime, so there is nothing to reject (matches the factory).
        if (raw === undefined) continue;

        if (Date.now() - startedAt >= totalBudgetMs) return true;
        const source = coerceToPatternString(raw);
        // Reject an oversized source on length alone, before compiling. An
        // in-dialect source compiles in time super-linear in its length, so a
        // single oversized pattern could otherwise stall validation for seconds
        // -- the budget check above cannot interrupt one in-flight compile. The
        // per-step length refine reports the same rejection with a precise
        // over-length message (MAX_TRANSFORM_PATTERN_LENGTH).
        if (source.length > maxPatternLength) return true;
        if (!patternConformsToDialect(source)) return true;
      }
    }
  }
  return false;
}
