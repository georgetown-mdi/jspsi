import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant, associationTableMessage } from "../src/participant";

import {
  createMessagePipe,
  receiveParsed,
  ConnectionError,
} from "../src/connection/messageConnection";
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
