import { WorkerPsiEngine } from "@psilink/core";

import { errorFromWorkerEvent } from "./workerEventError";

import type {
  PsiEngine,
  PsiWorkerHandle,
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@psilink/core";

/**
 * Off-main-thread PSI crypto for the web app: the CPU-bound elliptic-curve masking
 * a PSI round performs runs in a Web Worker the app owns, so the browser tab stays
 * interactive -- UI paints, timers fire, and the WebRTC peer keepalives keep firing
 * -- while a round masks, instead of freezing for the round's duration (the browser
 * analogue of the CLI's `worker_threads` offload).
 *
 * This is the BROWSER SPAWN ADAPTER for the runtime-agnostic PSI worker seam in
 * `@psilink/core`: core's {@link WorkerPsiEngine} turns each crypto call into a
 * request/response round trip with a worker reached through a {@link PsiWorkerHandle},
 * and core's `servePsiWorker` runs the crypto on the worker side. This module wires
 * a Web Worker into that seam (the CLI wires a `worker_threads` worker into the same
 * seam); {@link psiCrypto.worker} is the worker entry. Only raw bytes, value lists,
 * and index lists cross the boundary -- never a live library handle, and never the
 * secret key, which `servePsiWorker` generates and keeps inside the worker.
 *
 * Kept Node-loadable (it never references the real `Worker` constructor -- that lives
 * in {@link ./psiCryptoWorkerClient}) so its dispatch is unit-testable with a fake
 * worker, exactly as {@link ./csvParseController} is.
 */

/** The slice of the dedicated-`Worker` API the host side drives. The real `Worker`
 * is adapted to it in {@link ./psiCryptoWorkerClient}; a unit test supplies a fake.
 * `onmessage` receives the worker's {@link PsiWorkerResponse} replies; `onerror` and
 * `onmessageerror` surface a worker-level fault (see {@link createPsiCryptoWorkerHandle}). */
export interface PsiCryptoWorker {
  postMessage: (message: PsiWorkerRequest) => void;
  onmessage: ((event: { data: PsiWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate: () => void;
}

/** Spawns a fresh PSI-crypto worker seeded with `init` (its role and id). The seed
 * is passed at construction -- through the Worker's `name`, the browser analogue of
 * the CLI worker's `workerData` (see {@link encodePsiWorkerInit}) -- so the worker's
 * message channel carries only crypto requests. Injected so this module never
 * references the real `Worker` constructor directly (keeping it Node-loadable and the
 * dispatch unit-testable); the browser default is {@link ./psiCryptoWorkerClient}. */
export type SpawnPsiCryptoWorker = (init: PsiWorkerInit) => PsiCryptoWorker;

/**
 * Encode the worker's role/id seed for transport through the Web Worker's `name`.
 * A Web Worker has no `workerData` channel like `worker_threads`, so the seed rides
 * `name` (a string set at construction and readable synchronously as `self.name` at
 * worker startup), which is the browser analogue of the CLI worker's `workerData`:
 * available before the first message, so the worker's message channel carries only
 * crypto requests. Paired with {@link decodePsiWorkerInit}, the worker's side.
 */
export function encodePsiWorkerInit(init: PsiWorkerInit): string {
  return JSON.stringify(init);
}

/** Decode the role/id seed the worker reads from `self.name` (see
 * {@link encodePsiWorkerInit}). Runs in {@link ./psiCrypto.worker}. */
export function decodePsiWorkerInit(name: string): PsiWorkerInit {
  return JSON.parse(name) as PsiWorkerInit;
}

/**
 * The worker-side request router for {@link ./psiCrypto.worker}: buffers incoming
 * crypto requests until an asynchronously-loaded dispatcher is ready, then drains
 * them in order and routes the rest straight through. If the dispatcher fails to load
 * (a WASM-engine load failure), every buffered and subsequent request is answered with
 * a failure reply through `failRequest` -- so the host's pending call fails fast rather
 * than hanging on a worker that will never reply, the browser counterpart of the CLI
 * worker's exit(1)-on-load-failure signal. `startDispatcher` cannot both resolve and
 * reject, so a request is buffered-and-drained XOR failed, never both, and never
 * double-answered.
 *
 * Extracted here (Node-loadable) rather than inlined in the browser-only worker entry
 * so this buffer / drain / fail state machine -- including the load-failure path a real
 * WASM load will not exercise on demand -- is unit-testable with a fake dispatcher,
 * exactly as the host-side {@link createPsiCryptoWorkerHandle} is. `startDispatcher`
 * resolves to the ready request handler; the worker wires it to load the WASM engine
 * and call `servePsiWorker`.
 */
export function createBufferingRequestRouter(
  startDispatcher: () => Promise<(request: PsiWorkerRequest) => void>,
  failRequest: (id: number, error: string) => void,
): (request: PsiWorkerRequest) => void {
  let dispatch: ((request: PsiWorkerRequest) => void) | undefined;
  const buffered: Array<PsiWorkerRequest> = [];
  let loadFailure: string | undefined;
  void startDispatcher().then(
    (ready) => {
      for (const request of buffered) ready(request);
      buffered.length = 0;
      dispatch = ready;
    },
    (error: unknown) => {
      loadFailure = error instanceof Error ? error.message : String(error);
      for (const request of buffered) failRequest(request.id, loadFailure);
      buffered.length = 0;
    },
  );
  return (request: PsiWorkerRequest) => {
    if (loadFailure !== undefined) {
      failRequest(request.id, loadFailure);
      return;
    }
    if (dispatch) dispatch(request);
    else buffered.push(request);
  };
}

/**
 * Wrap a Web Worker as the runtime-agnostic {@link PsiWorkerHandle} a
 * {@link WorkerPsiEngine} drives: post a request, route replies and faults, and
 * terminate. This is the browser counterpart of the CLI's `createWorkerThreadHandle`,
 * and it is deliberately the SINGLE definition of the host-side event wiring --
 * production spawns a real Worker through it and the unit tests wrap a fake through it,
 * so neither re-implements a mirror that can drift.
 *
 * Unlike the CLI's `worker_threads` handle, no exit / self-initiated-teardown guard is
 * needed: a Web Worker's `terminate()` fires no event, so a clean disposal cannot
 * masquerade as a fault. Only a genuine worker fault reaches `onError`: an uncaught
 * error (a module-load failure, or the worker re-signalling a backend-load failure via
 * a per-request error reply -- see {@link ./psiCrypto.worker}) fires `onerror`, and a
 * reply that fails structured-clone deserialization fires `onmessageerror` instead of
 * `onmessage`/`onerror` -- with no handler it is silently dropped and the pending call
 * hangs, so route it to `onError` too. `onmessageerror` is unreachable for today's
 * cloneable replies (byte arrays and index lists), but a boundary hardening mirroring
 * the CLI handle's `messageerror` routing.
 */
export function createPsiCryptoWorkerHandle(
  worker: PsiCryptoWorker,
): PsiWorkerHandle {
  return {
    postMessage: (request: PsiWorkerRequest) => worker.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      worker.onmessage = (event: { data: PsiWorkerResponse }) =>
        onMessage(event.data);
      worker.onerror = (event: unknown) =>
        onError(errorFromWorkerEvent(event, "PSI crypto worker failed"));
      worker.onmessageerror = (event: unknown) =>
        onError(errorFromWorkerEvent(event, "PSI crypto worker failed"));
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Build the {@link RunExchangeOptions.psiEngineFactory} the web exchange passes to
 * core's `runExchange`: given the resolved PSI role and id, spawn a worker (via
 * `spawn`, seeded with that role/id) and return a {@link WorkerPsiEngine} bound to it,
 * so the masking runs off the main thread. `runExchange` disposes the returned engine
 * on every exchange-end path (success, error, abort) through the participant's
 * teardown, and {@link WorkerPsiEngine.dispose} terminates the worker -- so a worker
 * is never leaked past an exchange.
 *
 * `spawn` is injected so a unit test drives the factory with a fake worker; production
 * passes {@link ./psiCryptoWorkerClient.defaultSpawnPsiCryptoWorker}.
 */
export function createBrowserPsiEngineFactory(
  spawn: SpawnPsiCryptoWorker,
): (role: "starter" | "joiner", id: string) => PsiEngine {
  return (role, id) =>
    new WorkerPsiEngine(createPsiCryptoWorkerHandle(spawn({ role, id })));
}
