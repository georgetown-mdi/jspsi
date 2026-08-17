import { describe, expect, test, vi } from "vitest";

import { waitForPeerClose } from "../../src/psi/waitForPeerClose.js";

import type { DataConnection } from "peerjs";

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

function makeConn(overrides?: {
  channel?: FakeDataChannel | undefined;
  peerConnection?: FakePeerConnection | undefined;
}): {
  conn: DataConnection;
  channel: FakeDataChannel | undefined;
  peerConnection: FakePeerConnection | undefined;
} {
  const channel =
    overrides && "channel" in overrides
      ? overrides.channel
      : new FakeDataChannel();
  const peerConnection =
    overrides && "peerConnection" in overrides
      ? overrides.peerConnection
      : new FakePeerConnection();
  return {
    conn: { dataChannel: channel, peerConnection } as unknown as DataConnection,
    channel,
    peerConnection,
  };
}

/** Let pending microtasks and zero-delay timers run, so a promise that is not
 * settled after this one is genuinely parked. */
function drainTaskQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await drainTaskQueue();
  return settled;
}

describe("waitForPeerClose", () => {
  test("resolves once the peer closes the channel", async () => {
    const { conn, channel } = makeConn();

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    channel?.closeFromPeer();

    await expect(waiting).resolves.toBeUndefined();
  });

  test("resolves once the peer connection is no longer live", async () => {
    // An acknowledgement never comes from a peer that has gone, so a wait that
    // watched only the clock would turn a partner's crash into a wait as long
    // as the ceiling.
    const { conn, peerConnection } = makeConn();

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    peerConnection?.enter("failed");

    await expect(waiting).resolves.toBeUndefined();
  });

  test("keeps waiting through a transient ICE disconnect", async () => {
    // `disconnected` recovers, and the frame is still in flight while it does:
    // treating it as terminal would report delivery for bytes the peer never
    // received. The ceiling covers a disconnect that never recovers.
    const { conn, peerConnection } = makeConn();

    const waiting = waitForPeerClose(conn);
    peerConnection?.enter("disconnected");

    expect(await isSettled(waiting)).toBe(false);

    peerConnection?.enter("connected");
    (conn.dataChannel as unknown as FakeDataChannel).closeFromPeer();

    await expect(waiting).resolves.toBeUndefined();
  });

  test("resolves when the peer connection is already dead on entry", async () => {
    const { conn, peerConnection } = makeConn();
    peerConnection?.enter("closed");

    await expect(waitForPeerClose(conn)).resolves.toBeUndefined();
  });

  test("does not wait on a channel that is no longer open", async () => {
    // Nothing is left to deliver: whatever was buffered went with the channel,
    // so the wait would be pure delay on a path that has already failed.
    const { conn, channel } = makeConn();
    if (channel) channel.readyState = "closing";

    await expect(waitForPeerClose(conn)).resolves.toBeUndefined();
  });

  test("does not wait when the connection exposes no channel", async () => {
    const { conn } = makeConn({ channel: undefined });

    await expect(waitForPeerClose(conn)).resolves.toBeUndefined();
  });

  test("waits without a peer connection to watch", async () => {
    const { conn, channel } = makeConn({ peerConnection: undefined });

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    channel?.closeFromPeer();

    await expect(waiting).resolves.toBeUndefined();
  });

  test("resolves at the ceiling when the peer never closes", async () => {
    const { conn } = makeConn();

    await expect(waitForPeerClose(conn, 5)).resolves.toBeUndefined();
  });

  test("leaves no listener or timer behind on any settle path", async () => {
    const { conn, channel, peerConnection } = makeConn();
    const channelRemove = vi.spyOn(
      channel as FakeDataChannel,
      "removeEventListener",
    );
    const peerRemove = vi.spyOn(
      peerConnection as FakePeerConnection,
      "removeEventListener",
    );

    await waitForPeerClose(conn, 5);

    expect(channelRemove.mock.calls.map(([event]) => event)).toEqual([
      "close",
      "closing",
    ]);
    expect(peerRemove).toHaveBeenCalledWith(
      "connectionstatechange",
      expect.anything(),
    );
    // A second peer event after the settle must not re-enter the resolved
    // promise's teardown.
    expect(() => peerConnection?.enter("failed")).not.toThrow();
    expect(peerRemove).toHaveBeenCalledTimes(1);
  });
});
