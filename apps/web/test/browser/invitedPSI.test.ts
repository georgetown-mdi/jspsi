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

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
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

/** Resolve once `peer` has registered with the broker (its `open` event).
 * Settles exactly once and detaches both listeners, so an `open` and an `error`
 * firing in the same tick cannot both resolve and reject the promise. */
function peerOpened(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      peer.off("open", onOpen);
      peer.off("error", onError);
      action();
    };
    const onOpen = () => settle(resolve);
    const onError = (err: unknown) =>
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    peer.once("open", onOpen);
    peer.once("error", onError);
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

  // Hermetic ICE: both peers run in one browser on one machine, so a loopback
  // host candidate is all they need. Configure no STUN/TURN, so the exchange
  // contacts no external server (PeerJS's default config would otherwise reach
  // public Google STUN, and on a runner with open egress Chromium would probe
  // it). This makes the loopback host candidate the only one available, which is
  // exactly why the browser project disables Chromium's mDNS host-candidate
  // obfuscation (see vite.config.ts); without that the candidate is an
  // unresolvable `.local` name and the connection cannot open. Production
  // configures real STUN for cross-network peers (src/psi/rendezvous.ts).
  const inviterPeer = new Peer(inviterId, {
    host: addressInfo.address,
    path: "/api/",
    port: addressInfo.port,
    config: { iceServers: [] },
  });
  await peerOpened(inviterPeer);

  // Listen for the acceptor's inbound connection before it dials. Settles once
  // and detaches both listeners, so a late post-open peer error cannot reject
  // after the promise has resolved (which would leak into the runner).
  const inviterConnPromise: Promise<DataConnection> = new Promise(
    (resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        inviterPeer.off("connection", onConnection);
        inviterPeer.off("error", onError);
        action();
      };
      const onConnection = (conn: DataConnection) =>
        conn.once("open", () => settle(() => resolve(conn)));
      const onError = (err: unknown) =>
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      inviterPeer.on("connection", onConnection);
      inviterPeer.on("error", onError);
    },
  );

  // Acceptor dials the inviter's derived id directly (the inviter is already
  // listening, so there is no peer-unavailable retry to exercise here).
  const acceptorPeer = new Peer(acceptorId, {
    host: addressInfo.address,
    path: "/api/",
    port: addressInfo.port,
    config: { iceServers: [] }, // hermetic ICE -- see inviterPeer above
  });
  const acceptorConn: DataConnection = await new Promise<DataConnection>(
    (resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        acceptorPeer.off("open", onOpen);
        acceptorPeer.off("error", onError);
        action();
      };
      const onOpen = () => {
        const conn = acceptorPeer.connect(inviterId, { reliable: true });
        conn.once("open", () => settle(() => resolve(conn)));
      };
      const onError = (err: unknown) =>
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      acceptorPeer.on("open", onOpen);
      acceptorPeer.on("error", onError);
    },
  );

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

  // Mirror the production lifecycle: authenticate the peer over the real data
  // channel (the X25519 handshake the inviter/acceptor derive from the same
  // shared secret) before any PSI frame. This is the end-to-end check that the
  // key-exchange messages round-trip over PeerJS and that both ends agree.
  const runServerPSI = async () => {
    await authenticateExchange(serverMc, "responder", sharedSecret);
    const { associationTable } = await runExchange(
      serverMc,
      "responder",
      serverPrepared,
      { psiLibrary },
    );
    return associationTable;
  };

  const runClientPSI = async () => {
    await authenticateExchange(clientMc, "initiator", sharedSecret);
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
