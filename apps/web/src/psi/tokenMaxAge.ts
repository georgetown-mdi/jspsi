import { MAX_TOKEN_MAX_AGE_DAYS } from "@alcove/core";

import { z } from "zod";

/**
 * The maximum-age policy for a stored shared secret, as every surface that
 * authors one holds it: core's `authentication.token_max_age_days`, the number
 * of days after a rotation the rotated secret stays usable.
 */

/** The canonical `tokenMaxAgeDays` validator (a positive integer bounded by
 * {@link MAX_TOKEN_MAX_AGE_DAYS}), shared by the managed record, its
 * export/import artifact, and the console's job intent so none re-declares a
 * laxer copy. */
export const tokenMaxAgeDaysSchema = z
  .int()
  .positive()
  .max(MAX_TOKEN_MAX_AGE_DAYS);

/** Where the max-age field starts for an exchange that has no policy yet, so the
 * operator opting in edits a plausible bound rather than an empty field. */
export const OPT_IN_TOKEN_MAX_AGE_DAYS = 90;

/**
 * Validate an opted-in max-age day count as the operator typed it (a number, or
 * the string a cleared/partial number input reports), returning the field error
 * to show, or `undefined` when the value is a usable policy. An enabled-but-
 * invalid count must never resolve to "no bound": a cleared field silently
 * converting opt-in to no-bound would store an unbounded secret the operator
 * believes is bounded, so an invalid value blocks the save or the run instead.
 * The bounds are {@link tokenMaxAgeDaysSchema}'s, checked here so an
 * out-of-range value fails at the field rather than as a generic write failure.
 */
export function maxAgeDaysError(value: number | string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return "Enter a whole number of days.";
  if (value > MAX_TOKEN_MAX_AGE_DAYS)
    return `Enter at most ${MAX_TOKEN_MAX_AGE_DAYS} days.`;
  return undefined;
}
