import { expect, test } from "vitest";

import { ConnectionError } from "@psilink/core";

import { BoundedInboundFrames } from "../../src/connection/webrtc/inboundBounds";
import {
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
  packCloseSentinel,
  packValue,
} from "../../src/connection/webrtc/peerjsWire";
import { webRtcMessageConnection } from "../../src/connection/webrtc/webrtcMessageConnection";

import type { WebRtcPeerSession } from "../../src/connection/webrtc/weriftPeer";
import type { RTCDataChannel } from "werift";

/**
 * A data channel stand-in with the surface the binding uses. The real channel is
 * driven end to end in test/integration/webrtc/transport.test.ts; this exists to
 * exercise the orderings that are hard to provoke on a live channel -- a close
 * sentinel arriving with a frame still queued, a peer that vanishes, a drain
 * that never settles.
 */
class FakeChannel {
  readyState: "open" | "closed" | "connecting" | "closing" = "open";
  bufferedAmount = 0;
  readonly sent: Array<Uint8Array> = [];
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: ((event: { error: unknown }) => void) | undefined;
  /** Set to make `send` throw, standing in for a channel that went mid-write. */
  sendThrows = false;

  send(data: Buffer): void {
    if (this.sendThrows) throw new Error("channel is gone");
    this.sent.push(new Uint8Array(data));
  }

  /** Push one datagram at the binding, as the real channel's onmessage would. */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: Buffer.from(bytes) });
  }
}

interface Harness {
  channel: FakeChannel;
  session: WebRtcPeerSession;
  closed: () => number;
  /** Fire the peer-connection-lost hook the session installed. */
  disconnect: () => void;
  setAcknowledged: (value: boolean) => void;
  setTransmitted: (value: boolean) => void;
}

function harness(): Harness {
  const channel = new FakeChannel();
  let closeCount = 0;
  let acknowledged = true;
  let transmitted = true;
  let onLost: (() => void) | undefined;
  const session: WebRtcPeerSession = {
    channel: channel as unknown as RTCDataChannel,
    isConnected: () => true,
    outboundAcknowledged: () => acknowledged,
    outboundTransmitted: () => transmitted,
    onDisconnected: (handler) => {
      onLost = handler;
    },
    close: () => {
      closeCount += 1;
      return Promise.resolve();
    },
  };
  return {
    channel,
    session,
    closed: () => closeCount,
    disconnect: () => onLost?.(),
    setAcknowledged: (value) => {
      acknowledged = value;
    },
    setTransmitted: (value) => {
      transmitted = value;
    },
  };
}

/** Read the frames a fake channel was sent back through the inbound path. */
function decodeSent(channel: FakeChannel): Array<unknown> {
  const bounds = new BoundedInboundFrames();
  const values: Array<unknown> = [];
  for (const datagram of channel.sent) {
    const outcome = bounds.accept(datagram);
    if (outcome.kind === "frame") values.push(outcome.value);
    if (outcome.kind === "close") values.push({ __closeSentinel: true });
  }
  return values;
}

// --- send -------------------------------------------------------------------

test("a small frame goes out as one datagram, a large one as chunks", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session);

  await connection.send({ step: 1 });
  expect(channel.sent).toHaveLength(1);

  channel.sent.length = 0;
  await connection.send({ body: new Uint8Array(PEERJS_CHUNK_MTU * 3) });
  expect(channel.sent.length).toBeGreaterThan(1);
});

test("what goes on the wire decodes back to what was sent", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session);
  await connection.send({ step: 1, note: "one" });
  await connection.send({ body: new Uint8Array(PEERJS_CHUNK_MTU * 2).fill(9) });
  const decoded = decodeSent(channel);
  expect(decoded[0]).toEqual({ step: 1, note: "one" });
  expect(decoded).toHaveLength(2);
});

test("a send on a gone channel raises a terminal transport error", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session);
  channel.sendThrows = true;
  await expect(connection.send({ step: 1 })).rejects.toThrow(ConnectionError);
  await expect(connection.receive()).rejects.toThrow(ConnectionError);
});

// --- receive ----------------------------------------------------------------

test("inbound datagrams are delivered as whole frames", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session);
  const encoder = new PeerJsFrameEncoder();
  for (const datagram of encoder.encode({ step: 2, ok: true })) {
    channel.deliver(datagram);
  }
  expect(await connection.receive()).toEqual({ step: 2, ok: true });
});

test("the close sentinel half-closes: a queued frame is drained before it", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session);
  const encoder = new PeerJsFrameEncoder();
  for (const datagram of encoder.encode({ step: "final" })) {
    channel.deliver(datagram);
  }
  channel.deliver(packCloseSentinel());

  // The frame first -- a peer's clean close cannot swallow the frame it sent
  // immediately before it.
  expect(await connection.receive()).toEqual({ step: "final" });
  const after = await connection.receive().then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(after?.kind).toBe("transport");
  expect(after?.message).toContain("peer connection closed");
});

test("an over-bound datagram fails the connection closed", async () => {
  const { channel, session } = harness();
  const connection = webRtcMessageConnection(session, {
    inboundBounds: { maxFrameBytes: 64 },
  });
  channel.deliver(packValue({ body: new Uint8Array(256) }));
  const refusal = await connection.receive().then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(refusal?.kind).toBe("protocol");
  expect(refusal?.message).toContain("64-byte size limit");
});

test("a partner that vanishes fails the connection rather than stranding it", async () => {
  // werift raises no channel `close` when the remote peer connection is torn
  // down, so without this hook the exchange would sit on its hour-scale
  // inactivity budget.
  const { session, disconnect } = harness();
  const connection = webRtcMessageConnection(session);
  const parked = connection.receive();
  disconnect();
  const lost = await parked.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(lost?.kind).toBe("transport");
  expect(lost?.message).toContain("lost");
});

// --- close ------------------------------------------------------------------

test("a clean close waits for the peer to acknowledge before tearing down", async () => {
  // The delivery guarantee: `send` resolves on hand-off, so the acknowledgement
  // wait is the only thing standing between a final frame and a lost one.
  const { channel, session, closed, setAcknowledged } = harness();
  const connection = webRtcMessageConnection(session, {
    closeFlushTimeoutMs: 5_000,
  });
  await connection.send({ step: "last" });
  setAcknowledged(false);

  let settled = false;
  const closing = connection.close().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  expect(closed()).toBe(0);
  // The sentinel is written only once the frames before it are acknowledged.
  expect(decodeSent(channel)).toEqual([{ step: "last" }]);

  setAcknowledged(true);
  await closing;
  expect(closed()).toBe(1);
  expect(decodeSent(channel)).toEqual([
    { step: "last" },
    { __closeSentinel: true },
  ]);
});

test("a clean close still returns when the acknowledgement never comes", async () => {
  // A partner that stops acknowledging must not hang an unattended run: the
  // ceiling is what guarantees the close terminates.
  const { session, closed, setAcknowledged } = harness();
  const connection = webRtcMessageConnection(session, {
    closeFlushTimeoutMs: 80,
  });
  await connection.send({ step: "last" });
  setAcknowledged(false);
  const started = Date.now();
  await connection.close();
  expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  expect(closed()).toBe(1);
});

test("the sentinel is waited on for transmission only, never acknowledgement", async () => {
  // A peer closes the moment it reads the sentinel, so it never acknowledges
  // one; waiting for that would spend the whole budget on every clean close.
  const { session, setAcknowledged, setTransmitted } = harness();
  const connection = webRtcMessageConnection(session, {
    closeFlushTimeoutMs: 10_000,
  });
  await connection.send({ step: "last" });
  // Acknowledged (so phase one passes) but the sentinel is still queued.
  setAcknowledged(true);
  setTransmitted(false);
  let settled = false;
  const closing = connection.close().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  setTransmitted(true);
  await closing;
  expect(settled).toBe(true);
});

test("an error teardown neither flushes nor waits", async () => {
  const { channel, session, closed, setAcknowledged } = harness();
  const connection = webRtcMessageConnection(session, {
    closeFlushTimeoutMs: 10_000,
  });
  setAcknowledged(false);
  channel.onerror?.({ error: new Error("channel failed") });
  await expect(connection.receive()).rejects.toThrow(ConnectionError);
  // No sentinel on an error path: the link is already unusable.
  expect(channel.sent).toHaveLength(0);
  expect(closed()).toBe(1);
});

test("a close on an already-closed channel skips the flush entirely", async () => {
  const { channel, session, closed, setAcknowledged } = harness();
  const connection = webRtcMessageConnection(session, {
    closeFlushTimeoutMs: 10_000,
  });
  channel.readyState = "closed";
  setAcknowledged(false);
  const started = Date.now();
  await connection.close();
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(channel.sent).toHaveLength(0);
  expect(closed()).toBe(1);
});

test("the connection exposes no per-exchange inbound frame cap", async () => {
  // This transport bounds its inbound path with a fixed reassembly envelope
  // instead, so the call must degrade to a no-op rather than silently appearing
  // to narrow anything.
  const { session } = harness();
  const connection = webRtcMessageConnection(session);
  expect(() => connection.setInboundFrameCap?.(1024)).not.toThrow();
  await connection.close();
});
