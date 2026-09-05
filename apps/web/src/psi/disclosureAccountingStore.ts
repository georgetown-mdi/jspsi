/**
 * The IndexedDB layer over a managed exchange's accounting of disclosures: the
 * sibling store that accumulates each run's self-attested exchange record beside
 * the record it ran from ({@link MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME}). The
 * shape, the reader-rejects-unknown validation, and the append rule are the pure
 * {@link ./disclosureAccounting.ts}'s; this module is only the platform half, so
 * it is exercised against real Chromium rather than in the Node unit project.
 *
 * It is where an UNATTENDED run's disclosure record lands. The one-shot flows and
 * the attended re-run offer the record as a download at completion, which needs
 * somebody present; a scheduled run has nobody, so without this store a run that
 * discloses would leave no record of the disclosure at all. Writing the entry is
 * therefore part of the run, not part of the completion screen -- and it happens
 * before the run reports its outputs, so a tab closed on the completion screen
 * still leaves the accounting behind.
 *
 * A deleted managed exchange takes its accounting with it, in the same one-step
 * delete transaction (see {@link ./managedExchangeStore.ts}).
 *
 * Beside the read and the append sit the two recovery operations for a stored
 * accounting this build can no longer read -- get the entries out, then make the
 * store appendable again. They are one ordered pair, not alternatives: the export
 * retains the record but leaves the store un-appendable, and the reset restores
 * appendability but destroys the record. The read classifies which state the
 * exchange is in, so the recovery is offered on a value in hand, never on a
 * store that simply did not answer, and never on records a later build wrote --
 * which this page being behind is enough to explain.
 */

import { parseExchangeRecord } from "@psilink/core";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managed/managedExchangeStore";
import {
  appendDisclosureRecord,
  parseDisclosureAccounting,
  parseStoredDisclosureAccounting,
  storedEntriesAheadOfThisBuild,
} from "./disclosureAccounting";

import type {
  DisclosureAccounting,
  StoredDisclosureAccounting,
} from "./disclosureAccounting";
import type { ExchangeRecord } from "@psilink/core";

/** Read the stored accounting value under `id`, unparsed, or `undefined` when the
 * exchange has none. The one place the disclosure store is read from: every
 * reading of an accounting is this one round trip, held afterwards to whichever
 * parse the caller needs.
 *
 * @throws if the database does not open, or the transaction does not complete. */
async function readStoredValue(id: string): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        "readonly",
      );
      const request = transaction
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .get(id);
      let result: unknown;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * How reading one exchange's accounting turned out. The states are distinct
 * because their recoveries are: an accounting that could not be OBTAINED is a
 * condition of the store and says nothing about what is at rest, while one that
 * was obtained and refused is the app-upgrade case the export-then-reset recovery
 * exists for. Neither may render as an empty accounting -- "nothing was
 * disclosed" is a claim, and only `"none"` makes it.
 */
export type DisclosureAccountingRead =
  /** The stored value could not be obtained: the database did not open (private
   * mode with storage blocked, an engine without IndexedDB, or a version-change
   * open transiently held off by another tab's older connection -- see
   * {@link ./managedExchangeStore.ts}), or the read transaction did not complete.
   * Nothing is known about what is stored, so no recovery is offered on it. */
  | { kind: "unavailable" }
  /** The store was read and holds no accounting for this exchange: nothing has
   * been filed here, or what was filed has been cleared by
   * {@link resetDisclosureAccounting}. Empty is not the same as never-run, so the
   * surface reading this states the emptiness against the record's own run
   * bookkeeping (see {@link ../recurring/managedDetailModel.ts},
   * `completedRunRecorded`). */
  | { kind: "none" }
  /** The stored accounting, validated through {@link parseDisclosureAccounting}. */
  | { kind: "accounting"; accounting: DisclosureAccounting }
  /** A stored value the validating parse refused -- the corrupted or
   * app-upgrade-invalidated accounting. `stored` holds the entries exactly as
   * they sit at rest when the ENVELOPE still parses (the record-version-bump
   * case, which is what makes the export arm possible), and is `undefined` when
   * the envelope is gone too and there is nothing to hand back. */
  | { kind: "unreadable"; stored: StoredDisclosureAccounting | undefined }
  /** A stored value the validating parse refused whose entries name a LATER
   * exchange-record format than this build admits: the records are fine and this
   * PAGE is behind them (see {@link storedEntriesAheadOfThisBuild}). Its recovery
   * is to reload onto the build that wrote them, never the reset -- which would
   * destroy records the current build reads. `stored` is the same envelope-only
   * value, since handing back stored bytes claims nothing either way. */
  | { kind: "stale-page"; stored: StoredDisclosureAccounting };

/** The stored value held only to its envelope, or `undefined` when even that
 * refuses. Never a rendering source: these are the entries the validating parse
 * declined to vouch for, fit for handing back to the operator as stored bytes and
 * for nothing else (see {@link parseStoredDisclosureAccounting}). */
function recoverableStored(
  raw: unknown,
): StoredDisclosureAccounting | undefined {
  try {
    return parseStoredDisclosureAccounting(raw);
  } catch {
    return undefined;
  }
}

/**
 * Read one managed exchange's accounting of disclosures and classify the outcome.
 * ONE round trip: the stored value is read once and both parses are tried on that
 * same value, so the two readings of an accounting cannot disagree and a store
 * consulted twice cannot answer differently the second time.
 *
 * The classification is what keeps a transient store condition off the
 * destructive recovery. A failed open is separated from a failed PARSE, the same
 * split {@link ../recurring/savedExchangesLoad.ts} makes for the saved-exchanges
 * list: only a value actually read and then refused reaches `"unreadable"`, so a
 * blocked open -- which self-heals when the other tab yields -- can never present
 * as the irreversible-reset case. A value that WAS refused is then split by
 * direction, on the refused entries' own version literals: only entries from an
 * earlier record format are the stranded accounting the reset exists for; entries
 * from a later one say this page is running older code than the build that wrote
 * them, and reloading is that state's whole recovery.
 *
 * Total: every failure classifies rather than rejecting, so a caller renders an
 * outcome rather than catching one.
 */
export async function readDisclosureAccounting(
  id: string,
): Promise<DisclosureAccountingRead> {
  let raw: unknown;
  try {
    raw = await readStoredValue(id);
  } catch {
    return { kind: "unavailable" };
  }
  if (raw === undefined) return { kind: "none" };
  try {
    return { kind: "accounting", accounting: parseDisclosureAccounting(raw) };
  } catch {
    const stored = recoverableStored(raw);
    if (stored !== undefined && storedEntriesAheadOfThisBuild(stored))
      return { kind: "stale-page", stored };
    return { kind: "unreadable", stored };
  }
}

/**
 * Delete one managed exchange's accounting of disclosures, leaving the exchange
 * itself -- its terms, its stored secret, its schedule, its run bookkeeping, and
 * its local sibling state -- untouched. Scoped to the disclosure store alone,
 * unlike {@link ./managedExchangeStore.ts}'s delete, which removes the exchange
 * and takes the accounting with it.
 *
 * This is the second half of the recovery from a stored accounting this build
 * cannot read: the read failure is also an APPEND failure (the append re-reads
 * the accounting through the validating read inside its own transaction), so
 * every later run of a still-live exchange discloses and files nothing. Clearing
 * the unreadable value restores appendability; the next run starts a fresh
 * accounting.
 *
 * DESTRUCTIVE and irreversible: the entries are the exchange's disclosure history
 * and nothing else holds them. It is never a read's side effect -- the surface
 * that offers it confirms explicitly and offers the export first. Idempotent: a
 * reset of an exchange with no accounting resolves without error.
 */
export async function resetDisclosureAccounting(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Append one run's exchange record to the exchange's accounting. The read, the
 * pure append, and the write-back run inside ONE strict-durability readwrite
 * transaction, so two runs' entries cannot interleave into a lost write and the
 * entry is requested through to OS writeback before this resolves -- the same
 * durability the secret's own persist asks for.
 *
 * Re-appending a record already present is a no-op ({@link appendDisclosureRecord}
 * matches on the record's own binding nonce), so a retried write cannot inflate
 * the count of disclosures the accounting reports.
 *
 * The record is validated on the way in, through the same
 * {@link parseExchangeRecord} the read path holds a stored entry to, and the
 * PARSED result is what is written: what is at rest is then structurally what the
 * reader admits, so a caller's extra field cannot sit in the store invisibly
 * (the parser strips unknown keys) and a record the reader would reject cannot be
 * written at all.
 *
 * @throws {ZodError} if the record or the stored accounting is invalid; the
 *   transaction aborts and nothing is written.
 */
export async function appendDisclosureRecordToStore(
  id: string,
  record: ExchangeRecord,
): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      );
      const read = store.get(id);
      let failure: unknown;
      read.onsuccess = () => {
        try {
          const current =
            read.result === undefined
              ? undefined
              : parseDisclosureAccounting(read.result);
          store.put(
            appendDisclosureRecord(current, parseExchangeRecord(record)),
            id,
          );
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}
