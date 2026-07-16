/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  IDB_VERSION,
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  openManagedExchangeDatabase,
  persistManagedExchangeRotation,
  putManagedExchange,
  recordManagedExchangeLastRun,
  requestPersistentStorage,
  updateManagedExchangeLocalFields,
} from "@psi/managedExchangeStore";
import {
  MAX_LABEL_LENGTH,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { buildManagedDeposit } from "@bench/manageOfferModel";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The IndexedDB half of the managed-exchange store, exercised against real
// Chromium (real IndexedDB, structured clone, and the File System Access handle
// type). The pure record schema and composition are unit-tested without a
// database in test/unit/managedExchangeRecord.test.ts; this suite proves the CRUD
// round-trips, the reader-rejects-unknown rule on a store read, and that a
// one-step delete leaves nothing behind.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const schedule: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-13T14:00:00.000Z",
  consecutiveMisses: 0,
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The raw stored value under a key, read straight from IndexedDB (bypassing the
 * validating read path) so a test can assert exactly what persists and that a
 * delete removes it. */
async function rawStored(id: string): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(MANAGED_EXCHANGE_STORE_NAME, "readonly")
        .objectStore(MANAGED_EXCHANGE_STORE_NAME)
        .get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The raw sibling local-state value under a key, read straight from the local-state
 * store (bypassing the validating read path) so the delete test can assert the
 * sibling entry is gone too, not merely absent through a validating read. */
async function rawLocalStored(id: string): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(MANAGED_EXCHANGE_LOCAL_STORE_NAME, "readonly")
        .objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME)
        .get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Overwrite the stored value under a key with an arbitrary object, so a test can
 * seed a corrupted or future-version record the validating read path must
 * reject. */
async function rawPut(value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Overwrite the sibling local-state value under a key with an arbitrary object,
 * bypassing the validating write path, so a test can seed a corrupted sibling entry
 * the diagnostic read must treat conservatively (backed up on a parse failure). */
async function rawLocalPut(id: string, value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(value, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Delete the whole managed-exchange database, so a test can re-create it at a chosen
 * version. Resolves once the delete completes; a delete blocked by a live connection
 * still fires `onsuccess` once that connection closes, so callers close held
 * connections first. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MANAGED_EXCHANGE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Open a raw connection at `version`, deliberately WITHOUT the module's
 * `onversionchange` self-close, so it models an old tab whose connection never yields
 * to a later upgrade -- the condition that fires `blocked` on the next open. The caller
 * closes it. */
async function openRawHeldConnection(version: number): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, version);
    request.onupgradeneeded = () => undefined;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("managed exchange store CRUD", () => {
  test("create then get round-trips the record", async () => {
    const created = await createManagedExchange(newExchange());
    const read = await getManagedExchange(created.id);
    expect(read).toEqual(created);
  });

  test("create persists origin-isolated to this app's database", async () => {
    const created = await createManagedExchange(newExchange());
    // The record is under the app's named database and store, keyed by its id.
    const stored = (await rawStored(created.id)) as { id: string } | undefined;
    expect(stored?.id).toBe(created.id);
    expect(MANAGED_EXCHANGE_DB_NAME).toBe("psilink-managed-exchanges");
  });

  test("get of a missing id resolves undefined", async () => {
    expect(await getManagedExchange("no-such-id")).toBeUndefined();
  });

  test("list returns every persisted record", async () => {
    const a = await createManagedExchange(newExchange({ label: "A" }));
    const b = await createManagedExchange(newExchange({ label: "B" }));
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("put replaces a whole record and re-validates it", async () => {
    const created = await createManagedExchange(newExchange());
    const rotated = { ...created, sharedSecret: generateSharedSecret() };
    const saved = await putManagedExchange(rotated);
    expect(saved.sharedSecret).toBe(rotated.sharedSecret);
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotated.sharedSecret,
    );

    const malformed = { ...created, sharedSecret: "not-a-secret" };
    await expect(putManagedExchange(malformed)).rejects.toThrow();
  });

  test("update edits local fields in place, leaving the document untouched", async () => {
    const created = await createManagedExchange(newExchange());
    const updated = await updateManagedExchangeLocalFields(created.id, {
      label: "Riverbend monthly",
      schedule,
    });
    expect(updated.label).toBe("Riverbend monthly");
    expect(updated.schedule).toEqual(schedule);
    expect(updated.exchangeFile).toEqual(created.exchangeFile);
    expect(updated.sharedSecret).toBe(created.sharedSecret);

    await expect(
      updateManagedExchangeLocalFields("no-such-id", { label: "x" }),
    ).rejects.toThrow();
  });
});

describe("single-transaction local edits", () => {
  test("an edit after an out-of-band rotation write preserves the rotated secret", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    await putManagedExchange({ ...created, sharedSecret: rotatedSecret });

    const updated = await updateManagedExchangeLocalFields(created.id, {
      label: "Riverbend monthly",
    });

    // The edit read the freshest stored record, not the caller's stale copy: the
    // rotated secret survives the label edit.
    expect(updated.sharedSecret).toBe(rotatedSecret);
    expect(updated.label).toBe("Riverbend monthly");
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
  });

  test("the edit's read and write share one readwrite transaction", async () => {
    const created = await createManagedExchange(newExchange());

    // Count the transactions the update opens. One readwrite transaction is the
    // structural guarantee that no concurrent write can land between the read
    // and the write-back; the former cross-transaction shape opened a readonly
    // then a readwrite transaction, leaving a gap a rotation write could land in.
    const realTransaction = IDBDatabase.prototype.transaction;
    const openedModes: Array<IDBTransactionMode | undefined> = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      openedModes.push(mode);
      return realTransaction.call(this, storeNames, mode, options);
    };
    try {
      await updateManagedExchangeLocalFields(created.id, {
        label: "one transaction",
      });
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    expect(openedModes).toEqual(["readwrite"]);
  });

  test("a rejected edit aborts the transaction and writes nothing", async () => {
    const created = await createManagedExchange(newExchange());
    await expect(
      updateManagedExchangeLocalFields(created.id, {
        label: "x".repeat(MAX_LABEL_LENGTH + 1),
      }),
    ).rejects.toThrow();
    expect((await getManagedExchange(created.id))?.label).toBe(created.label);
  });
});

describe("field-scoped rotation write", () => {
  test("advances the secret and expires, leaving the document and label untouched", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    const rotatedSecret = generateSharedSecret();
    const rotated = await persistManagedExchangeRotation(created.id, {
      sharedSecret: rotatedSecret,
      expires: "2026-10-06T14:00:00.000Z",
    });
    expect(rotated.sharedSecret).toBe(rotatedSecret);
    expect(rotated.expires).toBe("2026-10-06T14:00:00.000Z");
    expect(rotated.label).toBe("Riverbend quarterly");
    expect(rotated.exchangeFile).toEqual(created.exchangeFile);
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
  });

  test("a null expires clears any standing bound", async () => {
    const created = await createManagedExchange(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const rotatedSecret = generateSharedSecret();
    const rotated = await persistManagedExchangeRotation(created.id, {
      sharedSecret: rotatedSecret,
      expires: null,
    });
    expect(rotated.expires).toBeUndefined();
    expect((await getManagedExchange(created.id))?.expires).toBeUndefined();
  });

  test("a rotation cannot carry a stale label over a concurrent local edit", async () => {
    // The store holds a rotation write and a label edit as two field-scoped
    // read-modify-writes, each reading the freshest record inside its own
    // transaction. A rotation applied after a label edit keeps the new label -- the
    // rotation write is structurally incapable of reverting a field it does not
    // touch, the property the persist-before-success write depends on.
    const created = await createManagedExchange(newExchange());
    await updateManagedExchangeLocalFields(created.id, {
      label: "edited after create",
    });
    const rotatedSecret = generateSharedSecret();
    const rotated = await persistManagedExchangeRotation(created.id, {
      sharedSecret: rotatedSecret,
      expires: null,
    });
    expect(rotated.sharedSecret).toBe(rotatedSecret);
    expect(rotated.label).toBe("edited after create");
  });

  test("a malformed rotated secret aborts and writes nothing", async () => {
    const created = await createManagedExchange(newExchange());
    await expect(
      persistManagedExchangeRotation(created.id, {
        sharedSecret: "not-a-secret",
        expires: null,
      }),
    ).rejects.toThrow();
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      created.sharedSecret,
    );
  });

  test("rotating a missing id rejects", async () => {
    await expect(
      persistManagedExchangeRotation("no-such-id", {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
    ).rejects.toThrow();
  });
});

describe("field-scoped lastRun write", () => {
  test("records the outcome, leaving the secret and document untouched", async () => {
    const created = await createManagedExchange(newExchange());
    const updated = await recordManagedExchangeLastRun(created.id, {
      at: "2026-07-14T12:00:00.000Z",
      outcome: "succeeded",
    });
    expect(updated.lastRun).toEqual({
      at: "2026-07-14T12:00:00.000Z",
      outcome: "succeeded",
    });
    expect(updated.sharedSecret).toBe(created.sharedSecret);
    expect(updated.exchangeFile).toEqual(created.exchangeFile);
  });

  test("recording an outcome cannot revert a concurrent rotation write", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    await persistManagedExchangeRotation(created.id, {
      sharedSecret: rotatedSecret,
      expires: null,
    });
    const updated = await recordManagedExchangeLastRun(created.id, {
      at: "2026-07-14T12:00:00.000Z",
      outcome: "failed",
      failureKind: "storage",
    });
    // The lastRun read the freshest record: the rotated secret survives.
    expect(updated.sharedSecret).toBe(rotatedSecret);
    expect(updated.lastRun?.failureKind).toBe("storage");
  });
});

describe("input-file handle persistence", () => {
  test("a FileSystemFileHandle round-trips by structured clone", async () => {
    // Acquire a real handle by round-tripping through the origin-private file
    // system, which exists in Chromium and needs no user gesture -- unlike the
    // File System Access picker. The handle is a platform object IndexedDB stores
    // by structured clone; the record persists the pointer, never file content.
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("managed-input.csv", {
      create: true,
    });
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: handle }),
    );
    const read = await getManagedExchange(created.id);
    expect(read?.inputFileHandle).toBeDefined();
    expect(await read?.inputFileHandle?.isSameEntry(handle)).toBe(true);
    await root.removeEntry("managed-input.csv");
  });
});

describe("deposit persists a managed record of the party's side", () => {
  const NOW = Date.parse("2026-02-01T14:00:00.000Z");

  test("the inviter's save-as-recurring deposit adds an inviter record", async () => {
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      {
        side: "inviter",
        exchangeFile: composeManagedExchangeFile({
          connection: webrtcLocator,
          linkageTerms,
        }),
        sharedSecret: secret,
        choices: { label: "Riverbend quarterly" },
      },
      NOW,
    );

    const created = await createManagedExchange(deposit);

    const stored = await listManagedExchanges();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(created.id);
    expect(stored[0].side).toBe("inviter");
    expect(stored[0].sharedSecret).toBe(secret);
  });

  test("the acceptor's save-as-recurring deposit adds an acceptor record to the same store", async () => {
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      {
        side: "acceptor",
        exchangeFile: composeManagedExchangeFile({
          connection: webrtcLocator,
          linkageTerms,
        }),
        sharedSecret: secret,
        choices: { label: "Riverbend quarterly" },
      },
      NOW,
    );

    const created = await createManagedExchange(deposit);

    const stored = await listManagedExchanges();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(created.id);
    expect(stored[0].side).toBe("acceptor");
  });

  test("both sides deposit into one list carrying both", async () => {
    await createManagedExchange(
      buildManagedDeposit(
        {
          side: "inviter",
          exchangeFile: composeManagedExchangeFile({
            connection: webrtcLocator,
            linkageTerms,
          }),
          sharedSecret: generateSharedSecret(),
          choices: { label: "Invited partnership" },
        },
        NOW,
      ),
    );
    await createManagedExchange(
      buildManagedDeposit(
        {
          side: "acceptor",
          exchangeFile: composeManagedExchangeFile({
            connection: webrtcLocator,
            linkageTerms,
          }),
          sharedSecret: generateSharedSecret(),
          choices: { label: "Accepted partnership" },
        },
        NOW,
      ),
    );

    const stored = await listManagedExchanges();
    expect(stored.map((record) => record.side).sort()).toEqual([
      "acceptor",
      "inviter",
    ]);
  });
});

describe("reader rejects unknown on a store read", () => {
  test("a future schemaVersion in the store rejects rather than loading", async () => {
    const created = await createManagedExchange(newExchange());
    await rawPut({ ...created, schemaVersion: "psilink-managed-exchange/v2" });
    await expect(getManagedExchange(created.id)).rejects.toThrow();
    await expect(listManagedExchanges()).rejects.toThrow();
  });
});

describe("one-step delete leaves nothing behind", () => {
  test("delete removes the record, secret, handle, schedule, bookkeeping, and every local sibling marker", async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("managed-input.csv", {
      create: true,
    });
    const created = await createManagedExchange(
      newExchange({
        inputFileHandle: handle,
        tokenMaxAgeDays: 90,
        expires: "2026-04-06T14:00:00.000Z",
        schedule,
      }),
    );
    await recordManagedExchangeLastRun(created.id, {
      at: "2026-02-01T14:00:00.000Z",
      outcome: "succeeded",
    });
    // Also stamp both sibling markers, so the delete must clear the local-state
    // entry as well as the record -- the two stores the browser holds an exchange
    // in.
    await markManagedExchangeBackedUp(created.id, "2026-02-01T14:05:00.000Z");
    await markManagedExchangeSpent(created.id, "2026-02-02T09:00:00.000Z");
    // Everything the browser holds for the exchange -- the record under its key,
    // and the sibling local-state entry -- exists before the delete.
    expect(await rawStored(created.id)).toBeDefined();
    expect(await rawLocalStored(created.id)).toBeDefined();

    await deleteManagedExchange(created.id);

    // Enumerate every location and assert emptiness, not merely that the row is
    // gone: the record store (raw and through both validating reads) AND the
    // sibling local-state store (raw and through its validating read).
    expect(await rawStored(created.id)).toBeUndefined();
    expect(await getManagedExchange(created.id)).toBeUndefined();
    expect(await listManagedExchanges()).toEqual([]);
    expect(await rawLocalStored(created.id)).toBeUndefined();
    expect(await getManagedLocalState(created.id)).toBeUndefined();
    await root.removeEntry("managed-input.csv");
  });

  test("delete of a missing id is idempotent", async () => {
    await expect(deleteManagedExchange("no-such-id")).resolves.toBeUndefined();
  });
});

describe("diagnostic read never rejects wholesale", () => {
  test("readable entries carry display essentials only, never the secret", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Riverbend quarterly", side: "acceptor" }),
    );

    const entries = await listManagedExchangesDiagnostic();

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.kind).toBe("readable");
    if (entry.kind !== "readable") throw new Error("expected a readable entry");
    expect(entry.essentials).toEqual({
      id: created.id,
      label: "Riverbend quarterly",
      side: "acceptor",
    });
    // A fresh record has no exported backup, and no marker's timestamp reaches the
    // entry -- only the boolean.
    expect(entry.backedUp).toBe(false);
    // The secret must never reach the diagnostic surface.
    expect(JSON.stringify(entries)).not.toContain(created.sharedSecret);
  });

  test("a backup marker present reads as backedUp; the timestamp never surfaces", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Backed up" }),
    );
    await markManagedExchangeBackedUp(created.id, "2026-07-10T09:00:00.000Z");

    const [entry] = await listManagedExchangesDiagnostic();
    expect(entry.backedUp).toBe(true);
    // The marker's own instant is never surfaced -- a boolean suffices.
    expect(JSON.stringify(entry)).not.toContain("2026-07-10T09:00:00.000Z");
  });

  test("an absent sibling entry reads as not backed up", async () => {
    await createManagedExchange(newExchange({ label: "Fresh" }));
    const [entry] = await listManagedExchangesDiagnostic();
    expect(entry.backedUp).toBe(false);
  });

  test("an unparseable sibling entry reads as backed up (conservative on doubt)", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Doubtful" }),
    );
    // Corrupt the sibling entry so its parse fails: a wrongly-shown custody warning
    // is harmless; a wrongly-suppressed one is not, so doubt reads as backed up.
    await rawLocalPut(created.id, { backup: { backedUpAt: "not-an-instant" } });

    const [entry] = await listManagedExchangesDiagnostic();
    expect(entry.backedUp).toBe(true);
  });

  test("one unreadable record does not fail the read; it yields an unreadable marker keyed for delete", async () => {
    const good = await createManagedExchange(newExchange({ label: "Good" }));
    // Seed a future-version record under its own key: the strict list read rejects
    // wholesale on it, but the diagnostic read must still enumerate both.
    await rawPut({
      ...good,
      id: "bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });

    // The strict read still rejects wholesale -- the untouched contract.
    await expect(listManagedExchanges()).rejects.toThrow();

    const entries = await listManagedExchangesDiagnostic();
    expect(entries).toHaveLength(2);
    const readable = entries.find((entry) => entry.kind === "readable");
    const unreadable = entries.find((entry) => entry.kind === "unreadable");
    expect(readable).toBeDefined();
    expect(unreadable).toEqual({
      kind: "unreadable",
      id: "bad-record",
      backedUp: false,
    });
  });

  test("an unreadable record with a live sibling backup marker still reads as backed up", async () => {
    const good = await createManagedExchange(newExchange({ label: "Good" }));
    await rawPut({
      ...good,
      id: "bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });
    // The sibling backup marker survives the record's unreadability: a delete of the
    // bad record must still warn about the exported backup's custody.
    await markManagedExchangeBackedUp("bad-record", "2026-07-10T09:00:00.000Z");

    const entries = await listManagedExchangesDiagnostic();
    const unreadable = entries.find((entry) => entry.kind === "unreadable");
    expect(unreadable).toEqual({
      kind: "unreadable",
      id: "bad-record",
      backedUp: true,
    });
  });

  test("an unreadable record is deletable by key without a successful parse", async () => {
    const good = await createManagedExchange(newExchange({ label: "Good" }));
    await rawPut({
      ...good,
      id: "bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });

    await deleteManagedExchange("bad-record");

    // The offending record is gone, so the strict list read recovers.
    expect(await rawStored("bad-record")).toBeUndefined();
    const recovered = await listManagedExchanges();
    expect(recovered.map((record) => record.id)).toEqual([good.id]);
  });
});

describe("persistent storage request", () => {
  test("requests persistence and returns the browser's grant decision", async () => {
    const granted = await requestPersistentStorage();
    expect(typeof granted).toBe("boolean");
  });

  test("create requests persistent storage before the record lands", async () => {
    const realPersist = StorageManager.prototype.persist;
    let persistCalls = 0;
    StorageManager.prototype.persist = function (this: StorageManager) {
      persistCalls += 1;
      return Promise.resolve(false);
    };
    try {
      const created = await createManagedExchange(newExchange());
      expect(persistCalls).toBeGreaterThanOrEqual(1);
      // A denied grant does not fail the create.
      expect(await getManagedExchange(created.id)).toEqual(created);
    } finally {
      StorageManager.prototype.persist = realPersist;
    }
  });

  test("create succeeds when the persistence request throws", async () => {
    const realPersist = StorageManager.prototype.persist;
    StorageManager.prototype.persist = function (this: StorageManager) {
      throw new Error("persist unavailable");
    };
    try {
      const created = await createManagedExchange(newExchange());
      expect(await getManagedExchange(created.id)).toEqual(created);
    } finally {
      StorageManager.prototype.persist = realPersist;
    }
  });
});

describe("a blocked open settles instead of hanging", () => {
  test("a version-change open held off by an older connection rejects, not hangs", async () => {
    // Recreate the database one version below this build, then hold that older
    // connection open WITHOUT the module's onversionchange self-close, modelling an old
    // tab that never yields. The module's open (at IDB_VERSION) is a version-change open
    // the older connection blocks: it must reject rather than hang forever.
    await deleteDatabase();
    const held = await openRawHeldConnection(IDB_VERSION - 1);
    try {
      await expect(openManagedExchangeDatabase()).rejects.toThrow();
    } finally {
      held.close();
    }
  });

  test("closing the blocking connection lets a reopened open succeed", async () => {
    // The blocked state is transient: once the older connection closes, the same open
    // succeeds. This pins the self-healing property the degrade relies on -- a reload
    // (or the other tab closing) recovers a store the first open found blocked.
    await deleteDatabase();
    const held = await openRawHeldConnection(IDB_VERSION - 1);
    await expect(openManagedExchangeDatabase()).rejects.toThrow();
    held.close();
    const db = await openManagedExchangeDatabase();
    try {
      expect(db.version).toBe(IDB_VERSION);
    } finally {
      db.close();
    }
  });

  test("an opened connection closes itself on a later version-change open", async () => {
    // The root-cause half: a connection this module opens registers onversionchange to
    // close itself, so it does not block the next build's upgrade the way an old tab's
    // unyielding connection does. With the module-opened connection left open, a raw
    // open one version higher completes rather than staying blocked.
    await deleteDatabase();
    const moduleConnection = await openManagedExchangeDatabase();
    const higher = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, IDB_VERSION + 1);
      request.onupgradeneeded = () => undefined;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("module connection did not yield on versionchange"));
    });
    higher.close();
    // The module connection closed itself, so a subsequent module open is clean.
    moduleConnection.close();
    await deleteDatabase();
  });
});
