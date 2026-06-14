import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// Inject a synthetic mid-exchange transport fault at the FIRST send, delegating
// everything else -- the real handshake, arming, transport, and runExchange --
// to the actual implementation. This is not the unit tests' wholesale
// runExchange throw: the real runExchange runs, and the fault surfaces from the
// connection's send (the transport layer) partway through, with the directory
// still writable (a synthetic throw does not kill the SFTP session) -- exactly
// the condition the abort marker exists for.
//
// Determinism comes from the protocol's lockstep, not from timing. The terms
// exchange is asymmetric (protocolSetup.ts: the initiator's first op is a send,
// the responder's first op is a receive), so with both parties patched
// identically the initiator throws on message 1's send -- it is already armed
// (armAbort runs before runExchange) -- and its catch writes
// <initiator>-abort.json over the real transport. The responder, blocked in its
// first receive, never reaches its own first send; its poll loop reads that
// marker over the real transport and fast-fails with PeerAbortError instead of
// riding out the full peer-inactivity timeout. Which physical party wins the
// rendezvous (and so becomes the initiator) does not matter: the assertions are
// party-agnostic (exactly one PeerAbortError, exactly one synthetic fault, one
// marker).
//
// The override is a plain rejection rather than a faithful terminal-state
// transition (it does not drive the connection's own fail()/close path): that is
// sufficient because the fault fires on the faulting party's FIRST operation, so
// no later send/receive runs on that party whose behavior on a half-closed
// connection could diverge, and the marker write the test actually guards is
// issued by runProtocol's catch on the underlying FileSyncConnection -- which
// this MessageConnection-level send override never touches -- so it runs for real
// over the live transport. The connection's own teardown-window race
// (fail()-driven close racing the marker write) is covered separately and
// deterministically in core's fileSyncAbortMarker.test.ts.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    runExchange: ((conn, role, prepared, options) => {
      const originalSend = conn.send.bind(conn);
      let firstSendThrown = false;
      conn.send = (data: unknown): Promise<void> => {
        if (firstSendThrown) return originalSend(data);
        firstSendThrown = true;
        return Promise.reject(
          new actual.ConnectionError(
            "synthetic mid-exchange transport fault",
            "transport",
          ),
        );
      };
      return actual.runExchange(conn, role, prepared, options);
    }) as typeof actual.runExchange,
  };
});

import {
  prepareForExchange,
  PeerAbortError,
  ConnectionError,
} from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { saveKeyFile } from "../../src/keyFile";
import {
  localPath,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";

const srv = sftpServer();

// 32 zero bytes as base64url (43 chars): a valid shared secret. Both key files
// start from it so the handshake -- which must complete for the connection to
// arm -- succeeds before the injected fault fires.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// The peer-inactivity budget. The fast peer-abort path completes in well under a
// second, so this is never reached on the happy path; it is set generously only
// so a regression in the marker write or read makes the waiting peer ride it out
// and fail with a transport timeout -- a DIFFERENT error type than the
// PeerAbortError the fast path produces. That type difference is what the
// assertions key on to separate the fast path from a timeout, so no brittle
// wall-clock bound is needed (and none is asserted).
const PEER_TIMEOUT_MS = 20_000;

// firstName-only terms over a tiny dataset (same approach as
// authenticatedExchange.test.ts): gives both parties valid, matching terms. The
// datasets are never actually intersected -- both parties fault before any PSI
// round -- so the rows only need to make prepareForExchange succeed.
const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "firstName" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

function preparedFor(identity: string) {
  const spec: ExchangeDataSpec = {
    linkageTerms: { ...baseTerms, identity },
  };
  return prepareForExchange(
    spec,
    identity,
    [{ first_name: "Bob" }],
    ["first_name"],
  );
}

interface AbortScenarioOutcome {
  /** Both parties' rejection reasons (the run always fails on both sides). */
  reasons: unknown[];
  /** Count of `<id>-abort.json` files left in the shared directory. */
  markerCount: number;
}

// Drives two real runProtocol parties against a shared directory, lets the
// injected first-send fault play out, and reports the outcome the assertions
// check. `markerDir` is the host directory backing the shared rendezvous path
// (the served local dir for SFTP, the drop dir for filedrop) so the marker file
// can be counted on disk.
async function runAbortScenario(
  work: string,
  makeConfig: () => ProtocolConnectionConfig,
  markerDir: string,
): Promise<AbortScenarioOutcome> {
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  const [resA, resB] = await Promise.allSettled([
    runProtocol(
      makeConfig(),
      { sharedSecret: INITIAL_SECRET, keyFilePath: keyA },
      preparedFor("Party A"),
      path.join(work, "a-out.csv"),
      -1,
      "abort-a",
    ),
    runProtocol(
      makeConfig(),
      { sharedSecret: INITIAL_SECRET, keyFilePath: keyB },
      preparedFor("Party B"),
      path.join(work, "b-out.csv"),
      -1,
      "abort-b",
    ),
  ]);

  expect(resA.status).toBe("rejected");
  expect(resB.status).toBe("rejected");
  const reasons = [resA, resB].map((r) => (r as PromiseRejectedResult).reason);

  const markerCount = (await fsp.readdir(markerDir)).filter((n) =>
    n.endsWith("-abort.json"),
  ).length;

  return { reasons, markerCount };
}

// The shared assertions. Each side is identified positively by error TYPE: the
// waiting peer fast-fails with a PeerAbortError (only producible by reading the
// marker -- which is what distinguishes the fast path from a peer-inactivity
// timeout, since a timeout would surface a transport ConnectionError instead),
// and the faulting party rejects with the injected synthetic ConnectionError.
// Any other failure (e.g. a genuine SFTP transport error) matches neither bucket
// and trips the total-count check with a clear wrong-error signal rather than a
// confusing message mismatch.
function expectFastPeerAbort(outcome: AbortScenarioOutcome): void {
  const peerAborts = outcome.reasons.filter((r) => r instanceof PeerAbortError);
  const injected = outcome.reasons.filter(
    (r) =>
      r instanceof ConnectionError &&
      r.message.includes("synthetic mid-exchange transport fault"),
  );

  // One side read the marker and fast-failed; the other hit the injected fault,
  // and nothing else was thrown.
  expect(peerAborts).toHaveLength(1);
  expect(injected).toHaveLength(1);
  expect(peerAborts.length + injected.length).toBe(outcome.reasons.length);

  // The real marker write landed exactly once (the path the Buffer-wrap fix
  // repaired) and was not echoed by the waiting peer.
  expect(outcome.markerCount).toBe(1);
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-abort-integ-"));
});

afterEach(() => {
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("filedrop: a mid-exchange fault writes a real abort marker the waiting peer fast-fails on", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const makeConfig = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 1, peerTimeoutMs: PEER_TIMEOUT_MS },
  });

  expectFastPeerAbort(await runAbortScenario(work, makeConfig, dropDir));
}, 30_000);

describe("sftp", () => {
  // Distinct namespace from the sibling integration files (authexchange / sftp /
  // mixed) so concurrent files cannot cross-contaminate the rendezvous dir.
  const SFTP_LOCAL_ROOT = localPath(srv, "abortmarker");
  const SFTP_PATH_ROOT = remotePath(srv, "abortmarker");

  beforeAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
    await fsp.mkdir(SFTP_LOCAL_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
  });

  test("sftp: a mid-exchange fault writes a real abort marker over the server the waiting peer fast-fails on", async () => {
    // A per-test served subdir so the rendezvous namespace is isolated; the
    // connection does not create remote directories, so create it first.
    const localDir = path.join(SFTP_LOCAL_ROOT, "run");
    await fsp.mkdir(localDir, { recursive: true });
    const serverPath = `${SFTP_PATH_ROOT}/run`;
    const makeConfig = (): ProtocolConnectionConfig => ({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: serverPath,
      },
      options: { pollIntervalMs: 50, peerTimeoutMs: PEER_TIMEOUT_MS },
    });

    expectFastPeerAbort(await runAbortScenario(work, makeConfig, localDir));
  }, 60_000);
});
