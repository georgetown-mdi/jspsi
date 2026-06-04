import { expect, test, vi } from "vitest";
import { z } from "zod";

import {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
  createMessagePipe,
  errorMessage,
  fromEventConnection,
  receiveParsed,
} from "../src/connection/messageConnection";

import type { TransportControls } from "../src/connection/messageConnection";

import { PassthroughConnection } from "./utils/passthroughConnection";

// --- QueuedMessageConnection / pipe ------------------------------------------

test("receive resolves with a message that arrived before it was called", async () => {
  const [a, b] = createMessagePipe();
  await a.send("hello");
  // Let the queued delivery microtask run before receiving.
  await Promise.resolve();
  expect(await b.receive()).toBe("hello");
});

test("receive parks until a message arrives", async () => {
  const [a, b] = createMessagePipe();
  const received = b.receive();
  await a.send("later");
  expect(await received).toBe("later");
});

test("messages are delivered in FIFO order", async () => {
  const [a, b] = createMessagePipe();
  await a.send("one");
  await a.send("two");
  await Promise.resolve();
  expect(await b.receive()).toBe("one");
  expect(await b.receive()).toBe("two");
});

test("a terminal error rejects a parked receive and is sticky", async () => {
  const [a, b] = createMessagePipe();
  const parked = b.receive();
  await a.close(); // surfaces a transport error on the peer

  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");

  // Subsequent calls observe the same latched error.
  await expect(b.receive()).rejects.toBeInstanceOf(ConnectionError);
  await expect(b.send("x")).rejects.toBeInstanceOf(ConnectionError);
});

test("close is idempotent and rejects sends afterwards", async () => {
  const [a] = createMessagePipe();
  await a.close();
  await a.close(); // no-op, resolves
  const err = await a.send("x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("usage");
});

test("close rejects a parked receive as cancelled, not usage", async () => {
  const [a] = createMessagePipe();
  const parked = a.receive();
  await a.close();
  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("closed");
});

test("buffered messages drain before a clean close rejects receive", async () => {
  const [a, b] = createMessagePipe();
  await a.send("buffered");
  await Promise.resolve();
  await b.close();
  // The already-arrived message is still delivered...
  expect(await b.receive()).toBe("buffered");
  // ...then further receives reject as closed.
  await expect(b.receive()).rejects.toBeInstanceOf(ConnectionError);
});

test("exceeding capacity fails the connection as a protocol violation", async () => {
  const [a, b] = createMessagePipe({ capacity: 2 });
  await a.send("1");
  await a.send("2");
  await a.send("3"); // one past capacity
  await Promise.resolve();
  const err = await b.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
});

// --- finish (drain-then-fail half-close) -------------------------------------

function makeQueued(options?: {
  capacity?: number;
  inactivityTimeoutMs?: number;
}): {
  conn: QueuedMessageConnection;
  controls: TransportControls;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let controls!: TransportControls;
  const send = vi.fn();
  const close = vi.fn();
  const conn = new QueuedMessageConnection((c) => {
    controls = c;
    return { send, close };
  }, options);
  return { conn, controls, send, close };
}

test("finish drains a buffered frame before surfacing the transport error", async () => {
  const { conn, controls, close } = makeQueued();
  controls.deliver("final"); // buffered, no parked waiter
  controls.finish(new ConnectionError("peer closed", "transport"));

  // The buffered frame is still delivered...
  expect(await conn.receive()).toBe("final");
  // ...and only the next receive surfaces the deferred transport error.
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  // Teardown runs exactly once, on promotion.
  expect(close).toHaveBeenCalledTimes(1);
});

test("finish with an empty queue fails immediately, like fail", async () => {
  const { conn, controls, close } = makeQueued();
  controls.finish(new ConnectionError("peer closed", "transport"));
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect(close).toHaveBeenCalledTimes(1);
});

test("finish rejects a parked receive immediately", async () => {
  const { conn, controls } = makeQueued();
  const parked = conn.receive();
  controls.finish(new ConnectionError("peer closed", "transport"));
  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
});

test("inbound after finish is ignored; the drained frame is the last one", async () => {
  const { conn, controls } = makeQueued();
  controls.deliver("keep");
  controls.finish(new ConnectionError("peer closed", "transport"));
  controls.deliver("dropped"); // a half-close is pending: ignored
  expect(await conn.receive()).toBe("keep");
  const err = await conn.receive().catch((e: unknown) => e);
  expect((err as ConnectionError).kind).toBe("transport");
});

test("a second finish is ignored; the first deferred error wins", async () => {
  const { conn, controls } = makeQueued();
  controls.deliver("final");
  controls.finish(new ConnectionError("first", "transport"));
  controls.finish(new ConnectionError("second", "security")); // ignored

  expect(await conn.receive()).toBe("final");
  const err = await conn.receive().catch((e: unknown) => e);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toBe("first");
});

test("send is rejected while a half-close is pending, without writing", async () => {
  const { conn, controls, send } = makeQueued();
  controls.deliver("final"); // buffered, half-close pending behind it
  controls.finish(new ConnectionError("peer closed", "transport"));

  const err = await conn.send("x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect(send).not.toHaveBeenCalled();
  // The buffered frame is still drainable after the rejected send.
  expect(await conn.receive()).toBe("final");
});

test("a close racing the final drain still surfaces the transport error", async () => {
  const { conn, controls } = makeQueued();
  controls.deliver("final");
  controls.finish(new ConnectionError("peer closed", "transport"));
  await conn.close(); // races ahead of draining the final frame

  // The buffered frame still drains...
  expect(await conn.receive()).toBe("final");
  // ...and the deferred error surfaces as transport, not a generic close/usage.
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
});

test("a clean close requests a flush; an error teardown does not", async () => {
  const clean = makeQueued();
  await clean.conn.close();
  expect(clean.close).toHaveBeenCalledWith({ flush: true });

  const failed = makeQueued();
  failed.controls.fail(new ConnectionError("boom", "transport"));
  await failed.conn.receive().catch(() => undefined);
  expect(failed.close).toHaveBeenCalledWith();
});

// --- fromEventConnection bridge ----------------------------------------------

function makeEventConnections(): [
  PassthroughConnection,
  PassthroughConnection,
] {
  const a = new PassthroughConnection();
  const b = new PassthroughConnection(a);
  a.setOther(b);
  return [a, b];
}

test("fromEventConnection: relays messages over an event-based Connection", async () => {
  const [eventA, eventB] = makeEventConnections();
  const connA = fromEventConnection(eventA);
  const connB = fromEventConnection(eventB);

  await connA.send({ from: "A" });
  await connB.send({ from: "B" });

  expect(await connB.receive()).toEqual({ from: "A" });
  expect(await connA.receive()).toEqual({ from: "B" });
});

test("fromEventConnection: surfaces an error buffered before the bridge attached", async () => {
  const [, eventB] = makeEventConnections();
  // Error emitted with no listener registered is buffered by the transport.
  eventB.emit("error", new Error("early failure"));

  const connB = fromEventConnection(eventB);
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).message).toContain("early failure");
});

test("fromEventConnection: a silent peer trips the inactivity deadline", async () => {
  const [, eventB] = makeEventConnections();
  // Peer never sends; the parked receive must fail rather than hang forever.
  const connB = fromEventConnection(eventB, { inactivityTimeoutMs: 20 });
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");

  // The deadline latches a terminal state observed by later calls.
  await expect(connB.receive()).rejects.toBeInstanceOf(ConnectionError);
  await expect(connB.send("x")).rejects.toBeInstanceOf(ConnectionError);
});

test("fromEventConnection: a message before the deadline clears the timer", async () => {
  const [eventA, eventB] = makeEventConnections();
  const connB = fromEventConnection(eventB, { inactivityTimeoutMs: 30 });
  const first = connB.receive();
  eventA.send("ping");
  expect(await first).toBe("ping");

  // Delivery reset the idle clock, so the connection is still healthy well
  // past the original deadline rather than having latched a failure.
  await new Promise((r) => setTimeout(r, 50));
  await expect(connB.send("pong")).resolves.toBeUndefined();
});

test("createMessagePipe: receive has no inactivity deadline", async () => {
  const [, b] = createMessagePipe();
  let settled = false;
  const parked = b.receive().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(settled).toBe(false);

  // Release the parked receive so it does not dangle past the test.
  await b.close();
  await parked;
});

// --- I8 contract: the production `data` consumer never throws synchronously ---
//
// docs/FILE_SYNC.md invariant I8 makes a non-throwing `data` consumer
// load-bearing for FileSyncConnection's retain-mode poll(): the emit("data",
// ...) hand-off sits inside the try whose catch reprocesses the never-deleted
// message, and recvSeq advances only after the emit returns. A consumer that
// threw synchronously would re-poll the same message until peer_timeout_ms and
// then surface a generic peer-silence error. The sole production consumer is
// deliver() (this file's QueuedMessageConnection, wired as fromEventConnection's
// onData closure `(data) => controls.deliver(data)`); these tests pin that it
// latches every failure mode it handles via a non-throwing fail() rather than
// throwing back into emit. They lock the contract for the consumer that exists
// today: a regression making deliver() throw on a handled mode would fail them.
// They do NOT, and cannot, exercise a second `data` consumer that does not yet
// exist -- a new throwing listener would be its own code path. The load-bearing
// comment at deliver() and I8 itself, not this test, are what put a future
// author adding such a consumer on notice. The eventB.emit("data", ...) call
// below is structurally the same call FileSyncConnection.poll() makes at the
// retain-mode emit site.

test("data consumer (deliver): inbound overflow latches without throwing into emit", async () => {
  const [, eventB] = makeEventConnections();
  const connB = fromEventConnection(eventB, { capacity: 2 });

  // Fill the inbound buffer to capacity with no parked receive: each delivery
  // enqueues and must not throw.
  expect(() => eventB.emit("data", "1")).not.toThrow();
  expect(() => eventB.emit("data", "2")).not.toThrow();

  // The capacity+1 frame is I8's named overflow mode. The consumer must absorb
  // it as a non-throwing fail(), so emit("data", ...) returns normally rather
  // than throwing back into the retain-mode poll loop.
  expect(() => eventB.emit("data", "3")).not.toThrow();

  // The absorbed overflow surfaces only as a sticky terminal protocol error on
  // the next receive() -- confirming the consumer latched rather than threw.
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");

  // The frames buffered before the overflow ("1"/"2") are discarded by the
  // latch, not replayed: a further receive() yields the same terminal error
  // rather than a stale frame. (This is fail()'s documented discard semantics;
  // asserted here so the drop reads as intended, not an untested side effect.)
  await expect(connB.receive()).rejects.toBe(err);
});

test("data consumer (deliver): a frame after a terminal latch is a non-throwing no-op", async () => {
  const [, eventB] = makeEventConnections();
  const connB = fromEventConnection(eventB);

  // A terminal failure has already latched the connection. In production this
  // would be a transport drop from an earlier poll cycle; here it is emitted
  // inline -- the test models the latched-then-late-frame ordering, not the
  // timing.
  eventB.emit("error", new Error("earlier transport drop"));

  // A late data frame from a subsequent emit("data", ...) must be silently
  // absorbed by the consumer, never thrown back into the poll loop.
  expect(() => eventB.emit("data", "late")).not.toThrow();

  // The connection is unchanged: still the original terminal transport error,
  // with the late frame dropped rather than surfaced.
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
});

// --- per-receive timeout -----------------------------------------------------

test("receive(timeoutMs) shorter than the connection default fires and latches", async () => {
  const [, eventB] = makeEventConnections();
  const connB = fromEventConnection(eventB, { inactivityTimeoutMs: 10_000 });
  const err = await connB.receive(20).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  // min(10000, 20) = 20: the override won.
  expect((err as ConnectionError).message).toContain("20ms");
  // Latched terminal: later calls fail fast on the same error.
  await expect(connB.receive()).rejects.toBeInstanceOf(ConnectionError);
  await expect(connB.send("x")).rejects.toBeInstanceOf(ConnectionError);
});

test("receive(timeoutMs) longer than the connection default is capped by the default", async () => {
  const [, eventB] = makeEventConnections();
  const connB = fromEventConnection(eventB, { inactivityTimeoutMs: 20 });
  // Override is 10 s, but the 20 ms connection default is the ceiling.
  const err = await connB.receive(10_000).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("20ms");
});

test("receive(timeoutMs) bounds a connection that has no inactivity default", async () => {
  // createMessagePipe is unbounded; the override is the only deadline source,
  // exercising armIdle's undefined-connection-default branch.
  const [, b] = createMessagePipe();
  const err = await b.receive(20).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("20ms");
});

// --- receiveParsed -----------------------------------------------------------

test("receiveParsed: resolves with the validated message", async () => {
  const [a, b] = createMessagePipe();
  const schema = z.object({ n: z.number() });
  const parked = receiveParsed(b, schema);
  await a.send({ n: 42 });
  expect(await parked).toEqual({ n: 42 });
});

test("receiveParsed: a malformed message throws a protocol ConnectionError", async () => {
  const [a, b] = createMessagePipe();
  const schema = z.object({ n: z.number() });
  const parked = receiveParsed(b, schema);
  await a.send({ n: "not a number" });
  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  // The validator's failure is preserved as the cause.
  expect((err as ConnectionError).cause).toBeInstanceOf(z.ZodError);
});

test("receiveParsed: a transport drop surfaces as transport, not protocol", async () => {
  const [a, b] = createMessagePipe();
  const schema = z.object({ n: z.number() });
  const parked = receiveParsed(b, schema);
  await a.close();
  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
});

// --- errorMessage / asConnectionError ----------------------------------------

test("errorMessage returns an Error's message", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
});

test("errorMessage falls back to String(err) for an empty-message Error", () => {
  // Non-blank guarantee: an empty message never yields a blank alert.
  expect(errorMessage(new Error(""))).toBe("Error");
});

test("errorMessage stringifies non-Error values without throwing", () => {
  expect(errorMessage(null)).toBe("null");
  expect(errorMessage(undefined)).toBe("undefined");
  expect(errorMessage("plain string")).toBe("plain string");
  expect(errorMessage(42)).toBe("42");
});

test("asConnectionError routes its message through errorMessage", () => {
  // The deliberate behavior change: an empty-message Error becomes "Error".
  const err = asConnectionError(new Error(""), "transport");
  expect(err).toBeInstanceOf(ConnectionError);
  expect(err.kind).toBe("transport");
  expect(err.message).toBe("Error");
});

test("asConnectionError passes an existing ConnectionError through unchanged", () => {
  const original = new ConnectionError("nope", "security");
  expect(asConnectionError(original, "transport")).toBe(original);
});
