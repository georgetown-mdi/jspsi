/**
 * The local sibling state a managed exchange carries beside its record: the backup
 * marker (when a backup was last taken) and the spent state (a migration export
 * handed this device's copy off). Both are deliberately NOT record fields and NOT
 * in the export artifact:
 *
 * - The backup marker is derived-currency input the record must not carry -- a
 *   secret-derived or record-embedded "when I last backed up" would either force a
 *   new record `schemaVersion` (reader-rejects-unknown) or leak into the artifact;
 *   keeping it a sibling makes its non-inclusion structural (see
 *   {@link ./managedBackupState.ts}).
 * - The spent state is this device's own status after a migration export, and an
 *   imported copy is a fresh live owner -- so the spent flag must not travel in the
 *   artifact either. It is a plain timestamp (the handoff date), no secret material
 *   and no rotation epoch (source invalidation is operator cooperation, not
 *   cryptography; see docs/MANAGED_EXCHANGE.md, "Export/import is migration, not
 *   sync").
 *
 * This is the thin IndexedDB layer over the sibling store the records database also
 * holds ({@link MANAGED_EXCHANGE_LOCAL_STORE_NAME}); the pure backup-state
 * derivation is in {@link ./managedBackupState.ts}. The state is validated on read
 * and write through {@link managedLocalStateSchema}, so a corrupted or
 * app-upgrade-invalidated sibling entry rejects loudly rather than loading, the
 * same reader-rejects-unknown discipline the record store follows.
 */

import { z } from "zod";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managedExchangeStore";

import type { ManagedBackupMarker } from "./managedBackupState";
import type { ZodType } from "zod";

/** This device's spent state for a record: set by a migration export, which hands
 * the copy off and transitions the source to a visible spent state (no Run
 * affordance, no scheduled runs). A plain handoff timestamp -- no secret material,
 * no rotation epoch. Cleared by importing the artifact back (a revive). */
export interface ManagedSpentState {
  /** ISO 8601 UTC instant the copy was handed off by a migration export. */
  spentAt: string;
}

/** The local sibling state for a record: the optional backup marker and the
 * optional spent state, either present independently. An entry with neither is
 * meaningless and never written (a cleared state deletes the entry). */
export interface ManagedLocalState {
  /** When a backup was last taken (see {@link ManagedBackupMarker}); absent until
   * the first export. */
  backup?: ManagedBackupMarker;
  /** This device's spent state (see {@link ManagedSpentState}); absent unless a
   * migration export handed the copy off. */
  spent?: ManagedSpentState;
}

const managedLocalStateSchema: ZodType<ManagedLocalState> = z
  .object({
    backup: z.object({ backedUpAt: z.iso.datetime() }).strict().optional(),
    spent: z.object({ spentAt: z.iso.datetime() }).strict().optional(),
  })
  .strict();

/** Run `work` inside a transaction over the local-state store, resolving on the
 * transaction's `complete` event, so a caller awaiting this has the write visible
 * to a subsequent read. The connection is closed once the transaction settles. */
async function withLocalStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        mode,
        { durability: "strict" },
      );
      const request = work(
        transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME),
      );
      let result: T;
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
 * Read the local sibling state for a record, or `undefined` when none exists. The
 * stored value is re-validated through {@link managedLocalStateSchema}, so a
 * corrupted sibling entry rejects rather than loading.
 *
 * @throws {ZodError} if the stored value is not valid local state.
 */
export async function getManagedLocalState(
  id: string,
): Promise<ManagedLocalState | undefined> {
  const raw = await withLocalStore(
    "readonly",
    (store) => store.get(id) as IDBRequest<unknown>,
  );
  if (raw === undefined) return undefined;
  return managedLocalStateSchema.parse(raw);
}

/**
 * Read every record id's local sibling state, as a map from id to state. Used by the
 * list to derive one backup state per exchange in a single sibling-store read rather
 * than one read per row. Each stored value is re-validated; a single invalid entry
 * rejects the whole read.
 *
 * @throws {ZodError} if any stored value is not valid local state.
 */
export async function listManagedLocalState(): Promise<
  Map<string, ManagedLocalState>
> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<Map<string, ManagedLocalState>>(
      (resolve, reject) => {
        const transaction = db.transaction(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          "readonly",
        );
        const store = transaction.objectStore(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        );
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        transaction.oncomplete = () => {
          const map = new Map<string, ManagedLocalState>();
          const keys = keysRequest.result;
          const values = valuesRequest.result;
          for (let index = 0; index < keys.length; index += 1)
            map.set(
              String(keys[index]),
              managedLocalStateSchema.parse(values[index]),
            );
          resolve(map);
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/** Read the sibling state under `id`, apply `transform` to it (undefined when none
 * exists), and write the result back inside ONE readwrite transaction, so no other
 * write lands between the read and the write-back. A `null` result deletes the
 * entry (a fully-cleared state leaves nothing behind). `transform` is synchronous
 * (Zod validation is), so the transaction does not auto-commit before the write. */
async function readModifyWriteLocalState(
  id: string,
  transform: (
    current: ManagedLocalState | undefined,
  ) => ManagedLocalState | null,
): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = store.get(id);
      let failure: unknown;
      read.onsuccess = () => {
        try {
          const current =
            read.result === undefined
              ? undefined
              : managedLocalStateSchema.parse(read.result);
          const next = transform(current);
          if (next === null) store.delete(id);
          else store.put(managedLocalStateSchema.parse(next), id);
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

/**
 * Record that a backup was taken for a record as of `backedUpAt`, advancing only the
 * backup marker and leaving any spent state untouched. The read-modify-write runs in
 * one transaction, so the marker update cannot clobber a concurrent spent-state
 * write.
 */
export async function markManagedExchangeBackedUp(
  id: string,
  backedUpAt: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    backup: { backedUpAt },
  }));
}

/**
 * Mark a record spent as of `spentAt` -- a migration export handed this device's
 * copy off. Advances only the spent state, leaving the backup marker untouched.
 */
export async function markManagedExchangeSpent(
  id: string,
  spentAt: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    spent: { spentAt },
  }));
}

/**
 * Clear a record's spent state -- an import of the artifact back revives it.
 * Removes only the spent state; if no backup marker remains either, the whole
 * sibling entry is deleted so nothing empty is left behind.
 */
export async function clearManagedExchangeSpent(id: string): Promise<void> {
  await readModifyWriteLocalState(id, (current) => {
    if (current === undefined) return null;
    const { spent: _spent, ...rest } = current;
    if (rest.backup === undefined) return null;
    return rest;
  });
}
