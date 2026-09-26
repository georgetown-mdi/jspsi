import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  InternalConsistencyError,
  isNamedDiagnosis,
  markNamedDiagnosis,
} from "../errors";
import {
  InProcessPsiEngine,
  type InProcessPsiEngineOptions,
  type PsiEngine,
  type PsiEngineMode,
  type PsiProcessedElementsReporter,
} from "./psiEngine";
import type { PSIParticipant } from "./participant";

// The runtime-agnostic PSI worker boundary. It moves the
// blocking elliptic-curve masking off the thread that owns the network transport
// and the event loop, so a long masking call no longer starves keepalives, timers,
// or (in the browser) the UI. The host side ({@link WorkerPsiEngine}) is a
// {@link PsiEngine} that turns each crypto call into a request/response round trip
// with a worker; the worker side ({@link servePsiWorker}) runs an
// {@link InProcessPsiEngine} and answers those requests. Both are agnostic to the
// worker technology -- the CLI wires a `worker_threads` Worker and the browser a
// Web Worker behind the same {@link PsiWorkerHandle}. Everything that crosses the
// boundary is raw bytes, value lists, index lists, or a count (never a live library
// handle and never the secret key, which is generated and stays inside the worker),
// so the same message protocol serves both structured-clone transports.

// The role an engine is built for. Named through the participant config field
// that holds it rather than through the Config interface itself, which the
// package entry does not re-export: a declaration naming Config leaves the built
// index.d.ts referencing a type a consumer cannot import.
type PsiWorkerRole = PSIParticipant["config"]["role"];

/**
 * Seed the worker with once, before any request: the role, id, and mode an engine
 * needs.
 */
export interface PsiWorkerInit {
  role: PsiWorkerRole;
  id: string;
  /**
   * The disclosure the worker's engine is built for. It seeds the key the worker
   * generates, so it is fixed for the worker's life exactly as it is for an
   * in-process engine's -- and stated rather than defaulted, so a spawn site that
   * omits it cannot run a revealing round under count-only terms.
   */
  mode: PsiEngineMode;
}

/**
 * A host -> worker request body, one variant per {@link PsiEngine} method. The
 * enclosing {@link PsiWorkerRequest} adds the correlation id.
 */
type PsiWorkerRequestBody =
  | { method: "createServerSetup"; values: ReadonlyArray<string> }
  | { method: "processClientRequest"; requestBytes: Uint8Array }
  | { method: "createClientRequest"; values: ReadonlyArray<string> }
  | { method: "receiveServerSetup"; setupBytes: Uint8Array }
  | { method: "computeAssociationTable"; responseBytes: Uint8Array }
  | { method: "computeIntersectionCardinality"; responseBytes: Uint8Array };

/** A host -> worker request: a {@link PsiWorkerRequestBody} tagged with an id. */
export interface PsiWorkerRequest {
  id: number;
  body: PsiWorkerRequestBody;
}

/**
 * A worker -> host reply, correlated to a request by its id. The variant with
 * neither `ok` nor `error` is a mid-operation progress tick: two integers and
 * nothing else, posted while the request it names is still running, so no
 * element, value, or index reaches the host ahead of the operation's result.
 */
export type PsiWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; processed: number }
  | {
      id: number;
      ok: false;
      error: string;
      /**
       * Whether the engine raised this failure itself, its message stating
       * the condition it refused on. Only the message crosses the boundary,
       * so the host cannot read that off the error it rebuilds; carried here
       * instead, it lets the rebuilt error keep the marker the PSI frame
       * boundary reads before it re-labels a failure as a decode fault (see
       * `markNamedDiagnosis`, `errors.ts`). Absent on a reply posted by a
       * worker entry point that never reached the engine.
       */
      namedDiagnosis?: boolean;
    };

/**
 * The narrow, runtime-agnostic view {@link WorkerPsiEngine} needs of a spawned
 * worker: post a request, register the reply / error listeners, and terminate.
 * The CLI implements it over a `worker_threads` Worker, the browser over a Web
 * Worker; a test implements it in-process. Kept minimal by design so the two
 * worker APIs (`postMessage` + `on("message")` vs `postMessage` + `onmessage`)
 * collapse to one shape here and nothing above forks on runtime.
 *
 * `onError` reports the worker's own death -- an exit code, an uncaught worker
 * error, a reply that failed structured-clone delivery. Its message becomes the
 * top line the operator is shown, so an implementation composes it from fixed
 * literals and local values only, never from a value the partner chose. It takes
 * an `Error` rather than `unknown`, so a received string or object cannot be
 * handed over as a fault and stand as that top line on its own.
 */
export interface PsiWorkerHandle {
  postMessage(request: PsiWorkerRequest): void;
  setHandlers(handlers: {
    onMessage: (response: PsiWorkerResponse) => void;
    onError: (error: Error) => void;
  }): void;
  terminate(): void;
}

const DISPOSED_MESSAGE = "PSI worker engine is disposed";

// Every failure the host side raises itself, as against one the worker's engine
// raised: a disposed engine, a caller breaking the lockstep invariant, and the
// crash cause a worker death fails the pending calls with. Each is a fault on
// this party's own machine, so its own message stands as the top line rather
// than the frame boundary above re-labeling it a decode failure
// (decodePsiBinaryFrame, psi/psiBinaryFrame.ts). Routing every one through this
// function keeps a raise site from being added untagged.
function localWorkerFault(error: Error): Error {
  return markNamedDiagnosis(error);
}

/**
 * A {@link PsiEngine} that runs the crypto in a worker reached through `handle`.
 *
 * Requests are correlated by a monotonically increasing id. The PSI exchange is
 * strictly lockstep -- each round awaits the partner's reply before the next crypto
 * call -- so at most one request is ever in flight; the id map exists to route the
 * reply and to fail every outstanding call at once on worker death or
 * {@link dispose}. That invariant is enforced, not merely assumed: {@link call}
 * rejects a second request while one is still in flight rather than letting two
 * replies race the id map. A worker crash / early exit is reported through
 * `onError` as a terminal rejection rather than a hang, and marks the engine
 * terminal so every later call fails fast with the crash cause instead of
 * posting to a dead worker; {@link dispose} rejects anything pending and
 * terminates the worker so a ref'd worker handle can never hold the process
 * open at teardown.
 */
export class WorkerPsiEngine implements PsiEngine {
  private readonly handle: PsiWorkerHandle;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private disposed = false;
  private terminalError: Error | undefined;
  private onProcessed: PsiProcessedElementsReporter | undefined;

  constructor(handle: PsiWorkerHandle) {
    this.handle = handle;
    handle.setHandlers({
      onMessage: (response) => this.onResponse(response),
      onError: (error) => this.failAll(error),
    });
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  private onResponse(response: PsiWorkerResponse): void {
    const entry = this.pending.get(response.id);
    // A reply with no pending entry (a late reply after dispose, or a duplicate)
    // is ignored: dispose already rejected it, so there is nothing to settle.
    if (entry === undefined) return;
    // A progress tick leaves the call outstanding: it reports how far the
    // operation has got, not that it settled.
    if (!("ok" in response)) {
      this.onProcessed?.(response.processed);
      return;
    }
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(rebuildWorkerFailure(response));
  }

  // Both call sites hand over an Error -- the handle's onError is typed for one
  // -- so the coercion is a safety check for a JavaScript caller that ignores
  // the type. It keeps the original as `cause` rather than letting String()
  // stand alone, which reduces most non-Error values to "[object Object]".
  private failAll(error: unknown): void {
    const err = localWorkerFault(
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error }),
    );
    this.terminalError ??= err;
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  private call<T>(body: PsiWorkerRequestBody): Promise<T> {
    if (this.disposed)
      return Promise.reject(
        localWorkerFault(new InternalConsistencyError(DISPOSED_MESSAGE)),
      );
    // A worker crash left the engine terminal: fail fast with the crash cause
    // rather than posting to a dead worker and hanging.
    if (this.terminalError) return Promise.reject(this.terminalError);
    // Enforce the strictly-lockstep invariant instead of only asserting it in the
    // class doc: a second request while one is still in flight is a caller bug, so
    // reject it rather than letting two replies race the single id map.
    if (this.pending.size > 0)
      return Promise.reject(
        localWorkerFault(
          new InternalConsistencyError(
            "PSI worker engine received a concurrent request; the exchange must be strictly lockstep",
          ),
        ),
      );
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

  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number> {
    return this.call({
      method: "computeIntersectionCardinality",
      responseBytes,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error(DISPOSED_MESSAGE));
    this.handle.terminate();
  }
}

/**
 * The worker-side dispatcher: builds an {@link InProcessPsiEngine} from `library`
 * in `init`'s mode (so the secret key -- and with it the round's disclosure -- is
 * generated and lives entirely inside the worker) and returns a handler that
 * answers each {@link PsiWorkerRequest} by calling the matching
 * engine method and posting the result -- or the error message -- back through
 * `post`. An operation over a set large enough to split also posts a
 * processed-count tick between chunks, which reaches the host while the
 * worker's thread is still inside the crypto. The worker's thread runs the
 * blocking crypto; the host's stays responsive. The CLI / browser worker entry
 * point loads the appropriate backend, calls this once, and routes its message
 * events into the returned handler.
 */
export function servePsiWorker(
  library: PSILibrary,
  init: PsiWorkerInit,
  post: (response: PsiWorkerResponse) => void,
  /** @internal Settings only a test varies; see {@link InProcessPsiEngineOptions}. */
  options: InProcessPsiEngineOptions = {},
): (request: PsiWorkerRequest) => void {
  const engine = new InProcessPsiEngine(
    library,
    init.role,
    init.id,
    init.mode,
    options,
  );
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
      case "computeIntersectionCardinality":
        return engine.computeIntersectionCardinality(body.responseBytes);
    }
  };
  return (request: PsiWorkerRequest): void => {
    // Bind the engine's processed-count sink to the request now starting, so a
    // tick carries the id of the call it belongs to. The worker's thread is
    // inside the crypto when it posts, which is exactly when the host, whose
    // own thread is free, needs it.
    engine.observeProcessedElements((processed) =>
      post({ id: request.id, processed }),
    );
    // run() may throw synchronously (an engine role guard) or reject; either way it
    // becomes a `{ ok: false }` reply, never an unhandled rejection in the worker.
    void Promise.resolve()
      .then(() => run(request.body))
      .then(
        (result) => {
          post({ id: request.id, ok: true, result });
          // Relieves the per-element JS<->native marshalling churn this op left
          // on the worker's heap (the dominant term in the single-pass
          // receiver's peak, per frameSize.ts) -- the worker-side counterpart
          // to relieveTransientMemory (link.ts), since that churn no longer
          // reaches the host. A no-op unless the worker was launched with
          // --expose-gc (the CLI does); called once per op here, never per
          // element.
          relievePsiWorkerMemory();
        },
        (error: unknown) =>
          post({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            namedDiagnosis: isNamedDiagnosis(error),
          }),
      );
  };
}

// Rebuilds a failed reply into the error the host raises. Only the message
// crosses the boundary, so a refusal the engine named itself is re-marked
// here from the reply's own flag -- otherwise the PSI frame boundary above
// would re-label it as a decode fault on every worker-backed run.
function rebuildWorkerFailure(response: {
  error: string;
  namedDiagnosis?: boolean;
}): Error {
  const failure = new Error(response.error);
  return response.namedDiagnosis === true
    ? markNamedDiagnosis(failure)
    : failure;
}

// Worker-side sibling of relieveTransientMemory (link.ts): force a collection of the
// transient marshalling garbage a completed crypto op leaves on the worker heap. A
// no-op unless the runtime exposes a global gc (the CLI launches its PSI worker with
// --expose-gc; a browser Web Worker never exposes gc, exactly as the browser main
// thread does not today).
function relievePsiWorkerMemory(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}
