/**
 * The width a linkage key element's transform chain bounds its standardized
 * value to, read from the AGREED terms alone.
 *
 * Its own module because the reading sits below both consumers: the fuzzy
 * candidate ceiling (`fuzzyComparisons.ts`) multiplies it into the width a key
 * declares (`declaredKeyWidth`, fanOutFunctions.ts), while the functions whose
 * output width it reads are implemented in `standardization.ts`, which imports
 * this. The two constants the derivation shares with those implementations live
 * here for the same reason -- a bound stated apart from the code that produces it
 * would drift silently.
 */

import type { TransformStep } from "./config/linkageTerms.js";

/**
 * The characters a `phonetic` step emits for one value under `soundex`: an
 * initial letter and three code digits, right-padded with `0`.
 *
 * The factory produces exactly this many characters or drops the value, so it is
 * both the code's own layout and the width bound the derivation below reads.
 */
export const SOUNDEX_CODE_LENGTH = 4;

/**
 * The output layout a `parse_date` step emits when it declares no usable
 * `outputFormat`. It carries every date component, so the default drops nothing.
 *
 * Exported so a terms-level reading of a step -- the breadth markers in
 * `standardization.ts`, the consent header's `parse_date` copy in
 * `invitationSummary.ts`, and the width bound below -- resolves an absent or
 * non-string `outputFormat` to what the runtime actually emits rather than to a
 * restated literal.
 */
export const DEFAULT_DATE_OUTPUT_FORMAT = "YYYYMMDD";

// A `substring` window is at most its declared `length` characters wide,
// whatever value it is handed -- but only for a POSITIVE length. The guards
// mirror `substringWindow` (standardization.ts): a non-integer bound, a `start`
// of 0, or a non-positive `length` reads nothing for any value, and a NEGATIVE
// length measures its end from the end of the VALUE, so the window it opens grows
// with the value rather than with the params.
function substringWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { start, length } = params;
  if (typeof start !== "number" || !Number.isInteger(start) || start === 0)
    return undefined;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0)
    return undefined;
  return length;
}

// `pad_left` fills a value UP to its declared length, so it settles a minimum and
// leaves the maximum where it found it: a value already longer passes through at
// its own width. It therefore raises a bound the chain already carries and
// derives none on its own. The guards mirror `padLeftFactory`, whose invalid
// params throw before any row runs.
function padLeftWidthBound(
  params: Record<string, unknown>,
  carried: number | undefined,
): number | undefined {
  const { length } = params;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0)
    return undefined;
  if (carried === undefined) return undefined;
  return Math.max(carried, length);
}

// `phonetic` emits a fixed-width code or drops the value. Only `soundex` is
// implemented -- `phoneticFactory` throws for any other algorithm, so a step
// naming one never runs -- and a non-string param names no algorithm this build
// codes for, so neither derives a width.
function phoneticWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { algorithm } = params;
  if (algorithm !== undefined && algorithm !== "soundex") return undefined;
  return SOUNDEX_CODE_LENGTH;
}

// `parse_date` renders its output format with each token replaced by a value of
// that token's own width -- a four-digit year for `YYYY`, a zero-padded month for
// `MM`, a zero-padded day for `DD` -- so the rendered date is exactly as wide as
// the format is. A non-string `outputFormat` falls back to the default layout,
// consistent with `parseDateFactory`.
function parseDateWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { outputFormat } = params;
  return typeof outputFormat === "string"
    ? outputFormat.length
    : DEFAULT_DATE_OUTPUT_FORMAT.length;
}

/**
 * The most characters an element's standardized value can carry once its
 * `transform` chain has run, or `undefined` when the agreed terms bound it to no
 * width at all.
 *
 * Both parties read the same terms, so both derive the same number; it is what
 * lets a fuzzy element declare a ceiling tighter than the global expansion limit
 * (`fuzzyCandidateCeiling`, fuzzyComparisons.ts).
 *
 * The chain is walked IN ORDER and the last step to settle a width governs, since
 * each step is handed the previous one's output:
 *
 * - `substring`, `phonetic`, and `parse_date` settle a width from their declared
 *   params alone, whatever they are handed, so each one REPLACES the width
 *   carried into it.
 * - `pad_left` fills up to its length and truncates nothing, so it raises a width
 *   already carried and settles none by itself.
 * - `null_if` and `filter_regex` return the value they were handed or drop it,
 *   so they carry a width through unchanged.
 * - Every other step -- a case fold, an accent strip, a regex replacement, a
 *   split, a `coalesce`, or a function a later build adds -- clears the width.
 *   A step is only classified above when the params alone settle what it emits,
 *   and several of the rest can EMIT MORE than they are handed: a
 *   `replace_regex` replacement re-inserts the matched context at every match
 *   position, an upper-casing expands the code points that case-fold to two, and
 *   a Unicode normalization is not length-preserving either.
 *
 * Deriving no width is always safe -- the consumer falls back to the global cap,
 * which is the bound that held before any of this was read -- while deriving one
 * too small would refuse an honest row at the width seam, which is why the
 * default is to clear.
 *
 * A width this DERIVES is never below 1. Params that would settle 0 -- a
 * `parse_date` whose output layout is empty -- are floored here rather than
 * passed on: a zero declares a key narrower than the single candidate the row
 * builder emits for it, which refuses an honest row at the width seam and drives
 * the effective key count below the plain key count. The terms schema refuses
 * that shape where a document is read (`linkageTerms.ts`), so this floor is what
 * holds for a chain reaching the derivation another way.
 */
export function elementValueWidthBound(
  steps: readonly TransformStep[] | undefined,
): number | undefined {
  let bound: number | undefined;
  for (const step of steps ?? []) {
    const params = step.params ?? {};
    switch (step.function) {
      case "substring":
        bound = substringWidthBound(params);
        break;
      case "pad_left":
        bound = padLeftWidthBound(params, bound);
        break;
      case "phonetic":
        bound = phoneticWidthBound(params);
        break;
      case "parse_date":
        bound = parseDateWidthBound(params);
        break;
      case "null_if":
      case "filter_regex":
        break;
      default:
        bound = undefined;
        break;
    }
  }
  return bound === undefined ? undefined : Math.max(1, bound);
}
