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
 * What it keeps is bounded by size as well as by time: a results file above
 * {@link ./resultSizeProjection.ts}'s bound is kept nowhere here, neither parked
 * nor shortened to fit, and the run records the too-large state in its place.
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

import type { PairTableFactors } from "./resultSizeProjection";
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

/** What every entry a run leaves here holds, whatever became of the results.
 *
 * The two declared record counts are the run's own, kept so the next visit can
 * project the size of the result a further run on these terms would produce
 * ({@link ./resultSizeProjection.ts}) before that run happens. They are counts,
 * not row values, and absent where the agreed cardinality puts no product on the
 * pair table. */
interface ParkedRunEntry {
  /** ISO 8601 UTC instant of the run, taken from the run's own bookkeeping stamp
   * so this entry and the run history name the same moment. */
  runAt: string;
  /** The two counts the run declared at the terms exchange, where their product
   * is what bounds its pair table ({@link PairTableFactors}). */
  pairTableFactors?: PairTableFactors;
}

/** One scheduled run's results, waiting for the operator. */
export interface ParkedRunResults extends ParkedRunEntry {
  kind: "results";
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
export interface WrittenRunResults extends ParkedRunEntry {
  kind: "written";
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
export interface RefusedRunResults extends ParkedRunEntry {
  kind: "storage-refused";
}

/** A scheduled run whose results were larger than this browser keeps
 * ({@link MAX_PARKED_RESULT_BYTES}). Nothing of the results is here: they are
 * kept whole or not at all, never shortened to fit. The run itself completed,
 * rotated, and filed its disclosure; what the operator's next visit meets is this
 * state and the remedy for it, which is the output-folder grant. */
export interface TooLargeRunResults extends ParkedRunEntry {
  kind: "too-large";
  /** The size of the results file that was not kept, in bytes, so the state names
   * what it weighed against the bound. */
  resultBytes: number;
  /** How many rows the results table had, where the run reported it. */
  matchedRecordCount?: number;
}

/** One entry of a managed exchange's parked results. */
export type ParkedResultsEntry =
  ParkedRunResults | WrittenRunResults | RefusedRunResults | TooLargeRunResults;

/** One managed exchange's parked results, oldest run first. */
export interface ParkedResults {
  version: typeof PARKED_RESULTS_VERSION;
  entries: ReadonlyArray<ParkedResultsEntry>;
}

const pairTableFactorsSchema: ZodType<PairTableFactors> = z
  .object({ local: z.int().min(0), partner: z.int().min(0) })
  .strict();

/** The fields every entry holds, spread into each shape below: the union is
 * `.strict()` shape by shape, so a shared base has to be spread rather than
 * extended. */
const runEntryFields = {
  runAt: z.iso.datetime(),
  pairTableFactors: pairTableFactorsSchema.optional(),
};

const entrySchema: ZodType<ParkedResultsEntry> = z.discriminatedUnion("kind", [
  z
    .object({
      ...runEntryFields,
      kind: z.literal("results"),
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
      ...runEntryFields,
      kind: z.literal("written"),
      fileName: z.string().min(1),
      directoryName: z.string().min(1),
      matchedRecordCount: z.int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      ...runEntryFields,
      kind: z.literal("storage-refused"),
    })
    .strict(),
  z
    .object({
      ...runEntryFields,
      kind: z.literal("too-large"),
      resultBytes: z.int().min(0),
      matchedRecordCount: z.int().min(0).optional(),
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

/** How many characters of the exchange's label reach the results file name. The
 * label's own cap is 120 characters; with the fixed prefix and the run stamp
 * beside it, a name built from all of them approaches a filesystem's limit on one
 * path component. */
const MAX_RESULTS_FILE_LABEL_CHARS = 40;

/** The exchange's label as a file-name fragment: ASCII letters and digits, every
 * other run of characters reduced to one hyphen. A label reduces to the empty
 * string where it holds none of those, and the name then omits the fragment
 * rather than standing a bare hyphen in for it. The reduction is also what keeps
 * a path separator or a traversal segment out of a name that reaches a real
 * filesystem through the granted folder. */
function resultsFileLabelSlug(label: string): string {
  return label
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(0, MAX_RESULTS_FILE_LABEL_CHARS)
    .replace(/^-+|-+$/g, "");
}

/**
 * The name a scheduled run's results file takes: the exchange's own label and the
 * run's instant, made filesystem-safe the same way the record downloads are
 * stamped ({@link ./runOutputs.ts}). It names the file both ways the results can
 * reach the operator, so two runs collide neither in the granted output folder nor
 * in the downloads folder a parked copy lands in, and an operator who granted one
 * folder to two exchanges reads whose results a file holds off its name.
 *
 * Two runs at the same millisecond, or two exchanges whose labels reduce to the
 * same fragment and run at it, still name one file; the later write takes it.
 */
export function runResultsFileName(label: string, runAt: string): string {
  const slug = resultsFileLabelSlug(label);
  const stamp = recordFileStamp(runAt);
  return `psilink-results-${slug === "" ? "" : `${slug}-`}${stamp}.csv`;
}
