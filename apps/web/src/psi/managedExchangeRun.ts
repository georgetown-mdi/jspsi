/**
 * The platform half of the managed (recurring) exchange's run+rotate critical
 * section: the Web Locks single-writer acquisition and the strict-durability,
 * field-scoped store write that the pure ordering logic in
 * {@link ./managedRunRotate.ts} drives. This is the seam the future managed-
 * exchange runner calls -- it passes its handshake and data-exchange phases in and
 * cannot get the persist-before-success ordering wrong, because the data-exchange
 * phase is a callback this module invokes only after the durable persist resolves.
 *
 * Two invariants this module owns (normative in docs/MANAGED_EXCHANGE.md and
 * docs/spec/MANAGED_EXCHANGE_RECORD.md):
 *
 * - **Single-writer exclusion.** A Web Locks lock keyed to the record's id is held
 *   from "begin this run" through "rotated secret durably persisted", so a second
 *   same-origin context (a second tab, or a tab and a scheduled run) cannot double-
 *   rotate and desync the two parties. The lock is a same-profile liveness guard,
 *   auto-released when the holding context is destroyed; it is taken WITHOUT
 *   `steal: true` (a steal would defeat the single-writer property it exists to
 *   provide). It does not and cannot guard a second device or profile -- the
 *   durable single-owner property rests on migration-not-sync export semantics,
 *   not on the lock.
 *
 * - **Persist-before-success.** The rotated secret is written durably (a strict-
 *   durability transaction awaited to `complete`) BEFORE the data exchange begins.
 *   {@link runRotationCriticalSection} enforces the ordering, resolving the gate the
 *   data exchange needs only after the persist commits; {@link persistManagedExchangeRotation}
 *   is the durable, field-scoped write it awaits.
 */

import {
  RotationPersistError,
  runRotationCriticalSection,
  succeededRun,
} from "./managedRunRotate";
import {
  persistManagedExchangeRotation,
  recordManagedExchangeLastRun,
} from "./managedExchangeStore";

import type { ManagedExchangeLastRun } from "./managedExchangeRecord";
import type { RotationWriteBack } from "./managedRunRotate";

/** Namespace prefix for the Web Locks name, so a managed-exchange run lock cannot
 * collide with any other same-origin lock name. The record's id is appended. */
const MANAGED_EXCHANGE_LOCK_PREFIX = "psilink-managed-exchange:";

/** The Web Locks name for a managed record's run+rotate critical section. */
export function managedExchangeLockName(id: string): string {
  return `${MANAGED_EXCHANGE_LOCK_PREFIX}${id}`;
}

/**
 * Raised when the run+rotate lock for a record cannot be acquired without
 * waiting -- another same-origin context already holds it. The runner treats this
 * as "a run is already in progress on this device", not a failure of this run.
 * Only raised on the non-blocking (`ifAvailable`) acquisition path.
 */
export class ManagedExchangeLockUnavailableError extends Error {
  constructor(id: string) {
    super(`a run is already in progress for managed exchange ${id}`);
    this.name = "ManagedExchangeLockUnavailableError";
  }
}

/** How the run+rotate lock is acquired when a second context already holds it. */
export interface ManagedExchangeLockOptions {
  /**
   * When `true`, do not queue behind a held lock: if another same-origin context
   * holds it, fail immediately with {@link ManagedExchangeLockUnavailableError}
   * rather than waiting. When `false` (the default), queue and run when the holder
   * releases -- either is a valid single-writer discipline; the runner chooses per
   * whether a scheduled run should wait out an attended one or defer to it.
   */
  ifAvailable?: boolean;
}

/**
 * Hold the run+rotate single-writer lock for `id` across `critical`, releasing it
 * when `critical` settles (the Web Locks API releases the lock when the callback's
 * promise resolves or rejects). The lock is taken WITHOUT `steal: true`: a steal
 * would let a second context wrench the lock away mid-run, defeating the single-
 * writer property. With `ifAvailable`, a lock held by another context yields a
 * `null` grant, which this raises as {@link ManagedExchangeLockUnavailableError}
 * rather than running `critical` unguarded.
 *
 * @throws {ManagedExchangeLockUnavailableError} if `ifAvailable` is set and the
 *   lock is already held.
 */
export async function withManagedExchangeLock<T>(
  id: string,
  critical: () => Promise<T>,
  options: ManagedExchangeLockOptions = {},
): Promise<T> {
  const name = managedExchangeLockName(id);
  const request: LockOptions = { mode: "exclusive" };
  if (options.ifAvailable === true) request.ifAvailable = true;
  return globalThis.navigator.locks.request(name, request, async (lock) => {
    // `ifAvailable` yields a null grant when the lock is held; without it the
    // grant is guaranteed non-null (the request queued). Never a steal, so a
    // granted lock is exclusively this run's until `critical` settles.
    if (lock === null) throw new ManagedExchangeLockUnavailableError(id);
    return critical();
  });
}

/** The handshake and data-exchange phases the runner supplies to
 * {@link runManagedExchange}, plus the record's rotation policy. The persist and
 * lock are this module's; the runner cannot reach the data exchange before the
 * persist resolves. */
export interface ManagedExchangeRunPhases<THandshake, TExchange> {
  /** The record whose secret this run rotates. Its `id` keys the lock and the
   * field-scoped store writes; `tokenMaxAgeDays` restamps `expires`. */
  record: { id: string; tokenMaxAgeDays?: number };
  /** Run the authenticated handshake and yield the rotated secret (from the
   * `AuthResult`) plus whatever the data exchange needs. Runs inside the lock. */
  handshake: () => Promise<{ rotatedSecret: string; handshake: THandshake }>;
  /** Begin and complete the data exchange -- reachable only after the durable
   * persist resolves. Receives the handshake's carried value. */
  dataExchange: (handshake: THandshake) => Promise<TExchange>;
  /** Lock acquisition discipline (queue vs. fail-fast). */
  lock?: ManagedExchangeLockOptions;
  /** The clock, injected so a test can pin the rotation and bookkeeping stamps.
   * Defaults to `Date.now`. */
  now?: () => number;
}

/** The outcome of a completed managed exchange run: the data-exchange result and
 * the `succeeded` `lastRun` recorded on the store. */
export interface ManagedExchangeRunResult<TExchange> {
  /** The data-exchange phase's return value. */
  exchange: TExchange;
  /** The `succeeded` `lastRun` recorded on the store for this run. */
  lastRun: ManagedExchangeLastRun;
}

/**
 * Run a managed exchange's run+rotate critical section: the seam the future runner
 * calls. The single-writer lock is held across the handshake and the durable,
 * field-scoped rotation write -- exactly "begin this run" through "rotated secret
 * durably persisted". The data exchange then runs AFTER the lock releases, and on
 * its completion the `succeeded` outcome is recorded. The data exchange still
 * cannot begin before the persist resolves: it consumes the gate the locked
 * section resolves only after the persist commits, so the ordering is structural,
 * not the caller's to uphold, and the lock is not held for the (potentially long)
 * data exchange.
 *
 * A persist failure after rotation records a `storage`-kind `lastRun` inside the
 * lock (so the next handshake failure surfaces through the benign tier, not the
 * attack framing) and re-raises, without beginning the data exchange. A handshake
 * or data-exchange failure propagates unchanged for the runner to classify and
 * record; this module owns only the two outcomes the critical section itself
 * decides (succeeded, and the storage failure).
 *
 * @throws {ManagedExchangeLockUnavailableError} if `lock.ifAvailable` is set and a
 *   run is already in progress on this device.
 * @throws {RotationPersistError} if the rotation write fails; the `storage`
 *   `lastRun` is recorded before this propagates.
 */
export async function runManagedExchange<THandshake, TExchange>(
  phases: ManagedExchangeRunPhases<THandshake, TExchange>,
): Promise<ManagedExchangeRunResult<TExchange>> {
  const { record } = phases;
  const now = phases.now ?? Date.now;

  // The locked window: handshake through rotated-secret-durably-persisted. The
  // gate is resolvable only once the persist has committed.
  const gate = await withManagedExchangeLock(
    record.id,
    async () => {
      try {
        return await runRotationCriticalSection<THandshake>({
          handshake: phases.handshake,
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
        if (error instanceof RotationPersistError)
          await recordLastRun(record.id, error.lastRun);
        throw error;
      }
    },
    phases.lock,
  );

  // Lock released: the peer-visible data exchange runs outside the single-writer
  // window, then the success outcome is recorded.
  const exchange = await phases.dataExchange(gate.handshake);
  const lastRun = succeededRun(now());
  await recordLastRun(record.id, lastRun);
  return { exchange, lastRun };
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
