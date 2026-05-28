import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { DataConnectionAdapter } from "../../src/psi/dataConnectionAdapter.js";

import type { DataConnection } from "peerjs";

class FakeDataConnection extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
}

function makeAdapter() {
  const fake = new FakeDataConnection();
  const adapter = new DataConnectionAdapter(fake as unknown as DataConnection);
  return { fake, adapter };
}

describe("DataConnectionAdapter", () => {
  test("forwards data events to registered listeners", () => {
    const { fake, adapter } = makeAdapter();
    const received: Array<unknown> = [];
    adapter.on("data", (d) => received.push(d));

    fake.emit("data", { hello: "world" });

    expect(received).toEqual([{ hello: "world" }]);
  });

  test("forwards error events to a registered listener", () => {
    const { fake, adapter } = makeAdapter();
    const err = new Error("transport failure");
    const received: Array<unknown> = [];
    adapter.on("error", (e) => received.push(e));

    fake.emit("error", err);

    expect(received).toEqual([err]);
    expect(adapter.takeBufferedError()).toBeUndefined();
  });

  test("buffers an error emitted while no listener is registered", () => {
    const { fake, adapter } = makeAdapter();
    const err = new Error("gap error");

    fake.emit("error", err);

    expect(adapter.takeBufferedError()).toBe(err);
  });

  test("takeBufferedError clears the buffer on read", () => {
    const { fake, adapter } = makeAdapter();

    fake.emit("error", new Error("gap error"));
    adapter.takeBufferedError();

    expect(adapter.takeBufferedError()).toBeUndefined();
  });

  test("data emitted with no listener is silently dropped", () => {
    const { fake, adapter } = makeAdapter();

    expect(() => fake.emit("data", { payload: 42 })).not.toThrow();
    expect(adapter.takeBufferedError()).toBeUndefined();
  });

  test("second buffered error supersedes the first and chains it as cause", () => {
    const { fake, adapter } = makeAdapter();
    const first = new Error("first");
    const second = new Error("second");

    fake.emit("error", first);
    fake.emit("error", second);

    const buffered = adapter.takeBufferedError();
    expect(buffered).toBe(second);
    expect((buffered as Error).cause).toBe(first);
  });

  test("removing an error listener causes subsequent errors to be buffered", () => {
    const { fake, adapter } = makeAdapter();
    const err = new Error("post-removal error");
    const received: Array<unknown> = [];
    const listener = (e: unknown) => received.push(e);

    adapter.on("error", listener);
    adapter.removeListener("error", listener);

    fake.emit("error", err);

    expect(received).toHaveLength(0);
    expect(adapter.takeBufferedError()).toBe(err);
  });

  test("close removes forwarding listeners from the underlying DataConnection", () => {
    const { fake, adapter } = makeAdapter();
    adapter.close();

    const received: Array<unknown> = [];
    adapter.on("data", (d) => received.push(d));
    fake.emit("data", { after: "close" });

    expect(received).toHaveLength(0);
  });

  test("delegates send to the underlying DataConnection", () => {
    const { fake, adapter } = makeAdapter();

    adapter.send("payload", true);

    expect(fake.send).toHaveBeenCalledWith("payload", true);
  });

  test("delegates close to the underlying DataConnection", () => {
    const { fake, adapter } = makeAdapter();

    adapter.close();

    expect(fake.close).toHaveBeenCalled();
  });
});
