/**
 * The unattended runner's tick: the pure decision half of running a managed
 * (recurring) exchange at its agreed window, with the clock, the store reads and
 * writes, the delay, and the run itself all injected. It is a HOST over the
 * existing run path, not a second one -- every attempt goes through the same
 * call site the attended surface calls, so the single-writer lock, the input
 * guard, the persist-before-success critical section, and the browser driver
 * are the ones already in place. What this module adds is three things: when a
 * window is due, how the window is occupied, and what the window's disposition
 * writes back.
 *
 * Normative rules (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The schedule object"
 * and "Catch-up on wake"; docs/MANAGED_EXCHANGE.md, "Retry and repeated
 * misses"):
 *
 * - **Catch-up runs before any attempt**, on the ordinary wake and on the first
 *   wake after an import (a restored backup holds a stale `nextWindow`), and its
 *   bookkeeping is persisted before an attempt is made -- an interrupted
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
 * Two properties of the loop are not visible from the criteria they serve
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Occupying a due window"):
 *
 * - The window's close is reached through each attempt's peer-WAIT budget,
 *   never through an abort: the abort probe the run path classifies on is the
 *   operator-cancel path ({@link ./managedRun.ts}, `rerunFailureLastRun`), so
 *   clamping the last attempt's wait to what is left of the window lets it end
 *   as the partner no-show it actually is, not a cancellation.
 * - Nothing is re-attempted once the data exchange began: the run's own phase
 *   boundary ({@link ./managedExchangeRun.ts}'s `onDataExchangeStart`) gates the
 *   retry rather than the failure's kind, since a re-attempt after payload flow
 *   could have started would disclose a second time.
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
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeSpentError,
} from "./managedExchangeRun";
import {
  advanceManagedScheduleAfterWindow,
  catchUpManagedSchedule,
} from "./managedSchedule";
import { ManagedExchangeExpiredError } from "./managedExpiry";
import { ManagedExchangeLockUnavailableError } from "./managedExchangeLock";
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
 * budget both one-shot roles wait on, by design: a window-long single wait
 * would put the whole window on one broker registration surviving that long
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Occupying a due window").
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

/** One attempt at a due window, as the runner hands it to the injected
 * runAttempt call. The wiring adds what the browser owns (the abort signal,
 * the object-URL boundary) and calls the same driver the attended surface
 * calls. */
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

/** The platform boundaries the tick runs on: the clock, the two store reads, the
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
   * keeps a handed-off copy from being attempted: a migration export sets it so
   * neither the operator nor the schedule runs the record again. This read is
   * the cheap pre-filter, not the guarantee -- the run path re-reads the marker
   * inside the run+rotate lock on every attempt ({@link ./managedExchangeRun.ts}). */
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
   * alongside a `"bookkeeping-failed"` skip: the window was occupied and its
   * disposition determined, and the write that would have recorded it is what
   * failed. */
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
 * A stored entry the read could not parse is reported as its own `"unreadable"`
 * skip and passed over; every other record still runs
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Catch-up on wake").
 *
 * Records are ticked concurrently. A record whose previous tick is still
 * running is passed over rather than started a second time, since occupying a
 * window can take the width of that window and each record holds its own
 * single-writer lock and rendezvous.
 *
 * `inFlight` is the registry of records a tick is still running for, owned by
 * the CALLER so the guard spans wakes; a call that omits it guards only within
 * itself. The membership read and the entry into it happen in one synchronous
 * step, so two overlapping wakes cannot both dispatch the same record.
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
    // The write is conditioned on the plan it was computed from: a record some
    // other wake or an operator edit moved first comes back unchanged. An edit
    // in another tab that DROPPED the schedule between this tick's snapshot and
    // this write is the shape that arrives here with no schedule at all.
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
  // unaccounted: it counts as missed at the wake that finds it elapsed.
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
 * window's disposition, absent when the window ended before anything decided
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
    // A runtime going away mid-window leaves the window UNRESOLVED: it is still
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
 * window's occupancy does not prove the partner was met
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Occupying a due window", the
 * disposition table).
 *
 * The fold reads every attempt rather than the last, since one trailing
 * transient failure would otherwise relabel a window of no-show waits
 * `"failed"` and lose the miss. `contactWasProven` is an accumulator across the
 * caller's attempts ({@link attemptProvesContact}); no verdict is both
 * `"missed"` and contact-proving today, so it holds no more than the evidence
 * of the attempt that just ended the window.
 *
 * A window whose failures are all local keeps `"failed"`, and the lock refusal
 * keeps `"unattempted"` -- neither is a claim about the partner. `"succeeded"`
 * never reaches here: a completed exchange returns from the loop.
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
 * Whether a failed attempt establishes that the two runners met in this window
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Occupying a due window").
 *
 * A `security`-kind {@link ConnectionError} comes from the authenticated key
 * exchange, reachable only once the rendezvous has resolved
 * ({@link ./managedRunDriver.ts}); a partner who never arrives raises
 * {@link PartnerNoShowError} instead. A {@link RotationPersistError} is raised
 * only after that handshake has yielded the rotated secret
 * ({@link ./managedRunRotate.ts}, `runRotationCriticalSection`). Any failure
 * past the data-exchange phase boundary postdates both.
 *
 * Every other failure the mapper classifies -- a lapsed bound, a copy an
 * export handed off, an unreadable custody entry, an unusable input, a terms
 * shortfall, a refused disclosure, or a cause the mapper cannot determine -- is
 * local, pre-connection, or names no phase, so it says nothing about whether
 * the partner was there.
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
 * Read a failed attempt as a window verdict
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Occupying a due window").
 *
 * The single-writer lock being held elsewhere is not this window's to account
 * for: another context holds the record, so the window records neither an
 * attempt nor a miss (`"unattempted"`), and this runner defers rather than
 * contending for the lock it was refused.
 *
 * A partner who never arrived is the benign no-show, and the only failure that
 * counts a coordination miss. Everything else is `"failed"`, leaving
 * `consecutiveMisses` unchanged.
 *
 * Only the no-show and a failure with no determinate local cause (a dropped
 * connection, a broker fault) are retried inside the window. Every other
 * failure -- a lapsed bound, a hand-off, an unreadable custody entry, an
 * unusable input, a terms shortfall, a refused disclosure, a failed rotation
 * persist, or a handshake that failed closed -- reproduces identically on the
 * next attempt, so it ends the window's occupancy where it happened. The
 * hand-off refusal is non-retryable and counts no partner miss on its own, but
 * a window that already found the partner absent still folds to `"missed"`
 * (see {@link foldWindowDisposition}).
 *
 * `dataExchangeStarted` overrides all of it: past that boundary a re-attempt
 * would disclose a second time.
 *
 * The verdict also states whether the failure proves the partner was met, for
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
    error instanceof ManagedExchangeCustodyUnreadableError ||
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
