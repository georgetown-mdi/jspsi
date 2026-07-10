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

// The host side of the CLI's PSI worker: it spawns the
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

// The minimal worker_threads Worker surface {@link createWorkerThreadHandle} drives.
// Node's Worker satisfies it structurally; a unit test supplies a fake so the failure
// routing below can be exercised deterministically -- a real 'messageerror' cannot be
// provoked with today's cloneable payloads.
interface WorkerThreadLike {
  on(event: "message", listener: (value: PsiWorkerResponse) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "messageerror", listener: (error: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  postMessage(value: PsiWorkerRequest): void;
  terminate(): unknown;
}

/**
 * Wrap a worker_threads Worker as the runtime-agnostic {@link PsiWorkerHandle} the
 * {@link WorkerPsiEngine} drives. This is the SINGLE definition of the host-side event
 * wiring -- message-reply routing plus the error / messageerror / exit failure paths:
 * the real-worker integration test wraps an actual Worker through it and a unit test
 * wraps a fake, so neither re-implements a mirror that can drift from production (the
 * drift that once let a broken exit handler ship untested).
 */
export function createWorkerThreadHandle(
  worker: WorkerThreadLike,
): PsiWorkerHandle {
  // Set when dispose() drives the teardown, so the worker's own 'exit' event is
  // recognized as the expected stop rather than a crash. terminate() reports a
  // NONZERO exit code (1) for a worker that had started serving -- indistinguishable
  // by code from the startup process.exit(1) in psiWorker.worker.ts -- so the exit
  // code cannot tell a clean disposal from a fault; whether WE asked it to stop can.
  // dispose() has already failed every pending call before terminating, so an
  // expected exit must NOT re-enter onError.
  let terminating = false;
  return {
    postMessage: (request: PsiWorkerRequest) => worker.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      worker.on("message", (response: PsiWorkerResponse) =>
        onMessage(response),
      );
      worker.on("error", (error) => onError(error));
      // A message that fails structured-clone deserialization surfaces as
      // 'messageerror', NOT 'error'; with no listener it is silently dropped and the
      // pending call would hang. Route it to onError so the call fails fast. Not
      // reachable with today's cloneable payloads (byte arrays and index lists), but
      // a boundary hardening against a future non-cloneable reply.
      worker.on("messageerror", (error) => onError(error));
      worker.on("exit", (code) => {
        // A worker that exits on its own -- a failed startup or a crash -- must fail
        // the exchange rather than let it hang on a dead worker. A terminate()'d
        // worker also exits nonzero, so an exit is a fault only when we did not
        // initiate it; an expected teardown is one dispose() has already settled.
        if (!terminating)
          onError(new Error(`PSI worker exited with code ${code}`));
      });
    },
    terminate: () => {
      terminating = true;
      void worker.terminate();
    },
  };
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
  // must stay alive, exactly as the synchronous masking kept it. dispose() (driven by
  // the exchange's teardown finally) calls terminate(), which is what releases the
  // process at the end -- so a ref'd worker handle never outlives the exchange.
  return new WorkerPsiEngine(createWorkerThreadHandle(worker));
}
