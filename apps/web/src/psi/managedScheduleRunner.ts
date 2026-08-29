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
 * - The single-writer lock is held per ATTEMPT, not for the window. Between two
 *   attempts the runner stands down for {@link attemptLockYieldMs}, which is one
 *   of the two intervals in which an operator's own Run can take the lock -- the
 *   other is the tail of an attempt that got past the rotation persist, which
 *   runs the data exchange and the success stamp with the lock already released
 *   ({@link ./managedExchangeRun.ts}). The attended path takes the lock
 *   fail-fast, so a window occupied back-to-back would refuse them for its whole
 *   width. A window the attended run wins by REFUSING an attempt records neither
 *   an attempt nor a miss, which is the `"unattempted"` disposition already in
 *   place.
 * - A window the attended run wins by COMPLETING is satisfied, not missed. That
 *   run rotates the shared secret the rendezvous peer id derives from
 *   ({@link ./managedRunDriver.ts}), so an occupancy re-attempting against the
 *   tick's snapshot would no-show against its own exchange and record a miss for
 *   a window the exchange was met in. The record is re-read before every
 *   re-attempt for that reason: a window a recorded success has discharged ends
 *   the occupancy, and one still due is attempted against the fresh secret.
 * - An attempt made after that rotation writes NO bookkeeping of its own
 *   ({@link ManagedScheduleAttempt.recordsFailureBookkeeping}). It is re-making
 *   an exchange another context has already conducted in this window, so its
 *   failure is not evidence about the partnership -- and `lastRun` is monotonic
 *   on `at` ({@link ./managedExchangeRecord.ts}), so a no-show stamped at the
 *   end of a wait that ran past that run's success would REPLACE the success,
 *   leaving the occupancy nothing to discharge the window with and a completed
 *   exchange recorded as a miss.
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
  managedScheduleWindowStateAt,
} from "./managedSchedule";
import { ManagedExchangeExpiredError } from "./managedExpiry";
import { ManagedExchangeLockUnavailableError } from "./managedExchangeRun";
import { ManagedInputError } from "./managedInputGuard";
import { RotationPersistError } from "./managedRunRotate";
import { parseStoredInstant } from "./managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
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
 * The share of a window's width the runner stands down for between two attempts,
 * before the floor and ceiling below are applied.
 *
 * The single-writer lock is held for the length of an attempt, so back-to-back
 * attempts hold it for essentially the whole window and refuse an attended Run
 * for all of it. The gap between attempts is when the lock is demonstrably free,
 * which makes it the yield policy, and it is scaled by the window because a wider
 * window can afford to stand down longer and still meet its partner.
 */
export const ATTEMPT_LOCK_YIELD_WINDOW_SHARE = 1 / 32;

/** The shortest stand-down between two attempts: the floor keeps a failure that
 * reproduces instantly from spinning the window away, and keeps the lock free
 * long enough for an operator's own Run to take it. */
export const MIN_ATTEMPT_LOCK_YIELD_MS = 120_000;

/**
 * The longest stand-down between two attempts, which is what keeps the yield from
 * costing the rendezvous it exists beside.
 *
 * Two runners each listening for {@link ATTEMPT_PEER_WAIT_MS} out of every
 * (wait + yield) overlap for at least (wait - yield) of every cycle whatever
 * their phase, so a yield at or past the wait admits an anti-phase pair that
 * never meets inside a window they both occupied. Half the wait leaves half of it
 * as guaranteed overlap, which is many times what a rendezvous and handshake
 * take.
 *
 * The (wait - yield) floor models an attempt as pure listening. A real attempt
 * spends input acquisition and rendezvous setup before it listens, so the
 * realized overlap is lower than the model's by that per-attempt overhead; the
 * margin half the wait leaves is what absorbs it, and the floor is the bound's
 * shape rather than a measured guarantee.
 */
export const MAX_ATTEMPT_LOCK_YIELD_MS = ATTEMPT_PEER_WAIT_MS / 2;

/**
 * How long the runner leaves the single-writer lock free after an attempt at a
 * window `windowMs` wide, before starting the next one. It is clamped into
 * [{@link MIN_ATTEMPT_LOCK_YIELD_MS}, {@link MAX_ATTEMPT_LOCK_YIELD_MS}], so the
 * window's width drives it across the narrow end of the widths schedule entry
 * admits and the rendezvous ceiling binds above that.
 */
export function attemptLockYieldMs(windowMs: number): number {
  return Math.min(
    MAX_ATTEMPT_LOCK_YIELD_MS,
    Math.max(
      MIN_ATTEMPT_LOCK_YIELD_MS,
      Math.floor(windowMs * ATTEMPT_LOCK_YIELD_WINDOW_SHARE),
    ),
  );
}

/**
 * The most attempts one window takes. The window's own close is what ends an
 * ordinary occupancy: a window nobody arrives in spends a full peer wait plus a
 * stand-down per attempt, so the widest window schedule entry admits stays under
 * this and the cap never cuts such a window short. It bounds the two cases the
 * close does not -- attempts failing immediately in a wide window, and a clock
 * that stops advancing under the loop, where the close is never reached at all.
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
  /** Whether this attempt stamps its own failure `lastRun` on the record (see
   * {@link ./managedRun.ts}, `rerunFailureLastRun`). False once the occupancy
   * has read the record's secret rotated under it: another context completed a
   * handshake for this exchange inside this window, so this attempt is a
   * re-make of a run already conducted and what it finds says nothing about the
   * partnership -- while the entry it would write, stamped later than that
   * run's own, would replace it. */
  recordsFailureBookkeeping: boolean;
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
  /** Every stored managed exchange. */
  listRecords: () => Promise<Array<ManagedExchangeRecord>>;
  /** One record as the store holds it now, or `undefined` when it is gone. The
   * occupancy re-reads through this before every re-attempt, so an attended run
   * that landed between two attempts is seen rather than attempted over. It
   * rejects on a record the current build cannot validate, exactly as the list
   * read does. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Each record's local sibling state, read once per tick. Its `spent` marker
   * is what keeps a handed-off copy from running: a migration export transitions
   * the source to spent precisely so neither the operator nor the schedule runs
   * it again. */
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
  | "no-schedule"
  | "spent"
  | "in-flight"
  | "not-due"
  | "no-input-handle"
  | "plan-moved"
  | "window-satisfied"
  | "window-closed"
  | "stopped"
  | "bookkeeping-failed";

/** What one record's tick did, for the runtime's diagnostic line and for the
 * checks. A tick reports rather than throws: one record's unusable schedule or
 * failed store write must not stop the records beside it. */
export interface ManagedScheduleTickEntry {
  /** The record this entry reports on. */
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
  const [records, localState] = await Promise.all([
    seams.listRecords(),
    seams.listLocalState(),
  ]);
  return Promise.all(
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

  const occupancy = await occupyWindow(claimed, due, entry, seams);
  // A window another context satisfied or re-planned under the occupancy is not
  // this tick's to account for: the recorded success discharges it through the
  // ordinary catch-up rule at the next wake, and a moved plan is the store's
  // newer bookkeeping. Writing an advance for either would count a window twice.
  if (occupancy.kind === "satisfied")
    return { ...entry, skipped: "window-satisfied" };
  if (occupancy.kind === "plan-moved")
    return { ...entry, skipped: "plan-moved" };
  if (occupancy.kind === "no-input-handle")
    return { ...entry, skipped: "no-input-handle" };
  if (occupancy.kind === "unresolved")
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

/**
 * How occupying one window ended.
 *
 * `"settled"` is the only ending the schedule advance is written for. The other
 * four each leave the window to a later wake, which recomputes it from the
 * stored plan: `"unresolved"` because the runtime went away or the close was
 * reached before anything settled it, and the three below because the window
 * stopped being this occupancy's to attempt while it ran.
 */
type WindowOccupancy =
  | { kind: "settled"; disposition: ManagedScheduleWindowDisposition }
  | { kind: "unresolved" }
  | { kind: "satisfied" }
  | { kind: "plan-moved" }
  | { kind: "no-input-handle" };

/**
 * Occupy one open window with bounded re-attempts.
 *
 * Each attempt waits for the partner up to {@link ATTEMPT_PEER_WAIT_MS},
 * clamped to what is left of the window; a retryable failure stands the runner
 * down for {@link attemptLockYieldMs} -- leaving the single-writer lock free for
 * an attended Run -- and no later than the window's close, which ends the
 * occupancy anyway. The window's disposition folds every attempt rather than
 * reading the last one (see {@link foldWindowDisposition}).
 *
 * The record is re-read before every re-attempt (see
 * {@link refreshOccupiedRecord}), so an attended Run that took the freed lock
 * and finished during the stand-down is met on its own terms rather than
 * attempted over with the state this occupancy started on. Each attempt's input
 * source is built from that fresh record too, so a handle re-pointed under the
 * occupancy is the one the next attempt reads, and a record left with none ends
 * the occupancy exactly as the tick's own no-handle path leaves the window.
 *
 * `entry.attempts` is counted here rather than returned, so a re-read that
 * rejects reports the attempts already made alongside the failure.
 */
async function occupyWindow(
  record: ManagedExchangeRecord,
  window: ManagedScheduleWindow,
  entry: ManagedScheduleTickEntry,
  seams: ManagedScheduleTickSeams,
): Promise<WindowOccupancy> {
  let current = record;
  let partnerWasAbsent = false;
  let contactWasProven = false;
  // Whether a rotation this occupancy did not perform has been read off the
  // record. It is sticky for the rest of the window: the rotating run's own
  // outcome lands whenever its data exchange ends, which is any instant after
  // the rotation, so every later attempt's stamp is one that could replace it.
  let secretRotatedElsewhere = false;
  let disposition: ManagedScheduleWindowDisposition | undefined;
  for (;;) {
    // A runtime going away mid-window leaves the window UNRESOLVED, discarding
    // whatever the attempts so far would have made of it: the window is still
    // open, and recording a miss for one this runner simply stopped occupying
    // would count a miss the partner may yet have been met in. A later wake
    // decides it from the stored plan.
    if (seams.stopped()) return { kind: "unresolved" };
    if (entry.attempts > 0) {
      const refreshed = await refreshOccupiedRecord(current.id, window, seams);
      if (refreshed.kind !== "attempt") return refreshed;
      // A secret that has moved since the last attempt is one this occupancy did
      // not move -- an attempt of its own that reached the rotation persist is
      // past the data-exchange boundary, which ends the occupancy rather than
      // re-attempting -- so it is another context's completed handshake for this
      // record, inside this window.
      if (refreshed.record.sharedSecret !== current.sharedSecret)
        secretRotatedElsewhere = true;
      current = refreshed.record;
    }
    const handle = current.inputFileHandle;
    // Without a persisted handle there is no unattended read of the input at all
    // (the re-selection path needs an operator), so the window is left
    // unaccounted: it counts as missed at the wake that finds it elapsed, exactly
    // as a window this runtime slept through does.
    if (handle === undefined) return { kind: "no-input-handle" };
    const startedAtMs = seams.now();
    const remainingMs = window.closesAtMs - startedAtMs;
    if (remainingMs <= 0 || entry.attempts >= MAX_WINDOW_ATTEMPTS) break;
    entry.attempts += 1;
    let dataExchangeStarted = false;
    try {
      await seams.runAttempt({
        record: current,
        source: { kind: "handle", handle, attendance: "unattended" },
        peerWaitTimeoutMs: Math.min(ATTEMPT_PEER_WAIT_MS, remainingMs),
        recordsFailureBookkeeping: !secretRotatedElsewhere,
        onDataExchangeStart: () => {
          dataExchangeStarted = true;
        },
      });
      return { kind: "settled", disposition: "succeeded" };
    } catch (error) {
      const verdict = managedScheduleWindowVerdict(error, dataExchangeStarted);
      if (verdict.disposition === "missed") partnerWasAbsent = true;
      if (verdict.provesContact) contactWasProven = true;
      if (!verdict.retryable)
        return {
          kind: "settled",
          disposition: foldWindowDisposition(
            verdict.disposition,
            partnerWasAbsent,
            contactWasProven,
          ),
        };
      disposition = verdict.disposition;
    }
    // The lock is free from here until the next attempt takes it, so this delay
    // is the yield: measured from the failed attempt's END, which is when the
    // lock actually came free, and clamped to the window's own close. The loop
    // head is what ends an occupancy, so a yield outlasting the window would hold
    // this record's tick open past the close for nothing -- and past the moment
    // the next wake could have found the record free.
    const yieldFromMs = seams.now();
    await seams.delay(
      Math.max(
        0,
        Math.min(
          attemptLockYieldMs(window.closesAtMs - window.opensAtMs),
          window.closesAtMs - yieldFromMs,
        ),
      ),
    );
  }
  return disposition !== undefined
    ? {
        kind: "settled",
        disposition: foldWindowDisposition(
          disposition,
          partnerWasAbsent,
          contactWasProven,
        ),
      }
    : { kind: "unresolved" };
}

/** What a re-read before a re-attempt makes of the occupancy: the record to
 * attempt against, or the ending the fresh state calls for. */
type WindowRefresh =
  | { kind: "attempt"; record: ManagedExchangeRecord }
  | { kind: "satisfied" }
  | { kind: "plan-moved" };

/**
 * Re-read the record the occupancy is running against, and decide from the
 * fresh state whether the window is still this occupancy's to attempt.
 *
 * The single-writer lock is free between two attempts, so an attended Run can
 * take it and complete there. It rotates the shared secret, and the rendezvous
 * peer id is derived from that secret ({@link ./managedRunDriver.ts}), so a
 * re-attempt carrying the tick's snapshot would announce itself at an address
 * the partner has already moved off -- a no-show, folded into a `"missed"`
 * window the exchange was in fact met in.
 *
 * A recorded success stamped inside the window discharges it, which is the same
 * evidence the catch-up walk reads for a window still open
 * ({@link ./managedSchedule.ts}, `catchUpManagedSchedule`) -- and the walk is
 * what accounts for the window at the next wake, so the occupancy writes no
 * advance of its own. `lastRun` is read as evidence and never validated: a stamp
 * that does not parse falls outside the window and discharges nothing.
 *
 * A record that is gone, one whose schedule an edit dropped, and one whose plan
 * has moved off this window are the shape the tick's own conditioned write
 * already treats as `"plan-moved"`: the store holds newer bookkeeping than this
 * occupancy computed against.
 *
 * @throws whatever the store's read raises for a record this build cannot
 *   validate, which the tick reports as failed bookkeeping.
 */
async function refreshOccupiedRecord(
  id: string,
  window: ManagedScheduleWindow,
  seams: ManagedScheduleTickSeams,
): Promise<WindowRefresh> {
  const fresh = await seams.readRecord(id);
  if (fresh?.schedule === undefined) return { kind: "plan-moved" };
  if (parseStoredInstant(fresh.schedule.nextWindow) !== window.opensAtMs)
    return { kind: "plan-moved" };
  if (windowSatisfiedByRun(window, fresh.lastRun)) return { kind: "satisfied" };
  return { kind: "attempt", record: fresh };
}

/** Whether a recorded run discharges this window: a success stamped inside the
 * window's own half-open interval. */
function windowSatisfiedByRun(
  window: ManagedScheduleWindow,
  lastRun: ManagedExchangeLastRun | undefined,
): boolean {
  return (
    lastRun?.outcome === "succeeded" &&
    managedScheduleWindowStateAt(window, parseStoredInstant(lastRun.at)) ===
      "open"
  );
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
 * bound, an unusable input, a shortfall against the standing terms and a
 * refused disclosure are all local and pre-connection, and a failure with no
 * determinate cause names no phase at all.
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
 * this window's to account for at all: another context is running this very
 * record, so the window records neither an attempt nor a miss
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
 * fault). A lapsed bound, an unusable input, a shortfall against the standing
 * terms, a refused disclosure, a failed rotation persist, and a handshake that
 * failed closed all reproduce identically on the next attempt -- the first four
 * because the local state that raised them is unchanged, the persist failure
 * because retrying a rotation whose write failed is how a desync is made, and
 * the closed handshake because hammering an authentication failure is the one
 * response to it that is never right.
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
