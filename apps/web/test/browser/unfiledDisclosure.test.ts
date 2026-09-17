/// <reference types="@vitest/browser-playwright/context" />

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
} from "@psilink/core";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  openManagedExchangeDatabase,
} from "@psi/managed/managedExchangeStore";
import {
  appendDisclosureRecordToStore,
  readDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import {
  clearUnfiledExchangeFlag,
  flagUnfiledExchange,
  unfiledExchangeFlagged,
} from "@psi/unfiledDisclosureFlag";
import {
  fileUnfiledDisclosures,
  noteUnfiledDisclosureRun,
  readUnfiledDisclosures,
} from "@psi/unfiledDisclosureStore";
import { DISCLOSURE_ACCOUNTING_VERSION } from "@psi/disclosureAccounting";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { unfiledDisclosureKey } from "@psi/unfiledDisclosure";

import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../utils/disclosureFixtures";

import type { ExchangeRecord } from "@psilink/core";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

/**
 * The note of a run whose disclosure record never reached the accounting, driven
 * against real IndexedDB: what a run leaves, what the next visit reads back
 * through a connection of its own, and what filing the retained records does to
 * both keys.
 *
 * The platform half is the point here. Each read opens its own connection, which
 * is what a later visit does, so an assertion that a note "survives" is an
 * assertion about what is at rest rather than about a value held in memory.
 */

const NOTED_AT = "2026-07-01T09:00:01.000Z";

function newExchange(): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  };
}

/** The raw value under a key of the disclosure store, so a test can assert what
 * is at rest rather than what a validating read reports. */
async function rawStored(key: IDBValidKey): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, "readonly")
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Put a value into the disclosure store past every write path's validation, so a
 * test can stage what an app upgrade leaves at rest: an accounting whose entries
 * this build's exchange-record format no longer admits. */
async function putRawStored(key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME)
        .put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** The entries of an exchange's accounting, through the production read. Asserts
 * the read classified as an accounting first, so a caller asserting on entries
 * can never be silently reading a classified failure as an empty history. */
async function accountingEntries(
  id: string,
): Promise<ReadonlyArray<ExchangeRecord>> {
  const read = await readDisclosureAccounting(id);
  expect(read.kind).toBe("accounting");
  return read.kind === "accounting" ? read.accounting.entries : [];
}

/** Hold the store's own report of a note it could not write, which the suite's
 * output would otherwise carry, and clear the flag it falls back to once the test
 * is done, so no exchange stays named past it. */
function captureRefusedNoteReport(id: string) {
  const failure = vi
    .spyOn(getLogger("unfiledDisclosureStore"), "error")
    .mockImplementation(() => {});
  onTestFinished(async () => {
    failure.mockRestore();
    await clearUnfiledExchangeFlag(id);
  });
  return failure;
}

beforeEach(clearManagedExchanges);
afterEach(clearManagedExchanges);

describe("what a run that could not file leaves", () => {
  test("the next visit reads the run and the record it retained", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();

    expect(await noteUnfiledDisclosureRun(created.id, record, NOTED_AT)).toBe(
      "noted",
    );

    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unfiled",
      disclosures: [{ at: record.createdAt, record }],
    });
  });

  test("a run that built no record is read as the fact alone", async () => {
    const created = await createManagedExchange(newExchange());

    await noteUnfiledDisclosureRun(created.id, undefined, NOTED_AT);

    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unfiled",
      disclosures: [{ at: NOTED_AT }],
    });
  });

  test("an exchange with nothing noted reads as none", async () => {
    const created = await createManagedExchange(newExchange());

    expect(await readUnfiledDisclosures(created.id)).toEqual({ kind: "none" });
  });

  test("the note sits beside the accounting, not in it", async () => {
    const created = await createManagedExchange(newExchange());
    const filed = await disclosureRecord();
    await appendDisclosureRecordToStore(created.id, filed);

    await noteUnfiledDisclosureRun(
      created.id,
      await disclosureRecord({ createdAt: "2026-08-01T09:00:00.000Z" }),
      NOTED_AT,
    );

    // The accounting is a log of self-attested records that WERE filed; a run
    // that was not filed may not appear among them.
    expect(
      (await accountingEntries(created.id)).map((e) => e.createdAt),
    ).toEqual([filed.createdAt]);
    expect(await rawStored(unfiledDisclosureKey(created.id))).toBeDefined();
  });

  test("a stored note this build cannot read still says a run is missing", async () => {
    const created = await createManagedExchange(newExchange());
    await putRawStored(unfiledDisclosureKey(created.id), {
      noted: "yesterday",
    });

    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unreadable",
    });
  });

  test("noting a run over a note this build cannot read keeps the stored value", async () => {
    const created = await createManagedExchange(newExchange());
    const unreadable = { noted: "yesterday" };
    await putRawStored(unfiledDisclosureKey(created.id), unreadable);
    captureRefusedNoteReport(created.id);

    const noted = await noteUnfiledDisclosureRun(
      created.id,
      await disclosureRecord(),
      NOTED_AT,
    );

    // Those bytes are the only thing standing for the runs they name, so the
    // write fails rather than replacing them with this run alone.
    expect(noted).toBe("flagged");
    expect(await rawStored(unfiledDisclosureKey(created.id))).toEqual(
      unreadable,
    );
  });

  test("the run refused that way lands in the flag and the diagnostic log", async () => {
    const created = await createManagedExchange(newExchange());
    await putRawStored(unfiledDisclosureKey(created.id), {
      noted: "yesterday",
    });
    const failure = captureRefusedNoteReport(created.id);

    await noteUnfiledDisclosureRun(
      created.id,
      await disclosureRecord(),
      NOTED_AT,
    );

    // What the run driver's append-failure path leaves for a note that could not
    // be written, database refusal and unreadable note alike: the exchange is
    // named for the next visit, and the loss is stated where an unattended run's
    // only account of it goes.
    expect(unfiledExchangeFlagged(created.id)).toBe(true);
    expect(failure).toHaveBeenCalledOnce();
  });
});

describe("filing what the note retained", () => {
  test("the record lands in the accounting and the note goes", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    await noteUnfiledDisclosureRun(created.id, record, NOTED_AT);

    await fileUnfiledDisclosures(created.id);

    expect(await accountingEntries(created.id)).toEqual([record]);
    expect(await readUnfiledDisclosures(created.id)).toEqual({ kind: "none" });
    // The key itself goes, so an exchange that owes nothing holds nothing.
    expect(await rawStored(unfiledDisclosureKey(created.id))).toBeUndefined();
  });

  test("filing a second time cannot double the entry", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    await noteUnfiledDisclosureRun(created.id, record, NOTED_AT);
    await fileUnfiledDisclosures(created.id);

    await noteUnfiledDisclosureRun(created.id, record, NOTED_AT);
    await fileUnfiledDisclosures(created.id);

    // The append matches on the record's own binding nonce, so a run filed twice
    // is one disclosure in the accounting.
    expect(await accountingEntries(created.id)).toEqual([record]);
  });

  test("a run with no record to file stays noted", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    await noteUnfiledDisclosureRun(created.id, record, NOTED_AT);
    await noteUnfiledDisclosureRun(
      created.id,
      undefined,
      "2026-08-01T09:00:00.000Z",
    );

    await fileUnfiledDisclosures(created.id);

    expect(await accountingEntries(created.id)).toEqual([record]);
    // Dropping it would retract a true statement: that run disclosed and this
    // accounting has no entry for it.
    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unfiled",
      disclosures: [{ at: "2026-08-01T09:00:00.000Z" }],
    });
  });

  test("an accounting this build cannot read refuses the filing and keeps the note", async () => {
    const created = await createManagedExchange(newExchange());
    const record = await disclosureRecord();
    await noteUnfiledDisclosureRun(created.id, record, NOTED_AT);
    await putRawStored(created.id, {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [
        {
          ...(await disclosureRecord()),
          version: neighbouringRecordVersion(-1),
        },
      ],
    });

    await expect(fileUnfiledDisclosures(created.id)).rejects.toThrow();

    // The same refusal a run's own append takes, so the note stands until that
    // accounting is recovered.
    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unfiled",
      disclosures: [{ at: record.createdAt, record }],
    });
  });
});

describe("deleting the exchange", () => {
  test("takes the note with it", async () => {
    const created = await createManagedExchange(newExchange());
    await noteUnfiledDisclosureRun(
      created.id,
      await disclosureRecord(),
      NOTED_AT,
    );

    await deleteManagedExchange(created.id);

    // Gone from the store, not merely absent through a validating read: the note
    // retains a run's own record.
    expect(await rawStored(unfiledDisclosureKey(created.id))).toBeUndefined();
    expect(await readUnfiledDisclosures(created.id)).toEqual({ kind: "none" });
  });

  test("takes the fallback flag with it", async () => {
    const created = await createManagedExchange(newExchange());
    expect(await flagUnfiledExchange(created.id)).toBe(true);

    await deleteManagedExchange(created.id);

    // The flag lives outside the delete's transaction, so the delete itself
    // drops it: no caller can leave an id of an exchange this browser no longer
    // holds behind.
    expect(unfiledExchangeFlagged(created.id)).toBe(false);
  });
});

describe("clearing every exchange", () => {
  test("leaves no flag behind", async () => {
    const first = await createManagedExchange(newExchange());
    const second = await createManagedExchange(newExchange());
    expect(await flagUnfiledExchange(first.id)).toBe(true);
    expect(await flagUnfiledExchange(second.id)).toBe(true);

    await clearManagedExchanges();

    expect(unfiledExchangeFlagged(first.id)).toBe(false);
    expect(unfiledExchangeFlagged(second.id)).toBe(false);
  });
});
