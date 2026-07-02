import { loadCSVFile } from "@psilink/core";

import type { CSVParseRequest, CSVParseResponse } from "./csvParseController";

/**
 * The off-main-thread CSV parse. It receives a browser File, runs core's
 * {@link loadCSVFile} on it -- so the non-string-header guard and the
 * `data`/`meta.fields` contract hold exactly as on the main thread -- and STREAMS the
 * result back to the controller as a sequence of row batches followed by a terminal
 * `done` message carrying the errors/meta (or a single serialized error if the parse
 * fails). Batching the reply lets the main thread deserialize it in many small,
 * interruptible steps instead of one clone of the whole row array; see
 * {@link CSVParseResponse}. Bundled by Vite from {@link ./csvParseWorkerClient}; it
 * pulls in only core's parse, nothing DOM.
 */

// Worker globals are not in the app's DOM lib; narrow `globalThis` to the two
// dedicated-worker affordances this entry uses rather than pulling the WebWorker lib
// into the whole program (which would clash with DOM on `self`/`postMessage`).
interface WorkerScope {
  onmessage: ((event: { data: CSVParseRequest }) => void) | null;
  postMessage: (message: CSVParseResponse) => void;
}
const scope = globalThis as unknown as WorkerScope;

/**
 * Target source-CSV bytes per streamed reply batch. The worker turns this into a row
 * count per batch from the file's average bytes-per-row, so each posted batch carries
 * roughly this many of the file's bytes regardless of row width -- a handful of wide
 * rows batch as tightly as many narrow ones, bounding the per-message structured-clone
 * the main thread pays either way rather than a fixed row count a very wide row could
 * blow past. A reasoned, tunable default sized for the modern-workstation target (like
 * CSV_WORKER_FILE_BYTE_THRESHOLD), not a measured optimum: small enough that one batch's
 * deserialization does not itself stall a frame, large enough that a near-cap intake is
 * not split into a wasteful flood of tiny posts.
 */
const CSV_WORKER_REPLY_BATCH_BYTES = 1024 * 1024;

/**
 * Rows per streamed batch for a `rowCount`-row parse of a `fileBytes`-byte File: the
 * count whose source bytes are about {@link CSV_WORKER_REPLY_BATCH_BYTES}. At least 1
 * whenever there are rows, so the batch loop always advances (a 0 would spin); the
 * value is irrelevant when there are no rows, where the loop never runs.
 */
function replyBatchRows(rowCount: number, fileBytes: number): number {
  if (rowCount === 0) return 1;
  const bytesPerRow = Math.max(fileBytes, 1) / rowCount;
  return Math.max(1, Math.floor(CSV_WORKER_REPLY_BATCH_BYTES / bytesPerRow));
}

async function parseAndReply(
  file: File,
  byteCeiling: number | undefined,
): Promise<void> {
  try {
    // loadCSVFile applies its own byteCeiling default when this is undefined. It runs
    // to completion here -- including the non-string-header guard -- BEFORE any batch is
    // posted, so a parse failure throws into the catch below and posts the serialized
    // error as the only message, exactly as the single-post hand-off did.
    const result = await loadCSVFile(file, byteCeiling);
    // Stream the rows back in batches so the main thread deserializes the reply in many
    // small, interruptible steps rather than one clone of the whole array. loadCSVFile
    // stays the parse boundary; only its already-complete result is chunked for transit.
    const batchRows = replyBatchRows(result.data.length, file.size);
    for (let i = 0; i < result.data.length; i += batchRows) {
      scope.postMessage({
        ok: true,
        done: false,
        rows: result.data.slice(i, i + batchRows),
      });
    }
    // Terminal message: the errors/meta the controller pairs with the accumulated rows
    // to rebuild the full result. Sent even for an empty parse (no batches), so the
    // controller always settles.
    scope.postMessage({
      ok: true,
      done: true,
      errors: result.errors,
      meta: result.meta,
    });
  } catch (error) {
    // Serialize the rejection so it survives structured clone: the controller
    // rebuilds an Error from message + name. Every core parse rejection is a plain
    // Error (a read/stream error, the single-line ceiling trip, the non-string-header
    // guard), so nothing richer than message + name is lost.
    scope.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    });
  }
}

scope.onmessage = (event) => {
  const { file, byteCeiling } = event.data;
  void parseAndReply(file, byteCeiling);
};
