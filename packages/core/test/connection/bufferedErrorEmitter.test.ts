import { expect, test, vi } from "vitest";

import { BufferedErrorEmitter } from "../../src/connection/bufferedErrorEmitter";

class TestEmitter extends BufferedErrorEmitter {
  onErrorSupersededSpy = vi.fn();
  protected override onErrorSuperseded(previous: unknown): void {
    this.onErrorSupersededSpy(previous);
  }
}

// --- Basic buffering ---------------------------------------------------------

test("error emitted with no listener is returned by takeBufferedError", () => {
  const emitter = new TestEmitter();
  const err = new Error("oops");
  emitter.emit("error", err);
  expect(emitter.takeBufferedError()).toBe(err);
});

test("takeBufferedError clears the buffer on the first call", () => {
  const emitter = new TestEmitter();
  emitter.emit("error", new Error("oops"));
  emitter.takeBufferedError();
  expect(emitter.takeBufferedError()).toBeUndefined();
});

test("error delivered to a listener is not buffered", () => {
  const emitter = new TestEmitter();
  emitter.on("error", () => {});
  emitter.emit("error", new Error("oops"));
  expect(emitter.takeBufferedError()).toBeUndefined();
});

// --- Superseding -------------------------------------------------------------

test("second unhandled error replaces the first in the buffer", () => {
  const emitter = new TestEmitter();
  const first = new Error("first");
  const second = new Error("second");
  emitter.emit("error", first);
  emitter.emit("error", second);
  expect(emitter.takeBufferedError()).toBe(second);
});

// --- Cause chaining ----------------------------------------------------------

test("superseding chains the previous error as cause when incoming has none", () => {
  const emitter = new TestEmitter();
  const first = new Error("first");
  const second = new Error("second");
  emitter.emit("error", first);
  emitter.emit("error", second);
  expect(second.cause).toBe(first);
});

test("superseding does not overwrite an existing cause", () => {
  const emitter = new TestEmitter();
  const root = new Error("root");
  const first = new Error("first");
  const second = Object.assign(new Error("second"), { cause: root });
  emitter.emit("error", first);
  emitter.emit("error", second);
  expect(second.cause).toBe(root);
});

test("re-emitting the same Error instance does not create a self-referential cause", () => {
  const emitter = new TestEmitter();
  const err = new Error("same");
  emitter.emit("error", err);
  emitter.emit("error", err);
  expect(err.cause).toBeUndefined();
});

// --- onErrorSuperseded hook --------------------------------------------------

test("onErrorSuperseded is called with the previous error when superseding", () => {
  const emitter = new TestEmitter();
  const first = new Error("first");
  const second = new Error("second");
  emitter.emit("error", first);
  emitter.emit("error", second);
  expect(emitter.onErrorSupersededSpy).toHaveBeenCalledOnce();
  expect(emitter.onErrorSupersededSpy).toHaveBeenCalledWith(first);
});

test("onErrorSuperseded is not called when the buffer is empty", () => {
  const emitter = new TestEmitter();
  emitter.emit("error", new Error("first"));
  expect(emitter.onErrorSupersededSpy).not.toHaveBeenCalled();
});
