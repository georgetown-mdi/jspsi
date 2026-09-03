import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  ConnectionError,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  StandardizedDataset,
  UsageError,
  describeResolvedRunShape,
  getDefaultLinkageTerms,
  runExchange,
} from "@psilink/core";

import {
  CLOSE_OUTCOME_WARNINGS,
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
  runExchangeLifecycle,
} from "../../src/psi/exchangeLifecycle.js";
import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import type {
  Acquire,
  AcquiredExchange,
  ExchangeOutputs,
} from "../../src/psi/exchangeLifecycle.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type {
  AuthResult,
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
  ResolvedRunShape,
  RunExchangeOptions,
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
// Captured log output from the mock getLogger handed to exchangeLifecycle.
// Hoisted so the vi.mock factory (lifted above imports) can close over it.
const logCapture = vi.hoisted(() => ({
  errors: [] as Array<string>,
  warnings: [] as Array<string>,
}));

vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runExchange: vi.fn(),
    // The module-level `log = getLogger("exchangeLifecycle")` is created at
    // import time, so withCapturedLogs cannot reach it; replace getLogger
    // instead. This routes the lifecycle's teardown / early-disconnect ERROR
    // lines into logCapture (asserted by the negative-path tests below) rather
    // than letting them leak to stderr. The logger is informational only --
    // replacing it does not affect the lifecycle's control flow.
    getLogger: () => ({
      info: () => {},
      warn: (msg: string, ...args: Array<unknown>) =>
        logCapture.warnings.push([msg, ...args.map(String)].join(" ")),
      error: (msg: string, ...args: Array<unknown>) =>
        logCapture.errors.push([msg, ...args.map(String)].join(" ")),
      debug: () => {},
      trace: () => {},
    }),
  };
});

const mockedOpen = vi.mocked(openPeerMessageConnection);
const mockedAuthenticate = vi.mocked(authenticateExchange);
const mockedRunExchange = vi.mocked(runExchange);

/** A placeholder invitation secret; the handshake is mocked, so its value is
 * never validated -- only that it is threaded through to authenticateExchange. */
const SHARED_SECRET = "test-shared-secret";

/** A placeholder invitation `expires`; like the secret, the mocked handshake
 * never parses it -- the lifecycle's contract is only that it forwards the value
 * to authenticateExchange alongside the secret. */
const EXPIRES = "2999-01-01T00:00:00.000Z";

/** The agreed terms every stand-in below carries. The lifecycle forwards terms
 * without reading them. */
const STUB_LINKAGE_TERMS = getDefaultLinkageTerms("Stand-in Party");

/** The prepared exchange `acquire` hands the lifecycle. runExchange is mocked,
 * so it is threaded through unread. */
const STUB_PREPARED = {
  metadata: [],
  linkageTerms: STUB_LINKAGE_TERMS,
  dataset: new StandardizedDataset([]),
  rawRows: [],
  rowCount: 0,
} satisfies PreparedExchange;

/** What a mocked runExchange resolves with. The withheld-table shape (no
 * association table, no count) is the inert one: the lifecycle hands the result
 * to the `generateOutput` seam, which every test here replaces. */
const STUB_EXCHANGE_RESULT = {
  associationTable: undefined,
  intersectionCount: undefined,
  partnerTerms: STUB_LINKAGE_TERMS,
  resolvedRole: "receiver",
  partnerPayload: { columns: [], rowIndices: [], rows: [] },
} satisfies ExchangeResult;

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
    prepared: STUB_PREPARED,
  };
  return { acquired, peer, conn };
}

// The per-test option bundle that does not vary: the React seams plus the
// invitation secret and its expiry. Spread into every runExchangeLifecycle call
// alongside the per-test acquire/exchangeRole/signal.
function seams() {
  return {
    sharedSecret: SHARED_SECRET,
    expires: EXPIRES,
    onStages: vi.fn(),
    onStage: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
    generateOutput: vi.fn(() => OUTPUTS),
  };
}

const OUTPUTS = {
  kind: "matched",
  resultsUrl: "blob:results",
  record: {
    recordUrl: "blob:record",
    recordFileName: "psilink-record.json",
    keysUrl: "blob:keys",
    keysFileName: "psilink-record.keys.json",
  },
} satisfies ExchangeOutputs;

afterEach(() => {
  vi.clearAllMocks();
  logCapture.errors.length = 0;
  logCapture.warnings.length = 0;
});

describe("runExchangeLifecycle", () => {
  beforeEach(() => {
    // Default happy mocks; individual tests override as needed. The handshake
    // resolves (its 32-byte session key is unused by the lifecycle today), so the
    // owner advances to runExchange.
    mockedAuthenticate.mockResolvedValue({
      sessionKey: new Uint8Array(32),
      rotatedSecret: "rotated",
      applyEncryption: false,
    } satisfies AuthResult);
    mockedRunExchange.mockResolvedValue(STUB_EXCHANGE_RESULT);
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

  test.each([
    ["peer-closed", undefined],
    ["ceiling", FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING],
    ["peer-gone", FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING],
    ["channel-not-open", FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING],
  ] as const)(
    "words a close that ended on %s for the operator",
    async (outcome, expected) => {
      // The transport reports only how its wait ended, so this is where an exit
      // that carried no delivery signal becomes something an operator reads --
      // and the run has already reported success by then, making it the only
      // sign the partner may never have taken the final frame. The peer's own
      // close IS that signal, so it alone stays silent; the other two say
      // different things (a partner who never confirmed within the wait, versus
      // a link that went before they could) and must not share one sentence.
      const { mc } = makeFakeMc();
      mockedOpen.mockResolvedValue(mc);
      const { acquired, conn } = makeResources();
      const acquire: Acquire = () => Promise.resolve(acquired);
      const s = seams();
      const controller = new AbortController();

      await runExchangeLifecycle({
        acquire,
        exchangeRole: "initiator",
        signal: controller.signal,
        ...s,
      });

      // The run's own signal travels alongside the outcome callback: it is the
      // only route by which a cancel can cut the close's wait for the peer short
      // (core's MessageConnection.close() takes no arguments).
      expect(mockedOpen).toHaveBeenCalledWith(conn, {
        onCloseOutcome: expect.any(Function),
        signal: controller.signal,
      });
      expect(s.onWarning).not.toHaveBeenCalled();
      mockedOpen.mock.calls[0][1]?.onCloseOutcome?.(outcome);
      expect(s.onWarning.mock.calls).toEqual(
        expected === undefined ? [] : [[expected]],
      );
    },
  );

  test("a cancelled wait is worded as a lost link, never as the peer's close", () => {
    // A cancel cuts the wait rather than letting it run out, so the wait-expired
    // sentence would name the one thing that did not happen; what the partner got
    // is as unknowable as it is when the link dies, which is that sentence's whole
    // point. The silent entry is the delivery signal and must not be reused here.
    expect(CLOSE_OUTCOME_WARNINGS["run-aborted"]).toBe(
      FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
    );
  });

  test("the two unconfirmed notices do not reuse one sentence", () => {
    // A partner who never confirmed within the wait and a link that died before
    // they could are different states of the partner's copy, so an operator who
    // reads one must not be reading the other's wording.
    expect(FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING).not.toEqual(
      FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
    );
  });

  test.each(["ceiling", "peer-gone", "channel-not-open"] as const)(
    "a failed run whose close then ends on %s raises no notice",
    async (outcome) => {
      // The handshake fails closed without the connection ever reaching a
      // terminal state, so teardown's close is still the real flushing one and
      // its wait can end without a delivery signal after onError has fired. Both
      // notices speak for a run that succeeded ("Your own results are
      // complete"), so this one must drain that close and say nothing.
      const { mc, close } = makeFakeMc();
      close.mockImplementation(() => {
        mockedOpen.mock.calls[0][1]?.onCloseOutcome?.(outcome);
        return Promise.resolve();
      });
      mockedOpen.mockResolvedValue(mc);
      mockedAuthenticate.mockRejectedValue(
        new ConnectionError("key exchange authentication failed", "security"),
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
        category: "security",
        error: expect.any(ConnectionError),
      });
      // The drain still ran, exactly as it does on the success path; only the
      // operator notice is withheld.
      expect(close).toHaveBeenCalledTimes(1);
      expect(s.onWarning).not.toHaveBeenCalled();
    },
  );

  test.each([
    "ceiling",
    "peer-gone",
    "channel-not-open",
    "run-aborted",
  ] as const)(
    "drops a %s notice raised once the run has aborted",
    async (outcome) => {
      // The close's wait can end long after an unmount aborts the run, and the
      // seam it would set state through is gone by then -- the same live gate
      // every other seam takes.
      const { mc } = makeFakeMc();
      mockedOpen.mockResolvedValue(mc);
      const { acquired } = makeResources();
      const acquire: Acquire = () => Promise.resolve(acquired);
      const s = seams();
      const controller = new AbortController();

      await runExchangeLifecycle({
        acquire,
        exchangeRole: "initiator",
        signal: controller.signal,
        ...s,
      });
      controller.abort();
      mockedOpen.mock.calls[0][1]?.onCloseOutcome?.(outcome);

      expect(s.onWarning).not.toHaveBeenCalled();
    },
  );

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

  test("a prepare-time StandardizationTermsError is category 'config', not 'exchange'", async () => {
    // prepareForExchange fails closed with a StandardizationTermsError inside
    // acquire, before any peer connection: an authored standardization that
    // contradicts the terms. It must surface as an actionable config problem, not
    // the generic retryable transport failure.
    const acquire: Acquire = () =>
      Promise.reject(
        new StandardizationTermsError("standardization contradicts its terms"),
      );
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "config",
      error: expect.any(StandardizationTermsError),
    });
    expect(s.onResult).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("'config' is keyed on the OperatorConfigError base, not one subclass", async () => {
    // The category is the base type, so any future local-config check (e.g. the
    // disclosure-commitment drift a recurring web exchange reaches) is surfaced by
    // extending OperatorConfigError at its throw site -- no change to this
    // classifier. Pin that contract directly with the base type, not a subclass.
    const acquire: Acquire = () =>
      Promise.reject(new OperatorConfigError("a local config fault"));
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "config",
      error: expect.any(OperatorConfigError),
    });
    expect(s.onResult).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a prepare-time terms-fitness refusal is 'config', for the affordance", async () => {
    // prepareForExchange refuses, before any peer connection, a file that cannot
    // supply every linkage key the agreed terms declare. The same file refuses
    // identically on every attempt, so it must not land in the retryable generic
    // alert; it joins `config` for that affordance, and the alert builder gives it
    // fixed copy of its own rather than surfacing its message (its names are the
    // agreed terms', partner-authored on every accept path).
    const acquire: Acquire = () =>
      Promise.reject(
        new LinkageTermsUnsatisfiableError(
          "this input cannot satisfy every linkage key the agreed terms declare",
        ),
      );
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "config",
      error: expect.any(LinkageTermsUnsatisfiableError),
    });
    expect(s.onResult).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a prepare-time non-config UsageError is NOT 'config' (type-scoped)", async () => {
    // The config category is scoped to OperatorConfigError, not to any prepare-phase
    // UsageError. The payload-send disclosure guard also throws a plain UsageError
    // during prepare, but on the accept side its column names are adopted from the
    // partner's invitation, so it must stay in the generic (message-swallowing)
    // 'exchange' alert rather than have its text surfaced by the actionable 'config'
    // one.
    const acquire: Acquire = () =>
      Promise.reject(new UsageError("payload.send does not match metadata"));
    const s = seams();

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "responder",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onError).toHaveBeenCalledWith({
      category: "exchange",
      error: expect.any(UsageError),
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

  test("a mid-run StandardizationTermsError is NOT classified 'config' (phase-scoped)", async () => {
    // The config category is scoped to the prepare phase. Even the config-typed
    // StandardizationTermsError, were it to surface from the run half (none does
    // today), must stay the generic 'exchange', never the actionable 'config'
    // meant for a pre-connection data problem -- a structural guarantee, so a
    // future core change that threw one mid-run cannot silently mislabel it.
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    mockedRunExchange.mockRejectedValue(
      new StandardizationTermsError("mid-run standardization error"),
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
      error: expect.any(StandardizationTermsError),
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

    // The handshake ran with the exchange role, the invitation secret, and its
    // expiry, over the opened connection, and strictly before the PSI exchange.
    expect(mockedAuthenticate).toHaveBeenCalledWith(
      mc,
      "responder",
      SHARED_SECRET,
      EXPIRES,
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
    // The swallowed teardown failure is still logged (capturing it proves the
    // diagnostic fired and keeps it off the test output).
    expect(
      logCapture.errors.some((e) =>
        e.includes("teardown: closing the connection failed"),
      ),
    ).toBe(true);
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
    // The run (and its teardown) drains on microtasks during the tick above, so
    // the one-shot throwing disconnect is consumed by teardown's peer.disconnect
    // -- and the swallowed failure is logged rather than leaked to stderr.
    expect(
      logCapture.errors.some((e) =>
        e.includes("teardown: disconnecting the peer failed"),
      ),
    ).toBe(true);
  });

  test("a throw in the early broker disconnect is swallowed and logged", async () => {
    // Holding the open await pending keeps the run parked with the first-frame
    // data listener attached (teardown has not run), so a throwing peer.disconnect
    // on the first frame exercises the early-broker catch -- the distinct ERROR
    // sink from the teardown-disconnect path above, and the only one no other
    // test reaches. The throw must not fail the exchange, and it must be logged
    // (captured here) rather than leaked.
    const peer = new FakePeer();
    peer.disconnect.mockImplementationOnce(() => {
      throw new Error("disconnect boom");
    });
    const { acquired, conn } = makeResources({ peer });
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
    // Park on the still-pending open await with the data listener attached, then
    // deliver the first frame so dropBrokerOnFirstFrame runs and throws.
    await tick();
    conn.emit("data", "first frame");

    // Finish opening so the run completes cleanly despite the early throw.
    opened.resolve(makeFakeMc().mc);
    await run;

    expect(s.onResult).toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
    expect(
      logCapture.errors.some((e) =>
        e.includes("early broker disconnect failed"),
      ),
    ).toBe(true);
  });

  test("abort mid-run closes the connection, the run rejects, teardown runs once, no alert", async () => {
    const { mc, close } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // runExchange parks on a receive that the teardown close() will reject.
    mockedRunExchange.mockImplementation(async (c) => {
      await c.receive();
      return STUB_EXCHANGE_RESULT;
    });
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

    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.onResult).not.toHaveBeenCalled();
  });

  test("abort during the handshake closes the connection, teardown runs once, no alert, no exchange", async () => {
    const { mc, close } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    // The handshake parks on a receive that the teardown close() will reject,
    // mirroring how a deliberate teardown unwinds an in-flight key exchange. This
    // exercises an abort landing in the handshake step (before runExchange), the
    // one interleaving the other abort tests do not cover.
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

    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalled();
    expect(mockedRunExchange).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
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

  // --- The resolved run shape, named at the pre-round seam -------------------

  /** Drive core's pre-round seam with one resolved shape, then end the run the
   * way `outcome` says. The shape is what `runExchange` hands a front end after
   * the terms exchange and before the first round. */
  function runExchangeConfirming(
    runShape: ResolvedRunShape,
    outcome: "resolve" | "reject" = "resolve",
  ) {
    return (
      _conn: unknown,
      _role: unknown,
      _prepared: unknown,
      options: RunExchangeOptions,
    ): Promise<ExchangeResult> => {
      options.onProtocolConfirmed?.(STUB_LINKAGE_TERMS, "receiver", runShape);
      return outcome === "reject"
        ? Promise.reject(new ConnectionError("connection closed", "closed"))
        : Promise.resolve(STUB_EXCHANGE_RESULT);
    };
  }

  const OVER_BOUND_SHAPE: ResolvedRunShape = {
    cardinality: "many-to-many",
    localRecordCount: 3163,
    localDeclaredRecordCount: 3163,
    partnerRecordCount: 3163,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  };

  test("raises the run's resolved-shape notices ahead of its own terminal", async () => {
    // The operator has to be able to read what the terms resolved to while the
    // run is still going, so these arrive at the seam that produced them rather
    // than with the result. Core composes both strings; this seat only routes
    // them to the notice slot its transport warnings already take.
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();
    const { cardinalityNotice, pairTableAdvisory } =
      describeResolvedRunShape(OVER_BOUND_SHAPE);
    const order: Array<string> = [];
    s.onWarning.mockImplementation((message: string) => order.push(message));
    s.onResult.mockImplementation(() => order.push("<result>"));
    mockedRunExchange.mockImplementation(
      runExchangeConfirming(OVER_BOUND_SHAPE),
    );

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(order).toEqual([cardinalityNotice, pairTableAdvisory, "<result>"]);
  });

  test("raises the pre-round notices on a run that then fails", async () => {
    // The success gate on the teardown notice must not reach these: a run whose
    // shape the operator has to read is exactly as likely to be the one that
    // fails, and the seam fired long before the failure.
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();
    const { cardinalityNotice, pairTableAdvisory } =
      describeResolvedRunShape(OVER_BOUND_SHAPE);
    mockedRunExchange.mockImplementation(
      runExchangeConfirming(OVER_BOUND_SHAPE, "reject"),
    );

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onWarning.mock.calls).toEqual([
      [cardinalityNotice],
      [pairTableAdvisory],
    ]);
    expect(s.onError).toHaveBeenCalledTimes(1);
  });

  test("raises no notice for a one-to-one run within the advisory bound", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();
    mockedRunExchange.mockImplementation(
      runExchangeConfirming({
        cardinality: "one-to-one",
        localRecordCount: 3163,
        localDeclaredRecordCount: 3163,
        partnerRecordCount: 3163,
        localExpectsOutput: true,
        partnerAssociationTableWithheld: false,
      }),
    );

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onResult).toHaveBeenCalledTimes(1);
    expect(s.onWarning).not.toHaveBeenCalled();
  });

  test("raises the cardinality alone when the projection is within the bound", async () => {
    const { mc } = makeFakeMc();
    mockedOpen.mockResolvedValue(mc);
    const { acquired } = makeResources();
    const acquire: Acquire = () => Promise.resolve(acquired);
    const s = seams();
    const shape: ResolvedRunShape = {
      cardinality: "one-to-many",
      localRecordCount: 3163,
      localDeclaredRecordCount: 3163,
      partnerRecordCount: 3163,
      localExpectsOutput: true,
      partnerAssociationTableWithheld: false,
    };
    mockedRunExchange.mockImplementation(runExchangeConfirming(shape));

    await runExchangeLifecycle({
      acquire,
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      ...s,
    });

    expect(s.onWarning.mock.calls).toEqual([
      [describeResolvedRunShape(shape).cardinalityNotice],
    ]);
  });
});
