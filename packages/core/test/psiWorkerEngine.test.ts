import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI, linkViaSinglePassPSI } from "../src/link";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../src/psiWorkerEngine";
import type { Config } from "../src/types";
import { sortAssociationTable } from "../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

const psiLibrary = await PSI();

// A WorkerPsiEngine wired to an in-process dispatcher instead of a real thread, so
// the request/response protocol, id correlation, and (via structuredClone at the
// boundary) the clonability of everything that crosses it are all exercised without
// spawning a worker. structuredClone is what a real worker's postMessage does, so a
// value that is not clonable -- a live library handle leaking across the seam --
// would throw here exactly as it would in production.
function inProcessWorkerEngine(
  role: Config["role"],
  id: string,
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(psiLibrary, { role, id }, (response) =>
    deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
}

function workerParticipant(
  id: string,
  role: "starter" | "joiner",
): PSIParticipant {
  return new PSIParticipant(
    id,
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    undefined,
    inProcessWorkerEngine(role, id),
  );
}

// The same inputs and known-correct result as the in-process cascade in
// psiLink.test.ts; a worker-backed exchange must reproduce them exactly.
const serverData = [
  ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
  ["1", "2", "1", "1", "1", "1", "1"],
];
const clientData = [
  ["Carol", "Elizabeth", "Henry"],
  ["3", "3", "2"],
];

test("a worker-backed cascade exchange yields the correct result", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const server = workerParticipant("server", "starter");
  const client = workerParticipant("client", "joiner");

  const [serverResultRaw, clientResultRaw] = await Promise.all([
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
  const serverResult = sortAssociationTable(serverResultRaw);
  const clientResult = sortAssociationTable(clientResultRaw, true);

  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
  // Both parties agree.
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("a worker-backed single-pass exchange yields the correct result", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const server = workerParticipant("server", "starter");
  const client = workerParticipant("client", "joiner");

  const [serverResultRaw, clientResultRaw] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      clientData[0].length,
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      serverData[0].length,
      false,
      -1,
    ),
  ]);
  const serverResult = sortAssociationTable(serverResultRaw);
  const clientResult = sortAssociationTable(clientResultRaw, true);

  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("an engine error propagates across the worker boundary", async () => {
  const engine = inProcessWorkerEngine("joiner", "receiver");
  // A well-formed server setup with no data structure set: the engine's Raw-check
  // must reject, and the rejection must survive the round trip.
  const nonRaw = new psiLibrary.serverSetup().serializeBinary();
  await expect(engine.receiveServerSetup(nonRaw)).rejects.toThrow(
    /server setup is not a Raw data structure/,
  );
});

test("dispose rejects pending calls and terminates the worker", async () => {
  let terminated = false;
  // A handle that never replies, so the call stays pending until dispose settles it.
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: () => {},
    terminate: () => {
      terminated = true;
    },
  };
  const engine = new WorkerPsiEngine(handle);

  const pending = engine.createClientRequest(["x"]);
  engine.dispose();

  await expect(pending).rejects.toThrow(/disposed/);
  expect(terminated).toBe(true);
  // A call after dispose fails fast rather than posting to a terminated worker.
  await expect(engine.createClientRequest(["y"])).rejects.toThrow(/disposed/);
});

test("a worker error fails every outstanding call", async () => {
  let fireError: (error: unknown) => void = () => {};
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  const pending = engine.createServerSetup(["a", "b"]);
  fireError(new Error("worker exited unexpectedly"));

  await expect(pending).rejects.toThrow(/worker exited unexpectedly/);
});

test("a call after a worker error fails fast with the crash cause", async () => {
  let fireError: (error: unknown) => void = () => {};
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  fireError(new Error("worker exited unexpectedly"));

  // A fresh call must reject immediately with the crash cause, not hang waiting
  // for a reply from the dead worker.
  await expect(engine.createServerSetup(["a"])).rejects.toThrow(
    /worker exited unexpectedly/,
  );
});

test("a second concurrent call is rejected as a lockstep violation", async () => {
  const handle: PsiWorkerHandle = {
    // Never replies, so the first request stays in flight.
    postMessage: () => {},
    setHandlers: () => {},
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  void engine.createServerSetup(["a"]);
  await expect(engine.createClientRequest(["b"])).rejects.toThrow(/lockstep/);
});
