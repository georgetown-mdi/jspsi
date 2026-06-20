/// <reference types="@vitest/browser-playwright/context" />

import { beforeAll, expect, inject, test } from "vitest";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  generateSharedSecret,
  prepareForExchange,
} from "@psilink/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { runExchangeLifecycle } from "../../src/psi/exchangeLifecycle.js";

import { connectRendezvousPair } from "../utils/rendezvousPair.js";
import { sortAssociationTable } from "../utils/associationTable.js";

import type {
  ExchangeErrorCategory,
  ExchangeOutputs,
} from "../../src/psi/exchangeLifecycle.js";
import type { ExchangeResult, PreparedExchange } from "@psilink/core";
import type { DataConnection } from "peerjs";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type Peer from "peerjs";

// This suite drives the app's own exchange orchestrator, runExchangeLifecycle,
// over a real WebRTC data channel for BOTH roles -- the seam ExchangeView depends
// on but the UI tests stub out (and invitedPSI bypasses by calling
// authenticateExchange/runExchange directly). It pins the contract ExchangeView
// reads back from the lifecycle: the real protocol-stage progression (including
// the CONFIRMING_PROTOCOL_STAGE_ID peer-connect transition that drives
// `peerConnected`), that success emits exactly one onResult and no onError (the
// done/error mutual exclusivity), and that the linkage is correct end to end.

interface AddressInfo {
  address: string;
  port: number;
}

const addressInfo: AddressInfo = {
  address: "127.0.0.1",
  // The browser project's globalSetup publishes the port it probed/launched the
  // dev server on (browser tests run in Chromium and cannot read process.env), so
  // the rendezvous below targets that exact port. Falls back to the Vite default
  // when run without that setup, where an unreachable server skips the suite.
  port: inject("webDevServerPort") ?? 3000,
};

const hostString = `http://${addressInfo.address}:${addressInfo.port.toString()}`;
const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

// Probe the PeerJS coordination server with a short timeout, inside a hook rather
// than at module scope, so an unreachable server skips this suite instead of
// taking down the whole browser project at import (see invitedPSI.test.ts).
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

// The default linkage-key templates all require SSN/DOB/lastName combinations, so
// none survive filtering for a firstName-only dataset. Provide one explicit key so
// both parties produce valid, matching linkage terms (a single key, so the stage
// progression below is exactly [confirming protocol, stage 1 / 1]).
const firstNameOnlyTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

/** Everything one role's lifecycle reported back, captured for assertion. */
interface CapturedRun {
  /** onStage ids, in order. */
  stages: Array<string>;
  /** onResult payloads (one on success). */
  results: Array<ExchangeOutputs>;
  /** onError failures (none on success). */
  errors: Array<{ category: ExchangeErrorCategory; error: unknown }>;
  /** The ExchangeResult generateOutput was handed, captured to verify linkage. */
  result?: ExchangeResult;
}

/** Drive runExchangeLifecycle for one role over an already-open connection,
 * capturing every callback. The connection is supplied via a trivial `acquire`
 * (the role-specific dialing is exercised by the live rendezvous setup and by
 * invitedPSI); everything after acquire -- message-connection open, authenticated
 * key exchange, runExchange, output generation, teardown -- runs for real. */
async function driveRole(
  exchangeRole: "responder" | "initiator",
  peer: Peer,
  conn: DataConnection,
  prepared: PreparedExchange,
  psiLibrary: PSILibrary,
  sharedSecret: string,
): Promise<CapturedRun> {
  const captured: CapturedRun = { stages: [], results: [], errors: [] };
  // Never aborted: let the exchange run to completion; the lifecycle's own
  // finally-latch tears the connection down before it resolves.
  const controller = new AbortController();
  await runExchangeLifecycle({
    acquire: () =>
      Promise.resolve({
        peer,
        conn,
        psi: Promise.resolve(psiLibrary),
        prepared,
      }),
    exchangeRole,
    sharedSecret,
    signal: controller.signal,
    generateOutput: (result) => {
      captured.result = result;
      return { resultsUrl: `blob:results-${exchangeRole}` };
    },
    onStages: () => {},
    onStage: (id) => captured.stages.push(id),
    onResult: (outputs) => captured.results.push(outputs),
    onError: (failure) => captured.errors.push(failure),
  });
  return captured;
}

// Undefined until a reachable server lets beforeAll run the exchange; the tests
// gate on these, so an unreachable server skips rather than reading a stale or
// absent result.
let responder: CapturedRun | undefined;
let initiator: CapturedRun | undefined;

// Generous timeout: peer coordination, the WASM load, and the round-trip exchange
// all happen here.
beforeAll(async () => {
  if (!(await canReachServer())) return;

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

  // The inviter is the PSI responder; the acceptor the PSI initiator. Run both
  // lifecycles concurrently over the live channel, exactly as the two browsers do.
  [responder, initiator] = await Promise.all([
    driveRole(
      "responder",
      inviterPeer,
      inviterConn,
      serverPrepared,
      psiLibrary,
      sharedSecret,
    ),
    driveRole(
      "initiator",
      acceptorPeer,
      acceptorConn,
      clientPrepared,
      psiLibrary,
      sharedSecret,
    ),
  ]);
}, 60_000);

test("both roles complete with a result and no error", (ctx) => {
  if (!responder || !initiator) return ctx.skip(serverUnreachableNote);

  // Success emits exactly one onResult and zero onError on each side: the
  // done/error mutual exclusivity ExchangeView relies on, proven over a real
  // exchange rather than a stub.
  expect(responder.errors).toEqual([]);
  expect(initiator.errors).toEqual([]);
  expect(responder.results).toHaveLength(1);
  expect(initiator.results).toHaveLength(1);
  expect(responder.results[0]?.resultsUrl).toBe("blob:results-responder");
  expect(initiator.results[0]?.resultsUrl).toBe("blob:results-initiator");
});

test("the lifecycle forwards the real protocol-stage progression", (ctx) => {
  if (!responder || !initiator) return ctx.skip(serverUnreachableNote);

  // The stages runExchange emits flow through runExchangeLifecycle unchanged: the
  // confirming-protocol step (the peer-connect transition ExchangeView keys
  // `peerConnected` on) followed by one stage per linkage key. A core rename of
  // these ids would break ExchangeView's stage model, which the stubbed UI tests
  // cannot catch.
  const expectedStages = [CONFIRMING_PROTOCOL_STAGE_ID, "stage 1 / 1"];
  expect(responder.stages).toEqual(expectedStages);
  expect(initiator.stages).toEqual(expectedStages);
});

test("the live exchange links the correct records", (ctx) => {
  if (!responder?.result || !initiator?.result) {
    return ctx.skip(serverUnreachableNote);
  }

  const responderTable = sortAssociationTable(
    responder.result.associationTable,
  );
  const initiatorTable = sortAssociationTable(
    initiator.result.associationTable,
    true,
  );

  // Carol (server row 2, client row 0) and Elizabeth (server row 4, client row 1)
  // are the only shared names.
  expect(responderTable[0]).toStrictEqual([2, 4]);
  expect(responderTable[1]).toStrictEqual([0, 1]);
  // The two parties agree on the pairing from their mirrored viewpoints.
  expect(responderTable[0]).toStrictEqual(initiatorTable[1]);
  expect(responderTable[1]).toStrictEqual(initiatorTable[0]);
});
