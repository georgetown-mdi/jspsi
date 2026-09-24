/**
 * The output-folder grant a scheduled run delivers its results into: the platform
 * layer that asks the operator for a folder, reports whether this runtime can
 * offer that at all, and writes one run's results CSV into a granted folder with
 * nobody present.
 *
 * The grant is taken at SCHEDULE ENTRY and re-taken by re-pointing, never at run
 * time: `showDirectoryPicker` needs a user gesture, and a scheduled run has
 * nobody to make one. At run time the permission is queried and never prompted,
 * through the same {@link ./managedInputHandle.ts} permission layer the input
 * handle uses, in `readwrite` mode.
 *
 * Delivery is total: every outcome classifies rather than throwing
 * ({@link ResultsDelivery}), because the run it belongs to has already rotated
 * its secret and filed its disclosure. A grant this platform will not honour with
 * nobody present, and a write the folder refuses, each name themselves so the
 * caller parks the results instead (see {@link ./managedScheduleRuntime.ts}).
 *
 * What the record holds is the handle, never a path: the folder is named to the
 * operator by the handle's own `name`, which is the leaf the picker returned.
 */

import {
  HandlePermissionError,
  ensureHandlePermission,
} from "./managedInputHandle";

import type {
  HandlePermissionQuery,
  HandlePermissionState,
} from "./managedInputHandle";

/** The directory picker the File System Access API offers, which the DOM lib does
 * not type. Declared locally, and reached only behind
 * {@link outputDirectoryGrantSupported}'s runtime feature check. */
interface DirectoryPicker {
  showDirectoryPicker?: (options: {
    mode: "read" | "readwrite";
    id?: string;
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/** The picker's `id`, so the browser reopens this app's folder grant where the
 * operator last took it rather than at an unrelated default. */
const OUTPUT_DIRECTORY_PICKER_ID = "alcove-results";

/**
 * Whether this runtime can take an output-folder grant at all: the directory
 * picker exists. A `false` is what routes the schedule-entry surface to state
 * that this browser offers no folder grant, so every scheduled run's results are
 * kept in the browser instead. Never throws, so it is safe under SSR and on older
 * engines.
 */
export function outputDirectoryGrantSupported(): boolean {
  return (
    typeof (globalThis as DirectoryPicker).showDirectoryPicker === "function"
  );
}

/**
 * Whether a record's stored output-folder grant can be followed in this runtime:
 * a handle is held AND this engine has directory handles to follow it with. Both
 * halves are required, so the run path and the schedule surface decide it
 * identically.
 */
export function storedOutputDirectoryUsable(
  handle: FileSystemDirectoryHandle | undefined,
): boolean {
  return (
    handle !== undefined &&
    typeof globalThis.FileSystemDirectoryHandle !== "undefined"
  );
}

/**
 * Ask the operator for the folder a scheduled run writes its results into, in
 * `readwrite` mode so the grant covers the write the run will make. Resolves
 * `undefined` where the operator dismissed the picker, which is not a failure.
 *
 * MUST be called from a user gesture: the picker refuses otherwise, which is the
 * whole reason the grant is taken at schedule entry rather than at run time.
 *
 * @throws if this runtime has no directory picker, or the picker refused for any
 *   reason other than the operator dismissing it.
 */
export async function chooseManagedOutputDirectory(): Promise<
  FileSystemDirectoryHandle | undefined
> {
  const picker = (globalThis as DirectoryPicker).showDirectoryPicker;
  if (picker === undefined)
    throw new Error("this browser has no directory picker");
  try {
    return await picker({
      mode: "readwrite",
      id: OUTPUT_DIRECTORY_PICKER_ID,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return undefined;
    throw error;
  }
}

/** How delivering one run's results into the granted folder turned out. Every
 * outcome is a value: the run is already complete, so nothing here may reject. */
export type ResultsDelivery =
  /** The results are in the folder, under `fileName`. */
  | { kind: "written"; fileName: string; directoryName: string }
  /** The grant is not one this run may use with nobody present -- revoked, or a
   * state only an operator gesture could raise to `"granted"`. Nothing was
   * written, and nothing was prompted. */
  | { kind: "ungranted"; state: HandlePermissionState }
  /** The folder was granted and the write did not land: the entry could not be
   * created, or the stream refused the bytes. */
  | { kind: "write-failed"; error: unknown };

/** Whether the folder already holds an entry under this name, so a failed write
 * removes only an entry that write created itself. */
async function entryHeldAlready(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  return directory.getFileHandle(fileName).then(
    () => true,
    () => false,
  );
}

/**
 * How long the removal keeps asking while the platform still holds the write lock
 * the aborted stream took; Chromium releases it a task turn after `abort()`
 * resolves. Measured worst case for the lock to clear: 13.4 ms after the first
 * refusal, over 2400 failed writes under load; 200 ms is about fifteen times that.
 * Measurement and method: docs/notes/output-directory-removal-lock.md.
 */
const REMOVAL_LOCK_BUDGET_MS = 200;

/** Whether a removal was refused because the write lock is still held, rather
 * than for a reason waiting cannot clear. */
function removalBlockedByLock(error: unknown): boolean {
  return error instanceof Error && error.name === "NoModificationAllowedError";
}

/** Drop the entry a failed write created, best-effort: a folder that refuses the
 * removal leaves the empty file behind, which a completed run may not fail over.
 * A refusal naming the lock is asked again until {@link REMOVAL_LOCK_BUDGET_MS}
 * is spent, since that lock outlives the abort that released the stream. */
async function dropCreatedEntry(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  let deadline: number | undefined;
  for (;;) {
    try {
      await directory.removeEntry(fileName);
      return;
    } catch (error) {
      if (!removalBlockedByLock(error)) return;
      deadline ??= Date.now() + REMOVAL_LOCK_BUDGET_MS;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Write one run's results CSV into the granted folder, under a name that holds
 * the exchange's label and the run's own instant so successive runs accumulate
 * rather than overwrite ({@link ../parkedResults.ts}, `runResultsFileName`).
 *
 * The permission is QUERIED in `readwrite` and never prompted: this runs with
 * nobody present. `permission` is the injectable permission layer, defaulting to
 * the platform's.
 *
 * A write that fails leaves the folder as it found it: the platform creates the
 * entry before any byte reaches it, so the empty file is removed rather than left
 * standing for results the caller then keeps in the browser.
 */
export async function writeResultsToOutputDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  csv: Blob,
  permission?: HandlePermissionQuery,
): Promise<ResultsDelivery> {
  try {
    await ensureHandlePermission(
      directory,
      "unattended",
      "readwrite",
      permission,
    );
  } catch (error) {
    return {
      kind: "ungranted",
      state: error instanceof HandlePermissionError ? error.state : "denied",
    };
  }
  let writable: FileSystemWritableFileStream | undefined;
  let heldAlready = true;
  try {
    heldAlready = await entryHeldAlready(directory, fileName);
    const file = await directory.getFileHandle(fileName, { create: true });
    writable = await file.createWritable();
    await writable.write(csv);
    await writable.close();
    return { kind: "written", fileName, directoryName: directory.name };
  } catch (error) {
    // Aborting releases the stream a failed write left open; a stream that never
    // closes commits nothing. What it does not undo is the entry `getFileHandle`
    // created, which the removal takes -- and only when this write created it, so
    // a file the folder already held is never the one dropped.
    if (writable !== undefined) await writable.abort().catch(() => undefined);
    if (!heldAlready) await dropCreatedEntry(directory, fileName);
    return { kind: "write-failed", error };
  }
}
