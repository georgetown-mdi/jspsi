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
// everything else -- handshake, arming, transport, and runExchange -- to the
// real implementation, not the unit tests' wholesale runExchange throw: the
// connection's send (the transport layer) exposes the fault partway through
// runExchange, with the directory still writable (a synthetic throw does not
// kill the SFTP session) -- exactly the condition the abort marker exists for.
//
// Determinism comes from the protocol's lockstep, not timing. The terms
// exchange is asymmetric (protocolSetup.ts: the initiator sends first, the
// responder receives first), so with both parties patched identically, the
// already-armed initiator throws on message 1's send and its catch writes
// <initiator>-abort.json; the responder, blocked in its own first receive,
// reads that marker and fast-fails with PeerAbortError instead of riding out
// the peer-inactivity timeout. Which party wins the rendezvous does not
// matter: the assertions are party-agnostic.
//
// `fault` scopes the injection so a RETRY can target the same directory:
// `inject` off makes runExchange wholly real, and `targetIdentity` selects
// the party that tears by its linkage-terms identity rather than letting the
// rendezvous race decide which physical party holds the fault. A patched
// party that ends up the responder throws on its own first send once it has
// received the peer's terms, so targeting fixes WHO faults regardless of role.
//
// The override is a plain rejection, not a faithful terminal-state transition
// (it never drives the connection's own fail()/close path): sufficient because
// the fault fires on the faulting party's FIRST operation, so no later
// send/receive on that party can diverge on a half-closed connection, and the
// marker write this test guards is issued by runProtocol's catch on the
// underlying FileSyncConnection, which this send override never touches. The
// connection's own teardown-window race is covered separately in core's
// fileSyncAbortMarker.test.ts.
const fault = vi.hoisted(() => ({
  inject: true,
  targetIdentity: undefined as string | undefined,
}));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    runExchange: ((conn, role, prepared, options) => {
      const targeted =
        fault.targetIdentity === undefined ||
        prepared.linkageTerms.identity === fault.targetIdentity;
      if (fault.inject && targeted) {
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
      }
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
import { withCapturedLogs } from "@psilink/core/testing";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
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
// authenticatedExchange.test.ts): gives both parties valid, matching terms. An
// attempt that faults never reaches a PSI round, so for those the rows only need
// to make prepareForExchange succeed; the retry attempt does intersect them, and
// its result is what proves the recovered exchange ran whole.
const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// Party A holds fewer rows than Party B, so A is the PSI receiver -- the side
// that learns the intersection and writes it -- regardless of which party wins
// the rendezvous.
const ROWS_A = [{ first_name: "Bob" }, { first_name: "Carol" }];
const ROWS_B = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

function preparedFor(identity: string, rows: Array<Record<string, string>>) {
  const spec: ExchangeDataSpec = {
    linkageTerms: { ...baseTerms, identity },
  };
  return prepareForExchange(spec, identity, rows, ["first_name"]);
}

const IDENTITY_A = "Party A";
const IDENTITY_B = "Party B";

interface AbortScenarioOutcome {
  /** Each party's settlement, in [A, B] order. */
  settled: PromiseSettledResult<unknown>[];
  /** The rejection reasons among those settlements, in the same order. */
  reasons: unknown[];
  /** Count of `<id>-abort.json` files left in the shared directory. */
  markerCount: number;
  /** WARN/ERROR lines the run emits -- captured so the faulting party's
   *  intended recovery advisory is asserted rather than leaked to the suite
   *  console (see expectFastPeerAbort). */
  capturedLogs: string[];
  /** Each party's result-CSV path, written only by a completed exchange. */
  outputs: { a: string; b: string };
}

interface AbortScenarioOptions {
  /** Distinguishes one attempt's output CSVs from the next attempt's. */
  tag?: string;
  /**
   * Runs against the key files exactly as the previous attempt left them --
   * still holding the token it rotated, which is what "retry without
   * re-inviting" means. A first attempt provisions the pair from
   * INITIAL_SECRET instead.
   */
  reuseKeyFiles?: boolean;
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
  options: AbortScenarioOptions = {},
): Promise<AbortScenarioOutcome> {
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  if (!options.reuseKeyFiles) {
    saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
    saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });
  }
  const secretA = loadKeyFile(keyA)!.sharedSecret;
  const secretB = loadKeyFile(keyB)!.sharedSecret;
  const tag = options.tag ?? "";
  const outputs = {
    a: path.join(work, `${tag}a-out.csv`),
    b: path.join(work, `${tag}b-out.csv`),
  };

  // The faulting party's catch emits an ERROR recovery advisory (its token
  // rotated before the fault). Run the parties under withCapturedLogs so that
  // intended line is captured for assertion below rather than printed to the
  // suite console; both per-party loggers are created (by name) inside this
  // wrapped call, so they bind to the capture's interceptor.
  const [settled, capturedLogs] = await withCapturedLogs(
    () =>
      Promise.allSettled([
        runProtocol({
          connection: makeConfig(),
          auth: { sharedSecret: secretA, keyFilePath: keyA },
          prepared: preparedFor(IDENTITY_A, ROWS_A),
          output: outputs.a,
          verbosity: -1,
          loggerName: `${tag}abort-a`,
        }),
        runProtocol({
          connection: makeConfig(),
          auth: { sharedSecret: secretB, keyFilePath: keyB },
          prepared: preparedFor(IDENTITY_B, ROWS_B),
          output: outputs.b,
          verbosity: -1,
          loggerName: `${tag}abort-b`,
        }),
      ]),
    (level) => level === "WARN" || level === "ERROR",
  );

  const reasons = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  const markerCount = (await fsp.readdir(markerDir)).filter((n) =>
    n.endsWith("-abort.json"),
  ).length;

  return {
    settled,
    reasons,
    markerCount,
    capturedLogs: capturedLogs.map((l) => l.message),
    outputs,
  };
}

// The shared assertions. Each side is identified positively by error TYPE: the
// waiting peer fast-fails with a PeerAbortError (only producible by reading the
// marker -- which is what distinguishes the fast path from a peer-inactivity
// timeout, since a timeout would raise a transport ConnectionError instead),
// and the faulting party rejects with the injected synthetic ConnectionError.
// Any other failure (e.g. a genuine SFTP transport error) matches neither bucket
// and trips the total-count check with a clear wrong-error signal rather than a
// confusing message mismatch.
function expectFastPeerAbort(outcome: AbortScenarioOutcome): void {
  // The attempt fails on both sides, so every settlement holds a reason.
  expect(outcome.reasons).toHaveLength(outcome.settled.length);
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

  // Exactly one intended WARN/ERROR fired: the faulting party's recovery
  // advisory (its token rotated before the synthetic fault, so it tells the
  // operator to retry without re-inviting). The waiting peer's PeerAbortError is
  // hint-tagged and emits none. Asserting the captured set proves intent and
  // guards against a different, genuine error slipping through unsuppressed.
  expect(outcome.capturedLogs).toHaveLength(1);
  expect(outcome.capturedLogs[0]).toContain(
    "The shared secret was already rotated and saved before this error.",
  );
}

// Measures the recovery the faulting party's advisory prescribes: a plain retry
// in the same directory, no re-invite, both parties holding the token the
// failed attempt rotated. Both parties draw fresh ids on the retry, so the
// marker the failure left is named by neither of them and by neither hello; the
// entry sweep clears it and the exchange runs to completion.
async function expectPlainRetryToComplete(
  makeConfig: () => ProtocolConnectionConfig,
  markerDir: string,
): Promise<void> {
  fault.targetIdentity = IDENTITY_A;
  const first = await runAbortScenario(work, makeConfig, markerDir, {
    tag: "first-",
  });
  expectFastPeerAbort(first);

  fault.inject = false;
  const retry = await runAbortScenario(work, makeConfig, markerDir, {
    tag: "retry-",
    reuseKeyFiles: true,
  });

  expect(retry.settled.map((r) => r.status)).toEqual([
    "fulfilled",
    "fulfilled",
  ]);
  // The leftover marker was swept at entry, and a completed exchange leaves
  // none of its own.
  expect(retry.markerCount).toBe(0);
  // Party A holds the smaller dataset, so it is the receiver and its result CSV
  // is the intersection: a header plus every row both parties hold.
  const rows = (await fsp.readFile(retry.outputs.a, "utf8")).trim().split("\n");
  expect(rows).toHaveLength(1 + ROWS_A.length);
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-abort-integ-"));
  fault.inject = true;
  fault.targetIdentity = undefined;
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

test("filedrop: a plain retry under fresh ids after a mid-exchange fault completes the exchange", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const makeConfig = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 1, peerTimeoutMs: PEER_TIMEOUT_MS },
  });

  await expectPlainRetryToComplete(makeConfig, dropDir);
}, 60_000);

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
    // A unique served subdir per run so the rendezvous namespace is isolated
    // from any sibling test and from a prior run that bypassed cleanup; the
    // connection does not create remote directories, so mkdtemp creates it first.
    const localDir = await fsp.mkdtemp(path.join(SFTP_LOCAL_ROOT, "run-"));
    const serverPath = `${SFTP_PATH_ROOT}/${path.basename(localDir)}`;
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

  test("sftp: a plain retry under fresh ids after a mid-exchange fault completes the exchange", async () => {
    const localDir = await fsp.mkdtemp(path.join(SFTP_LOCAL_ROOT, "run-"));
    const serverPath = `${SFTP_PATH_ROOT}/${path.basename(localDir)}`;
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

    await expectPlainRetryToComplete(makeConfig, localDir);
  }, 120_000);
});
