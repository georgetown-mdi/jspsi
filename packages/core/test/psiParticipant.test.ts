import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  associationTableMessage,
  numberArrayMessage,
} from "../src/participant";

import {
  createMessagePipe,
  receiveParsed,
  parseOrProtocolError,
  ConnectionError,
} from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";
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

// ─── association-table wire message: pathological-count bound ─────────────────
// The association table is partner-controlled (the PPRL threat model treats the
// counterparty as adversarial) and rides the ~512 MiB exchange frame. An inner
// index array of hundreds of thousands of invalid elements overflowed Zod's call
// stack spreading one issue per element up through the array/tuple frames
// (RangeError). receiveParsed always surfaces a parse failure as a clean
// ConnectionError("protocol"); the single-issue validators make the cause a
// bounded validation error rather than that RangeError.

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

// ─── numberArrayMessage: direct-`.parse()` send-before-parse site ─────────────
// The joiner's final received frame -- the starter's original-index list -- is
// read by a direct `parseOrProtocolError(numberArrayMessage, ...)` AFTER the
// status acknowledgement is sent (so a malformed frame cannot strand the
// partner). It is the one residual flat array read off a direct `.parse()`
// rather than receiveParsed, so before the single-issue bound a pathological
// count surfaced a BARE RangeError instead of a clean ConnectionError.

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

// ─── PSI decode element-count guard: frame-bytes vs element-count amplification ─
// A malicious partner can pack a PSI setup / request / response with many minimal
// (~2-byte) repeated encrypted-element entries -- staying within the frame byte
// cap, yet declaring far more curve points than the cap's ~40-byte-per-value
// sizing assumes. Each entry becomes a curve point when the message is handed to
// the library, so the participant validates the declared element count against the
// authenticated keyCount * recordCount bound at the deserializeBinary seam and
// aborts BEFORE that materialization. These craft such an over-declared frame (a
// handful of 2-byte entries, so a ~tens-of-bytes frame -- orders of magnitude
// under any byte cap) and assert the abort. The bound is tightened to a small
// value to stand in for a real authenticated count.

// A tiny encrypted-element list whose declared count far exceeds any bound the
// tests set, in a frame of only a few dozen bytes.
const OVER_DECLARED_COUNT = 64;
const tinyElements = () =>
  Array.from({ length: OVER_DECLARED_COUNT }, () => new Uint8Array([1, 2]));

test("processClientRequest rejects a request declaring more elements than the bound", () => {
  // Single-pass sender seam: the starter deserializes the receiver's request.
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
  expect(() => sender.processClientRequest(bytes)).toThrow(
    /request declares 64 encrypted element\(s\), exceeding the authenticated bound of 4/,
  );
});

test("computeValueMatches rejects a setup declaring more elements than the bound", () => {
  // Single-pass receiver seam (setup): the joiner deserializes the sender's setup.
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
  expect(() =>
    receiver.computeValueMatches(setup.serializeBinary(), response),
  ).toThrow(/server setup declares 64 encrypted element\(s\)/);
});

test("computeValueMatches rejects a response declaring more elements than the bound", () => {
  // Single-pass receiver seam (response): a within-bound setup, an over-declared
  // response, so the response check is what fires.
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
  expect(() =>
    receiver.computeValueMatches(
      setup.serializeBinary(),
      response.serializeBinary(),
    ),
  ).toThrow(/response declares 64 encrypted element\(s\)/);
});

test("cascade identifyIntersection (starter) rejects an over-declared request frame", async () => {
  // Cascade decode path shares the same seam: inject an over-declared request as
  // the frame the starter deserializes (its 1st receive) and assert it aborts
  // before processing it. The bound stands in for the authenticated
  // keyCount * receiverRecordCount.
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
    /request declares 64 encrypted element\(s\), exceeding the authenticated bound of 4/,
  );
});

test("cascade identifyIntersection (joiner) rejects an over-declared server setup frame", async () => {
  // The mirror seam: the joiner deserializes the sender's server setup on its 1st
  // receive. An over-declared setup aborts before curve-point materialization.
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
    /server setup declares 64 encrypted element\(s\), exceeding the authenticated bound of 4/,
  );
});

// ─── Non-Raw server setup: the element-count guard cannot be bypassed ──────────
// This protocol only ever sends a Raw server setup. A setup whose data-structure
// oneof is anything other than Raw -- or is left unset -- has `getRaw()` undefined,
// so its declared element count would be a benign 0 that slips past the bound,
// then hands a non-Raw structure to the reveal-intersection path, which aborts
// with a cryptic library error. The participant instead rejects a non-Raw setup
// with a clean protocol abort, so the guard is fail-closed on an unexpected
// structure regardless of the bound.

// A well-formed server setup with no data structure set: its `getRaw()` is
// undefined, the generic non-Raw case the guard rejects.
function nonRawServerSetupBytes(): Uint8Array {
  return new psiLibrary.serverSetup().serializeBinary();
}

test("computeValueMatches rejects a non-Raw server setup", () => {
  // Single-pass receiver seam: UNBOUNDED bounds, so it is the Raw check -- not the
  // element-count bound -- that fires.
  const receiver = new PSIParticipant(
    "receiver",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const response = new psiLibrary.response().serializeBinary();
  expect(() =>
    receiver.computeValueMatches(nonRawServerSetupBytes(), response),
  ).toThrow(/server setup is not a Raw data structure/);
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
