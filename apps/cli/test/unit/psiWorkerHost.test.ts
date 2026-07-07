import { describe, expect, test, vi } from "vitest";
import {
  WorkerPsiEngine,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@psilink/core";

import { createWorkerThreadHandle } from "../../src/psiWorkerHost";

// createWorkerThreadHandle is the SINGLE definition of the host-side worker wiring
// (see psiWorkerHost.ts): production spawns a real worker through it, the integration
// test wraps a real worker through it, and these tests wrap a fake through it. That is
// deliberate -- a hand-rolled mirror of this wiring is exactly what drifted from
// production once before (a broken exit handler that shipped untested). Driving a fake
// worker also reaches the paths a real worker cannot exercise on demand: a
// 'messageerror' (a reply that fails structured-clone deserialization) never fires for
// today's cloneable payloads, so only a fake can prove it is routed rather than
// silently dropped, which would hang the pending call.

// A stand-in for a worker_threads Worker: records posted requests and terminate()
// calls, and lets a test emit the worker's events on demand.
class FakeWorker {
  readonly posted: PsiWorkerRequest[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();

  on(event: string, listener: (arg: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (arg: unknown) => void);
    this.listeners.set(event, list);
  }

  postMessage(request: PsiWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
}

describe("createWorkerThreadHandle", () => {
  test("routes replies to onMessage and every failure event to onError", () => {
    const fake = new FakeWorker();
    const handle = createWorkerThreadHandle(fake);
    const onMessage = vi.fn();
    const onError = vi.fn();
    handle.setHandlers({ onMessage, onError });

    // A normal reply routes to onMessage unchanged.
    const reply: PsiWorkerResponse = {
      id: 0,
      ok: true,
      result: new Uint8Array(),
    };
    fake.emit("message", reply);
    expect(onMessage).toHaveBeenCalledWith(reply);

    // 'error' routes to onError.
    const err = new Error("worker faulted");
    fake.emit("error", err);
    expect(onError).toHaveBeenCalledWith(err);

    // 'messageerror' -- a reply that fails structured-clone deserialization -- also
    // routes to onError. Without this wiring the event is silently dropped and the
    // pending call hangs; nothing else in the suite exercises it, so dropping the
    // listener would otherwise go unnoticed.
    const cloneErr = new Error("could not be deserialized");
    fake.emit("messageerror", cloneErr);
    expect(onError).toHaveBeenCalledWith(cloneErr);

    // An exit we did not initiate is a fault.
    fake.emit("exit", 1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("exited with code 1"),
      }),
    );
  });

  test("an expected exit after terminate() is not surfaced as a fault", () => {
    const fake = new FakeWorker();
    const handle = createWorkerThreadHandle(fake);
    const onError = vi.fn();
    handle.setHandlers({ onMessage: vi.fn(), onError });

    // terminate() marks the coming exit as one WE initiated.
    handle.terminate();
    expect(fake.terminateCalls).toBe(1);

    // The worker's own exit (nonzero, indistinguishable by code from a crash) must
    // therefore NOT re-enter onError -- the exit code cannot tell a clean disposal
    // from a fault, so whether we asked it to stop is what gates the fault.
    fake.emit("exit", 1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("a messageerror fails the engine's pending call fast instead of hanging", async () => {
    const fake = new FakeWorker();
    const engine = new WorkerPsiEngine(createWorkerThreadHandle(fake));

    // A call posts its request to the worker and awaits the reply.
    const pending = engine.createClientRequest(["x"]);
    expect(fake.posted).toHaveLength(1);

    // The reply comes back as a messageerror (non-cloneable): the pending call must
    // reject with that cause rather than hang on a reply that will never arrive.
    fake.emit("messageerror", new Error("could not be deserialized"));
    await expect(pending).rejects.toThrow(/could not be deserialized/);
  });
});
