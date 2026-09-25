/**
 * The local sibling state a managed exchange holds beside its record: the backup
 * marker (when a backup was last taken) and the spent state (an export handed this
 * device's copy off, and which one did). Both are NOT record fields and NOT in
 * the export artifact:
 *
 * - The backup marker is derived-currency input the record must not hold -- a
 *   secret-derived or record-embedded "when I last backed up" would either force a
 *   new record `schemaVersion` (an older build drops a member it does not name)
 *   or leak into the artifact;
 *   keeping it a sibling makes its non-inclusion structural (see
 *   {@link ./managedBackupState.ts}).
 * - The spent state is this device's own status after a hand-off export, and an
 *   imported copy is a fresh live owner -- so the spent flag must not travel in the
 *   artifact either. It is a plain timestamp (the handoff date), no secret material
 *   and no rotation epoch (source invalidation is operator cooperation, not
 *   cryptography; see docs/MANAGED_EXCHANGE.md, "Export/import is migration, not
 *   sync"). It is the one sibling marker this module does not write: a spend is
 *   only ever taken together with the record read that finds the hand-off still
 *   current, and a re-take together with the record it hands the exchange back to,
 *   so its writers are the cross-store steps in
 *   {@link ./managedExchangeStore.ts} (`spendManagedExchangeIfCurrent` and
 *   `retakeHandedOffManagedExchange`).
 *
 * This is the thin IndexedDB layer over the sibling store the records database also
 * holds ({@link MANAGED_EXCHANGE_LOCAL_STORE_NAME}); the state's shape and its
 * reader-rejects-unknown validation are the pure {@link ./managedLocalStateShape.ts}
 * (shared with the record store's rotation write, which clears the backup marker in
 * the same cross-store transaction), and the pure backup-state derivation is in
 * {@link ./managedBackupState.ts}. Every read and write validates through
 * {@link managedLocalStateSchema}, so a corrupted or app-upgrade-invalidated sibling
 * entry rejects loudly rather than loading, the same discipline the record store
 * follows; the unattended wake's read reports such an entry by key instead
 * ({@link listReadableManagedLocalState}).
 */

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  openManagedExchangeDatabase,
} from "./managedExchangeStore";
import {
  managedLocalStateSchema,
  partitionReadableManagedLocalState,
} from "./managedLocalStateShape";

import type {
  ManagedLocalState,
  ManagedReadableLocalState,
} from "./managedLocalStateShape";

export type {
  ManagedImportMarker,
  ManagedLocalState,
  ManagedReadableLocalState,
  ManagedSpendOutcome,
  ManagedSpentHandoff,
  ManagedSpentState,
} from "./managedLocalStateShape";

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
          try {
            const map = new Map<string, ManagedLocalState>();
            const keys = keysRequest.result;
            const values = valuesRequest.result;
            for (let index = 0; index < keys.length; index += 1)
              map.set(
                String(keys[index]),
                managedLocalStateSchema.parse(values[index]),
              );
            resolve(map);
          } catch (error) {
            // A parse throws inside `oncomplete`, outside the executor's own scope:
            // reject with it so a corrupted sibling entry rejects the read (the
            // documented contract) rather than throwing unhandled and leaving the
            // promise unsettled.
            reject(error);
          }
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/**
 * Read every record id's local sibling state one entry at a time: the entries
 * that parse, and the keys of those that do not. The unattended wake's read, so
 * one entry this build cannot parse costs its own exchange's scheduled runs
 * rather than every exchange's (see {@link partitionReadableManagedLocalState});
 * the attended list keeps the strict {@link listManagedLocalState}.
 */
export async function listReadableManagedLocalState(): Promise<ManagedReadableLocalState> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedReadableLocalState>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readonly",
      );
      const store = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      transaction.oncomplete = () => {
        resolve(
          partitionReadableManagedLocalState(
            keysRequest.result,
            valuesRequest.result,
          ),
        );
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
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
 * Mark a record imported and backed-up as of the import instant -- a fresh install
 * from a backup artifact, which is itself a current backup of the installed secret.
 * Both markers are stamped in one read-modify-write, so the record reads green and
 * holds its restore evidence together. The import marker is what the desync tiering
 * reads to tell an import-since-last-success apart from an unexplained handshake
 * failure (see {@link ./managedFailureTiers.ts}); the backup marker keeps the freshly
 * installed record from immediately prompting a re-export. A revive-in-place instead
 * stamps both inside its own cross-store transaction (see
 * {@link ./managedExchangeStore.ts}, `reviveSpentManagedExchange`).
 */
export async function markManagedExchangeImported(
  id: string,
  at: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    backup: { backedUpAt: at },
    imported: { importedAt: at },
  }));
}

/**
 * Mark a record imported as of the import instant, and nothing else -- a fresh
 * install from a command-line `alcove.yaml` and its `.alcove.key`. The import
 * marker is the same restore evidence {@link markManagedExchangeImported}
 * stamps; the backup marker is not stamped, since it attests the app's own
 * backup file and the pair is not one (docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "The backup marker, the spent state, and the import marker").
 */
export async function markManagedExchangeKeyImported(
  id: string,
  at: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    imported: { importedAt: at },
  }));
}
