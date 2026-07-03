import { expect, test, vi } from "vitest";
import { z } from "zod";

import {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
  createMessagePipe,
  errorMessage,
  fromEventConnection,
  parseOrProtocolError,
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
  // The frames buffered before the overflow drain first (the abnormal-tail
  // rule: receive() returns an already-arrived frame ahead of a terminal
  // error); the protocol violation then surfaces once they are drained.
  expect(await b.receive()).toBe("1");
  expect(await b.receive()).toBe("2");
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
  // Teardown runs eagerly, at finish() time - not on the later drain promotion.
  expect(close).toHaveBeenCalledTimes(1);

  // The buffered frame is still delivered...
  expect(await conn.receive()).toBe("final");
  // ...and only the next receive surfaces the deferred transport error.
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  // Promotion does not re-run teardown.
  expect(close).toHaveBeenCalledTimes(1);
});

test("a deferred half-close tears down the transport even if abandoned (F2)", () => {
  const { controls, close } = makeQueued();
  controls.deliver("buffered"); // queued, no waiter
  controls.finish(new ConnectionError("peer closed", "transport"));
  // The half-close is never drained and never close()d, yet teardown has
  // already run: an abandoned half-close cannot leak the transport's
  // listeners/channel. A no-flush teardown, since the peer has gone.
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith();
});

test("an abnormal drop drains a buffered frame before the error (deliver->fail)", async () => {
  const { conn, controls } = makeQueued();
  controls.deliver("tail"); // buffered, no parked waiter
  controls.fail(new ConnectionError("dropped", "transport"));
  // The abnormal-tail rule applies to fail() too: an already-arrived frame is
  // returned before the abnormal error surfaces.
  expect(await conn.receive()).toBe("tail");
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
});

test("a fail after a pending half-close still drains the frame (deliver->finish->fail)", async () => {
  const { conn, controls } = makeQueued();
  controls.deliver("tail");
  controls.finish(new ConnectionError("peer closed", "transport"));
  controls.fail(new ConnectionError("late drop", "transport")); // no-ops: terminal
  // The buffered frame drains, then the first error to latch (the finish) wins;
  // the later fail() is a no-op rather than a frame-dropping override.
  expect(await conn.receive()).toBe("tail");
  const err = await conn.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toBe("peer closed");
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

test("fromEventConnection: a supplied inactivityHint is appended to the silence error", async () => {
  const [, eventB] = makeEventConnections();
  // A caller that knows the transport (the file-sync CLI) supplies guidance
  // about likely causes; it is appended as a trailing sentence to the generic
  // peer-silence diagnostic.
  const connB = fromEventConnection(eventB, {
    inactivityTimeoutMs: 20,
    inactivityHint: "check the peer's own logs",
  });
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("gone silent");
  expect((err as ConnectionError).message).toContain(
    "check the peer's own logs",
  );
});

test("fromEventConnection: the silence error carries no clause when no hint is supplied", async () => {
  const [, eventB] = makeEventConnections();
  // No hint: the bare diagnostic, unchanged. This pins that a transport which
  // supplies none (e.g. WebRTC) is not given file-sync guidance.
  const connB = fromEventConnection(eventB, { inactivityTimeoutMs: 20 });
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).message).toMatch(/gone silent$/);
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
// docs/spec/FILE_SYNC.md invariant I8 makes a non-throwing `data` consumer
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

  // The frames buffered before the overflow ("1"/"2") drain first under the
  // abnormal-tail rule: receive() returns each already-arrived frame before the
  // latched protocol error surfaces.
  expect(await connB.receive()).toBe("1");
  expect(await connB.receive()).toBe("2");

  // Once the buffer is drained, the absorbed overflow surfaces as a sticky
  // terminal protocol error -- confirming the consumer latched rather than
  // threw, and that the latch is sticky across further calls.
  const err = await connB.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
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

// --- send-liveness (the encrypt-then-send window) ----------------------------
// A parked receive() keeps the ref'd idle timer armed, so a silent peer is
// caught. The sender's encrypt-then-send window parks no receive(), so before
// this guard a transport hand-off that orphaned (its callback never firing, all
// lower per-op deadlines `.unref()`'d) let the event loop drain to a silent
// exit 0. These pin that a send now holds a ref'd guard across the hand-off and
// clears it on every settlement/terminal path.

test("send: an orphaned hand-off with no parked receive fails terminally, not silently", async () => {
  const { conn, send } = makeQueued({ inactivityTimeoutMs: 20 });
  // The transport accepts the write but never resolves -- a mid-exchange drop in
  // the encrypt-then-send window, where no receive() is parked to keep the idle
  // timer armed. Before the guard this call would hang and the loop drain to
  // exit 0; now it must reject terminally.
  send.mockReturnValue(new Promise(() => {}));
  const err = await conn.send("x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain(
    "lost during the exchange",
  );
  // The failure latches terminal: later calls fail fast on the same state.
  await expect(conn.receive()).rejects.toBeInstanceOf(ConnectionError);
  await expect(conn.send("y")).rejects.toBeInstanceOf(ConnectionError);
});

test("send: a transport rejection surfaces its own cause, not the liveness backstop", async () => {
  const { conn, send } = makeQueued({ inactivityTimeoutMs: 10_000 });
  // The guard holds the loop open so a lower, faster per-operation deadline (or a
  // socket error) rejects the hand-off first with its transport-specific cause,
  // well before the coarse core backstop would; that specific cause must win.
  send.mockRejectedValue(new Error("SFTP file write of /x stalled"));
  const err = await conn.send("x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain(
    "SFTP file write of /x stalled",
  );
});

test("send: a completed hand-off leaves no liveness guard armed", async () => {
  vi.useFakeTimers();
  try {
    const { conn, send } = makeQueued({ inactivityTimeoutMs: 20 });
    send.mockResolvedValue(undefined);
    await conn.send("x");
    // Cleared the instant the hand-off settles: a healthy send leaves no ref'd
    // timer to hold the event loop open at teardown.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("send: a close during an in-flight hand-off rejects the send and clears the guard", async () => {
  vi.useFakeTimers();
  try {
    const { conn, send } = makeQueued({ inactivityTimeoutMs: 20 });
    send.mockReturnValue(new Promise(() => {})); // hand-off never settles
    // Attach the handler synchronously so the pending rejection is never briefly
    // unhandled once close() settles it.
    const sending = conn.send("x").catch((e: unknown) => e);
    // Armed while the hand-off is outstanding...
    expect(vi.getTimerCount()).toBe(1);
    await conn.close();
    // ...and the explicit (cancelled-exchange) close SETTLES the awaited send --
    // rejecting it as a cancelled "closed" operation rather than leaving it to
    // hang on the orphaned hand-off -- and leaves no ref'd handle to hold the
    // loop open. Clearing the guard timer without rejecting here would reinstate
    // the very silent-hang this guard exists to prevent.
    const err = await sending;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("send: a concurrent transport fail rejects an in-flight hand-off", async () => {
  const { conn, controls, send } = makeQueued({ inactivityTimeoutMs: 10_000 });
  send.mockReturnValue(new Promise(() => {})); // hand-off orphans, never settles
  const sending = conn.send("x").catch((e: unknown) => e);
  // A terminal transition (an inbound-overflow fail(), a transport error, or a
  // peer half-close) fires while the hand-off is still outstanding. The send
  // must be rejected here with the terminal cause, not left hanging with its
  // guard swept -- the racing-teardown gap the guard would otherwise reopen.
  controls.fail(new ConnectionError("dropped mid-send", "transport"));
  const err = await sending;
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("dropped mid-send");
});

test("send: a half-close (finish) draining a buffered frame rejects an in-flight hand-off", async () => {
  const { conn, controls, send } = makeQueued({ inactivityTimeoutMs: 10_000 });
  send.mockReturnValue(new Promise(() => {})); // hand-off orphans, never settles
  // A buffered inbound frame makes finish() take its draining branch (not the
  // empty-queue delegation to fail()), so this exercises the failSends() call on
  // that distinct path specifically.
  controls.deliver("buffered");
  const sending = conn.send("x").catch((e: unknown) => e);
  controls.finish(new ConnectionError("peer closed mid-send", "transport"));
  // The in-flight send rejects with the deferred error rather than hanging: the
  // peer has gone, so the write can never complete.
  const err = await sending;
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("peer closed mid-send");
  // Half-close semantics are preserved: the buffered frame still drains before
  // the deferred error surfaces to receive().
  expect(await conn.receive()).toBe("buffered");
});

test("send: with no inactivity budget arms no liveness guard", async () => {
  vi.useFakeTimers();
  try {
    // No inactivityTimeoutMs (the low-level QueuedMessageConnection, as
    // createMessagePipe builds): the hand-off is returned directly with no guard
    // timer, the send-side parity of a parked receive() getting no bound there.
    const { conn, send } = makeQueued();
    send.mockResolvedValue(undefined);
    await conn.send("x");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
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

// --- parseOrProtocolError ----------------------------------------------------
// The send-before-parse half of receiveParsed: the two direct `.parse()` sites
// (participant.ts numberArrayMessage, link.ts associationAndIterationArray) must
// receive a frame, acknowledge it, then parse, so they call this rather than
// receiveParsed. It surfaces a parse failure as the same clean
// ConnectionError("protocol") -- never the validator's raw throw escaping bare.

test("parseOrProtocolError: returns the validated value on success", () => {
  const schema = z.object({ n: z.number() });
  expect(parseOrProtocolError(schema, { n: 42 })).toEqual({ n: 42 });
});

test("parseOrProtocolError: a malformed value throws a protocol ConnectionError", () => {
  const schema = z.object({ n: z.number() });
  let err: unknown;
  try {
    parseOrProtocolError(schema, { n: "not a number" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  // The validator's failure is preserved as the cause.
  expect((err as ConnectionError).cause).toBeInstanceOf(z.ZodError);
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
