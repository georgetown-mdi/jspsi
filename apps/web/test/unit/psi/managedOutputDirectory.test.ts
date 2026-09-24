import { afterEach, describe, expect, test, vi } from "vitest";

import {
  chooseManagedOutputDirectory,
  outputDirectoryGrantSupported,
  storedOutputDirectoryUsable,
  writeResultsToOutputDirectory,
} from "@psi/managed/managedOutputDirectory";

import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";

/**
 * The output-folder grant's platform layer: what the grant asks for, what the
 * runtime reports about being able to take one, and how each way a write into the
 * granted folder can go classifies. A real directory handle needs a picker grant
 * no Node project can summon, so the handle here is built to the two platform
 * calls the write makes, and the permission layer is injected for the states an
 * OPFS handle cannot report.
 */

/** The bytes a run's results hold, asserted back out of the fake folder. */
const RESULTS_CSV = "id,county\nA-19,Riverbend\n";

/** A permission layer reporting a fixed state, recording whether it prompted --
 * which an unattended write may never do -- and under which mode it was asked. */
function fakePermission(state: "granted" | "denied" | "prompt") {
  const seam = {
    requested: false,
    modes: [] as Array<string>,
    query: (_handle: FileSystemHandle, mode: string) => {
      seam.modes.push(mode);
      return Promise.resolve(state);
    },
    request: () => {
      seam.requested = true;
      return Promise.resolve(state);
    },
  };
  return seam as typeof seam & HandlePermissionQuery;
}

/** A granted folder built to the calls the write makes: `getFileHandle`, with
 * `create` for the entry it writes and without it to ask whether the folder
 * already holds that name, then one writable the bytes go through, and
 * `removeEntry` for the entry a failed write leaves empty. `failWrite` makes the
 * stream refuse the bytes, as a full disk or a removed folder would; `holding`
 * are the names the folder already has. */
function fakeFolder(failWrite?: Error, holding: Array<string> = []) {
  const written: Array<{ fileName: string; text: string }> = [];
  const aborted: Array<string> = [];
  const opened: Array<{ fileName: string; create: boolean }> = [];
  const names = new Set(holding);
  const handle = {
    name: "Riverbend results",
    getFileHandle: (fileName: string, options?: { create?: boolean }) => {
      const create = options?.create === true;
      opened.push({ fileName, create });
      if (!create && !names.has(fileName))
        return Promise.reject(new Error("this folder holds no such entry"));
      names.add(fileName);
      return Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: async (blob: Blob) => {
              if (failWrite !== undefined) throw failWrite;
              written.push({ fileName, text: await blob.text() });
            },
            close: () => Promise.resolve(),
            abort: () => {
              aborted.push(fileName);
              return Promise.resolve();
            },
          }),
      });
    },
    removeEntry: (fileName: string) =>
      names.delete(fileName)
        ? Promise.resolve()
        : Promise.reject(new Error("this folder holds no such entry")),
  };
  return {
    written,
    aborted,
    opened,
    names,
    handle: handle as unknown as FileSystemDirectoryHandle,
  };
}

/** The refusal Chromium raises while the write lock an aborted stream took is
 * still held, which a removal has to wait out rather than accept. */
function writeLockRefusal(): Error {
  const refusal = new Error("modifications are not allowed here");
  refusal.name = "NoModificationAllowedError";
  return refusal;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whether this runtime can take a folder grant", () => {
  test("says no where there is no directory picker, and yes where there is", () => {
    expect(outputDirectoryGrantSupported()).toBe(false);
    vi.stubGlobal("showDirectoryPicker", () => Promise.resolve({}));
    expect(outputDirectoryGrantSupported()).toBe(true);
  });

  test("holds a stored grant unusable where this engine has no directory handles", () => {
    const { handle } = fakeFolder();
    expect(storedOutputDirectoryUsable(handle)).toBe(false);
    vi.stubGlobal("FileSystemDirectoryHandle", class {});
    expect(storedOutputDirectoryUsable(handle)).toBe(true);
    // Both halves are required, so no grant is no grant either way.
    expect(storedOutputDirectoryUsable(undefined)).toBe(false);
  });
});

describe("asking the operator for a folder", () => {
  test("asks in readwrite, since the run it is taken for writes", async () => {
    const asked: Array<{ mode: string }> = [];
    vi.stubGlobal("showDirectoryPicker", (options: { mode: string }) => {
      asked.push(options);
      return Promise.resolve({ name: "Riverbend results" });
    });
    expect(await chooseManagedOutputDirectory()).toMatchObject({
      name: "Riverbend results",
    });
    expect(asked[0].mode).toBe("readwrite");
  });

  test("yields no handle where the operator dismissed the picker", async () => {
    const dismissed = new Error("the operator closed it");
    dismissed.name = "AbortError";
    vi.stubGlobal("showDirectoryPicker", () => Promise.reject(dismissed));
    expect(await chooseManagedOutputDirectory()).toBeUndefined();
  });

  test("raises any other refusal, which is not the operator declining", async () => {
    vi.stubGlobal("showDirectoryPicker", () =>
      Promise.reject(new Error("no transient activation")),
    );
    await expect(chooseManagedOutputDirectory()).rejects.toThrow(
      "no transient activation",
    );
  });
});

describe("writing a run's results into the granted folder", () => {
  test("writes the file and names where it went", async () => {
    const folder = fakeFolder();
    const permission = fakePermission("granted");
    const delivery = await writeResultsToOutputDirectory(
      folder.handle,
      "alcove-results-2026-03-01.csv",
      new Blob([RESULTS_CSV]),
      permission,
    );

    expect(delivery).toEqual({
      kind: "written",
      fileName: "alcove-results-2026-03-01.csv",
      directoryName: "Riverbend results",
    });
    expect(folder.written).toEqual([
      { fileName: "alcove-results-2026-03-01.csv", text: RESULTS_CSV },
    ]);
    // The entry is opened with `create`, which is what makes a first run's file
    // exist at all.
    expect(folder.opened.at(-1)?.create).toBe(true);
    // The write is queried in readwrite, and never prompted: nobody is present.
    expect(permission.modes).toEqual(["readwrite"]);
    expect(permission.requested).toBe(false);
  });

  test("reports a grant it may not use, without prompting for one", async () => {
    for (const state of ["prompt", "denied"] as const) {
      const folder = fakeFolder();
      const permission = fakePermission(state);
      const delivery = await writeResultsToOutputDirectory(
        folder.handle,
        "alcove-results-2026-03-01.csv",
        new Blob([RESULTS_CSV]),
        permission,
      );

      expect(delivery).toEqual({ kind: "ungranted", state });
      expect(folder.written).toHaveLength(0);
      expect(permission.requested).toBe(false);
    }
  });

  test("reports a write that threw, and leaves no stream open behind it", async () => {
    const folder = fakeFolder(new Error("the disk is full"));
    const delivery = await writeResultsToOutputDirectory(
      folder.handle,
      "alcove-results-2026-03-01.csv",
      new Blob([RESULTS_CSV]),
      fakePermission("granted"),
    );

    expect(delivery.kind).toBe("write-failed");
    expect(folder.written).toHaveLength(0);
    expect(folder.aborted).toEqual(["alcove-results-2026-03-01.csv"]);
  });

  test("removes the empty entry a failed write created", async () => {
    const folder = fakeFolder(new Error("the disk is full"));
    await writeResultsToOutputDirectory(
      folder.handle,
      "alcove-results-2026-03-01.csv",
      new Blob([RESULTS_CSV]),
      fakePermission("granted"),
    );

    expect([...folder.names]).toEqual([]);
  });

  test("asks again when the removal is refused over the write lock", async () => {
    const folder = fakeFolder(new Error("the disk is full"));
    let asked = 0;
    const lockedOnce = {
      name: "Riverbend results",
      getFileHandle: folder.handle.getFileHandle,
      removeEntry: (fileName: string) =>
        asked++ === 0
          ? Promise.reject(writeLockRefusal())
          : folder.handle.removeEntry(fileName),
    } as unknown as FileSystemDirectoryHandle;

    await writeResultsToOutputDirectory(
      lockedOnce,
      "alcove-results-2026-03-01.csv",
      new Blob([RESULTS_CSV]),
      fakePermission("granted"),
    );

    expect(asked).toBe(2);
    expect([...folder.names]).toEqual([]);
  });

  test("gives up on a write lock that never clears", async () => {
    const folder = fakeFolder(new Error("the disk is full"));
    let asked = 0;
    const lockedThroughout = {
      name: "Riverbend results",
      getFileHandle: folder.handle.getFileHandle,
      removeEntry: () => {
        asked++;
        return Promise.reject(writeLockRefusal());
      },
    } as unknown as FileSystemDirectoryHandle;

    await expect(
      writeResultsToOutputDirectory(
        lockedThroughout,
        "alcove-results-2026-03-01.csv",
        new Blob([RESULTS_CSV]),
        fakePermission("granted"),
      ),
    ).resolves.toMatchObject({ kind: "write-failed" });
    // Settling at all is the bound; more than one ask is the retry it bounds.
    expect(asked).toBeGreaterThan(1);
  });

  test("keeps a file the folder already held when the write fails", async () => {
    const folder = fakeFolder(new Error("the disk is full"), [
      "alcove-results-2026-03-01.csv",
      "last-quarter.csv",
    ]);
    await writeResultsToOutputDirectory(
      folder.handle,
      "alcove-results-2026-03-01.csv",
      new Blob([RESULTS_CSV]),
      fakePermission("granted"),
    );

    expect([...folder.names].sort()).toEqual([
      "alcove-results-2026-03-01.csv",
      "last-quarter.csv",
    ]);
  });

  test("never rejects over a folder that will not take the removal", async () => {
    const folder = fakeFolder(new Error("the disk is full"));
    const refusingRemoval = {
      name: "Riverbend results",
      getFileHandle: folder.handle.getFileHandle,
      removeEntry: () => Promise.reject(new Error("the folder is read-only")),
    } as unknown as FileSystemDirectoryHandle;

    await expect(
      writeResultsToOutputDirectory(
        refusingRemoval,
        "alcove-results-2026-03-01.csv",
        new Blob([RESULTS_CSV]),
        fakePermission("granted"),
      ),
    ).resolves.toMatchObject({ kind: "write-failed" });
  });

  test("never rejects: the run it belongs to has already completed", async () => {
    const refusing = {
      name: "Riverbend results",
      getFileHandle: () => Promise.reject(new Error("the folder is gone")),
    } as unknown as FileSystemDirectoryHandle;

    await expect(
      writeResultsToOutputDirectory(
        refusing,
        "alcove-results-2026-03-01.csv",
        new Blob([RESULTS_CSV]),
        fakePermission("granted"),
      ),
    ).resolves.toMatchObject({ kind: "write-failed" });
  });
});
