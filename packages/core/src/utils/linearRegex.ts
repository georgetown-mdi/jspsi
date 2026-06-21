import { RE2JS } from "re2js";

// --- Linear-time transform-regex engine --------------------------------------
//
// The engine that executes every partner-supplied transform pattern -- the four
// `tier: "regex"` factories (`replace_regex`, `extract_regex`, `filter_regex`,
// `split_on`) and the regex `parse_date` builds from its partner-controlled input
// format (see standardization.ts). It replaces the JavaScript `RegExp` engine on
// exactly these paths.
//
// Why: those patterns arrive inside an invitation token / over the exchange wire
// from a counterparty whose payload passed only a transcription checksum, not an
// authenticity guarantee, and they run per row over the acceptor's full dataset
// on the single, non-interruptible JavaScript thread. A crafted catastrophic-
// backtracking ("ReDoS") pattern on `new RegExp` would hang that thread -- a
// browser-tab freeze on the web path, a hung process on the CLI. re2js is an
// RE2-semantics engine (a Thompson NFA / lazy DFA): its matching is linear in the
// input length and it has no backtracking, so the blow-up is impossible BY
// CONSTRUCTION rather than screened for heuristically. This supersedes the
// best-effort `redos-detector` static screen that previously guarded these paths.
//
// re2js is pure JavaScript, so the SAME engine build runs identically in the CLI
// (Node) and the web (browser). Both parties and both build targets therefore
// derive byte-identical keys, which PSI requires -- there is no second engine
// build whose semantics could diverge from the first on an adversarial pattern.
// The standardization pipeline around it is already pure cross-target JavaScript
// (NFC, case-folding, the canonical encoder), proven byte-identical by the
// cross-build vector tests; this keeps regex execution inside that same model.
//
// The permitted pattern dialect is pinned normatively in docs/spec/PROTOCOL.md
// ("Transform regular-expression dialect"). A pattern outside it -- one re2js
// cannot compile, e.g. a backreference or lookaround, which RE2 drops -- is
// rejected at terms validation (config/transformRegexDialect.ts), before any
// per-row execution. There is deliberately NO fallback to `new RegExp`: a pattern
// this engine cannot compile fails closed, never silently re-runs on the
// backtracking engine, which would reopen the ReDoS hole.

/**
 * Upper bound on the number of distinct compiled patterns held in
 * {@link compileCache}. The per-row key-building path recompiles each element
 * transform per row ({@link applyElementTransform}), so without memoization a
 * dataset of N rows would recompile the same pattern N times; the cache makes the
 * compile pay once per distinct pattern. The bound keeps a long-lived process
 * (many exchanges, each with its own partner-controlled patterns) from growing
 * the cache without limit -- on overflow the oldest entry is evicted. A single
 * terms set holds far fewer distinct patterns than this (the count bounds in
 * config/linkageTerms.ts cap keys/elements/steps), so a legitimate exchange never
 * evicts mid-build.
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
  // Throws (RE2JSSyntaxException / RE2JSCompileException) on a pattern outside the
  // dialect; the caller decides whether that is a fail-closed reject
  // ({@link patternConformsToDialect}) or a propagated runtime error (a factory
  // built from an unvalidated pattern, mirroring the old `new RegExp` throw).
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
 * standardization factories need, each defined to be byte-identical to the
 * JavaScript `RegExp` operation it replaced for every in-dialect pattern (pinned
 * by the cross-engine equivalence tests). Compile once via
 * {@link compileLinearRegex}; call per row.
 */
export interface CompiledLinearRegex {
  /**
   * Replace every match with `replacement`, as `String.prototype.replace` with a
   * global regex does. `replacement` uses `$n` / `$&` / `$$` group-reference
   * syntax identical to JavaScript's; an unknown `$n` is emitted literally.
   * Mirrors `s.replace(new RegExp(pattern, "g"), replacement)`.
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
   * Split `input` around matches of the pattern. Uses RE2 split semantics: unlike
   * `String.prototype.split`, capture groups in the pattern are NOT emitted as
   * output elements (see the dialect spec). Trailing empty strings are retained
   * (limit < 0), so a caller filtering empties gets the same non-empty parts as
   * `input.split(new RegExp(pattern))` would.
   */
  split(input: string): string[];
  /**
   * The capture groups of the first match as `[group0, group1, ...]` (index 0 is
   * the whole match; an unmatched optional group is `null`), or `null` on no
   * match. Used by `parse_date`, whose source anchors with `^...$`, so the first
   * match is the whole-string match. Mirrors reading `m[i]` off
   * `input.match(new RegExp(source))`.
   */
  matchGroups(input: string): (string | null)[] | null;
}

/**
 * Compile `pattern` under the linear-time engine and return the per-row
 * operations. Throws (an `RE2JS` exception) if the pattern is outside the dialect;
 * callers that execute already-validated terms never hit that throw (the dialect
 * gate rejected such a pattern at parse time), and the operator-local
 * `runPipeline` path surfaces it exactly as the previous `new RegExp` throw did.
 */
export function compileLinearRegex(pattern: string): CompiledLinearRegex {
  const re = compileCached(pattern);
  return {
    replaceAll: (input, replacement) =>
      re.matcher(input).replaceAll(replacement),
    extractFirst: (input) => {
      const m = re.matcher(input);
      if (!m.find()) return null;
      // groupCount() is the pattern's static capturing-group count, so this asks
      // "does the pattern have a group 1?" exactly as `m[1] !== undefined` does;
      // group(1) is null for a group that did not participate, matching m[1]'s
      // undefined, and "" for one that matched empty, matching m[1]'s "".
      const group1 = m.groupCount() >= 1 ? m.group(1) : null;
      return (group1 ?? m.group(0)) || null;
    },
    test: (input) => re.test(input),
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
 * compiles. The wire schema leaves transform `params` values as `z.unknown()`, so
 * a partner can supply a non-string (a JSON number, boolean, object, or null);
 * `RE2JS.compile` throws a bare `TypeError` on `null` / `undefined` / an array
 * rather than coercing, so the dialect gate and the factories must render the
 * value the SAME way -- with `String(...)` -- or the gate's verdict would not
 * match what the factory runs. A non-string still executes on the linear-time
 * engine, so it carries no ReDoS risk; this only fixes WHICH literal it compiles
 * to. `String("abc")` is `"abc"`, so a normal string pattern is unchanged.
 */
export function coerceToPatternString(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw);
}

/**
 * Whether `pattern` is in the linear-time dialect: it compiles under the engine.
 * The single conformance oracle for both the terms-validation gate
 * ({@link linkageTermsHaveNonConformantTransformRegex}) and the editor-facing
 * `regexPatternSchema`, so the editor accepts exactly the patterns an exchange
 * will execute. Returns `false` (reject, fail closed) on any compile failure,
 * including a feature RE2 drops (backreference, lookaround) -- which is the point:
 * those are the patterns that could otherwise backtrack catastrophically.
 */
export function patternConformsToDialect(pattern: string): boolean {
  try {
    compileCached(pattern);
    return true;
  } catch {
    return false;
  }
}
