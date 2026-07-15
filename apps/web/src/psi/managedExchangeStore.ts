/**
 * The IndexedDB-backed store for managed (recurring) exchange records. Origin-
 * isolated to the app by IndexedDB's own same-origin model, so the persisted
 * records never leave the browser. This is the thin platform layer over the pure
 * record schema and composition in {@link ./managedExchangeRecord.ts}: every
 * record it writes is built and validated there, and every record it reads is
 * re-validated there, so the schema rules (reader-rejects-unknown
 * `schemaVersion`, the label cap, the credential-free document) hold on both
 * sides of storage.
 *
 * The whole managed exchange -- the record, the secret, the input-file handle,
 * the schedule, and the run bookkeeping -- is one object under one key, so
 * deleting a managed exchange is a single `delete` that leaves nothing behind
 * (see docs/spec/MANAGED_EXCHANGE_RECORD.md, the one-record design). There is no
 * separate secret-only retirement: removing a managed secret means deleting the
 * whole record and re-establishing it by re-invite.
 *
 * The database and the store logic are split deliberately: the pure module is
 * unit-testable in a Node environment with no IndexedDB, and only this thin layer
 * needs a real browser (the app's Playwright project runs it against real
 * Chromium).
 */

import {
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeRotation,
  buildManagedExchangeRecord,
  parseManagedExchangeRecord,
} from "./managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
  ManagedExchangeRotation,
  NewManagedExchange,
} from "./managedExchangeRecord";

/** The IndexedDB database name, under the app's origin. */
export const MANAGED_EXCHANGE_DB_NAME = "psilink-managed-exchanges";

/** The object store holding one {@link ManagedExchangeRecord} per key. */
export const MANAGED_EXCHANGE_STORE_NAME = "records";

/** The database schema version this build opens. Bump only for an IndexedDB
 * structural migration (a new object store or index), never for a change to the
 * record's own `schemaVersion`, which the record schema governs. */
const IDB_VERSION = 1;

/**
 * Open (creating or upgrading) the managed-exchange database. The object store is
 * keyed by the record's `id` (an in-line key path), so a record is its own key
 * and a delete needs only that id. Callers usually go through the higher-level
 * CRUD functions below rather than opening the database themselves.
 */
export function openManagedExchangeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Request that the browser make the origin's storage persistent, so the managed
 * store is not evicted under storage pressure. Best-effort: the grant is never
 * assumed durable (a browser may deny or later revoke it) and is not surfaced as
 * its own status line -- durability rests on rotation, fast re-invite, and the
 * opt-in age bound, not on this request. Returns the browser's grant decision, or
 * `false` where the API is unavailable.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  // `navigator.storage.persist` is typed as always present by the DOM lib but is
  // absent under SSR and on older engines, where the call throws; the try/catch
  // resolves either case to the secure-by-default no-grant, the same wrap
  // isDiagnosticMode uses for localStorage.
  try {
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Run `work` inside a transaction over the records store, resolving on the
 * transaction's `complete` event (not merely the request's success), so a caller
 * awaiting this has the write visible to a subsequent read. The database
 * connection is closed once the transaction settles. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  options?: { durability?: IDBTransactionDurability },
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        mode,
        options,
      );
      const request = work(
        transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME),
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
 * Create and persist a new managed exchange record. The record is built and
 * validated through {@link buildManagedExchangeRecord} (which assigns the `id`
 * and `schemaVersion` and enforces the label cap, the credential-free document,
 * and the secret format), then written. The write uses
 * `{ durability: "strict" }`, requesting OS writeback before the transaction
 * completes -- the persist-before-success discipline the secret at rest relies
 * on. Persistent storage is requested alongside the first write
 * ({@link requestPersistentStorage}), so the record cannot land in evictable
 * storage with the request never made. Returns the persisted record, including
 * its assigned `id`.
 *
 * @throws {ZodError} if the fields do not form a valid record.
 */
export async function createManagedExchange(
  fields: NewManagedExchange,
): Promise<ManagedExchangeRecord> {
  const record = buildManagedExchangeRecord(fields);
  // Fired, not awaited: the request must be made before the record lands, but a
  // browser may gate the grant behind a user prompt, and a denied, absent, or
  // pending grant must neither delay nor fail the create (the helper never
  // rejects; the grant is never assumed).
  void requestPersistentStorage();
  await withStore("readwrite", (store) => store.add(record), {
    durability: "strict",
  });
  return record;
}

/**
 * Persist a whole managed exchange record, replacing any record with the same
 * `id`. The record is re-validated through {@link parseManagedExchangeRecord}
 * before the write, so an invalid record (an over-long label, a document carrying
 * an `authentication` block, a malformed secret) never reaches storage. Uses
 * `{ durability: "strict" }` -- this is the write the persist-before-success
 * ordering runs when a rotation advances the secret.
 *
 * @throws {ZodError} if the record is invalid.
 */
export async function putManagedExchange(
  record: ManagedExchangeRecord,
): Promise<ManagedExchangeRecord> {
  const validated = parseManagedExchangeRecord(record);
  await withStore("readwrite", (store) => store.put(validated), {
    durability: "strict",
  });
  return validated;
}

/**
 * Read one managed exchange record by `id`, or `undefined` when none exists. The
 * stored value is re-validated through {@link parseManagedExchangeRecord}, so a
 * record whose `schemaVersion` the current build does not recognize -- or one an
 * app upgrade has otherwise invalidated -- rejects loudly rather than loading
 * (the recovery is re-invite, not migration).
 *
 * @throws {ZodError} if the stored value is not a valid v1 record.
 */
export async function getManagedExchange(
  id: string,
): Promise<ManagedExchangeRecord | undefined> {
  const raw = await withStore("readonly", (store) => store.get(id));
  if (raw === undefined) return undefined;
  return parseManagedExchangeRecord(raw);
}

/**
 * Read every managed exchange record. Each stored value is re-validated through
 * {@link parseManagedExchangeRecord}; a single invalid record rejects the whole
 * read rather than silently dropping it, so a corrupted or app-upgrade-
 * invalidated store surfaces rather than partially loading.
 *
 * @throws {ZodError} if any stored value is not a valid v1 record.
 */
export async function listManagedExchanges(): Promise<
  Array<ManagedExchangeRecord>
> {
  const raws = await withStore("readonly", (store) => store.getAll());
  return raws.map((raw) => parseManagedExchangeRecord(raw));
}

/**
 * Read the record under `id` and write back `transform`'s result inside a SINGLE
 * readwrite transaction, so no other write can land between the read and the
 * write-back. This is the required shape for any edit that writes the whole
 * record: a cross-transaction read-modify-write would have an await gap in which
 * a concurrent rotation write could land, and the stale write-back would then
 * silently revert the rotated secret -- the fork the spec's linear-resource
 * invariant forbids. `transform` must be synchronous (it runs inside the read's
 * success callback; Zod validation is synchronous, so it qualifies) or the
 * transaction would auto-commit before the write is issued; it throws to abort
 * the transaction, leaving the stored record unchanged, and receives `undefined`
 * when no record exists under `id`.
 */
async function readModifyWriteRecord(
  id: string,
  transform: (stored: unknown) => ManagedExchangeRecord,
): Promise<ManagedExchangeRecord> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const read = store.get(id);
      let written: ManagedExchangeRecord;
      let failure: unknown;
      read.onsuccess = () => {
        try {
          written = transform(read.result);
          store.put(written);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(written);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Apply local edits (the label, schedule, and max-token-age policy -- the only
 * fields that update in place without a re-invite) to the stored record and
 * persist the result. The read, the edit application through
 * {@link applyManagedExchangeLocalEdits} (which re-validates), and the write-back
 * all run inside one readwrite transaction ({@link readModifyWriteRecord}), so
 * the edit applies to the freshest stored record and cannot carry a stale secret
 * back over a concurrent rotation write. A change to the agreed terms is a
 * re-invite, not an edit here, so the document and the secret are deliberately
 * not editable through this path.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the edit
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function updateManagedExchangeLocalFields(
  id: string,
  edits: ManagedExchangeLocalEdits,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeLocalEdits(existing, edits);
  });
}

/**
 * Persist a rotation to the stored record: advance the rotated secret and the
 * `expires` bound, and nothing else. The read, the field-scoped application
 * through {@link applyManagedExchangeRotation} (which re-validates), and the
 * write-back run inside one strict-durability readwrite transaction
 * ({@link readModifyWriteRecord}), so the rotation applies to the freshest stored
 * record and the write is structurally incapable of carrying a stale secret or a
 * stale document. This is the durable write the persist-before-success ordering
 * awaits before the data exchange begins (see docs/spec/MANAGED_EXCHANGE_RECORD.md).
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the rotation
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeRotation(
  id: string,
  rotation: ManagedExchangeRotation,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeRotation(existing, rotation);
  });
}

/**
 * Record a run's `lastRun` bookkeeping on the stored record, leaving the rotated
 * secret and the document untouched. The read, the field-scoped application
 * through {@link applyManagedExchangeLastRun}, and the write-back run inside one
 * strict-durability readwrite transaction, so recording an outcome cannot revert a
 * concurrent rotation write. Separate from {@link persistManagedExchangeRotation}
 * so the run outcome is recorded (succeeded after the data exchange, or a
 * `storage` failure when the rotation persist itself failed) without re-touching
 * the secret.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function recordManagedExchangeLastRun(
  id: string,
  lastRun: ManagedExchangeLastRun,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeLastRun(existing, lastRun);
  });
}

/**
 * Delete a managed exchange in one step, removing everything the browser holds
 * for it -- the record, the secret, the input-file handle, the schedule, and the
 * run bookkeeping -- because all of it is one object under one key. Idempotent: a
 * delete of a missing id resolves without error.
 */
export async function deleteManagedExchange(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

/**
 * Delete every managed exchange record. Used to reset the store; each record's
 * whole contents are removed with it, as {@link deleteManagedExchange} removes
 * one.
 */
export async function clearManagedExchanges(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
