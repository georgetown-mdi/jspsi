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
 * reader-rejects-unknown rule makes every addition a compatibility event. Which
 * is also why the note a folder write leaves lands here rather than on the
 * record: it is one more thing a run's delivery says.
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
  TooLargeRunResults,
  WrittenRunResults,
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

/** Read the stored value under `id` and hand it to `decide`, inside one
 * strict-durability readwrite transaction over the parked results store,
 * resolving on the transaction's `complete` event. The read, the retention, and
 * the write-back therefore cannot interleave with another run's, and what
 * `decide` writes is requested through to OS writeback before this resolves.
 *
 * `decide` runs synchronously inside the read request's own `onsuccess`, where
 * the transaction is still active, so a write it issues from the value it just
 * read is part of the same transaction rather than of a later microtask the
 * transaction has already outlived.
 *
 * @throws if the database does not open, if `decide` throws -- the transaction
 *   aborts and nothing is written -- or if the transaction does not complete. */
async function withStoredResults<T>(
  id: string,
  decide: (raw: unknown, store: IDBObjectStore) => T,
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_RESULTS_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore(
        MANAGED_EXCHANGE_RESULTS_STORE_NAME,
      );
      const read = store.get(id);
      let result: T;
      let failure: unknown;
      read.onsuccess = () => {
        try {
          result = decide(read.result, store);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
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
  try {
    return await withStoredResults<ParkedResultsRead>(id, (raw, store) => {
      try {
        const { retained, released } = retainedInStore(raw, now);
        // Written back only where the retention actually released something: a
        // read that rewrote the value every time would re-serialize every parked
        // results file on every visit.
        if (released) writeStoredValue(store, id, retained);
        return retained === undefined
          ? { kind: "none" }
          : { kind: "parked", results: retained };
      } catch {
        // A value this build refuses is left exactly as it sits: the pruning
        // write above cannot describe it, and deleting it here would destroy an
        // operator's results on a parse a later build may well admit. Removing
        // the exchange removes it.
        return { kind: "unreadable" };
      }
    });
  } catch {
    // The store never answered -- the database did not open, or the transaction
    // did not complete -- so nothing is known about what is stored.
    return { kind: "unavailable" };
  }
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
  await withStoredResults(id, (raw, store) => {
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
 * Record that a run's results went into the folder the operator granted, so the
 * next visit says where they are. The entry holds no rows -- the rows are in that
 * folder -- which is what keeps the folder route from leaving a second copy at
 * rest here.
 *
 * @throws if the note cannot be written; the results themselves are in the folder
 *   either way, so the caller reports the lost note to the diagnostic log.
 */
export async function recordResultsWrittenToFolder(
  id: string,
  written: WrittenRunResults,
  now: number = Date.now(),
): Promise<void> {
  await appendEntry(id, written, now);
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

/**
 * Record that a run's results were larger than this browser keeps, so the
 * operator meets the size and its remedy at the next visit. The entry holds no
 * rows and no part of them: the results are kept whole or not at all.
 *
 * @throws if the entry cannot be written; the caller reports the run to the
 *   diagnostic log instead.
 */
export async function recordResultsTooLarge(
  id: string,
  tooLarge: TooLargeRunResults,
  now: number = Date.now(),
): Promise<void> {
  await appendEntry(id, tooLarge, now);
}

/**
 * Remove everything this exchange's scheduled runs left here, in one transaction:
 * the parked rows, the notes saying where results were written, and the states
 * recorded where results were not kept. The key itself goes, so no envelope is
 * left at rest either.
 *
 * The notes go with the rows rather than staying behind them: a note holds the
 * granted folder's own name, which is presence and shape at rest (see
 * docs/SECURITY_DESIGN.md, "Results of a scheduled run at rest"), and an operator
 * clearing what this browser kept is not asking to keep part of it.
 *
 * The delete reads nothing first, so it also removes a stored value this build
 * refuses -- the one state the read offers no other way out of.
 *
 * @throws if the database does not open or the transaction does not complete; the
 *   caller reports the failure rather than showing a clear that did not happen.
 */
export async function clearParkedResults(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_RESULTS_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      transaction.objectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
