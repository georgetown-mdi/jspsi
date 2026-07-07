import { describe, expect, test, vi } from "vitest";

import {
  createBrowserPsiEngineFactory,
  createBufferingRequestRouter,
  createPsiCryptoWorkerHandle,
  decodePsiWorkerInit,
  encodePsiWorkerInit,
} from "../../src/psi/psiCryptoController.js";

import type {
  PsiEngine,
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@psilink/core";

import type {
  PsiCryptoWorker,
  SpawnPsiCryptoWorker,
} from "../../src/psi/psiCryptoController.js";

// createPsiCryptoWorkerHandle is the SINGLE definition of the browser host-side worker
// wiring (see psiCryptoController.ts): production spawns a real Web Worker through it
// (via createBrowserPsiEngineFactory) and these tests wrap a fake through it, so
// neither re-implements a mirror that could drift. Driving a fake also reaches paths a
// real worker cannot exercise on demand: an 'onmessageerror' (a reply that fails
// structured-clone deserialization) never fires for today's cloneable payloads, so
// only a fake can prove it is routed rather than silently dropped (which would hang the
// pending call). The real worker + real WASM round-trip lives in the browser suite
// (test/browser/psiCryptoWorker.test.ts), where a Worker constructor exists.

// A stand-in for a dedicated Web Worker: records posted requests and terminate() calls,
// and lets a test emit the worker's message/error/messageerror events on demand.
class FakePsiCryptoWorker implements PsiCryptoWorker {
  onmessage: ((event: { data: PsiWorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: Array<PsiWorkerRequest> = [];
  terminations = 0;

  postMessage(request: PsiWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminations += 1;
  }

  // Drive the host side: deliver a reply, a worker fault, or an undeserializable reply.
  reply(response: PsiWorkerResponse): void {
    this.onmessage?.({ data: response });
  }
  emitError(event: unknown): void {
    this.onerror?.(event);
  }
  emitMessageError(event: unknown): void {
    this.onmessageerror?.(event);
  }
  // Answer the most recent posted request as a success, echoing its id.
  replyOkToLast(result: unknown): void {
    const last = this.posted.at(-1);
    if (last === undefined) throw new Error("no request to reply to");
    this.reply({ id: last.id, ok: true, result });
  }
}

describe("encode/decodePsiWorkerInit", () => {
  test("round-trips the role/id seed", () => {
    const init: PsiWorkerInit = { role: "joiner", id: "client" };
    expect(decodePsiWorkerInit(encodePsiWorkerInit(init))).toEqual(init);
  });
});

describe("createPsiCryptoWorkerHandle", () => {
  test("routes replies to onMessage and every fault event to onError", () => {
    const fake = new FakePsiCryptoWorker();
    const handle = createPsiCryptoWorkerHandle(fake);
    const onMessage = vi.fn();
    const onError = vi.fn();
    handle.setHandlers({ onMessage, onError });

    // A reply routes to onMessage unchanged (the handle unwraps the { data } event).
    const response: PsiWorkerResponse = {
      id: 0,
      ok: true,
      result: new Uint8Array(),
    };
    fake.reply(response);
    expect(onMessage).toHaveBeenCalledWith(response);

    // A worker fault (onerror -- an uncaught error or a module-load failure) routes to
    // onError as an Error naming the fault.
    fake.emitError({ message: "worker faulted" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "worker faulted" }),
    );

    // An undeserializable reply fires onmessageerror, NOT onmessage/onerror; without
    // this wiring it is silently dropped and the pending call hangs. Route it to
    // onError. Nothing else in the suite exercises it, so dropping the listener would
    // otherwise go unnoticed.
    fake.emitMessageError({ message: "could not be deserialized" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "could not be deserialized" }),
    );
  });

  test("forwards a posted request and terminate() to the worker", () => {
    const fake = new FakePsiCryptoWorker();
    const handle = createPsiCryptoWorkerHandle(fake);
    const request: PsiWorkerRequest = {
      id: 3,
      body: { method: "createClientRequest", values: ["x"] },
    };
    handle.postMessage(request);
    expect(fake.posted).toEqual([request]);
    handle.terminate();
    expect(fake.terminations).toBe(1);
  });
});

describe("createBrowserPsiEngineFactory", () => {
  // Wire a factory over a fake spawner that records the seed and hands back a
  // controllable worker, so the factory's spawn+wire behavior is exercised without a
  // real Worker (absent under Node).
  function wireFactory(): {
    factory: (role: "starter" | "joiner", id: string) => PsiEngine;
    seeds: Array<PsiWorkerInit>;
    workers: Array<FakePsiCryptoWorker>;
  } {
    const seeds: Array<PsiWorkerInit> = [];
    const workers: Array<FakePsiCryptoWorker> = [];
    const spawn: SpawnPsiCryptoWorker = (init) => {
      seeds.push(init);
      const worker = new FakePsiCryptoWorker();
      workers.push(worker);
      return worker;
    };
    return { factory: createBrowserPsiEngineFactory(spawn), seeds, workers };
  }

  test("spawns a worker seeded with the resolved role and id", () => {
    const { factory, seeds, workers } = wireFactory();
    factory("starter", "server");
    expect(seeds).toEqual([{ role: "starter", id: "server" }]);
    expect(workers).toHaveLength(1);
  });

  test("a crypto call posts a request the worker's reply resolves", async () => {
    const { factory, workers } = wireFactory();
    const engine = factory("joiner", "client");

    const pending = engine.createClientRequest(["a", "b"]);
    const worker = workers[0];
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]?.body).toEqual({
      method: "createClientRequest",
      values: ["a", "b"],
    });

    const result = new Uint8Array([1, 2, 3]);
    worker.replyOkToLast(result);
    await expect(pending).resolves.toEqual(result);
  });

  test("a worker fault fails the pending call fast instead of hanging", async () => {
    const { factory, workers } = wireFactory();
    const engine = factory("starter", "server");

    const pending = engine.createServerSetup(["x"]);
    // The worker faults (onerror) before replying: the pending call must reject with
    // that cause rather than hang on a reply that will never arrive.
    workers[0].emitError({ message: "backend failed to load" });
    await expect(pending).rejects.toThrow(/backend failed to load/);
  });

  // The acceptance criterion: the worker is torn down on every exchange-end path.
  // runExchange funnels all three -- success, error, abort -- through the participant's
  // dispose() in its finally, so at the engine seam each is "dispose() after that prior
  // state", and dispose() must terminate the worker exactly once every time.
  describe("dispose() terminates the worker on every terminal path", () => {
    test("success: after a resolved call", async () => {
      const { factory, workers } = wireFactory();
      const engine = factory("joiner", "client");
      const pending = engine.createClientRequest(["a"]);
      workers[0].replyOkToLast(new Uint8Array());
      await pending;

      engine.dispose();
      expect(workers[0].terminations).toBe(1);
    });

    test("error: after a crypto call rejected by the worker", async () => {
      const { factory, workers } = wireFactory();
      const engine = factory("starter", "server");
      const pending = engine.createServerSetup(["x"]);
      workers[0].reply({
        id: workers[0].posted[0].id,
        ok: false,
        error: "crypto failed",
      });
      await expect(pending).rejects.toThrow(/crypto failed/);

      engine.dispose();
      expect(workers[0].terminations).toBe(1);
    });

    test("abort: while a call is still in flight, the pending call rejects", async () => {
      const { factory, workers } = wireFactory();
      const engine = factory("joiner", "client");
      // Post a call the worker never answers (an exchange aborted mid-round), then
      // dispose without awaiting: dispose must reject the outstanding call and
      // terminate, never leave it hanging.
      const pending = engine.createClientRequest(["a"]);
      engine.dispose();
      await expect(pending).rejects.toThrow(/disposed/);
      expect(workers[0].terminations).toBe(1);
    });

    test("a repeated dispose() terminates only once", () => {
      const { factory, workers } = wireFactory();
      const engine = factory("starter", "server");
      engine.dispose();
      engine.dispose();
      expect(workers[0].terminations).toBe(1);
    });
  });
});

describe("createBufferingRequestRouter", () => {
  // Flush pending microtasks so the router's startDispatcher().then() settles before
  // an assertion (a setTimeout(0) drains the microtask queue). setTimeout, not
  // Math.random/Date, so nothing non-deterministic enters the test.
  const tick = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const req = (id: number): PsiWorkerRequest => ({
    id,
    body: { method: "createClientRequest", values: [String(id)] },
  });

  test("buffers requests during load, then drains them in order and routes the rest directly", async () => {
    const dispatched: Array<number> = [];
    // A dispatcher that resolves only when the test says so, so requests can be posted
    // during the load window (before the engine is ready).
    let resolveStart!: (dispatch: (request: PsiWorkerRequest) => void) => void;
    const startDispatcher = (): Promise<(request: PsiWorkerRequest) => void> =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });
    const failRequest = vi.fn();
    const route = createBufferingRequestRouter(startDispatcher, failRequest);

    // Arrive while the engine is still loading -> buffered, nothing dispatched yet.
    route(req(0));
    route(req(1));
    expect(dispatched).toEqual([]);

    // The engine loads: buffered requests drain in the order they arrived.
    resolveStart((request) => dispatched.push(request.id));
    await tick();
    expect(dispatched).toEqual([0, 1]);

    // A request arriving after load routes straight through, not through the buffer.
    route(req(2));
    expect(dispatched).toEqual([0, 1, 2]);
    expect(failRequest).not.toHaveBeenCalled();
  });

  test("fails buffered and subsequent requests when the engine never loads", async () => {
    // The load-failure signal a real WASM-load failure would trigger: buffered and
    // later requests are answered with the failure rather than left to hang. Only a
    // fake dispatcher can drive this on demand (a real WASM load always succeeds here).
    let rejectStart!: (error: unknown) => void;
    const startDispatcher = (): Promise<(request: PsiWorkerRequest) => void> =>
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      });
    const failRequest = vi.fn();
    const route = createBufferingRequestRouter(startDispatcher, failRequest);

    route(req(0)); // buffered while loading
    rejectStart(new Error("WASM engine failed to load"));
    await tick();
    // The buffered request is failed fast with the load error, not left hanging.
    expect(failRequest).toHaveBeenCalledWith(0, "WASM engine failed to load");

    // A request arriving after the failure also fails fast rather than hanging.
    route(req(1));
    expect(failRequest).toHaveBeenCalledWith(1, "WASM engine failed to load");
    expect(failRequest).toHaveBeenCalledTimes(2);
  });
});
