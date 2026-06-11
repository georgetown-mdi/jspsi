import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { ConnectionError, runExchange } from "@psilink/core";

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";
import { runExchangeLifecycle } from "../../src/psi/exchangeLifecycle.js";

import type {
  Acquire,
  AcquiredExchange,
} from "../../src/psi/exchangeLifecycle.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type {
  AuthResult,
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// runExchange, the open-handshake, and the authenticated key exchange are the
// heavy operations the owner runs uniformly; mock them so the contract
// (teardown, abort, error classification, first-frame disconnect, the handshake
// gating runExchange) is observable without a real peer, WASM library, or
// crypto round-trip.
vi.mock("../../src/psi/peerMessageConnection.js", () => ({
  openPeerMessageConnection: vi.fn(),
}));
vi.mock("../../src/psi/authenticateExchange.js", () => ({
  authenticateExchange: vi.fn(),
}));
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runExchange: vi.fn() };
});

const mockedOpen = vi.mocked(openPeerMessageConnection);
const mockedAuthenticate = vi.mocked(authenticateExchange);
const mockedRunExchange = vi.mocked(runExchange);

/** A placeholder invitation secret; the handshake is mocked, so its value is
 * never validated -- only that it is threaded through to authenticateExchange. */
const SHARED_SECRET = "test-shared-secret";

/** Flush pending microtasks (and any queued macrotask) so the owner advances. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeConn extends EventEmitter {
  close = vi.fn();
}

class FakePeer extends EventEmitter {
  disconnect = vi.fn();
  destroy = vi.fn();
}

/** A MessageConnection whose parked `receive` is rejected with a `closed`
 * ConnectionError by `close`, mirroring how a deliberate teardown unwinds an
 * in-flight `runExchange`. */
function makeFakeMc() {
  let rejectParked: ((reason: unknown) => void) | undefined;
  const close = vi.fn((): Promise<void> => {
    rejectParked?.(new ConnectionError("connection closed", "closed"));
    return Promise.resolve();
  });
  const receive = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectParked = reject;
      }),
  );
  const send = vi.fn((): Promise<void> => Promise.resolve());
  return {
    mc: { close, receive, send } as unknown as MessageConnection,
    close,
  };
}

function makeResources(overrides?: { peer?: FakePeer; conn?: FakeConn }) {
  const peer = overrides?.peer ?? new FakePeer();
  const conn = overrides?.conn ?? new FakeConn();
  const acquired: AcquiredExchange = {
    peer: peer as unknown as Peer,
    conn: conn as unknown as DataConnection,
    psi: Promise.resolve({} as PSILibrary),
    prepared: {} as PreparedExchange,
  };
  return { acquired, peer, conn };
}

// The per-test option bundle that does not vary: the React seams plus the
// invitation secret. Spread into every runExchangeLifecycle call alongside the
// per-test acquire/exchangeRole/signal.
function seams() {
  return {
    sharedSecret: SHARED_SECRET,
    onStages: vi.fn(),
    onStage: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    generateOutput: vi.fn(() => OUTPUTS),
  };
}

const OUTPUTS = {
  resultsUrl: "blob:results",
  record: {
    recordUrl: "blob:record",
    recordFileName: "psilink-record.json",
    openingUrl: "blob:opening",
    openingFileName: "psilink-record.opening.json",
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("runExchangeLifecycle", () => {
  beforeEach(() => {
    // Default happy mocks; individual tests override as needed. The handshake
    // resolves (its 32-byte session key is unused by the lifecycle today), so the
    // owner advances to runExchange exactly as before the handshake existed.
    mockedAuthenticate.mockResolvedValue({
      sessionKey: new Uint8Array(32),
      rotatedSecret: "rotated",
      applyEncryption: false,
    } satisfies AuthResult);
    mockedRunExchange.mockResolvedValue({} as ExchangeResult);
  });

  test("success: reports the result, then tears down", async () => {
    const { mc, close } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired, peer } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.generateOutput).toHaveBeenCalledTimes(1);
    expect(s.onResult).toHaveBeenCalledWith(OUTPUTS);
    expect(s.onError).not.toHaveBeenCalled();
    // Teardown ran: the flushing close (teardown-exclusive) once, and the peer
    // was disconnected.
    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalled();
  });

  test("an acquire failure is category 'exchange' and needs no owner teardown", async () => {
    const acquire: Acquire = () => Promise.reject(new Error("CSV load failed"));
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "exchange",
      error: expect.any(Error),
    });
    expect(s.onResult).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a runExchange failure is classified as category 'exchange'", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    mockedRunExchange.mockRejectedValue(new Error("protocol blew up"));
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "exchange",
      error: expect.any(Error),
    });
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("authenticates the peer at the mc seam before runExchange", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    // The handshake ran with the exchange role and the invitation secret, over
    // the opened connection, and strictly before the PSI exchange.
    expect(mockedAuthenticate).toHaveBeenCalledWith(
      mc,
      "responder",
      SHARED_SECRET,
    );
    expect(mockedAuthenticate.mock.invocationCallOrder[0]).toBeLessThan(
      mockedRunExchange.mock.invocationCallOrder[0],
    );
  });

  test("a handshake trust failure is category 'security' and never runs the exchange", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // The kex fails closed on a wrong secret/tamper: authenticateExchange re-tags
    // it as a security-kind ConnectionError.
    const trustFailure = new ConnectionError(
      "key exchange authentication failed",
      "security",
    );
    mockedAuthenticate.mockRejectedValue(trustFailure);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "security",
      error: trustFailure,
    });
    // The trust boundary holds: no PSI frame is sent after a failed handshake.
    expect(mockedRunExchange).not.toHaveBeenCalled();
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("a handshake transport drop stays the retryable category 'exchange'", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // A transport-kind failure (peer unreachable / timeout) is passed through by
    // authenticateExchange unchanged, so it is the generic retryable category, not
    // the non-retryable security one.
    mockedAuthenticate.mockRejectedValue(
      new ConnectionError("peer connection closed", "transport"),
    );
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "exchange",
      error: expect.any(ConnectionError),
    });
    expect(mockedRunExchange).not.toHaveBeenCalled();
  });

  test("a generateOutput failure is category 'output' (the exchange succeeded)", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();
    s.generateOutput.mockImplementation(() => {
      throw new Error("could not build CSV");
    });

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "output",
      error: expect.any(Error),
    });
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("a teardown-only failure preserves the result and raises no alert", async () => {
    const { mc, close } = makeFakeMc();
    close.mockImplementation(() => Promise.reject(new Error("close blew up")));
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    // The exchange and output both succeeded; only teardown threw, so the
    // success state survives and neither alert is shown (F2).
    expect(s.onResult).toHaveBeenCalledWith(OUTPUTS);
    expect(s.onError).not.toHaveBeenCalled();
  });

  test("drops the broker on the first inbound frame, armed before the open await", async () => {
    const { acquired, peer, conn } = makeResources();
    const opened = deferred<MessageConnection>();
    mockedOpen.mockReturnValue(opened.promise);
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    const run = runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    // Let acquire resolve so the owner has attached conn.once("data") and is now
    // parked on the (still pending) open await.
    await tick();
    expect(peer.disconnect).not.toHaveBeenCalled();
    conn.emit("data", "first frame");
    expect(peer.disconnect).toHaveBeenCalledTimes(1);

    // Finish opening so the run can complete cleanly.
    opened.resolve(makeFakeMc().mc);
    await run;
    expect(s.onResult).toHaveBeenCalled();
  });

  test("a throw in the first-frame disconnect does not fail the exchange", async () => {
    const peer = new FakePeer();
    peer.disconnect.mockImplementationOnce(() => {
      throw new Error("disconnect boom");
    });
    const { acquired, conn } = makeResources({ peer });
    mockedOpen.mockResolvedValue(makeFakeMc().mc);
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    const run = runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });
    await tick();
    conn.emit("data", "first frame");
    await run;

    expect(s.onResult).toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
  });

  test("abort mid-run closes the connection, the run rejects, teardown runs once, no alert", async () => {
    const { mc, close } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // runExchange parks on a receive that the teardown close() will reject.
    mockedRunExchange.mockImplementation(
      async (c) => (await c.receive()) as ExchangeResult,
    );
    const controller = new AbortController();
    const { acquired, peer } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    const run = runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: controller.signal,
      ...s,
    });
    await tick(); // reach the parked receive inside runExchange
    controller.abort();
    await run;

    expect(close).toHaveBeenCalledTimes(1); // teardown-exclusive effect, once
    expect(peer.disconnect).toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled(); // abort is silent
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("abort during the handshake closes the connection, teardown runs once, no alert, no exchange", async () => {
    const { mc, close } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // The handshake parks on a receive that the teardown close() will reject,
    // mirroring how a deliberate teardown unwinds an in-flight key exchange. This
    // exercises an abort landing in the newly-inserted handshake step (before
    // runExchange), the one interleaving the other abort tests do not cover.
    mockedAuthenticate.mockImplementation(
      async (c) => (await c.receive()) as AuthResult,
    );
    const controller = new AbortController();
    const { acquired, peer } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    const run = runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: controller.signal,
      ...s,
    });
    await tick(); // reach the parked receive inside the handshake
    controller.abort();
    await run;

    expect(close).toHaveBeenCalledTimes(1); // teardown-exclusive effect, once
    expect(peer.disconnect).toHaveBeenCalled();
    expect(mockedRunExchange).not.toHaveBeenCalled(); // never reached the exchange
    expect(s.onError).not.toHaveBeenCalled(); // abort is silent
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("abort during a wait settles silently and tears down nothing it never held", async () => {
    const controller = new AbortController();
    // acquire models a wait that settles (rejects) when the owner's signal aborts.
    const acquire: Acquire = ({ signal }) =>
      new Promise<AcquiredExchange>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("wait aborted")),
          { once: true },
        );
      });
    const s = seams();

    const run = runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: controller.signal,
      ...s,
    });
    await tick();
    controller.abort();
    await run;

    // The aborted wait is a deliberate user-leave, not a failure: no alert.
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.onResult).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("already-aborted before the run starts tears down the acquired resources", async () => {
    const controller = new AbortController();
    controller.abort();
    const { acquired, peer, conn } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: controller.signal,
      ...s,
    });

    // acquire resolved but the signal was already aborted: tear down what it
    // handed us (no mc yet -> hard close the raw channel) and stay silent.
    expect(conn.close).toHaveBeenCalled();
    expect(peer.disconnect).toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.onResult).not.toHaveBeenCalled();
  });
});
