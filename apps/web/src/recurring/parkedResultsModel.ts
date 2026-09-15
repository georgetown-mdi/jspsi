/**
 * The pure derivation and copy behind what a scheduled run left for the
 * operator's next visit: one row per run, newest first, the statements the app
 * owes the operator about keeping row values at rest -- where they schedule,
 * where they collect, and where they clear what is kept -- and the warning a run
 * projecting a result larger than this browser keeps raises before it happens.
 * No React, no IndexedDB.
 *
 * The one partner-authored value here is the partner's declared record count,
 * admitted only as a schema-bounded integer from the terms-exchange envelope and
 * rendered through Intl.NumberFormat: the safety argument is that bound, not an
 * absence of partner input. Everything else a row states -- an instant, a count
 * this browser produced, the name of a folder the operator themselves chose, and
 * fixed first-party copy -- needs no such boundary. The results themselves are
 * never rendered -- they are handed to the operator as the file the run built, or
 * written to the folder they granted.
 */

import {
  MAX_PARKED_RESULT_BYTES,
  projectedPairs,
  projectionOverParkedBound,
} from "@psi/resultSizeProjection";
import {
  PARKED_RESULTS_RETENTION_DAYS,
  parkedResultsExpiryMs,
} from "@psi/parkedResults";
import { byteSizeLabel, dateTimeLabel } from "@psi/formatting";

import type {
  ParkedResults,
  ParkedResultsEntry,
  ParkedResultsFallback,
  ParkedRunResults,
  TooLargeRunResults,
  WrittenRunResults,
} from "@psi/parkedResults";
import type { PairTableFactors } from "@psi/resultSizeProjection";

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
 * the disk -- and everything that removes them, because the schedule is the
 * decision that starts producing them.
 */
export const PARKED_RESULTS_SCHEDULE_NOTE =
  `Without a folder to write to, a scheduled run keeps its results in this ` +
  `browser and this exchange's page offers them at your next visit. That also ` +
  `happens whenever the folder you granted cannot be written to. Those results ` +
  `are the matched rows themselves -- the identifiers that matched and the ` +
  `values your partner disclosed -- kept unencrypted in browser storage, where ` +
  `any script running on this site and anyone who can read this machine's disk ` +
  `can read them. After ${RETENTION_PHRASE} they are no longer offered, and ` +
  `your next visit to this page deletes them, as does a later run that leaves ` +
  `results of its own; until one of those happens the bytes stay on disk. ` +
  `Clearing what is kept here removes them at once, as does deleting the ` +
  `exchange.`;

/** What the section holding parked results says about them: where they are, how
 * long they stay, and what removes them. */
export const PARKED_RESULTS_RETENTION_NOTE =
  `Results from a run nobody was present for are written to the folder you ` +
  `granted, and kept in this browser where there is no such folder or it could ` +
  `not be written to. What is kept here is the matched rows, unencrypted in ` +
  `browser storage; after ${RETENTION_PHRASE} they are no longer offered, and ` +
  `your next visit to this page deletes them, as does a later run that leaves ` +
  `results of its own. Until one of those happens the bytes stay on disk. ` +
  `Clearing what is kept here removes them at once, as does deleting this ` +
  `exchange.`;

/** The empty state: no scheduled run has left anything here. Stated against the
 * schedule rather than as a bare blank, so an operator whose runs are not
 * producing results reads it as the fact it is. */
export const NO_PARKED_RESULTS_NOTE =
  "No scheduled run has left anything here. A run that happens with nobody " +
  "present writes its results to the folder you granted and says here where " +
  "they went, or, without such a folder, leaves the results here for you to " +
  "collect.";

/** The state a value this build cannot read presents as. It offers no recovery:
 * unlike an accounting of disclosures, there is no reading of these bytes the app
 * can vouch for, and nothing else holds what they were. It is also a standing
 * state rather than a passing one -- the parking write reads through the same
 * parse -- so it states what later runs can no longer leave here. The refused
 * value's shape is unknown, so it is not stated to hold results. The retention
 * arithmetic never runs over bytes the parse refuses, while the clear and the
 * exchange delete each remove the value without reading it, which is the way out
 * the statement offers (see {@link ../psi/parkedResultsStore.ts}). */
export const UNREADABLE_PARKED_RESULTS_NOTE =
  "Something is stored here for this exchange that this browser cannot read, " +
  "so it cannot tell you whether any results are in it. The retention that " +
  "would otherwise remove it does not apply, and while it is here a scheduled " +
  "run cannot leave its results or record that it could not -- the runs " +
  "themselves still complete and file their disclosures. Clearing what is kept " +
  "here removes it without reading it, as does deleting the exchange.";

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

/** A count with grouped digits, so a figure in the millions reads as one. */
function formatRecordCount(count: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(count);
}

/** How many rows a run's results hold, as a phrase to open a summary with, or
 * `undefined` where the run reported no count. */
function matchedRecordPhrase(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  return count === 1
    ? "1 matched record"
    : `${formatRecordCount(count)} matched records`;
}

/** What a row says about a run whose results went into the granted folder: where
 * they are, so the operator can go and get them, and that this browser is not
 * holding a copy of them. */
function writtenSummary(entry: WrittenRunResults): string {
  const matched = matchedRecordPhrase(entry.matchedRecordCount);
  const written =
    matched === undefined
      ? "Results were written to"
      : `${matched}, written to`;
  return (
    `${written} ${entry.fileName} in the folder you granted ` +
    `(${entry.directoryName}). Nothing of them is kept in this browser.`
  );
}

/** What a row says about results kept in this browser, including the reason a
 * granted folder did not take them -- the operator is owed which of the two
 * happened, not a plain success. */
function parkedSummary(entry: ParkedRunResults): string {
  const matched = matchedRecordPhrase(entry.matchedRecordCount);
  const ready =
    matched === undefined
      ? "Results ready to download."
      : `${matched}, ready to download.`;
  if (entry.fallback === undefined) return ready;
  return entry.fallback === "ungranted"
    ? `${ready} The folder you granted could not be written to without asking ` +
        `you, and a run with nobody present cannot ask, so the results were ` +
        `kept here instead. Granting the folder again restores it for later runs.`
    : `${ready} Writing to the folder you granted failed, so the results were ` +
        `kept here instead. Check that the folder still exists and has room, ` +
        `or grant a different one.`;
}

/** How large a result this browser keeps, as the surfaces state it. */
const PARKED_SIZE_PHRASE = byteSizeLabel(MAX_PARKED_RESULT_BYTES);

/** What a row says to do about the folder that would have taken a result this
 * browser would not keep: which of the three folder outcomes reached the bound,
 * and the step that answers it. */
const TOO_LARGE_FOLDER_REMEDY: Record<ParkedResultsFallback | "none", string> =
  {
    none:
      "No folder is granted for this exchange's results. Choose a folder, and " +
      "a run of any size writes them there instead.",
    ungranted:
      "The folder you granted could not be written to without asking you, and " +
      "a run with nobody present cannot ask. Grant the folder again, and a run " +
      "of any size writes there instead.",
    "write-failed":
      "Writing to the folder you granted failed. Check that the folder still " +
      "exists and has room, or grant a different one; a run of any size writes " +
      "there instead.",
  };

/** What a row says about a run whose results were larger than this browser keeps:
 * what they weighed against the bound, that none of them are here and none were
 * shortened to fit, and what to do about the folder that takes a result this
 * size. */
function tooLargeSummary(entry: TooLargeRunResults): string {
  const matched = matchedRecordPhrase(entry.matchedRecordCount);
  const size = byteSizeLabel(entry.resultBytes);
  const opening =
    matched === undefined
      ? `This run's results were ${size}`
      : `${matched}, ${size} of results`;
  return (
    `${opening} -- more than the ${PARKED_SIZE_PHRASE} this browser keeps, so ` +
    `none of them were kept here and none were cut down to fit. The run itself ` +
    `completed and filed its disclosure. ` +
    TOO_LARGE_FOLDER_REMEDY[entry.fallback ?? "none"]
  );
}

/** What a row says about a run that wrote its results to the granted folder, one
 * that left them here, one this browser would not store them for, or one whose
 * results were larger than it keeps. Each state names the run's own standing --
 * it completed and filed its disclosure -- so none is read as a failed run. */
function rowSummary(entry: ParkedResultsEntry): string {
  if (entry.kind === "storage-refused")
    return (
      "This browser would not store this run's results, so they are gone. " +
      "The run itself completed and filed its disclosure."
    );
  if (entry.kind === "too-large") return tooLargeSummary(entry);
  return entry.kind === "written"
    ? writtenSummary(entry)
    : parkedSummary(entry);
}

/** The declared counts the most recent run that reported any left here, or
 * `undefined` where no entry holds a pair-table product -- no run has left
 * anything, or every cardinality the runs resolved to bounds its table by a
 * single record count. */
function latestPairTableFactors(
  results: ParkedResults,
): PairTableFactors | undefined {
  for (let index = results.entries.length - 1; index >= 0; index -= 1) {
    const factors = results.entries[index].pairTableFactors;
    if (factors !== undefined) return factors;
  }
  return undefined;
}

/**
 * What the operator is told where a further run on the terms the last one
 * declared projects a result larger than this browser keeps, or `undefined` where
 * it does not: the figures behind the projection, what would become of such a
 * result, and the folder grant that takes one of any size.
 *
 * Shown where the operator enters the schedule, while they are present to act on
 * it, and in the run history, so a visit that is not editing the schedule meets it
 * too -- both before the run it speaks about, which is the only time either is
 * worth saying. The projection is the worst case (see
 * {@link ../psi/resultSizeProjection.ts}): it reaches the bound while a narrower
 * result of the same pair count still fits, so it warns rather than predicts.
 */
export function projectedResultSizeWarning(
  results: ParkedResults | undefined,
  folderGranted: boolean,
): string | undefined {
  if (results === undefined) return undefined;
  const factors = latestPairTableFactors(results);
  if (factors === undefined || !projectionOverParkedBound(factors))
    return undefined;
  return (
    `Your last scheduled run declared ${formatRecordCount(factors.local)} ` +
    `records against your partner's ${formatRecordCount(factors.partner)}, and ` +
    `the terms let every record on each side match every record on the other: ` +
    `up to ${formatRecordCount(projectedPairs(factors))} matched pairs, one ` +
    `row each. A result ` +
    `that size is more than the ${PARKED_SIZE_PHRASE} this browser keeps, so ` +
    `a run with nobody present would leave nothing here. That is the most ` +
    `these terms allow rather than what the next run will match: a run that ` +
    `matches fewer records may leave a result that fits. ` +
    (folderGranted
      ? `Results written to the folder you granted are not held to that size; ` +
        `a run that cannot write there leaves nothing.`
      : `Choose a folder for this exchange's results: results written there ` +
        `are not held to that size.`)
  );
}

/** What the control that clears what this browser kept says it does, shown beside
 * it. It names everything that goes, because a note of a result written to the
 * granted folder goes with the rows it is not holding. */
export const CLEAR_PARKED_RESULTS_NOTE =
  "Clearing removes everything this exchange's scheduled runs left here: the " +
  "results kept in this browser, the notes saying where results were written, " +
  "and the states recorded where results were not kept. The results already in " +
  "a folder you granted stay there, and the runs themselves stay in the " +
  "accounting of disclosures. It cannot be undone.";

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
