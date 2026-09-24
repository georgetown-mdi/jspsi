/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { acquireManagedInput } from "@psi/managed/managedInputHandle";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import type { CSVParseRows } from "@psi/workers/csvParseController";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

// What a run reads through a persisted input-file handle after the file at the
// agreed path is replaced, exercised against real Chromium: the three ways an
// export job, an editor, or a sync client refreshes a file -- overwrite in
// place, write a temporary file and rename it over the name, delete the file
// and create a new one -- plus the archive-then-drop variant that moves the
// current file away first.
//
// Constraint: the handle source measured is the origin private file system,
// whose handles are structured-cloneable and take the same
// getFile/createWritable calls as a picked one. It stands in for the production
// case -- a handle the operator picked from the local filesystem -- which no
// headless run can obtain, since the file picker needs a person. The permission
// extension an OPFS handle does not implement is the injected suite's
// (managedInputHandle.test.ts, "permission layer").

const INPUT_NAME = "replace-methods-input.csv";
const STAGED_NAME = "replace-methods-input.csv.part";
const ARCHIVED_NAME = "replace-methods-input-prior-period.csv";

const HEADER = "ssn,first_name,last_name,date_of_birth\n";
const FIRST_PERIOD = HEADER + "111111111,ADA,LOVELACE,01/01/1990\n";
const SECOND_PERIOD =
  HEADER +
  "222222222,GRACE,HOPPER,12/09/1906\n" +
  "333333333,KATHERINE,JOHNSON,08/26/1918\n";

const FIRST_PERIOD_ROWS = [
  {
    ssn: "111111111",
    first_name: "ADA",
    last_name: "LOVELACE",
    date_of_birth: "01/01/1990",
  },
];
const SECOND_PERIOD_ROWS = [
  {
    ssn: "222222222",
    first_name: "GRACE",
    last_name: "HOPPER",
    date_of_birth: "12/09/1906",
  },
  {
    ssn: "333333333",
    first_name: "KATHERINE",
    last_name: "JOHNSON",
    date_of_birth: "08/26/1918",
  },
];

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const linkageTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inferMetadata(["ssn", "first_name", "last_name", "date_of_birth"], []),
);

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

/** `FileSystemFileHandle.move` is a Chromium extension the DOM lib does not
 * type. It is what a rename over an existing name takes here, and its absence
 * fails the rename cases rather than skipping them. */
type MovableFileHandle = FileSystemFileHandle & {
  move: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

function movable(handle: FileSystemFileHandle): MovableFileHandle {
  const candidate = handle as MovableFileHandle;
  expect(typeof candidate.move).toBe("function");
  return candidate;
}

const OPFS_NAMES = new Set<string>();

/** Register a name for the teardown sweep, whether this case writes the file
 * there or renames one over it. */
function trackOpfsName(name: string): string {
  OPFS_NAMES.add(name);
  return name;
}

async function writeOpfsFile(
  name: string,
  content: string,
): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(trackOpfsName(name), {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return handle;
}

/** The handle a run actually follows: written onto a managed record and read
 * back out of the store, so every case below measures a handle that has been
 * through the record's structured-clone round trip rather than the one the
 * deposit held in memory. */
async function persistedInputHandle(
  handle: FileSystemFileHandle,
): Promise<FileSystemFileHandle> {
  const created = await createManagedExchange(
    newExchange({ inputFileHandle: handle }),
  );
  const stored = await getManagedExchange(created.id);
  const persisted = stored?.inputFileHandle;
  if (persisted === undefined) throw new Error("no handle was persisted");
  return persisted;
}

/** One run's read through the persisted pointer: the bytes that run received
 * and the rows it parsed out of them. */
async function runTimeRead(
  handle: FileSystemFileHandle,
): Promise<{ text: string; rows: CSVParseRows }> {
  const acquired = await acquireManagedInput({
    kind: "handle",
    handle,
    attendance: "unattended",
  });
  return { text: await acquired.file.text(), rows: acquired.rows };
}

async function firstPeriodRun(): Promise<FileSystemFileHandle> {
  const handle = await persistedInputHandle(
    await writeOpfsFile(INPUT_NAME, FIRST_PERIOD),
  );
  const first = await runTimeRead(handle);
  expect(first.text).toBe(FIRST_PERIOD);
  expect(first.rows).toEqual(FIRST_PERIOD_ROWS);
  return handle;
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of OPFS_NAMES) {
    try {
      await root.removeEntry(name);
    } catch {
      // Already gone: a case that moved or removed the entry itself.
    }
  }
  OPFS_NAMES.clear();
});

describe("overwrite in place", () => {
  test("the next run reads the new period", async () => {
    const persisted = await firstPeriodRun();

    const root = await navigator.storage.getDirectory();
    const atPath = await root.getFileHandle(INPUT_NAME);
    const writable = await atPath.createWritable();
    await writable.write(SECOND_PERIOD);
    await writable.close();

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
    expect(await persisted.isSameEntry(atPath)).toBe(true);
  });
});

describe("write a temporary file and rename it over the name", () => {
  test("the next run reads the new period", async () => {
    const persisted = await firstPeriodRun();

    const root = await navigator.storage.getDirectory();
    const staged = await writeOpfsFile(STAGED_NAME, SECOND_PERIOD);
    await movable(staged).move(root, INPUT_NAME);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
    expect(
      await persisted.isSameEntry(await root.getFileHandle(INPUT_NAME)),
    ).toBe(true);
    await expect(root.getFileHandle(STAGED_NAME)).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

describe("delete the file and create a new one", () => {
  test("the next run reads the new period", async () => {
    const persisted = await firstPeriodRun();

    const root = await navigator.storage.getDirectory();
    await root.removeEntry(INPUT_NAME);
    await writeOpfsFile(INPUT_NAME, SECOND_PERIOD);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
  });

  test("a run between the delete and the create fails the read", async () => {
    const persisted = await firstPeriodRun();

    const root = await navigator.storage.getDirectory();
    await root.removeEntry(INPUT_NAME);

    const error: unknown = await acquireManagedInput({
      kind: "handle",
      handle: persisted,
      attendance: "unattended",
    }).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
    expect((error as ManagedInputError).cause).toBeInstanceOf(DOMException);
    expect((error as ManagedInputError).cause).toMatchObject({
      name: "NotFoundError",
    });
  });
});

describe("move the current file away, then write the new period", () => {
  test("the next run reads the new period", async () => {
    const persisted = await firstPeriodRun();

    const root = await navigator.storage.getDirectory();
    const atPath = await root.getFileHandle(INPUT_NAME);
    await movable(atPath).move(root, trackOpfsName(ARCHIVED_NAME));
    await writeOpfsFile(INPUT_NAME, SECOND_PERIOD);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
    const archived = await root.getFileHandle(ARCHIVED_NAME);
    expect(await (await archived.getFile()).text()).toBe(FIRST_PERIOD);
    expect(await persisted.isSameEntry(archived)).toBe(false);
  });
});

describe("a File kept from the previous run", () => {
  test("does not read the new period", async () => {
    const persisted = await firstPeriodRun();
    const retained = await persisted.getFile();

    const root = await navigator.storage.getDirectory();
    const writable = await (
      await root.getFileHandle(INPUT_NAME)
    ).createWritable();
    await writable.write(SECOND_PERIOD);
    await writable.close();

    await expect(retained.text()).rejects.toMatchObject({
      name: "NotReadableError",
    });
    expect((await runTimeRead(persisted)).text).toBe(SECOND_PERIOD);
  });
});
