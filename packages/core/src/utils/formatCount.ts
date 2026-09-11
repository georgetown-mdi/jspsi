/**
 * Format a count with grouped digits under an EXPLICIT locale, so the grouping
 * separator is the same ASCII bytes on every host and in every browser: the
 * CLI's console sentinel fails a line holding a byte outside printable ASCII,
 * which a locale-default separator (a non-breaking space in several) would put
 * there.
 *
 * The one formatter for every figure an operator-facing sentence composed in
 * this package states, so no two of them group digits differently.
 */
export function formatCount(count: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(count);
}
