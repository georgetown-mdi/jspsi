/**
 * The results a scheduled run leaves for the operator's next visit: the pure,
 * IndexedDB-free half of {@link ./parkedResultsStore.ts}, so the shape, the
 * retention rule, and the append are unit-testable in Node with no database.
 *
 * A run with nobody present has no taker for its result file. Where the operator
 * granted an output folder the run writes the file there and leaves only a note
 * of where it went; otherwise, and whenever that grant or write does not hold, it
 * keeps the results CSV here, beside the record it ran from, until the operator
 * returns for it.
 *
 * What this holds at rest is NOT what the managed record and the accounting of
 * disclosures hold. Those hold presence, shape, and aggregate counts; an entry
 * here holds the matched rows themselves -- the identifiers that matched and the
 * payload values the partner disclosed -- unencrypted, readable by any script on
 * the origin and by whoever holds the disk (see
 * docs/SECURITY_DESIGN.md, "Results of a scheduled run at rest").
 *
 * Retention is arithmetic over each entry's own run instant rather than a stored
 * expiry or a sweep timer: the store applies {@link retainParkedResults} on every
 * read and every write, so the retention the surface states is the one enforced
 * whether or not any timer fires, and an entry past it is never handed to a
 * caller.
 */

import { z } from "zod";

import { parseStoredInstant } from "./managed/managedExchangeRecord";
import { recordFileStamp } from "./runOutputs";

import type { ZodType } from "zod";

/** The single recognized format version for a stored set of parked results. A
 * reader rejects any other value rather than migrating it, the
 * reader-rejects-unknown rule the record and the accounting of disclosures
 * follow (see docs/spec/EXCHANGE_RECORD.md). */
export const PARKED_RESULTS_VERSION = "psilink-parked-results/v1";

/** How long a scheduled run's results stay in this browser, counted from the run
 * itself. The surface states this number and the store enforces exactly it (see
 * {@link retainParkedResults}). */
export const PARKED_RESULTS_RETENTION_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Why a run that held an output-folder grant kept its results in the browser
 * instead of writing them there: the grant was not one the run could use with
 * nobody present (never taken, not honoured unattended, or revoked), or the write
 * itself did not land. Absent where no grant was held at all, which is the plain
 * parking case. */
export type ParkedResultsFallback = "ungranted" | "write-failed";

/** One scheduled run's results, waiting for the operator. */
export interface ParkedRunResults {
  kind: "results";
  /** ISO 8601 UTC instant of the run, taken from the run's own bookkeeping stamp
   * so this entry and the run history name the same moment. */
  runAt: string;
  /** The name the download is offered under, stamped so repeated downloads
   * accumulate rather than collide ({@link runResultsFileName}). */
  fileName: string;
  /** The results CSV, exactly as an attended run's download would hold it. */
  csv: Blob;
  /** How many rows the results table has, where the run reported it. */
  matchedRecordCount?: number;
  /** Why the granted output folder did not take these results, where one was
   * held ({@link ParkedResultsFallback}). */
  fallback?: ParkedResultsFallback;
}

/** One scheduled run's results as written into the folder the operator granted.
 * The rows are in that folder and nothing of them is kept here: this entry is the
 * note that says where they went, so the operator's next visit can say it. */
export interface WrittenRunResults {
  kind: "written";
  /** ISO 8601 UTC instant of the run whose results were written. */
  runAt: string;
  /** The name the results were written under. */
  fileName: string;
  /** The granted folder's own name, as the picker reported it -- the leaf, not a
   * path: a directory handle discloses no path to the app. */
  directoryName: string;
  /** How many rows the results table has, where the run reported it. */
  matchedRecordCount?: number;
}

/** A scheduled run whose results this browser would not store: the run itself
 * completed, rotated, and filed its disclosure, and the rows are gone. The state
 * is kept so the operator meets it at the next visit instead of finding nothing
 * where results should be. */
export interface RefusedRunResults {
  kind: "storage-refused";
  /** ISO 8601 UTC instant of the run whose results were refused. */
  runAt: string;
}

/** One entry of a managed exchange's parked results. */
export type ParkedResultsEntry =
  ParkedRunResults | WrittenRunResults | RefusedRunResults;

/** One managed exchange's parked results, oldest run first. */
export interface ParkedResults {
  version: typeof PARKED_RESULTS_VERSION;
  entries: ReadonlyArray<ParkedResultsEntry>;
}

const entrySchema: ZodType<ParkedResultsEntry> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("results"),
      runAt: z.iso.datetime(),
      fileName: z.string().min(1),
      // A Blob has no structure Zod can describe, so the check is the runtime
      // brand itself: a value read back from the store is the Blob structured
      // clone rebuilt, and anything else is a stored value this reader refuses.
      csv: z.custom<Blob>((value) => value instanceof Blob),
      matchedRecordCount: z.int().min(0).optional(),
      fallback: z.enum(["ungranted", "write-failed"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("written"),
      runAt: z.iso.datetime(),
      fileName: z.string().min(1),
      directoryName: z.string().min(1),
      matchedRecordCount: z.int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("storage-refused"),
      runAt: z.iso.datetime(),
    })
    .strict(),
]);

const parkedResultsSchema: ZodType<ParkedResults> = z
  .object({
    version: z.literal(PARKED_RESULTS_VERSION),
    entries: z.array(entrySchema),
  })
  .strict();

/**
 * Parse and validate a value read from the parked-results store. Rejects an
 * unrecognized `version`, an unknown key, or an entry that is not a valid entry,
 * rather than loading it -- so a corrupted or app-upgrade-invalidated value shows
 * as a read failure rather than silently offering a shorter, false set of
 * results.
 *
 * @throws {ZodError} if the value is not a valid set of parked results.
 */
export function parseParkedResults(raw: unknown): ParkedResults {
  return parkedResultsSchema.parse(raw);
}

/** The instant an entry's results stop being offered and are removed: its run
 * instant plus {@link PARKED_RESULTS_RETENTION_DAYS}. `NaN` for a run instant
 * this reader cannot place on the clock, which {@link retainParkedResults} drops
 * rather than keeps. */
export function parkedResultsExpiryMs(entry: ParkedResultsEntry): number {
  return (
    parseStoredInstant(entry.runAt) + PARKED_RESULTS_RETENTION_DAYS * MS_PER_DAY
  );
}

/**
 * The entries still inside the retention at `now`, oldest first. Applied on every
 * read and every write of the store, so what is stated is what is enforced: an
 * entry past the retention is neither offered nor kept, and no sweep timer has to
 * have fired for that to hold.
 *
 * An entry whose run instant does not place on the clock is dropped: it can be
 * held to no retention at all, and keeping content at rest that nothing bounds is
 * the one outcome this rule exists to prevent.
 */
export function retainParkedResults(
  results: ParkedResults,
  now: number,
): ParkedResults {
  const entries = results.entries.filter(
    (entry) => parkedResultsExpiryMs(entry) > now,
  );
  return entries.length === results.entries.length
    ? results
    : { version: PARKED_RESULTS_VERSION, entries };
}

/**
 * Add one run's entry, returning the result; a missing set starts one. Entries
 * stay in run order.
 *
 * Parking the same run twice replaces the earlier entry, matched on the run
 * instant: a retried write cannot leave two entries for one run, and a refusal
 * recorded after a failed park stands in place of that run's results rather than
 * beside them.
 */
export function appendParkedResults(
  current: ParkedResults | undefined,
  entry: ParkedResultsEntry,
): ParkedResults {
  const kept = (current?.entries ?? []).filter(
    (stored) => stored.runAt !== entry.runAt,
  );
  return { version: PARKED_RESULTS_VERSION, entries: [...kept, entry] };
}

/** The name a scheduled run's results file takes: the run's own instant, made
 * filesystem-safe the same way the record downloads are stamped
 * ({@link ./runOutputs.ts}). It names the file both ways the results can reach
 * the operator, so two runs collide neither in the granted output folder nor in
 * the downloads folder a parked copy lands in. */
export function runResultsFileName(runAt: string): string {
  return `psilink-results-${recordFileStamp(runAt)}.csv`;
}
