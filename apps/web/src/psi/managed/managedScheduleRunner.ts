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
 * - **A due window is skipped while the operator's compromise response stands**
 *   (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack"): the operator
 *   has said the secret may be in someone else's hands, so the window connects
 *   to nobody and rotates nothing. It is the window's own outcome rather than a
 *   partner absence, so it counts no miss, and the next window is attempted as
 *   soon as one of the three acts clears the response. The answer is read off
 *   the store before every attempt's connect, so one written mid-window ends the
 *   occupancy on the same skipped outcome. A window that opened under the
 *   response and elapsed while nothing was running folds the same way in the
 *   catch-up walk, so a machine asleep across several of them wakes with the
 *   miss count where it stood.
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
} from "@alcove/core";

import {
  DEFAULT_PEER_WAIT_TIMEOUT_MS,
  PartnerNoShowError,
} from "../transport/waitForConnection";
import {
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeNotRunnableError,
  ManagedExchangeSpentError,
} from "./managedExchangeRun";
import {
  advanceManagedScheduleAfterWindow,
  catchUpManagedSchedule,
} from "./managedSchedule";
import {
  parseStoredInstant,
  runnableManagedExchange,
  standingCompromiseResponse,
} from "./managedExchangeRecord";
import { ManagedExchangeExpiredError } from "./managedExpiry";
import { ManagedExchangeLockUnavailableError } from "./managedExchangeLock";
import { ManagedInputError } from "./managedInputGuard";
import { RotationPersistError } from "./managedRunRotate";

import type {
  ManagedExchangeReadableRecords,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeScheduleAdvance,
  ManagedStandingCondition,
  ManagedStandingConditionKind,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type {
  ManagedLocalState,
  ManagedReadableLocalState,
} from "./managedLocalStateShape";
import type {
  ManagedScheduleWindow,
  ManagedScheduleWindowDisposition,
} from "./managedSchedule";
import type { ManagedInputSource } from "./managedInputHandle";

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
  /** The record as the store held it just before this attempt. The run path
   * reads it again inside the run+rotate lock and runs that copy. */
  record: RunnableManagedExchangeRecord;
  /** This run's input, always the persisted handle read UNATTENDED: a scheduled
   * run has no operator to answer a permission prompt, so a non-granted
   * permission must fail benignly rather than block on one (see
   * {@link ./managedInputHandle.ts}, `ensureHandlePermission`). */
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
  /** Read one stored record afresh. Every attempt in a window runs the record
   * this returns, and reads the operator's compromise response and the plan
   * through it before it connects, so a write landing while the window is being
   * occupied is met by the attempt after it rather than only by the next
   * window (see {@link occupyWindow}). A read returning nothing is the record
   * deleted, which ends the occupancy the same way. A read that rejects ends the
   * tick's bookkeeping, leaving the window unaccounted: an attempt whose answer
   * cannot be read does not connect. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Each record's local sibling state, read once per tick. Its `spent` marker
   * keeps a handed-off copy from being attempted: a migration export sets it so
   * neither the operator nor the schedule runs the record again. This read is
   * the cheap pre-filter, not the guarantee -- the run path re-reads the marker
   * inside the run+rotate lock on every attempt ({@link ./managedExchangeRun.ts}).
   * Read per entry for the reason {@link listRecords} is: a record whose sibling
   * entry does not parse is skipped as `"unreadable"`, and no other. */
  listLocalState: () => Promise<ManagedReadableLocalState>;
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
type ManagedScheduleSkipReason =
  | "unreadable"
  | "no-schedule"
  | "configuration-only"
  | "spent"
  | "in-flight"
  | "not-due"
  | "no-input-handle"
  | "plan-moved"
  | "window-closed"
  | "deleted"
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
  /** Fully-elapsed windows the catch-up walk held back over the operator's
   * compromise response, counted as neither an attempt nor a miss. */
  caughtUpSkips: number;
  /** Attempts made inside the due window. */
  attempts: number;
  /** The window's disposition, absent where the wake neither occupied nor
   * skipped a window. It stands alongside a `"bookkeeping-failed"` skip: the
   * window's disposition was determined, and the write that would have recorded
   * it is what failed. */
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
      caughtUpSkips: 0,
      attempts: 0,
      skipped: "unreadable" as const,
    }),
  );
  const unreadableLocalState = new Set(localState.unreadableIds);
  const ticked = await Promise.all(
    records.map((record) => {
      // An unreadable sibling may be the one recording a hand-off, so the
      // record is passed over rather than attempted.
      if (unreadableLocalState.has(record.id))
        return {
          id: record.id,
          caughtUpMisses: 0,
          caughtUpSkips: 0,
          attempts: 0,
          skipped: "unreadable" as const,
        };
      if (inFlight.has(record.id))
        return {
          id: record.id,
          caughtUpMisses: 0,
          caughtUpSkips: 0,
          attempts: 0,
          skipped: "in-flight" as const,
        };
      inFlight.add(record.id);
      return tickManagedScheduleRecord(
        record,
        localState.states.get(record.id),
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
    caughtUpSkips: 0,
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
  // The response is read off the tick's own snapshot because the walk decides
  // windows that closed before this wake: the answer in force across them is the
  // stored one, not whatever the catch-up write returns below.
  const response = standingCompromiseResponse(record);
  const catchUp = catchUpManagedSchedule(
    stored,
    record.lastRun,
    seams.now(),
    response === undefined ? undefined : parseStoredInstant(response.at),
  );
  entry.caughtUpMisses = catchUp.missedWindows;
  entry.caughtUpSkips = catchUp.skippedWindows;

  // The catch-up bookkeeping is written BEFORE anything is attempted, so an
  // attempt that never finishes still leaves the elapsed windows counted.
  let planned = catchUp.schedule;
  let claimed = record;
  if (scheduleMoved(stored, catchUp.schedule)) {
    claimed = await seams.persistAdvance(record.id, {
      schedule: catchUp.schedule,
      fromNextWindow: catchUp.fromNextWindow,
      fromConsecutiveMisses: catchUp.fromConsecutiveMisses,
      ...(catchUp.caughtUpLastRun !== undefined
        ? { lastRun: catchUp.caughtUpLastRun }
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

  // The operator's answer that nothing added up, read off the record the store
  // holds: while it stands, this window connects to nobody and rotates nothing,
  // and the plan advances past it on the window's own skipped outcome.
  if (standingCompromiseResponse(claimed) !== undefined) {
    entry.disposition = "skipped";
    await seams.persistAdvance(record.id, {
      schedule: advanceManagedScheduleAfterWindow(planned, due, "skipped"),
      fromNextWindow: planned.nextWindow,
      fromConsecutiveMisses: planned.consecutiveMisses,
      lastRun: { at: new Date(seams.now()).toISOString(), outcome: "skipped" },
    });
    return { ...entry };
  }

  // A record holding no shared secret runs from the command line and nowhere
  // else. The record schema keeps a schedule and a handle off one, so this
  // reports a store hand-edited past that rule rather than a state the app
  // writes.
  if (!runnableManagedExchange(claimed))
    return { ...entry, skipped: "configuration-only" };

  const handle = claimed.inputFileHandle;
  // Without a persisted handle there is no unattended read of the input at all
  // (the re-selection path needs an operator), so the window is left
  // unaccounted: it counts as missed at the wake that finds it elapsed.
  if (handle === undefined) return { ...entry, skipped: "no-input-handle" };

  const occupancy = await occupyWindow(claimed.id, planned, due, seams);
  entry.attempts = occupancy.attempts;
  if (occupancy.ended !== undefined)
    return { ...entry, skipped: occupancy.ended };
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
    // A window the answer stopped mid-occupancy takes the same stamp as one the
    // answer stood over from the start: the attempt it stopped never connected,
    // so it wrote no `lastRun` of its own.
    ...(occupancy.disposition === "skipped"
      ? {
          lastRun: {
            at: new Date(seams.now()).toISOString(),
            outcome: "skipped" as const,
          },
        }
      : {}),
    ...(occupancy.standingCondition !== undefined
      ? { standingCondition: occupancy.standingCondition }
      : {}),
  });
  return { ...entry };
}

/** What occupying one window produced: how many attempts it took, the window's
 * disposition (absent when the window ended before anything decided it), and the
 * standing condition its attempts raised. */
interface WindowOccupancy {
  attempts: number;
  disposition?: ManagedScheduleWindowDisposition;
  /** The first standing condition an attempt raised, carried into the window's
   * own write; absent when none did. */
  standingCondition?: ManagedStandingCondition;
  /** Set where the per-attempt read ended the occupancy with nothing to record:
   * the record is gone, its plan no longer holds this window, or it can no
   * longer run unattended. The caller writes no bookkeeping for the window: a
   * deleted record has nothing to write onto, and a moved plan would drop the
   * conditioned write anyway. */
  ended?: "deleted" | "plan-moved" | "configuration-only" | "no-input-handle";
}

/**
 * Occupy one open window with bounded re-attempts.
 *
 * Each attempt re-reads the stored record before it connects and runs THAT
 * record -- its secret, input handle, document, and max-age policy -- so an
 * edit or an attended rotation landing mid-window reaches the attempts after
 * it. The same read ends the occupancy:
 *
 * - as `"succeeded"` where another context recorded a success inside this
 *   window, which is how catch-up reads the same record;
 * - as `"skipped"` where the operator's compromise response stands;
 * - with no disposition where the record is gone, its plan no longer holds
 *   this window, or it has lost its secret or its input handle.
 *
 * Each attempt waits for the partner up to {@link ATTEMPT_PEER_WAIT_MS},
 * clamped to what is left of the window; a retryable failure starts another
 * attempt no sooner than {@link ATTEMPT_RATE_GAP_MS} after the last one began,
 * and no later than the window's close, which ends the occupancy anyway.
 * The window's disposition folds every attempt rather than reading the last one
 * (see {@link foldWindowDisposition}).
 *
 * The first standing condition an attempt raises is carried out with the
 * disposition, for the window's own write to persist. Each attempt's run already
 * stamps it best-effort, so this is a second chance rather than the only one:
 * the case it covers is a store that refused the run's stamp -- the rotation
 * write and the bookkeeping write alike -- and then answered the window's write,
 * which would otherwise advance the plan past a window whose failure left no
 * evidence at all.
 */
async function occupyWindow(
  id: string,
  planned: ManagedExchangeSchedule,
  window: ManagedScheduleWindow,
  seams: ManagedScheduleTickSeams,
): Promise<WindowOccupancy> {
  let attempts = 0;
  let partnerWasAbsent = false;
  let contactWasProven = false;
  let disposition: ManagedScheduleWindowDisposition | undefined;
  let standingCondition: ManagedStandingCondition | undefined;
  for (;;) {
    // A runtime going away mid-window leaves the window UNRESOLVED: it is still
    // open, and recording a miss for one this runner simply stopped occupying
    // would count a miss the partner may yet have been met in. A later wake
    // decides it from the stored plan.
    if (seams.stopped()) return { attempts };
    const startedAtMs = seams.now();
    const remainingMs = window.closesAtMs - startedAtMs;
    if (remainingMs <= 0 || attempts >= MAX_WINDOW_ATTEMPTS) break;
    // The operator's answer is read off the store before every connect, as the
    // run+rotate lock re-reads the sibling spent state before every run
    // ({@link ./managedExchangeRun.ts}): an answer written while this window is
    // being occupied must stop the attempt after it, not just the next window.
    // The answer rides on a raised condition, so the window's write has no
    // evidence of its own to carry here.
    const stored = await seams.readRecord(id);
    if (stored === undefined) return { attempts, ended: "deleted" };
    if (!planHoldsWindow(stored.schedule, planned, window))
      return { attempts, ended: "plan-moved" };
    // Checked ahead of the answer: a `"skipped"` advance would stamp its
    // `lastRun` over the success, and the window was met.
    if (windowMetByRecordedSuccess(stored, window, startedAtMs))
      return { attempts, disposition: "succeeded" };
    if (standingCompromiseResponse(stored) !== undefined)
      return { attempts, disposition: "skipped" };
    if (!runnableManagedExchange(stored))
      return { attempts, ended: "configuration-only" };
    const handle = stored.inputFileHandle;
    if (handle === undefined) return { attempts, ended: "no-input-handle" };
    attempts += 1;
    let dataExchangeStarted = false;
    try {
      await seams.runAttempt({
        record: stored,
        source: { kind: "handle", handle, attendance: "unattended" },
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
      if (verdict.standing !== undefined && standingCondition === undefined)
        standingCondition = {
          since: new Date(seams.now()).toISOString(),
          kind: verdict.standing,
        };
      if (!verdict.retryable)
        return {
          attempts,
          disposition: foldWindowDisposition(
            verdict.disposition,
            partnerWasAbsent,
            contactWasProven,
          ),
          ...(standingCondition !== undefined ? { standingCondition } : {}),
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
    ...(standingCondition !== undefined ? { standingCondition } : {}),
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
interface ManagedScheduleWindowVerdict {
  /** The window's disposition if this is the last attempt. */
  disposition: ManagedScheduleWindowDisposition;
  /** Whether another attempt inside this window can do better. */
  retryable: boolean;
  /** Whether this failure establishes that the partner WAS met in this window,
   * which is what keeps an earlier attempt's absence from folding the window to
   * `"missed"` (see {@link attemptProvesContact}). */
  provesContact: boolean;
  /** The standing condition this failure raises, absent for a failure that
   * raises none. The attempt's own run stamps it too, best-effort; the window
   * carries it so a store that refused that stamp and then recovered still
   * leaves the evidence behind (see {@link occupyWindow}). */
  standing?: ManagedStandingConditionKind;
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
 * the window's fold to read (see {@link attemptProvesContact}), and the standing
 * condition it raises, for the window's bookkeeping to carry.
 */
function managedScheduleWindowVerdict(
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
  if (error instanceof RotationPersistError)
    return {
      disposition: "failed",
      retryable: false,
      provesContact,
      standing: "storage",
    };
  if (error instanceof ConnectionError && error.kind === "security")
    return {
      disposition: "failed",
      retryable: false,
      provesContact,
      // Gated on the phase boundary exactly as the attempt's own stamp is
      // ({@link ./managedRun.ts}, `rerunFailureLastRun`), so the window and the
      // run cannot disagree about whether the handshake is what failed.
      ...(dataExchangeStarted ? {} : { standing: "auth" as const }),
    };
  if (
    error instanceof ManagedExchangeExpiredError ||
    error instanceof ManagedExchangeSpentError ||
    error instanceof ManagedExchangeCustodyUnreadableError ||
    error instanceof ManagedExchangeNotRunnableError ||
    error instanceof ManagedInputError ||
    error instanceof LinkageTermsUnsatisfiableError ||
    error instanceof OutboundDisclosureRefusalError
  )
    return { disposition: "failed", retryable: false, provesContact };
  return { disposition: "failed", retryable, provesContact };
}

/** Whether the stored schedule still plans `window` on the cadence and miss
 * count the occupancy was claimed on: the fields the window's own conditioned
 * write is held to, so an occupancy that went on past a change here would end
 * in a write the store drops. */
function planHoldsWindow(
  stored: ManagedExchangeSchedule | undefined,
  planned: ManagedExchangeSchedule,
  window: ManagedScheduleWindow,
): boolean {
  return (
    stored !== undefined &&
    parseStoredInstant(stored.anchor) === parseStoredInstant(planned.anchor) &&
    stored.intervalDays === planned.intervalDays &&
    stored.windowSeconds === planned.windowSeconds &&
    parseStoredInstant(stored.nextWindow) === window.opensAtMs &&
    stored.consecutiveMisses === planned.consecutiveMisses
  );
}

/** Whether the stored `lastRun` is a success stamped inside `window` and not
 * after `nowMs`: a run another context completed in a free interval of this
 * occupancy. Later attempts would find the partner gone and stamp a miss over
 * it. */
function windowMetByRecordedSuccess(
  record: ManagedExchangeRecord,
  window: ManagedScheduleWindow,
  nowMs: number,
): boolean {
  const lastRun = record.lastRun;
  if (lastRun?.outcome !== "succeeded") return false;
  const atMs = parseStoredInstant(lastRun.at);
  return atMs >= window.opensAtMs && atMs < window.closesAtMs && atMs <= nowMs;
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
