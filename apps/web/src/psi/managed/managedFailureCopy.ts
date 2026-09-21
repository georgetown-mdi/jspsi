/**
 * Notification copy shared between the next-visit alert and the unattended
 * runner's between-visit notification: the repeated-miss coordination state
 * (threshold, title, and the two phrasings every surface that reports repeated
 * misses holds), the title over each recorded failure tier, and the
 * single-column shortfall's delimiter remedy.
 *
 * It sits below the product directories because two readers need it and they are
 * in different layers: the saved-exchanges list and the per-exchange detail view
 * read the repeated-miss state through
 * {@link ../../recurring/scheduleSurfacingModel.ts}, the next-visit alert reads
 * the failure titles through {@link ../../recurring/managedRunLaunchModel.ts},
 * and the unattended runner's between-visit notification
 * ({@link ./betweenVisitNotice.ts}) reads both directly -- `psi/` cannot import
 * `recurring/`. One definition of each is what keeps the notification and the
 * next visit saying the same thing.
 *
 * Pure: the record's `consecutiveMisses` is read verbatim, and nothing here
 * advances or anticipates a write the runner has not made.
 */

import type { ManagedExchangeSchedule } from "./managedExchangeRecord";

/**
 * The consecutive-miss count at which a surface escalates from naming the last
 * run's outcome to the coordination prompt. Normative value and the reasoning
 * behind it: docs/spec/MANAGED_EXCHANGE_RECORD.md, the `consecutiveMisses` row,
 * and docs/MANAGED_EXCHANGE.md, "Retry and repeated misses".
 */
export const REPEATED_MISS_ESCALATION = 2;

/** The escalated coordination state, phrased for every surface: the list's quiet
 * line, the notification's body, and the detail view's prompt. */
export interface RepeatedMissCoordination {
  /** The consecutive-miss count the record holds, at or above
   * {@link REPEATED_MISS_ESCALATION}. */
  misses: number;
  /** The one-line form: the state and both checks, deferring the rest to the
   * exchange's own surface. */
  line: string;
  /** The detail view's coordination prompt. */
  prompt: string;
}

/** The title over the coordination state. It names the state, not a fault: which
 * side was absent is exactly what the record cannot know. */
export const REPEATED_MISS_TITLE = "Runs are not happening on schedule";

/**
 * The coordination state a run of missed windows earns, or `undefined` below
 * the escalation threshold (a single miss demands nothing beyond the last
 * run's own outcome). Both phrasings name BOTH checks, the partner and this
 * device's own clock, since a drifted clock produces exactly this pattern;
 * neither offers to pause anything -- the agreed cadence stands
 * (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they do not
 * auto-pause").
 */
export function repeatedMissCoordination(
  schedule: ManagedExchangeSchedule,
): RepeatedMissCoordination | undefined {
  const misses = schedule.consecutiveMisses;
  if (misses < REPEATED_MISS_ESCALATION) return undefined;
  return {
    misses,
    line: `${misses} scheduled runs in a row have not happened; check with your partner, and check this device's clock.`,
    prompt: `${misses} scheduled runs in a row have not happened. Ask your partner whether they are still running this exchange, and check this device's clock -- if it is wrong, your run window and theirs never overlap. Nothing has been paused: the schedule stands, and the count resets after a successful run.`,
  };
}

/** The title over the benign input failure tier. */
export const INPUT_FAILURE_TITLE = "Your input file could not be used";

/** The title over the benign linkage-shortfall failure tier. */
export const TERMS_SHORTFALL_FAILURE_TITLE =
  "Your input file cannot match on everything this exchange agreed to";

/** The title over the benign disclosure-refusal failure tier. */
export const CONSENT_FAILURE_TITLE =
  "What this run would send is not what this exchange agreed to send";

/** The title over the Tier-2 unexplained failure tier. */
export const UNEXPLAINED_FAILURE_TITLE =
  "This run failed and needs you to check with your partner";

/**
 * The remedy for a shortfall whose input file read as ONE column, in the words
 * every managed surface states it in: the next-visit alert
 * ({@link ../../recurring/managedRunLaunchModel.ts}) and the between-visit
 * notification ({@link ./betweenVisitNotice.ts}).
 *
 * It names a file saved with the separator this exchange reads, or a fresh setup
 * where the separator is chosen, rather than the delimiter field the intake
 * surfaces offer ({@link ../../components/csvDelimiterChoice.ts}): a record's
 * delimiter is fixed for the partnership, so no surface reading this copy has
 * that field on it.
 */
export const SINGLE_COLUMN_DELIMITER_REMEDY =
  "Its fields may be separated by a character other than the one this " +
  "exchange reads it with. Save the input file with the separator this " +
  "exchange was set up to read, or set the exchange up again with your " +
  "partner and choose your file's separator at its file step.";
