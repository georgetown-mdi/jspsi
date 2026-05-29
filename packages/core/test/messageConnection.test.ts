import { expect, test } from "vitest";
import { z } from "zod";

import {
  ConnectionError,
  createMessagePipe,
  fromEventConnection,
  receiveParsed,
} from "../src/connection/messageConnection";

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
