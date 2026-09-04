/**
 * The browser half of the unattended runner: it builds the platform seams the
 * pure tick in {@link ./managedScheduleRunner.ts} decides on -- the store reads
 * and the conditioned schedule write, the clock, an abort-aware delay, and the
 * run itself -- and wakes the tick on an interval for as long as the runtime
 * that started it lives.
 *
 * The run seam is {@link runManagedExchangeInBrowser}, the same entry the
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
 * WHAT AN UNATTENDED RUN PRODUCES, and does not: the rotated secret is persisted
 * and the disclosure is filed to this exchange's accounting (both inside the
 * driver), and the window's outcome is recorded. The run's OUTPUT files are
 * built into object URLs that nobody is present to download, so they are revoked
 * as the attempt settles rather than accumulating in a runtime that stays open
 * for weeks; delivering an unattended run's results to the operator is a surface
 * this slice does not have.
 */

import log from "loglevel";

import { appendSanitizedRunWarning } from "@bench/runWarnings";

import {
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
} from "./managedExchangeStore";
import { CLOSE_OUTCOME_WARNINGS } from "./exchangeLifecycle";
import { delayUntilAborted } from "./delayUntilAborted";
import { listManagedLocalState } from "./managedLocalState";
import { runManagedExchangeInBrowser } from "./managedRunDriver";
import { tickManagedSchedules } from "./managedScheduleRunner";

import type { ObjectUrls } from "@bench/runOutputs";

import type {
  ManagedScheduleAttempt,
  ManagedScheduleTickEntry,
  ManagedScheduleTickSeams,
} from "./managedScheduleRunner";

/**
 * How often the runtime looks for a due window. It is the resolution of "the
 * runner arrives at the agreed window", and the window width the schedule entry
 * enforces is on the order of an hour, so a minute is slack against it while
 * costing one store read per minute in an idle runtime.
 */
export const SCHEDULE_TICK_INTERVAL_MS = 60_000;

/** The diagnostic-log prefix an unattended run's notices have, so a line in the
 * console names the run that raised it. */
export const UNATTENDED_RUN_NOTICE_PREFIX =
  "scheduled managed exchange run notice:";

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

/** How the runtime is started. The seams and the tick are injectable so the
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
  /** Overrides the platform seams. Defaults to the store, the clock, and the
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

/** The platform seams: the store, the clock, an abort-aware delay, and the
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

/** Run one scheduled attempt through the browser driver, revoking the object
 * URLs its outputs were built into once the attempt settles. */
async function runUnattendedAttempt(
  attempt: ManagedScheduleAttempt,
  signal: AbortSignal,
): Promise<void> {
  const created: Array<string> = [];
  const urls: ObjectUrls = {
    create: (blob) => {
      const url = window.URL.createObjectURL(blob);
      created.push(url);
      return url;
    },
    revoke: (url) => {
      window.URL.revokeObjectURL(url);
    },
  };
  try {
    await runManagedExchangeInBrowser({
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
        // Four notices reach this sink, not one kind: the close-outcome notice
        // speaks to an operator watching the run and is dropped. The rest --
        // the resolved-cardinality notice and pair-table advisory (raised at
        // core's post-terms, pre-round boundary), plus the disclosure that
        // could not be filed, which an unattended run has no way to remedy --
        // go to the diagnostic log, folded through the same display boundary
        // a seat's surface uses so each is escaped exactly once.
        if (droppableUnattendedNotice(message)) return;
        for (const notice of appendSanitizedRunWarning([], message))
          log.warn(UNATTENDED_RUN_NOTICE_PREFIX, notice);
      },
    });
  } finally {
    for (const url of created) window.URL.revokeObjectURL(url);
  }
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
