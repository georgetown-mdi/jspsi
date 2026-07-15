/**
 * The pure orchestration of a managed (recurring) exchange re-run -- the attended
 * path: launch a run from a stored record, reconnecting to the partner without a
 * new invitation and completing through the durable rotate-and-persist path. It
 * is the tested boundary for the re-run's decisions and ordering, with every
 * platform operation injected: the pre-connection checks (expiry, then input),
 * the side dispatch, the phase assembly into {@link runManagedExchange}, and the
 * `lastRun` classification of a failure the runner (not the critical section)
 * owns. No IndexedDB, no Web Locks, no broker, no WASM -- those are the injected
 * seams, wired for real in {@link ./managedRunDriver.ts}.
 *
 * Normative shape (docs/spec/MANAGED_EXCHANGE_RECORD.md, docs/MANAGED_EXCHANGE.md):
 *
 * - **The record's local `side` dispatches the run**, never the document's
 *   `connection.role`: the injected `rendezvous` seam is called with `side`, and
 *   the current `sharedSecret`, so its peer id derives fresh each run.
 * - **The input is acquired per run** through the injected `acquireInput` seam
 *   (the persisted handle, or a re-selection), and its contents are never taken
 *   from the record.
 * - **The pre-connection checks run in order -- expiry, then input -- before any
 *   connection.** A lapsed `expires` is the benign expiry state; an input problem
 *   is the benign `"input"` state; neither is routed through desync/attack
 *   framing. The lock's own unavailability (another tab is running) is the third
 *   benign "already running" state.
 * - **Persist-before-success is {@link runManagedExchange}'s**, unchanged: this
 *   module only supplies the phases it gates.
 */

import {
  ManagedExchangeExpiredError,
  managedExchangeLapsed,
} from "./managedExpiry";
import {
  ManagedExchangeLockUnavailableError,
  runManagedExchange,
} from "./managedExchangeRun";
import { ManagedInputError } from "./managedInputGuard";
import { RotationPersistError } from "./managedRunRotate";

import type {
  ManagedExchangeLockOptions,
  ManagedExchangeRunResult,
} from "./managedExchangeRun";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The handshake result a re-run's handshake phase yields: the rotated secret the
 * persist-before-success write advances, plus whatever the data-exchange phase
 * needs carried through the lock. Generic over the carried handshake value so the
 * platform wiring names its own concrete type (the message connection, the PSI
 * library, the prepared exchange) and a test names a trivial one. */
export interface ManagedRerunHandshake<THandshake> {
  rotatedSecret: string;
  handshake: THandshake;
}

/** The platform seams a re-run injects, each the wiring the pure orchestration
 * cannot own. Split so the run's decisions and ordering are testable without a
 * broker, a database, or WASM. */
export interface ManagedRerunSeams<TInput, THandshake, TExchange> {
  /**
   * Acquire and validate the input file BEFORE any connection: read it through
   * the persisted handle (attended may prompt once) or the re-selected file, then
   * reject a missing file, a gone permission, or a column shape the standing terms
   * cannot satisfy as a benign {@link ManagedInputError}. Its contents are never
   * taken from the record. Its result feeds the handshake, so the connection is
   * structurally unreachable until this passes.
   */
  acquireInput: () => Promise<TInput>;
  /**
   * Open the side-dispatched rendezvous, authenticate the partner, and yield the
   * rotated secret plus the carried value the data exchange consumes. Receives the
   * acquired input. The side dispatch and the fresh peer-id derivation live inside
   * this seam (see {@link ./managedRendezvous.ts}); this module only guarantees it
   * runs after the pre-connection checks and inside the run+rotate lock.
   */
  handshake: (input: TInput) => Promise<ManagedRerunHandshake<THandshake>>;
  /** Run the data exchange -- reachable only after the durable persist resolves.
   * Receives the handshake's carried value. */
  dataExchange: (handshake: THandshake) => Promise<TExchange>;
}

/** How a re-run launches, plus the clock. `attendance` is the run path (attended
 * may prompt for a gone permission; unattended never), passed through to the
 * input seam by the wiring; the pure orchestration only needs the record and the
 * clock. */
export interface ManagedRerunOptions {
  /** The clock, injected so a test can pin the expiry check and the bookkeeping
   * stamp. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Lock acquisition discipline. The attended re-run sets `ifAvailable` so a lock
   * already held by a scheduled run or another tab surfaces the benign "already
   * running elsewhere" state ({@link ManagedExchangeLockUnavailableError}) rather
   * than silently waiting; the default (queue) is a valid single-writer discipline
   * too, so this is the caller's choice.
   */
  lock?: ManagedExchangeLockOptions;
}

/**
 * Launch a managed exchange re-run from a stored record. The pre-connection
 * checks run first and in order:
 *
 * 1. **Expiry.** A lapsed `expires` (as of `now`) re-raises a
 *    {@link ManagedExchangeExpiredError} before any connection -- its own benign
 *    state, read from `expires` itself (no `lastRun` is written for it: no run
 *    happened, and the record already carries the lapse), never the desync/attack
 *    framing.
 * 2. **Input, then the run.** {@link runManagedExchange} acquires and validates the
 *    input before the handshake opens any connection (a {@link ManagedInputError}
 *    is its benign `"input"` tier), holds the single-writer lock across the
 *    handshake and the durable rotation persist, then runs the data exchange and
 *    records success.
 *
 * The lock's own unavailability ({@link ManagedExchangeLockUnavailableError}: a run
 * is already in progress in another tab) propagates for the caller to surface as
 * the benign "already running elsewhere" state -- not a failure of this run. Every
 * benign pre-run state (expiry, input, lock-unavailable) and the storage tier are
 * classified here or in runManagedExchange; a handshake or data-exchange failure
 * propagates unchanged for the caller to surface through the existing generic
 * path.
 *
 * @throws {ManagedExchangeExpiredError} if the stored secret has lapsed (checked
 *   before any connection).
 * @throws {ManagedInputError} if the input guard rejects (a missing file, a gone
 *   permission, or an unsatisfiable column shape); no connection was attempted.
 * @throws {ManagedExchangeLockUnavailableError} if a run is already in progress in
 *   another same-origin context.
 * @throws {RotationPersistError} if the rotation write fails after the handshake.
 */
export async function runManagedRerun<TInput, THandshake, TExchange>(
  record: ManagedExchangeRecord,
  seams: ManagedRerunSeams<TInput, THandshake, TExchange>,
  options: ManagedRerunOptions = {},
): Promise<ManagedExchangeRunResult<TExchange>> {
  const now = options.now ?? Date.now;

  // Expiry is checked BEFORE any connection and is its own benign state, read from
  // `expires` itself: a lapsed bound re-raises without ever dispatching the
  // rendezvous, so it is never ambiguous with a handshake failure. No lastRun is
  // written -- no run happened, and the record already carries the lapse.
  if (managedExchangeLapsed(record, now())) {
    // record.expires is defined here: managedExchangeLapsed returns true only when
    // it is set and in the past.
    throw new ManagedExchangeExpiredError(record.expires as string);
  }

  // The input guard, the single-writer lock, the persist-before-success rotation,
  // and the data exchange are runManagedExchange's, wired to this record's seams.
  return runManagedExchange<TInput, THandshake, TExchange>({
    record: {
      id: record.id,
      ...(record.tokenMaxAgeDays !== undefined
        ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
        : {}),
    },
    acquireInput: seams.acquireInput,
    handshake: seams.handshake,
    dataExchange: seams.dataExchange,
    ...(options.lock !== undefined ? { lock: options.lock } : {}),
    now,
  });
}

/** The benign, pre-connection outcomes of a launch a surface classifies without
 * attack framing: a lapsed bound, an input problem, or a run already in progress
 * elsewhere. */
export type BenignRerunOutcome = "expired" | "input" | "already-running";

/** Classify a launch failure into the benign pre-connection outcome it carries,
 * or `undefined` for a failure that is not one of the three benign states (a
 * handshake failure, a storage failure, a data-exchange drop) -- which the caller
 * surfaces through the existing generic path. Keeps the three benign-state checks
 * in one place so a surface cannot mis-order or omit one. */
export function benignRerunOutcome(
  error: unknown,
): BenignRerunOutcome | undefined {
  if (error instanceof ManagedExchangeExpiredError) return "expired";
  if (error instanceof ManagedInputError) return "input";
  if (error instanceof ManagedExchangeLockUnavailableError)
    return "already-running";
  return undefined;
}

export { ManagedExchangeExpiredError, ManagedInputError };
export { ManagedExchangeLockUnavailableError, RotationPersistError };
