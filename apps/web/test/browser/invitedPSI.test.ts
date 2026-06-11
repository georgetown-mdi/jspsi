/// <reference types="@vitest/browser-playwright/context" />

import { beforeAll, expect, inject, test } from "vitest";

import Peer from "peerjs";

import {
  deriveRendezvousPeerId,
  generateSharedSecret,
  prepareForExchange,
  runExchange,
} from "@psilink/core";
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
  // The `browser` project's globalSetup publishes the port it probed/launched
  // the dev server on (browser tests run in Chromium and cannot read
  // `process.env`), so the probe and exchange below target that exact port
  // rather than a hardcoded guess. Falls back to the Vite default when this file
  // is run without that setup, where an unreachable server skips the suite.
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

/** Resolve once `peer` has registered with the broker (its `open` event). */
function peerOpened(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    peer.on("open", () => resolve());
    peer.on("error", reject);
  });
}

// Undefined until a reachable server lets beforeAll run the exchange; the tests
// gate on this, so an unreachable server skips rather than reading a stale or
// absent result.
let serverResult: ReturnType<typeof sortAssociationTable> | undefined;
let clientResult: ReturnType<typeof sortAssociationTable> | undefined;

// Generous timeout: peer coordination, the WASM load, and the round-trip
// exchange all happen here. The hook timeout turns a stuck server into a clear
// failure, not a hang.
beforeAll(async () => {
  const reachable = await canReachServer();
  if (!reachable) return;

  // The backend-free rendezvous: a fresh shared secret stands in for the
  // invitation, and both peer ids are derived from it -- no /api/psi/* session.
  // The inviter (PSI responder) listens on its derived id; the acceptor (PSI
  // initiator) dials it.
  const sharedSecret = generateSharedSecret();
  const inviterId = await deriveRendezvousPeerId(sharedSecret, "inviter");
  const acceptorId = await deriveRendezvousPeerId(sharedSecret, "acceptor");

  const inviterPeer = new Peer(inviterId, {
    host: addressInfo.address,
    path: "/api/",
    port: addressInfo.port,
  });
  await peerOpened(inviterPeer);

  // Listen for the acceptor's inbound connection before it dials.
  const inviterConnPromise: Promise<DataConnection> = new Promise(
    (resolve, reject) => {
      inviterPeer.on("connection", (conn) => {
        conn.on("open", () => resolve(conn));
      });
      inviterPeer.on("error", reject);
    },
  );

  // Acceptor dials the inviter's derived id directly (the inviter is already
  // listening, so there is no peer-unavailable retry to exercise here).
  const acceptorPeer = new Peer(acceptorId, {
    host: addressInfo.address,
    path: "/api/",
    port: addressInfo.port,
  });
  const acceptorConn: DataConnection = await new Promise((resolve, reject) => {
    acceptorPeer.on("open", () => {
      const conn = acceptorPeer.connect(inviterId, { reliable: true });
      conn.on("open", () => resolve(conn));
    });
    acceptorPeer.on("error", reject);
  });

  const psiLibrary = await (PSI() as Promise<PSILibrary>);

  const inviterConn = await inviterConnPromise;

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

  const serverMc = await openPeerMessageConnection(inviterConn);
  const clientMc = await openPeerMessageConnection(acceptorConn);

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
  inviterPeer.disconnect();
  acceptorPeer.disconnect();

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
