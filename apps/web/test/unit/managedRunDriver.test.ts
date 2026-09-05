import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import log from "loglevel";

import { describeResolvedRunShape, runExchange } from "@psilink/core";

import {
  DISCLOSURE_NOT_FILED_WARNING,
  runManagedExchangeInBrowser,
} from "../../src/psi/managedRunDriver.js";
import {
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
} from "../../src/psi/exchangeLifecycle.js";
import {
  PartnerNoShowError,
  waitForIncomingConnection,
} from "../../src/psi/waitForConnection.js";
import { appendDisclosureRecordToStore } from "../../src/psi/disclosureAccountingStore.js";
import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { beginManagedRendezvous } from "../../src/psi/managedRendezvous.js";
import { disclosureRecord } from "../utils/disclosureFixtures.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import type { ManagedExchangeRecord } from "../../src/psi/managedExchangeRecord.js";
import type { ManagedInputSource } from "../../src/psi/managedInputHandle.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type * as PsilinkCore from "@psilink/core";
import type {
  ExchangeResult,
  HandshakeRole,
  LinkageTerms,
  MessageConnection,
  PsiBackendSelection,
  RendezvousRole,
  ResolvedRunShape,
  RunExchangeOptions,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { PeerCloseOutcome } from "../../src/psi/waitForPeerClose.js";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The browser wiring of a managed re-run, every platform boundary mocked
 * (rendezvous, message connection, handshake, PSI exchange, outputs builder):
 * only the wiring's own decisions are under test -- the handshake role per
 * stored side, checked against the cross-application interop vectors, and its
 * two teardowns, where neither the outputs nor a failed handshake's error
 * waits on the clean close's peer-controlled drain.
 */

/** The outputs the mocked builder returns; identity is all the assertions need.
 * Hoisted so the mock factory below (lifted above the imports) can close over
 * it. */
const OUTPUTS: RunOutputs = vi.hoisted(() => ({
  kind: "matched" as const,
  resultsUrl: "blob:results",
}));

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
// Only the inbound wait is faked; PartnerNoShowError stays the real class, because
// the classification downstream of this wiring is an instanceof check on it.
vi.mock("../../src/psi/waitForConnection.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  waitForIncomingConnection: vi.fn(),
}));
vi.mock("../../src/psi/managedInputHandle.js", () => ({
  acquireValidatedManagedInput: vi.fn(() =>
    Promise.resolve({ rows: [], columns: [] }),
  ),
}));
vi.mock("../../src/psi/disclosureAccountingStore.js", () => ({
  appendDisclosureRecordToStore: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/psi/managedPreparedExchange.js", () => ({
  prepareManagedRerunExchange: vi.fn(() => ({})),
}));
vi.mock("../../src/psi/authenticateExchange.js", () => ({
  authenticateExchange: vi.fn(() => Promise.resolve({ rotatedSecret: "next" })),
}));
vi.mock("@psi/runOutputs", () => ({
  buildRunOutputs: vi.fn(() => OUTPUTS),
}));
// The WASM library the driver loads for the exchange: mocked at both ends (the
// engine module and core's backend selection) so no WASM is loaded for a run
// whose exchange is itself mocked.
vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  return {
    ...actual,
    loadPsiBackend: vi.fn(() =>
      Promise.resolve({
        library: {} as PSILibrary,
        backend: "wasm",
      } satisfies PsiBackendSelection),
    ),
    runExchange: vi.fn(() => Promise.resolve({})),
  };
});

const mockedAuthenticate = vi.mocked(authenticateExchange);
const mockedAppendDisclosure = vi.mocked(appendDisclosureRecordToStore);
const mockedRendezvous = vi.mocked(beginManagedRendezvous);
const mockedRunExchange = vi.mocked(runExchange);
const mockedOpen = vi.mocked(openPeerMessageConnection);
const mockedWaitForIncoming = vi.mocked(waitForIncomingConnection);

/** The side-to-handshake-role pairing both applications are held to, read from
 * the shared cross-application fixture. */
const SIDE_VECTORS = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
        import.meta.url,
      ),
      { encoding: "utf8" },
    ),
  ) as {
    rendezvous: {
      sides: Array<{ side: RendezvousRole; handshakeRole: HandshakeRole }>;
    };
  }
).rendezvous.sides;

/** Only the fields the driver itself reads: the side that picks the handshake
 * role, and the secret/terms/expiry it hands to boundaries that are mocked here. */
const RECORD = {
  id: "record-under-test",
  side: "acceptor",
  sharedSecret: "stored-secret",
  exchangeFile: {},
} as unknown as ManagedExchangeRecord;

/** The same record stored for the other rendezvous side. */
const recordForSide = (side: RendezvousRole): ManagedExchangeRecord => ({
  ...RECORD,
  side,
});

/** The per-run input source; its contents never reach anything unmocked. */
const SOURCE = {} as unknown as ManagedInputSource;

const URLS = { create: () => "blob:artifact", revoke: () => {} };

/** Flush pending microtasks (and any queued macrotask), so a promise that has
 * not settled after this one is parked. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A message connection whose clean close parks until `release` (the peer takes
 * the final frame) or `failDrain` (the wait ends badly) is called -- the peer
 * that keeps the link up without ever reading the close sentinel. */
function makeParkedCloseMc() {
  let settle:
    { resolve: () => void; reject: (error: Error) => void } | undefined;
  const close = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  return {
    mc: {
      close,
      receive: vi.fn(),
      send: vi.fn(),
    } as unknown as MessageConnection,
    close,
    release: () => settle?.resolve(),
    failDrain: (error: Error) => settle?.reject(error),
  };
}

function acquireResources(side: RendezvousRole = "acceptor") {
  const peer = { disconnect: vi.fn(), destroy: vi.fn() };
  const conn = { close: vi.fn() };
  mockedRendezvous.mockResolvedValue(
    side === "inviter"
      ? { side: "inviter", peer: peer as unknown as Peer }
      : {
          side: "acceptor",
          peer: peer as unknown as Peer,
          conn: conn as unknown as DataConnection,
        },
  );
  // The inviter listens, so its channel arrives through the inbound wait rather
  // than out of the acquisition.
  mockedWaitForIncoming.mockResolvedValue(conn as unknown as DataConnection);
  return { peer, conn };
}

function runDriver(
  signal: AbortSignal,
  onWarning?: (message: string) => void,
  record: ManagedExchangeRecord = RECORD,
  peerWaitTimeoutMs?: number,
) {
  return runManagedExchangeInBrowser({
    record,
    source: SOURCE,
    signal,
    urls: URLS,
    ...(onWarning !== undefined ? { onWarning } : {}),
    ...(peerWaitTimeoutMs !== undefined ? { peerWaitTimeoutMs } : {}),
  });
}

/** Report how the clean close's wait for the peer ended, the way the transport
 * does: through the `onCloseOutcome` the driver handed `openPeerMessageConnection`
 * when it opened this run's connection. */
function reportCloseOutcome(outcome: PeerCloseOutcome) {
  mockedOpen.mock.calls[0][1]?.onCloseOutcome?.(outcome);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runManagedExchangeInBrowser", () => {
  test.each(SIDE_VECTORS)(
    "authenticates a stored $side in the vector's $handshakeRole role",
    async ({ side, handshakeRole }) => {
      // The role this flow reads out of the side-to-role table, taken from the
      // handshake's own arguments: a re-run that authenticated in the role its
      // partner also took never completes a handshake, and no web-to-web test
      // would notice, since both ends would have moved together.
      const { mc } = makeParkedCloseMc();
      mockedOpen.mockResolvedValue(mc);
      acquireResources(side);

      await runDriver(
        new AbortController().signal,
        undefined,
        recordForSide(side),
      );

      expect(mockedAuthenticate).toHaveBeenCalledWith(
        mc,
        handshakeRole,
        RECORD.sharedSecret,
        undefined,
      );
    },
  );

  test("a partner who never arrives reaches the classifier unchanged", async () => {
    // The wiring's rendezvous catch frees the peer and rethrows. Rethrowing the
    // SAME error is what the bookkeeping downstream depends on: it classifies the
    // benign "missed" outcome by instanceof, so a wrap here would file an absent
    // partner as a transport fault again.
    const { peer } = acquireResources("inviter");
    const noShow = new PartnerNoShowError("nobody arrived");
    mockedWaitForIncoming.mockRejectedValue(noShow);

    const rejection = await runDriver(
      new AbortController().signal,
      undefined,
      recordForSide("inviter"),
    ).catch((error: unknown) => error);

    expect(rejection).toBe(noShow);
    expect(peer.destroy).toHaveBeenCalledTimes(1);
  });

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
    // front of it rather than after it. The broker id is already freed, since
    // the teardown frees it ahead of the drain it does not wait on.
    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("completes the teardown once the drain ends", async () => {
    // Not awaiting the drain must not mean abandoning it: the close the run left
    // parked is still the teardown's to finish, and the id freed ahead of it is
    // not disturbed when it ends.
    const { mc, close, release } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();

    await runDriver(new AbortController().signal);
    release();
    await tick();

    expect(close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a failing teardown does not fail a completed run", async () => {
    // What makes starting the teardown without awaiting it safe: it swallows its
    // own faults, so a rejecting close neither replaces the run's outputs nor
    // shows as an unhandled rejection.
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
      onCloseOutcome: expect.any(Function),
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

  test("frees the broker id before a handshake failure reaches the caller", async () => {
    // The two halves the teardown's order buys, in the one moment they are both
    // visible: the lock is released (the failure is out) with the record's
    // rendezvous id already free, so the retry that derives the same id from the
    // unrotated secret is not refused as taken -- and the drain that the id
    // would otherwise have waited on is still in flight.
    const { mc, close } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    const { peer } = acquireResources();
    mockedAuthenticate.mockRejectedValueOnce(new Error("handshake refused"));

    await expect(runDriver(new AbortController().signal)).rejects.toThrow(
      "handshake refused",
    );

    expect(peer.disconnect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("finishes a failed handshake's drain after the failure reaches the caller", async () => {
    // Freeing the id first must not mean abandoning the drain behind it: the
    // parked close is still the teardown's to finish, so a fault it raises once
    // the failure is already out lands in the teardown's own handler rather than
    // escaping as an unhandled rejection.
    const { mc, failDrain } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    mockedAuthenticate.mockRejectedValueOnce(new Error("handshake refused"));
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});

    await expect(runDriver(new AbortController().signal)).rejects.toThrow(
      "handshake refused",
    );
    failDrain(new Error("close failed"));
    await tick();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
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

  test.each([
    ["ceiling", FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING],
    ["peer-gone", FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING],
    ["channel-not-open", FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING],
  ] as const)(
    "tells the operator when the close ends on %s",
    async (outcome, expected) => {
      // The gap this pins: a recurring run's close outcome reached nobody, so the
      // one population that cannot watch the exchange happen was never told its
      // partner may not have taken the final frame. The wording is the run
      // vocabulary's, unchanged from the one-shot path -- an exit that ran the
      // wait out and one that lost the link say different things about the
      // partner's copy.
      const { mc, release } = makeParkedCloseMc();
      mockedOpen.mockResolvedValue(mc);
      acquireResources();
      const onWarning = vi.fn();

      await runDriver(new AbortController().signal, onWarning);
      reportCloseOutcome(outcome);
      release();
      await tick();

      expect(onWarning.mock.calls).toEqual([[expected]]);
    },
  );

  test("says nothing when the peer's own close ends the wait", async () => {
    // The peer's close IS the delivery signal, so the run that got it has nothing
    // to report: a notice here would put a doubt on the one exit that resolves it.
    const { mc, release } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    const onWarning = vi.fn();

    await runDriver(new AbortController().signal, onWarning);
    reportCloseOutcome("peer-closed");
    release();
    await tick();

    expect(onWarning).not.toHaveBeenCalled();
  });

  test.each(["ceiling", "peer-gone", "channel-not-open"] as const)(
    "withholds a %s notice from a failed handshake's close",
    async (outcome) => {
      // The failed handshake's teardown drains a close of its own, whose wait ends
      // exactly the way a completed run's does. Both notices speak for a run that
      // succeeded here ("Your own results are complete"), so this one drains that
      // close and says nothing -- the failure has told the operator something
      // stronger already.
      const { mc, release } = makeParkedCloseMc();
      mockedOpen.mockResolvedValue(mc);
      acquireResources();
      mockedAuthenticate.mockRejectedValueOnce(new Error("handshake refused"));
      const onWarning = vi.fn();

      await expect(
        runDriver(new AbortController().signal, onWarning),
      ).rejects.toThrow("handshake refused");
      reportCloseOutcome(outcome);
      release();
      await tick();

      expect(onWarning).not.toHaveBeenCalled();
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
      // A cancel cuts the close's wait rather than letting it run out, and the
      // teardown behind the cancel ends the same close without a delivery signal
      // either way -- a partner notice on a run the operator stopped is noise.
      const { mc, release } = makeParkedCloseMc();
      mockedOpen.mockResolvedValue(mc);
      acquireResources();
      const controller = new AbortController();
      const onWarning = vi.fn();

      await runDriver(controller.signal, onWarning);
      controller.abort();
      reportCloseOutcome(outcome);
      release();
      await tick();

      expect(onWarning).not.toHaveBeenCalled();
    },
  );
});

describe("the peer-wait bound", () => {
  /** The options each half of the inviter's rendezvous was called with: the
   * acquisition that registers the peer, and the inbound wait that follows it. */
  function rendezvousOptions() {
    return {
      acquisition: mockedRendezvous.mock.calls[0][3],
      inboundWait: mockedWaitForIncoming.mock.calls[0][1],
    };
  }

  test("is left to the flows' own default when the caller supplies none", async () => {
    // The confinement this pins: the ONE producer of a bound is the scheduled
    // runner's window policy, and every other caller -- the attended surface
    // included -- leaves both waits on the shared human-timescale budget. The
    // options are matched exactly rather than by value, because a driver that
    // filled the bound in from a default of its own would produce the same
    // numbers here while taking the choice away from the policy that owns it.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources("inviter");
    const controller = new AbortController();

    await runDriver(controller.signal, undefined, recordForSide("inviter"));

    expect(rendezvousOptions().acquisition).toEqual({
      signal: controller.signal,
    });
    expect(rendezvousOptions().inboundWait).toEqual({
      signal: controller.signal,
    });
  });

  test("reaches both halves of the rendezvous when the caller supplies one", async () => {
    // A run that bounded only one half would keep waiting past the window's
    // close on the other, which is the wait a scheduled run's whole no-show
    // bookkeeping is read off.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources("inviter");
    const controller = new AbortController();

    await runDriver(
      controller.signal,
      undefined,
      recordForSide("inviter"),
      90_000,
    );

    expect(rendezvousOptions().acquisition).toEqual({
      signal: controller.signal,
      peerWaitTimeoutMs: 90_000,
    });
    expect(rendezvousOptions().inboundWait).toEqual({
      signal: controller.signal,
      timeoutMs: 90_000,
    });
  });
});

describe("naming what the agreed terms resolved to", () => {
  /** Drive core's pre-round call site with one resolved shape, then finish the
   * run. `runExchange` is mocked here, so this is the call site a real run
   * fires after the terms exchange completes. */
  function exchangeConfirming(runShape: ResolvedRunShape) {
    mockedRunExchange.mockImplementationOnce(
      (
        _conn: unknown,
        _role: unknown,
        _prepared: unknown,
        options: {
          onProtocolConfirmed?: RunExchangeOptions["onProtocolConfirmed"];
        },
      ) => {
        options.onProtocolConfirmed?.({} as LinkageTerms, "receiver", runShape);
        return Promise.resolve({} as ExchangeResult);
      },
    );
  }

  const OVER_BOUND_SHAPE: ResolvedRunShape = {
    cardinality: "many-to-many",
    localRecordCount: 3163,
    localDeclaredRecordCount: 3163,
    partnerRecordCount: 3164,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  };

  test("raises both notices to the caller's notice slot", async () => {
    // The seat this covers has nobody watching, so the notice is the whole
    // signal: a standing set of terms resolving to a deduplicating cardinality --
    // or projecting a pair table past the advisory bound -- would otherwise widen
    // the run with nothing said. Composed by core, so this seat and the attended
    // one cannot drift into two wordings of the one fact.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    exchangeConfirming(OVER_BOUND_SHAPE);
    const onWarning = vi.fn();
    const { cardinalityNotice, pairTableAdvisory } =
      describeResolvedRunShape(OVER_BOUND_SHAPE);

    await runDriver(new AbortController().signal, onWarning);

    expect(onWarning.mock.calls).toEqual([
      [cardinalityNotice],
      [pairTableAdvisory],
    ]);
  });

  test("raises nothing for a one-to-one run within the bound", async () => {
    // The cardinality that adds no multiplicity is the one every consent surface
    // already describes, so naming it here would be noise on the ordinary run --
    // and an unattended seat's noise is a log line nobody asked for.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    exchangeConfirming({
      cardinality: "one-to-one",
      localRecordCount: 3163,
      localDeclaredRecordCount: 3163,
      partnerRecordCount: 3164,
      localExpectsOutput: true,
      partnerAssociationTableWithheld: false,
    });
    const onWarning = vi.fn();

    await runDriver(new AbortController().signal, onWarning);

    expect(onWarning).not.toHaveBeenCalled();
  });

  test("drops the notices on a run the operator already stopped", async () => {
    // The live gate every call site of this wiring takes: a cancelled run's notices
    // are noise, and the caller's surface may be gone.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    exchangeConfirming(OVER_BOUND_SHAPE);
    const onWarning = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await runDriver(controller.signal, onWarning);

    expect(onWarning).not.toHaveBeenCalled();
  });
});

describe("filing the run's disclosure", () => {
  /** Make this run's exchange produce a real self-attested record, the way a
   * completed exchange does. The cast is the shape the assertions need: the rest of
   * `ExchangeResult` is the mocked outputs builder's business, not this run's. */
  async function exchangeYieldsRecord() {
    const record = await disclosureRecord();
    mockedRunExchange.mockResolvedValueOnce({
      audit: {
        record,
        keys: { version: "psilink-exchange-keys/v1", salts: {} },
      },
    } as unknown as Awaited<ReturnType<typeof runExchange>>);
    return record;
  }

  test("files this run's record against this exchange, once", async () => {
    // The gap this closes: a run that completes with nobody present had nowhere to
    // leave a record of what it disclosed, the completion download being an
    // attended affordance.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    const record = await exchangeYieldsRecord();

    await runDriver(new AbortController().signal);

    expect(mockedAppendDisclosure.mock.calls).toEqual([[RECORD.id, record]]);
  });

  test("files the disclosure before the run yields its outputs", async () => {
    // A tab closed on the completion screen must not be what decides whether the
    // disclosure was recorded, so the entry lands before the outputs are yielded.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    await exchangeYieldsRecord();
    let fileEntry: (() => void) | undefined;
    mockedAppendDisclosure.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        fileEntry = resolve;
      }),
    );
    let settled = false;

    const running = runDriver(new AbortController().signal).then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);

    fileEntry?.();
    await expect(running).resolves.toMatchObject({ exchange: OUTPUTS });
  });

  test("files nothing when the exchange produced no record", async () => {
    // Core omits the audit only when building the record threw after the exchange
    // succeeded; there is nothing to file, and inventing an entry would attest a
    // record that does not exist.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();

    await runDriver(new AbortController().signal);

    expect(mockedAppendDisclosure).not.toHaveBeenCalled();
  });

  test("a failed filing warns the operator and leaves the run's results standing", async () => {
    // The exchange has already happened, so a failed filing can neither undo it nor
    // make the run a failure: it points the operator at the completion download,
    // which is the only remaining route to a record of this disclosure.
    const { mc } = makeParkedCloseMc();
    mockedOpen.mockResolvedValue(mc);
    acquireResources();
    await exchangeYieldsRecord();
    mockedAppendDisclosure.mockRejectedValueOnce(new Error("quota exceeded"));
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const onWarning = vi.fn();

    const result = await runDriver(new AbortController().signal, onWarning);

    expect(result.exchange).toBe(OUTPUTS);
    expect(onWarning.mock.calls).toEqual([[DISCLOSURE_NOT_FILED_WARNING]]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
