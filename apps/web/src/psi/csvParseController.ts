import { loadCSVFile } from "@psilink/core";

/**
 * Off-main-thread CSV parse for the web app: a browser File above a size threshold
 * is parsed in a Web Worker the app owns, so a large intake (the once-per-exchange
 * invite or accept parse) does not block input or painting while it parses.
 * Everything else -- a small File, or the Node readable stream the unit tests feed
 * generateInvitation -- parses inline, where a worker's spawn and structured-clone
 * hand-off buy nothing.
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
 * structured-clone hand-off (the File in, the parsed rows back) would cost more than
 * it saves. Sized for the modern-workstation execution target and tunable as that
 * profile is measured, the same way `MAX_CSV_FILE_BYTES` and the nonEmptyAggregate
 * thresholds are; it sits well below the 100 MB intake cap the worst-case parse this
 * offloads is bounded by.
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
  terminate: () => void;
}

/** Spawns a fresh CSV-parse worker. Injected so this module never references the
 * real `Worker` constructor directly (keeping it Node-loadable and the dispatch
 * unit-testable); the browser default is imported lazily -- see
 * {@link loadCSVFileOffMainThread}. */
export type SpawnCSVParseWorker = () => CSVParseWorker;

/**
 * Whether `file` should be parsed off the main thread: a browser File (the only
 * cloneable, FileReader-readable input) larger than
 * {@link CSV_WORKER_FILE_BYTE_THRESHOLD}, with `Worker` available (absent under Node
 * and SSR). A Node stream or a small File returns false and is parsed inline.
 */
export function shouldParseOffThread(file: CSVParseInput): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof File !== "undefined" &&
    file instanceof File &&
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
 */
export async function loadCSVFileOffMainThread(
  file: CSVParseInput,
  options: {
    byteCeiling?: number;
    spawnWorker?: SpawnCSVParseWorker;
  } = {},
): Promise<CSVParseResult> {
  const { byteCeiling, spawnWorker } = options;
  // Inline unless a worker is warranted (or a test injected one). loadCSVFile
  // applies its own byteCeiling default when this one is undefined.
  if (spawnWorker === undefined && !shouldParseOffThread(file))
    return loadCSVFile(file, byteCeiling);
  const spawn =
    spawnWorker ??
    (await import("./csvParseWorkerClient")).defaultSpawnCSVParseWorker;
  return parseInWorker(spawn(), file as File, byteCeiling);
}

/**
 * Drive one parse through `worker` and settle. The worker is one-shot: it is
 * terminated as soon as it answers (or errors), so nothing lingers past the single
 * parse. A worker-level failure (a module-load error, a non-cloneable message)
 * surfaces through `onerror` and rejects, so a caller never hangs on a worker that
 * cannot answer.
 */
function parseInWorker(
  worker: CSVParseWorker,
  file: File,
  byteCeiling: number | undefined,
): Promise<CSVParseResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      worker.terminate();
      const response = event.data;
      if (response.ok) resolve(response.result);
      else reject(rebuildWorkerError(response));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(workerFailure(event));
    };
    worker.postMessage({ file, byteCeiling });
  });
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
