/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
  putManagedExchange,
  requestPersistentStorage,
  updateManagedExchangeLocalFields,
} from "@psi/managedExchangeStore";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

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

describe("reader rejects unknown on a store read", () => {
  test("a future schemaVersion in the store rejects rather than loading", async () => {
    const created = await createManagedExchange(newExchange());
    await rawPut({ ...created, schemaVersion: "psilink-managed-exchange/v2" });
    await expect(getManagedExchange(created.id)).rejects.toThrow();
    await expect(listManagedExchanges()).rejects.toThrow();
  });
});

describe("one-step delete leaves nothing behind", () => {
  test("delete removes the record, secret, handle, schedule, and bookkeeping", async () => {
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
    // Everything the browser holds for the exchange is one object under one key.
    expect(await rawStored(created.id)).toBeDefined();

    await deleteManagedExchange(created.id);

    expect(await rawStored(created.id)).toBeUndefined();
    expect(await getManagedExchange(created.id)).toBeUndefined();
    expect(await listManagedExchanges()).toEqual([]);
    await root.removeEntry("managed-input.csv");
  });

  test("delete of a missing id is idempotent", async () => {
    await expect(deleteManagedExchange("no-such-id")).resolves.toBeUndefined();
  });
});

describe("persistent storage request", () => {
  test("requests persistence and returns the browser's grant decision", async () => {
    const granted = await requestPersistentStorage();
    expect(typeof granted).toBe("boolean");
  });
});
