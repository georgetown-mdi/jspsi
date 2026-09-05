/**
 * The pure orchestration of a managed (recurring) exchange re-run -- the attended
 * path: launch a run from a stored record, reconnecting to the partner without a
 * new invitation, completing through the durable rotate-and-persist path. The
 * platform operations are injected: the pre-connection checks (expiry, then
 * input), the side dispatch, the phase assembly into {@link runManagedExchange},
 * and the `lastRun` classification of a runner-owned failure ({@link
 * rerunFailureLastRun}, written best-effort). No broker, no WASM: both are wired
 * for real in {@link ./managedRunDriver.ts}.
 *
 * The normative shape is docs/spec/MANAGED_EXCHANGE_RECORD.md and
 * docs/MANAGED_EXCHANGE.md. This module holds three constraints from it: the
 * record's local `side` dispatches the run, never `connection.role`; the input
 * is acquired per run through `acquireInput`, never read from the record; and
 * the pre-connection checks run in order -- expiry, hand-off refusal, input --
 * before any connection. Persist-before-success is {@link runManagedExchange}'s;
 * this module only supplies the phases it gates.
 */

import {
  ConnectionError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  OutboundDisclosureRefusalError,
} from "@psilink/core";

import {
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeSpentError,
  runManagedExchange,
} from "./managedExchangeRun";
import {
  ManagedExchangeExpiredError,
  managedExchangeLapsed,
} from "./managedExpiry";
import {
  ManagedInputError,
  managedInputFailureKind,
} from "./managedInputGuard";
import { RotationPersistError, failedRun, missedRun } from "./managedRunRotate";
import { ManagedExchangeLockUnavailableError } from "./managedExchangeLock";
import { PartnerNoShowError } from "./waitForConnection";
import { hasRecoveryHint } from "./authenticateExchange";
import { recordManagedExchangeLastRun } from "./managedExchangeStore";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { ManagedExchangeLockOptions } from "./managedExchangeLock";
import type { ManagedExchangeRunResult } from "./managedExchangeRun";

/** The handshake result a re-run's handshake phase yields: the rotated secret the
 * persist-before-success write advances, plus whatever the data-exchange phase
 * needs, passed through the lock. Generic over the handshake value so the
 * platform wiring names its own concrete type (the message connection, the PSI
 * library, the prepared exchange) and a test names a trivial one. */
export interface ManagedRerunHandshake<THandshake> {
  rotatedSecret: string;
  handshake: THandshake;
}

/** The platform operations a re-run injects, each the wiring the pure
 * orchestration cannot own. Split so the run's decisions and ordering are
 * testable without a broker, a database, or WASM. */
export interface ManagedRerunSeams<TInput, THandshake, TExchange> {
  /**
   * Acquire and validate the input file BEFORE any connection: read it through
   * the persisted handle (attended may prompt once) or the re-selected file, then
   * reject a missing file, a gone permission, or a column shape the standing terms
   * cannot satisfy as a benign {@link ManagedInputError}. Its contents are never
   * taken from the record. Its result feeds the handshake, so the connection is
   * unreachable until this passes.
   */
  acquireInput: () => Promise<TInput>;
  /**
   * Open the side-dispatched rendezvous, authenticate the partner, and yield the
   * rotated secret plus the value the data exchange consumes. Receives the
   * acquired input. The side dispatch and the fresh peer-id derivation live here
   * (see {@link ./managedRendezvous.ts}); this module only guarantees it runs
   * after the pre-connection checks and inside the run+rotate lock.
   */
  handshake: (input: TInput) => Promise<ManagedRerunHandshake<THandshake>>;
  /** Run the data exchange -- reachable only after the durable persist resolves.
   * Receives the handshake's output value. */
  dataExchange: (handshake: THandshake) => Promise<TExchange>;
}

/** How a re-run launches, plus the clock. `attendance` is the run path (attended
 * may prompt for a gone permission; unattended never), passed through to
 * `acquireInput` by the wiring; the pure orchestration only needs the record and
 * the clock. */
export interface ManagedRerunOptions {
  /** The clock, injected so a test can pin the expiry check and the bookkeeping
   * stamp. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Lock acquisition discipline. The attended re-run sets `ifAvailable` so a lock
   * already held by a scheduled run or another tab raises the benign "already
   * running elsewhere" state ({@link ManagedExchangeLockUnavailableError}) instead
   * of waiting; the default (queue) is also a valid single-writer discipline.
   */
  lock?: ManagedExchangeLockOptions;
  /**
   * Whether the run's owner has cancelled it (the driver passes the run signal's
   * `aborted`). Read only when classifying a failed run's bookkeeping, so a
   * teardown-provoked error on an operator-cancelled run records `"cancelled"`
   * rather than a transport fault. Defaults to never-cancelled.
   */
  aborted?: () => boolean;
  /**
   * Called once when the data exchange begins -- the phase boundary past which
   * payload could have flowed. The run's own failure bookkeeping reads that
   * boundary ({@link rerunFailureLastRun}), and a caller classifying the failure
   * for display needs the same value: a state whose copy tells the operator
   * nothing left this device is accurate only before this boundary (see
   * {@link benignRerunOutcome}). Optional: omit it if never classifying a
   * failure.
   */
  onDataExchangeStart?: () => void;
}

/**
 * Launch a managed exchange re-run from a stored record. The pre-connection
 * checks run first and in order:
 *
 * 1. **Expiry.** A lapsed `expires` (as of `now`) re-raises a
 *    {@link ManagedExchangeExpiredError} before any connection; no `lastRun` is
 *    written (no run happened, and the record already holds the lapse).
 * 2. **The hand-off refusal, the input, then the run.**
 *    {@link runManagedExchange} takes the single-writer lock, refuses a copy an
 *    export handed off ({@link ManagedExchangeSpentError}, the `"handed-off"`
 *    state), then acquires and validates the input before the handshake opens
 *    any connection (a {@link ManagedInputError} has the `"input"` or
 *    `"terms-shortfall"` tier), holds the lock across the handshake and the
 *    durable rotation persist, then runs the data exchange and records success.
 *
 * The lock's own unavailability ({@link ManagedExchangeLockUnavailableError}: a
 * run is already in progress in another tab) propagates for the caller to show
 * as the benign "already running elsewhere" state. A handshake or data-exchange
 * failure is stamped into the record's `lastRun` best-effort
 * ({@link rerunFailureLastRun}) and then propagates unchanged. A bound that
 * lapses mid-run -- after the pre-connection check but before the handshake
 * completes -- fails the handshake through core's own expiry guards and is
 * re-mapped to the same {@link ManagedExchangeExpiredError} the pre-connection
 * check raises ({@link remapLapsedRunFailure}).
 *
 * @throws {ManagedExchangeExpiredError} if the stored secret has lapsed -- before
 *   any connection, or during the run (re-mapped from the handshake's own expiry
 *   failure).
 * @throws {ManagedExchangeSpentError} if an export handed this device's copy off;
 *   no input was read and no connection was attempted.
 * @throws {ManagedExchangeCustodyUnreadableError} if the sibling entry holding
 *   that state could not be read; the run refuses rather than rotating on an
 *   unread custody.
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

  // Checked before any connection: a lapsed bound means no run happened, so no
  // lastRun is written.
  if (managedExchangeLapsed(record, now())) {
    // record.expires is defined here: managedExchangeLapsed returns true only when
    // it is set.
    throw new ManagedExchangeExpiredError(record.expires as string);
  }

  // Whether the data exchange began before the failure, captured at the phase
  // boundary runManagedExchange marks. Read by the classification below (see
  // rerunFailureLastRun) and passed to the caller via onDataExchangeStart.
  let dataExchangeStarted = false;

  // The input guard, the single-writer lock, the persist-before-success rotation,
  // and the data exchange are runManagedExchange's, wired to this record's seams.
  try {
    return await runManagedExchange<TInput, THandshake, TExchange>({
      record: {
        id: record.id,
        ...(record.tokenMaxAgeDays !== undefined
          ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
          : {}),
      },
      acquireInput: seams.acquireInput,
      handshake: seams.handshake,
      dataExchange: seams.dataExchange,
      onDataExchangeStart: () => {
        dataExchangeStarted = true;
        options.onDataExchangeStart?.();
      },
      ...(options.lock !== undefined ? { lock: options.lock } : {}),
      now,
    });
  } catch (error) {
    // A bound that lapsed mid-run remaps to the same benign expiry (see
    // remapLapsedRunFailure).
    const lapsed = remapLapsedRunFailure(error, record, now());
    if (lapsed !== undefined) throw lapsed;
    // Everything rerunFailureLastRun does not own (see its doc) is stamped here.
    const lastRun = rerunFailureLastRun(
      error,
      now(),
      options.aborted?.() ?? false,
      dataExchangeStarted,
    );
    if (lastRun !== undefined) {
      // Best-effort: a failed write here must never replace the run's own
      // failure.
      try {
        await recordManagedExchangeLastRun(record.id, lastRun);
      } catch {
        // Swallowed: the original failure still reaches the caller on the rethrow.
      }
    }
    throw error;
  }
}

/**
 * Re-map a run failure caused by the bound lapsing MID-RUN -- after the
 * pre-connection expiry check passed but before the handshake completed -- to
 * the benign {@link ManagedExchangeExpiredError}, or `undefined` when the
 * failure is not that case. Core's expiry guards throw errors tagged
 * `psilinkRecoveryHintEmitted` (the tag survives the security re-wrap; see
 * {@link hasRecoveryHint}); the re-map additionally requires the record's bound
 * has in fact lapsed by `now`, since the tag alone also covers a
 * malformed-secret error (which cannot arise here: a stored secret is
 * regex-validated on every read).
 *
 * {@link InternalConsistencyError} is excluded by type: the single-pass reply-
 * cap safety check also raises it mid-data-exchange, coinciding with a bound
 * lapsing during a long run as readily as with a real expiry, and re-mapping it
 * would report a defect in psilink as a benign expiry that a fresh invitation
 * cannot fix.
 */
export function remapLapsedRunFailure(
  error: unknown,
  record: Pick<ManagedExchangeRecord, "expires">,
  now: number,
): ManagedExchangeExpiredError | undefined {
  if (error instanceof InternalConsistencyError) return undefined;
  if (!hasRecoveryHint(error)) return undefined;
  if (!managedExchangeLapsed(record, now)) return undefined;
  // expires is defined here: managedExchangeLapsed returns true only when it is
  // set.
  return new ManagedExchangeExpiredError(record.expires as string);
}

/**
 * The `lastRun` bookkeeping for a failed run the runner (not the critical
 * section) classifies, or `undefined` for a failure whose bookkeeping is owned
 * elsewhere or absent by design:
 *
 * - {@link ManagedInputError}, {@link RotationPersistError},
 *   {@link ManagedExchangeSpentError}, and
 *   {@link ManagedExchangeCustodyUnreadableError}: already recorded
 *   best-effort inside the critical section.
 * - {@link LinkageTermsUnsatisfiableError} before the data exchange began:
 *   records `terms-shortfall` here, since this refusal comes from the
 *   pre-connection prepare rather than the input guard.
 * - {@link ManagedExchangeExpiredError} and
 *   {@link ManagedExchangeLockUnavailableError}: unrecorded -- no run began,
 *   and the record's own `expires` already holds the lapse.
 *
 * Everything else is this run's to stamp. Read before the `aborted` check,
 * since both are deterministic local states an abort cannot produce:
 * {@link OutboundDisclosureRefusalError} before the data exchange began
 * records `consent`; {@link PartnerNoShowError} before the data exchange began
 * records the benign `missed` outcome ({@link missedRun}). `aborted` then
 * records `cancelled`. A `security`-kind {@link ConnectionError} before the
 * data exchange began records `auth`. Everything else -- including any of
 * these once the data exchange began -- records `transport`.
 *
 * `terms-shortfall`, `consent`, `auth`, and `missed` require
 * `!dataExchangeStarted`: each tells the operator nothing left this device.
 * Every outcome here is `failed` apart from `missed`; `desynced` is stamped
 * elsewhere.
 */
export function rerunFailureLastRun(
  error: unknown,
  at: number,
  aborted: boolean,
  dataExchangeStarted: boolean,
): ManagedExchangeLastRun | undefined {
  if (
    error instanceof ManagedExchangeCustodyUnreadableError ||
    error instanceof ManagedExchangeExpiredError ||
    error instanceof ManagedExchangeLockUnavailableError ||
    error instanceof ManagedExchangeSpentError ||
    error instanceof ManagedInputError ||
    error instanceof RotationPersistError
  )
    return undefined;
  if (error instanceof LinkageTermsUnsatisfiableError && !dataExchangeStarted)
    return failedRun(at, "failed", "terms-shortfall");
  if (error instanceof OutboundDisclosureRefusalError && !dataExchangeStarted)
    return failedRun(at, "failed", "consent");
  if (error instanceof PartnerNoShowError && !dataExchangeStarted)
    return missedRun(at);
  if (aborted) return failedRun(at, "failed", "cancelled");
  if (
    error instanceof ConnectionError &&
    error.kind === "security" &&
    !dataExchangeStarted
  )
    return failedRun(at, "failed", "auth");
  return failedRun(at, "failed", "transport");
}

/** The benign outcomes a surface classifies without attack framing. The first
 * six are read before any connection is attempted; `"missed"` is read after a
 * connection attempt found no partner. */
export type BenignRerunOutcome =
  | "expired"
  | "handed-off"
  | "custody-unreadable"
  | "input"
  | "terms-shortfall"
  | "already-running"
  | "missed";

/** Classify a launch failure into the benign outcome it holds, or `undefined`
 * for a failure that is not one of these states (a handshake failure, a storage
 * failure, a data-exchange drop), which the caller exposes through the generic
 * path. Keeps the benign-state checks in one place so a surface cannot mis-order
 * or omit one.
 *
 * `"missed"` is the one state here a connection attempt reaches -- the wait for
 * the partner's runner spent its whole budget with nobody arriving -- and it
 * stays out of the transport bucket since no handshake ran and nothing left
 * this device.
 *
 * `"handed-off"` is read before the input state because the run refuses in that
 * order (see {@link ./managedExchangeRun.ts}): a copy an export gave away is
 * refused before its input file is read.
 *
 * `"custody-unreadable"` is read off the error rather than the record's stamp:
 * the failure that raises it takes the record's own evidence with it, so
 * reading from the record alone would fall through to the retryable transport
 * tier -- offering a retry for a permanent local problem.
 *
 * `"input"` and `"terms-shortfall"` are split by remedy (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md): putting the file back clears `"input"`;
 * `"terms-shortfall"` refuses identically until the file or the standing terms
 * change. Both read their kind from {@link managedInputFailureKind}, matching
 * the stamp {@link rerunFailureLastRun} records for the same failure.
 *
 * `dataExchangeStarted` (from {@link ManagedRerunOptions.onDataExchangeStart})
 * gates every outcome whose copy tells the operator nothing left this device:
 * `"missed"` and `"terms-shortfall"` share the guard their bookkeeping
 * counterpart applies in {@link rerunFailureLastRun}, so the state a surface
 * shows and the outcome the record holds cannot disagree. `"handed-off"` and
 * `"custody-unreadable"` are guarded here alone, since the critical section
 * always writes their stamp before any connection. A failure delivered past the
 * boundary is not a benign outcome here and falls through to the caller's
 * generic transport path.
 *
 * This guard classifies off THIS run's live error. A surface classifying off
 * the record's stored bookkeeping instead ({@link ./managedFailureTiers.ts})
 * applies the same boundary at its own read site
 * ({@link ../bench/managedRunLaunchModel.ts}).
 */
export function benignRerunOutcome(
  error: unknown,
  dataExchangeStarted: boolean,
): BenignRerunOutcome | undefined {
  if (error instanceof ManagedExchangeExpiredError) return "expired";
  if (error instanceof ManagedExchangeSpentError && !dataExchangeStarted)
    return "handed-off";
  if (
    error instanceof ManagedExchangeCustodyUnreadableError &&
    !dataExchangeStarted
  )
    return "custody-unreadable";
  if (error instanceof ManagedInputError && !dataExchangeStarted)
    return managedInputFailureKind(error.rejection);
  if (error instanceof LinkageTermsUnsatisfiableError && !dataExchangeStarted)
    return "terms-shortfall";
  if (error instanceof ManagedExchangeLockUnavailableError)
    return "already-running";
  if (error instanceof PartnerNoShowError && !dataExchangeStarted)
    return "missed";
  return undefined;
}

export { ManagedExchangeExpiredError, ManagedInputError };
export { ManagedExchangeLockUnavailableError, RotationPersistError };
export { ManagedExchangeCustodyUnreadableError, ManagedExchangeSpentError };
