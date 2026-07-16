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
  applyManagedExchangeInputHandle,
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeReinviteRotation,
  applyManagedExchangeRotation,
  buildManagedExchangeRecord,
  diagnoseManagedExchangeRecord,
  parseManagedExchangeRecord,
} from "./managedExchangeRecord";
import { parseManagedLocalState } from "./managedLocalStateShape";

import type {
  ManagedExchangeDiagnosticEssentials,
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

/**
 * The object store holding the local sibling state for a record (the backup marker
 * and the spent state), keyed by the record's `id`. It is deliberately a SEPARATE
 * store, not a record field: that state must never appear in the export artifact,
 * and the record schema is reader-rejects-unknown -- keeping it a sibling makes its
 * non-inclusion structural (the exporter reads only the records store). Its shape
 * is governed by {@link ./managedLocalState.ts}.
 */
export const MANAGED_EXCHANGE_LOCAL_STORE_NAME = "localState";

/** The database schema version this build opens. Bump only for an IndexedDB
 * structural migration (a new object store or index), never for a change to the
 * record's own `schemaVersion`, which the record schema governs. Bumped to 2 to add
 * the local-sibling-state store. */
const IDB_VERSION = 2;

/**
 * Open (creating or upgrading) the managed-exchange database. The records store is
 * keyed by the record's `id` (an in-line key path), so a record is its own key and
 * a delete needs only that id; the local-state store is keyed out-of-line by the
 * same id. Callers usually go through the higher-level CRUD functions below rather
 * than opening the database themselves.
 */
export function openManagedExchangeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_LOCAL_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Whether the managed store can be opened at all in this browser. Opens the
 * database and closes the connection at once: it exists only to tell an unopenable
 * store (private mode with storage blocked, an engine without IndexedDB) from an
 * openable one, so holding it open would leak a live connection and could block a
 * later version-change transaction. Resolves `true` on a successful open, `false`
 * when the open rejects, and never rejects itself -- a caller degrades on `false`
 * rather than catching. The higher-level reads reopen as needed.
 */
export async function probeManagedStoreOpen(): Promise<boolean> {
  try {
    (await openManagedExchangeDatabase()).close();
    return true;
  } catch {
    return false;
  }
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
 * One entry in the diagnostic read: for a stored key, either the display essentials
 * the entry parsed to (`readable`) or an unreadable marker (`unreadable`) carrying
 * only the key. Both carry the stored `id` so a delete-by-key acts on either --
 * deleting an unreadable entry must not require a successful parse. Both also carry
 * `backedUp`, derived from the sibling local-state store (the backup marker survives
 * independently of record validity), so the delete confirm's custody note shows on
 * the recovery path exactly as on the normal list. A boolean suffices: the marker's
 * timestamp is never surfaced here.
 */
export type ManagedExchangeDiagnosticEntry =
  | {
      kind: "readable";
      essentials: ManagedExchangeDiagnosticEssentials;
      backedUp: boolean;
    }
  | { kind: "unreadable"; id: string; backedUp: boolean };

/**
 * Read every stored entry for the read-failed recovery listing, per-record and
 * NEVER rejecting wholesale -- unlike {@link listManagedExchanges}, whose strict
 * contract is deliberately untouched so a single bad record still fails the normal
 * list read. This diagnostic read exists ONLY for the recovery surface: it walks
 * the raw keys and values, attempts {@link diagnoseManagedExchangeRecord} on each,
 * and returns for each stored key either its display essentials or an unreadable
 * marker, so an operator can identify and discard the offending record even when
 * the normal list cannot load.
 *
 * SECURITY: the entries carry display essentials only (the label, side, dates, and
 * key) plus the `backedUp` boolean; the `sharedSecret`, the document, the input
 * handle, and the marker's timestamp never leave the diagnostic extraction, so no
 * secret material reaches the recovery surface. Keyed off the store's own keys
 * rather than the parsed records, so an unreadable entry still yields a key to
 * delete by.
 *
 * The transaction spans the record store AND the sibling local-state store so each
 * entry's `backedUp` is read in the same read. The backup marker survives
 * independently of record validity, so an entry whose record is unreadable can still
 * hold a live exported backup. `backedUp` is CONSERVATIVE on doubt: if the sibling
 * entry exists but cannot be parsed it reads as backed up (a wrongly-shown custody
 * warning is harmless; a wrongly-suppressed one is not).
 */
export async function listManagedExchangesDiagnostic(): Promise<
  Array<ManagedExchangeDiagnosticEntry>
> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<Array<ManagedExchangeDiagnosticEntry>>(
      (resolve, reject) => {
        const transaction = db.transaction(
          [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
          "readonly",
        );
        const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
        const local = transaction.objectStore(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        );
        const keysRequest = records.getAllKeys();
        const valuesRequest = records.getAll();
        const localKeysRequest = local.getAllKeys();
        const localValuesRequest = local.getAll();
        transaction.oncomplete = () => {
          const keys = keysRequest.result;
          const values = valuesRequest.result;
          const backedUpByKey = backedUpMarkersByKey(
            localKeysRequest.result,
            localValuesRequest.result,
          );
          const entries: Array<ManagedExchangeDiagnosticEntry> = [];
          for (let index = 0; index < keys.length; index += 1) {
            const key = String(keys[index]);
            const backedUp = backedUpByKey.get(key) ?? false;
            try {
              entries.push({
                kind: "readable",
                essentials: diagnoseManagedExchangeRecord(values[index]),
                backedUp,
              });
            } catch {
              // The parse failed, so the record's own `id` is untrusted; the store
              // key is the delete target instead, and the only field surfaced.
              entries.push({ kind: "unreadable", id: key, backedUp });
            }
          }
          resolve(entries);
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/** Derive, per sibling-store key, whether an exported backup marker is present --
 * the `backedUp` boolean the diagnostic entries carry. CONSERVATIVE on doubt: a
 * sibling entry that cannot be parsed reads as backed up (a wrongly-shown custody
 * warning is harmless; a wrongly-suppressed one is not). The marker's timestamp is
 * never surfaced -- only its presence. */
function backedUpMarkersByKey(
  keys: ReadonlyArray<IDBValidKey>,
  values: ReadonlyArray<unknown>,
): Map<string, boolean> {
  const backedUpByKey = new Map<string, boolean>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = String(keys[index]);
    try {
      backedUpByKey.set(
        key,
        parseManagedLocalState(values[index]).backup !== undefined,
      );
    } catch {
      backedUpByKey.set(key, true);
    }
  }
  return backedUpByKey;
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
 * Persist a rotation to the stored record AND clear its backup and import markers in
 * one transaction spanning both stores. Advancing the secret invalidates any prior
 * export -- an export taken before this rotation restores a stale secret -- so the
 * backup marker must fall in the same atomic step: "marker present" then structurally
 * means "an export containing the current secret was taken since the last
 * rotation", regardless of how the run was classified afterward. The import marker
 * falls in the same step for the same reason: a rotation is driven by a completed
 * handshake, which proves the two parties held the same secret, so a restored-stale
 * secret can no longer explain a failure -- the import evidence is consumed and must
 * not shield a later, genuinely-unexplained handshake failure (the desync tiering's
 * secret-farming caveat; see {@link ./managedFailureTiers.ts}). A cross-store
 * transaction is the required shape: clearing a marker in a separate transaction
 * would leave a window in which the rotated record reads over stale sibling evidence.
 * Only the backup and import markers are cleared; any spent state is left untouched.
 *
 * The record write is field-scoped through `transform` exactly as
 * {@link readModifyWriteRecord}, so it cannot carry a stale secret or document;
 * `transform` must be synchronous (Zod validation is) or the transaction
 * auto-commits before the writes are issued.
 */
async function readModifyWriteRotation(
  id: string,
  transform: (stored: unknown) => ManagedExchangeRecord,
): Promise<ManagedExchangeRecord> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let written: ManagedExchangeRecord;
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          written = transform(read.result);
          records.put(written);
          clearRotationSiblingsOnLocalStore(local, id, readLocal.result);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(written);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Drop the backup and import markers from a record's sibling local-state entry, on
 * an already-open local-state object store inside a live transaction -- the sibling
 * evidence a rotation consumes (a stale export and a stale-secret restore are both
 * invalidated by the completed-handshake rotation). A `null`-ing of the whole entry
 * when no spent state remains keeps the store from carrying an empty sibling. The
 * stored value is re-validated ({@link parseManagedLocalState}) so a corrupted
 * sibling aborts the transaction rather than being silently kept.
 */
function clearRotationSiblingsOnLocalStore(
  store: IDBObjectStore,
  id: string,
  raw: unknown,
): void {
  if (raw === undefined) return;
  const current = parseManagedLocalState(raw);
  if (current.spent === undefined) {
    store.delete(id);
    return;
  }
  store.put({ spent: current.spent }, id);
}

/**
 * Read the current stored record for `id` AND stamp its backup marker as of
 * `backedUpAt`, both inside one transaction spanning the record and sibling stores,
 * returning the record read. This is the atomic read-and-mark every export binds
 * to: the bytes an export serializes come from the record this call returns, and the
 * marker it writes attests exactly those bytes, so a stale-tab or stale-React-state
 * export cannot stamp a marker over a secret it did not serialize. Because the mark
 * is cross-store-atomic with the read, a rotation write (which clears the marker in
 * its own cross-store transaction) that lands first is never masked: either this
 * transaction reads the pre-rotation record and marks it -- then the rotation clears
 * that marker -- or it reads the rotated record and marks the rotated secret. The
 * marker advances only when it is set to a later instant, so a slow export's late
 * mark cannot revert a newer one; the spent state is left untouched.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or sibling entry is invalid.
 */
export async function readRecordAndMarkBackedUp(
  id: string,
  backedUpAt: string,
): Promise<ManagedExchangeRecord> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let record: ManagedExchangeRecord;
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          if (read.result === undefined)
            throw new Error(`no managed exchange with id ${id}`);
          record = parseManagedExchangeRecord(read.result);
          markBackupOnLocalStore(local, id, readLocal.result, backedUpAt);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Advance the backup marker on a record's sibling entry to `backedUpAt`, on an
 * already-open local-state object store inside a live transaction, preserving any
 * spent state. The marker only moves forward: a stamp older than the stored marker
 * is a no-op, so a slow export's late mark cannot revert a newer one. Compared as
 * parsed instants, since the schema admits ISO stamps of differing precision.
 */
function markBackupOnLocalStore(
  store: IDBObjectStore,
  id: string,
  raw: unknown,
  backedUpAt: string,
): void {
  const current = raw === undefined ? undefined : parseManagedLocalState(raw);
  if (
    current?.backup !== undefined &&
    Date.parse(current.backup.backedUpAt) > Date.parse(backedUpAt)
  )
    return;
  store.put({ ...current, backup: { backedUpAt } }, id);
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
 * An edit to the max-token-age policy re-derives `expires` conservatively (an
 * edit never extends the stored credential's life without a rotation; see
 * {@link applyManagedExchangeLocalEdits}). The clock is captured once before the
 * transaction opens, since the field-scoped transform must be synchronous.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the edit
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function updateManagedExchangeLocalFields(
  id: string,
  edits: ManagedExchangeLocalEdits,
): Promise<ManagedExchangeRecord> {
  const now = Date.now();
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeLocalEdits(existing, edits, now);
  });
}

/**
 * Persist a rotation to the stored record: advance the rotated secret and the
 * `expires` bound, and nothing else, AND clear the record's backup marker -- both
 * in one strict-durability transaction spanning the record and sibling stores
 * ({@link readModifyWriteRotation}). Advancing the secret invalidates any prior
 * export, so the marker falls in the same atomic step: "marker present" then means
 * "an export containing the current secret was taken since the last rotation",
 * independent of how the run was later classified. The record write is field-scoped
 * through {@link applyManagedExchangeRotation} (which re-validates), so it is
 * structurally incapable of carrying a stale secret or a stale document. This is
 * the durable write the persist-before-success ordering awaits before the data
 * exchange begins (see docs/spec/MANAGED_EXCHANGE_RECORD.md).
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the rotation
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeRotation(
  id: string,
  rotation: ManagedExchangeRotation,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRotation(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeRotation(existing, rotation);
  });
}

/**
 * Persist a re-invite's rotation to the stored record: advance the fresh setup
 * secret and re-derive the `expires` bound exactly as
 * {@link persistManagedExchangeRotation}, AND drop any `lastRun` bookkeeping -- all
 * in the one cross-store transaction that also clears the backup and import markers
 * ({@link readModifyWriteRotation}). Distinct from the run's rotation write because a
 * re-invite consumes the failure `lastRun` recorded (its recovery is exactly this
 * re-invite), so the post-re-invite record must read as "no failure to tier": leaving
 * the stale `lastRun` in place would re-derive the consumed benign tier, and -- with
 * the import marker now cleared in the same step -- would re-derive a stale `auth`
 * failure as the attack tier, resurrecting the framing the operator already recovered
 * from (see {@link ./managedFailureTiers.ts}). The record write is field-scoped
 * through {@link applyManagedExchangeReinviteRotation} (which re-validates), so it
 * cannot carry a stale secret or document.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the rotation
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeReinvite(
  id: string,
  rotation: ManagedExchangeRotation,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRotation(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeReinviteRotation(existing, rotation);
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
 * the secret. The application is monotonic on `at` (see
 * {@link applyManagedExchangeLastRun}): a write staler than the stored entry is a
 * no-op, so a slow run's late bookkeeping tail cannot mask a newer run's outcome.
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
 * Persist an input-file handle onto the stored record, or drop it with `null`,
 * advancing only `inputFileHandle` and nothing else. The read, the field-scoped
 * application through {@link applyManagedExchangeInputHandle} (which re-validates),
 * and the write-back run inside one strict-durability readwrite transaction
 * ({@link readModifyWriteRecord}), so persisting a handle applies to the freshest
 * stored record and is structurally incapable of carrying a stale secret or a
 * stale document back over a concurrent rotation write. This is the write the save
 * flow uses to persist the handle at save-as-recurring or first run, and the write
 * the surfaces use to re-point a handle after a missing-file failure.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v1 record or the result is
 *   invalid; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeInputHandle(
  id: string,
  handle: FileSystemFileHandle | null,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeInputHandle(existing, handle);
  });
}

/**
 * Revive a SPENT record whose stored secret matches the reconstructed artifact's,
 * in place -- an import of the migration artifact back onto the device that spent
 * it. The whole reconciliation runs in one transaction spanning both stores: it
 * reads every record and every sibling entry, finds a record that is spent AND
 * holds the same `sharedSecret` as `reconstructed` (the honest match -- the artifact
 * of a spent, unrun-since record carries exactly its secret; compared in memory, so
 * nothing secret-derived is ever persisted), and, if one exists, updates that
 * record's fields from the artifact (keeping its own `id` and any persisted input
 * handle), clears its spent state, and stamps the backup and import markers as of
 * `at` (a revive is itself an import event -- the desync tiering's restore evidence).
 * It returns the revived record, or `undefined` when no spent secret-match exists --
 * in which case the caller installs a fresh record instead of duplicating the husk.
 *
 * Only a SPENT match revives: a live record holding the same secret is a genuine
 * second owner (a re-import onto a device that never spent), so importing over it
 * would be the fork the single-owner invariant forbids; that case installs fresh and
 * the operator resolves the duplicate. The field update is re-validated through the
 * record schema, so a malformed revive aborts the transaction and leaves the store
 * untouched.
 *
 * @throws {ZodError} if any stored record or sibling entry is invalid, or the
 *   revived record is invalid.
 */
export async function reviveSpentManagedExchange(
  reconstructed: ManagedExchangeRecord,
  at: string,
): Promise<ManagedExchangeRecord | undefined> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord | undefined>(
      (resolve, reject) => {
        const transaction = db.transaction(
          [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
          "readwrite",
          { durability: "strict" },
        );
        const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
        const local = transaction.objectStore(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        );
        const readRecords = records.getAll();
        const readKeys = local.getAllKeys();
        const readValues = local.getAll();
        let revived: ManagedExchangeRecord | undefined;
        let failure: unknown;
        const applyWhenReady = () => {
          if (
            readRecords.readyState !== "done" ||
            readKeys.readyState !== "done" ||
            readValues.readyState !== "done"
          )
            return;
          try {
            const spent = new Set<string>();
            const keys = readKeys.result;
            const values = readValues.result;
            for (let index = 0; index < keys.length; index += 1)
              if (parseManagedLocalState(values[index]).spent !== undefined)
                spent.add(String(keys[index]));
            const match = readRecords.result
              .map((raw) => parseManagedExchangeRecord(raw))
              .find(
                (existing) =>
                  spent.has(existing.id) &&
                  existing.sharedSecret === reconstructed.sharedSecret,
              );
            if (match === undefined) return;
            revived = parseManagedExchangeRecord({
              ...reconstructed,
              id: match.id,
              ...(match.inputFileHandle !== undefined
                ? { inputFileHandle: match.inputFileHandle }
                : {}),
            });
            records.put(revived);
            local.put(
              { backup: { backedUpAt: at }, imported: { importedAt: at } },
              match.id,
            );
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        readRecords.onsuccess = applyWhenReady;
        readKeys.onsuccess = applyWhenReady;
        readValues.onsuccess = applyWhenReady;
        transaction.oncomplete = () => resolve(revived);
        transaction.onerror = () => reject(failure ?? transaction.error);
        transaction.onabort = () => reject(failure ?? transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/**
 * Delete a managed exchange in one step, removing everything the browser holds
 * for it -- the record, the secret, the input-file handle, the schedule, the run
 * bookkeeping, AND the local sibling state (the backup marker and any spent
 * state) -- so nothing is left behind. The record and its sibling state are removed
 * in one transaction spanning both stores, so a delete cannot leave a stranded
 * sibling entry. Idempotent: a delete of a missing id resolves without error.
 */
export async function deleteManagedExchange(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).delete(id);
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Delete every managed exchange record and all local sibling state. Used to reset
 * the store; both stores are cleared in one transaction, so no sibling entry
 * outlives the records it belonged to.
 */
export async function clearManagedExchanges(): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
