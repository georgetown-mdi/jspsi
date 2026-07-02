import { loadCSVFile } from "@psilink/core";

import type { CSVParseRequest, CSVParseResponse } from "./csvParseController";

/**
 * The off-main-thread CSV parse. It receives a browser File, runs core's
 * {@link loadCSVFile} on it -- so the non-string-header guard and the
 * `data`/`meta.fields` contract hold exactly as on the main thread -- and posts the
 * result (or a serialized error) back for the controller. Bundled by Vite from
 * {@link ./csvParseWorkerClient}; it pulls in only core's parse, nothing DOM.
 */

// Worker globals are not in the app's DOM lib; narrow `globalThis` to the two
// dedicated-worker affordances this entry uses rather than pulling the WebWorker lib
// into the whole program (which would clash with DOM on `self`/`postMessage`).
interface WorkerScope {
  onmessage: ((event: { data: CSVParseRequest }) => void) | null;
  postMessage: (message: CSVParseResponse) => void;
}
const scope = globalThis as unknown as WorkerScope;

async function parseAndReply(
  file: File,
  byteCeiling: number | undefined,
): Promise<void> {
  try {
    // loadCSVFile applies its own byteCeiling default when this is undefined.
    const result = await loadCSVFile(file, byteCeiling);
    scope.postMessage({ ok: true, result });
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
