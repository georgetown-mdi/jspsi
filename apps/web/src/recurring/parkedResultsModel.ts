/**
 * The pure derivation and copy behind the results a scheduled run left for the
 * operator's next visit: one row per parked run, newest first, and the two
 * statements the app owes the operator about keeping row values at rest -- one
 * where they schedule, one where they collect. No React, no IndexedDB.
 *
 * Nothing here holds a partner-authored value: a row states an instant, a count
 * this browser produced, and fixed first-party copy, so there is no display
 * sanitization boundary in this module. The results themselves are never
 * rendered -- they are handed to the operator as the file the run built.
 */

import {
  PARKED_RESULTS_RETENTION_DAYS,
  parkedResultsExpiryMs,
} from "@psi/parkedResults";
import { dateTimeLabel } from "@psi/formatting";

import type { ParkedResults, ParkedResultsEntry } from "@psi/parkedResults";

/** One parked run as the surface shows it: when it ran, what it left, and -- for
 * results that are still there -- the file to hand over. */
export interface ParkedResultsRow {
  /** The run instant, the key the row is rendered under. */
  runAt: string;
  /** The run instant phrased for display. */
  when: string;
  /** When these results stop being offered, phrased for display. */
  until: string;
  /** What this run left: the results themselves, or the state this browser
   * recorded in their place. */
  entry: ParkedResultsEntry;
  /** What the row says about the run, beside its date. */
  summary: string;
}

/** How long parked results stay, as the surfaces state it. */
const RETENTION_PHRASE = `${String(PARKED_RESULTS_RETENTION_DAYS)} days`;

/**
 * What the operator is told about parked results BEFORE they schedule anything,
 * shown with the cadence fields. It states the disclosure plainly -- row values
 * at rest, unencrypted, in reach of any script on this site and of whoever holds
 * the disk -- and the two things that remove them, because the schedule is the
 * decision that starts producing them.
 */
export const PARKED_RESULTS_SCHEDULE_NOTE =
  `A scheduled run has nobody present to take its results, so it keeps them in ` +
  `this browser and this exchange's page offers them at your next visit. Those ` +
  `results are the matched rows themselves -- the identifiers that matched and ` +
  `the values your partner disclosed -- kept unencrypted in browser storage, ` +
  `where any script running on this site and anyone who can read this machine's ` +
  `disk can read them. After ${RETENTION_PHRASE}, your next visit here or the ` +
  `next run, whichever comes first, removes them; until then the bytes stay on ` +
  `disk, and deleting the exchange removes them at once.`;

/** What the section holding parked results says about them: where they are, how
 * long they stay, and what removes them. */
export const PARKED_RESULTS_RETENTION_NOTE =
  `Results from a run nobody was present for are kept in this browser so you ` +
  `can collect them here. They are the matched rows, kept unencrypted in ` +
  `browser storage; after ${RETENTION_PHRASE}, the next visit here or run, ` +
  `whichever comes first, removes them, and until then the bytes stay on disk, ` +
  `and deleting this exchange removes them at once.`;

/** The empty state: no scheduled run has left anything here. Stated against the
 * schedule rather than as a bare blank, so an operator whose runs are not
 * producing results reads it as the fact it is. */
export const NO_PARKED_RESULTS_NOTE =
  "No scheduled run has left results here. A run that happens with nobody " +
  "present puts its results here for you to collect.";

/** The state a value this build cannot read presents as. It offers no recovery:
 * unlike an accounting of disclosures, there is no reading of these bytes the app
 * can vouch for, and nothing else holds what they were. */
export const UNREADABLE_PARKED_RESULTS_NOTE =
  "Results are stored here for this exchange, but this browser cannot read " +
  "them, so the retention that would otherwise remove them no longer applies. " +
  "Deleting the exchange is the only way to remove them.";

/** The state a store that did not answer presents as, held apart from the empty
 * one: nothing is known about what is stored, so it may not read as "nothing is
 * here". Its documented cause is transient (another tab holding an older version
 * of the store open), so it names reading again rather than a page reload, which
 * would end a run in progress. */
export const UNAVAILABLE_PARKED_RESULTS_NOTE =
  "Whether a scheduled run left results here could not be read from this " +
  "browser's storage. Nothing kept here has been changed or deleted. A tab " +
  "running an older version of this app can hold that storage for a while; " +
  "close any other tab this app is open in, then try again.";

/** What a row says about a run that left results, or about one this browser
 * would not store them for. A refusal names the run's own standing -- it
 * completed and filed its disclosure -- so the state is not read as a failed
 * run. */
function rowSummary(entry: ParkedResultsEntry): string {
  if (entry.kind === "storage-refused")
    return (
      "This browser would not store this run's results, so they are gone. " +
      "The run itself completed and filed its disclosure."
    );
  return entry.matchedRecordCount === undefined
    ? "Results ready to download."
    : entry.matchedRecordCount === 1
      ? "1 matched record, ready to download."
      : `${String(entry.matchedRecordCount)} matched records, ready to download.`;
}

/**
 * The parked runs as rows, newest run first -- the order a returning operator
 * reads, where the most recent run is the one they came for.
 *
 * The retention is displayed from each entry's own run instant through the same
 * arithmetic the store enforces, so the date a row shows is the date its results
 * go.
 */
export function parkedResultsRows(
  results: ParkedResults,
): ReadonlyArray<ParkedResultsRow> {
  return [...results.entries]
    .map((entry) => ({
      runAt: entry.runAt,
      when: dateTimeLabel(new Date(entry.runAt)),
      until: dateTimeLabel(new Date(parkedResultsExpiryMs(entry))),
      entry,
      summary: rowSummary(entry),
    }))
    .reverse();
}
