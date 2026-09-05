import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  associationTableMessage,
  numberArrayMessage,
} from "../src/participant";
import { InProcessPsiEngine } from "../src/psiEngine";

import {
  createMessagePipe,
  receiveParsed,
  parseOrProtocolError,
  ConnectionError,
} from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import { sortAssociationTable } from "../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = new PSIParticipant(
  "server",
  psiLibrary,
  { role: "starter", verbose: 0 },
  UNBOUNDED_PSI_ELEMENTS,
);

const client = new PSIParticipant(
  "client",
  psiLibrary,
  { role: "joiner", verbose: 0 },
  UNBOUNDED_PSI_ELEMENTS,
);

const serverData = [
  "Alice",
  "Bob",
  "Carol",
  "David",
  "Elizabeth",
  "Frank",
  "Greta",
];

const clientData = ["Carol", "Elizabeth", "Henry"];

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
    server.identifyIntersection(serverConn, serverData),
    client.identifyIntersection(clientConn, clientData),
  ]);
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test("server and client yield identical results", () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("psi yields correct results", () => {
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
});

[clientResult, serverResult] = await (async () => {
  return await Promise.all([
    client.identifyIntersection(clientConn, clientData),
    server.identifyIntersection(serverConn, serverData),
  ]);
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test("order doesn't matter", () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
});

// --- association-table wire message: pathological-count bound -----------------
// The association table is partner-controlled (the PPRL threat model
// treats the counterparty as adversarial) and rides the ~512 MiB exchange
// frame. An inner index array of hundreds of thousands of invalid elements
// overflowed Zod's call stack, spreading one issue per element up through
// the array/tuple frames (RangeError). receiveParsed always reports a
// parse failure as a clean ConnectionError("protocol"), so the
// single-issue validators make the cause a bounded validation error instead.

test("a pathological-count association table fails cleanly, not with a RangeError", async () => {
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationTableMessage);
  // ~300k invalid (non-number) inner elements, well past the ~130k overflow
  // threshold the unbounded `z.array(z.number())` schema would hit.
  await connB.send([Array.from({ length: 300_000 }, () => "x"), []]);
  const err = await parsed.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("a legitimately large association table parses", async () => {
  // The intersection is legitimately in the millions; a count `.max()` would
  // reject it, the single-issue validators do not. 200k clears the overflow
  // threshold, so a VALID large table never trips the bound.
  const n = 200_000;
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationTableMessage);
  const indices = Array.from({ length: n }, (_, i) => i);
  await connB.send([indices, indices]);
  const [first, second] = await parsed;
  expect(first).toHaveLength(n);
  expect(second).toHaveLength(n);
});

// --- numberArrayMessage: direct-`.parse()` send-before-parse site -------------

// Replaces the value the Nth receive() on `conn` resolves with, leaving the send
// path and every other receive untouched. The real frame is still drained from
// the underlying connection so the pipe stays in lockstep.
function corruptNthReceive(
  conn: MessageConnection,
  n: number,
  replacement: unknown,
): MessageConnection {
  let count = 0;
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) => {
      count += 1;
      const real = await conn.receive(timeoutMs);
      return count === n ? replacement : real;
    },
    close: () => conn.close(),
  };
}

test("joiner: a pathological-count final frame fails cleanly, not with a bare RangeError", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const starter = new PSIParticipant(
    "starter",
    psiLibrary,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const joiner = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  // ~4M invalid (non-number) elements, past the ~3.5M `Invalid string length`
  // threshold the unbounded `z.array(z.number())` schema hit (a ~4.5s CPU burn
  // then a bare RangeError). The joiner's 3rd receive is the final original-index
  // frame parsed at the direct-`.parse()` site; replacing it drives the joiner to
  // parse a pathological array while the real exchange otherwise proceeds.
  const pathological = Array.from({ length: 4_000_000 }, () => "x");
  const [starterOutcome, joinerOutcome] = await Promise.allSettled([
    starter.identifyIntersection(serverConn, ["Alice", "Carol"]),
    joiner.identifyIntersection(
      corruptNthReceive(clientConn, 3, pathological),
      ["Carol"],
    ),
  ]);
  // The joiner acknowledges (status:completed) before parsing, so the starter
  // completes; only the joiner's direct parse rejects.
  expect(starterOutcome.status).toBe("fulfilled");
  expect(joinerOutcome.status).toBe("rejected");
  const err = (joinerOutcome as PromiseRejectedResult).reason;
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("a legitimately large original-index frame parses", () => {
  // The original-index list is bounded only by the frame cap, legitimately in
  // the millions; 200k clears the overflow threshold, so a VALID large frame is
  // never rejected by the single-issue bound.
  const n = 200_000;
  const valid = Array.from({ length: n }, (_, i) => i);
  expect(parseOrProtocolError(numberArrayMessage, valid)).toHaveLength(n);
});

// --- PSI decode element-count guard: frame-bytes vs element-count amplification -
// A malicious partner can pack minimal (~2-byte) repeated encrypted-element entries
// within the frame byte cap while declaring far more elements than legitimate;
// deserializeBinary allocates one heap object per declared entry, exhausting memory.
// The participant scans the wire format and rejects an over-declared frame before
// deserializing (connection/psiElementScan.ts), with a ceiling of min(authenticated
// keyCount * recordCount, MAX_PSI_DECODE_ELEMENTS). These tests craft such a frame
// and assert the pre-scan's abort message, with the bound tightened to stand in for
// a real count.

// A tiny encrypted-element list whose declared count far exceeds any bound the
// tests set, in a frame of only a few dozen bytes.
const OVER_DECLARED_COUNT = 64;
const tinyElements = () =>
  Array.from({ length: OVER_DECLARED_COUNT }, () => new Uint8Array([1, 2]));

test("processClientRequest rejects a request declaring more elements than the bound", async () => {
  // Single-pass sender boundary: the starter would deserialize the
  // receiver's request.
  const sender = new PSIParticipant(
    "sender",
    psiLibrary,
    { role: "starter", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, request: 4 },
  );
  const request = new psiLibrary.request();
  request.setEncryptedElementsList(tinyElements());
  const bytes = request.serializeBinary();
  // The over-declared frame is a few dozen bytes, far within any byte cap, yet
  // declares 64 elements against a bound of 4.
  expect(bytes.byteLength).toBeLessThan(1024);
  // deserializeBinary is the amplifying allocation, so the guard must fire BEFORE
  // it. Spy on it and assert it is never reached -- this pins the pre-deserialize
  // ordering as a runtime check, not an inference from statement order.
  const deserialize = vi.spyOn(psiLibrary.request, "deserializeBinary");
  try {
    await expect(sender.processClientRequest(bytes)).rejects.toThrow(
      /inbound PSI request declares more than 4 encrypted element\(s\)/,
    );
    expect(deserialize).not.toHaveBeenCalled();
  } finally {
    deserialize.mockRestore();
  }
});

test("computeValueMatches rejects a setup declaring more elements than the bound", async () => {
  // Single-pass receiver boundary (setup): the joiner would deserialize
  // the sender's setup.
  const receiver = new PSIParticipant(
    "receiver",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, setup: 4 },
  );
  const setup = new psiLibrary.serverSetup();
  const raw = new psiLibrary.serverSetup.RawInfo();
  raw.setEncryptedElementsList(tinyElements());
  setup.setRaw(raw);
  // The response is never reached (the setup check fires first), so a trivial one
  // suffices.
  const response = new psiLibrary.response().serializeBinary();
  await expect(
    receiver.computeValueMatches(setup.serializeBinary(), response),
  ).rejects.toThrow(
    /inbound PSI serverSetup declares more than 4 encrypted element\(s\)/,
  );
});

test("computeValueMatches rejects a response declaring more elements than the bound", async () => {
  // Single-pass receiver boundary (response): a within-bound setup, an
  // over-declared response, so the response check is what fires.
  const receiver = new PSIParticipant(
    "receiver",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, response: 4 },
  );
  const setup = new psiLibrary.serverSetup();
  const raw = new psiLibrary.serverSetup.RawInfo();
  raw.setEncryptedElementsList([new Uint8Array([1, 2])]);
  setup.setRaw(raw);
  const response = new psiLibrary.response();
  response.setEncryptedElementsList(tinyElements());
  await expect(
    receiver.computeValueMatches(
      setup.serializeBinary(),
      response.serializeBinary(),
    ),
  ).rejects.toThrow(
    /inbound PSI response declares more than 4 encrypted element\(s\)/,
  );
});

test("cascade identifyIntersection (starter) rejects an over-declared request frame", async () => {
  // Cascade decode path shares the same boundary: inject an over-declared
  // request as the frame the starter reads (its 1st receive) and assert it
  // aborts before deserializing it. The bound stands in for the
  // authenticated keyCount * receiverRecordCount.
  const [serverConn, clientConn] = createMessagePipe();
  const starter = new PSIParticipant(
    "starter",
    psiLibrary,
    { role: "starter", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, request: 4 },
  );
  const overDeclared = new psiLibrary.request();
  overDeclared.setEncryptedElementsList(tinyElements());
  const run = starter.identifyIntersection(
    corruptNthReceive(serverConn, 1, overDeclared.serializeBinary()),
    ["Alice", "Carol"],
  );
  // The starter sends its setup, then reads the client request (its 1st receive).
  // corruptNthReceive still awaits a real frame before substituting, so send any
  // frame from the peer to unblock it; the over-declared request stands in.
  await clientConn.send(new Uint8Array([0]));
  await expect(run).rejects.toThrow(
    /inbound PSI request declares more than 4 encrypted element\(s\)/,
  );
});

test("cascade identifyIntersection (joiner) rejects an over-declared server setup frame", async () => {
  // The mirror boundary: the joiner reads the sender's server setup on its
  // 1st receive. An over-declared setup aborts before it is deserialized.
  const [serverConn, clientConn] = createMessagePipe();
  const joiner = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, setup: 4 },
  );
  const setup = new psiLibrary.serverSetup();
  const raw = new psiLibrary.serverSetup.RawInfo();
  raw.setEncryptedElementsList(tinyElements());
  setup.setRaw(raw);
  const run = joiner.identifyIntersection(
    corruptNthReceive(clientConn, 1, setup.serializeBinary()),
    ["Carol"],
  );
  // The joiner reads the server setup first (its 1st receive); send any frame
  // from the peer to unblock it, and the over-declared setup stands in.
  await serverConn.send(new Uint8Array([0]));
  await expect(run).rejects.toThrow(
    /inbound PSI serverSetup declares more than 4 encrypted element\(s\)/,
  );
});

test("count-only countIntersection (joiner) rejects an over-declared response frame", async () => {
  // The count-only leg reaches the same amplifying deserialize the association-table
  // leg does -- partner-supplied response bytes -- so it gets the same
  // pre-deserialize bound. Without it the guard would be present for one disclosure
  // and absent for the other, on the same frame.
  const [serverConn, clientConn] = createMessagePipe();
  const joiner = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    { ...UNBOUNDED_PSI_ELEMENTS, response: 4 },
    new InProcessPsiEngine(psiLibrary, "joiner", "joiner", "count-only"),
  );
  const sender = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "sender",
    "count-only",
  );
  const { setup } = await sender.createServerSetup(["Alice", "Carol"]);
  const overDeclared = new psiLibrary.response();
  overDeclared.setEncryptedElementsList(tinyElements());
  // The joiner reads the setup (1st receive), sends its request, then reads the
  // response (2nd receive) -- the frame replaced here.
  const run = joiner.countIntersection(
    corruptNthReceive(clientConn, 2, overDeclared.serializeBinary()),
    ["Carol"],
  );
  await serverConn.send(setup);
  // Drain the joiner's request and unblock its 2nd receive; the
  // over-declared response stands in for whatever this frame holds.
  await serverConn.receive();
  await serverConn.send(new Uint8Array([0]));
  const deserialize = vi.spyOn(psiLibrary.response, "deserializeBinary");
  try {
    await expect(run).rejects.toThrow(
      /inbound PSI response declares more than 4 encrypted element\(s\)/,
    );
    expect(deserialize).not.toHaveBeenCalled();
  } finally {
    deserialize.mockRestore();
    joiner.dispose();
    sender.dispose();
  }
});

// --- Non-Raw server setup: the element-count guard cannot be bypassed ----------
// This protocol only ever sends a Raw server setup. A non-Raw or unset
// data-structure oneof has `getRaw()` undefined, so its declared element count is a
// benign 0 that slips past the bound, then reaches the reveal-intersection path as a
// cryptic library error. The participant instead rejects a non-Raw setup with a
// clean protocol abort, fail-closed regardless of the bound.

// A well-formed server setup with no data structure set: its `getRaw()` is
// undefined, the generic non-Raw case the guard rejects.
function nonRawServerSetupBytes(): Uint8Array {
  return new psiLibrary.serverSetup().serializeBinary();
}

test("computeValueMatches rejects a non-Raw server setup", async () => {
  // Single-pass receiver boundary: UNBOUNDED bounds, so it is the Raw
  // check -- not the element-count bound -- that fires.
  const receiver = new PSIParticipant(
    "receiver",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const response = new psiLibrary.response().serializeBinary();
  await expect(
    receiver.computeValueMatches(nonRawServerSetupBytes(), response),
  ).rejects.toThrow(/server setup is not a Raw data structure/);
});

test("cascade identifyIntersection (joiner) rejects a non-Raw server setup frame", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const joiner = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const run = joiner.identifyIntersection(
    corruptNthReceive(clientConn, 1, nonRawServerSetupBytes()),
    ["Carol"],
  );
  await serverConn.send(new Uint8Array([0]));
  await expect(run).rejects.toThrow(/server setup is not a Raw data structure/);
});
