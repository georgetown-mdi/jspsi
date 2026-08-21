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
 */

import { parseExchangeRecord } from "@psilink/core";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managedExchangeStore";
import {
  appendDisclosureRecord,
  parseDisclosureAccounting,
} from "./disclosureAccounting";

import type { DisclosureAccounting } from "./disclosureAccounting";
import type { ExchangeRecord } from "@psilink/core";

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
  const db = await openManagedExchangeDatabase();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
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
    if (raw === undefined) return undefined;
    return parseDisclosureAccounting(raw);
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
