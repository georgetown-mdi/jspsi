/**
 * The platform half of the managed (recurring) exchange's run+rotate critical
 * section: the single-writer window ({@link ./managedExchangeLock.ts}) and the
 * strict-durability, field-scoped store write that the pure ordering logic in
 * {@link ./managedRunRotate.ts} drives. This is the seam the future managed-
 * exchange runner calls -- it passes its input-guard, handshake, and data-exchange
 * phases in and cannot get the ordering wrong: the input guard gates the handshake
 * (its result is the handshake's argument), and the data-exchange phase is a
 * callback this module invokes only after the durable persist resolves.
 *
 * Four invariants this module owns (normative in docs/MANAGED_EXCHANGE.md and
 * docs/spec/MANAGED_EXCHANGE_RECORD.md):
 *
 * - **Input guard before connection.** The input file is acquired and its columns
 *   validated against the standing terms BEFORE the handshake opens any connection;
 *   the guard's result is the handshake's argument, so a runner cannot reorder the
 *   guard after the handshake. A benign input rejection records the bookkeeping
 *   kind its remedy calls for -- `"input"` for a missing file or a gone permission,
 *   `"terms-shortfall"` for columns the standing terms cannot be run against -- and
 *   re-raises with no connection attempted, never through desync/attack framing.
 *
 * - **Single-writer exclusion.** The Web Locks lock keyed to the record's id
 *   ({@link ./managedExchangeLock.ts}) is held from "begin this run" through
 *   "rotated secret durably persisted", so a second same-origin context (a second
 *   tab, or a tab and a scheduled run) cannot double-rotate and desync the two
 *   parties. The same lock is what a hand-off spend takes, so a spend and a run
 *   exclude each other rather than observing each other.
 *
 * - **A handed-off copy does not run.** The first thing the locked window does is
 *   re-read the record's sibling spent state and refuse a copy an export has
 *   handed off, before the input is read and before any connection. It is a read
 *   per run rather than a surface's mount-time reading, so a hand-off confirmed
 *   after a surface loaded -- or between two attempts at one scheduled window --
 *   stops the runs that follow it rather than only the ones that start after a
 *   reload.
 *
 * - **Persist-before-success.** The rotated secret is written durably (a strict-
 *   durability transaction awaited to `complete`) BEFORE the data exchange begins.
 *   {@link runRotationCriticalSection} enforces the ordering, resolving the gate the
 *   data exchange needs only after the persist commits; {@link persistManagedExchangeRotation}
 *   is the durable, field-scoped write it awaits.
 */

import {
  ManagedInputError,
  managedInputFailureKind,
} from "./managedInputGuard";
import {
  RotationPersistError,
  failedRun,
  runRotationCriticalSection,
  succeededRun,
} from "./managedRunRotate";
import {
  persistManagedExchangeRotation,
  recordManagedExchangeLastRun,
} from "./managedExchangeStore";
import { getManagedLocalState } from "./managedLocalState";
import { withManagedExchangeLock } from "./managedExchangeLock";

import type { ManagedExchangeLastRun } from "./managedExchangeRecord";
import type { ManagedExchangeLockOptions } from "./managedExchangeLock";
import type { RotationWriteBack } from "./managedRunRotate";

/**
 * Raised when a run finds this device's copy of the record handed off: an export
 * spent it, so the secret it would rotate belongs to whoever the hand-off gave it
 * to. Refusing is the whole response -- rotating would leave the new owner's first
 * run meeting a partner that has moved on, which nothing short of a re-invite
 * recovers, and the run has no standing to decide that on the operator's behalf.
 * Raised inside the run+rotate lock before the input is read, so a refused run has
 * touched neither the operator's file nor the network.
 */
export class ManagedExchangeSpentError extends Error {
  constructor(id: string) {
    super(
      `managed exchange ${id} was handed off, so this device's copy no longer runs it`,
    );
    this.name = "ManagedExchangeSpentError";
  }
}

/** The input, handshake, and data-exchange phases the runner supplies to
 * {@link runManagedExchange}, plus the record's rotation policy. The persist and
 * lock are this module's; the runner cannot reach the data exchange before the
 * persist resolves, nor the handshake before the input is acquired and validated. */
export interface ManagedExchangeRunPhases<TInput, THandshake, TExchange> {
  /** The record whose secret this run rotates. Its `id` keys the lock and the
   * field-scoped store writes; `tokenMaxAgeDays` restamps `expires`. */
  record: { id: string; tokenMaxAgeDays?: number };
  /**
   * Acquire and validate the input file BEFORE any connection: read it through the
   * persisted handle (or the re-selected file), then reject a missing file, a gone
   * permission, or a column shape the standing terms cannot satisfy as a benign
   * pre-run failure (the `acquireValidatedManagedInput` seam in
   * {@link ./managedInputHandle.ts} raises a {@link ManagedInputError} for each).
   * Its result is handed to {@link handshake}, so the handshake -- and the
   * connection it opens -- is structurally unreachable until the guard passes: a
   * runner cannot reorder the guard after the handshake.
   */
  acquireInput: () => Promise<TInput>;
  /** Run the authenticated handshake and yield the rotated secret (from the
   * `AuthResult`) plus whatever the data exchange needs. Runs inside the lock, after
   * the input guard passed; receives the acquired input. */
  handshake: (
    input: TInput,
  ) => Promise<{ rotatedSecret: string; handshake: THandshake }>;
  /** Begin and complete the data exchange -- reachable only after the durable
   * persist resolves. Receives the handshake's carried value. */
  dataExchange: (handshake: THandshake) => Promise<TExchange>;
  /** Invoked once, synchronously, at the instant the data exchange begins (after
   * the persist resolves and the lock releases, immediately before
   * {@link dataExchange} is called). It marks the phase boundary a failure
   * classifier reads to tell a pre-data-exchange failure from one that could
   * postdate the first peer-visible payload -- a `security`-kind error before this
   * fires is the handshake failing closed, one after it can arise on a tampered
   * frame mid-exchange. */
  onDataExchangeStart?: () => void;
  /** Lock acquisition discipline (queue vs. fail-fast). */
  lock?: ManagedExchangeLockOptions;
  /** The clock, injected so a test can pin the rotation and bookkeeping stamps.
   * Defaults to `Date.now`. */
  now?: () => number;
}

/** The outcome of a completed managed exchange run: the data-exchange result and
 * the `succeeded` `lastRun` this run stamped. The store keeps the newest entry
 * across racing runs' tails (the monotonic guard in the bookkeeping write), so
 * this is this run's outcome, not necessarily the stored one. */
export interface ManagedExchangeRunResult<TExchange> {
  /** The data-exchange phase's return value. */
  exchange: TExchange;
  /** The `succeeded` `lastRun` this run stamped. */
  lastRun: ManagedExchangeLastRun;
}

/**
 * Run a managed exchange's run+rotate critical section: the seam the future runner
 * calls. The single-writer lock is held across the input guard, the handshake, and
 * the durable, field-scoped rotation write -- "begin this run" through "rotated
 * secret durably persisted". The data exchange then runs AFTER the lock releases,
 * and on its completion the `succeeded` outcome is recorded. The data exchange
 * still cannot begin before the persist resolves: it consumes the gate the locked
 * section resolves only after the persist commits, so the ordering is structural,
 * not the caller's to uphold, and the lock is not held for the (potentially long)
 * data exchange.
 *
 * The spent check runs first of all, inside the lock: a record an export handed off
 * refuses with a {@link ManagedExchangeSpentError} that records the `handed-off`
 * `lastRun`, before the input is read and before any connection.
 *
 * The input guard runs next, before the handshake opens any connection: its
 * result is the handshake's argument, so a runner structurally cannot reorder the
 * guard after the handshake. A benign {@link ManagedInputError} records the
 * `lastRun` kind {@link managedInputFailureKind} reads off its rejection inside the
 * lock, best-effort, and re-raises without a handshake -- never routed through
 * desync/attack framing, and no connection is attempted.
 *
 * A persist failure after rotation records a `storage`-kind `lastRun` inside the
 * lock, best-effort (so the next handshake failure surfaces through the benign
 * tier, not the attack framing) and re-raises, without beginning the data
 * exchange. A handshake or data-exchange failure propagates unchanged for the
 * runner to classify and record; this module owns only the outcomes the critical
 * section itself decides (succeeded, the storage failure, and the benign input
 * failure). Because the bookkeeping tail runs outside the lock, its write is
 * monotonic on `at` (see {@link recordManagedExchangeLastRun}): a slow run's stale
 * tail cannot mask a newer run's recorded outcome. The success stamp is likewise an
 * unlocked, individually failable write: if it fails after a completed exchange,
 * the NEXT run's tiering degrades to the stricter Tier-2 surface -- an operator
 * inconvenience, not a correctness break (the rotated secret is already durable).
 *
 * @throws {ManagedExchangeLockUnavailableError} if `lock.ifAvailable` is set and a
 *   run is already in progress on this device.
 * @throws {ManagedExchangeSpentError} if an export has handed this device's copy
 *   off; the `handed-off` `lastRun` is recorded best-effort before this
 *   propagates, and no input was read and no connection made.
 * @throws {ManagedInputError} if the input guard rejects (a missing file, a gone
 *   permission, or an unsatisfiable column shape); the benign `lastRun` for that
 *   rejection is recorded best-effort before this propagates, and no connection was
 *   made.
 * @throws {RotationPersistError} if the rotation write fails; the `storage`
 *   `lastRun` is recorded best-effort before this propagates, and the error
 *   carries it either way -- a bookkeeping-write failure never replaces this
 *   error.
 */
export async function runManagedExchange<TInput, THandshake, TExchange>(
  phases: ManagedExchangeRunPhases<TInput, THandshake, TExchange>,
): Promise<ManagedExchangeRunResult<TExchange>> {
  const { record } = phases;
  const now = phases.now ?? Date.now;

  // The locked window: input guard through rotated-secret-durably-persisted. The
  // gate is resolvable only once the persist has committed.
  const gate = await withManagedExchangeLock(
    record.id,
    async () => {
      // A copy an export handed off is refused before anything else this window
      // does: the sibling state is read here rather than trusted from whatever a
      // caller loaded, so a hand-off confirmed since that load stops this run.
      await refuseHandedOffCopy(record.id, now);
      // The input guard runs before the handshake opens any connection. A benign
      // input rejection records its classified kind inside the lock (this run's
      // record until the lock releases), then re-raises with no handshake attempted.
      let input: TInput;
      try {
        input = await phases.acquireInput();
      } catch (error) {
        if (error instanceof ManagedInputError) {
          // Best-effort, for the same reason the storage tier is below: a failed
          // bookkeeping write must not replace the ManagedInputError the runner
          // classifies on.
          try {
            await recordLastRun(
              record.id,
              failedRun(
                now(),
                "failed",
                managedInputFailureKind(error.rejection),
              ),
            );
          } catch {
            // Swallowed: the ManagedInputError still reaches the runner on the rethrow.
          }
        }
        throw error;
      }
      try {
        return await runRotationCriticalSection<THandshake>({
          handshake: () => phases.handshake(input),
          persist: (writeBack: RotationWriteBack) =>
            persistRotation(record.id, writeBack),
          tokenMaxAgeDays: record.tokenMaxAgeDays,
          now,
        });
      } catch (error) {
        // A persist failure after rotation is the one failure this section records
        // itself: the `storage` bookkeeping is what steers the next handshake
        // failure to the benign tier. Record it inside the lock (the record is
        // this run's until the lock releases), then re-raise for the runner. Every
        // other failure is the runner's to classify and record.
        if (error instanceof RotationPersistError) {
          // Best-effort: the storage subsystem that just failed the rotation
          // persist may fail this write too, and a second storage rejection must
          // never replace the RotationPersistError -- the runner's instanceof
          // classification, and the storage lastRun the error itself carries,
          // depend on the original propagating.
          try {
            await recordLastRun(record.id, error.lastRun);
          } catch {
            // Swallowed: error.lastRun still reaches the runner on the rethrow.
          }
        }
        throw error;
      }
    },
    phases.lock,
  );

  // Lock released: the peer-visible data exchange runs outside the single-writer
  // window, then the success outcome is recorded. The boundary is marked before
  // the first peer-visible payload, so a classifier can tell a handshake failure
  // from one that could postdate it.
  phases.onDataExchangeStart?.();
  const exchange = await phases.dataExchange(gate.handshake);
  const lastRun = succeededRun(now());
  await recordLastRun(record.id, lastRun);
  return { exchange, lastRun };
}

/**
 * Refuse this run when the record's sibling state says an export handed this
 * device's copy off, recording the `handed-off` `lastRun` before it re-raises.
 * Read inside the lock and before the input guard, so a run that meets a hand-off
 * has read no input file and opened no connection.
 *
 * The bookkeeping is this section's own, like the input and storage tiers beside
 * it: a scheduled run has nobody watching it, so the refusal is what the record
 * carries afterwards rather than a line in a log the operator never sees. It is
 * best-effort for the reason those are -- a failed bookkeeping write must not
 * replace the refusal the runner classifies on.
 *
 * @throws {ManagedExchangeSpentError} always, when the copy is spent.
 * @throws {ZodError} if the sibling entry is unreadable -- a run whose custody
 *   cannot be read does not rotate on the assumption it is still this device's.
 */
async function refuseHandedOffCopy(
  id: string,
  now: () => number,
): Promise<void> {
  const local = await getManagedLocalState(id);
  if (local?.spent === undefined) return;
  try {
    await recordLastRun(id, failedRun(now(), "failed", "handed-off"));
  } catch {
    // Swallowed: the refusal below still reaches the runner.
  }
  throw new ManagedExchangeSpentError(id);
}

/** The durable, field-scoped rotation write the ordering awaits before the data
 * exchange. Split out so the write target is one call site. */
async function persistRotation(
  id: string,
  writeBack: RotationWriteBack,
): Promise<void> {
  await persistManagedExchangeRotation(id, {
    sharedSecret: writeBack.sharedSecret,
    expires: writeBack.expires,
  });
}

/** Record a run's `lastRun` bookkeeping on the store. */
async function recordLastRun(
  id: string,
  lastRun: ManagedExchangeLastRun,
): Promise<void> {
  await recordManagedExchangeLastRun(id, lastRun);
}
