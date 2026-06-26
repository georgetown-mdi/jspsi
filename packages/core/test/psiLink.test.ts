import { expect, test } from "vitest";

import log from "loglevel";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  associationAndIterationArray,
} from "../src/link";

import {
  createMessagePipe,
  receiveParsed,
  parseOrProtocolError,
  ConnectionError,
} from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = new PSIParticipant("server", psiLibrary, {
  role: "starter",
  verbose: -1,
});

const client = new PSIParticipant("client", psiLibrary, {
  role: "joiner",
  verbose: -1,
});

const serverData = [
  ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
  ["1", "2", "1", "1", "1", "1", "1"],
];

const clientData = [
  ["Carol", "Elizabeth", "Henry"],
  ["3", "3", "2"],
];

log.setLevel("DEBUG");

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      -1,
    ),
  ]);
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test("server and client yield identical results", () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("results are correct", () => {
  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
});

// ─── linkViaSinglePassPSI: scaffold stub fails closed ─────────────────────────
// The single-pass strategy's algorithm is implemented by the owner against this
// entry point; until then, selecting it must abort rather than silently fall
// back to the cascade. Pins that interim fail-closed contract.
test("single-pass linkage entry point is not yet implemented and fails closed", async () => {
  await expect(
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      -1,
    ),
  ).rejects.toThrow(/not yet implemented/);
});

// ─── associationAndIterationArray: pathological-count bound ───────────────────
// The mapped-elements frame exchanged in exchangeMappedElements is partner-
// controlled and rides the ~512 MiB exchange frame; its matched-record count is
// legitimately in the millions. A flat array of ~4M invalid elements made Zod
// throw `RangeError: Invalid string length` building its error string from one
// issue per element (a ~4.5s CPU burn). The single-issue validator caps that at
// one clean issue. The frame is read two ways -- via receiveParsed (sendFirst)
// and via a direct `parseOrProtocolError` (the !sendFirst send-before-parse
// path) -- and both must surface a clean ConnectionError("protocol").
const pathologicalPairs = () => Array.from({ length: 4_000_000 }, () => 1);

test("receiveParsed: a pathological-count mapped-elements frame fails cleanly", async () => {
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationAndIterationArray);
  await connB.send(pathologicalPairs());
  const err = await parsed.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("direct parse: a pathological-count mapped-elements frame fails cleanly, not with a bare RangeError", () => {
  let err: unknown;
  try {
    parseOrProtocolError(associationAndIterationArray, pathologicalPairs());
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("a legitimately large mapped-elements frame parses", async () => {
  // One pair per matched record, legitimately in the millions; 200k clears the
  // overflow threshold, so a VALID large frame never trips the single-issue
  // bound. The accepted shape is unchanged from the `z.object` schema it
  // replaced (finite theirIndex/iteration per pair).
  const n = 200_000;
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationAndIterationArray);
  await connB.send(
    Array.from({ length: n }, (_, i) => ({ theirIndex: i, iteration: 0 })),
  );
  expect(await parsed).toHaveLength(n);
});

test("a mapped-elements element that is an array (not a plain object) is rejected", () => {
  // z.object rejects an array outright, even one carrying theirIndex/iteration
  // own-properties; the single-issue predicate must too, so the set of accepted
  // messages is exactly the one the replaced `z.object` schema accepted. This is
  // unreachable over the JSON transport (an array cannot carry named own-
  // properties through serialization), but the exact-mirror contract holds
  // regardless -- it guards against the `!Array.isArray` check being dropped.
  const arrayElement = [] as unknown as Record<string, unknown>;
  arrayElement.theirIndex = 0;
  arrayElement.iteration = 0;
  let err: unknown;
  try {
    parseOrProtocolError(associationAndIterationArray, [arrayElement]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
});
