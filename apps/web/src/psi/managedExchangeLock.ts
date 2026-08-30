/**
 * The run+rotate single-writer lock of a managed (recurring) exchange: its Web Locks
 * name, the acquisition that holds it across a critical section, and the origin-wide
 * reading a surface polls.
 *
 * It is a module of its own because BOTH sides of the mutual exclusion take it and
 * they sit on opposite sides of the store: the run's critical section
 * ({@link ./managedExchangeRun.ts}) and the hand-off spend the record store owns
 * ({@link ./managedExchangeStore.ts}, `spendManagedExchangeIfCurrent`). The run
 * module already imports the store, so a lock defined there could not be reached
 * from the store without an import cycle. Nothing here imports anything: the lock is
 * a name and a platform call.
 *
 * The lock is a same-profile **liveness guard**, not a persistent claim: it is
 * auto-released when the holding tab or worker is destroyed, and it is taken WITHOUT
 * `steal: true` -- a steal would let a second context wrench it away mid-run,
 * defeating the single-writer property it exists to provide. It guards concurrency
 * within one browser profile on one device, which is the scope where a racing second
 * context is a realistic accident; it does not and cannot guard a second device or a
 * second browser profile, where the durable single-owner property rests on
 * migration-not-sync export semantics instead (normative in docs/MANAGED_EXCHANGE.md
 * and docs/spec/MANAGED_EXCHANGE_RECORD.md).
 */

/** Namespace prefix for the Web Locks name, so a managed-exchange run lock cannot
 * collide with any other same-origin lock name. The record's id is appended. */
const MANAGED_EXCHANGE_LOCK_PREFIX = "psilink-managed-exchange:";

/** The Web Locks name for a managed record's run+rotate critical section. */
export function managedExchangeLockName(id: string): string {
  return `${MANAGED_EXCHANGE_LOCK_PREFIX}${id}`;
}

/**
 * Whether some same-origin context currently HOLDS the run+rotate lock for `id`.
 * `navigator.locks.query()` reports the whole origin's lock state rather than this
 * context's, so this is the only signal a surface has that another tab -- or the
 * scheduled runtime -- is mid-run on this record. It answers for this context's own
 * run too: the query does not distinguish holders.
 *
 * It is a point-in-time reading with no change event behind it, so a surface
 * rendering from it polls, and the lock can be taken or released between the reading
 * and whatever the reader does next. Gate PRESENTATION on it, never the correctness
 * of a write: a write that must not cross a run takes the lock itself (see
 * {@link ./managedExchangeStore.ts}, the hand-off spend).
 */
export async function managedExchangeRunLockHeld(id: string): Promise<boolean> {
  const name = managedExchangeLockName(id);
  const snapshot = await globalThis.navigator.locks.query();
  return snapshot.held?.some((lock) => lock.name === name) === true;
}

/**
 * Raised when the run+rotate lock for a record cannot be acquired without
 * waiting -- another same-origin context already holds it. Its holder is a run in
 * progress in all but one case: a hand-off spend takes the same lock for the
 * duration of its own store step, which is a write, not a run. The runner treats
 * this as "a run is already in progress on this device" either way, since both mean
 * the same thing to it -- this context is not the one advancing the secret right
 * now. Only raised on the non-blocking (`ifAvailable`) acquisition path.
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
   * releases -- either is a valid single-writer discipline; the caller chooses per
   * whether its work should wait out the holder or defer to it.
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
    // granted lock is exclusively this section's until `critical` settles.
    if (lock === null) throw new ManagedExchangeLockUnavailableError(id);
    return critical();
  });
}
