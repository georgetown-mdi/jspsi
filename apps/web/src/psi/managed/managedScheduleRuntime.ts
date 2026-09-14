/**
 * The browser half of the unattended runner: it builds the platform boundary the
 * pure tick in {@link ./managedScheduleRunner.ts} decides on -- the store reads
 * and the conditioned schedule write, the clock, an abort-aware delay, and the
 * run itself -- and wakes the tick on an interval for as long as the runtime
 * that started it lives.
 *
 * The run boundary is {@link runManagedExchangeInBrowser}, the same entry the
 * attended surface calls, so a scheduled run takes the identical single-writer
 * lock, input guard, and persist-before-success critical section. Two things
 * differ, and only these two: the input is read through the persisted handle
 * UNATTENDED (queried, never prompted -- there is nobody to answer a prompt),
 * and the peer wait is the window's rather than the flow's default.
 *
 * The lock is taken fail-fast (`ifAvailable`), matching the attended surface: a
 * run already in progress in another tab is a window this runner defers, not one
 * it queues behind. The tick reads that refusal as the window's `"unattempted"`
 * disposition.
 *
 * WHAT AN UNATTENDED RUN PRODUCES: the rotated secret is persisted and the
 * disclosure is filed to this exchange's accounting (both inside the driver), the
 * window's outcome is recorded, and the results CSV is delivered -- written into
 * the folder the operator granted, or parked for the operator's next visit where
 * there is no such grant or it does not hold ({@link ../parkedResultsStore.ts}).
 * The object URLs the outputs were built into are revoked as the attempt settles
 * either way -- nobody is present to download one, and a runtime that stays open
 * for weeks would accumulate them -- so the written file or the parked copy is
 * what the operator returns to. The record pair is neither written nor parked:
 * the run's disclosure record is already in the accounting.
 */

import { getLogger } from "@psilink/core";

import { appendSanitizedRunWarning } from "../runWarnings";

import { CLOSE_OUTCOME_WARNINGS } from "../exchangeLifecycle";
import { delayUntilAborted } from "../delayUntilAborted";

import {
  parkRunResults,
  recordParkedResultsRefusal,
  recordResultsWrittenToFolder,
} from "../parkedResultsStore";
import { runResultsFileName } from "../parkedResults";

import {
  storedOutputDirectoryUsable,
  writeResultsToOutputDirectory,
} from "./managedOutputDirectory";

import {
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
} from "./managedExchangeStore";
import { listManagedLocalState } from "./managedLocalState";
import { runManagedExchangeInBrowser } from "./managedRunDriver";
import { tickManagedSchedules } from "./managedScheduleRunner";

import type { ObjectUrls, RunOutputs } from "../runOutputs";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedExchangeRunResult } from "./managedExchangeRun";
import type { ParkedResultsFallback } from "../parkedResults";

import type {
  ManagedScheduleAttempt,
  ManagedScheduleTickEntry,
  ManagedScheduleTickSeams,
} from "./managedScheduleRunner";

const log = getLogger("managedScheduleRuntime");

/**
 * How often the runtime looks for a due window. It is the resolution of "the
 * runner arrives at the agreed window", and the window width the schedule entry
 * enforces is on the order of an hour, so a minute is slack against it while
 * costing one store read per minute in an idle runtime.
 */
const SCHEDULE_TICK_INTERVAL_MS = 60_000;

/** The diagnostic-log prefix an unattended run's notices have, so a line in the
 * console names the run that raised it. */
const UNATTENDED_RUN_NOTICE_PREFIX = "scheduled managed exchange run notice:";

/**
 * The notices an unattended run drops: the close-outcome family, which tells an
 * operator watching the run that their partner may never have taken the final
 * frame. There is no operator watching, and the driver already drops these for
 * any caller offering no notice surface.
 *
 * The set is matched POSITIVELY: a notice this module has never seen reaches
 * the diagnostic log instead of being swallowed by a broad rule.
 */
const DROPPED_UNATTENDED_NOTICES: ReadonlySet<string> = new Set(
  Object.values(CLOSE_OUTCOME_WARNINGS).filter(
    (warning): warning is string => warning !== undefined,
  ),
);

/** Whether an unattended run drops this notice rather than logging it (see
 * {@link DROPPED_UNATTENDED_NOTICES}). */
export function droppableUnattendedNotice(message: string): boolean {
  return DROPPED_UNATTENDED_NOTICES.has(message);
}

/** How the runtime is started. The boundary and the tick are injectable so the
 * host's own behavior -- the interval, the re-entrancy guard, the stop -- is
 * testable without a store, a broker, or a real clock. */
export interface ManagedScheduleRuntimeOptions {
  /** Stops the runtime: the last tick finishes, no further tick starts. */
  signal: AbortSignal;
  /** Overrides {@link SCHEDULE_TICK_INTERVAL_MS}. */
  intervalMs?: number;
  /** Overrides the tick. Defaults to {@link tickManagedSchedules}, and is
   * handed the runtime's one in-flight registry on every wake. */
  tick?: (
    seams: ManagedScheduleTickSeams,
    inFlight: Set<string>,
  ) => Promise<Array<ManagedScheduleTickEntry>>;
  /** Overrides the platform boundary. Defaults to the store, the clock, and the
   * browser run driver. */
  seams?: ManagedScheduleTickSeams;
}

/**
 * Start waking the tick until `signal` aborts. The first wake is immediate --
 * the catch-up rule is what a launch owes a record whose windows elapsed while
 * this runtime was not running -- and the rest are on the interval. A signal
 * that has already aborted starts nothing at all.
 *
 * Held-back state is per RECORD, in the one registry this runtime holds across
 * its wakes, not per tick: a record whose tick is still running is passed over
 * while every other due record is dispatched, so one record legitimately
 * occupying its own window for hours does not hide a second exchange's due
 * window behind it.
 */
export function startManagedScheduleRuntime(
  options: ManagedScheduleRuntimeOptions,
): void {
  const { signal } = options;
  // An abort listener attached to a signal that has ALREADY aborted never fires,
  // so a runtime started on one would keep its interval for the life of the
  // page with nothing left to clear it. managedScheduleRuntime.test.ts drives a
  // start on an aborted signal and holds it to scheduling nothing at all.
  if (signal.aborted) return;
  const tick = options.tick ?? tickManagedSchedules;
  const seams = options.seams ?? browserScheduleTickSeams(signal);
  const inFlight = new Set<string>();
  const wake = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      reportTick(await tick(seams, inFlight));
    } catch (error) {
      log.error("scheduled managed exchange tick failed:", error);
    }
  };
  const timer = setInterval(
    () => void wake(),
    options.intervalMs ?? SCHEDULE_TICK_INTERVAL_MS,
  );
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
    },
    { once: true },
  );
  void wake();
}

/** The platform boundary: the store, the clock, an abort-aware delay, and the
 * browser run driver. The record read is the store's per-entry one, never the
 * strict list the attended surfaces take: an unattended wake has nobody present
 * to meet the read-failed recovery surface a wholesale rejection routes to. */
export function browserScheduleTickSeams(
  signal: AbortSignal,
): ManagedScheduleTickSeams {
  return {
    now: () => Date.now(),
    listRecords: listReadableManagedExchanges,
    listLocalState: listManagedLocalState,
    persistAdvance: persistManagedExchangeScheduleAdvance,
    delay: (ms) => delayUntilAborted(ms, signal),
    stopped: () => signal.aborted,
    runAttempt: (attempt) => runUnattendedAttempt(attempt, signal),
  };
}

/**
 * Run one scheduled attempt through the browser driver: deliver the results it
 * produced to the operator, then revoke the object URLs its outputs were built
 * into once the attempt settles.
 *
 * The blob behind each URL is held as it is created, so the delivery writes the
 * same bytes the attended download would offer rather than reading them back out
 * of a URL.
 */
async function runUnattendedAttempt(
  attempt: ManagedScheduleAttempt,
  signal: AbortSignal,
): Promise<void> {
  const created = new Map<string, Blob>();
  const urls: ObjectUrls = {
    create: (blob) => {
      const url = window.URL.createObjectURL(blob);
      created.set(url, blob);
      return url;
    },
    revoke: (url) => {
      window.URL.revokeObjectURL(url);
      created.delete(url);
    },
  };
  try {
    const result = await runManagedExchangeInBrowser({
      record: attempt.record,
      source: attempt.source,
      signal,
      urls,
      peerWaitTimeoutMs: attempt.peerWaitTimeoutMs,
      options: {
        lock: { ifAvailable: true },
        onDataExchangeStart: attempt.onDataExchangeStart,
      },
      onWarning: (message) => {
        // Seven notices reach this sink, not one kind: the close-outcome notice
        // speaks to an operator watching the run and is dropped. The rest --
        // the resolved-cardinality notice and pair-table advisory (raised at
        // core's post-terms, pre-round boundary), plus the four for a
        // disclosure the accounting did not get, which an unattended run has
        // no way to remedy -- go to the diagnostic log, folded through the
        // same display boundary a seat's surface uses so each is escaped
        // exactly once.
        if (droppableUnattendedNotice(message)) return;
        for (const notice of appendSanitizedRunWarning([], message))
          log.warn(UNATTENDED_RUN_NOTICE_PREFIX, notice);
      },
    });
    await deliverUnattendedResults(attempt.record, result, created);
  } finally {
    for (const url of created.keys()) window.URL.revokeObjectURL(url);
  }
}

/**
 * Deliver a completed unattended run's results CSV: write it into the folder the
 * operator granted, and keep it in this browser where there is no such grant or
 * the grant does not hold. Either way the operator's next visit is told which
 * happened.
 *
 * Never rejects: the run has already rotated its secret and filed its disclosure,
 * so nothing here may turn a completed run into a failed attempt or restate its
 * outcome. A refusal the store will not even record the state of ends in the
 * diagnostic log, which is all that is left.
 *
 * A run with no results table -- a count-only run, or one whose agreed terms give
 * this party no output -- delivers nothing: there is no file to write or keep, and
 * the run's own bookkeeping already states what it did.
 */
async function deliverUnattendedResults(
  record: ManagedExchangeRecord,
  result: ManagedExchangeRunResult<RunOutputs>,
  created: ReadonlyMap<string, Blob>,
): Promise<void> {
  const outputs = result.exchange;
  if (outputs.kind !== "matched") return;
  const id = record.id;
  const runAt = result.lastRun.at;
  const csv = created.get(outputs.resultsUrl);
  if (csv === undefined) {
    log.error(
      `scheduled managed exchange ${id}: the run's results file was not built ` +
        `through this runtime's own allocation, so nothing was kept for the ` +
        `next visit`,
    );
    return;
  }
  const fileName = runResultsFileName(runAt);
  const matched =
    outputs.matchedRecordCount !== undefined
      ? { matchedRecordCount: outputs.matchedRecordCount }
      : {};
  const fallback = await writeUnattendedResultsToFolder(
    record,
    fileName,
    csv,
    runAt,
    matched,
  );
  if (fallback === undefined) return;
  try {
    await parkRunResults(id, {
      kind: "results",
      runAt,
      fileName,
      csv,
      ...matched,
      ...(fallback === "none" ? {} : { fallback }),
    });
    return;
  } catch (error) {
    log.warn(
      `scheduled managed exchange ${id}: this browser would not store the ` +
        `run's results:`,
      error,
    );
  }
  try {
    await recordParkedResultsRefusal(id, runAt);
  } catch (error) {
    log.error(
      `scheduled managed exchange ${id}: this browser would not store the ` +
        `run's results, and would not record that either; the run itself ` +
        `stands and its disclosure is filed:`,
      error,
    );
  }
}

/**
 * Write one run's results into the granted output folder, reporting what the
 * caller owes the operator next: `undefined` where the results are in the folder
 * and nothing more is owed, `"none"` where no grant was held at all, and the
 * fallback reason where a grant was held and did not take them.
 *
 * The note recording a successful write is best-effort: the results are in the
 * folder either way, so a store that will not hold the note reaches the
 * diagnostic log rather than parking a second copy of the rows.
 */
async function writeUnattendedResultsToFolder(
  record: ManagedExchangeRecord,
  fileName: string,
  csv: Blob,
  runAt: string,
  matched: { matchedRecordCount?: number },
): Promise<ParkedResultsFallback | "none" | undefined> {
  const directory = record.outputDirectoryHandle;
  if (directory === undefined || !storedOutputDirectoryUsable(directory))
    return "none";
  const id = record.id;
  const delivery = await writeResultsToOutputDirectory(
    directory,
    fileName,
    csv,
  );
  if (delivery.kind === "ungranted") {
    log.warn(
      `scheduled managed exchange ${id}: the granted output folder reports ` +
        `permission ${delivery.state} with nobody present, so the run's ` +
        `results are kept in this browser instead`,
    );
    return "ungranted";
  }
  if (delivery.kind === "write-failed") {
    log.warn(
      `scheduled managed exchange ${id}: the run's results could not be ` +
        `written to the granted output folder, so they are kept in this ` +
        `browser instead:`,
      delivery.error,
    );
    return "write-failed";
  }
  try {
    await recordResultsWrittenToFolder(id, {
      kind: "written",
      runAt,
      fileName: delivery.fileName,
      directoryName: delivery.directoryName,
      ...matched,
    });
  } catch (error) {
    log.warn(
      `scheduled managed exchange ${id}: the run's results were written to the ` +
        `granted output folder as ${delivery.fileName}, and this browser would ` +
        `not store the note saying so:`,
      error,
    );
  }
  return undefined;
}

/** Write one tick's entries to the diagnostic log: a failed bookkeeping write
 * and a stored entry that could not be read are the operator's to know about,
 * the rest are triage detail. */
function reportTick(entries: Array<ManagedScheduleTickEntry>): void {
  for (const entry of entries) {
    if (entry.skipped === "unreadable") {
      // Standing rather than transient: the entry is skipped at this wake and
      // every wake after it until the record is discarded, which is the saved
      // exchanges list's read-failed recovery surface.
      log.warn(
        `scheduled managed exchange ${entry.id}: the stored record cannot be ` +
          `read, so it is skipped until it is discarded from the saved ` +
          `exchanges list; the other exchanges still run`,
      );
      continue;
    }
    if (entry.skipped === "bookkeeping-failed") {
      log.warn(
        `scheduled managed exchange ${entry.id}: schedule bookkeeping failed ` +
          `after ${String(entry.attempts)} attempt(s), ` +
          `${entry.disposition ?? "nothing"}:`,
        entry.error,
      );
      continue;
    }
    if (
      entry.skipped === "no-schedule" ||
      entry.skipped === "not-due" ||
      entry.skipped === "in-flight"
    )
      continue;
    log.debug(
      `scheduled managed exchange ${entry.id}: ` +
        `${String(entry.caughtUpMisses)} caught-up miss(es), ` +
        `${String(entry.attempts)} attempt(s), ` +
        `${entry.disposition ?? entry.skipped ?? "nothing"}`,
    );
  }
}
