import { loadCSVFile } from "@psilink/core";

/**
 * Off-main-thread CSV parse for the web app: a browser File above a size threshold
 * is parsed in a Web Worker the app owns, so the parse itself (the dominant CPU:
 * tokenizing, splitting, and building the row objects) runs off the main thread and
 * the tab stays interactive WHILE a large intake -- the once-per-exchange invite or
 * accept file -- parses. It is not fully non-blocking: the worker posts the parsed
 * rows back, and receiving them costs the main thread a structured-clone
 * deserialization of the row array proportional to the result size (uninterruptible,
 * on message receipt). So this reduces the intake stall to that hand-off rather than
 * removing it -- the parse-time freeze is gone, a shorter receive-time cost remains.
 * Streaming the reply in chunks (the open question #202522668 left) would spread that
 * cost into smaller stalls but not lower its total. Everything else -- a small File,
 * or the Node readable stream the unit tests feed generateInvitation -- parses
 * inline, where a worker's spawn and structured-clone hand-off buy nothing.
 *
 * The worker WRAPS core's {@link loadCSVFile} rather than reimplementing the parse
 * (see {@link ./csvParse.worker}), so the non-string-header guard and the
 * `data`/`meta.fields` result contract hold identically whether the parse runs on
 * this thread or in the worker. This is the Vite-native replacement for PapaParse's
 * `worker: true` self-hosted worker, which #307 removed because it corrupts the
 * parse once Vite bundles and minifies the app (see the `worker: false` rationale in
 * core's `file.ts`): a worker Vite bundles from `new Worker(new URL(...))` survives a
 * production `vite build`; one PapaParse constructs from the running script's URL
 * does not.
 */

/** The input {@link loadCSVFile} accepts (a browser `File`, or a Node readable
 * stream in tests). Derived from its signature rather than importing papaparse's
 * `LocalFile`, so this module takes on no papaparse dependency of its own -- the same
 * derivation `invitation.ts` uses. */
export type CSVParseInput = Parameters<typeof loadCSVFile>[0];

/** The result {@link loadCSVFile} resolves -- `data` plus `meta.fields`. Derived
 * from its return type for the same no-papaparse-import reason. */
export type CSVParseResult = Awaited<ReturnType<typeof loadCSVFile>>;

/**
 * Byte size above which a browser File's parse moves to the worker. Below it the
 * inline parse is quick enough not to drop a frame, and the worker's spawn plus the
 * structured-clone hand-off would cost more than it saves. The trade-off above it is
 * not all upside: the worker path removes the parse CPU from the main thread but adds
 * a serialize-in-worker plus deserialize-on-main round-trip of the whole row set (and
 * a transient second copy of it in memory during transfer) that the inline path never
 * pays, so for mid-sized files the net main-thread saving is smaller than the raw
 * parse cost and could even be marginal. The 4 MiB line is a reasoned default, not a
 * measured optimum: it is sized for the modern-workstation execution target and
 * tunable as that profile is measured, the same way `MAX_CSV_FILE_BYTES` and the
 * nonEmptyAggregate thresholds are; it sits well below the 100 MB intake cap the
 * worst-case parse this offloads is bounded by.
 */
export const CSV_WORKER_FILE_BYTE_THRESHOLD = 4 * 1024 * 1024;

/** Worker request: parse this File, bounding a single logical line at `byteCeiling`
 * (undefined lets core apply its own default). A File is the only input the worker
 * takes -- it is structured-cloneable and read via FileReader in the worker, which a
 * Node stream is not. */
export interface CSVParseRequest {
  file: File;
  byteCeiling: number | undefined;
}

/** Worker response: the parse result, or a serialized error (message plus name, so
 * it survives structured clone and rebuilds into an Error the consumer can display
 * and the tests can match on). */
export type CSVParseResponse =
  | { ok: true; result: CSVParseResult }
  | { ok: false; message: string; name: string };

/** The slice of the `Worker` API the off-thread parse drives. The real `Worker` is
 * adapted to it in {@link ./csvParseWorkerClient}; a unit test supplies a fake. */
export interface CSVParseWorker {
  postMessage: (message: CSVParseRequest) => void;
  onmessage: ((event: { data: CSVParseResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate: () => void;
}

/** Spawns a fresh CSV-parse worker. Injected so this module never references the
 * real `Worker` constructor directly (keeping it Node-loadable and the dispatch
 * unit-testable); the browser default is imported lazily -- see
 * {@link loadCSVFileOffMainThread}. */
export type SpawnCSVParseWorker = () => CSVParseWorker;

/** Whether `file` is a browser File -- the only input a worker can take
 * (structured-cloneable, and read via FileReader in the worker); a Node stream is
 * not. Guards the `File` reference so it never throws where `File` is undefined (an
 * older runtime or SSR). */
function isBrowserFile(file: CSVParseInput): file is File {
  return typeof File !== "undefined" && file instanceof File;
}

/**
 * Whether `file` should be parsed off the main thread: a browser File larger than
 * {@link CSV_WORKER_FILE_BYTE_THRESHOLD}, with `Worker` available (absent under Node
 * and SSR). A Node stream or a small File returns false and is parsed inline.
 */
export function shouldParseOffThread(file: CSVParseInput): boolean {
  return (
    typeof Worker !== "undefined" &&
    isBrowserFile(file) &&
    file.size > CSV_WORKER_FILE_BYTE_THRESHOLD
  );
}

/**
 * Parse `file` off the main thread when it is a large browser File, inline
 * otherwise. Resolves the same {@link CSVParseResult} either way -- a drop-in for
 * core's `loadCSVFile` at the web intake call sites.
 *
 * `spawnWorker` is injected only by the unit tests (to drive the dispatch with a
 * fake); production omits it, and the browser worker module is imported lazily so
 * this module stays Node-loadable -- `invitation.ts`, which calls this, is unit-
 * tested under Node with a readable stream (the inline path, which never reaches the
 * import).
 *
 * `signal` tears the worker down if the caller aborts mid-parse (a component
 * unmount), so a discarded parse does not keep a worker running; a caller that never
 * unmounts mid-parse (the inviter flows) simply omits it.
 */
export async function loadCSVFileOffMainThread(
  file: CSVParseInput,
  options: {
    byteCeiling?: number;
    spawnWorker?: SpawnCSVParseWorker;
    signal?: AbortSignal;
  } = {},
): Promise<CSVParseResult> {
  const { byteCeiling, spawnWorker, signal } = options;
  // Off-thread only for a browser File: a large one (the routing predicate) or any
  // File when a test injects a spawner to force the worker path. A Node stream is not
  // structured-cloneable, so it -- and a small File -- parses inline. loadCSVFile
  // applies its own byteCeiling default when this one is undefined. The isBrowserFile
  // guard narrows `file` to File for parseInWorker, so no unchecked cast is needed.
  if (
    isBrowserFile(file) &&
    (spawnWorker !== undefined || shouldParseOffThread(file))
  ) {
    const spawn =
      spawnWorker ??
      (await import("./csvParseWorkerClient")).defaultSpawnCSVParseWorker;
    return parseInWorker(spawn(), file, byteCeiling, signal);
  }
  return loadCSVFile(file, byteCeiling);
}

/**
 * Drive one parse through `worker` and settle. The worker is one-shot: it is torn
 * down on the FIRST outcome -- a result, a worker-level failure (a module-load error,
 * a non-cloneable message) surfaced through `onerror`, an undeserializable reply
 * surfaced through `onmessageerror`, a synchronous `postMessage` failure, or a caller
 * abort -- so nothing lingers past the single parse and a caller never hangs on a
 * worker that cannot answer. A `settled` guard makes every later event a no-op, so a
 * second outcome cannot double-settle or re-terminate.
 */
function parseInWorker(
  worker: CSVParseWorker,
  file: File,
  byteCeiling: number | undefined,
  signal: AbortSignal | undefined,
): Promise<CSVParseResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      finish();
    };

    // Abort before we even post (an already-aborted signal, e.g. a torn-down caller):
    // terminate the just-spawned worker and reject without posting.
    if (signal?.aborted) {
      settle(() => reject(abortError()));
      return;
    }
    // The abort listener is left attached rather than removed on settle: the `settled`
    // guard already makes a late abort a no-op, and the signal is a per-parse
    // controller the caller discards, so the inert listener costs nothing.
    signal?.addEventListener("abort", () => settle(() => reject(abortError())));

    worker.onmessage = (event) => {
      const response = event.data;
      settle(() =>
        response.ok
          ? resolve(response.result)
          : reject(rebuildWorkerError(response)),
      );
    };
    worker.onerror = (event) => settle(() => reject(workerFailure(event)));
    // A reply that fails to deserialize on this thread fires onmessageerror, not
    // onmessage/onerror; without a handler the promise would hang. Unreachable for the
    // current all-primitive reply shape (an all-string CSVRow tree), but wired so the
    // one-shot's never-hang guarantee holds if a future reply ever gains an
    // uncloneable field.
    worker.onmessageerror = () =>
      settle(() =>
        reject(new Error("CSV parse worker reply could not be deserialized")),
      );

    try {
      worker.postMessage({ file, byteCeiling });
    } catch (error) {
      // A synchronous structured-clone failure never reaches onmessage/onerror, so
      // tear the worker down here rather than leak it.
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
}

/** The rejection a caller-signalled abort produces. A named Error (not a
 * `DOMException`) so it is portable to the Node dispatch tests; no consumer inspects
 * it as a DOMException -- FileAcquire, the only caller that passes a signal, swallows
 * it via its own `aborted` check. */
function abortError(): Error {
  const error = new Error("CSV parse aborted");
  error.name = "AbortError";
  return error;
}

/** Rebuild an Error from the worker's serialized failure, so the consumer's
 * sanitize/display path and the tests' message matchers see an ordinary Error. */
function rebuildWorkerError(response: {
  message: string;
  name: string;
}): Error {
  const error = new Error(response.message);
  error.name = response.name;
  return error;
}

/** Turn a worker `onerror` event into an Error. The event is a browser ErrorEvent
 * whose `message` names the fault; fall back to a fixed message when it carries
 * none. */
function workerFailure(event: unknown): Error {
  const message =
    typeof event === "object" &&
    event !== null &&
    typeof (event as { message?: unknown }).message === "string"
      ? (event as { message: string }).message
      : "CSV parse worker failed";
  return new Error(message);
}
