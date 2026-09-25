/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
  reconcileManagedCommandLinePair,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedImportAlreadyHeldError,
  ManagedImportChosenCopyError,
  ManagedImportHandedOffError,
  ManagedImportSideMismatchError,
  ManagedImportStoredCopyError,
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
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// The command-line pair import against the real store (real IndexedDB): a pair
// installs a runnable record, a matching stored exchange is reconciled on the
// backup import's rule, a stored record of the pair's terms and side that its
// secret misses is offered and taken into only on the operator's answer, and
// the imported secret is stored in the record's secret field and in no other
// place this browser keeps anything.

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

  test("the backup import refuses a live match on the same rule", async () => {
    const live = await createRunnableExchange(newExchange());
    const outcome = await reconcileManagedCommandLinePair(
      live,
      "2026-07-14T12:00:00.000Z",
    );
    expect(outcome).toEqual({ kind: "held", label: live.label });
    await expect(
      importManagedExchange(
        serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(live)),
      ),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);
    expect(await listManagedExchanges()).toEqual([live]);
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

describe("a stored record of the pair's terms and side that its secret misses", () => {
  // The scheduled command-line runs rotated the secret past the one stored
  // here, so only the agreed terms and side find the record. The import stops
  // to ask, writing nothing, and the operator's answer decides where it lands.

  /** A pair of `record`'s terms and side holding a secret it does not. */
  function rotatedPairOf(record: ManagedExchangeRecord): {
    configuration: string;
    key: string;
    sharedSecret: string;
  } {
    const sharedSecret = generateSharedSecret();
    const onTheCommandLine = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({ label: "", side: record.side, sharedSecret }),
      ),
    );
    return { ...pairOf(onTheCommandLine), sharedSecret };
  }

  async function handedOff(): Promise<RunnableManagedExchangeRecord> {
    const record = await createRunnableExchange(newExchange({ schedule }));
    await markManagedExchangeBackedUp(record.id, "2026-07-10T09:00:00.000Z");
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      "2026-07-11T09:00:00.000Z",
      "command-line",
    );
    return record;
  }

  async function migrationSpent(): Promise<RunnableManagedExchangeRecord> {
    const record = await createRunnableExchange(newExchange({ schedule }));
    await markManagedExchangeBackedUp(record.id, "2026-07-10T09:00:00.000Z");
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      "2026-07-11T09:00:00.000Z",
    );
    return record;
  }

  async function configurationOnly(): Promise<ManagedExchangeRecord> {
    return createManagedExchange(newExchange({ sharedSecret: undefined }));
  }

  async function storedCopyOffer(
    configuration: string,
    key: string,
  ): Promise<ManagedImportStoredCopyError> {
    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedImportStoredCopyError);
    return error as ManagedImportStoredCopyError;
  }

  test("each kind of stored record is offered by state, a live one is not, and nothing is written", async () => {
    const live = await createRunnableExchange(newExchange());
    const handed = await handedOff();
    const spent = await migrationSpent();
    const configured = await configurationOnly();
    const storedBefore = await listManagedExchanges();
    const { configuration, key, sharedSecret } = rotatedPairOf(handed);

    const offer = await storedCopyOffer(configuration, key);

    expect(
      [...offer.copies].sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [
        { id: handed.id, label: handed.label, state: "handed-off" },
        { id: spent.id, label: spent.label, state: "migration-spent" },
        {
          id: configured.id,
          label: configured.label,
          state: "configuration-only",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(offer.copies.map(({ id }) => id)).not.toContain(live.id);
    expect(await listManagedExchanges()).toEqual(storedBefore);
    expect(await getManagedLocalState(handed.id)).toEqual({
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
      spent: {
        spentAt: "2026-07-11T09:00:00.000Z",
        handoff: "command-line",
      },
    });
    expect(await getManagedLocalState(configured.id)).toBeUndefined();
    expect(await everywhereStored(sharedSecret)).toEqual([]);
  });

  test("taken into a hand-off, the pair's secret is read in through the re-take", async () => {
    const handed = await handedOff();
    const { configuration, key, sharedSecret } = rotatedPairOf(handed);
    await storedCopyOffer(configuration, key);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: handed.id },
    );

    expect(record.id).toBe(handed.id);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([handed.id]);
    expect(stored[0].sharedSecret).toBe(sharedSecret);
    expect(stored[0].label).toBe(handed.label);
    expect(stored[0].schedule).toEqual(schedule);
    // The secret moved past the one the backup attests, so its marker goes.
    const local = await getManagedLocalState(handed.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
  });

  test("added beside a hand-off, the pair installs fresh and leaves it spent", async () => {
    const handed = await handedOff();
    const { configuration, key, sharedSecret } = rotatedPairOf(handed);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { besideIds: [handed.id] },
    );

    expect(record.id).not.toBe(handed.id);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id).sort()).toEqual(
      [handed.id, record.id].sort(),
    );
    expect(stored.find((entry) => entry.id === handed.id)).toEqual(handed);
    expect((await getManagedLocalState(handed.id))?.spent?.handoff).toBe(
      "command-line",
    );
    expect(await everywhereStored(sharedSecret)).toEqual([
      `${MANAGED_EXCHANGE_STORE_NAME}[${record.id}].sharedSecret`,
    ]);
  });

  test("taken into a migration-spent record, it is revived with the pair's secret and its backup marker dropped", async () => {
    // The marker is kept only where the pair holds the secret it attests (the
    // secret-match revive above); this pair's secret has moved past it.
    const spent = await migrationSpent();
    const { configuration, key, sharedSecret } = rotatedPairOf(spent);
    await storedCopyOffer(configuration, key);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: spent.id },
    );

    expect(record.id).toBe(spent.id);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([spent.id]);
    expect(stored[0].sharedSecret).toBe(sharedSecret);
    expect(stored[0].label).toBe(spent.label);
    expect(stored[0].schedule).toEqual(schedule);
    const local = await getManagedLocalState(spent.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
  });

  test("added beside a migration-spent record, the pair installs fresh and leaves it spent", async () => {
    const spent = await migrationSpent();
    const { configuration, key } = rotatedPairOf(spent);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { besideIds: [spent.id] },
    );

    expect(record.id).not.toBe(spent.id);
    expect(
      (await listManagedExchanges()).find((entry) => entry.id === spent.id),
    ).toEqual(spent);
    expect(await getManagedLocalState(spent.id)).toEqual({
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
      spent: { spentAt: "2026-07-11T09:00:00.000Z" },
    });
  });

  test("taken into a configuration-only record, it completes that record in place", async () => {
    const configured = await configurationOnly();
    const { configuration, key, sharedSecret } = rotatedPairOf(configured);
    await storedCopyOffer(configuration, key);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: configured.id },
    );

    expect(record.id).toBe(configured.id);
    expect(runnableManagedExchange(record)).toBe(true);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([configured.id]);
    expect(stored[0].sharedSecret).toBe(sharedSecret);
    expect(stored[0].label).toBe(configured.label);
    const local = await getManagedLocalState(configured.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
  });

  test("a chosen record deleted since the offer refuses, writing nothing", async () => {
    const configured = await configurationOnly();
    const { configuration, key, sharedSecret } = rotatedPairOf(configured);
    await storedCopyOffer(configuration, key);
    await deleteManagedExchange(configured.id);

    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: configured.id },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect((error as ManagedImportChosenCopyError).reason).toBe("changed");
    expect(await listManagedExchanges()).toEqual([]);
    expect(await everywhereStored(sharedSecret)).toEqual([]);
  });
});

describe("a migration-spent record holding the pair's secret for the other side", () => {
  test("refuses the pair, writing nothing", async () => {
    // The partner's files hold the same secret from their side.
    const husk = await createRunnableExchange(newExchange());
    await spendManagedExchangeIfCurrent(
      husk.id,
      husk.sharedSecret,
      "2026-07-11T09:00:00.000Z",
    );
    const partners = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({ side: "acceptor", sharedSecret: husk.sharedSecret }),
      ),
    );
    const { configuration, key } = pairOf(partners);

    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagedImportSideMismatchError);
    expect((error as ManagedImportSideMismatchError).label).toBe(husk.label);
    expect(await listManagedExchanges()).toEqual([husk]);
    expect(await getManagedLocalState(husk.id)).toEqual({
      spent: { spentAt: "2026-07-11T09:00:00.000Z" },
    });
  });
});
