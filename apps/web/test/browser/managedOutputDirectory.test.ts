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
  persistManagedExchangeOutputDirectory,
} from "@psi/managed/managedExchangeStore";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { runResultsFileName } from "@psi/parkedResults";
import { writeResultsToOutputDirectory } from "@psi/managed/managedOutputDirectory";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

// The platform half of the output-folder grant, exercised against real Chromium:
// a directory handle held on the record across a fresh read of the store (which
// is what a grant surviving a reload rests on), and a real write into a real
// directory. Origin-private-file-system directories stand in for a picker grant:
// they are structured-cloneable and take the same getFileHandle/createWritable
// calls, differing only in the permission extension, which is the injected
// suite's (test/unit/psi/managedOutputDirectory.test.ts).

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

/** The label the results file names are built from here. */
const LABEL = "Riverbend quarterly";

/** This suite's two run instants, a week apart. */
const FIRST_RUN = "2026-03-01T09:00:00.000Z";
const SECOND_RUN = "2026-03-08T09:00:00.000Z";

const OPFS_NAMES: Array<string> = [];

/** An origin-private-file-system directory, tracked for removal. */
async function trackedOpfsDirectory(
  name: string,
): Promise<FileSystemDirectoryHandle> {
  OPFS_NAMES.push(name);
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

/** What a directory holds, by entry name. */
async function entryNames(
  directory: FileSystemDirectoryHandle,
): Promise<Array<string>> {
  const names: Array<string> = [];
  for await (const name of directory.keys()) names.push(name);
  return names.sort();
}

beforeEach(clearManagedExchanges);

afterEach(async () => {
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of OPFS_NAMES.splice(0))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
});

describe("the output-folder grant on the stored record", () => {
  test("is held across a fresh read of the store, which is what survives a reload", async () => {
    const folder = await trackedOpfsDirectory("results-granted");
    const created = await createManagedExchange(
      newExchange({ outputDirectoryHandle: folder }),
    );

    const stored = await getManagedExchange(created.id);
    expect(await stored?.outputDirectoryHandle?.isSameEntry(folder)).toBe(true);
    expect(stored?.outputDirectoryHandle?.name).toBe("results-granted");
  });

  test("re-points to another folder, and a null returns runs to keeping results here", async () => {
    const first = await trackedOpfsDirectory("results-first");
    const created = await createManagedExchange(newExchange());
    expect(created.outputDirectoryHandle).toBeUndefined();

    const granted = await persistManagedExchangeOutputDirectory(
      created.id,
      first,
    );
    expect(await granted.outputDirectoryHandle?.isSameEntry(first)).toBe(true);
    // The grant advanced only itself: the secret and the document stand.
    expect(granted.sharedSecret).toBe(created.sharedSecret);
    expect(granted.exchangeFile).toEqual(created.exchangeFile);

    const second = await trackedOpfsDirectory("results-second");
    await persistManagedExchangeOutputDirectory(created.id, second);
    const repointed = await getManagedExchange(created.id);
    expect(await repointed?.outputDirectoryHandle?.isSameEntry(second)).toBe(
      true,
    );

    await persistManagedExchangeOutputDirectory(created.id, null);
    expect(
      (await getManagedExchange(created.id))?.outputDirectoryHandle,
    ).toBeUndefined();
  });
});

describe("writing a run's results into a real granted folder", () => {
  test("writes the file the run built, readable back out of the folder", async () => {
    const folder = await trackedOpfsDirectory("results-written");
    const csv = "id,county\nA-19,Riverbend\n";

    const delivery = await writeResultsToOutputDirectory(
      folder,
      runResultsFileName(LABEL, FIRST_RUN),
      new Blob([csv], { type: "text/csv" }),
    );

    expect(delivery).toMatchObject({
      kind: "written",
      directoryName: "results-written",
    });
    const written = await folder.getFileHandle(
      runResultsFileName(LABEL, FIRST_RUN),
    );
    expect(await (await written.getFile()).text()).toBe(csv);
  });

  test("leaves successive runs' results beside each other rather than overwriting", async () => {
    const folder = await trackedOpfsDirectory("results-accumulating");
    for (const runAt of [FIRST_RUN, SECOND_RUN])
      await writeResultsToOutputDirectory(
        folder,
        runResultsFileName(LABEL, runAt),
        new Blob([`id\n${runAt}\n`], { type: "text/csv" }),
      );

    expect(await entryNames(folder)).toEqual([
      runResultsFileName(LABEL, FIRST_RUN),
      runResultsFileName(LABEL, SECOND_RUN),
    ]);
  });
});

/**
 * A granted folder whose write refuses the bytes, wrapping a REAL directory: the
 * entry `getFileHandle` creates, the stream it hands back, the abort the failure
 * path takes, and the removal that follows are all Chromium's own, so what the
 * folder is left holding is the platform's answer rather than a fake's. `partial`
 * is written through before the refusal, for the stream that already holds bytes.
 */
function refusingWriteFolder(
  real: FileSystemDirectoryHandle,
  partial?: Blob,
): FileSystemDirectoryHandle {
  return {
    name: real.name,
    getFileHandle: async (
      fileName: string,
      options?: FileSystemGetFileOptions,
    ) => {
      const file = await real.getFileHandle(fileName, options);
      return {
        createWritable: async () => {
          const writable = await file.createWritable();
          return {
            write: async () => {
              if (partial !== undefined) await writable.write(partial);
              throw new Error("the folder refused the bytes");
            },
            close: () => writable.close(),
            abort: () => writable.abort(),
          };
        },
      };
    },
    removeEntry: (name: string, options?: FileSystemRemoveOptions) =>
      real.removeEntry(name, options),
  } as unknown as FileSystemDirectoryHandle;
}

describe("a write into a real granted folder that fails", () => {
  // Chromium creates the entry at getFileHandle, before a byte is written, and
  // aborting the stream discards what the stream held rather than the entry. A
  // failed write would therefore leave an empty results-named file in the
  // operator's folder while the next visit says the results are in the browser.
  test("leaves no empty results file behind, whether or not bytes were written", async () => {
    for (const partial of [undefined, new Blob(["id,county\n"])]) {
      const tag = partial === undefined ? "before-any-byte" : "mid-stream";
      const folder = await trackedOpfsDirectory(`results-failed-${tag}`);

      const delivery = await writeResultsToOutputDirectory(
        refusingWriteFolder(folder, partial),
        runResultsFileName(LABEL, FIRST_RUN),
        new Blob(["id,county\nA-19,Riverbend\n"], { type: "text/csv" }),
      );

      expect(delivery.kind).toBe("write-failed");
      expect(await entryNames(folder)).toEqual([]);
    }
  });

  test("leaves a file the folder already held exactly as it was", async () => {
    const folder = await trackedOpfsDirectory("results-failed-over-existing");
    const fileName = runResultsFileName(LABEL, FIRST_RUN);
    const earlier = "id,county\nA-01,Riverbend\n";
    const standing = await folder.getFileHandle(fileName, { create: true });
    const opening = await standing.createWritable();
    await opening.write(new Blob([earlier]));
    await opening.close();

    const delivery = await writeResultsToOutputDirectory(
      refusingWriteFolder(folder, new Blob(["id,county\n"])),
      fileName,
      new Blob(["id,county\nA-19,Riverbend\n"], { type: "text/csv" }),
    );

    expect(delivery.kind).toBe("write-failed");
    expect(await entryNames(folder)).toEqual([fileName]);
    const kept = await folder.getFileHandle(fileName);
    expect(await (await kept.getFile()).text()).toBe(earlier);
  });
});
