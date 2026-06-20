import { isSafePattern } from "redos-detector";
import type { LinkageTerms } from "./linkageTerms.js";

// --- Catastrophic-backtracking (ReDoS) rejection -----------------------------
//
// A linkage-key element transform whose function is a regex step
// (`replace_regex`, `extract_regex`, `filter_regex`, `split_on`) compiles a
// partner-supplied pattern with `new RegExp(...)` and runs it per row inside the
// key-building pipeline (see standardization.ts). The pattern arrives inside the
// inviter's invitation token, which is attacker-influenceable -- the token
// carries only a transcription checksum, not an authenticity guarantee -- so a
// crafted catastrophic-backtracking pattern run over the acceptor's full dataset
// would hang the single JavaScript thread (a browser tab freeze on the web path,
// a hung process on the CLI). The pattern cannot be sanitized (PSI requires both
// parties to derive byte-identical keys, and the terms are hashed into the
// exchange-agreement receipt, so a unilateral rewrite both breaks matching and is
// detected as a mismatch) and JavaScript regex evaluation is synchronous and not
// interruptible on the main thread, so it cannot be time-bounded at runtime. The
// only fail-closed move is to reject a dangerous pattern at terms validation,
// before any per-row execution. This is the interim heuristic; item 202724227
// supersedes it with a linear-time engine whose dialect is pinned in the spec.
//
// This is a BEST-EFFORT heuristic: a static analyzer reduces but does not
// eliminate the class. A sophisticated pattern may evade it (a false negative);
// a legitimate-but-complex pattern may be over-rejected (a false positive). Both
// outcomes fail closed -- no data is exchanged and no thread hangs -- and a
// rejection is the correct response to a malicious counterparty regardless.

/**
 * Which `params` key carries the raw partner-controlled pattern for each
 * regex-based standardization function. These are exactly the functions whose
 * descriptor in {@link STANDARDIZATION_FUNCTION_DESCRIPTORS} carries
 * `tier: "regex"`; a parity test pins the two together so neither can gain or
 * lose a member without the other. `replace_regex` runs its pattern with the
 * global (`g`) flag, which does not affect backtracking, so the pattern string is
 * analyzed flag-independently.
 */
export const REGEX_STEP_PATTERN_PARAM: Readonly<Record<string, string>> = {
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
};

/**
 * Regex patterns the project ships and has vetted as safe, which bypass the
 * analyzer. Seeded with every regex pattern in the bundled default
 * standardization (`defaults/standardization.ts`); a drift test asserts that set
 * stays a subset of this one. The bundled email filter
 * `^[^\s@]+@[^\s@]+\.[^\s@]+$` is the reason this allowlist exists: it has three
 * top-level `+` quantifiers but no nested quantifier (it is linear in practice),
 * yet the conservative path-enumeration analyzer flags it. Allowlisting the
 * vetted defaults keeps the heuristic from blocking a legitimate exchange that
 * reuses one in a key-element transform, satisfying the do-not-reject-the-defaults
 * requirement by construction. An entry is matched by exact pattern string, so it
 * cannot be used to smuggle a different (dangerous) pattern past the analyzer.
 */
export const KNOWN_SAFE_TRANSFORM_PATTERNS: ReadonlySet<string> = new Set([
  "[^0-9]",
  "^\\d{9}$",
  "(\\d{4})$",
  "^\\d{4}$",
  "[A-Z]",
  "^1(\\d{10})$",
  "^\\d{10}$",
  "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
]);

/**
 * Upper bound on the length of a pattern the analyzer will inspect. A real
 * transform pattern is short; an over-long one is rejected closed rather than
 * analyzed. This bounds the analyzer's own cost: redos-detector's `timeout`
 * covers its analysis loop but NOT the up-front parse, and `new RegExp` compiles
 * the whole literal, so a multi-kilobyte pattern could burn unbounded time before
 * any time budget engages.
 */
export const MAX_ANALYZED_PATTERN_LENGTH = 1000;

// redos-detector budget knobs, pinned to its documented defaults so a future
// version's default change cannot silently shift the safe/unsafe verdict of this
// security check. `maxScore` is the ambiguity-score ceiling above which a pattern
// is reported unsafe; `maxSteps` bounds the analysis-loop work.
const REGEX_ANALYSIS_MAX_SCORE = 200;
const REGEX_ANALYSIS_MAX_STEPS = 20000;

/**
 * Total wall-clock budget, in milliseconds, for analyzing all regex patterns in
 * one linkage-terms validation. The existing count bounds cap each collection at
 * 256 entries, but their product (keys x elements x steps) is large, so a hostile
 * counterparty could pack enough patterns to make analysis itself a denial of
 * service. When the budget is exhausted the remaining patterns are rejected
 * closed (see {@link linkageTermsHaveUnsafeTransformRegex}), bounding total
 * validation cost regardless of pattern count.
 */
export const REGEX_ANALYSIS_TOTAL_BUDGET_MS = 2000;

/**
 * Upper bound, in milliseconds, on the analysis budget handed to any single
 * pattern, so one pathological pattern cannot consume the whole
 * {@link REGEX_ANALYSIS_TOTAL_BUDGET_MS} and starve the rest.
 */
export const REGEX_ANALYSIS_PER_PATTERN_MS = 250;

/** Optional overrides for the analysis budget; defaulted from the constants
 * above. Exposed so tests can drive the budget-exhaustion path deterministically. */
export interface RegexAnalysisBudget {
  /** Total wall-clock budget across all patterns; see
   * {@link REGEX_ANALYSIS_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /** Per-pattern analysis cap; see {@link REGEX_ANALYSIS_PER_PATTERN_MS}. */
  perPatternMaxMs?: number;
}

/**
 * Whether a single regex `source` is unsafe (catastrophic-backtracking risk)
 * under a `timeoutMs` analysis budget. Returns `true` to reject, `false` to
 * accept.
 *
 * Order matters and each step is fail-closed except the deliberate
 * SyntaxError passthrough:
 * - An over-{@link MAX_ANALYZED_PATTERN_LENGTH} pattern is rejected before either
 *   engine touches it (parse-cost bound).
 * - A pattern `new RegExp` cannot compile is NOT this check's concern: the
 *   factory's own `new RegExp(...)` throws on it at runtime and the exchange
 *   aborts through the existing sanitized error boundary. It passes here so that
 *   boundary, not this one, handles it -- preserving that behavior.
 * - A compilable pattern is analyzed; a non-safe verdict rejects it.
 * - redos-detector's regjsparser rejects some patterns V8 accepts (e.g. named
 *   capture groups). Such a pattern cannot be vetted, so it is rejected closed.
 *
 * @internal Exported for unit tests; not a supported entry point.
 */
export function transformPatternIsUnsafe(
  source: string,
  timeoutMs: number,
): boolean {
  if (source.length > MAX_ANALYZED_PATTERN_LENGTH) return true;
  try {
    new RegExp(source);
  } catch {
    return false;
  }
  try {
    const result = isSafePattern(source, {
      maxScore: REGEX_ANALYSIS_MAX_SCORE,
      maxSteps: REGEX_ANALYSIS_MAX_STEPS,
      timeout: timeoutMs,
    });
    return !result.safe;
  } catch {
    return true;
  }
}

/**
 * Whether any linkage-key element transform in `terms` uses a regex pattern that
 * is a catastrophic-backtracking risk. Walks every regex step
 * ({@link REGEX_STEP_PATTERN_PARAM}) across all keys, elements, and transform
 * steps and returns `true` on the first unsafe pattern (so a packed bomb is
 * caught early), or when the analysis budget is exhausted before a pattern is
 * vetted (fail closed).
 *
 * A present pattern value is coerced to a string exactly as `new RegExp` would
 * coerce it, so a non-string JSON value that stringifies to a dangerous pattern
 * cannot slip past by virtue of its type -- including a JSON `null`, which both
 * the runtime factory and this check render as the literal regex `/null/`. Only
 * an omitted pattern (`undefined`) is skipped: it compiles to the empty regex at
 * runtime, which is safe. Vetted bundled patterns
 * ({@link KNOWN_SAFE_TRANSFORM_PATTERNS}) bypass the analyzer.
 */
export function linkageTermsHaveUnsafeTransformRegex(
  terms: Pick<LinkageTerms, "linkageKeys">,
  budget: RegexAnalysisBudget = {},
): boolean {
  const totalBudgetMs = budget.totalBudgetMs ?? REGEX_ANALYSIS_TOTAL_BUDGET_MS;
  const perPatternMaxMs =
    budget.perPatternMaxMs ?? REGEX_ANALYSIS_PER_PATTERN_MS;
  const startedAt = Date.now();

  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      for (const step of element.transform ?? []) {
        const paramKey = REGEX_STEP_PATTERN_PARAM[step.function];
        if (paramKey === undefined) continue;
        const raw = step.params?.[paramKey];
        if (raw === undefined) continue;
        const source = typeof raw === "string" ? raw : String(raw);
        if (KNOWN_SAFE_TRANSFORM_PATTERNS.has(source)) continue;

        const remainingMs = totalBudgetMs - (Date.now() - startedAt);
        if (remainingMs <= 0) return true;
        if (
          transformPatternIsUnsafe(
            source,
            Math.min(perPatternMaxMs, remainingMs),
          )
        )
          return true;
      }
    }
  }
  return false;
}
