/**
 * The input-file handle lifecycle for a managed (recurring) exchange: the platform
 * layer the save flow, the runner, and the future management surfaces call to
 * persist a live pointer to the operator's input file, read the input through it at
 * each run start, check and request read permission where the platform offers it,
 * detect platform support, and re-point (replace) the handle. It is the pointer
 * side of the no-second-copy invariant: the record holds a `FileSystemFileHandle`,
 * never file content, and every run reads through the handle with `getFile()` at
 * run start rather than retaining a `File` across runs, so dropping the current
 * period's extract over the same name is the data-refresh workflow (see
 * docs/MANAGED_EXCHANGE.md, "The input file each run", and
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `inputFileHandle` row).
 *
 * The pure column-shape guard and the input-rejection classification are in
 * {@link ./managedInputGuard.ts}; this module composes them with the platform reads
 * so a run-start acquisition failure (missing file, gone permission, no handle
 * where one is required) or a column-shape rejection each surfaces as the same
 * benign {@link ManagedInputError}, before any connection, on every run path.
 *
 * The permission layer is a non-standard File System Access extension
 * (`queryPermission` / `requestPermission`) the DOM lib does not type and some
 * handle sources (a picker handle) offer while others (an origin-private-file-
 * system handle) do not. It is reached through {@link browserHandleReadPermission},
 * which feature-detects the methods and treats their absence as an already-usable
 * grant, so a handle without the extension reads through without prompting -- and
 * the {@link HandleReadPermissionQuery} seam stays injectable for tests that cannot
 * summon a real picker grant.
 */

import {
  ManagedInputError,
  assessManagedInputColumns,
} from "./managedInputGuard";
import { loadCSVFileOffMainThread } from "./csvParseController";

import type { ExchangeSpec } from "@psilink/core";

/**
 * Whether the File System Access API's file handles exist in this runtime, so a
 * managed exchange can persist a live pointer to the operator's input file
 * (Chromium) rather than re-selecting it each attended run (Safari, Firefox). A
 * `false` here is what routes the save flow to persist no handle and the runner to
 * re-selection; it never throws, so it is safe under SSR and on older engines.
 */
export function fileSystemAccessSupported(): boolean {
  return typeof globalThis.FileSystemFileHandle !== "undefined";
}

/** A selected file that MAY carry a File System Access handle. The bench's file
 * intake (Mantine's Dropzone over `file-selector`) attaches a `handle` to a
 * dropped file in a secure context on Chromium, so a managed deposit can capture
 * the operator's existing selection without a second picker dialog; every other
 * selection path (a click-to-open input, a browser without the API) yields a plain
 * `File` and no handle. Declared locally because the DOM `File` lib does not type
 * the `file-selector` extension. */
interface FileWithOptionalHandle {
  handle?: FileSystemFileHandle;
}

/**
 * Read the File System Access handle a drop attached to `file`, or `undefined`
 * when the selection path did not yield one. On Chromium in a secure context,
 * `file-selector` (under the bench's Dropzone) calls
 * `DataTransferItem.getAsFileSystemHandle()` on a drop and attaches the handle to
 * the `File`; a click-to-open selection and a browser without the API leave it
 * absent. The presence of the handle is also gated on
 * {@link fileSystemAccessSupported}, so a foreign object carrying a `handle`
 * property on a runtime without the API is not mistaken for a real handle. This is
 * the capture-at-deposit seam: no extra dialog is shown to obtain a handle the
 * operator's existing selection already carries, and no handle is persisted when
 * the selection cannot yield one (the record field is optional).
 */
export function capturedInputHandle(
  file: File,
): FileSystemFileHandle | undefined {
  if (!fileSystemAccessSupported()) return undefined;
  const handle = (file as File & FileWithOptionalHandle).handle;
  return handle instanceof FileSystemFileHandle ? handle : undefined;
}

/**
 * The read-permission state a handle reports: `"granted"` reads through without a
 * prompt, `"denied"` cannot be read, and `"prompt"` needs an operator gesture to
 * grant. Mirrors the `PermissionState` the File System Access permission methods
 * return. A handle whose source does not implement the permission extension is
 * treated as `"granted"` -- there is no separate permission to hold, so the read is
 * governed only by whether the file still exists.
 */
export type HandleReadPermissionState = "granted" | "denied" | "prompt";

/** The `queryPermission` / `requestPermission` extension a File System Access
 * handle MAY carry (a picker handle does; an origin-private-file-system handle does
 * not). Declared locally because the DOM lib does not type these non-standard
 * methods; a handle is narrowed to it by {@link handleReadPermission} through a
 * runtime feature check rather than an unchecked cast. */
interface FileSystemHandlePermission {
  queryPermission?: (descriptor: {
    mode: "read" | "readwrite";
  }) => Promise<HandleReadPermissionState>;
  requestPermission?: (descriptor: {
    mode: "read" | "readwrite";
  }) => Promise<HandleReadPermissionState>;
}

/** The one operation the permission layer performs, factored into a seam so a run
 * path can query without prompting (the unattended path) or request with a gesture
 * (the attended path), and so a test can inject a permission outcome a real
 * origin-private-file-system handle cannot report (it implements neither method).
 * The default is {@link browserHandleReadPermission}, the feature-detecting
 * platform implementation. */
export interface HandleReadPermissionQuery {
  /** Report the handle's current read-permission state WITHOUT prompting -- the
   * only check the unattended path may make, since a scheduled run has no operator
   * to answer a prompt. */
  query: (handle: FileSystemFileHandle) => Promise<HandleReadPermissionState>;
  /** Prompt for read permission where the state is `"prompt"`, returning the state
   * after the operator answers. Called only on an attended path (a gesture is
   * present). */
  request: (handle: FileSystemFileHandle) => Promise<HandleReadPermissionState>;
}

/**
 * The platform permission layer: feature-detects the handle's non-standard
 * `queryPermission` / `requestPermission` methods and, when they are absent (an
 * origin-private-file-system handle, a runtime without the extension), reports
 * `"granted"` -- there is no separate read permission to hold, so the read is
 * governed only by whether the file still exists. Never prompts on `query`; prompts
 * on `request` only where the method exists.
 */
export const browserHandleReadPermission: HandleReadPermissionQuery = {
  query: (handle) => {
    const permission = handle as unknown as FileSystemHandlePermission;
    if (permission.queryPermission === undefined)
      return Promise.resolve("granted");
    return permission.queryPermission({ mode: "read" });
  },
  request: (handle) => {
    const permission = handle as unknown as FileSystemHandlePermission;
    if (permission.requestPermission === undefined)
      return Promise.resolve("granted");
    return permission.requestPermission({ mode: "read" });
  },
};

/** Raised when a handle is held but its read permission cannot be secured for a
 * run: the unattended path found a non-`"granted"` state (it must not prompt), or
 * an attended request was denied. Carried as the `cause` of the benign
 * {@link ManagedInputError} `"acquire"` rejection, so a gone permission records the
 * same benign `"input"` failure as a missing file, never desync/attack framing. */
export class HandleReadPermissionError extends Error {
  /** The permission state that blocked the read. */
  readonly state: HandleReadPermissionState;
  constructor(state: HandleReadPermissionState) {
    super(`managed exchange input handle read permission is ${state}`);
    this.name = "HandleReadPermissionError";
    this.state = state;
  }
}

/** How a run acquires its input-file read permission: an unattended (scheduled)
 * run may only proceed on an EXISTING grant and must never prompt; an attended run
 * may request the grant with the operator's gesture. */
export type ManagedRunAttendance = "unattended" | "attended";

/**
 * Secure read permission for `handle` for a run of the given `attendance`, or throw
 * {@link HandleReadPermissionError}. The unattended path queries only: a
 * non-`"granted"` state throws, because a scheduled run has no operator to answer a
 * prompt (the spec's "the unattended path can only proceed on an existing grant --
 * it must not prompt"). The attended path may additionally request where the state
 * is `"prompt"`, so a one-action re-run is at most one permission gesture.
 */
export async function ensureHandleReadPermission(
  handle: FileSystemFileHandle,
  attendance: ManagedRunAttendance,
  permission: HandleReadPermissionQuery = browserHandleReadPermission,
): Promise<void> {
  const current = await permission.query(handle);
  if (current === "granted") return;
  // A scheduled run has nobody present to answer a prompt, so it proceeds only on
  // an already-granted permission and fails benignly on any other state.
  if (attendance === "unattended") throw new HandleReadPermissionError(current);
  if (current === "denied") throw new HandleReadPermissionError("denied");
  const afterPrompt = await permission.request(handle);
  if (afterPrompt !== "granted")
    throw new HandleReadPermissionError(afterPrompt);
}

/** A read input for one run: the `File` read through the handle at run start (never
 * retained across runs) and its CSV column names, the two the column-shape guard
 * and the exchange consume. */
export interface AcquiredManagedInput {
  /** The `File` read through the handle at THIS run start (a point-in-time
   * reference; never persisted or retained across runs). */
  file: File;
  /** The read file's CSV column names, for the column-shape guard and the
   * exchange. */
  columns: Array<string>;
}

/** How a run supplies its input file, per platform and path. `handle` reads through
 * a persisted `FileSystemFileHandle` (the unattended and one-action paths, and a
 * re-point); `file` takes an operator-selected `File` directly (the re-selection
 * path on a browser without the API). Exactly one is set. */
export type ManagedInputSource =
  | {
      /** Read through a persisted handle at run start (`getFile()` per run). */
      kind: "handle";
      handle: FileSystemFileHandle;
      /** The run's attendance, gating whether a gone permission may be re-prompted
       * (attended) or must fail benignly (unattended). */
      attendance: ManagedRunAttendance;
    }
  | {
      /** An operator-selected file on a browser without the API (re-selection). */
      kind: "file";
      file: File;
    };

/**
 * Read a run's input through its source and parse its column names, throwing a
 * benign {@link ManagedInputError} `"acquire"` rejection on any failure BEFORE the
 * column guard or any connection: a missing entry (the file deleted, moved, or
 * renamed away, so `getFile()` rejects), a gone or refused read permission, or an
 * unreadable file. The `File` is read at THIS run start and never retained across
 * runs. On the handle path, permission is secured first (queried for an unattended
 * run, requestable for an attended one).
 *
 * @throws {ManagedInputError} an `"acquire"` rejection carrying the underlying
 *   error, so the runner records the benign `"input"` failure and knows no
 *   connection was attempted.
 */
export async function acquireManagedInput(
  source: ManagedInputSource,
  permission: HandleReadPermissionQuery = browserHandleReadPermission,
): Promise<AcquiredManagedInput> {
  let file: File;
  try {
    if (source.kind === "handle") {
      await ensureHandleReadPermission(
        source.handle,
        source.attendance,
        permission,
      );
      // getFile() reads whatever file currently exists at the handle's path -- a
      // missing entry rejects here, the clean not-found the benign input state
      // rests on. The File is this run's point-in-time reference; it is never
      // retained past the run.
      file = await source.handle.getFile();
    } else {
      file = source.file;
    }
  } catch (cause) {
    throw new ManagedInputError({ reason: "acquire", cause });
  }

  let columns: Array<string>;
  try {
    const parsed = await loadCSVFileOffMainThread(file);
    columns = parsed.meta.fields ?? [];
  } catch (cause) {
    throw new ManagedInputError({ reason: "acquire", cause });
  }
  return { file, columns };
}

/**
 * Acquire and validate a run's input against the record's standing terms in one
 * step, the guard every run path applies before any connection. Reads the input
 * through {@link acquireManagedInput} (missing file, gone permission, and
 * unreadable file all surface as a benign `"acquire"` rejection), then rejects an
 * input whose columns cannot satisfy the standing terms' column shape as a benign
 * `"columns"` rejection ({@link assessManagedInputColumns}) -- never silently
 * linked, never routed through desync/attack framing. Returns the read `File` and
 * its columns when the input is accepted, for the runner to feed the exchange.
 *
 * @throws {ManagedInputError} an `"acquire"` or `"columns"` rejection, both benign
 *   `"input"`-kind failures detected before any connection.
 */
export async function acquireValidatedManagedInput(
  exchangeFile: ExchangeSpec,
  source: ManagedInputSource,
  permission: HandleReadPermissionQuery = browserHandleReadPermission,
): Promise<AcquiredManagedInput> {
  const acquired = await acquireManagedInput(source, permission);
  const rejection = assessManagedInputColumns(exchangeFile, acquired.columns);
  if (rejection !== undefined) throw new ManagedInputError(rejection);
  return acquired;
}
