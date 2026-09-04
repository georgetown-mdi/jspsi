/**
 * The IndexedDB-backed store for managed (recurring) exchange records,
 * origin-isolated by IndexedDB's same-origin model. A thin platform layer over
 * the pure record schema in {@link ./managedExchangeRecord.ts}: every record
 * written or read here is built or re-validated there. The whole exchange --
 * record, secret, input handle, schedule, and run bookkeeping -- is one object
 * under one key, so a delete removes it entirely; there is no separate
 * secret-only retirement (see docs/spec/MANAGED_EXCHANGE_RECORD.md).
 */

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "./managedExchangeLock";
import {
  applyManagedExchangeInputHandle,
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeReinviteRotation,
  applyManagedExchangeRotation,
  applyManagedExchangeScheduleAdvance,
  buildManagedExchangeRecord,
  diagnoseManagedExchangeRecord,
  parseManagedExchangeRecord,
  partitionReadableManagedExchanges,
} from "./managedExchangeRecord";
import { parseManagedLocalState } from "./managedLocalStateShape";

import type {
  ManagedExchangeDiagnosticEssentials,
  ManagedExchangeLastRun,
  ManagedExchangeLocalEdits,
  ManagedExchangeReadableRecords,
  ManagedExchangeRecord,
  ManagedExchangeRotation,
  ManagedExchangeScheduleAdvance,
  NewManagedExchange,
} from "./managedExchangeRecord";
import type {
  ManagedSpendOutcome,
  ManagedSpentHandoff,
  ManagedSpentState,
} from "./managedLocalStateShape";

/** The IndexedDB database name, under the app's origin. */
export const MANAGED_EXCHANGE_DB_NAME = "psilink-managed-exchanges";

/** The object store holding one {@link ManagedExchangeRecord} per key. */
export const MANAGED_EXCHANGE_STORE_NAME = "records";

/**
 * The object store holding the local sibling state for a record (the backup marker
 * and the spent state), keyed by the record's `id`. A separate store, not a record
 * field: this state must never appear in the export artifact, and keeping it a
 * sibling makes that non-inclusion structural (the exporter reads only the records
 * store). Its shape is governed by {@link ./managedLocalState.ts}.
 */
export const MANAGED_EXCHANGE_LOCAL_STORE_NAME = "localState";

/**
 * The object store holding a record's accounting of disclosures -- its runs'
 * self-attested exchange records -- keyed by the record's `id`. A separate store
 * for the same reason as the local-state store: the export artifact must not
 * include the accounting, so keeping it a sibling makes that structural. Its shape is
 * governed by {@link ./disclosureAccounting.ts}.
 */
export const MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME = "disclosures";

/** The database schema version this build opens. Bump only for an IndexedDB
 * structural migration (a new object store or index), never for a change to the
 * record's own `schemaVersion`, which the record schema governs.
 * @internal */
export const IDB_VERSION = 3;

/**
 * Open (creating or upgrading) the managed-exchange database. The records store is
 * keyed by the record's `id` (an in-line key path), so a record is its own key and
 * a delete needs only that id; the local-state store is keyed out-of-line by the
 * same id. Callers usually go through the higher-level CRUD functions below rather
 * than opening the database themselves.
 */
export function openManagedExchangeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Per the IndexedDB spec, `blocked` does not abort the request: this same
    // request's onupgradeneeded/onsuccess can still fire after `onblocked` already
    // settled the promise. This flag detects that case so the late success closes
    // the connection instead of leaking it or resolving a second time.
    let blocked = false;
    const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_LOCAL_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      // Closes on a later open's version-change, so this connection does not hold an
      // older version open and block the next build's upgrade indefinitely (the
      // condition that fires `blocked` below).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // A version-change open is blocked when another live connection still holds an
    // older version, and settles neither way on its own; without this handler the
    // promise would hang forever. Rejecting classifies a blocked open as
    // store-unavailable rather than hanging the caller. The state is transient --
    // the `onversionchange` close above lets the other connection yield -- so a
    // reload recovers it.
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error("managed-exchange database open blocked by another tab"),
      );
    };
  });
}

/**
 * Whether the managed store can be opened at all in this browser. Opens the
 * database and closes the connection at once, since holding it open could block a
 * later version-change transaction. Distinguishes an unopenable store (private
 * mode with storage blocked, an engine without IndexedDB) from an openable one.
 * Resolves `true` on a successful open, `false` when the open rejects, and never
 * rejects itself -- a caller degrades on `false` rather than catching.
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
 * assumed durable, and is not surfaced as its own status line -- durability rests
 * on rotation, fast re-invite, and the opt-in age bound, not on this request.
 * Returns the browser's grant decision, or `false` where the API is unavailable.
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
 * validated through {@link buildManagedExchangeRecord} (which assigns `id` and
 * `schemaVersion` and enforces the label cap, the credential-free document, and
 * the secret format). The write uses `{ durability: "strict" }`, requesting OS
 * writeback before the transaction completes. Persistent storage is requested
 * alongside the write ({@link requestPersistentStorage}). Returns the persisted
 * record, including its assigned `id`.
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
 * before the write, so an invalid record (an over-long label, a document holding
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
 * Read every managed exchange record PER ENTRY: an entry this build cannot parse
 * is skipped and its stored key returned beside the records, rather than failing
 * the whole read the way {@link listManagedExchanges} does.
 *
 * This is the UNATTENDED runner's read only (see
 * {@link ./managedScheduleRunner.ts}): a wake has nobody present to meet the
 * read-failed recovery surface, so one unparseable entry must not stop every
 * other exchange's scheduled run.
 *
 * Keys and values are read in ONE transaction, so an entry that fails to parse
 * still yields the key it is stored under (its own `id` is untrusted once the
 * parse fails).
 */
export async function listReadableManagedExchanges(): Promise<ManagedExchangeReadableRecords> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeReadableRecords>(
      (resolve, reject) => {
        const transaction = db.transaction(
          MANAGED_EXCHANGE_STORE_NAME,
          "readonly",
        );
        const store = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        transaction.oncomplete = () => {
          resolve(
            partitionReadableManagedExchanges(
              keysRequest.result,
              valuesRequest.result,
            ),
          );
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
 * One entry in the diagnostic read: for a stored key, either the display essentials
 * the entry parsed to (`readable`) or an unreadable marker (`unreadable`) holding
 * only the key. Both hold the stored `id`, so a delete-by-key acts on either
 * without requiring a successful parse. Both also hold `backedUp`, derived from
 * the sibling local-state store, so the delete confirm's custody note shows on the
 * recovery path exactly as on the normal list. A boolean suffices: the marker's
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
 * NEVER rejecting wholesale -- unlike {@link listManagedExchanges}. Exists ONLY for
 * the recovery surface: it attempts {@link diagnoseManagedExchangeRecord} on each
 * raw value and returns, per stored key, either its display essentials or an
 * unreadable marker, so an operator can discard the offending record even when the
 * normal list cannot load.
 *
 * SECURITY: entries hold display essentials only (label, side, dates, key) plus
 * `backedUp`; the `sharedSecret`, the document, the input handle, and the marker's
 * timestamp never leave the diagnostic extraction. Keyed off the store's own keys
 * rather than the parsed records, so an unreadable entry still yields a key to
 * delete by.
 *
 * `backedUp` is read from the sibling local-state store in the same transaction,
 * and is CONSERVATIVE on doubt: an unparseable sibling entry is treated as backed
 * up (a wrongly-shown custody warning is harmless; a wrongly-suppressed one is
 * not).
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
 * the `backedUp` boolean the diagnostic entries hold. CONSERVATIVE on doubt: a
 * sibling entry that cannot be parsed is treated as backed up (a wrongly-shown
 * custody warning is harmless; a wrongly-suppressed one is not). The marker's
 * timestamp is never surfaced -- only its presence. */
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
 * write-back -- a cross-transaction read-modify-write would have an await gap in
 * which a concurrent rotation write could land and be silently reverted.
 * `transform` must be synchronous (Zod validation is) or the transaction would
 * auto-commit before the write is issued; it throws to abort the transaction,
 * leaving the stored record unchanged, and receives `undefined` when no record
 * exists under `id`.
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
 * Persist a rotation to the stored record AND clear its backup and import markers,
 * in one transaction spanning both stores -- clearing a marker in a separate
 * transaction would leave a window where the rotated record reads over stale
 * sibling evidence. An export taken before the rotation holds the old secret, so
 * the backup marker must clear atomically with it: "marker present" then means "an
 * export of the current secret was taken since the last rotation." The import
 * marker clears for the same reason: a rotation is driven by a completed handshake
 * that proves both parties held the same secret, so it must not shield a later,
 * unexplained handshake failure (see {@link ./managedFailureTiers.ts}). Only the
 * backup and import markers are cleared; any spent state is left untouched.
 *
 * The record write is field-scoped through `transform` exactly as
 * {@link readModifyWriteRecord}, so it cannot include a stale secret or document;
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
 * an already-open local-state object store inside a live transaction. Deletes the
 * whole entry when no spent state remains, rather than leave an empty sibling. The
 * stored value is re-validated ({@link parseManagedLocalState}), so a corrupted
 * sibling aborts the transaction rather than being kept.
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
 * Read the current stored record for `id`, compose the export's bytes from it, AND
 * stamp its backup marker as of `backedUpAt`, all inside one transaction spanning
 * the record and sibling stores, returning the record read. The marker attests
 * exactly the bytes the export serialized, so a stale-tab export cannot stamp a
 * marker over a secret it did not serialize. Because the mark is cross-store-atomic
 * with the read, a concurrent rotation (which clears the marker in its own
 * cross-store transaction) is never masked: this transaction either marks the
 * pre-rotation record before the rotation clears it, or marks the already-rotated
 * secret. The marker only advances forward, so a slow export's late mark cannot
 * revert a newer one; the spent state is left untouched.
 *
 * `composeExport` runs synchronously here, BEFORE the mark is issued: if it throws
 * (an export that refuses the record it read), the whole transaction aborts and no
 * marker is written. It must stay synchronous and store-free, or the transaction
 * would commit out from under it.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or sibling entry is invalid.
 */
export async function readRecordAndMarkBackedUp(
  id: string,
  backedUpAt: string,
  composeExport: (record: ManagedExchangeRecord) => void,
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
          composeExport(record);
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
 * Spend this device's copy as of `spentAt` -- under `handoff`, or as the device
 * migration when it is omitted -- but ONLY while no run of this record is in flight
 * and the stored record still holds `expectedSharedSecret`, the secret the
 * hand-off's downloaded files hold.
 *
 * A run in flight excludes the spend outright: this step takes the record's
 * run+rotate lock ({@link ./managedExchangeLock.ts}) with `ifAvailable`, so a run
 * holding it refuses the spend as `"run-in-flight"` before the currency check runs.
 * A landed rotation refuses the spend instead: the read, the comparison, and the
 * spent-state write run inside one transaction spanning the record and sibling
 * stores, so a rotation is seen either fully before or fully after, never mid-check.
 *
 * Resolves `"run-in-flight"`, `"superseded"`, or `"gone"` -- writing nothing -- when
 * a run holds the lock, the stored secret has moved on, or no record exists under
 * `id`; reported apart because the remedy differs (wait, re-download, or nothing
 * left to hand over). An edit that leaves the secret alone (a label, a max-age
 * policy) leaves the downloaded copy spendable. Any backup marker is left untouched.
 *
 * @throws {ZodError} if the stored record or sibling entry is invalid; the
 *   transaction aborts and nothing is written.
 */
export async function spendManagedExchangeIfCurrent(
  id: string,
  expectedSharedSecret: string,
  spentAt: string,
  handoff?: ManagedSpentHandoff,
): Promise<ManagedSpendOutcome> {
  try {
    return await withManagedExchangeLock(
      id,
      () => spendCurrentCopy(id, expectedSharedSecret, spentAt, handoff),
      { ifAvailable: true },
    );
  } catch (error) {
    if (error instanceof ManagedExchangeLockUnavailableError)
      return "run-in-flight";
    throw error;
  }
}

/** The checked spend itself, run under the record's run+rotate lock: the cross-store
 * transaction that compares the stored secret and writes the spent state. */
async function spendCurrentCopy(
  id: string,
  expectedSharedSecret: string,
  spentAt: string,
  handoff: ManagedSpentHandoff | undefined,
): Promise<ManagedSpendOutcome> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedSpendOutcome>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      // Refusal is the default, so every way out of the transaction short of the
      // write -- a missing record, a moved secret -- resolves as a refusal rather
      // than relying on each to say so. The missing record then names itself,
      // because the two refusals leave the operator with different things to do.
      let outcome: ManagedSpendOutcome = "superseded";
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          if (read.result === undefined) {
            outcome = "gone";
            return;
          }
          const stored = parseManagedExchangeRecord(read.result);
          if (stored.sharedSecret !== expectedSharedSecret) return;
          markSpentOnLocalStore(local, id, readLocal.result, spentAt, handoff);
          outcome = "spent";
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Write the spent state onto a record's sibling entry, on an already-open local-state
 * object store inside a live transaction, preserving any backup and import markers.
 *
 * `handoff` records WHICH export spent the copy, since the two have different
 * recoveries: a migration spend (`handoff` omitted) is revived by importing the
 * downloaded artifact ({@link reviveSpentManagedExchange}), while a `"command-line"`
 * hand-off downloaded files the import flow does not accept, so an artifact
 * predating it is refused instead of reviving the copy. Re-validated
 * ({@link parseManagedLocalState}) before the write, so a malformed spent state
 * aborts the transaction rather than landing.
 */
function markSpentOnLocalStore(
  store: IDBObjectStore,
  id: string,
  raw: unknown,
  spentAt: string,
  handoff: ManagedSpentHandoff | undefined,
): void {
  const current = raw === undefined ? undefined : parseManagedLocalState(raw);
  store.put(
    parseManagedLocalState({
      ...current,
      spent: { spentAt, ...(handoff !== undefined ? { handoff } : {}) },
    }),
    id,
  );
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
 * run inside one readwrite transaction ({@link readModifyWriteRecord}), so the
 * edit applies to the freshest stored record and cannot reintroduce a stale
 * secret over a concurrent rotation write. A change to the agreed terms is a re-invite,
 * not an edit here: the document and the secret are not editable through this path.
 *
 * An edit to the max-token-age policy re-derives `expires` conservatively -- never
 * extending the stored credential's life without a rotation (see
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
 * ({@link readModifyWriteRotation}). The record write is field-scoped through
 * {@link applyManagedExchangeRotation} (which re-validates), so it cannot include a
 * stale secret or document. This is the durable write the persist-before-success
 * ordering awaits before the data exchange begins (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md).
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
 * re-invite consumes the failure `lastRun` recorded: leaving it in place, with the
 * import marker now cleared, would re-derive a stale `auth` failure as the attack
 * tier, resurrecting a framing the operator already recovered from (see
 * {@link ./managedFailureTiers.ts}). The record write is field-scoped through
 * {@link applyManagedExchangeReinviteRotation} (which re-validates), so it cannot
 * include a stale secret or document.
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
 * so the outcome (succeeded, or a `storage` failure when the rotation persist
 * itself failed) is recorded without re-touching the secret. Monotonic on `at`
 * (see {@link applyManagedExchangeLastRun}): a write staler than the stored entry
 * is a no-op, so a slow run's late bookkeeping cannot mask a newer outcome.
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
 * Persist a scheduled window's bookkeeping to the stored record: `nextWindow`,
 * `consecutiveMisses`, and the window's `lastRun` advance in ONE strict-durability
 * readwrite transaction ({@link readModifyWriteRecord}), leaving the rotated
 * secret and the document untouched. Atomicity matters: split across two writes, a
 * wake interrupted between them would leave a planned window moved past a count
 * that has not (or the reverse), and the next wake would recount or skip the
 * difference. Field-scoped through {@link applyManagedExchangeScheduleAdvance}
 * (which re-validates and conditions on the stored cadence, planned window, and
 * miss count), so it cannot reintroduce a stale secret over a concurrent rotation,
 * overwrite a schedule edited or cleared from another tab, or rewind one a newer
 * wake already advanced.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedExchangeScheduleAdvance(
  id: string,
  advance: ManagedExchangeScheduleAdvance,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeScheduleAdvance(existing, advance);
  });
}

/**
 * Persist an input-file handle onto the stored record, or drop it with `null`,
 * advancing only `inputFileHandle` and nothing else. The read, the field-scoped
 * application through {@link applyManagedExchangeInputHandle} (which re-validates),
 * and the write-back run inside one strict-durability readwrite transaction
 * ({@link readModifyWriteRecord}), so it applies to the freshest stored record and
 * cannot reintroduce a stale secret or document over a concurrent rotation write.
 * Used by the save flow at save-as-recurring or first run, and to re-point a
 * handle after a missing-file failure.
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
 * How {@link reviveSpentManagedExchange} reconciled an artifact against the spent
 * records in the store:
 *
 * - `"revived"` -- a MIGRATION-spent record held the artifact's secret and was
 *   revived in place, holding the revived record.
 * - `"handed-off"` -- a spent record holding the artifact's secret was handed off
 *   by a route of its own ({@link ManagedSpentHandoff}), which the artifact cannot
 *   take back. Nothing was written; the caller refuses the import, naming the record
 *   the store still holds.
 * - `"no-match"` -- no spent record holds the artifact's secret, so the caller
 *   installs a fresh record.
 */
export type ManagedReviveOutcome =
  | { kind: "revived"; record: ManagedExchangeRecord }
  | { kind: "handed-off"; handoff: ManagedSpentHandoff; label: string }
  | { kind: "no-match" };

/**
 * Reconcile a reconstructed artifact against the spent records in the store, in one
 * transaction spanning both stores: reads every record and sibling entry and looks
 * for a record that is spent AND holds the same `sharedSecret` as `reconstructed`
 * (compared in memory, so nothing secret-derived is ever persisted).
 *
 * A match spent by the DEVICE MIGRATION is revived in place: the record's fields
 * are updated from the artifact (keeping its own `id` and any persisted input
 * handle), its spent state cleared, and the backup and import markers stamped as
 * of `at`.
 *
 * A match spent under a `handoff` is NOT revived and nothing is written -- the
 * migration is the only spend that leaves `handoff` absent, so a hand-off route
 * added later gates here by default. The exchange runs from what the hand-off
 * saved, and the artifact cannot take the copy back, so the outcome names the
 * record for the caller to refuse the import on. This refusal wins over a revive:
 * when the secret matches both a handed-off record and a migration-spent one, the
 * outcome refuses on the handed-off record rather than reviving the other, which
 * would put a second live owner beside the one the hand-off already runs.
 *
 * Only a SPENT match is reconciled: a live record holding the same secret is a
 * genuine second owner, and importing over it would fork the single-owner
 * invariant, so that case reports `"no-match"` and the caller installs fresh. The
 * field update is re-validated through the record schema, so a malformed revive
 * aborts the transaction and leaves the store untouched.
 *
 * @throws {ZodError} if any stored record or sibling entry is invalid, or the
 *   revived record is invalid.
 */
export async function reviveSpentManagedExchange(
  reconstructed: ManagedExchangeRecord,
  at: string,
): Promise<ManagedReviveOutcome> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedReviveOutcome>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const readRecords = records.getAll();
      const readKeys = local.getAllKeys();
      const readValues = local.getAll();
      let outcome: ManagedReviveOutcome = { kind: "no-match" };
      let failure: unknown;
      const applyWhenReady = () => {
        if (
          readRecords.readyState !== "done" ||
          readKeys.readyState !== "done" ||
          readValues.readyState !== "done"
        )
          return;
        try {
          const spentStates = new Map<string, ManagedSpentState>();
          const keys = readKeys.result;
          const values = readValues.result;
          for (let index = 0; index < keys.length; index += 1) {
            const { spent } = parseManagedLocalState(values[index]);
            if (spent !== undefined)
              spentStates.set(String(keys[index]), spent);
          }
          let match: ManagedExchangeRecord | undefined;
          let handedOff:
            | { record: ManagedExchangeRecord; handoff: ManagedSpentHandoff }
            | undefined;
          // Every stored record is parsed, matched or not: an invalid one aborts
          // this transaction rather than being skipped past.
          for (const raw of readRecords.result) {
            const existing = parseManagedExchangeRecord(raw);
            const spent = spentStates.get(existing.id);
            if (
              spent === undefined ||
              existing.sharedSecret !== reconstructed.sharedSecret
            )
              continue;
            if (spent.handoff === undefined) match ??= existing;
            else handedOff ??= { record: existing, handoff: spent.handoff };
          }
          if (handedOff !== undefined) {
            outcome = {
              kind: "handed-off",
              handoff: handedOff.handoff,
              label: handedOff.record.label,
            };
            return;
          }
          if (match === undefined) return;
          const revived = parseManagedExchangeRecord({
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
          outcome = { kind: "revived", record: revived };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      readRecords.onsuccess = applyWhenReady;
      readKeys.onsuccess = applyWhenReady;
      readValues.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Delete a managed exchange in one step, removing everything the browser holds
 * for it -- the record, the secret, the input-file handle, the schedule, the run
 * bookkeeping, the local sibling state (the backup marker and any spent state),
 * AND its accounting of disclosures -- so nothing is left behind. All three are
 * removed in one transaction spanning the three stores, so a delete cannot leave a
 * stranded sibling entry. Idempotent: a delete of a missing id resolves without
 * error.
 *
 * The accounting goes with the exchange: it is this exchange's own disclosure
 * history, and leaving it behind would strand cleartext partner and agreement
 * metadata under an id nothing surfaces. An operator who must keep it exports it
 * before deleting; the delete confirm says so.
 */
export async function deleteManagedExchange(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [
          MANAGED_EXCHANGE_STORE_NAME,
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        ],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).delete(id);
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).delete(id);
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
 * Delete every managed exchange record, all local sibling state, and every
 * accounting of disclosures. Used to reset the store; all three stores are cleared
 * in one transaction, so no sibling entry outlives the records it belonged to.
 */
export async function clearManagedExchanges(): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [
          MANAGED_EXCHANGE_STORE_NAME,
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        ],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
