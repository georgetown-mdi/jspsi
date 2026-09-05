import { RE2JS } from "re2js";

// Linear-time regex engine for every partner-supplied transform pattern: the
// four `tier: "regex"` factories (replace_regex, extract_regex, filter_regex,
// split_on) and the regex `parse_date` builds from its format. Replaces
// `RegExp` on these paths because the pattern is unauthenticated and runs per
// row on the single JS thread, where a catastrophic-backtracking pattern
// would hang it; re2js (RE2 semantics: linear time, no backtracking) closes
// that class rather than screening for it. Pure JS, so the CLI and the
// browser run the identical engine build, which PSI's byte-identical keys
// require. The dialect is pinned in docs/spec/PROTOCOL.md ("Transform
// regular-expression dialect") and rejected at terms validation
// (config/transformRegexDialect.ts) before any per-row run; there is no
// fallback to `RegExp`, which would reopen the ReDoS hole.

/**
 * Upper bound on distinct compiled patterns held in {@link compileCache}. This
 * cache dedupes identical pattern sources across distinct steps arrays and
 * across exchanges in a long-lived process; it does not guard a per-row
 * recompile, which the key-building path already avoids on its own. On
 * overflow the oldest entry is evicted. The count bounds in
 * config/linkageTerms.ts keep a single terms set well under this, so a
 * legitimate exchange never evicts mid-build.
 */
const COMPILE_CACHE_MAX = 1024;

/**
 * Memoized compiled patterns, keyed by the exact pattern source. Insertion-
 * ordered (a plain `Map`), so the oldest entry is `keys().next().value`. A
 * pattern that fails to compile is not cached (the `RE2JS.compile` throw
 * propagates), so the cache holds only valid handles.
 */
const compileCache = new Map<string, RE2JS>();

function compileCached(pattern: string): RE2JS {
  const cached = compileCache.get(pattern);
  if (cached !== undefined) return cached;
  // Throws (RE2JSSyntaxException / RE2JSCompileException) on a pattern outside
  // the dialect; the caller decides whether that is a fail-closed reject
  // ({@link patternConformsToDialect}) or a propagated runtime error, mirroring
  // `new RegExp`'s throw for a factory built from an unvalidated pattern.
  const compiled = RE2JS.compile(pattern);
  if (compileCache.size >= COMPILE_CACHE_MAX) {
    const oldest = compileCache.keys().next().value;
    if (oldest !== undefined) compileCache.delete(oldest);
  }
  compileCache.set(pattern, compiled);
  return compiled;
}

/**
 * A compiled transform pattern, exposing exactly the operations the
 * standardization factories need, each matching the `RegExp` operation it
 * replaced for every in-dialect pattern (enforced by the cross-engine
 * equivalence tests). The equivalence covers the PATTERN dialect only;
 * {@link CompiledLinearRegex.replaceAll}'s replacement string resolves under
 * the engine's own rules, which diverge -- see there. Compile once via
 * {@link compileLinearRegex}; call per row.
 */
export interface CompiledLinearRegex {
  /**
   * Replace every match with `replacement`. The `$n`/`$nn`, `$<name>`, `$&`,
   * `` $` ``, `$'`, and `$$` sequences have their usual meanings; an
   * unrecognized sequence is emitted literally. The engine, not
   * `String.prototype.replace`, decides what is recognized, and differs on
   * two cases: a leading-zero reference (`$01`) and an unknown `$<name>` are
   * emitted literally here, where JavaScript resolves the first to group 1
   * and substitutes empty for the second. Normative in docs/spec/PROTOCOL.md
   * (Transform regular-expression dialect); both divergences are checks in
   * test/linearRegex.test.ts.
   */
  replaceAll(input: string, replacement: string): string;
  /**
   * The first capture group of the first match, or the whole match when the
   * pattern has no group, or `null` on no match or an empty result. Mirrors
   * `(m[1] ?? m[0]) || null` for `m = input.match(new RegExp(pattern))`.
   */
  extractFirst(input: string): string | null;
  /**
   * Whether the pattern matches anywhere in `input` (unanchored). Mirrors
   * `new RegExp(pattern).test(input)`.
   */
  test(input: string): boolean;
  /**
   * Whether the pattern matches the ENTIRE `input` (anchored at both ends), as
   * RE2JS `Matcher.matches`. Unlike {@link test} (an unanchored find), a
   * zero-width or leading-substring match does not satisfy it. Mirrors
   * `new RegExp(`^(?:${pattern})$`).test(input)` for an in-dialect pattern.
   * Used where the pattern's own `^`/`$` anchors could be defeated by an
   * alternation breakout (see `withinAllowedCharacters`).
   */
  matches(input: string): boolean;
  /**
   * Split `input` around matches of the pattern. Uses RE2 split semantics:
   * unlike `String.prototype.split`, capture groups in the pattern are NOT
   * emitted as output elements (see the dialect spec). Trailing empty strings
   * are retained (limit < 0), so a caller filtering empties gets the same
   * non-empty parts as `input.split(new RegExp(pattern))` would.
   */
  split(input: string): string[];
  /**
   * The capture groups of the first match as `[group0, group1, ...]` (index 0
   * is the whole match; an unmatched optional group is `null`), or `null` on
   * no match. Used by `parse_date`, whose source anchors with `^...$`, so the
   * first match is the whole-string match. Mirrors reading `m[i]` off
   * `input.match(new RegExp(source))`.
   */
  matchGroups(input: string): (string | null)[] | null;
}

/**
 * Compile `pattern` under the linear-time engine and return the per-row
 * operations. Throws (an `RE2JS` exception) if the pattern is outside the
 * dialect; already-validated terms never hit that throw, since the dialect
 * gate rejected such a pattern at parse time. The operator-local `runPipeline`
 * path does expose it, including for a JavaScript-valid pattern the dialect
 * drops (a backreference or lookaround) -- safe there since the pattern is
 * operator-authored, so the echoed error leaks nothing partner-controlled.
 */
export function compileLinearRegex(pattern: string): CompiledLinearRegex {
  const re = compileCached(pattern);
  return {
    replaceAll: (input, replacement) =>
      re.matcher(input).replaceAll(replacement),
    extractFirst: (input) => {
      const m = re.matcher(input);
      if (!m.find()) return null;
      // groupCount() is the pattern's static capturing-group count, so this
      // asks "does the pattern have a group 1?" exactly as `m[1] !==
      // undefined` does; group(1) is null for a group that did not
      // participate, matching m[1]'s undefined, and "" for one that matched
      // empty, matching m[1]'s "".
      const group1 = m.groupCount() >= 1 ? m.group(1) : null;
      return (group1 ?? m.group(0)) || null;
    },
    test: (input) => re.test(input),
    matches: (input) => re.matcher(input).matches(),
    split: (input) => re.split(input, -1),
    matchGroups: (input) => {
      const m = re.matcher(input);
      if (!m.find()) return null;
      const count = m.groupCount();
      const groups: (string | null)[] = [m.group(0)];
      for (let i = 1; i <= count; i++) groups.push(m.group(i));
      return groups;
    },
  };
}

/**
 * Coerce a partner-supplied transform param to the pattern string the engine
 * compiles. The wire schema leaves transform `params` as `z.unknown()`, so a
 * partner can supply a non-string; `RE2JS.compile` throws a bare `TypeError`
 * on `null`/`undefined`/an array rather than coercing, so the dialect gate
 * and the factories must render the value the same way -- with `String(...)`
 * -- or the gate's verdict would not match what the factory runs. A
 * non-string still runs on the linear-time engine, so it has no ReDoS risk;
 * this only fixes which literal it compiles to.
 */
export function coerceToPatternString(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw);
}

/**
 * Whether `pattern` is in the linear-time dialect: it compiles under the
 * engine. The single conformance oracle for both the terms-validation gate
 * ({@link linkageTermsHaveNonConformantTransformRegex}) and the editor-facing
 * `regexPatternSchema`, so the editor accepts exactly what an exchange will
 * run. Returns `false` on any compile failure, including a feature RE2 drops
 * (backreference, lookaround) -- exactly the patterns that could otherwise
 * backtrack catastrophically.
 */
export function patternConformsToDialect(pattern: string): boolean {
  try {
    compileCached(pattern);
    return true;
  } catch {
    return false;
  }
}
