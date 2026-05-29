import { expect, test } from "vitest";

import {
  ConnectionError,
  createMessagePipe,
  fromEventConnection,
} from "../src/connection/messageConnection";
import {
  preparePayload,
  exchangePayloadsOverMessages,
} from "../src/payloadExchange";

import type { Metadata } from "../src/config/metadata";

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

// --- exchangePayloadsOverMessages --------------------------------------------

const metaWithId: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "patient_id",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

const metaNoId: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

const rawRows = [
  { ssn: "001", patient_id: "P0", diagnosis: "A" },
  { ssn: "002", patient_id: "P1", diagnosis: "B" },
  { ssn: "003", patient_id: "P2", diagnosis: "C" },
  { ssn: "004", patient_id: "P3", diagnosis: "D" },
];

test("exchangePayloadsOverMessages: each party receives the other's payload", async () => {
  const [connA, connB] = createMessagePipe();
  const payloadA = preparePayload(rawRows, metaWithId, [
    [0, 2],
    [1, 3],
  ]);
  const payloadB = preparePayload(rawRows, metaNoId, [
    [1, 3],
    [0, 2],
  ]);

  const [receivedByA, receivedByB] = await Promise.all([
    exchangePayloadsOverMessages(connA, "initiator", payloadA),
    exchangePayloadsOverMessages(connB, "responder", payloadB),
  ]);

  expect(receivedByB.columns).toEqual(["patient_id", "diagnosis"]);
  expect(receivedByB.rowIndices).toEqual([0, 2]);
  expect(receivedByB.rows).toEqual([
    ["P0", "A"],
    ["P2", "C"],
  ]);
  expect(receivedByA.columns).toEqual(["diagnosis"]);
  expect(receivedByA.rowIndices).toEqual([1, 3]);
  expect(receivedByA.rows).toEqual([["B"], ["D"]]);
});

test("exchangePayloadsOverMessages: empty payloads from both parties", async () => {
  const [connA, connB] = createMessagePipe();
  const empty = preparePayload(rawRows, metaWithId, [[], []]);

  const [a, b] = await Promise.all([
    exchangePayloadsOverMessages(connA, "initiator", empty),
    exchangePayloadsOverMessages(connB, "responder", empty),
  ]);

  expect(a).toEqual({ columns: [], rowIndices: [], rows: [] });
  expect(b).toEqual({ columns: [], rowIndices: [], rows: [] });
});

test("exchangePayloadsOverMessages: malformed partner data rejects", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = exchangePayloadsOverMessages(connA, "initiator", {
    hasData: false,
  });
  // Responder replies with garbage instead of a valid payload message.
  await connB.receive();
  await connB.send({ unexpected: true });
  await expect(initiator).rejects.toThrow();
});

test("exchangePayloadsOverMessages: a mid-exchange transport drop rejects", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = exchangePayloadsOverMessages(connB, "responder", {
    hasData: false,
  });
  // Initiator never sends; the link drops instead.
  await connA.close();
  const err = await responder.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
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

test("fromEventConnection: runs the exchange over an event-based Connection", async () => {
  const [eventA, eventB] = makeEventConnections();
  const connA = fromEventConnection(eventA);
  const connB = fromEventConnection(eventB);

  const payloadA = preparePayload(rawRows, metaWithId, [[0], [1]]);
  const payloadB = preparePayload(rawRows, metaNoId, [[1], [0]]);

  const [receivedByA, receivedByB] = await Promise.all([
    exchangePayloadsOverMessages(connA, "initiator", payloadA),
    exchangePayloadsOverMessages(connB, "responder", payloadB),
  ]);

  expect(receivedByB.columns).toEqual(["patient_id", "diagnosis"]);
  expect(receivedByA.columns).toEqual(["diagnosis"]);
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
