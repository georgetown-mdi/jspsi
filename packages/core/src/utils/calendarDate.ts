/**
 * Whether `year`-`month`-`day` names a real calendar date.
 *
 * The ISO-string `Date` constructor rolls an out-of-range day or month over
 * (Feb 29 in a non-leap year becomes Mar 1) instead of returning an Invalid
 * Date, so `isNaN` alone would accept it; the parsed UTC components are
 * round-tripped against the input to catch the rollover.
 *
 * Shared by the `parse_date` standardization step, which rejects a row whose
 * components do not form a date, and by the two date fuzzy expansions, which
 * drop a candidate that is not a real date: a shifted year landing on Feb 29 of
 * a non-leap year for `adjacent_years`, and a day above 12 becoming a month for
 * `day_month_swaps`.
 *
 * Each component is the plain decimal string the caller already holds; `month`
 * and `day` are expected zero-padded to two digits, `year` to four.
 */
export function isCalendarDateValid(
  year: string,
  month: string,
  day: string,
): boolean {
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}
