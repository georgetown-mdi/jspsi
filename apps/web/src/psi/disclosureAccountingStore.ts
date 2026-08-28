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
 * Beside the validating read and the append sit the two recovery operations for a
 * stored accounting this build can no longer read -- get the entries out, then
 * make the store appendable again. They are one ordered pair, not alternatives:
 * the export retains the record but leaves the store un-appendable, and the reset
 * restores appendability but destroys the record.
 */

import { parseExchangeRecord } from "@psilink/core";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managedExchangeStore";
import {
  appendDisclosureRecord,
  parseDisclosureAccounting,
  parseStoredDisclosureAccounting,
} from "./disclosureAccounting";

import type {
  DisclosureAccounting,
  StoredDisclosureAccounting,
} from "./disclosureAccounting";
import type { ExchangeRecord } from "@psilink/core";

/** Read the stored accounting value under `id`, unparsed, or `undefined` when the
 * exchange has none. The one place the disclosure store is read from, so the
 * validating read and the recovery read below differ only in what they hold the
 * value to. */
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
 * Read one managed exchange's accounting of disclosures, or `undefined` when it
 * has none (no run has completed). The stored value is re-validated through
 * {@link parseDisclosureAccounting}, so a corrupted or app-upgrade-invalidated
 * accounting rejects rather than loading as a shorter, quietly false account.
 *
 * @throws {ZodError} if the stored value is not a valid accounting.
 */
export async function getDisclosureAccounting(
  id: string,
): Promise<DisclosureAccounting | undefined> {
  const raw = await readStoredValue(id);
  if (raw === undefined) return undefined;
  return parseDisclosureAccounting(raw);
}

/**
 * Read one managed exchange's accounting for RECOVERY: the entries exactly as
 * they sit at rest, held only to the envelope, so an accounting whose entries
 * this build's exchange-record format no longer admits can still be got out
 * whole. `undefined` when the exchange has no accounting.
 *
 * Deliberately not the read any rendering surface uses. It returns what
 * {@link getDisclosureAccounting} refused to vouch for, so its result is fit for
 * handing back to the operator as stored bytes and for nothing else -- see
 * {@link parseStoredDisclosureAccounting} for why rendering it would be a
 * quietly false account.
 *
 * @throws {ZodError} if the stored value is not even a valid envelope. That is
 *   the corruption case rather than the bump case -- a bump moves the ENTRIES'
 *   version literal, not the accounting's own -- and it leaves no accounting to
 *   hand back at all.
 */
export async function getStoredDisclosureAccounting(
  id: string,
): Promise<StoredDisclosureAccounting | undefined> {
  const raw = await readStoredValue(id);
  if (raw === undefined) return undefined;
  return parseStoredDisclosureAccounting(raw);
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
