/**
 * The pure orchestration of a managed (recurring) exchange re-run -- the attended
 * path: launch a run from a stored record, reconnecting to the partner without a
 * new invitation and completing through the durable rotate-and-persist path. It
 * is the tested boundary for the re-run's decisions and ordering, with the
 * platform operations injected: the pre-connection checks (expiry, then input),
 * the side dispatch, the phase assembly into {@link runManagedExchange}, and the
 * `lastRun` classification of a failure the runner (not the critical section)
 * owns -- the classification itself pure ({@link rerunFailureLastRun}), its write
 * the store's monotonic bookkeeping write, best-effort. No broker, no WASM --
 * those are the injected seams, wired for real in {@link ./managedRunDriver.ts}.
 *
 * Normative shape (docs/spec/MANAGED_EXCHANGE_RECORD.md, docs/MANAGED_EXCHANGE.md):
 *
 * - **The record's local `side` dispatches the run**, never the document's
 *   `connection.role`: the injected `rendezvous` seam is called with `side`, and
 *   the current `sharedSecret`, so its peer id derives fresh each run.
 * - **The input is acquired per run** through the injected `acquireInput` seam
 *   (the persisted handle, or a re-selection), and its contents are never taken
 *   from the record.
 * - **The pre-connection checks run in order -- expiry, then the hand-off refusal,
 *   then input -- before any connection.** A lapsed `expires` is the benign expiry
 *   state; a copy an export handed off is the benign `"handed-off"` state, refused
 *   inside the run+rotate lock so no run rotates a secret this device gave away
 *   ({@link ./managedExchangeRun.ts}); an input problem
 *   is the benign `"input"` or `"terms-shortfall"` state, split by which remedy it
 *   calls for; neither is routed through desync/attack framing. The lock's own
 *   unavailability (another tab is running) is a benign state of its own beside
 *   them, as is a partner who never arrives in the rendezvous wait -- the benign
 *   `"missed"` outcome, held apart from a transport fault (a connection that was
 *   made and broke) and from the operator's own cancellation.
 * - **Persist-before-success is {@link runManagedExchange}'s**, unchanged: this
 *   module only supplies the phases it gates.
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
   * boundary ({@link rerunFailureLastRun}), and a caller that classifies the
   * failure for display needs the same value: every state whose copy tells the
   * operator nothing left this device is honest only before it (see
   * {@link benignRerunOutcome}). Optional: a caller that never classifies a
   * failure omits it.
   */
  onDataExchangeStart?: () => void;
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
 * 2. **The hand-off refusal, the input, then the run.**
 *    {@link runManagedExchange} takes the single-writer lock, refuses a copy an
 *    export handed off ({@link ManagedExchangeSpentError}, the benign
 *    `"handed-off"` state), then acquires and validates the input before the
 *    handshake opens any connection (a {@link ManagedInputError} is its benign
 *    `"input"` or `"terms-shortfall"` tier), holds the lock across the handshake
 *    and the durable rotation persist, then runs the data exchange and records
 *    success.
 *
 * The lock's own unavailability ({@link ManagedExchangeLockUnavailableError}: a run
 * is already in progress in another tab) propagates for the caller to surface as
 * the benign "already running elsewhere" state -- not a failure of this run. A
 * handshake or data-exchange failure is the runner's to classify and record (the
 * contract runManagedExchange states): it is stamped into the record's `lastRun`
 * best-effort here ({@link rerunFailureLastRun}) and then propagates unchanged for
 * the caller's generic failure surface. A bound that lapses mid-run -- after the
 * pre-connection check but before the handshake completes -- fails the handshake
 * through core's own expiry guards and is re-mapped to the same benign
 * {@link ManagedExchangeExpiredError} the pre-connection check raises
 * ({@link remapLapsedRunFailure}), so expiry is never routed through attack
 * framing even in that race window.
 *
 * @throws {ManagedExchangeExpiredError} if the stored secret has lapsed -- before
 *   any connection (the pre-connection check), or during the run (re-mapped from
 *   the handshake's own expiry failure).
 * @throws {ManagedExchangeSpentError} if an export handed this device's copy off;
 *   no input was read and no connection was attempted.
 * @throws {ManagedExchangeCustodyUnreadableError} if the sibling entry holding
 *   that state could not be read, on the same terms -- the run refuses rather
 *   than rotating on an unread custody.
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
    // it is set.
    throw new ManagedExchangeExpiredError(record.expires as string);
  }

  // Whether the data exchange began before the failure -- captured at the phase
  // boundary runManagedExchange marks, consumed by the classification below so a
  // tier that claims nothing was disclosed (a security-kind error's "auth", a
  // disclosure refusal's "consent", a linkage refusal's "terms-shortfall") is
  // stamped only pre-data-exchange, and a failure once payload flow could have
  // started records "transport". The same boundary is reported to the caller, whose
  // display classification of the failure carries the identical guard.
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
    // A bound that lapsed mid-run failed the handshake through core's expiry
    // guards; surface it as the same benign expiry state the pre-connection check
    // raises, never attack framing.
    const lapsed = remapLapsedRunFailure(error, record, now());
    if (lapsed !== undefined) throw lapsed;
    // The bookkeeping boundary: the critical section records its own tiers
    // best-effort (the benign input-guard rejection and the `storage` persist
    // failure); a pre-run expiry and a lock already held stay deliberately
    // unrecorded (no run began, and the record's own `expires` already carries a
    // lapse). Everything else -- the consent refusal the pre-connection prepare
    // raises, and the handshake, transport, and cancelled failures
    // runManagedExchange documents as the runner's to classify and record -- is
    // stamped here.
    const lastRun = rerunFailureLastRun(
      error,
      now(),
      options.aborted?.() ?? false,
      dataExchangeStarted,
    );
    if (lastRun !== undefined) {
      // Best-effort, mirroring the critical section's own bookkeeping writes: a
      // failed lastRun write must never replace the run's own failure, which the
      // caller classifies on.
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
 * pre-connection expiry check passed but before the handshake completed -- to the
 * benign {@link ManagedExchangeExpiredError}, or `undefined` when the failure is
 * not that case. Core's pre- and post-handshake expiry guards throw errors tagged
 * `psilinkRecoveryHintEmitted` (the tag survives the security re-wrap; see
 * {@link hasRecoveryHint}); the tag alone also covers a malformed-secret error, so
 * the re-map additionally requires that the record's bound has in fact lapsed by
 * `now` -- and core throws its expiry error only when it has, so the pair is
 * exact, not a heuristic. (A stored record's secret is regex-validated on every
 * read, so the malformed-tag case cannot arise here regardless; the lapse check
 * covers it anyway.)
 *
 * The rest of core's tagged family are the file-sync transport refusals, which a
 * WebRTC-only browser run never raises. {@link InternalConsistencyError} is the
 * one that does reach here: the single-pass reply-cap backstop runs in the
 * browser too and raises it mid-data-exchange, so a bound lapsing during a long
 * run coincides with it as readily as with a real expiry. It is excluded by
 * type, because re-mapping it would report a defect in psilink as a benign
 * expiry and send the operator to a fresh invitation that cannot fix it.
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
 * The `lastRun` bookkeeping for a failed run the runner (not the critical section)
 * classifies, or `undefined` for a failure whose bookkeeping is owned elsewhere or
 * deliberately absent:
 *
 * - {@link ManagedInputError}, {@link RotationPersistError},
 *   {@link ManagedExchangeSpentError} and
 *   {@link ManagedExchangeCustodyUnreadableError}: recorded best-effort inside the
 *   critical section (the tier {@link managedInputFailureKind} reads off the
 *   rejection, the `storage` tier a failed rotation persist records, the
 *   `custody-unreadable` tier an entry the run could not read records, and the
 *   `handed-off` tier a copy an export gave away records).
 * - A core {@link LinkageTermsUnsatisfiableError} raised BEFORE the data exchange
 *   began: the benign `"terms-shortfall"` tier, stamped here because the refusal
 *   comes out of the pre-connection prepare rather than the input guard, which
 *   stamps the same kind for its own column rejection. This run's file cannot
 *   supply every linkage key the standing terms declare, which no amount of
 *   reconnecting changes, so it must not land in the retryable transport bucket
 *   where a scheduled run would repeat it every cycle -- nor in the `"input"`
 *   tier, whose remedy is re-picking a file that refuses identically.
 * - {@link ManagedExchangeExpiredError} and
 *   {@link ManagedExchangeLockUnavailableError}: deliberately unrecorded -- no
 *   run began, and a lapse is already carried by the record's own `expires`.
 *
 * Everything else is this run's to stamp. A core
 * {@link OutboundDisclosureRefusalError} -- one of the two send-side disclosure
 * gates refusing inside the pre-connection prepare -- records `"consent"` when it
 * fired BEFORE the data exchange began (`!dataExchangeStarted`), and is read
 * BEFORE the abort probe: unlike a teardown-provoked error it is a deterministic
 * local state that refuses identically on the next run, so attributing it to the
 * operator's cancellation would drop the only remedy the record can name. A
 * {@link PartnerNoShowError} is read before that probe for the same reason and
 * records the benign `"missed"` outcome ({@link missedRun}): the rendezvous raises
 * it only when the wait spent its whole budget with the partner absent, which an
 * abort cannot manufacture (an aborted wait rejects through its own abort path),
 * so a cancel landing in the same tick as the budget's end must not overwrite the
 * one thing this run established. It carries the same `!dataExchangeStarted`
 * guard as the tiers beside it, because the `"missed"` outcome is what the
 * disclosure copy reads to say nothing left this device. A
 * cancelled run (`aborted`) then records `"cancelled"`, so a teardown-provoked
 * error on a cancelled run is not misread. A `security`-kind
 * {@link ConnectionError} likewise records `"auth"` only when it fired before the
 * data exchange began -- the authenticated handshake failing closed, which provably
 * precedes any payload. All four guards carry the same weight: `"terms-shortfall"`,
 * `"consent"`, `"auth"`, and the `"missed"` outcome are what tell the operator
 * nothing left this device, so none is stamped on a failure the phase boundary says
 * could have followed payload flow. A refusal or security-kind error once payload
 * flow could have started (core's `EncryptedMessageConnection` raising on a tampered
 * frame mid-exchange) records `"transport"` (the neither-way disclosure bucket), as
 * does any other failure. Every outcome this classifier writes is `"failed"` apart
 * from the no-show's `"missed"` -- `"desynced"` is the later desync-tiering item's
 * call, not this classifier's.
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

/** The benign outcomes of a launch a surface classifies without attack framing: a
 * lapsed bound, a copy an export handed off, a copy whose hand-off state could not
 * be read at all, an unusable input, an input the standing terms cannot be run
 * against, a run already in progress elsewhere, or a partner who never arrived. The
 * first six are read before any connection; the last is read when no connection was
 * ever made. */
export type BenignRerunOutcome =
  | "expired"
  | "handed-off"
  | "custody-unreadable"
  | "input"
  | "terms-shortfall"
  | "already-running"
  | "missed";

/** Classify a launch failure into the benign outcome it carries, or `undefined`
 * for a failure that is not one of these states (a handshake failure, a storage
 * failure, a data-exchange drop) -- which the caller surfaces through the existing
 * generic path. Keeps the benign-state checks in one place so a surface cannot
 * mis-order or omit one.
 *
 * `"missed"` is the one state here a connection attempt reaches: the wait for the
 * partner's runner spent its whole budget with nobody arriving. It belongs beside
 * the pre-connection states because it shares their property -- no handshake ran,
 * so nothing left this device -- and it is held apart from the transport bucket a
 * fall-through would put it in, whose copy would send an operator to check their
 * own connection for a partner who was simply not there.
 *
 * `"handed-off"` is read before the input state for the reason the run refuses in
 * that order: a copy an export gave away is not this device's to run whatever its
 * input file says, and the refusal happens before the file is read.
 *
 * `"custody-unreadable"` is that same refusal failing to read the entry it decides
 * on, and it is read off the error rather than left to the record's stamp because
 * the failure that raises it takes the record's evidence with it: the stamp is
 * best-effort like every other, and a local store that did not answer the run is
 * what makes the caller's post-failure reload reject too, leaving it classifying
 * against a record carrying no stamp at all. Read from the record alone it falls
 * through to the retryable transport tier -- a retry offered for a permanent local
 * problem, which is what the kind exists to prevent.
 *
 * The two input states are split by what the operator can do about them, since
 * both are read before any connection and only one is worth offering the run again
 * for. `"input"` is the acquisition failure -- the file is missing, moved, or
 * unreadable -- which putting the file back clears. `"terms-shortfall"` is the file
 * that cannot supply every linkage key the standing terms declare, raised either by
 * the input guard's own grading or by core's refusal inside the pre-connection
 * prepare: the same file refuses identically every time, so its remedy is a
 * conforming file or terms settled with the partner, never a retry. Each records
 * the bookkeeping kind of the same name, and the guard's own split is read from
 * {@link managedInputFailureKind} here as well as at the stamp, so a revisit tiers
 * the state a live launch showed rather than a coarser one.
 *
 * `dataExchangeStarted` is the run's own phase boundary, reported by
 * {@link ManagedRerunOptions.onDataExchangeStart}. Every outcome whose copy tells
 * the operator nothing left this device carries it. `"missed"` and
 * `"terms-shortfall"` from either of its two raisers (core's refusal in the
 * pre-connection prepare, and the input guard's own column grading) carry it as
 * the same guard their bookkeeping counterpart applies
 * ({@link rerunFailureLastRun}), so the state a surface shows and the outcome the
 * record carries cannot disagree about a disclosure. `"handed-off"` and
 * `"custody-unreadable"` are guarded here alone -- that classifier records
 * nothing for either -- and what holds them together with their stamps instead is
 * where those are written: the critical section writes both before the input
 * guard and before any connection ({@link ./managedExchangeRun.ts}), so the
 * recorded outcome is on the same side of the boundary as the state shown. The
 * input-guard arm is gated whole rather than on the kind it grades to, so a
 * grading that gains a kind does not have to re-derive the guard. None of these
 * errors can be raised past the boundary today (the custody read, the spent check
 * it decides, and the input guard all run before any connection, core refuses an
 * unsatisfiable shortfall inside the pre-connection prepare, and the no-show is
 * raised only by a wait that never opened a channel), and the guard is what keeps
 * that a check rather than a standing assumption: one delivered past the boundary
 * is not a benign outcome here, and falls through to the caller's generic
 * transport path.
 *
 * The guard binds the outcomes read here off THIS run's error. A surface state
 * derived instead from the record's stored bookkeeping
 * ({@link ./managedFailureTiers.ts}) meets the same boundary where it is
 * classified ({@link ../bench/managedRunLaunchModel.ts}): a stored kind whose copy
 * attests that nothing left this device gives way to the generic tier past the
 * boundary exactly as the state read off the error does here, rather than resting
 * on the guard the run that stamped the kind applied.
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
