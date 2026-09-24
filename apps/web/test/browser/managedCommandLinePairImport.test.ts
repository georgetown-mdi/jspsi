/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
  reconcileManagedCommandLinePair,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedImportAlreadyHeldError,
  ManagedImportHandedOffError,
  importManagedCommandLinePair,
  importManagedExchange,
} from "@psi/managed/managedExchangeImport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managed/managedLocalState";
import { ManagedKeyFileRefusedError } from "@psi/managed/managedCommandLineImport";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// The command-line pair import against the real store (real IndexedDB): a pair
// installs a runnable record, a matching stored exchange is reconciled on the
// backup import's rule, and the imported secret is stored in the record's
// secret field and in no other place this browser keeps anything.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

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
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The two files the app's own command-line export writes for `record`. */
function pairOf(record: RunnableManagedExchangeRecord): {
  configuration: string;
  key: string;
} {
  const exported = composeManagedCronExport(record);
  return { configuration: exported.config.text, key: exported.key.text };
}

async function createRunnableExchange(
  fields: NewManagedExchange,
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

/** Every place under `value` holding `needle` as a whole string or a part of
 * one, as a dotted path from `at`. */
function pathsHolding(
  value: unknown,
  needle: string,
  at: string,
): Array<string> {
  if (typeof value === "string") return value.includes(needle) ? [at] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.includes(needle) ? [`${at}.<key>`] : []),
    ...pathsHolding(child, needle, `${at}.${key}`),
  ]);
}

/** Every place this browser's origin keeps something that holds `needle`: each
 * object store of the managed-exchange database, by store name and key, and
 * localStorage and sessionStorage. */
async function everywhereStored(needle: string): Promise<Array<string>> {
  const db = await openManagedExchangeDatabase();
  const found: Array<string> = [];
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      const [keys, values] = await new Promise<
        [Array<IDBValidKey>, Array<unknown>]
      >((resolve, reject) => {
        const store = db
          .transaction(storeName, "readonly")
          .objectStore(storeName);
        const readKeys = store.getAllKeys();
        const readValues = store.getAll();
        readValues.onsuccess = () =>
          resolve([readKeys.result, readValues.result]);
        readValues.onerror = () => reject(readValues.error);
      });
      keys.forEach((key, index) => {
        found.push(
          ...pathsHolding(
            values[index],
            needle,
            `${storeName}[${String(key)}]`,
          ),
        );
      });
    }
  } finally {
    db.close();
  }
  for (const [name, storage] of [
    ["localStorage", localStorage],
    ["sessionStorage", sessionStorage],
  ] as const)
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? "";
      found.push(
        ...pathsHolding({ [key]: storage.getItem(key) }, needle, name),
      );
    }
  return found;
}

beforeEach(async () => {
  await clearManagedExchanges();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("a command-line pair installs a runnable exchange", () => {
  test("with no stored match, installs fresh and stamps only the import marker", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration, key } = pairOf(source);

    const { record } = await importManagedCommandLinePair(configuration, key);

    expect(runnableManagedExchange(record)).toBe(true);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([record.id]);
    expect(stored[0].sharedSecret).toBe(source.sharedSecret);
    const local = await getManagedLocalState(record.id);
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    expect(local?.backup).toBeUndefined();
  });

  test("the secret is stored in the record's secret field and nowhere else", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration, key } = pairOf(source);

    const { record } = await importManagedCommandLinePair(configuration, key);

    expect(await everywhereStored(source.sharedSecret)).toEqual([
      `${MANAGED_EXCHANGE_STORE_NAME}[${record.id}].sharedSecret`,
    ]);
  });

  test("a refused key file stores nothing anywhere", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration } = pairOf(source);

    await expect(
      importManagedCommandLinePair(
        configuration,
        JSON.stringify({ sharedSecret: source.sharedSecret, stray: 1 }),
      ),
    ).rejects.toBeInstanceOf(ManagedKeyFileRefusedError);

    expect(await listManagedExchanges()).toEqual([]);
    expect(await everywhereStored(source.sharedSecret)).toEqual([]);
  });
});

describe("a stored exchange holding the pair's secret", () => {
  test("a live one refuses the pair, writing nothing", async () => {
    const live = await createRunnableExchange(newExchange());
    const { configuration, key } = pairOf(live);

    await expect(
      importManagedCommandLinePair(configuration, key),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);

    const stored = await listManagedExchanges();
    expect(stored).toEqual([live]);
    expect(await getManagedLocalState(live.id)).toBeUndefined();
  });

  test("the backup import's live match is unchanged: it still installs fresh", async () => {
    const live = await createRunnableExchange(newExchange());
    const outcome = await reconcileManagedCommandLinePair(
      live,
      "2026-07-14T12:00:00.000Z",
    );
    expect(outcome).toEqual({ kind: "held", label: live.label });
    const { record } = await importManagedExchange(
      serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(live)),
    );
    expect(record.id).not.toBe(live.id);
  });

  test("a migration-spent one is revived in place with the pair laid over it", async () => {
    const husk = await createRunnableExchange(
      newExchange({ schedule, tokenMaxAgeDays: 30 }),
    );
    await markManagedExchangeBackedUp(husk.id, "2026-07-10T09:00:00.000Z");
    await spendManagedExchangeIfCurrent(
      husk.id,
      husk.sharedSecret,
      "2026-07-11T09:00:00.000Z",
    );
    const onTheCommandLine = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({
          label: "",
          sharedSecret: husk.sharedSecret,
          expires: "2026-12-31T00:00:00.000Z",
          tokenMaxAgeDays: 60,
        }),
      ),
    );
    const { configuration, key } = pairOf(onTheCommandLine);

    const { record } = await importManagedCommandLinePair(configuration, key);

    expect(record.id).toBe(husk.id);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([husk.id]);
    expect(stored[0].label).toBe(husk.label);
    expect(stored[0].schedule).toEqual(schedule);
    expect(stored[0].tokenMaxAgeDays).toBe(60);
    expect(stored[0].expires).toBe("2026-12-31T00:00:00.000Z");
    const local = await getManagedLocalState(husk.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    // The secret did not move, so the backup taken before it still holds it.
    expect(local?.backup?.backedUpAt).toBe("2026-07-10T09:00:00.000Z");
  });

  test("one handed off to the command line refuses the pair, writing nothing", async () => {
    const handedOff = await createRunnableExchange(newExchange());
    await spendManagedExchangeIfCurrent(
      handedOff.id,
      handedOff.sharedSecret,
      "2026-07-11T09:00:00.000Z",
      "command-line",
    );
    const { configuration, key } = pairOf(handedOff);

    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagedImportHandedOffError);
    expect((error as ManagedImportHandedOffError).label).toBe(handedOff.label);
    expect(await listManagedExchanges()).toEqual([handedOff]);
    const local = await getManagedLocalState(handedOff.id);
    expect(local?.spent?.handoff).toBe("command-line");
    expect(local?.imported).toBeUndefined();
  });
});
