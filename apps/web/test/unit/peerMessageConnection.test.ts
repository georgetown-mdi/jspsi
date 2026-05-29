import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { ConnectionError } from "@psilink/core";

import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import type { DataConnection } from "peerjs";

class FakeDataConnection extends EventEmitter {
  open: boolean;
  send = vi.fn();
  // Mirrors PeerJS: a flush close on a channel that never opened only queues a
  // close sentinel and returns without tearing down the RTCPeerConnection, so
  // it does not count as a teardown. Any other close does.
  torndown = false;
  close = vi.fn((options?: { flush?: boolean }) => {
    if (options?.flush && !this.open) return;
    this.torndown = true;
  });

  constructor(open = true) {
    super();
    this.open = open;
  }
}

function makeConn(open = true): {
  fake: FakeDataConnection;
  conn: DataConnection;
} {
  const fake = new FakeDataConnection(open);
  return { fake, conn: fake as unknown as DataConnection };
}

describe("openPeerMessageConnection", () => {
  test("round-trips an inbound frame to receive()", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("data", { hello: "world" });

    expect(await mc.receive()).toEqual({ hello: "world" });
  });

  test("delegates send to the underlying channel", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    await mc.send("payload");

    expect(fake.send).toHaveBeenCalledWith("payload");
  });

  test("a remote close while a receive is parked rejects it as transport", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    const parked = mc.receive();
    fake.emit("close");

    const err = await parked.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
  });

  test("a remote close drains a buffered frame before failing", async () => {
    // The discard regression: a frame buffered with no parked receive must
    // survive a clean close. finish() defers the transport error until the
    // queue empties, so the buffered frame is returned and only the next
    // receive() rejects.
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("data", "final frame"); // buffered, no waiter
    fake.emit("close");

    expect(await mc.receive()).toBe("final frame");
    const err = await mc.receive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
  });

  test("a remote error fails the connection as transport and preserves the cause", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    const cause = new Error("ICE failure");
    fake.emit("error", cause);

    const err = await mc.receive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
    expect((err as ConnectionError).message).toBe("ICE failure");
    expect((err as ConnectionError).cause).toBe(cause);
  });

  test("send after close rejects and does not reach the channel", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    await mc.close();

    await expect(mc.send("x")).rejects.toBeInstanceOf(ConnectionError);
    expect(fake.send).not.toHaveBeenCalled();
  });

  test("an intentional close is quiet: it closes the channel once and silences the close event", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    await expect(mc.close()).resolves.toBeUndefined();
    expect(fake.close).toHaveBeenCalledTimes(1);

    // The onClose listener was detached, so a late channel close fires no
    // spurious failure.
    expect(() => fake.emit("close")).not.toThrow();
  });

  test("rejects if the channel closes before it opens", async () => {
    const { fake, conn } = makeConn(false);

    const promise = openPeerMessageConnection(conn);
    fake.emit("close");

    await expect(promise).rejects.toThrow("connection closed before open");
  });

  test("attaches the inbound listener before the channel opens", async () => {
    // The dropped-first-frame regression: the initiator sends Message 1 the
    // instant the channel opens, before this side resolves the open handshake.
    // The listener must already be attached, since PeerJS does not replay a
    // frame emitted before a listener exists.
    const { fake, conn } = makeConn(false);
    const promise = openPeerMessageConnection(conn);

    fake.emit("open");
    fake.emit("data", "first frame"); // arrives in the same tick as open

    const mc = await promise;
    expect(await mc.receive()).toBe("first frame");
  });

  test("tears down the channel on a pre-open close", async () => {
    // peer.disconnect() would not close a half-open data channel, so a failed
    // open must close it here or it leaks its RTCPeerConnection.
    const { fake, conn } = makeConn(false);
    const promise = openPeerMessageConnection(conn);

    fake.emit("close");

    await expect(promise).rejects.toThrow("connection closed before open");
    expect(fake.torndown).toBe(true);
  });

  test("hard-closes a never-opening channel on timeout instead of leaking it", async () => {
    // An open timeout emits no pre-open error/close to route through fail(), so
    // the catch closes the channel itself. A flush close would no-op on an
    // unopened channel, so this must be a hard close or the channel leaks - the
    // regression the open-state guard in the close hook prevents.
    const { fake, conn } = makeConn(false); // never opens, never errors

    const promise = openPeerMessageConnection(conn, { openTimeoutMs: 10 });

    await expect(promise).rejects.toThrow("connection open timed out");
    expect(fake.torndown).toBe(true);
  });

  test("a clean close flushes buffered writes before tearing down", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    await mc.close();

    expect(fake.close).toHaveBeenCalledWith({ flush: true });
  });

  test("an error teardown closes the channel without flushing", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("error", new Error("boom"));
    await mc.receive().catch(() => undefined);

    expect(fake.close).toHaveBeenCalledWith();
  });
});
