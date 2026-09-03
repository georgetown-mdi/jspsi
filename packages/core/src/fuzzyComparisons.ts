import { UsageError } from "./errors.js";
import { isCalendarDateValid } from "./utils/calendarDate.js";
import type { GenerateFuzzyComparisons } from "./config/linkageTerms.js";

/**
 * The longest standardized value the fuzzy expansion will widen.
 *
 * Every expansion kind emits O(length) candidates of O(length) characters each,
 * so the work and allocation for one element grow with the SQUARE of the value
 * it is handed. The value is local row data, whose length nothing upstream
 * bounds, while the decision to expand it comes from the partner-authored
 * linkage terms -- so without this cap a partner could declare a fuzzy element
 * over a field the local file happens to fill with very long cells and drive
 * unbounded per-row allocation. Names and canonical dates sit far below the cap,
 * so it never binds on real linkage data.
 *
 * A value above the cap is refused rather than passed through unexpanded:
 * passing it through would match that row on the single exact value while the
 * consent surface states each candidate matches independently.
 */
export const MAX_FUZZY_EXPANSION_INPUT_LENGTH = 128;

/** The canonical date layout `adjacent_years` expands, the `parse_date` default. */
const CANONICAL_DATE_LAYOUT = "YYYYMMDD";

const CANONICAL_DATE_PATTERN = /^[0-9]{8}$/;

// Neither the standardized value nor the element name is interpolated into any
// refusal below: the value is local row data (the PII the exchange exists to
// keep local) and the element name is partner-authored free text. Each message
// names only the fixed enum member and the recovery, so it is safe to render.
function fuzzyValueTooLongRefusal(kind: GenerateFuzzyComparisons): UsageError {
  return new UsageError(
    `a linkage-key element declares "${kind}" fuzzy comparisons, but a row's ` +
      "standardized value is longer than the " +
      `${MAX_FUZZY_EXPANSION_INPUT_LENGTH}-character limit the expansion ` +
      "accepts: expanding it would allocate work that grows with the square " +
      "of the value's length, and matching the row on its exact value alone " +
      "would match on less than the terms declare. The exchange is refused " +
      "instead. Shorten the field with an element transform, or remove the " +
      "fuzzy comparison from the element.",
  );
}

function nonCanonicalDateRefusal(): UsageError {
  return new UsageError(
    'a linkage-key element declares "adjacent_years" fuzzy comparisons, but a ' +
      "row's standardized value is not a canonical " +
      `${CANONICAL_DATE_LAYOUT} date: the year cannot be located, so the ` +
      "element would match on its exact value alone rather than on the " +
      "adjacent years the terms declare. The exchange is refused instead. " +
      `Add a "parse_date" element transform emitting ${CANONICAL_DATE_LAYOUT}, ` +
      "or remove the fuzzy comparison from the element.",
  );
}

/**
 * Every adjacent-character transposition of `value`, excluding `value` itself.
 *
 * Iterates code points rather than UTF-16 units so a swap never splits a
 * surrogate pair into two lone surrogates -- a candidate no partner's
 * standardized value could equal, and one that would not survive the key
 * builder's final NFC pass unchanged.
 *
 * A pair of identical characters transposes to the original string, so it emits
 * no candidate.
 */
export function transpositionCandidates(value: string): string[] {
  const points = Array.from(value);
  const candidates: string[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    if (points[i] === points[i + 1]) continue;
    const swapped = [...points];
    swapped[i] = points[i + 1];
    swapped[i + 1] = points[i];
    candidates.push(swapped.join(""));
  }
  return candidates;
}

/**
 * Every single-character deletion of `value`; each is one code point shorter
 * than `value`, so `value` itself is never among them.
 *
 * These are the values within one edit distance of `value` that are SHORTER
 * than it; the partner's own value is expanded by its own party, so a deletion
 * on each side covers a single substitution or insertion between them without
 * either side enumerating the alphabet.
 *
 * Deleting either character of a repeated pair yields the same string, so the
 * result is deduplicated.
 */
export function deletionCandidates(value: string): string[] {
  const points = Array.from(value);
  const candidates = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    candidates.add([...points.slice(0, i), ...points.slice(i + 1)].join(""));
  }
  return [...candidates];
}

/**
 * The calendar-valid dates one year either side of a canonical
 * `YYYYMMDD` value, excluding the value itself.
 *
 * Feb 29 has no counterpart in an adjacent non-leap year, so a shifted date
 * that is not a real calendar date emits no candidate; the surviving side (or
 * neither) is returned. A shift off the four-digit year range is dropped the
 * same way.
 *
 * Throws when `value` is not a canonical `YYYYMMDD` date, rather than returning
 * the value unexpanded -- see {@link expandFuzzyComparisons}.
 */
export function adjacentYearCandidates(value: string): string[] {
  if (!CANONICAL_DATE_PATTERN.test(value)) throw nonCanonicalDateRefusal();
  const year = Number(value.slice(0, 4));
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const candidates: string[] = [];
  for (const shifted of [year - 1, year + 1]) {
    if (shifted < 0 || shifted > 9999) continue;
    const shiftedYear = String(shifted).padStart(4, "0");
    if (!isCalendarDateValid(shiftedYear, month, day)) continue;
    candidates.push(`${shiftedYear}${month}${day}`);
  }
  return candidates;
}

/**
 * Whether `kind`'s candidates are built by the resolved PSI RECEIVER alone
 * rather than by both parties.
 *
 * This is expanding-side selection, not the one-sided OUTPUT entitlement
 * (docs/notes/one-sided-disclosure.md): the entitlement is an agreed term, while
 * this is a local execution choice keyed on the role both parties resolve from
 * the record counts they already exchanged (`resolveRole`, protocolSetup.ts). It
 * moves no term, no terms hash, and no wire byte, extending the receiver-only
 * `swap` directive's precedent.
 *
 * `transpositions` and `adjacent_years` are role-keyed: their candidates are
 * built on the resolved receiver alone. `edit_distances` is built by BOTH
 * parties: each side's own deletions are what let a substitution or insertion
 * between the two values meet in the middle (see {@link deletionCandidates}),
 * so expanding one side alone would match on less than the terms declare.
 *
 * Total over the kind and pure -- it reads no term, no role, and no row -- so
 * both parties classify a kind identically, and a member added to
 * {@link GenerateFuzzyComparisons} without an arm here fails to compile.
 */
export function expandsOnReceiverOnly(kind: GenerateFuzzyComparisons): boolean {
  switch (kind) {
    case "transpositions":
    case "adjacent_years":
      return true;
    case "edit_distances":
      return false;
  }
}

/**
 * The most candidate values `kind` can realize from one standardized value,
 * counting the value itself.
 *
 * This is the factor a fuzzy element contributes to its key's declared width
 * (`declaredKeyWidth`, fanOutFunctions.ts), so it must upper-bound
 * {@link expandFuzzyComparisons}'s result for every value the expansion accepts:
 * a ceiling below what the expansion realizes refuses an honest row at the width
 * bound, and one above it spends value slots that stay empty.
 *
 * Each arm is its kind's count at {@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}, the
 * longest value the expansion accepts. `adjacent_years` emits the year either
 * side of a canonical date, so three with the value. `edit_distances` emits one
 * deletion per code point, so the length plus the value. `transpositions` emits
 * one swap per adjacent pair, one fewer than the length, so the length with the
 * value.
 *
 * Total over the kind and pure, like {@link expandsOnReceiverOnly} beside it, so
 * both parties derive the identical factor from the agreed terms and a member
 * added to {@link GenerateFuzzyComparisons} without an arm here fails to compile.
 */
export function fuzzyCandidateCeiling(kind: GenerateFuzzyComparisons): number {
  switch (kind) {
    case "adjacent_years":
      return 3;
    case "edit_distances":
      return MAX_FUZZY_EXPANSION_INPUT_LENGTH + 1;
    case "transpositions":
      return MAX_FUZZY_EXPANSION_INPUT_LENGTH;
  }
}

/**
 * Expand one standardized value into the match candidates a
 * `generateFuzzyComparisons` rule declares.
 *
 * The returned array always LEADS with `value` itself: fuzzy comparison widens
 * the candidate set rather than replacing the exact match, so a record that
 * would match today still matches. The remaining entries are the kind's
 * candidates, deduplicated against each other and against `value`, in a
 * deterministic order -- both parties run this over their own rows, and a
 * hashed PSI entry is order-independent, but a stable order keeps the key
 * builder's cross-product reproducible for a given row.
 *
 * Expansion runs on the value the element's `transform` pipeline has already
 * produced, not on the raw field value; see `buildKeyStrings`.
 *
 * Throws a {@link UsageError} when the declared expansion cannot be applied to
 * this value -- a value above {@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}, or an
 * `adjacent_years` element whose value is not a canonical `YYYYMMDD` date.
 * Returning the bare value instead would match the row on its exact value while
 * the consent surface states each candidate matches independently, which is the
 * silent narrowing this refusal exists to prevent.
 */
export function expandFuzzyComparisons(
  value: string,
  kind: GenerateFuzzyComparisons,
): string[] {
  if (value.length > MAX_FUZZY_EXPANSION_INPUT_LENGTH)
    throw fuzzyValueTooLongRefusal(kind);

  let candidates: string[];
  switch (kind) {
    case "transpositions":
      candidates = transpositionCandidates(value);
      break;
    case "edit_distances":
      candidates = deletionCandidates(value);
      break;
    case "adjacent_years":
      candidates = adjacentYearCandidates(value);
      break;
  }

  return [...new Set([value, ...candidates])];
}
