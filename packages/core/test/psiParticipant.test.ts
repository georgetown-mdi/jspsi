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

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = new PSIParticipant("server", psiLibrary, {
  role: "starter",
  verbose: 0,
});

const client = new PSIParticipant("client", psiLibrary, {
  role: "joiner",
  verbose: 0,
});

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
  const starter = new PSIParticipant("starter", psiLibrary, {
    role: "starter",
    verbose: 0,
  });
  const joiner = new PSIParticipant("joiner", psiLibrary, {
    role: "joiner",
    verbose: 0,
  });
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
