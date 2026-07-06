import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { InProcessPsiEngine, type PsiEngine } from "./psiEngine";
import type { Config } from "./types";

// The runtime-agnostic PSI worker seam (board item 208035324). It moves the
// blocking elliptic-curve masking off the thread that owns the network transport
// and the event loop, so a long masking call no longer starves keepalives, timers,
// or (in the browser) the UI. The host side ({@link WorkerPsiEngine}) is a
// {@link PsiEngine} that turns each crypto call into a request/response round trip
// with a worker; the worker side ({@link servePsiWorker}) runs an
// {@link InProcessPsiEngine} and answers those requests. Both are agnostic to the
// worker technology -- the CLI wires a `worker_threads` Worker and the browser a
// Web Worker behind the same {@link PsiWorkerHandle}. Everything that crosses the
// boundary is raw bytes, value lists, or index lists (never a live library handle
// and never the secret key, which is generated and stays inside the worker), so the
// same message protocol serves both structured-clone transports.

/** Seed the worker with once, before any request: the role and id an engine needs. */
export interface PsiWorkerInit {
  role: Config["role"];
  id: string;
}

/**
 * A host -> worker request body, one variant per {@link PsiEngine} method. The
 * enclosing {@link PsiWorkerRequest} adds the correlation id.
 */
export type PsiWorkerRequestBody =
  | { method: "createServerSetup"; values: ReadonlyArray<string> }
  | { method: "processClientRequest"; requestBytes: Uint8Array }
  | { method: "createClientRequest"; values: ReadonlyArray<string> }
  | { method: "receiveServerSetup"; setupBytes: Uint8Array }
  | { method: "computeAssociationTable"; responseBytes: Uint8Array };

/** A host -> worker request: a {@link PsiWorkerRequestBody} tagged with an id. */
export interface PsiWorkerRequest {
  id: number;
  body: PsiWorkerRequestBody;
}

/** A worker -> host reply, correlated to a request by its id. */
export type PsiWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/**
 * The narrow, runtime-agnostic view {@link WorkerPsiEngine} needs of a spawned
 * worker: post a request, register the reply / error listeners, and terminate. The
 * CLI implements it over a `worker_threads` Worker, the browser over a Web Worker;
 * a test implements it in-process. Kept deliberately minimal so the two worker APIs
 * (`postMessage` + `on("message")` vs `postMessage` + `onmessage`) collapse to one
 * shape here and nothing above forks on runtime.
 */
export interface PsiWorkerHandle {
  postMessage(request: PsiWorkerRequest): void;
  setHandlers(handlers: {
    onMessage: (response: PsiWorkerResponse) => void;
    onError: (error: unknown) => void;
  }): void;
  terminate(): void;
}

/**
 * A {@link PsiEngine} that runs the crypto in a worker reached through `handle`.
 *
 * Requests are correlated by a monotonically increasing id. The PSI exchange is
 * strictly lockstep -- each round awaits the partner's reply before the next crypto
 * call -- so at most one request is ever in flight; the id map exists to route the
 * reply and to fail every outstanding call at once on worker death or
 * {@link dispose}. A worker crash / early exit surfaces through `onError` as a
 * terminal rejection rather than a hang, and {@link dispose} rejects anything
 * pending and terminates the worker so a ref'd worker handle can never hold the
 * process open at teardown.
 */
export class WorkerPsiEngine implements PsiEngine {
  private readonly handle: PsiWorkerHandle;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private disposed = false;

  constructor(handle: PsiWorkerHandle) {
    this.handle = handle;
    handle.setHandlers({
      onMessage: (response) => this.onResponse(response),
      onError: (error) => this.failAll(error),
    });
  }

  private onResponse(response: PsiWorkerResponse): void {
    const entry = this.pending.get(response.id);
    // A reply with no pending entry (a late reply after dispose, or a duplicate)
    // is ignored: dispose already rejected it, so there is nothing to settle.
    if (entry === undefined) return;
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error));
  }

  private failAll(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  private call<T>(body: PsiWorkerRequestBody): Promise<T> {
    if (this.disposed)
      return Promise.reject(new Error("PSI worker engine is disposed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.handle.postMessage({ id, body });
    });
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    return this.call({ method: "createServerSetup", values });
  }

  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    return this.call({ method: "processClientRequest", requestBytes });
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    return this.call({ method: "createClientRequest", values });
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.call({ method: "receiveServerSetup", setupBytes });
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    return this.call({ method: "computeAssociationTable", responseBytes });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("PSI worker engine is disposed"));
    this.handle.terminate();
  }
}

/**
 * The worker-side dispatcher: builds an {@link InProcessPsiEngine} from `library`
 * (so the secret key is generated and lives entirely inside the worker) and returns
 * a handler that answers each {@link PsiWorkerRequest} by calling the matching
 * engine method and posting the result -- or the error message -- back through
 * `post`. The worker's thread runs the blocking crypto; the host's stays
 * responsive. The CLI / browser worker entry point loads the appropriate backend,
 * calls this once, and routes its message events into the returned handler.
 */
export function servePsiWorker(
  library: PSILibrary,
  init: PsiWorkerInit,
  post: (response: PsiWorkerResponse) => void,
): (request: PsiWorkerRequest) => void {
  const engine = new InProcessPsiEngine(library, init.role, init.id);
  const run = (body: PsiWorkerRequestBody): Promise<unknown> => {
    switch (body.method) {
      case "createServerSetup":
        return engine.createServerSetup(body.values);
      case "processClientRequest":
        return engine.processClientRequest(body.requestBytes);
      case "createClientRequest":
        return engine.createClientRequest(body.values);
      case "receiveServerSetup":
        return engine.receiveServerSetup(body.setupBytes);
      case "computeAssociationTable":
        return engine.computeAssociationTable(body.responseBytes);
    }
  };
  return (request: PsiWorkerRequest): void => {
    // run() may throw synchronously (an engine role guard) or reject; either way it
    // becomes a `{ ok: false }` reply, never an unhandled rejection in the worker.
    void Promise.resolve()
      .then(() => run(request.body))
      .then(
        (result) => post({ id: request.id, ok: true, result }),
        (error: unknown) =>
          post({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  };
}
