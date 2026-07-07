import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import {
  InProcessPsiEngine,
  WorkerPsiEngine,
  type PsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// The host side of the CLI's PSI worker (board item 208035324): it spawns the
// worker_threads worker that runs the masking off the event-loop-owning thread and
// exposes it as a PsiEngine, so a long round no longer starves the SFTP heartbeat or
// the liveness timers. Wired through RunExchangeOptions.psiEngineFactory in
// protocol.ts.

// The bundled worker entry (dist/psiWorker.worker.js) sits beside this module in the
// built CJS bundle, so __dirname resolves it there. When running from src under the
// test runner -- where no compiled .js sits beside the source -- or wherever it
// cannot be found, this yields undefined and the caller falls back to the in-process
// engine, so behavior is unchanged in dev and tests while the shipped CLI (which
// always emits the bundle) always off-threads. The try/catch also covers a context
// where __dirname is not defined at all.
function resolveWorkerEntry(): string | undefined {
  try {
    const entry = path.join(__dirname, "psiWorker.worker.js");
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the PSI crypto engine for a CLI exchange. When the bundled worker entry is
 * present (the shipped CLI), the masking runs in a worker_threads worker off the
 * event-loop-owning thread; otherwise it falls back to the in-process engine (dev,
 * tests). `library` backs only that fallback -- the worker loads its own backend.
 */
export function createPsiEngine(
  library: PSILibrary,
  role: "starter" | "joiner",
  id: string,
): PsiEngine {
  const entry = resolveWorkerEntry();
  if (entry !== undefined) return spawnWorkerPsiEngine(entry, role, id);
  return new InProcessPsiEngine(library, role, id);
}

function spawnWorkerPsiEngine(
  entry: string,
  role: "starter" | "joiner",
  id: string,
): WorkerPsiEngine {
  // The worker exposes gc() for the single-pass memory relief itself, at startup
  // (see psiWorker.worker.ts): --expose-gc cannot be passed through a worker's
  // execArgv (Node rejects it), so nothing gc-related is set here.
  const worker = new Worker(entry, { workerData: { role, id } });
  // The worker is deliberately NOT unref'd: while crypto is in flight the process
  // must stay alive, exactly as the synchronous masking kept it. dispose() (driven
  // by the exchange's teardown finally) calls terminate(), which is what releases
  // the process at the end -- so a ref'd worker handle never outlives the exchange.
  const handle: PsiWorkerHandle = {
    postMessage: (request: PsiWorkerRequest) => worker.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      worker.on("message", (response: PsiWorkerResponse) =>
        onMessage(response),
      );
      worker.on("error", (error) => onError(error));
      worker.on("exit", (code) => {
        // Exit 0 follows a clean terminate(); any other code is a crash or a failed
        // startup, which must fail the exchange rather than let it hang on a dead
        // worker.
        if (code !== 0)
          onError(new Error(`PSI worker exited with code ${code}`));
      });
    },
    terminate: () => {
      void worker.terminate();
    },
  };
  return new WorkerPsiEngine(handle);
}
