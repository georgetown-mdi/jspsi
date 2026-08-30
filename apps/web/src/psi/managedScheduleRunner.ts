/**
 * The unattended runner's tick: the pure decision half of running a managed
 * (recurring) exchange at its agreed window, with the clock, the store reads and
 * writes, the delay, and the run itself all injected. It is a HOST over the
 * existing run path, not a second one -- every attempt goes through the same
 * seam the attended surface calls, so the single-writer lock, the input guard,
 * the persist-before-success critical section, and the browser driver are the
 * ones already in place. What this module adds is three things: when a window is
 * due, how the window is occupied, and what the window's disposition writes back.
 *
 * Normative rules (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The schedule object"
 * and "Catch-up on wake"; docs/MANAGED_EXCHANGE.md, "Retry and repeated
 * misses"):
 *
 * - **Catch-up runs before any attempt**, on the ordinary wake and on the first
 *   wake after an import (a restored backup carries a stale `nextWindow`), and
 *   its bookkeeping is persisted before an attempt is made -- an interrupted
 *   attempt must not lose the misses the walk counted.
 * - **The schedule advance is this module's alone.** `nextWindow`,
 *   `consecutiveMisses`, and the window's `lastRun` move together through the
 *   store's one conditioned, atomic write; the attended path writes `lastRun`
 *   and never touches `schedule`.
 * - **Retry is at the next agreed window and nothing sooner.** A window is
 *   occupied by bounded re-attempts while it is open, and a window that closes
 *   with no completed handshake advances to the NEXT window -- never a backoff,
 *   never an off-schedule retry.
 *
 * Two properties the loop holds that are worth naming, because neither is
 * visible from the criteria they serve:
 *
 * - The window's close is reached through the peer-WAIT budget of each attempt,
 *   never through an abort. The abort probe the run path classifies on is the
 *   operator-cancel path ({@link ./managedRun.ts}, `rerunFailureLastRun`), so a
 *   window that simply ran out would be recorded as a cancellation if the close
 *   were signalled that way; clamping the last attempt's wait to what is left of
 *   the window lets it end as the partner no-show it actually is.
 * - Nothing is re-attempted once the data exchange began. A re-attempt after
 *   payload flow could have started would disclose a second time, so the run's
 *   own phase boundary ({@link ./managedExchangeRun.ts}'s `onDataExchangeStart`)
 *   is what gates the retry rather than the failure's kind.
 */

import {
  ConnectionError,
  LinkageTermsUnsatisfiableError,
  OutboundDisclosureRefusalError,
} from "@psilink/core";

import {
  DEFAULT_PEER_WAIT_TIMEOUT_MS,
  PartnerNoShowError,
} from "./waitForConnection";
import {
  advanceManagedScheduleAfterWindow,
  catchUpManagedSchedule,
} from "./managedSchedule";
import { ManagedExchangeExpiredError } from "./managedExpiry";
import { ManagedExchangeLockUnavailableError } from "./managedExchangeLock";
import { ManagedExchangeSpentError } from "./managedExchangeRun";
import { ManagedInputError } from "./managedInputGuard";
import { RotationPersistError } from "./managedRunRotate";
import { parseStoredInstant } from "./managedExchangeRecord";

import type {
  ManagedExchangeReadableRecords,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeScheduleAdvance,
} from "./managedExchangeRecord";
import type {
  ManagedScheduleWindow,
  ManagedScheduleWindowDisposition,
} from "./managedSchedule";
import type { ManagedInputSource } from "./managedInputHandle";
import type { ManagedLocalState } from "./managedLocalStateShape";

/**
 * The wait one attempt gives the partner's runner to arrive, before the attempt
 * ends as a no-show and the next one starts. It is the same human-timescale
 * budget both one-shot roles wait on, deliberately: an attempt is an ordinary
 * rendezvous, and a window-long single wait is exactly what this is not -- one
 * broker registration held for the width of the window would make the whole
 * window ride on a single listen surviving that long.
 */
export const ATTEMPT_PEER_WAIT_MS = DEFAULT_PEER_WAIT_TIMEOUT_MS;

/**
 * The minimum spacing between two attempts at the same window, measured from
 * one attempt's start to the next. An attempt that spends its whole peer wait
 * has already outlasted this and the next one starts immediately; an attempt
 * that fails at once waits out the remainder, so a failure that reproduces
 * instantly cannot spin the window away.
 */
export const ATTEMPT_RATE_GAP_MS = 60_000;

/**
 * The most attempts one window takes. The window's own close is what ends an
 * ordinary occupancy -- at the peer wait above, a window would have to stay open
 * for the better part of a day to reach this -- so the cap does not cut a
 * realistic window short. It bounds the other case: an attempt failing
 * immediately, paced by {@link ATTEMPT_RATE_GAP_MS}, would otherwise keep the
 * runner in a wide window for its whole width.
 */
export const MAX_WINDOW_ATTEMPTS = 64;

/** One attempt at a due window, as the runner hands it to the injected run
 * seam. The wiring adds what the browser owns (the abort signal, the object-URL
 * boundary) and calls the same driver the attended surface calls. */
export interface ManagedScheduleAttempt {
  /** The record to run, as the store held it when the window was claimed. */
  record: ManagedExchangeRecord;
  /** This run's input, always the persisted handle read UNATTENDED: a scheduled
   * run has no operator to answer a permission prompt, so a non-granted
   * permission must fail benignly rather than block on one (see
   * {@link ./managedInputHandle.ts}, `ensureHandleReadPermission`). */
  source: ManagedInputSource;
  /** How long this attempt waits for the partner's runner, clamped to what is
   * left of the window so the last attempt ends AT the close rather than past
   * it -- as a no-show, which is what a window nobody arrived in is. */
  peerWaitTimeoutMs: number;
  /** Called at the run's own data-exchange phase boundary. The runner reads it
   * to refuse a re-attempt once payload flow could have started. */
  onDataExchangeStart: () => void;
}

/** The platform seams the tick runs on: the clock, the two store reads, the
 * conditioned schedule write, the run, the pacing delay, and the runtime's own
 * stop. Every one is injected, so the tick's decisions are testable without a
 * database, a broker, or a real clock. */
export interface ManagedScheduleTickSeams {
  /** The wake instant, UTC milliseconds. */
  now: () => number;
  /** Every stored managed exchange this build can read, and the stored keys of
   * the entries it cannot. Read per entry rather than strictly, so one entry a
   * schema bound or an app upgrade invalidated costs its own exchange's
   * scheduled runs instead of every exchange's (see
   * {@link ManagedExchangeReadableRecords}). */
  listRecords: () => Promise<ManagedExchangeReadableRecords>;
  /** Each record's local sibling state, read once per tick. Its `spent` marker
   * is what keeps a handed-off copy from being attempted at all: a migration
   * export transitions the source to spent precisely so neither the operator nor
   * the schedule runs it again. Read once, so it is the cheap pre-filter rather
   * than the guarantee -- a hand-off confirmed after this read is refused by the
   * run path itself, which re-reads the marker inside the run+rotate lock on
   * every attempt ({@link ./managedExchangeRun.ts}). */
  listLocalState: () => Promise<Map<string, ManagedLocalState>>;
  /** The store's one conditioned, atomic schedule write. */
  persistAdvance: (
    id: string,
    advance: ManagedExchangeScheduleAdvance,
  ) => Promise<ManagedExchangeRecord>;
  /** Run one attempt to completion, resolving on a completed exchange and
   * rejecting with the run path's own error otherwise. */
  runAttempt: (attempt: ManagedScheduleAttempt) => Promise<unknown>;
  /** Pace the next attempt. */
  delay: (ms: number) => Promise<void>;
  /** Whether the runtime hosting this tick is going away. */
  stopped: () => boolean;
}

/** Why a record's tick attempted nothing. */
export type ManagedScheduleSkipReason =
  | "unreadable"
  | "no-schedule"
  | "spent"
  | "in-flight"
  | "not-due"
  | "no-input-handle"
  | "plan-moved"
  | "window-closed"
  | "stopped"
  | "bookkeeping-failed";

/** What one record's tick did, for the runtime's diagnostic line and for the
 * checks. A tick reports rather than throws: one record's unusable schedule or
 * failed store write must not stop the records beside it. */
export interface ManagedScheduleTickEntry {
  /** The record this entry reports on: its `id`, or -- for an entry that did not
   * parse -- the key the store holds it under, the record's own `id` being
   * untrusted once the parse failed. */
  id: string;
  /** Fully-elapsed windows the catch-up walk counted as missed before any
   * attempt. */
  caughtUpMisses: number;
  /** Attempts made inside the due window. */
  attempts: number;
  /** The window's disposition, absent when no window was occupied. It stands
   * alongside a `"bookkeeping-failed"` skip: the window was occupied and settled,
   * and the write that would have recorded it is what failed. */
  disposition?: ManagedScheduleWindowDisposition;
  /** Why nothing was attempted, absent when a window was occupied and its
   * bookkeeping landed. */
  skipped?: ManagedScheduleSkipReason;
  /** The failure that stopped this record's bookkeeping, when one did. */
  error?: unknown;
}

/**
 * Run one tick over every stored managed exchange: apply catch-up, then occupy
 * the window it lands on if that window is open now.
 *
 * A stored entry the read could not parse is reported as its own
 * `"unreadable"` skip and passed over, and every other record still runs. The
 * entry stays unreadable until an operator discards it, so a read that rejected
 * wholesale on it would fail this wake and every wake after it, taking every
 * other exchange's scheduled run with it -- the tolerated skip costs one
 * exchange what the rejection costs all of them.
 *
 * Records are ticked concurrently, and a record whose previous tick is still
 * running is passed over rather than started a second time. Each one holds its
 * own single-writer lock and its own rendezvous, and occupying a window can take
 * the width of that window, so a guard any coarser than per-record -- one over
 * the whole tick, say -- would let one exchange's occupancy starve every other
 * exchange whose window opens during it, for as long as it lasts.
 *
 * `inFlight` is the registry of records a tick is still running for. Its owner
 * is the CALLER, which is what lets the guard span wakes; a call that omits it
 * guards only within itself. The membership read and the entry into it happen in
 * one synchronous step, so two overlapping wakes cannot both dispatch the same
 * record between them.
 */
export async function tickManagedSchedules(
  seams: ManagedScheduleTickSeams,
  inFlight: Set<string> = new Set(),
): Promise<Array<ManagedScheduleTickEntry>> {
  const [{ records, unreadableIds }, localState] = await Promise.all([
    seams.listRecords(),
    seams.listLocalState(),
  ]);
  const unreadable: Array<ManagedScheduleTickEntry> = unreadableIds.map(
    (id) => ({
      id,
      caughtUpMisses: 0,
      attempts: 0,
      skipped: "unreadable" as const,
    }),
  );
  const ticked = await Promise.all(
    records.map((record) => {
      if (inFlight.has(record.id))
        return {
          id: record.id,
          caughtUpMisses: 0,
          attempts: 0,
          skipped: "in-flight" as const,
        };
      inFlight.add(record.id);
      return tickManagedScheduleRecord(
        record,
        localState.get(record.id),
        seams,
      ).finally(() => inFlight.delete(record.id));
    }),
  );
  return [...unreadable, ...ticked];
}

/** Run one record's tick, reporting rather than throwing (see
 * {@link ManagedScheduleTickEntry}). */
async function tickManagedScheduleRecord(
  record: ManagedExchangeRecord,
  localState: ManagedLocalState | undefined,
  seams: ManagedScheduleTickSeams,
): Promise<ManagedScheduleTickEntry> {
  // Filled in as the tick learns each field rather than rebuilt at every return,
  // so the catch below reports the attempts and disposition that actually
  // happened beside the failed write instead of the zeroes this started as.
  const entry: ManagedScheduleTickEntry = {
    id: record.id,
    caughtUpMisses: 0,
    attempts: 0,
  };
  const schedule = record.schedule;
  if (schedule === undefined) return { ...entry, skipped: "no-schedule" };
  if (localState?.spent !== undefined) return { ...entry, skipped: "spent" };
  if (seams.stopped()) return { ...entry, skipped: "stopped" };
  try {
    return await occupyDueWindow(record, schedule, entry, seams);
  } catch (error) {
    // An unusable stored schedule (the arithmetic's RangeError) and a failed
    // store write land here alike: neither is this window's outcome to record,
    // and a later wake recomputes both from the stored plan.
    return { ...entry, skipped: "bookkeeping-failed", error };
  }
}

/** Apply catch-up, then occupy the window it lands on when that window is open
 * now. */
async function occupyDueWindow(
  record: ManagedExchangeRecord,
  stored: ManagedExchangeSchedule,
  entry: ManagedScheduleTickEntry,
  seams: ManagedScheduleTickSeams,
): Promise<ManagedScheduleTickEntry> {
  const catchUp = catchUpManagedSchedule(stored, record.lastRun, seams.now());
  entry.caughtUpMisses = catchUp.missedWindows;

  // The catch-up bookkeeping is written BEFORE anything is attempted, so an
  // attempt that never finishes still leaves the elapsed windows counted.
  let planned = catchUp.schedule;
  let claimed = record;
  if (scheduleMoved(stored, catchUp.schedule)) {
    claimed = await seams.persistAdvance(record.id, {
      schedule: catchUp.schedule,
      fromNextWindow: catchUp.fromNextWindow,
      fromConsecutiveMisses: catchUp.fromConsecutiveMisses,
      ...(catchUp.missedLastRun !== undefined
        ? { lastRun: catchUp.missedLastRun }
        : {}),
    });
    // The write is conditioned on the plan it was computed from, so a record
    // some other wake or an operator edit moved first comes back unchanged --
    // including one whose schedule an edit in another tab DROPPED between this
    // tick's snapshot and this write, which is the shape that arrives here with
    // no schedule at all. Occupying a window against a plan the store no longer
    // holds is exactly what the condition exists to prevent.
    if (claimed.schedule === undefined)
      return { ...entry, skipped: "plan-moved" };
    planned = claimed.schedule;
  }

  const due = catchUp.dueWindow;
  if (due === undefined) return { ...entry, skipped: "not-due" };
  if (parseStoredInstant(planned.nextWindow) !== due.opensAtMs)
    return { ...entry, skipped: "plan-moved" };

  const handle = claimed.inputFileHandle;
  // Without a persisted handle there is no unattended read of the input at all
  // (the re-selection path needs an operator), so the window is left
  // unaccounted: it counts as missed at the wake that finds it elapsed, exactly
  // as a window this runtime slept through does.
  if (handle === undefined) return { ...entry, skipped: "no-input-handle" };

  const occupancy = await occupyWindow(claimed, handle, due, seams);
  entry.attempts = occupancy.attempts;
  if (occupancy.disposition === undefined)
    return { ...entry, skipped: seams.stopped() ? "stopped" : "window-closed" };
  entry.disposition = occupancy.disposition;

  await seams.persistAdvance(record.id, {
    schedule: advanceManagedScheduleAfterWindow(
      planned,
      due,
      occupancy.disposition,
    ),
    fromNextWindow: planned.nextWindow,
    fromConsecutiveMisses: planned.consecutiveMisses,
  });
  return { ...entry };
}

/** What occupying one window produced: how many attempts it took and the
 * window's disposition, absent when the window ended before anything settled
 * it. */
interface WindowOccupancy {
  attempts: number;
  disposition?: ManagedScheduleWindowDisposition;
}

/**
 * Occupy one open window with bounded re-attempts.
 *
 * Each attempt waits for the partner up to {@link ATTEMPT_PEER_WAIT_MS},
 * clamped to what is left of the window; a retryable failure starts another
 * attempt no sooner than {@link ATTEMPT_RATE_GAP_MS} after the last one began,
 * and no later than the window's close, which ends the occupancy anyway.
 * The window's disposition folds every attempt rather than reading the last one
 * (see {@link foldWindowDisposition}).
 */
async function occupyWindow(
  record: ManagedExchangeRecord,
  handle: FileSystemFileHandle,
  window: ManagedScheduleWindow,
  seams: ManagedScheduleTickSeams,
): Promise<WindowOccupancy> {
  const source: ManagedInputSource = {
    kind: "handle",
    handle,
    attendance: "unattended",
  };
  let attempts = 0;
  let partnerWasAbsent = false;
  let contactWasProven = false;
  let disposition: ManagedScheduleWindowDisposition | undefined;
  for (;;) {
    // A runtime going away mid-window leaves the window UNRESOLVED, discarding
    // whatever the attempts so far would have made of it: the window is still
    // open, and recording a miss for one this runner simply stopped occupying
    // would count a miss the partner may yet have been met in. A later wake
    // decides it from the stored plan.
    if (seams.stopped()) return { attempts };
    const startedAtMs = seams.now();
    const remainingMs = window.closesAtMs - startedAtMs;
    if (remainingMs <= 0 || attempts >= MAX_WINDOW_ATTEMPTS) break;
    attempts += 1;
    let dataExchangeStarted = false;
    try {
      await seams.runAttempt({
        record,
        source,
        peerWaitTimeoutMs: Math.min(ATTEMPT_PEER_WAIT_MS, remainingMs),
        onDataExchangeStart: () => {
          dataExchangeStarted = true;
        },
      });
      return { attempts, disposition: "succeeded" };
    } catch (error) {
      const verdict = managedScheduleWindowVerdict(error, dataExchangeStarted);
      if (verdict.disposition === "missed") partnerWasAbsent = true;
      if (verdict.provesContact) contactWasProven = true;
      if (!verdict.retryable)
        return {
          attempts,
          disposition: foldWindowDisposition(
            verdict.disposition,
            partnerWasAbsent,
            contactWasProven,
          ),
        };
      disposition = verdict.disposition;
    }
    // Paced from the failed attempt's start, and clamped to the window's own
    // close: the loop head is what ends an occupancy, so a delay outlasting the
    // window would hold this record's tick open past the close for nothing --
    // and past the moment the next wake could have found the record free.
    const pacedFromMs = seams.now();
    await seams.delay(
      Math.max(
        0,
        Math.min(
          ATTEMPT_RATE_GAP_MS - (pacedFromMs - startedAtMs),
          window.closesAtMs - pacedFromMs,
        ),
      ),
    );
  }
  return {
    attempts,
    ...(disposition !== undefined
      ? {
          disposition: foldWindowDisposition(
            disposition,
            partnerWasAbsent,
            contactWasProven,
          ),
        }
      : {}),
  };
}

/**
 * Fold one window's attempts into its disposition: `"missed"` only when at
 * least one attempt found the partner absent and the attempt that ends the
 * window's occupancy does not prove the partner was met.
 *
 * Both halves come from docs/spec/MANAGED_EXCHANGE_RECORD.md ("Occupying a due
 * window", the disposition table, and "The schedule object"'s
 * `consecutiveMisses` row). The absence half is why the fold reads every
 * attempt rather than the last: one trailing transient failure -- a dropped
 * channel, a broker fault -- would otherwise relabel a window of no-show waits
 * `"failed"`, which leaves `consecutiveMisses` untouched and loses the miss
 * entirely, though an attempt that spent its whole peer wait already answered
 * the coordination question the count asks. The contact half instead turns on
 * only the attempt that ends the window: every contact-proving verdict is also
 * non-retryable ({@link attemptProvesContact}), so a handshake that ran and
 * failed ends the window's occupancy at once rather than starting another
 * attempt -- the spec routes that as a desync/attack question rather than
 * coordination drift, so the window records `"failed"` and counts nothing.
 * `contactWasProven` stays an accumulator across the caller's attempts for a
 * future retryable contact-proving class; no verdict is both today, so it
 * never carries more into this fold than the evidence of the attempt that just
 * ended the window.
 *
 * A window whose failures are all local keeps `"failed"`, and the lock refusal
 * keeps `"unattempted"`: neither is a claim about the partner. `"succeeded"`
 * never reaches here -- a completed exchange returns from the loop.
 */
function foldWindowDisposition(
  last: ManagedScheduleWindowDisposition,
  partnerWasAbsent: boolean,
  contactWasProven: boolean,
): ManagedScheduleWindowDisposition {
  return last === "failed" && partnerWasAbsent && !contactWasProven
    ? "missed"
    : last;
}

/** What one failed attempt says about its window: the disposition it would leave
 * behind, and whether the window is worth another attempt. */
export interface ManagedScheduleWindowVerdict {
  /** The window's disposition if this is the last attempt. */
  disposition: ManagedScheduleWindowDisposition;
  /** Whether another attempt inside this window can do better. */
  retryable: boolean;
  /** Whether this failure establishes that the partner WAS met in this window,
   * which is what keeps an earlier attempt's absence from folding the window to
   * `"missed"` (see {@link attemptProvesContact}). */
  provesContact: boolean;
}

/**
 * Whether a failed attempt establishes that the two runners met in this window.
 *
 * The enumeration is the run path's own ordering, not a reading of the failure
 * text. A `security`-kind {@link ConnectionError} comes from the authenticated
 * key exchange, which this path reaches only over a channel already open to the
 * partner -- the rendezvous resolves first ({@link ./managedRunDriver.ts}), and
 * a partner who never arrives raises {@link PartnerNoShowError} instead. A
 * {@link RotationPersistError} is raised only after that handshake has yielded
 * the rotated secret ({@link ./managedRunRotate.ts},
 * `runRotationCriticalSection`). Any failure past the data-exchange phase
 * boundary postdates both, since the persist-before-success sequence puts the
 * data exchange after the handshake and the persist.
 *
 * Nothing else the mapper classifies says the partner was there: a lapsed
 * bound, a copy an export handed off, an unusable input, a shortfall against the
 * standing terms and a refused disclosure are all local and pre-connection, and a
 * failure with no determinate cause names no phase at all.
 */
function attemptProvesContact(
  error: unknown,
  dataExchangeStarted: boolean,
): boolean {
  return (
    dataExchangeStarted ||
    error instanceof RotationPersistError ||
    (error instanceof ConnectionError && error.kind === "security")
  );
}

/**
 * Read a failed attempt as a window verdict.
 *
 * The single-writer lock being held elsewhere is the one failure that is not
 * this window's to account for at all: another context holds this very record --
 * running it, or spending it on a hand-off, which takes the same lock to exclude
 * a run -- so the window records neither an attempt nor a miss
 * (`"unattempted"`), and this runner defers rather than contending for the lock
 * it was refused.
 *
 * A partner who never arrived is the benign no-show, and the only failure that
 * counts a coordination miss. Everything else is `"failed"`, which leaves
 * `consecutiveMisses` untouched per the outcome table -- a run that failed for
 * a local reason says nothing about whether the two runners are still meeting.
 *
 * Only two shapes are worth another attempt inside the window: the no-show, and
 * a failure with no determinate local cause (a dropped connection, a broker
 * fault). A lapsed bound, a copy an export handed off, an unusable input, a
 * shortfall against the standing terms, a refused disclosure, a failed rotation
 * persist, and a handshake that failed closed all reproduce identically on the
 * next attempt -- the first five because the local state that raised them is
 * unchanged, the persist failure because retrying a rotation whose write failed is
 * how a desync is made, and the closed handshake because hammering an
 * authentication failure is the one response to it that is never right. The
 * hand-off is the one of them a window can meet after starting cleanly: the tick's
 * own spent check reads the sibling state once, while the run path re-reads it
 * inside the lock on every attempt, so a hand-off confirmed mid-window ends the
 * window there instead of being re-attempted until it closes.
 *
 * `dataExchangeStarted` overrides all of it: past that boundary this run's
 * payload could already have reached the partner, and a re-attempt would
 * disclose a second time.
 *
 * The verdict also carries whether the failure proves the partner was met, for
 * the window's fold to read (see {@link attemptProvesContact}).
 */
export function managedScheduleWindowVerdict(
  error: unknown,
  dataExchangeStarted: boolean,
): ManagedScheduleWindowVerdict {
  if (error instanceof ManagedExchangeLockUnavailableError)
    return {
      disposition: "unattempted",
      retryable: false,
      provesContact: false,
    };
  const retryable = !dataExchangeStarted;
  const provesContact = attemptProvesContact(error, dataExchangeStarted);
  if (error instanceof PartnerNoShowError)
    return { disposition: "missed", retryable, provesContact };
  if (
    error instanceof ManagedExchangeExpiredError ||
    error instanceof ManagedExchangeSpentError ||
    error instanceof ManagedInputError ||
    error instanceof LinkageTermsUnsatisfiableError ||
    error instanceof OutboundDisclosureRefusalError ||
    error instanceof RotationPersistError ||
    (error instanceof ConnectionError && error.kind === "security")
  )
    return { disposition: "failed", retryable: false, provesContact };
  return { disposition: "failed", retryable, provesContact };
}

/** Whether a catch-up walk moved the stored plan at all. The planned instant is
 * compared as a parsed moment rather than a string, for the varying-ISO-precision
 * reason {@link ./managedExchangeRecord.ts}'s `applyManagedExchangeLastRun`
 * gives. */
function scheduleMoved(
  stored: ManagedExchangeSchedule,
  walked: ManagedExchangeSchedule,
): boolean {
  return (
    parseStoredInstant(stored.nextWindow) !==
      parseStoredInstant(walked.nextWindow) ||
    stored.consecutiveMisses !== walked.consecutiveMisses
  );
}
