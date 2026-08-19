import { afterEach, describe, expect, test, vi } from "vitest";

import log from "loglevel";

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { beginManagedRendezvous } from "../../src/psi/managedRendezvous.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";
import { runManagedExchangeInBrowser } from "../../src/psi/managedRunDriver.js";

import type { ManagedExchangeRecord } from "../../src/psi/managedExchangeRecord.js";
import type { ManagedInputSource } from "../../src/psi/managedInputHandle.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { MessageConnection } from "@psilink/core";
import type { RunOutputs } from "@bench/runOutputs";

/**
 * The browser wiring of a managed re-run, with every platform seam it composes
 * mocked: the rendezvous, the message connection, the handshake, the PSI
 * exchange, and the outputs builder. What is left is the wiring's own decisions,
 * and the ones asserted here are its two teardowns: neither the run's outputs nor
 * a failed handshake's error may be held behind the clean close's wait for the
 * peer, whose duration the partner chooses up to the close ceiling.
 *
 * On the handshake's teardown that wait costs more than the run's own latency.
 * The handshake phase runs inside the single-writer lock, which releases when the
 * phase settles (`runManagedExchange`; the release on a rejecting critical section
 * is pinned against real Web Locks in test/browser/managedExchangeRun.test.ts), so
 * a phase that settles only after the drain holds the lock -- and every other
 * context's run of this record -- for the partner-chosen duration too. A phase
 * that rejects while the drain is still in flight is what releases it promptly.
 *
 * The orchestration this driver injects into (the lock, the persist ordering, the
 * bookkeeping) is `runManagedRerun`'s, tested in managedRun.test.ts and against
 * real Chromium in test/browser/managedRun.test.ts; it is replaced here by a fake
 * that runs the three phases in order.
 */

/** The outputs the mocked builder returns; identity is all the assertions need.
 * Hoisted so the mock factory below (lifted above the imports) can close over
 * it. */
const OUTPUTS: RunOutputs = vi.hoisted(() => ({ resultsUrl: "blob:results" }));

vi.mock("../../src/psi/managedRun.js", () => ({
  runManagedRerun: vi.fn(
    async (
      _record: unknown,
      seams: {
        acquireInput: () => Promise<unknown>;
        handshake: (input: unknown) => Promise<{ handshake: unknown }>;
        dataExchange: (carried: unknown) => Promise<unknown>;
      },
    ) => {
      const input = await seams.acquireInput();
      const { handshake } = await seams.handshake(input);
      const exchange = await seams.dataExchange(handshake);
      return { exchange, lastRun: { at: 0, outcome: "succeeded" } };
    },
  ),
}));
vi.mock("../../src/psi/managedRendezvous.js", () => ({
  beginManagedRendezvous: vi.fn(),
}));
vi.mock("../../src/psi/peerMessageConnection.js", () => ({
  openPeerMessageConnection: vi.fn(),
}));
vi.mock("../../src/psi/managedInputHandle.js", () => ({
  acquireValidatedManagedInput: vi.fn(() =>
    Promise.resolve({ rows: [], columns: [] }),
  ),
}));
vi.mock("../../src/psi/managedPreparedExchange.js", () => ({
  prepareManagedRerunExchange: vi.fn(() => ({})),
}));
vi.mock("../../src/psi/authenticateExchange.js", () => ({
  authenticateExchange: vi.fn(() => Promise.resolve({ rotatedSecret: "next" })),
}));
vi.mock("@bench/runOutputs", () => ({
  buildRunOutputs: vi.fn(() => OUTPUTS),
}));
// The WASM library the driver loads for the exchange: mocked at both ends (the
// engine module and core's backend selection) so no WASM is loaded for a run
// whose exchange is itself mocked.
vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadPsiBackend: vi.fn(() => Promise.resolve({ library: {} })),
    runExchange: vi.fn(() => Promise.resolve({})),
  };
});

const mockedAuthenticate = vi.mocked(authenticateExchange);
const mockedRendezvous = vi.mocked(beginManagedRendezvous);
const mockedOpen = vi.mocked(openPeerMessageConnection);

/** Only the fields the driver itself reads: the side that picks the handshake
 * role, and the secret/terms/expiry it hands to seams that are mocked here. */
const RECORD = {
  id: "record-under-test",
  side: "acceptor",
  sharedSecret: "stored-secret",
  exchangeFile: {},
} as unknown as ManagedExchangeRecord;

/** The per-run input source; its contents never reach anything unmocked. */
const SOURCE = {} as unknown as ManagedInputSource;

const URLS = { create: () => "blob:artifact", revoke: () => {} };

/** Flush pending microtasks (and any queued macrotask), so a promise that has
 * not settled after this one is genuinely parked. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A message connection whose clean close parks until `release` is called --
 * the peer that keeps the link up without ever reading the close sentinel. */
function makeParkedCloseMc() {
  let release: (() => void) | undefined;
  const close = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return {
    mc: {
      close,
      receive: vi.fn(),
      send: vi.fn(),
    } as unknown as MessageConnection,
    close,
    release: () => release?.(),
  };
}

function acquireResources() {
  const peer = { disconnect: vi.fn(), destroy: vi.fn() };
  const conn = { close: vi.fn() };
  mockedRendezvous.mockResolvedValue({
    side: "acceptor",
    peer: peer as unknown as Peer,
    conn: conn as unknown as DataConnection,
  });
  return { peer, conn };
}

function runDriver(signal: AbortSignal) {
  return runManagedExchangeInBrowser({
    record: RECORD,
    source: SOURCE,
    signal,
    urls: URLS,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runManagedExchangeInBrowser", () => {
  test("yields its outputs while the close is still draining", async () => {
    // The defect this pins: a peer that answers ICE but never reads the close
    // sentinel holds the drain to its ceiling, and awaiting the drain would hold
    // this run's outputs -- and the success bookkeeping behind them -- with it.
    const { mc, close } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();

    const result = await runDriver(new AbortController().signal);

    expect(result.exchange).toBe(OUTPUTS);
    // The drain did start, and is still in flight: the outputs came out from in
    // front of it rather than after it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).not.toHaveBeenCalled();
  });

  test("completes the teardown once the drain ends", async () => {
    // Not awaiting the drain must not mean abandoning it: the broker id is still
    // freed when the close finally resolves.
    const { mc, release } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();

    await runDriver(new AbortController().signal);
    release();
    await tick();

    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a failing teardown does not fail a completed run", async () => {
    // What makes starting the teardown without awaiting it safe: it swallows its
    // own faults, so a rejecting close neither replaces the run's outputs nor
    // surfaces as an unhandled rejection.
    const close = vi.fn(() => Promise.reject(new Error("close failed")));
    const failing = {
      close,
      receive: vi.fn(),
      send: vi.fn(),
    } as unknown as MessageConnection;
    mockedOpen.mockResolvedValue(failing);
    acquireResources();
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});

    const result = await runDriver(new AbortController().signal);
    await tick();

    expect(result.exchange).toBe(OUTPUTS);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  test("hands the run's signal to the transport, so a cancel cuts the drain", async () => {
    // The signal is the only route by which a cancel reaches the close's wait for
    // the peer (core's MessageConnection.close() takes no arguments), and it
    // covers both closes this driver drives: the failed handshake's and the data
    // exchange's.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { conn } = acquireResources();
    const controller = new AbortController();

    await runDriver(controller.signal);

    expect(mockedOpen).toHaveBeenCalledWith(conn, {
      signal: controller.signal,
    });
  });

  test("yields its outputs on a run cancelled during the drain", async () => {
    // The cancel case of the same rule: the drain is cut by the signal rather
    // than run to the ceiling, and either way the outputs are already out.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    const controller = new AbortController();

    const running = runDriver(controller.signal);
    controller.abort();

    await expect(running).resolves.toMatchObject({ exchange: OUTPUTS });
  });

  test("reports a handshake failure while its teardown is still draining", async () => {
    // The defect this pins: the failed handshake's teardown drains the same
    // close, and a phase that awaits it settles -- releasing the single-writer
    // lock over this record -- only once the partner lets go.
    const { mc, close } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();
    mockedAuthenticate.mockRejectedValueOnce(new Error("handshake refused"));

    await expect(runDriver(new AbortController().signal)).rejects.toThrow(
      "handshake refused",
    );

    // The drain did start, and is still in flight: the handshake failure came
    // out from in front of it rather than after it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).not.toHaveBeenCalled();
  });

  test("completes a failed handshake's teardown once the drain ends", async () => {
    // Not awaiting the drain must not mean abandoning it: the guarantee the
    // handshake's catch exists for is that a failed run leaves neither an open
    // channel nor a registered peer behind.
    const { mc, release } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();
    mockedAuthenticate.mockRejectedValueOnce(new Error("handshake refused"));

    await expect(runDriver(new AbortController().signal)).rejects.toThrow(
      "handshake refused",
    );
    release();
    await tick();

    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("tears a never-opened channel down before the failure propagates", async () => {
    // The already-broken connection: no wrapper materialized, so the teardown
    // hard-closes the raw channel and frees the broker id with no drain to wait
    // on -- both settled by the time the failure reaches the caller, since
    // nothing on that path suspends.
    mockedOpen.mockRejectedValueOnce(new Error("channel never opened"));
    const { peer, conn } = acquireResources();

    await expect(runDriver(new AbortController().signal)).rejects.toThrow(
      "channel never opened",
    );

    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });
});
