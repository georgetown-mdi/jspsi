import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_PEER_CLOSE_TIMEOUT_MS,
  waitForPeerClose,
} from "../../src/psi/waitForPeerClose.js";

import type { PeerCloseOutcome } from "../../src/psi/waitForPeerClose.js";

import type { DataConnection } from "peerjs";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  closeFromPeer() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  enterClosing() {
    this.readyState = "closing";
    this.dispatchEvent(new Event("closing"));
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

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await drainTaskQueue();
  return settled;
}

type ListenerCall = [
  type: string,
  handler: EventListenerOrEventListenerObject | null,
  ...rest: Array<unknown>,
];

/** The handler a spied add/removeEventListener was given for `event`, asserted
 * present so comparing two absent handlers cannot pass as identity. */
function handlerFor(
  calls: ReadonlyArray<ListenerCall>,
  event: string,
): EventListenerOrEventListenerObject {
  const handler = calls.find(([type]) => type === event)?.[1];
  expect(typeof handler, `no listener recorded for "${event}"`).toBe(
    "function",
  );
  return handler as EventListenerOrEventListenerObject;
}

describe("waitForPeerClose", () => {
  test("reports the peer's close, the one exit that means delivered", async () => {
    const { conn, channel } = makeConn();

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    channel?.closeFromPeer();

    await expect(waiting).resolves.toBe("peer-closed");
  });

  test("resolves once the channel enters closing", async () => {
    // The listener also settles on a LOCALLY initiated close, since PeerJS
    // transitions its own channel through `closing` too (see the module
    // comment) -- this is the reachable local-close case, not the peer-origin
    // one the module exists for.
    const { conn, channel } = makeConn();

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    channel?.enterClosing();

    await expect(waiting).resolves.toBe("peer-closed");
  });

  test("resolves once the peer connection is no longer live", async () => {
    // An acknowledgement never comes from a peer that has gone, so a wait that
    // watched only the clock would turn a partner's crash into a wait as long
    // as the ceiling.
    const { conn, peerConnection } = makeConn();

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    peerConnection?.enter("failed");

    await expect(waiting).resolves.toBe("peer-gone");
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

    await expect(waiting).resolves.toBe("peer-closed");
  });

  test("resolves when the peer connection is already dead on entry", async () => {
    const { conn, peerConnection } = makeConn();
    peerConnection?.enter("closed");

    await expect(waitForPeerClose(conn)).resolves.toBe("peer-gone");
  });

  test("does not wait on a channel that is no longer open", async () => {
    // Nothing is left to deliver: whatever was buffered went with the channel,
    // so the wait would be pure delay on a path that has already failed.
    const { conn, channel } = makeConn();
    if (channel) channel.readyState = "closing";

    await expect(waitForPeerClose(conn)).resolves.toBe("channel-not-open");
  });

  test("does not wait when the connection exposes no channel", async () => {
    const { conn } = makeConn({ channel: undefined });

    await expect(waitForPeerClose(conn)).resolves.toBe("channel-not-open");
  });

  test("waits without a peer connection to watch", async () => {
    const { conn, channel } = makeConn({ peerConnection: undefined });

    const waiting = waitForPeerClose(conn);
    expect(await isSettled(waiting)).toBe(false);

    channel?.closeFromPeer();

    await expect(waiting).resolves.toBe("peer-closed");
  });

  test("reports the ceiling when the peer never closes", async () => {
    // The exit the delivery warning hangs on: the peer answered ICE and the
    // channel is still open, so the outcome has to say the wait gave up rather
    // than that the peer took the frame.
    const { conn } = makeConn();

    await expect(waitForPeerClose(conn, 5)).resolves.toBe("ceiling");
  });

  test("ends on the run's cancellation instead of standing to the ceiling", async () => {
    // The peer chooses how long the ceiling takes to arrive -- it holds the wait
    // by keeping ICE alive without reading the sentinel -- so an operator who
    // cancels must not have to spend it. The ceiling here is the production one:
    // the wait can only settle by the abort.
    const { conn } = makeConn();
    const controller = new AbortController();

    const waiting = waitForPeerClose(
      conn,
      DEFAULT_PEER_CLOSE_TIMEOUT_MS,
      controller.signal,
    );
    expect(await isSettled(waiting)).toBe(false);

    controller.abort();

    await expect(waiting).resolves.toBe("run-aborted");
  });

  test("does not wait at all when the run has already been cancelled", async () => {
    // The teardown a cancel drives arrives here with the signal already aborted,
    // so there is nothing to wait for: the operator asked for the teardown.
    const { conn } = makeConn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForPeerClose(conn, DEFAULT_PEER_CLOSE_TIMEOUT_MS, controller.signal),
    ).resolves.toBe("run-aborted");
  });

  test("removes the handlers it added, by identity, on any settle path", async () => {
    const { conn, channel, peerConnection } = makeConn();
    const channelAdd = vi.spyOn(channel as FakeDataChannel, "addEventListener");
    const channelRemove = vi.spyOn(
      channel as FakeDataChannel,
      "removeEventListener",
    );
    const peerAdd = vi.spyOn(
      peerConnection as FakePeerConnection,
      "addEventListener",
    );
    const peerRemove = vi.spyOn(
      peerConnection as FakePeerConnection,
      "removeEventListener",
    );
    const controller = new AbortController();
    const signalAdd = vi.spyOn(controller.signal, "addEventListener");
    const signalRemove = vi.spyOn(controller.signal, "removeEventListener");

    await waitForPeerClose(conn, 5, controller.signal);

    expect(channelRemove.mock.calls.map(([event]) => event)).toEqual([
      "close",
      "closing",
    ]);
    // The handler reference, not just the event name: removing a function that
    // was never added leaves the added one attached for the lifetime of a
    // channel this wait no longer holds, and an event-name assertion alone
    // cannot see that.
    for (const event of ["close", "closing"])
      expect(handlerFor(channelRemove.mock.calls, event)).toBe(
        handlerFor(channelAdd.mock.calls, event),
      );
    expect(handlerFor(peerRemove.mock.calls, "connectionstatechange")).toBe(
      handlerFor(peerAdd.mock.calls, "connectionstatechange"),
    );
    // The run's signal outlives this wait -- one signal covers the whole run --
    // so an abort listener left on it is a leak that grows with every close.
    expect(handlerFor(signalRemove.mock.calls, "abort")).toBe(
      handlerFor(signalAdd.mock.calls, "abort"),
    );
    // A second peer event after the settle must not re-enter the resolved
    // promise's teardown.
    expect(() => peerConnection?.enter("failed")).not.toThrow();
    expect(peerRemove).toHaveBeenCalledTimes(1);
  });
});

describe("DEFAULT_PEER_CLOSE_TIMEOUT_MS", () => {
  test("matches the spec budget table's Close drain row", () => {
    // docs/spec/WEBRTC_TRANSPORT.md, "## Budgets": "Close drain | 5 min" --
    // a deliberate change to either must update the other.
    expect(DEFAULT_PEER_CLOSE_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test("is the ceiling waitForPeerClose applies when no timeout is passed", async () => {
    vi.useFakeTimers();
    try {
      const { conn } = makeConn();
      let outcome: PeerCloseOutcome | undefined;
      void waitForPeerClose(conn).then((result) => {
        outcome = result;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_PEER_CLOSE_TIMEOUT_MS - 1);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("ceiling");
    } finally {
      vi.useRealTimers();
    }
  });
});
