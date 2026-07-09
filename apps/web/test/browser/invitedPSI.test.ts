/// <reference types="@vitest/browser-playwright/context" />

import { beforeAll, expect, inject, test } from "vitest";

import {
  generateSharedSecret,
  prepareForExchange,
  runExchange,
} from "@psilink/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import {
  canReachServer,
  clientRows,
  firstNameOnlyTerms,
  serverRows,
} from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";
import { sortAssociationTable } from "../utils/associationTable.js";

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

// Undefined until a reachable server lets beforeAll run the exchange; the tests
// gate on this, so an unreachable server skips rather than reading a stale or
// absent result.
let serverResult: ReturnType<typeof sortAssociationTable> | undefined;
let clientResult: ReturnType<typeof sortAssociationTable> | undefined;

// Generous timeout: peer coordination, the WASM load, and the round-trip
// exchange all happen here. The hook timeout turns a stuck server into a clear
// failure, not a hang.
beforeAll(async () => {
  const reachable = await canReachServer(hostString);
  if (!reachable) return;

  // The backend-free rendezvous stands in for the invitation: a fresh shared
  // secret, both peer ids derived from it (no /api/psi/* session). The inviter
  // (PSI responder) listens; the acceptor (PSI initiator) dials. Hermetic ICE and
  // the loopback-candidate reasoning live in connectRendezvousPair.
  const sharedSecret = generateSharedSecret();
  const { inviterPeer, acceptorPeer, inviterConn, acceptorConn } =
    await connectRendezvousPair(sharedSecret, addressInfo);

  const psiLibrary = await (PSI() as Promise<PSILibrary>);

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

  // Both parties' terms are both-output, so each is entitled to the result and
  // the exchange returns a table to both; the withholding gate only fires for a
  // non-receiving party. Narrow off the now-optional return, failing loudly if
  // that invariant ever breaks here.
  if (rawServerResult === undefined || rawClientResult === undefined)
    throw new Error(
      "both-output exchange unexpectedly withheld a result table",
    );
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
