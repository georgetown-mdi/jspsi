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

  test("once('data') fires on the first event only", () => {
    const { fake, adapter } = makeAdapter();
    const received: Array<unknown> = [];
    adapter.once("data", (d) => received.push(d));

    fake.emit("data", "first");
    fake.emit("data", "second");

    expect(received).toEqual(["first"]);
  });

  test("once('error') fires on the first error; second unhandled error is buffered", () => {
    const { fake, adapter } = makeAdapter();
    const received: Array<unknown> = [];
    adapter.once("error", (e) => received.push(e));

    const first = new Error("first");
    const second = new Error("second");
    fake.emit("error", first);
    fake.emit("error", second);

    expect(received).toEqual([first]);
    expect(adapter.takeBufferedError()).toBe(second);
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

  test("close removes error forwarding listeners from the underlying DataConnection", () => {
    const { fake, adapter } = makeAdapter();
    adapter.close();

    const received: Array<unknown> = [];
    adapter.on("error", (e) => received.push(e));
    fake.emit("error", new Error("after close"));

    expect(received).toHaveLength(0);
    expect(adapter.takeBufferedError()).toBeUndefined();
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

  test("close() is idempotent: second call does not invoke conn.close() again", () => {
    const { fake, adapter } = makeAdapter();

    adapter.close();
    adapter.close();

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  test("send() after close() does not delegate to the underlying DataConnection", () => {
    const { fake, adapter } = makeAdapter();

    adapter.close();
    adapter.send("post-close payload");

    expect(fake.send).not.toHaveBeenCalled();
  });

  test("non-Error value is buffered when no listener is registered", () => {
    const { fake, adapter } = makeAdapter();

    fake.emit("error", "transport error string");

    expect(adapter.takeBufferedError()).toBe("transport error string");
  });

  test("Error superseding a buffered non-Error value chains the non-Error as cause", () => {
    const { fake, adapter } = makeAdapter();
    const second = new Error("second");

    fake.emit("error", "first string error");
    fake.emit("error", second);

    const buffered = adapter.takeBufferedError();
    expect(buffered).toBe(second);
    expect((buffered as Error).cause).toBe("first string error");
  });

  test("non-Error superseding a buffered Error updates the buffer without cause chain", () => {
    const { fake, adapter } = makeAdapter();
    const first = new Error("first");

    fake.emit("error", first);
    fake.emit("error", "second string");

    expect(adapter.takeBufferedError()).toBe("second string");
  });

  test("close event from underlying conn is forwarded as an error", () => {
    const { fake, adapter } = makeAdapter();
    const received: Array<unknown> = [];
    adapter.on("error", (e) => received.push(e));

    fake.emit("close");

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Error);
    expect((received[0] as Error).message).toBe(
      "peer connection closed unexpectedly",
    );
  });

  test("close event is buffered when no error listener is registered", () => {
    const { fake, adapter } = makeAdapter();

    fake.emit("close");

    const buffered = adapter.takeBufferedError();
    expect(buffered).toBeInstanceOf(Error);
    expect((buffered as Error).message).toBe("peer connection closed unexpectedly");
  });

  test("close event after adapter.close() does not emit an error", () => {
    const { fake, adapter } = makeAdapter();
    const received: Array<unknown> = [];
    adapter.on("error", (e) => received.push(e));

    adapter.close();
    fake.emit("close");

    expect(received).toHaveLength(0);
    expect(adapter.takeBufferedError()).toBeUndefined();
  });
});
