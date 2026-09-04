import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

import { sanitizeErrorForDisplay, servePsiWorker } from "@psilink/core";
import type {
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@psilink/core";

import { loadCliPsiBackend } from "./psiBackend";

// --expose-gc cannot be passed through a worker's execArgv (Node rejects it
// with ERR_WORKER_INVALID_EXEC_ARGV), and a parent only exposes gc in its
// workers when launched with --expose-gc itself, so enable it here at runtime
// instead. This backs relievePsiWorkerMemory's per-op collection; what it
// protects: docs/spec/PROTOCOL.md, "The single-pass dataset ceiling: receiver
// memory and masking compute".
// Cast through unknown so `gc` is a plain optional function here rather than
// intersecting with globalThis's own GCFunction typing (which rejects the
// () => void assignment below).
const globalWithGc = globalThis as unknown as { gc?: () => void };
if (typeof globalWithGc.gc !== "function") {
  setFlagsFromString("--expose-gc");
  globalWithGc.gc = runInNewContext("gc") as () => void;
}

// worker_threads entry point for the PSI masking, off the CLI's event-loop-owning
// thread so a multi-minute round does not starve the SFTP heartbeat. Seeded once
// with the participant's role and id via workerData; the secret key is generated
// inside this worker (servePsiWorker's createWithNewKey) and never leaves it.
// Design details: docs/spec/PROTOCOL.md, "The single-pass dataset ceiling:
// receiver memory and masking compute".
async function main(): Promise<void> {
  const port = parentPort;
  if (!port)
    throw new Error("PSI worker started outside a worker_threads worker");
  const init = workerData as PsiWorkerInit;
  const { library } = await loadCliPsiBackend();
  const handle = servePsiWorker(library, init, (response: PsiWorkerResponse) =>
    port.postMessage(response),
  );
  // Messages the host posted while the backend was loading were queued on the port;
  // attaching the listener now drains them in order.
  port.on("message", (request: PsiWorkerRequest) => handle(request));
}

void main().catch((error: unknown) => {
  // The backend failed to load; there is nothing to serve. Report and exit non-zero
  // so the host's Worker 'exit' handler fails the exchange rather than leaving it to
  // hang on a dead worker.
  process.stderr.write(
    `PSI worker failed to start: ${sanitizeErrorForDisplay(error)}\n`,
  );
  process.exit(1);
});
