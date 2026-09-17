/**
 * The IndexedDB layer over the note a run leaves when its disclosure record
 * never reached the accounting of disclosures: the same disclosure store the
 * accounting sits in, under the note's own key ({@link unfiledDisclosureKey}).
 * The shape, the key, and the merge rule are the pure
 * {@link ./unfiledDisclosure.ts}'s; this module is only the platform half, so it
 * is exercised against real Chromium rather than in the Node unit project.
 *
 * Three operations, one per state the shortfall can be in: note it as the run
 * ends, read it at the next visit, and file the retained records once the store
 * takes them. The filing is the append the run would have made -- the
 * accounting's own pure append, idempotent on the record's binding nonce -- so a
 * retry that reaches the store twice cannot inflate the count of disclosures.
 *
 * The note and the accounting are written in ONE transaction wherever both move,
 * so an entry cannot be dropped from the note without landing in the accounting.
 *
 * Where the note cannot be written -- storage full, an open that does not
 * complete, or a stored note this build cannot read, which a write leaves exactly
 * as it sits -- the fact falls back to the localStorage flag
 * ({@link ./unfiledDisclosureFlag.ts}), which keeps the exchange id alone. That
 * is the limit of what is recoverable: a run named only by that flag has no
 * record left to file.
 *
 * A deleted managed exchange takes its note with it, in the same one-step delete
 * transaction (see {@link ./managed/managedExchangeStore.ts}).
 */

import { getLogger, parseExchangeRecord } from "@psilink/core";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managed/managedExchangeStore";
import {
  appendDisclosureRecord,
  parseDisclosureAccounting,
} from "./disclosureAccounting";
import {
  noteUnfiledDisclosure,
  parseStoredUnfiledDisclosures,
  unfiledDisclosureKey,
  unfiledDisclosuresAfterFiling,
  unfiledDisclosuresOf,
} from "./unfiledDisclosure";
import { flagUnfiledExchange } from "./unfiledDisclosureFlag";

import type {
  StoredUnfiledDisclosures,
  UnfiledDisclosure,
} from "./unfiledDisclosure";
import type { DisclosureAccounting } from "./disclosureAccounting";
import type { ExchangeRecord } from "@psilink/core";

const log = getLogger("unfiledDisclosureStore");

/**
 * How reading one exchange's note turned out. The states are distinct because
 * what the operator is owed differs: a note that could not be OBTAINED is a
 * condition of the store and says nothing about what is at rest, while a value
 * obtained and refused says a run went unfiled and that this build cannot read
 * which one. Neither may render as "nothing is missing", which only `"none"`
 * states.
 */
export type UnfiledDisclosureRead =
  /** The stored value could not be obtained: the database did not open, or the
   * read transaction did not complete (see
   * {@link ./managed/managedExchangeStore.ts} for what makes an open fail).
   * Nothing is known about what is stored. */
  | { kind: "unavailable" }
  /** The store was read and holds no note for this exchange: every run that
   * disclosed filed its entry, or what was noted has been filed since. */
  | { kind: "none" }
  /** The noted runs, oldest first, at least one. A run holding a record can be
   * filed; one holding none cannot (see {@link unfiledDisclosuresOf}). */
  | { kind: "unfiled"; disclosures: ReadonlyArray<UnfiledDisclosure> }
  /** A stored value this build refuses: a run of this exchange was noted as
   * unfiled, and which run it was cannot be read. The bytes are left exactly as
   * they sit -- the note is the only thing standing for that disclosure. */
  | { kind: "unreadable" };

/** Where a run that could not be filed was recorded, so a caller with no notice
 * sink still reports the outcome to the diagnostic log. */
export type UnfiledDisclosureNote =
  /** In the disclosure store, beside the accounting, with the run's record
   * retained where the run built one. */
  | "noted"
  /** In the localStorage flag alone: the note could not be written, so the
   * exchange is named and the run's record is gone. */
  | "flagged"
  /** Nowhere. Both refused, so nothing in this browser stands for the
   * disclosure. */
  | "nowhere";

/** What {@link withStoredNote} hands the decision it wraps: the note's stored
 * value, the store both keys live in, and the way to end the transaction on a
 * failure raised from a nested request's own callback, which no synchronous
 * `throw` can reach. */
interface NoteTransaction {
  raw: unknown;
  store: IDBObjectStore;
  fail: (error: unknown) => void;
}

/** Open the disclosure store in one transaction and hand the note's stored value
 * to `decide`, resolving on the transaction's own `complete` event so a write
 * `decide` issues is requested through to OS writeback before this resolves.
 *
 * `decide` runs synchronously inside the read request's `onsuccess`, where the
 * transaction is still active, so a write it issues from the value it just read
 * is part of the same transaction rather than of a later microtask the
 * transaction has already outlived. A further request it issues may report its
 * own failure through `fail`, which aborts the transaction with that error.
 *
 * @throws if the database does not open, if `decide` throws or fails -- the
 *   transaction aborts and nothing is written -- or if the transaction does not
 *   complete. */
async function withStoredNote<T>(
  id: string,
  mode: IDBTransactionMode,
  decide: (context: NoteTransaction) => T,
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction =
        mode === "readwrite"
          ? db.transaction(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, mode, {
              durability: "strict",
            })
          : db.transaction(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, mode);
      const store = transaction.objectStore(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      );
      const read = store.get(unfiledDisclosureKey(id));
      let result: T;
      let failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        transaction.abort();
      };
      read.onsuccess = () => {
        try {
          result = decide({ raw: read.result, store, fail });
        } catch (error) {
          fail(error);
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

/** The note a write merges its entry into, or `undefined` where nothing is
 * stored.
 *
 * @throws where a value is stored that this build cannot read, which fails the
 *   write rather than replacing those bytes: they are the only thing standing for
 *   the runs they name, and the caller falls back to the flag instead. */
function noteToMergeInto(raw: unknown): StoredUnfiledDisclosures | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseStoredUnfiledDisclosures(raw);
  } catch (error) {
    throw new Error(
      "a note this build cannot read is already stored for this exchange",
      { cause: error },
    );
  }
}

/** The record as the accounting's own reader admits it, or `undefined` for one it
 * refuses. A refused record is retained nowhere: the append would refuse it too,
 * so retaining it would offer a retry that cannot land, and what is at rest stays
 * structurally what the reader admits. */
function retainable(record: ExchangeRecord | undefined): unknown {
  if (record === undefined) return undefined;
  try {
    return parseExchangeRecord(record);
  } catch {
    return undefined;
  }
}

/**
 * Note that a run of this exchange disclosed and its record was not filed, so
 * the next visit reads the shortfall whether or not anybody was present for the
 * notice the run raised.
 *
 * The run's record is retained with the note where the run built one and the
 * reader admits it, which is what lets the next visit file the entry. A run that
 * built none leaves its instant alone: nothing can be appended for it later, and
 * the surface states that rather than offering a retry that would do nothing.
 *
 * A note already stored that this build cannot read fails the write, its stored
 * bytes untouched: they are the only thing standing for the runs they name, so
 * this run's fact takes the fallback rather than replacing them.
 *
 * Total, and never throws: the run has already disclosed and is not made a
 * failure by a note that could not be written, so a note the store did not take
 * falls back to the localStorage flag and the return value says where the fact
 * landed.
 */
export async function noteUnfiledDisclosureRun(
  id: string,
  record: ExchangeRecord | undefined,
  at: string,
): Promise<UnfiledDisclosureNote> {
  const retained = retainable(record);
  const entry = { at, ...(retained === undefined ? {} : { record: retained }) };
  try {
    await withStoredNote(id, "readwrite", ({ raw, store }) => {
      store.put(
        noteUnfiledDisclosure(noteToMergeInto(raw), entry),
        unfiledDisclosureKey(id),
      );
    });
    return "noted";
  } catch (error) {
    log.error("noting an unfiled disclosure in the store failed:", error);
    return (await flagUnfiledExchange(id)) ? "flagged" : "nowhere";
  }
}

/**
 * Read the runs this exchange noted as unfiled and classify the outcome.
 *
 * Total: every failure classifies rather than rejecting, so a caller renders an
 * outcome rather than catching one.
 */
export async function readUnfiledDisclosures(
  id: string,
): Promise<UnfiledDisclosureRead> {
  try {
    return await withStoredNote<UnfiledDisclosureRead>(
      id,
      "readonly",
      ({ raw }) => {
        if (raw === undefined) return { kind: "none" };
        let stored: StoredUnfiledDisclosures;
        try {
          stored = parseStoredUnfiledDisclosures(raw);
        } catch {
          return { kind: "unreadable" };
        }
        const disclosures = unfiledDisclosuresOf(stored);
        return disclosures.length === 0
          ? { kind: "none" }
          : { kind: "unfiled", disclosures };
      },
    );
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * File the records the note retained into this exchange's accounting of
 * disclosures, and drop from the note every run that landed there.
 *
 * One transaction over both keys: the accounting is read, appended to, and
 * written back beside the note's own write, so a run cannot be dropped from the
 * note without its entry being in the accounting. The append is the accounting's
 * own, idempotent on the record's binding nonce, so filing a run the accounting
 * already holds resolves without a second entry.
 *
 * A run whose record cannot be read -- none was retained, or the record format
 * has moved past it -- stays noted: there is nothing to append for it, and
 * dropping it would retract a true statement that the accounting is short an
 * entry.
 *
 * @throws if the database does not open, if the accounting stored for this
 *   exchange is one this build refuses -- the same refusal a run's own append
 *   takes, so the note stands until that accounting is recovered -- or if the
 *   transaction does not complete. Nothing is written in any of those cases.
 */
export async function fileUnfiledDisclosures(id: string): Promise<void> {
  await withStoredNote(id, "readwrite", ({ raw, store, fail }) => {
    if (raw === undefined) return;
    const stored = parseStoredUnfiledDisclosures(raw);
    const read = store.get(id);
    read.onsuccess = () => {
      try {
        const filed = new Set<string>();
        let accounting: DisclosureAccounting | undefined =
          read.result === undefined
            ? undefined
            : parseDisclosureAccounting(read.result);
        for (const entry of stored.entries) {
          if (entry.record === undefined) continue;
          let record: ExchangeRecord;
          try {
            record = parseExchangeRecord(entry.record);
          } catch {
            continue;
          }
          accounting = appendDisclosureRecord(accounting, record);
          filed.add(record.bindingNonce);
        }
        if (filed.size === 0 || accounting === undefined) return;
        store.put(accounting, id);
        const left = unfiledDisclosuresAfterFiling(stored, filed);
        if (left === undefined) store.delete(unfiledDisclosureKey(id));
        else store.put(left, unfiledDisclosureKey(id));
      } catch (error) {
        fail(error);
      }
    };
  });
}
