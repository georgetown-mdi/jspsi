/// <reference types="@vitest/browser-playwright/context" />

import { beforeAll, expect, inject, test } from "vitest";

import Peer from "peerjs";

import { prepareForExchange, runExchange } from "@psilink/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import { sortAssociationTable } from "../utils/associationTable.js";

import type { DataConnection } from "peerjs";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

interface AddressInfo {
  address: string;
  family: string;
  port: number;
}

const addressInfo: AddressInfo = {
  address: "127.0.0.1",
  family: "IpV4",
  // The `browser` project's globalSetup publishes the port it launched the dev
  // server on (browser tests run in Chromium and cannot read `process.env`), so
  // the probe and exchange below cannot drift from the running server. Falls
  // back to the Vite default when this file is run without that setup.
  port: inject("webDevServerPort") ?? 3000,
};
const protocol = "http:";

const hostString =
  `${protocol}//${addressInfo.address}` +
  `${addressInfo.port ? ":" + addressInfo.port.toString() : ""}`;

const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

// Probe the PeerJS coordination server with a short timeout. The `browser`
// vitest project stands this server up via the dev-server globalSetup, so a
// normal `test:browser` run finds it. Running this file directly without that
// setup leaves it down -- in which case this suite skips rather than failing.
// Reachability is decided here, inside a hook, never at module scope: the
// networked exchange below used to run during import, where a "Failed to fetch"
// took down the entire browser project (0 tests collected), hiding the
// server-less vector suites (canonical, exchangeRecord) that share it.
async function canReachServer(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(`${hostString}/`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const serverRows = [
  { first_name: "Alice" },
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "David" },
  { first_name: "Elizabeth" },
  { first_name: "Frank" },
  { first_name: "Greta" },
];
const clientRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];

// The default linkage-key templates all require SSN/DOB/lastName combinations,
// so none survive filtering for a firstName-only dataset. Provide one explicit
// key so both parties produce valid, matching linkage terms.
const firstNameOnlyTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "firstName" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// Undefined until a reachable server lets beforeAll run the exchange; the tests
// gate on this, so an unreachable server skips rather than reading a stale or
// absent result.
let serverResult: ReturnType<typeof sortAssociationTable> | undefined;
let clientResult: ReturnType<typeof sortAssociationTable> | undefined;

// Generous timeout: peer coordination, the WASM load, and the round-trip
// exchange all happen here. Previously this ran at module scope with no bound;
// the hook timeout now turns a stuck server into a clear failure, not a hang.
beforeAll(async () => {
  const reachable = await canReachServer();
  if (!reachable) return;

  const session = await (async () => {
    const response = await fetch(`${hostString}/api/psi/create`, {
      method: "POST",
      body: JSON.stringify({
        initiatedName: "Test Server",
        invitedName: "Test Code",
        description: "Testing invited",
      }),
    });
    return await response.json();
  })();

  const clientPeer: Peer = await (() => {
    return new Promise((resolve, reject) => {
      const peer = new Peer({
        host: addressInfo.address,
        path: "/api/",
        port: addressInfo.port,
      });
      peer.on("open", (id: string) => {
        fetch(`${hostString}/api/psi/${session["uuid"]}`, {
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify({
            invitedPeerId: id,
          }),
        }).then((response) => {
          if (!response.ok) {
            reject(
              new Error(
                `error posting peer id: ${response.status}, text: ${response.statusText}`,
              ),
            );
          } else {
            resolve(peer);
          }
        });
      });
    });
  })();

  const clientConnPromise: Promise<DataConnection> = (() => {
    return new Promise((resolve) => {
      clientPeer.on("connection", (conn) => {
        conn.on("open", () => {
          resolve(conn);
        });
      });
    });
  })();

  const clientPeerId: string = await (() => {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(
        `${hostString}/api/psi/${session.uuid}/wait`,
        { withCredentials: false },
      );

      eventSource.addEventListener("message", (ev: MessageEvent<any>) => {
        try {
          const messageData = ev.data && JSON.parse(ev.data);
          if (!("invitedPeerId" in messageData)) {
            throw new Error("unexpected message from server: " + ev.data);
          } else {
            const invitedPeerId = messageData["invitedPeerId"];
            eventSource.close();
            resolve(invitedPeerId);
          }
        } catch (err) {
          eventSource.close();
          reject(err);
        }
      });

      eventSource.addEventListener("error", (ev: Event) => {
        eventSource.close();
        reject(new Error("EventSource connection error:" + JSON.stringify(ev)));
      });
    });
  })();

  const [serverPeer, serverConn]: [Peer, DataConnection] = await (async () => {
    return new Promise((resolve, reject) => {
      const peer = new Peer({
        host: addressInfo.address,
        path: "/api/",
        port: addressInfo.port,
      });
      peer.on("open", () => {
        const conn = peer.connect(clientPeerId, { reliable: true });
        resolve([peer, conn]);
      });

      peer.on("error", (err) => reject(err));
    });
  })();

  const psiLibrary = await (PSI() as Promise<PSILibrary>);

  const clientConn = await clientConnPromise;

  const serverPrepared = prepareForExchange(
    { linkageTerms: { ...firstNameOnlyTerms, identity: "server" } },
    "server",
    serverRows,
    ["first_name"],
  );
  const clientPrepared = prepareForExchange(
    { linkageTerms: { ...firstNameOnlyTerms, identity: "client" } },
    "client",
    clientRows,
    ["first_name"],
  );

  const serverMc = await openPeerMessageConnection(serverConn);
  const clientMc = await openPeerMessageConnection(clientConn);

  const runServerPSI = async () => {
    const { associationTable } = await runExchange(
      serverMc,
      "responder",
      serverPrepared,
      { psiLibrary },
    );
    return associationTable;
  };

  const runClientPSI = async () => {
    const { associationTable } = await runExchange(
      clientMc,
      "initiator",
      clientPrepared,
      { psiLibrary },
    );
    return associationTable;
  };

  const [rawServerResult, rawClientResult] = await Promise.all([
    runServerPSI(),
    runClientPSI(),
  ]);

  await serverMc.close();
  await clientMc.close();
  serverPeer.disconnect();
  clientPeer.disconnect();

  serverResult = sortAssociationTable(rawServerResult);
  clientResult = sortAssociationTable(rawClientResult, true);
}, 60_000);

test("server and client yield identical results", (ctx) => {
  if (!serverResult || !clientResult) return ctx.skip(serverUnreachableNote);
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("psi yields correct results", (ctx) => {
  if (!serverResult) return ctx.skip(serverUnreachableNote);
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
});
