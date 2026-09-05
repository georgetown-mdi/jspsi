/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  IDB_VERSION,
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  listReadableManagedExchanges,
  openManagedExchangeDatabase,
  persistManagedExchangeRotation,
  persistManagedExchangeScheduleAdvance,
  putManagedExchange,
  recordManagedExchangeLastRun,
  requestPersistentStorage,
  spendManagedExchangeIfCurrent,
  updateManagedExchangeLocalFields,
} from "@psi/managedExchangeStore";
import {
  MAX_LABEL_LENGTH,
  MAX_SCHEDULE_INTERVAL_DAYS,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  appendDisclosureRecordToStore,
  readDisclosureAccounting,
  resetDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managedLocalState";
import { DISCLOSURE_ACCOUNTING_VERSION } from "@psi/disclosureAccounting";
import { buildManagedDeposit } from "@bench/manageOfferModel";

import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../utils/disclosureFixtures";

import type { ExchangeRecord, WebRTCExchangeLocator } from "@psilink/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";

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

/** The raw accounting-of-disclosures value under a key, read straight from its
 * sibling store, so the delete and clear tests can assert the accounting is gone
 * too -- and gone from the store, rather than merely absent through a validating
 * read -- and the write path's validation can be checked against what is at rest. */
async function rawDisclosureStored(id: string): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, "readonly")
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Put a value into the accounting store past the write path's validation, so a
 * test can stage what an app upgrade LEAVES at rest -- entries admitted by the
 * exchange-record format current when they were written, which this build's
 * format no longer admits. The append path cannot write one by construction, so a
 * recovery test has no other way to reach that state. */
async function putRawDisclosureStored(
  id: string,
  value: unknown,
): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .put(value, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** The entries of an exchange's accounting, through the production read. Asserts
 * the read classified as an accounting first, so a caller asserting on entries can
 * never be silently reading a classified failure as an empty history. */
async function accountingEntries(
  id: string,
): Promise<ReadonlyArray<ExchangeRecord>> {
  const read = await readDisclosureAccounting(id);
  expect(read.kind).toBe("accounting");
  return read.kind === "accounting" ? read.accounting.entries : [];
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

/** Open a raw connection at `version`, WITHOUT the module's
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

  test("a rotation cannot revert a concurrent label edit", async () => {
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

describe("atomic schedule advance", () => {
  const advanced: ManagedExchangeSchedule = {
    ...schedule,
    nextWindow: "2026-01-20T14:00:00.000Z",
    consecutiveMisses: 1,
  };
  const missedRun = {
    at: "2026-01-13T17:00:00.000Z",
    outcome: "missed",
  } as const;

  test("the planned window, the count, and the outcome land in one write", async () => {
    const created = await createManagedExchange(newExchange({ schedule }));
    const written = await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: advanced,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(written.schedule).toEqual(advanced);
    expect(written.lastRun).toEqual(missedRun);
    // What persists is what the call returned, not a validating read's view.
    expect(await rawStored(created.id)).toMatchObject({
      schedule: advanced,
      lastRun: missedRun,
    });
  });

  test("advancing cannot revert a concurrent rotation write", async () => {
    const created = await createManagedExchange(newExchange({ schedule }));
    const rotatedSecret = generateSharedSecret();
    await persistManagedExchangeRotation(created.id, {
      sharedSecret: rotatedSecret,
      expires: null,
    });
    const written = await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: advanced,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(written.sharedSecret).toBe(rotatedSecret);
    expect(written.schedule).toEqual(advanced);
  });

  test("a schedule dropped between the wake and the write is not resurrected", async () => {
    const created = await createManagedExchange(newExchange({ schedule }));
    await updateManagedExchangeLocalFields(created.id, { schedule: null });
    const written = await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: advanced,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(written).not.toHaveProperty("schedule");
    expect(written).not.toHaveProperty("lastRun");
    expect(await rawStored(created.id)).not.toHaveProperty("schedule");
  });

  test("a plan a newer write already moved leaves the stored record alone", async () => {
    const created = await createManagedExchange(newExchange({ schedule }));
    const newer = {
      ...advanced,
      nextWindow: "2026-01-27T14:00:00.000Z",
      consecutiveMisses: 2,
    };
    await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: newer,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
    });
    const written = await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: advanced,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(written.schedule).toEqual(newer);
    expect(await rawStored(created.id)).toMatchObject({ schedule: newer });
    expect(await rawStored(created.id)).not.toHaveProperty("lastRun");
  });

  test("a count the operator cleared survives a wake that read the old one", async () => {
    const created = await createManagedExchange(
      newExchange({ schedule: { ...schedule, consecutiveMisses: 3 } }),
    );
    const cleared = { ...schedule, consecutiveMisses: 0 };
    await updateManagedExchangeLocalFields(created.id, { schedule: cleared });
    const written = await persistManagedExchangeScheduleAdvance(created.id, {
      schedule: { ...advanced, consecutiveMisses: 4 },
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: 3,
      lastRun: missedRun,
    });
    expect(written.schedule).toEqual(cleared);
    expect(await rawStored(created.id)).toMatchObject({ schedule: cleared });
    expect(await rawStored(created.id)).not.toHaveProperty("lastRun");
  });

  test("an advance the record schema rejects aborts the transaction and writes nothing", async () => {
    const created = await createManagedExchange(newExchange({ schedule }));
    await expect(
      persistManagedExchangeScheduleAdvance(created.id, {
        schedule: { ...advanced, consecutiveMisses: -1 },
        fromNextWindow: schedule.nextWindow,
        fromConsecutiveMisses: schedule.consecutiveMisses,
        lastRun: missedRun,
      }),
    ).rejects.toThrow();
    // Re-read the raw store: neither half of the advance landed.
    expect(await rawStored(created.id)).toMatchObject({ schedule });
    expect(await rawStored(created.id)).not.toHaveProperty("lastRun");
  });

  test("advancing a missing id rejects", async () => {
    await expect(
      persistManagedExchangeScheduleAdvance("no-such-id", {
        schedule: advanced,
        fromNextWindow: schedule.nextWindow,
        fromConsecutiveMisses: schedule.consecutiveMisses,
      }),
    ).rejects.toThrow();
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
        documentParts: { side: "inviter", linkageTerms },
        connection: webrtcLocator,
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
        documentParts: { side: "acceptor", linkageTerms },
        connection: webrtcLocator,
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

  test("both sides deposit into one list holding both", async () => {
    await createManagedExchange(
      buildManagedDeposit(
        {
          documentParts: { side: "inviter", linkageTerms },
          connection: webrtcLocator,
          sharedSecret: generateSharedSecret(),
          choices: { label: "Invited partnership" },
        },
        NOW,
      ),
    );
    await createManagedExchange(
      buildManagedDeposit(
        {
          documentParts: { side: "acceptor", linkageTerms },
          connection: webrtcLocator,
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

describe("the unattended read is per entry", () => {
  /** Seed an entry holding a period past the schema's ceiling under its own key
   * -- the shape a pre-ceiling import or a hand-edit leaves in the store, written
   * past the validating path that would refuse it. */
  async function seedOutOfBoundsRecord(
    from: ManagedExchangeRecord,
  ): Promise<void> {
    await rawPut({
      ...from,
      id: "legacy-out-of-bounds",
      schedule: { ...schedule, intervalDays: MAX_SCHEDULE_INTERVAL_DAYS + 1 },
    });
  }

  test("skips the entry it cannot parse and returns every record it can", async () => {
    const good = await createManagedExchange(
      newExchange({ label: "Good", schedule }),
    );
    await seedOutOfBoundsRecord(good);

    // The attended read still rejects wholesale: that contract is what routes an
    // operator to the read-failed recovery surface, and that stands by design.
    await expect(listManagedExchanges()).rejects.toThrow();

    const read = await listReadableManagedExchanges();
    expect(read.records.map((record) => record.id)).toEqual([good.id]);
    expect(read.unreadableIds).toEqual(["legacy-out-of-bounds"]);
  });

  test("reports nothing unreadable for a store of valid records", async () => {
    const first = await createManagedExchange(newExchange({ label: "First" }));
    const second = await createManagedExchange(
      newExchange({ label: "Second" }),
    );

    const read = await listReadableManagedExchanges();

    expect(read.unreadableIds).toEqual([]);
    expect(read.records.map((record) => record.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  test("names the key a delete acts on, so the read recovers once it is used", async () => {
    const good = await createManagedExchange(
      newExchange({ label: "Good", schedule }),
    );
    await seedOutOfBoundsRecord(good);
    const [unreadableId] = (await listReadableManagedExchanges()).unreadableIds;

    await deleteManagedExchange(unreadableId);

    const read = await listReadableManagedExchanges();
    expect(read.unreadableIds).toEqual([]);
    expect(read.records.map((record) => record.id)).toEqual([good.id]);
    // And the attended read recovers with it: one discard fixes both.
    expect((await listManagedExchanges()).map((record) => record.id)).toEqual([
      good.id,
    ]);
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
    await spendManagedExchangeIfCurrent(
      created.id,
      created.sharedSecret,
      "2026-02-02T09:00:00.000Z",
    );
    // And file a run's disclosure, so the delete must clear the accounting too --
    // otherwise the delete strands cleartext partner and agreement metadata under
    // an id nothing shows.
    await appendDisclosureRecordToStore(created.id, await disclosureRecord());
    // Everything the browser holds for the exchange -- the record under its key,
    // the sibling local-state entry, and the accounting -- exists before the delete.
    expect(await rawStored(created.id)).toBeDefined();
    expect(await rawLocalStored(created.id)).toBeDefined();
    expect(await rawDisclosureStored(created.id)).toBeDefined();

    await deleteManagedExchange(created.id);

    // Enumerate every location and assert emptiness, not merely that the row is
    // gone: the record store (raw and through both validating reads) AND the
    // sibling local-state store (raw and through its validating read).
    expect(await rawStored(created.id)).toBeUndefined();
    expect(await getManagedExchange(created.id)).toBeUndefined();
    expect(await listManagedExchanges()).toEqual([]);
    expect(await rawLocalStored(created.id)).toBeUndefined();
    expect(await getManagedLocalState(created.id)).toBeUndefined();
    expect(await rawDisclosureStored(created.id)).toBeUndefined();
    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "none",
    });
    await root.removeEntry("managed-input.csv");
  });

  test("delete of a missing id is idempotent", async () => {
    await expect(deleteManagedExchange("no-such-id")).resolves.toBeUndefined();
  });
});

describe("the accounting of disclosures accumulates each run's record", () => {
  test("a filed record round-trips verbatim, and a second run is a second entry", async () => {
    const created = await createManagedExchange(newExchange());
    const first = await disclosureRecord({
      createdAt: "2026-02-01T14:00:00.000Z",
    });
    const second = await disclosureRecord({
      createdAt: "2026-03-01T14:00:00.000Z",
    });

    await appendDisclosureRecordToStore(created.id, first);
    await appendDisclosureRecordToStore(created.id, second);

    // Verbatim through the structured clone and the validating read: the entry is
    // the record the run produced, not a summary of it.
    expect(await accountingEntries(created.id)).toEqual([first, second]);
  });

  test("re-filing one run's record does not double its entry", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();

    await appendDisclosureRecordToStore(created.id, record);
    await appendDisclosureRecordToStore(created.id, record);

    expect(await accountingEntries(created.id)).toHaveLength(1);
  });

  test("an exchange that has never completed a run has no accounting", async () => {
    const created = await createManagedExchange(newExchange());

    // Classified as an empty store rather than as a failure: this is the only
    // state the surface may render as "nothing was disclosed".
    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "none",
    });
  });

  test("an entry is stored as the reader admits it, without a caller's extra key", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();

    // A caller handing the store more than the record format holds: the append
    // validates through the same parser the read path uses, so the extra field
    // never reaches the disk to sit there invisibly.
    await appendDisclosureRecordToStore(created.id, {
      ...record,
      operatorNote: "not part of the record format",
    } as ExchangeRecord);

    const stored = (await rawDisclosureStored(created.id)) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(stored.entries[0]).not.toHaveProperty("operatorNote");
    expect(stored.entries[0]).toEqual(record);
  });
});

/**
 * Recovering an accounting this build can no longer read, against real IndexedDB:
 * an app upgrade moved the record version, so entries admissible when written are
 * now refused. The read classifies that state in ONE round trip, so a refused
 * value -- the only kind eligible for the destructive reset -- is never confused
 * with a store that never yielded one. Recovery keeps the record but leaves the
 * store un-appendable; reset restores appendability and destroys the entries.
 */
describe("an unreadable accounting recovers without deleting the exchange", () => {
  /** A stored accounting whose entries hold a record version this build does not
   * admit, staged under an exchange that otherwise stands. */
  async function strandedAccounting(): Promise<{
    id: string;
    entries: Array<unknown>;
  }> {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    const entries = [
      { ...record, version: `${record.version}-moved` } as unknown,
    ];
    await putRawDisclosureStored(created.id, {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries,
    });
    // The assumption behind the whole recovery, restated against the real store: the
    // read refuses to vouch for this, so the exchange is in the stranded state.
    expect((await readDisclosureAccounting(created.id)).kind).toBe(
      "unreadable",
    );
    return { id: created.id, entries };
  }

  test("the one read that refuses the entries hands back the stored form", async () => {
    const { id, entries } = await strandedAccounting();

    const read = await readDisclosureAccounting(id);

    // Verbatim through the structured clone: what the operator is handed is what
    // is at rest, not a reading of it -- and it comes from the same round trip
    // that refused it, so a second read cannot disagree about what is stored.
    expect(read).toEqual({
      kind: "unreadable",
      stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
    });
  });

  test("an accounting damaged past its envelope leaves nothing to hand back", async () => {
    const created = await createManagedExchange(newExchange());
    await putRawDisclosureStored(created.id, {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: "one disclosure",
    });

    // Still the unreadable state -- the value was read and refused -- but with no
    // export to offer, which is the distinction the surface renders.
    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "unreadable",
      stored: undefined,
    });
  });

  test("an accounting this version can read classifies as an accounting, not a recovery", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    await appendDisclosureRecordToStore(created.id, record);

    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "accounting",
      accounting: {
        version: DISCLOSURE_ACCOUNTING_VERSION,
        entries: [record],
      },
    });
  });

  test("a store that will not open is transient, never the unreadable state", async () => {
    // The real blocked open, driven as the store's own suite drives it: an older
    // connection that never yields holds off this build's version-change open.
    // Whatever else is true, the accounting was never READ -- so classifying this
    // as unreadable would offer the irreversible reset over a condition that
    // clears when the other tab closes, and classifying it as "none" would claim
    // nothing was disclosed.
    await deleteDatabase();
    const held = await openRawHeldConnection(IDB_VERSION - 1);
    try {
      expect(await readDisclosureAccounting("any-exchange")).toEqual({
        kind: "unavailable",
      });
    } finally {
      held.close();
    }
  });

  test("a stranded accounting cannot be appended to until it is reset", async () => {
    const { id } = await strandedAccounting();

    // The consequence the reset exists for: the read failure is an append failure
    // too, so a still-scheduled exchange keeps disclosing and files nothing.
    await expect(
      appendDisclosureRecordToStore(id, await disclosureRecord()),
    ).rejects.toThrow();

    await resetDisclosureAccounting(id);
    const filed = await disclosureRecord();
    await appendDisclosureRecordToStore(id, filed);

    expect(await accountingEntries(id)).toEqual([filed]);
  });

  test("the reset destroys the accounting and nothing else the browser holds", async () => {
    const { id } = await strandedAccounting();
    await markManagedExchangeBackedUp(id, "2026-08-01T09:00:00.000Z");
    const before = await getManagedExchange(id);
    expect(before).toBeDefined();

    await resetDisclosureAccounting(id);

    // Gone from the store, not merely absent through a validating read.
    expect(await rawDisclosureStored(id)).toBeUndefined();
    expect(await readDisclosureAccounting(id)).toEqual({ kind: "none" });
    // The exchange itself stands: the record under its key, byte for byte, and
    // the sibling local state beside it. This is the whole point of scoping the
    // delete to the one store -- an operator recovers an accounting without
    // losing the partnership.
    expect(await getManagedExchange(id)).toEqual(before);
    expect((await getManagedLocalState(id))?.backup).toBeDefined();
    expect((await listManagedExchanges()).map((entry) => entry.id)).toEqual([
      id,
    ]);
  });

  test("the reset of an exchange with no accounting is idempotent", async () => {
    const created = await createManagedExchange(newExchange());

    await expect(
      resetDisclosureAccounting(created.id),
    ).resolves.toBeUndefined();
    expect(await getManagedExchange(created.id)).toBeDefined();
  });

  test("the reset is scoped to its own exchange, leaving another's accounting alone", async () => {
    const { id } = await strandedAccounting();
    const other = await createManagedExchange(newExchange());
    const otherRecord = await disclosureRecord();
    await appendDisclosureRecordToStore(other.id, otherRecord);

    await resetDisclosureAccounting(id);

    expect(await accountingEntries(other.id)).toEqual([otherRecord]);
  });
});

/**
 * Which way the refusal points, against the real store. A refused value means one
 * of two opposite things -- this build is ahead of the entries, or behind them --
 * and only the destructive recovery belongs to the first. The reverse skew is
 * live in this app: a new deployment activates while a tab goes on running the
 * code it loaded with, so a stale tab can read entries a newer build filed.
 */
describe("a refused accounting is classified by which side is behind", () => {
  /** Stage an accounting whose entries hold a record version `offset` ordinals
   * from this build's, under an exchange that otherwise stands. */
  async function accountingFromNeighbouringBuild(offset: number): Promise<{
    id: string;
    entries: Array<unknown>;
  }> {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    const entries = [
      { ...record, version: neighbouringRecordVersion(offset) } as unknown,
    ];
    await putRawDisclosureStored(created.id, {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries,
    });
    return { id: created.id, entries };
  }

  test("entries from a later record format are treated as a stale page, not a stranded accounting", async () => {
    const { id, entries } = await accountingFromNeighbouringBuild(1);

    // The reset is the wrong recovery here by construction: these entries are
    // readable by a build that already exists, so clearing them would destroy
    // records over a tab running older code. The state holds the stored value
    // all the same -- handing back stored bytes claims nothing either way.
    expect(await readDisclosureAccounting(id)).toEqual({
      kind: "stale-page",
      stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
    });
  });

  test("entries from an earlier record format stay the stranded accounting", async () => {
    const { id, entries } = await accountingFromNeighbouringBuild(-1);

    expect(await readDisclosureAccounting(id)).toEqual({
      kind: "unreadable",
      stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
    });
  });

  test("a stale page's entries are still not appendable, so neither state files quietly", async () => {
    const { id } = await accountingFromNeighbouringBuild(1);

    // The append re-reads through the validating parse, so this build files
    // nothing here either. What differs is the remedy the surface offers, not
    // what the store does.
    await expect(
      appendDisclosureRecordToStore(id, await disclosureRecord()),
    ).rejects.toThrow();
  });
});

describe("clearing the store leaves no accounting behind", () => {
  test("a cleared store takes every accounting of disclosures with it", async () => {
    const created = await createManagedExchange(newExchange());
    await appendDisclosureRecordToStore(created.id, await disclosureRecord());
    expect(await rawDisclosureStored(created.id)).toBeDefined();

    await clearManagedExchanges();

    // The raw sibling value is gone, not merely absent through a validating read:
    // a clear that spared the accounting would leave cleartext partner and
    // agreement metadata under an id no record shows any more.
    expect(await rawDisclosureStored(created.id)).toBeUndefined();
    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "none",
    });
    expect(await listManagedExchanges()).toEqual([]);
  });
});

describe("diagnostic read never rejects wholesale", () => {
  test("readable entries hold display essentials only, never the secret", async () => {
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

  test("a backup marker present is treated as backedUp; the timestamp never shows", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Backed up" }),
    );
    await markManagedExchangeBackedUp(created.id, "2026-07-10T09:00:00.000Z");

    const [entry] = await listManagedExchangesDiagnostic();
    expect(entry.backedUp).toBe(true);
    // The marker's own instant is never shown -- a boolean suffices.
    expect(JSON.stringify(entry)).not.toContain("2026-07-10T09:00:00.000Z");
  });

  test("an absent sibling entry is treated as not backed up", async () => {
    await createManagedExchange(newExchange({ label: "Fresh" }));
    const [entry] = await listManagedExchangesDiagnostic();
    expect(entry.backedUp).toBe(false);
  });

  test("an unparseable sibling entry is treated as backed up (conservative on doubt)", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Doubtful" }),
    );
    // Corrupt the sibling entry so its parse fails: a wrongly-shown custody warning
    // is harmless; a wrongly-suppressed one is not, so doubt is treated as backed up.
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

  test("an unreadable record with a live sibling backup marker is still treated as backed up", async () => {
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

  test("a late success after blocked-rejection closes the connection instead of leaking it", async () => {
    // The blocked request never aborts: it stays pending, and once `held` closes,
    // this SAME request's onupgradeneeded/onsuccess fire late, after the promise
    // already rejected. A probe that reopens the database cannot tell an immediate
    // close from a leak that only self-closes on the NEXT version-change open, so
    // the proof here is a spy on IDBDatabase.prototype.close, checked by instance
    // identity, on the late connection itself (a THIRD instance, distinct from `held`).
    const closeSpy = vi.spyOn(IDBDatabase.prototype, "close");
    try {
      await deleteDatabase();
      const held = await openRawHeldConnection(IDB_VERSION - 1);
      await expect(openManagedExchangeDatabase()).rejects.toThrow();
      held.close();
      // Give the same request's now-unblocked onupgradeneeded/onsuccess a beat to fire,
      // by polling the spy itself (no new IDB opens per attempt, so no risk of stacking
      // probe connections) rather than a fixed sleep.
      await vi.waitFor(() => {
        const closedInstances = new Set(
          closeSpy.mock.instances as Array<IDBDatabase>,
        );
        expect(closedInstances.has(held)).toBe(true);
        expect(closedInstances.size).toBeGreaterThanOrEqual(2);
      });
    } finally {
      closeSpy.mockRestore();
      await deleteDatabase();
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
