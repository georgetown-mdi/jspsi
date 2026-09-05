import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { ConnectionError } from "@psilink/core";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection.js";

import type { DataConnection } from "peerjs";

/** The underlying `RTCDataChannel` PeerJS exposes on an open connection. A
 * flushing close leaves it open - the PEER closes it when it reads the close
 * sentinel (measured; see waitForPeerClose.ts) - so nothing here closes it
 * except an explicit `closeFromPeer`. */
class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  closeFromPeer() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "connected";
  enter(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

class FakeDataConnection extends EventEmitter {
  open: boolean;
  dataChannel = new FakeDataChannel();
  peerConnection = new FakePeerConnection();
  // The remote peer id PeerJS exposes; empty by default so redaction is a no-op
  // for tests that do not set it. A real connection's `peer` is the derived
  // rendezvous id.
  peer = "";
  send = vi.fn();
  // Mirrors PeerJS: a flush close on a channel that never opened only queues a
  // close sentinel and returns without tearing down the RTCPeerConnection, so
  // it does not count as a teardown. Any other close does.
  torndown = false;
  close = vi.fn((options?: { flush?: boolean }) => {
    if (options?.flush && !this.open) return;
    this.torndown = true;
  });

  // The PeerJS reassembly/unpack internals openPeerMessageConnection wraps to
  // bound inbound memory (see boundedReassembly.ts). Modeled here so the install
  // assertion passes; the bound itself is exercised in boundedReassembly.test.ts.
  _chunkedData: Record<number, unknown> = {};
  _handleChunk = (_chunk: unknown) => {};
  _handleDataMessage = (_message: unknown) => {};

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

/** Open with the clean close's wait for the peer disabled, for the tests that
 * are about something else: the wait itself is exercised below, and left at its
 * default a close would park until the fake peer closed the channel. */
function openWithoutCloseWait(conn: DataConnection) {
  return openPeerMessageConnection(conn, { closeDrainTimeoutMs: 0 });
}

/** Let pending microtasks and zero-delay timers run, so a promise that is not
 * settled after this one is genuinely parked. */
function drainTaskQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openPeerMessageConnection", () => {
  test("round-trips an inbound frame to receive()", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("data", { hello: "world" });

    expect(await mc.receive()).toEqual({ hello: "world" });
  });

  test("rejects an over-cap delivered binary frame as a terminal protocol error", async () => {
    // The delivered-frame safety check: an over-cap Uint8Array arriving on the data
    // event fails the exchange rather than being handed to receive(). A tiny cap
    // keeps the test cheap (the production cap is a fixed 256 MiB).
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn, { maxFrameBytes: 8 });

    fake.emit("data", new Uint8Array(9)); // one byte over the cap

    const err = await mc.receive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("protocol");
    expect((err as ConnectionError).message).toContain("exceeds");
  });

  test("accepts an at-cap delivered binary frame", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn, { maxFrameBytes: 8 });

    const atCap = new Uint8Array(8); // exactly at the cap is accepted
    fake.emit("data", atCap);

    expect(await mc.receive()).toBe(atCap);
  });

  test("does not size-bound a delivered non-binary frame", async () => {
    // A parsed object/array is not byte-measured here (core's count bounds govern
    // it); the byte bound only refuses binary frames.
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn, { maxFrameBytes: 1 });

    const obj = { theirIndex: 1, iteration: 0 };
    fake.emit("data", obj);

    expect(await mc.receive()).toBe(obj);
  });

  test("fails to install the inbound bound on a connection lacking PeerJS internals", async () => {
    // The dependency-assumption check: a connection without _handleChunk/_chunkedData
    // (a future peerjs that renamed them) fails loud rather than running unbounded.
    const fake = new EventEmitter();
    await expect(
      openPeerMessageConnection(fake as unknown as DataConnection),
    ).rejects.toThrow(/reassembly\/unpack internals/);
    // The assumption is checked before any listener is attached, so a broken
    // assumption strands nothing: no data/open/error/close listener is left on the channel.
    expect(fake.eventNames()).toHaveLength(0);
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

  test("redacts the derived peer id from a remote error before it is shown", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { fake, conn } = makeConn();
    fake.peer = id;
    const mc = await openPeerMessageConnection(conn);

    // A mid-exchange PeerJS failure interpolates conn.peer (a derived rendezvous
    // id) into the error it emits.
    fake.emit("error", new Error(`Negotiation of connection to ${id} failed.`));

    const err = (await mc
      .receive()
      .catch((e: unknown) => e)) as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).not.toContain(id);
    expect(err.message).toContain("[redacted-peer-id]");
    // The wrapped cause (the original PeerJS error) is redacted too, so the
    // cause-walking alert and console.error cannot reprint the id.
    const cause = err.cause as Error;
    expect(cause.message).not.toContain(id);
    expect(cause.stack ?? "").not.toContain(id);
  });

  test("redacts the derived peer id from a pre-open error", async () => {
    const id = "fedcba9876543210fedcba9876543210";
    const { fake, conn } = makeConn(false);
    fake.peer = id;
    const promise = openPeerMessageConnection(conn);

    fake.emit("error", new Error(`Could not connect to peer ${id}`));

    const err = (await promise.catch((e: unknown) => e)) as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).not.toContain(id);
  });

  test("a remote error drains a buffered frame before failing (abnormal tail)", async () => {
    // The abnormal-tail rule generalized to a fail() drop: a frame already
    // queued when an ICE/transport error fires is still drained by receive()
    // before the transport error reaches the caller, matching the clean-close ordering.
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("data", "final frame"); // buffered, no waiter
    fake.emit("error", new Error("ICE failure")); // abnormal drop behind it

    expect(await mc.receive()).toBe("final frame");
    const err = await mc.receive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
    expect((err as ConnectionError).message).toBe("ICE failure");
  });

  test("a buffered frame survives a close-then-error sequence", async () => {
    // PeerJS can emit close and then error around an ICE teardown. The first
    // control to latch wins and the buffered frame drains ahead of it; eager
    // finish() teardown detaches the error listener, so the trailing error is a
    // no-op rather than a frame-dropping fail().
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("data", "final frame");
    fake.emit("close"); // finish: defers the error, tears down, detaches listeners
    fake.emit("error", new Error("late ICE error")); // no-op: listener detached

    expect(await mc.receive()).toBe("final frame");
    const err = await mc.receive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
    // The clean close (first to latch) supplies the error, not the late ICE one.
    expect((err as ConnectionError).message).toBe("peer connection closed");
  });

  test("send after close rejects and does not reach the channel", async () => {
    const { fake, conn } = makeConn();
    const mc = await openWithoutCloseWait(conn);

    await mc.close();

    await expect(mc.send("x")).rejects.toBeInstanceOf(ConnectionError);
    expect(fake.send).not.toHaveBeenCalled();
  });

  test("an intentional close is quiet: it closes the channel once and silences the close event", async () => {
    const { fake, conn } = makeConn();
    const mc = await openWithoutCloseWait(conn);

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

  test("tags an open-handshake failure as a transport ConnectionError", async () => {
    // F5: waitForConnectionOpen rejects with a bare Error, but the boundary must
    // expose a kind-tagged ConnectionError so a consumer can classify it.
    const { fake, conn } = makeConn(false);
    const promise = openPeerMessageConnection(conn);

    fake.emit("close");

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
    expect((err as ConnectionError).message).toBe(
      "connection closed before open",
    );
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
    const mc = await openWithoutCloseWait(conn);

    await mc.close();

    expect(fake.close).toHaveBeenCalledWith({ flush: true });
  });

  test("a clean close parks until the peer takes the final frame", async () => {
    // The delivery guarantee: PeerJS's flush only queues its close sentinel, so
    // a close that returned here would report delivery for a frame still in the
    // browser's outbound buffer. The peer closing the channel - what it does on
    // reading the sentinel, behind every frame already sent - is what ends it.
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    let closed = false;
    void mc.close().then(() => (closed = true));
    await drainTaskQueue();
    expect(closed).toBe(false);
    expect(fake.close).toHaveBeenCalledWith({ flush: true });

    fake.dataChannel.closeFromPeer();
    await drainTaskQueue();
    expect(closed).toBe(true);
  });

  test("a clean close does not park when the peer has already closed", async () => {
    // A peer that closes the instant it reads the sentinel must not leave the
    // close parked on an event that has already fired: modelled here by a
    // channel that closes inside the PeerJS close call itself.
    const { fake, conn } = makeConn();
    fake.close.mockImplementation(() => fake.dataChannel.closeFromPeer());
    const mc = await openPeerMessageConnection(conn);

    await expect(mc.close()).resolves.toBeUndefined();
  });

  test("a clean close stops waiting once there is no live peer left", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    let closed = false;
    void mc.close().then(() => (closed = true));
    await drainTaskQueue();
    expect(closed).toBe(false);

    fake.peerConnection.enter("failed");
    await drainTaskQueue();
    expect(closed).toBe(true);
  });

  test("a clean close gives up at its ceiling rather than parking forever", async () => {
    // A peer that answers ICE but never reads: the close returns on the ceiling
    // instead of hanging a finished exchange on it.
    const { conn } = makeConn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5,
    });

    await expect(mc.close()).resolves.toBeUndefined();
  });

  test("a clean close that ends on its ceiling reports that exit", async () => {
    // The run reports success either way, so this exit -- the peer still live
    // and the channel still open, with the sentinel never taken -- is the only
    // sign the partner may never have taken the final frame.
    const { conn } = makeConn();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5,
      onCloseOutcome,
    });

    await mc.close();
    // A repeated close is a no-op on a connection already torn down, so the one
    // wait is reported once rather than per call.
    await mc.close();

    expect(onCloseOutcome.mock.calls).toEqual([["ceiling"]]);
  });

  test("a clean close the peer ends reports the peer's close", async () => {
    // The peer closing the channel IS the delivery signal; reporting it as such
    // is what lets the caller stay silent on a healthy exchange.
    const { fake, conn } = makeConn();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, { onCloseOutcome });

    const closing = mc.close();
    await drainTaskQueue();
    fake.dataChannel.closeFromPeer();
    await closing;

    expect(onCloseOutcome.mock.calls).toEqual([["peer-closed"]]);
  });

  test("a close with no live peer left reports the dead peer", async () => {
    // The link died under the drain: whatever was still buffered went with it,
    // and no delivery signal is coming.
    const { fake, conn } = makeConn();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, { onCloseOutcome });

    const closing = mc.close();
    await drainTaskQueue();
    fake.peerConnection.enter("failed");
    await closing;

    expect(onCloseOutcome.mock.calls).toEqual([["peer-gone"]]);
  });

  test("a clean close ends on the run's cancellation, not on its ceiling", async () => {
    // The peer holds this wait by keeping ICE alive without reading the close
    // sentinel, so the ceiling is the peer's duration to choose: a cancel has to
    // cut the wait itself. The ceiling here is the production one, so the close
    // can only resolve through the abort.
    const { conn } = makeConn();
    const controller = new AbortController();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5 * 60 * 1000,
      onCloseOutcome,
      signal: controller.signal,
    });

    let closed = false;
    void mc.close().then(() => (closed = true));
    await drainTaskQueue();
    expect(closed).toBe(false);

    controller.abort();
    await drainTaskQueue();

    expect(closed).toBe(true);
    // Not "peer-closed": nothing confirmed the partner took the final frame, and
    // the caller's report of the exchange rests on that difference.
    expect(onCloseOutcome.mock.calls).toEqual([["run-aborted"]]);
  });

  test("a close on an already-cancelled run still flushes and reports the cancel", async () => {
    // The teardown a cancel drives reaches the close with the signal already
    // aborted. It starts no wait, but it is still the flushing close -- PeerJS's
    // flush queues the sentinel and returns, so a frame the peer is willing to
    // read can still get there.
    const { fake, conn } = makeConn();
    const controller = new AbortController();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5 * 60 * 1000,
      onCloseOutcome,
      signal: controller.signal,
    });
    controller.abort();

    await expect(mc.close()).resolves.toBeUndefined();

    expect(fake.close).toHaveBeenCalledWith({ flush: true });
    expect(onCloseOutcome.mock.calls).toEqual([["run-aborted"]]);
  });

  test("a live run's close is unaffected by the signal it was given", async () => {
    // The signal only cuts the wait; while the run is live the peer's close is
    // still what ends it, and still the exit that means delivered.
    const { fake, conn } = makeConn();
    const controller = new AbortController();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      onCloseOutcome,
      signal: controller.signal,
    });

    const closing = mc.close();
    await drainTaskQueue();
    fake.dataChannel.closeFromPeer();
    await closing;

    expect(onCloseOutcome.mock.calls).toEqual([["peer-closed"]]);
  });

  test("a flushing close over a channel already out of open reports that exit", async () => {
    // PeerJS's `open` flag is its own bookkeeping rather than the channel's
    // state, so the flush branch can run over a channel that can hold neither
    // the sentinel nor the frames behind it. It holds no delivery signal
    // either, and is reported as its own exit rather than folded into the
    // ceiling: the caller distinguishes a wait that ran out from a link that
    // was not there.
    const { fake, conn } = makeConn();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5,
      onCloseOutcome,
    });

    fake.dataChannel.readyState = "closing";
    await mc.close();

    // Pins that the flush branch is the one that ran: the else branch has no
    // wait at all, so the assertion below would pass there vacuously.
    expect(fake.close).toHaveBeenCalledWith({ flush: true });
    expect(onCloseOutcome.mock.calls).toEqual([["channel-not-open"]]);
  });

  test("an error teardown reports nothing", async () => {
    // fail() closes without flush, so there is no wait to end at all and no
    // outcome to report: the failure itself is what the operator sees.
    const { fake, conn } = makeConn();
    const onCloseOutcome = vi.fn();
    const mc = await openPeerMessageConnection(conn, {
      closeDrainTimeoutMs: 5,
      onCloseOutcome,
    });

    fake.emit("error", new Error("boom"));
    await mc.receive().catch(() => undefined);
    await drainTaskQueue();

    expect(onCloseOutcome).not.toHaveBeenCalled();
  });

  test("an error teardown closes the channel without flushing", async () => {
    const { fake, conn } = makeConn();
    const mc = await openPeerMessageConnection(conn);

    fake.emit("error", new Error("boom"));
    await mc.receive().catch(() => undefined);

    expect(fake.close).toHaveBeenCalledWith();
  });
});
