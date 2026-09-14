/**
 * The IndexedDB layer over a managed exchange's parked results: the sibling store
 * holding what a scheduled run produced with nobody present, keyed by the record
 * id ({@link MANAGED_EXCHANGE_RESULTS_STORE_NAME}). The shape, the
 * reader-rejects-unknown validation, and the retention rule are the pure
 * {@link ./parkedResults.ts}'s; this module is only the platform half, so it is
 * exercised against real Chromium rather than in the Node unit project.
 *
 * A sibling store, not a record field: parked results then sit structurally
 * outside the export artifact as the local state and the accounting of
 * disclosures do (the exporter reads only the records store), and how a run's
 * results were delivered adds no value to the record schema, where the
 * reader-rejects-unknown rule makes every addition a compatibility event.
 *
 * Retention is applied inside every transaction here, the read included, so an
 * entry past it is neither offered to a caller nor left at rest waiting for a
 * timer. A deleted managed exchange takes its parked results with it, in the same
 * one-step delete transaction (see {@link ./managed/managedExchangeStore.ts}).
 */

import {
  MANAGED_EXCHANGE_RESULTS_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managed/managedExchangeStore";
import {
  appendParkedResults,
  parseParkedResults,
  retainParkedResults,
} from "./parkedResults";

import type {
  ParkedResults,
  ParkedResultsEntry,
  ParkedRunResults,
} from "./parkedResults";

/**
 * How reading one exchange's parked results turned out. The states are distinct
 * because what the operator is owed differs: results that could not be OBTAINED
 * are a condition of the store and say nothing about what is at rest, while a
 * value obtained and refused is content this build cannot hand back. Neither may
 * render as "no scheduled run left anything here", which only `"none"` states.
 */
export type ParkedResultsRead =
  /** The stored value could not be obtained: the database did not open, or the
   * transaction did not complete (see {@link ./managed/managedExchangeStore.ts}
   * for what makes an open fail). Nothing is known about what is stored. */
  | { kind: "unavailable" }
  /** The store was read and holds nothing for this exchange: no scheduled run has
   * parked anything, everything parked has passed the retention, or the exchange
   * was deleted. */
  | { kind: "none" }
  /** The stored results, validated and inside the retention. */
  | { kind: "parked"; results: ParkedResults }
  /** A stored value the validating parse refused -- corrupted, or written by a
   * build whose format this one does not admit. The bytes are not handed back:
   * unlike the accounting of disclosures, these are row values, and there is no
   * reading of them this build can vouch for. */
  | { kind: "unreadable" };

/** Run `work` inside one strict-durability readwrite transaction over the parked
 * results store, resolving on the transaction's `complete` event. The read, the
 * retention, and the write-back therefore cannot interleave with another run's,
 * and what `work` writes is requested through to OS writeback before this
 * resolves.
 *
 * @throws if the database does not open, or the transaction does not complete. */
async function withResultsStore<T>(
  work: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_RESULTS_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      let result: T;
      let failure: unknown;
      void (async () => {
        try {
          result = await work(
            transaction.objectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME),
          );
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      })();
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/** The stored value under `id`, as one request inside `store`'s transaction. */
function readStoredValue(store: IDBObjectStore, id: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** What a stored value holds once the retention is applied: `undefined` where
 * nothing is stored or nothing survived it, and `released` when the retention
 * dropped an entry -- which is what tells a read whether it owes the store a
 * pruning write.
 *
 * @throws {ZodError} if the stored value is not a valid set of parked results. */
function retainedInStore(
  raw: unknown,
  now: number,
): { retained: ParkedResults | undefined; released: boolean } {
  if (raw === undefined) return { retained: undefined, released: false };
  const stored = parseParkedResults(raw);
  const retained = retainParkedResults(stored, now);
  return {
    retained: retained.entries.length === 0 ? undefined : retained,
    released: retained !== stored,
  };
}

/** Write `results` under `id`, or remove the key entirely when there is nothing
 * left to hold, so an exchange whose entries have all passed the retention keeps
 * no envelope at rest. */
function writeStoredValue(
  store: IDBObjectStore,
  id: string,
  results: ParkedResults | undefined,
): void {
  if (results === undefined) store.delete(id);
  else store.put(results, id);
}

/**
 * Read one managed exchange's parked results and classify the outcome, applying
 * the retention as it goes: an entry past it is dropped from the store in the
 * same transaction, so the read never offers content the stated retention has
 * released and never leaves it at rest behind the surface.
 *
 * Total: every failure classifies rather than rejecting, so a caller renders an
 * outcome rather than catching one.
 */
export async function readParkedResults(
  id: string,
  now: number = Date.now(),
): Promise<ParkedResultsRead> {
  // The landing state for a transaction that resolves without the work below
  // having classified anything: it claims nothing about what is stored.
  let read: ParkedResultsRead = { kind: "unavailable" };
  try {
    await withResultsStore(async (store) => {
      const raw = await readStoredValue(store, id);
      try {
        const { retained, released } = retainedInStore(raw, now);
        // Written back only where the retention actually released something: a
        // read that rewrote the value every time would re-serialize every parked
        // results file on every visit.
        if (released) writeStoredValue(store, id, retained);
        read =
          retained === undefined
            ? { kind: "none" }
            : { kind: "parked", results: retained };
      } catch {
        // A value this build refuses is left exactly as it sits: the pruning
        // write above cannot describe it, and deleting it here would destroy an
        // operator's results on a parse a later build may well admit. Removing
        // the exchange removes it.
        read = { kind: "unreadable" };
      }
    });
  } catch {
    return { kind: "unavailable" };
  }
  return read;
}

/** Add one entry for this run, replacing anything already stored for the same run
 * instant and dropping everything past the retention, inside one transaction.
 *
 * @throws if the store does not take the write -- which is what the caller
 *   records as the refused state ({@link recordParkedResultsRefusal}) -- or if
 *   the stored value is one this build refuses, since appending to a value it
 *   cannot read would write a set it cannot vouch for. */
async function appendEntry(
  id: string,
  entry: ParkedResultsEntry,
  now: number,
): Promise<void> {
  await withResultsStore(async (store) => {
    const raw = await readStoredValue(store, id);
    const { retained } = retainedInStore(raw, now);
    writeStoredValue(store, id, appendParkedResults(retained, entry));
  });
}

/**
 * Park one scheduled run's results for the operator's next visit.
 *
 * @throws if the results could not be stored: the quota refused the rows, the
 *   database did not open, or the transaction did not complete. The run itself
 *   stands -- it rotated and filed its disclosure -- so the caller records the
 *   refusal rather than restating the run's outcome
 *   ({@link recordParkedResultsRefusal}).
 */
export async function parkRunResults(
  id: string,
  results: ParkedRunResults,
  now: number = Date.now(),
): Promise<void> {
  await appendEntry(id, results, now);
}

/**
 * Record that this browser would not store a run's results, so the operator meets
 * a named state at the next visit rather than finding nothing where results
 * should be. The entry holds no rows, which is what lets it be written where the
 * results themselves were refused.
 *
 * @throws if even this entry cannot be written; the caller has no state left to
 *   record and reports the run to the diagnostic log instead.
 */
export async function recordParkedResultsRefusal(
  id: string,
  runAt: string,
  now: number = Date.now(),
): Promise<void> {
  await appendEntry(id, { kind: "storage-refused", runAt }, now);
}
