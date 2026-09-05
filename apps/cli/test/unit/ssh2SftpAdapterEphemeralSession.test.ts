// The connection-per-poll cycle, from the idle release to the next dial.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";
import { FileTransportClient, UsageError } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { SFTP_REDIAL_WARN_INTERVAL } from "../../src/connection/sftpAdapterLedger";
import { SFTP_HEARTBEAT_INTERVAL_MS } from "../../src/connection/sftpHeartbeat";
import {
  adapterLog,
  boundarySaysReleaseTookTheSession,
  captureAdapterLog,
  ephemeralClient,
  installClient,
  notConnected,
  outstandingOperations,
  releasableClient,
  releaseBoundaryStands,
  slowClosingClient,
  stubAdapterLog,
  withheldCloseClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

// --- ephemeral session mode (connection-per-poll) ----------------------------
//
// In this mode the adapter releases its SFTP session at each poll-loop idle
// boundary (releaseForIdle) and re-dials at the start of the next cycle
// (ensureConnected), so no session is held across an idle gap a server's
// max-session/idle cap would drop. The release is NON-TERMINAL: it drives the
// underlying ssh2 Client's own end() (not ssh2-sftp-client's, which would latch
// endCalled and disable drop detection) so `closing` stays unlatched and the
// within-cycle recovery floor survives. Off by default, so all of this is inert
// unless the adapter is constructed with ephemeralSessions: true.

describe("ephemeral session mode (connection-per-poll)", () => {
  // A client that models what an ssh2 'end' does to an operation ALREADY ON THE
  // WIRE: ssh2-sftp-client's endListener both clears the session and rejects the
  // in-flight operation, and ssh2 emits 'end' BEFORE the 'close' that lands a
  // macrotask later. A connect() started inside that window is what the real
  // library fails: it resets the event flags and installs its own temp listeners,
  // so the release's own stale 'close' lands on the fresh handshake and rejects it
  // as an "Unexpected close event".
  function midWireTearClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, ending: false };
    // Every operation on the wire, not one: a drop tears the whole set, which is
    // what a fan-out case needs and what the real stack does (one cut, every
    // outstanding request failed). A single-operation case is the one-member set.
    const inFlight = new Set<(error: unknown) => void>();
    const failEveryInFlight = (error: unknown) => {
      const torn = [...inFlight];
      inFlight.clear();
      for (const fail of torn) fail(error);
    };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    // destroy() needs nothing from the peer, and the ssh2 Client's 'close' that
    // follows is what fires ssh2-sftp-client's global listener to clear the
    // session. A stand-in that drove neither leaves a retirement of a session
    // still held over an ended transport failing for want of a mock.
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      destroy: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        state.ending = true;
        state.live = false;
        failEveryInFlight(notConnected("exists"));
        setTimeout(() => {
          state.ending = false;
          rawClient.emit("close");
        }, 0);
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.ending)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      socket.writableEnded = false;
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      // An operation on a live session is outstanding for one macrotask -- the
      // server round trip the release can fall in the middle of -- and completes
      // unless it is torn first.
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const fail = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
            const answer = setTimeout(() => {
              inFlight.delete(fail);
              resolve(true);
            }, 0);
            inFlight.add(fail);
          }),
      ),
    };
    // The PARTNER dropping the session with operations on the wire while
    // withholding its CONNECTION close: only the SFTP channel goes, so the
    // operations are rejected over a transport ssh2 has ended while neither
    // ssh2-sftp-client listener that clears `sftp` has run.
    // The session property therefore still reads live, which is what leaves a
    // release something to close (see shouldRecoverFromSessionLoss for why the
    // ended transport is what makes this rejection a loss rather than an
    // application failure).
    const tearChannelWithholdingClose = () => {
      socket.writableEnded = true;
      failEveryInFlight(new Error("exists: channel is closed"));
    };
    return {
      client,
      connect,
      state,
      rawClient,
      tearChannelWithholdingClose,
    };
  }

  test("connect-then-release-then-reconnect brackets a single cycle's ops", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Idle boundary: the session is released for the inter-poll gap.
    await adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(state.live).toBe(false);

    // Start of the next cycle: an explicit re-dial re-establishes the session
    // (no lazy re-dial on a first-op failure).
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(state.live).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("the boundary release does not latch closing; recovery still works after it", async () => {
    // The release must be NON-TERMINAL: it must not run the adapter's end()
    // (which latches `closing` and disables recovery). Prove it by releasing,
    // re-dialing, then dropping mid-cycle and confirming the within-cycle
    // recovery floor still re-dials and completes the op.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (() => {
        let served = false;
        return (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => {
          if (served) return cb(Object.assign(new Error("EOF"), { code: 1 }));
          served = true;
          cb(null, [{ filename: "a.json", attrs: { mtime: 1, size: 1 } }]);
        };
      })(),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).session.isClosing).toBe(false);
    await adapter.ensureConnected();
    expect(connect).toHaveBeenCalledTimes(2);

    // Mid-cycle clean drop: the within-cycle recovery floor must still re-dial.
    state.live = false;
    const result = await adapter.list("/remote/dir");
    expect(result.map((e) => e.name)).toEqual(["a.json"]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  test("recovery re-dials are NOT bounded by the mid-exchange reconnection cap", async () => {
    // The cumulative cap applies only to the default held-session mode. In
    // connection-per-poll it is gated off in EVERY phase, so recovery re-dials are
    // unbounded by the count (bounded instead by the peer-inactivity ceiling): more
    // drops than max_reconnect_attempts still recover, where the default mode would
    // have failed terminally. This is what sustains the rendezvous phase -- which
    // holds one session across its waits, unlike the poll loop -- through a server
    // cap that cuts it repeatedly.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    // Budget of 1: the default mode would fail on the SECOND drop.
    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }
    // All three drops recovered past the default cap, none refused.
    expect(connect).toHaveBeenCalledTimes(4); // initial + 3 recoveries
    // They still count as mid-exchange recoveries -- only the CAP is off in this mode.
    expect(adapter.midExchangeReconnectCount).toBe(3);
  });

  test("the recovery warning describes the per-poll case, quoting no budget", async () => {
    // The warn line must match the mode the operator is running. In per-poll the
    // count is not charged against max_reconnect_attempts and the remedy the
    // default-mode line recommends is already in force, so quoting a remaining
    // budget would state a bound that does not apply and naming the flag would
    // advise a mode already on. The mode's own idle release never reaches this
    // warning, and the adapter cannot tell the two causes that do reach it apart --
    // a fault within a poll cycle, or a rendezvous wait cut by the server's cap --
    // so the line names both with the remedy for each, and says plainly that the
    // rendezvous case is the mode working rather than something to chase.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;
    await adapter.list("/remote/dir");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    // A real drop, stated plainly, with both of the causes it can have.
    expect(message).toContain("dropped mid-exchange");
    expect(message).toContain("the exchange continues");
    expect(message).toContain("within a poll cycle");
    expect(message).toContain("rendezvous");
    // The rendezvous cause is not sent after the link: it is the mode working.
    expect(message).toContain("needs nothing from you");
    // No budget quoted, and no advice to enable the mode already running.
    expect(message).not.toContain("max_reconnect_attempts=2");
    expect(message).not.toContain("further mid-exchange re-dial");
    expect(message).not.toContain("--connection-per-poll");
    // The bound that DOES apply is named instead.
    expect(message).toContain("peer_timeout_ms");
  });

  test("re-dial reuses the retained connect options (no re-prompt / same key + credentials)", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    const hostVerifier = () => true;
    await adapter.connect({
      host: "h",
      username: "u",
      password: "pw",
      hostVerifier,
      maxReconnectAttempts: 0,
    });
    await adapter.releaseForIdle();
    await adapter.ensureConnected();

    // The re-dial passed ssh2 the identical connect options as the first dial
    // (host, credentials, and the enforcing host-key verifier), minus the
    // psilink-specific maxReconnectAttempts connect() strips -- no re-prompt, no
    // freshly-built options.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1][0]).toEqual(connect.mock.calls[0][0]);
    expect(connect.mock.calls[1][0]).toMatchObject({
      host: "h",
      username: "u",
      password: "pw",
      hostVerifier,
    });
    expect(state.live).toBe(true);
  });

  test("a transient dial failure returns false (skip the cycle), not a throw", async () => {
    const wrapper = wrapperMethods();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("connect ECONNREFUSED");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Model a released (dropped) session so ensureConnected attempts a re-dial.
    state.live = false;

    await expect(adapter.ensureConnected()).resolves.toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
    // The transient failure is reported for observability, not thrown.
    expect(adapterLog(adapter).warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying"),
    );
  });

  test("a host-key mismatch on the re-dial is fatal (rejects, not skipped)", async () => {
    const wrapper = wrapperMethods();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    // A non-zero reconnect budget makes the single-attempt assertion meaningful:
    // a working predicate refuses to spend it re-running the key exchange against
    // the same untrusted host.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    state.live = false;

    await expect(adapter.ensureConnected()).rejects.toThrow("Host denied");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("releaseForIdle and ensureConnected are no-ops when the mode is off", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    // Default construction: ephemeral mode off.
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Neither boundary method touches the session in the default whole-exchange
    // model.
    await adapter.releaseForIdle();
    expect(rawClient.end).not.toHaveBeenCalled();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    // And neither dials on a session that is GONE either: in the default mode
    // session recovery owns re-establishment, so a cycle-boundary reconnect that
    // dialed here would open a session the mode never asked for.
    state.live = false;
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    // Stop the (default-mode) heartbeat so no unref'd timer lingers past the test.
    await adapter.end();
  });

  test("the heartbeat is not armed in ephemeral mode (no keepalive fires)", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = wrapperMethods();
      const { client } = ephemeralClient(wrapper);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stubAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // No session is held long enough to idle out, so the heartbeat is never
      // armed: however long an idle stretch runs, no realPath keepalive fires.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(client.realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an intentional cycle release + re-dial is not counted or warned as a drop", async () => {
    // The mode's OWN idle-boundary release (releaseForIdle drives the ssh2 Client's
    // end(), clearing this.sftp) and the next cycle's re-dial are its designed
    // behavior, NOT a server-forced mid-exchange drop, so neither may increment the
    // mid-exchange recovery counter or fire the recovery WARN (reserved for a
    // genuine unexpected drop the operator should see). Proven over both orderings
    // an exchange produces: the poll cycle's, where ensureConnected re-establishes
    // at cycle start ahead of the cycle's ops, and the send's, where the protocol
    // continuation resumes INTO the idle gap and the op itself re-establishes.
    // Each cycle runs a real op, so a boundary mistaken for a drop would show up.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await adapter.releaseForIdle();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      // A normal op runs against the freshly re-dialed session; ensureConnected
      // repopulated this.sftp, so withSessionRecovery must not treat it as a loss.
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
    }

    // The send ordering: the continuation resumes in the idle gap, with no cycle
    // start between the release and the ops, so the send's own list/put/rename are
    // what re-establish the session.
    for (let send = 0; send < 3; send += 1) {
      await adapter.releaseForIdle();
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
      await adapter.put(Buffer.from("frame"), "/remote/temp-send.tmp", {
        flags: "w",
      });
      await adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json");
    }

    // The designed release + re-dial is invisible to the recovery accounting under
    // both orderings: no server-forced drop happened, so the mid-exchange sub-count
    // stays zero (and no internal connect-retry bumped the merged total either).
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    // ... and the recovery WARN never fired: no message names a transparently
    // re-dialed mid-exchange drop. (connect() called once per cycle to re-dial,
    // never via the recovery path.)
    const recoveryWarns = warn.mock.calls.filter((c) =>
      (c[0] as string).includes("transparently"),
    );
    expect(recoveryWarns).toEqual([]);
    // Initial dial plus one re-dial per boundary, whichever side re-established it.
    expect(connect).toHaveBeenCalledTimes(7);
  });

  test("an ordinary release is totalled, warns nothing, and needs a session to count", async () => {
    // The outcome the mode exists for: this side drove the close, the partner's
    // server answered it within the bound, and the next cycle dialed a fresh
    // session. Nothing anomalous happened, so no occurrence draws a line and the
    // run total is the only thing telling an unattended operator the mode
    // delivered per-cycle sessions at all -- and the only denominator the forced
    // total has. A release that finds no session to close is not one of them: it
    // ended no boundary, so counting it would inflate that denominator with
    // boundaries the partner never answered.
    const { client } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
    }
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(adapter.releasedBoundaryCount).toBe(4);
    // Each of the mode's other per-cycle outcomes is its own count, and none of
    // them happened here.
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.declinedReleaseCount).toBe(0);
    expect(adapter.declinedCycleRedialCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(0);
    // Nothing was lost, so no boundary reaches the reconnect counters, and the
    // operator hears nothing at all about an ordinary cycle.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
  });

  test("an op after the idle release issues no attempt against the released session", async () => {
    // What the standing release boundary buys, stated as the only thing that
    // distinguishes it from letting the recovery path absorb the gap: the op is
    // spared the one attempt that is guaranteed to fail. The counters, the dial
    // count and the warnings are identical either way -- the re-dial that follows
    // a deliberate release is exempt from all three -- so the attempt itself is
    // what has to be asserted.
    const { client, state } = ephemeralClient(wrapperMethods());
    const attempts: boolean[] = [];
    client.exists = vi.fn(async () => {
      attempts.push(state.live);
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);

    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);

    // One attempt, and the session was live when it was made: without the gate
    // the first attempt lands on the released session, rejects, and only the
    // re-issue behind the recovery re-dial succeeds.
    expect(attempts).toEqual([true]);
  });

  test("an op issued while the release is in flight completes instead of failing terminally", async () => {
    // The release drives the ssh2 Client's end() and then awaits its 'close'.
    // ssh2-sftp-client clears `this.sftp` from that 'close', not from end(), so
    // between the two the session still reports live while the channel is already
    // going away. An op landing in that window rejects with a live-looking
    // session, which the clean-loss classifier treats as "not a session loss" and
    // fails terminally -- so the op must wait the release out and re-establish
    // rather than race it.
    const wrapper = wrapperMethods();
    const { client, connect, rawClient } = slowClosingClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Issue the op INSIDE the window: end() has been called, 'close' has not
    // landed, and the session still reads live.
    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();
    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);
    await release;

    // It rode the deliberate release, so it is neither counted nor warned.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // The initial dial plus the one re-establishment the op waited for.
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("an op issued during a release that records no boundary still waits the close window out", async () => {
    // The release in flight is the reading that covers the close window, and it
    // is the ONLY one that covers this release: the PEER began this teardown, so
    // no deliberate-release boundary is recorded and the boundary reading never
    // becomes true. An op issued into the window must still be held off -- it
    // would otherwise reject against a session that still reads live, which the
    // clean-loss classifier calls terminal.
    const { client, connect, rawClient, state } =
      slowClosingClient(wrapperMethods());
    const socket = rawClient._sock as Record<string, unknown>;
    // The peer's FIN has been consumed: ssh2 has emitted 'end' and the 'close' is
    // on its way, which is what makes this boundary the server's rather than this
    // adapter's.
    socket.readableEnded = true;
    // Each attempt records whether it was made inside the close window (the ssh2
    // Client's end() driven, its 'close' not yet landed, the session still
    // reading live).
    const attempts: boolean[] = [];
    client.exists = vi.fn(async () => {
      attempts.push(state.ending);
      if (state.ending)
        throw new Error("Channel closed while the connection was ending");
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);
    await release;

    // One attempt, made on the far side of the close rather than inside it.
    expect(attempts).toEqual([false]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("the release latch is one-shot: a drop after the cycle-start re-dial is counted and warned", async () => {
    // Exempting the release must not blanket-exempt the mode. The latch is
    // discharged by the re-establishment itself, so the very next cleared session
    // in that same cycle is what it looks like -- an unexpected drop -- and is
    // counted and warned like any other.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(adapter.midExchangeReconnectCount).toBe(0);

    // The server drops the freshly established session mid-cycle.
    state.live = false;
    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a release that finds no session charges the drop it found and leaves the next op none to charge", async () => {
    // releaseForIdle returns early when the session is ALREADY gone, which means
    // the server dropped it before the boundary -- a real drop the operator must
    // still see, and the release is the first thing in the run to observe it. It
    // charges the lost session there, records no reading that a release took it,
    // and warns the operator; the operation that follows re-dials over the same
    // ended generation and so adds nothing.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The drop lands at the tail of the cycle, before the idle boundary runs.
    state.live = false;
    await adapter.releaseForIdle();
    // Nothing to close: the release took its early return without driving end().
    expect(rawClient.end).not.toHaveBeenCalled();
    // The boundary charged the drop it found, and told the operator about a lost
    // session no operation was on the wire to report.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );
    // Not a boundary that RELEASED anything, so the release totals stay empty.
    expect(adapter.releasedBoundaryCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);

    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    // The operation re-dialed over the generation the boundary had already ended,
    // so one partner cut is still one in each counter.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("dropped mid-exchange"),
      ),
    ).toHaveLength(0);
  });

  test("a release during teardown does not latch", async () => {
    // `closing` is latched by end(), and a release arriving after it returns at
    // once without touching the session. Nothing was released, so nothing may be
    // latched: the latch exempts the next re-establishment from the reconnect
    // count and the operator warning, and a release that did nothing has no
    // exemption to hand out. Asserted on the latch itself because teardown leaves
    // no behavior to read it through -- `closing` also disables recovery.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.end();
    await adapter.releaseForIdle();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
  });

  // Every call site the idle release drives past the public API, and where it lives.
  // The release is the only caller of any of them, so an upgrade that relocates
  // one takes the boundary with it silently -- a session held across every idle
  // gap, which is the one thing this mode exists to prevent.
  const idleReleaseSeams = [
    {
      seam: "client.end()",
      remove: (raw: Record<string, unknown>) => {
        delete raw.end;
      },
    },
    {
      seam: "client.once()",
      remove: (raw: Record<string, unknown>) => {
        raw.once = undefined;
      },
    },
    {
      seam: "client.removeListener()",
      remove: (raw: Record<string, unknown>) => {
        raw.removeListener = undefined;
      },
    },
    {
      seam: "client._sock.destroy()",
      remove: (raw: Record<string, unknown>) => {
        delete (raw._sock as Record<string, unknown>).destroy;
      },
    },
    {
      seam: "client._sock.writableEnded",
      remove: (raw: Record<string, unknown>) => {
        delete (raw._sock as Record<string, unknown>).writableEnded;
      },
    },
  ] as const;

  test.each(idleReleaseSeams)(
    "connect fails loudly when $seam is gone",
    async ({ seam, remove }) => {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      remove(rawClient);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      const dial = adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      await expect(dial).rejects.toThrow(
        "which the installed SFTP library does not support",
      );
      // The call site itself is contributor-tier detail: logged at debug rather than
      // put on the operator's terminal.
      expect(adapterLog(adapter).debug).toHaveBeenCalledWith(
        expect.stringContaining(seam),
      );
    },
  );

  test("the default held-session mode is not held to the release's call sites", async () => {
    // Nothing outside connection-per-poll mode drives any of them, so failing a
    // held-session dial on a call site it never reaches would ground the whole SFTP
    // channel on an upgrade that costs it nothing.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    delete rawClient.end;
    delete (rawClient._sock as Record<string, unknown>).destroy;
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 2 }),
    ).resolves.toBeUndefined();
  });

  test("a release whose close never lands forces the transport closed, so the next cycle re-dials before any op", async () => {
    // The defect this closes: the release's own end() has already ended the
    // transport, so a session left set behind it can serve nothing -- yet
    // ensureConnected reads it as live and skips the cycle's dial, and the first
    // operation of that cycle rides the per-operation liveness deadline into a
    // terminal failure. The release must not hand that state to the next cycle: it
    // forces the socket closed itself, which clears the session, so the cycle
    // starts by dialing a fresh one.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, sock } =
        withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      // The listeners the adapter holds on the Client across a dial: its
      // persistent transport-lifecycle watch, and nothing else. Anything above
      // this afterwards is a close wait that outlived the release that armed it.
      const dialedCloseListeners = rawClient.listenerCount("close");
      const release = adapter.releaseForIdle();
      // The adapter's own close bound (not exported; a liveness safety check, not
      // a tunable). Past it the partner's close is still outstanding.
      await vi.advanceTimersByTimeAsync(5_000);
      await release;

      expect(rawClient.end).toHaveBeenCalledOnce();
      expect(sock.destroy).toHaveBeenCalledOnce();
      // The session the next cycle reads is gone, so the dial cannot be skipped.
      expect(client.sftp).toBeNull();
      expect(state.live).toBe(false);
      // Nothing was left waiting on the ssh2 Client for a close that never came;
      // the next cycle's release installs its own.
      expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);

      // The next cycle: the session is RE-ESTABLISHED before any operation is
      // issued, rather than an operation being issued against the ended transport.
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(state.live).toBe(true);
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      // A forced release is still this adapter's own deliberate boundary, so the
      // re-dial that follows it is neither counted nor reported as a drop.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      const dropWarns = warn.mock.calls.filter((c) =>
        (c[0] as string).includes("dropped mid-exchange"),
      );
      expect(dropWarns).toEqual([]);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close the connection");
      expect(message).toContain("closed it from this side");
      expect(message).toContain("dials a fresh session");
      expect(message).toContain("the exchange continues");
      expect(message).not.toContain("stall");
      expect(message).not.toContain("will not replace it");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a genuine drop in the cycle after a forced release is still counted and warned", async () => {
    // The forced release keeps the latch (it is the mode's own boundary), so the
    // latch has to be discharged by the re-establishment that follows exactly as
    // an ordinary release's is. Otherwise the first real server-side drop of the
    // new cycle would inherit the release's exemption and never reach the operator.
    vi.useFakeTimers();
    try {
      const { client, connect, state } = withheldCloseClient(
        wrapperMethods({
          opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
            cb(null, Buffer.from("h")),
          readdir: (
            _h: Buffer,
            cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
          ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
          close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
        }),
      );
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      await release;
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      expect(adapter.midExchangeReconnectCount).toBe(0);

      // The server drops the freshly established session mid-cycle.
      state.live = false;
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

      expect(connect).toHaveBeenCalledTimes(3);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a forced release warns on the first and then on the rate-escalated cadence", async () => {
    // A partner that never closes forces one of these EVERY cycle, so an unpaced
    // line would fill an hours-long exchange's log. It follows the cadence a
    // chronic mid-exchange re-dial already gets: the first, then every
    // SFTP_REDIAL_WARN_INTERVAL-th. Driven past two intervals rather than one, so
    // what is pinned is the repeating cadence and not merely its first escalation:
    // an off-by-one in either term would still produce one line at the interval.
    vi.useFakeTimers();
    try {
      const { client, sock, rawClient } = withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const dialedCloseListeners = rawClient.listenerCount("close");
      const cycles = SFTP_REDIAL_WARN_INTERVAL * 2 + 1;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const release = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;
        await adapter.ensureConnected();
      }

      expect(sock.destroy).toHaveBeenCalledTimes(cycles);
      // Every cycle re-dialed, and none of them was reported as a drop.
      expect(adapter.reconnectCount).toBe(0);
      // The forced total is a SUBSET of the released one -- the same boundary
      // reached two ways -- so an exchange whose every cycle was forced is treated
      // as the whole of its denominator rather than as a total with none.
      expect(adapter.forcedReleaseCount).toBe(cycles);
      expect(adapter.releasedBoundaryCount).toBe(cycles);
      expect(warn).toHaveBeenCalledTimes(3);
      // The number in each line is the number of boundaries the sentence
      // describes, which is the end-of-run summary's total: the first occurrence
      // and every interval-th after it, with the trailing occurrences past the
      // last one silent.
      expect(warn.mock.calls[0][0]).toContain(
        "1 idle boundary closed this way so far",
      );
      expect(warn.mock.calls[1][0]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} idle boundaries closed this way so far`,
      );
      expect(warn.mock.calls[2][0]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL * 2} idle boundaries closed this way so far`,
      );
      // Each cycle's release installs and consumes its own close wait, so nothing
      // accumulates on the ssh2 Client the library keeps across reconnects: the
      // count is back to the one persistent watch a dial leaves behind.
      expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the forced close's bound is ref'd; the release's own stays unref'd", async () => {
    // A liveness bound the process can exit out from under is not a bound. After
    // the socket is destroyed there is no ref'd handle left in the destroyed
    // socket's place, so an unref'd forced-close timer never fires: the one case
    // that bound exists for -- an ssh2 that stopped emitting 'close' on a destroyed
    // socket -- would exit the CLI silently mid-exchange instead of reaching the
    // check behind it. The release's own bound waits on a half-ended socket, which
    // is still a ref'd handle, so it keeps the unref'd-liveness-timer contract.
    vi.useFakeTimers();
    const armed: { delayMs: number; handle: { hasRef(): boolean } }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delayMs?: number,
        ...rest: unknown[]
      ) => {
        const handle = realSetTimeout(callback, delayMs, ...rest);
        armed.push({
          delayMs: delayMs ?? 0,
          handle: handle as unknown as { hasRef(): boolean },
        });
        return handle;
      }) as unknown as typeof setTimeout);
    try {
      const { client, sock } = withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      // The release's own close bound expires, then the forced close runs.
      await vi.advanceTimersByTimeAsync(5_000);
      await release;
      expect(sock.destroy).toHaveBeenCalledOnce();

      // The two bounds, identified by their unexported liveness safety-check delays.
      const releaseBound = armed.filter((timer) => timer.delayMs === 5_000);
      const forcedBound = armed.filter((timer) => timer.delayMs === 1_000);
      expect(releaseBound).toHaveLength(1);
      expect(forcedBound).toHaveLength(1);
      expect(releaseBound[0].handle.hasRef()).toBe(false);
      expect(forcedBound[0].handle.hasRef()).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("an op issued while the forced close runs waits for it instead of stalling on the ended transport", async () => {
    // The forced close runs past the release's own close bound, and the session
    // still reads live inside it. An operation arriving there must serialize behind
    // the release the way one arriving before the bound expired does -- otherwise
    // it is admitted by a session that cannot answer and rides the per-operation
    // liveness deadline, which is exactly the terminal failure being fixed.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, sock } =
        withheldCloseClient(wrapperMethods());
      const state = { destroyed: false };
      // A destroy whose 'close' lands a macrotask later, so the window is real.
      sock.destroy = vi.fn(() => {
        setTimeout(() => {
          state.destroyed = true;
          client.sftp = null;
          rawClient.emit("close");
        }, 0);
      });
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      // Inside the forced close: the destroy has been driven, its 'close' has not
      // landed, and the session still reads live.
      expect(sock.destroy).toHaveBeenCalledOnce();
      expect(state.destroyed).toBe(false);
      expect(client.sftp).not.toBeNull();

      const op = adapter.exists("/remote/out.json");
      await vi.advanceTimersByTimeAsync(1);
      await release;
      await expect(op).resolves.toBe(true);
      // The op ran on a session the release re-established, not on the ended one.
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a release that finds the transport still writable drops the latch", async () => {
    // The warning above rests on an ssh2 assumption -- end() ends the socket -- so it
    // is checked, not asserted: an ssh2 whose end() stopped ending the socket would
    // leave a genuinely live session held across the idle gap, the one thing this
    // mode exists to prevent, and the operator must be pointed at the changelog
    // rather than told to expect a stall. It is also the one branch where the
    // session may still be LIVE, so the check has to handle the latch as well as the
    // log line: a latch standing over a live session exempts its next genuine drop
    // from the count and the warning. Proven by dropping that session and requiring
    // the re-dial to be reported.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      // An end() that neither ends the transport nor closes anything, over a socket
      // that reports the half-close flag a live net.Socket does.
      rawClient.end = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      await release;

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("still writable"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ssh2 changelog"),
      );
      expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
      expect(state.live).toBe(true);

      // The server drops the session the release could not close: a real loss.
      state.live = false;
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second release that closes nothing draws a second warning", async () => {
    // The one degraded outcome off the shared warn cadence: it
    // keeps no run total, so a paced line would say "1" every time it fired and
    // the operator could not tell one occurrence from ten. Every occurrence is
    // its own record instead, which only a second one can measure -- the shared
    // cadence's interval is wide enough that it would swallow this line.
    vi.useFakeTimers();
    try {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      rawClient.end = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const release = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;
      }

      expect(
        warn.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("still writable")),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a release that finds the PEER tearing the connection down charges that drop and does not latch", async () => {
    // ssh2 emits 'end' on the peer's FIN and 'close' only after, and
    // ssh2-sftp-client's global 'end' listener leaves its session property set, so
    // a release can walk into a server-initiated teardown and find a session that
    // still reads live. Its end() closes nothing there -- the peer already did --
    // so the boundary charges the loss to the partner and records no reading that
    // a release took the session; latching would hand a genuine drop the release's
    // own exemption and the operator would never hear about it.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    const sock = rawClient._sock as { readableEnded?: boolean };
    // The peer's FIN has been consumed: this teardown is the server's.
    sock.readableEnded = true;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();

    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    expect(state.live).toBe(false);
    // The peer took this session, so the boundary charges it and says so, and it
    // is not one this side released.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );
    expect(adapter.releasedBoundaryCount).toBe(0);

    // The next operation re-establishes over the generation the boundary already
    // ended, so the one cut stays one in each counter.
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a throwing ssh2 end() rejects the release, leaving no boundary and no held transition", async () => {
    // The release takes the transition lock, arms its close wait, and records its
    // boundary before it drives the close, so a throw out of the ssh2 Client's
    // end() must undo all three: a lock never released would hold the next
    // operation's gate forever, the wait would sit on the shared client for a
    // close that is never coming, and the boundary would exempt a later genuine
    // drop from the count and the warning.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    const dialedCloseListeners = rawClient.listenerCount("close");
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );

    expect(state.live).toBe(true);
    // Nothing was left for the next operation to wait on: it runs on the session
    // the failed release never closed, rather than stalling out the close bound.
    const outcome = await Promise.race([
      adapter.exists("/remote/out.json").then(() => "ran"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 250)),
    ]);
    expect(outcome).toBe("ran");
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    // Back to the one persistent transport-lifecycle watch a dial leaves behind:
    // the release's own close wait was dismantled on its way out.
    expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);
  });

  // Every data-plane operation on the transport contract reaches the server
  // through the same recovery chokepoint, so every one must cross an idle
  // boundary the same way. The table below is that enumeration; the guard under
  // it is what makes adding an operation to the contract without a row here fail
  // `npm run typecheck` instead of silently leaving that operation uncovered.
  type RecoveredDataPlaneOp = Exclude<
    keyof FileTransportClient,
    // Lifecycle, not data plane: these establish and release the session the
    // table's ops ride on.
    | "connect"
    | "end"
    | "releaseForIdle"
    | "ensureConnected"
    | "beginTeardown"
    // The never-reject cleanup delete. It swallows every outcome instead of being
    // recovery-wrapped, so it never reaches this table's chokepoint: it neither
    // re-establishes before its attempt nor touches the reconnect counters and the
    // warning these rows assert about. What it does across a boundary instead --
    // record the cleanup and re-issue it at the next re-establishment -- is
    // asserted by ssh2SftpAdapterCleanupDrain.test.ts, which is what keeps this
    // exclusion an exclusion from THIS crossing rather than from coverage. Adding
    // a second such op is a deliberate edit of this list, not an omission.
    | "safeDelete"
  >;
  const dataPlaneOps = [
    { op: "list", run: (a: SSH2SFTPClientAdapter) => a.list("/remote/dir") },
    { op: "get", run: (a: SSH2SFTPClientAdapter) => a.get("/remote/in.json") },
    {
      op: "put",
      run: (a: SSH2SFTPClientAdapter) =>
        a.put(Buffer.from("payload"), "/remote/out.tmp", { flags: "w" }),
    },
    {
      op: "delete",
      run: (a: SSH2SFTPClientAdapter) => a.delete("/remote/out.json"),
    },
    {
      op: "rename",
      run: (a: SSH2SFTPClientAdapter) =>
        a.rename("/remote/out.tmp", "/remote/out.json"),
    },
    {
      op: "createExclusive",
      run: (a: SSH2SFTPClientAdapter) =>
        a.createExclusive("/remote/x-lock.json"),
    },
    {
      op: "exists",
      run: (a: SSH2SFTPClientAdapter) => a.exists("/remote/out.json"),
    },
  ] as const satisfies ReadonlyArray<{
    op: RecoveredDataPlaneOp;
    run: (adapter: SSH2SFTPClientAdapter) => Promise<unknown>;
  }>;
  type UncoveredDataPlaneOp = Exclude<
    RecoveredDataPlaneOp,
    (typeof dataPlaneOps)[number]["op"]
  >;
  // `true` only while the table covers the contract: an uncovered op makes the
  // annotation `never` and this initializer a type error.
  const everyDataPlaneOpIsCovered: UncoveredDataPlaneOp extends never
    ? true
    : never = true;

  test("every data-plane op re-establishes across an idle release, uncounted and unwarned", async () => {
    expect(everyDataPlaneOpIsCovered).toBe(true);

    for (const { op, run } of dataPlaneOps) {
      const wrapper = wrapperMethods({
        opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("h")),
        readdir: (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
        open: (
          _p: string,
          _f: number,
          _a: object,
          cb: (e: Error | null, h: Buffer) => void,
        ) => cb(null, Buffer.from("h")),
        close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
      });
      const { client, connect, state } = ephemeralClient(wrapper);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
      await adapter.releaseForIdle();
      expect(state.live, op).toBe(false);

      await run(adapter);

      expect(state.live, op).toBe(true);
      expect(connect, op).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount, op).toBe(0);
      expect(adapter.midExchangeReconnectCount, op).toBe(0);
      expect(warn, op).not.toHaveBeenCalled();
    }
  });

  test("the retain-mode ack write crosses an idle release uncounted and unwarned", async () => {
    // The ack write issues a put and then a rename with no session precondition
    // of its own. It rides the same chokepoint as every other op, so it needs no
    // placement guarantee: prove it by running the pair across a boundary, in the
    // order writeAck issues them.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);

    await adapter.put(Buffer.alloc(0), "/remote/temp-ack.tmp", { flags: "w" });
    await adapter.rename("/remote/temp-ack.tmp", "/remote/id-msg-ack.json");

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a host-key rejection on the post-release re-establishment fails the op terminally", async () => {
    // The post-release re-establishment is best-effort so it cannot break the
    // never-reject callers, but nothing is swallowed for good: a server presenting
    // a different key is a trust-boundary fault, and it must still reach the
    // caller as a terminal failure rather than being ridden to a timeout.
    const wrapper = wrapperMethods();
    const state = { live: true };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(async () => {
        if (!state.live) throw notConnected("exists");
        return true;
      }),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.releaseForIdle();

    await expect(adapter.exists("/remote/out.json")).rejects.toThrow(
      "Host denied",
    );
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("the default held-session mode is untouched: drops still counted, warned, and capped", async () => {
    // The release path is mode-gated at every point it touches, so the default
    // whole-exchange model behaves as though the mode did not exist: calling the
    // boundary methods changes nothing, and a genuine drop is still counted,
    // warned, and charged against the cumulative max_reconnect_attempts budget
    // whose exhaustion is terminal. What the default mode does share is the
    // transition lock -- its connect() and its end() take it too -- and the two
    // orderings that follow from that are pinned separately (the first dial
    // acquiring, so teardown cannot run the client down under it; and a connect
    // issued during an in-flight teardown parking before it refuses the re-open).
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    // Default construction: connection-per-poll off.
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    // Both boundary methods are no-ops here and leave no release behind.
    await adapter.releaseForIdle();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);

    // The one drop the budget allows: recovered, counted, and warned.
    state.live = false;
    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("dropped mid-exchange");
    expect(warn.mock.calls[0][0]).toContain("max_reconnect_attempts=1");

    // The next drop exhausts the cumulative budget and is terminal.
    state.live = false;
    const error = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain(
      "reconnection budget is exhausted",
    );
    // Two sessions lost, one of them recovered: the budget bounds the losses.
    expect(adapter.midExchangeReconnectCount).toBe(2);

    await adapter.end();
  });

  test("two concurrent ensureConnected calls open a single connect (serialized)", async () => {
    // poll()'s cycle-start ensureConnected and close()'s pre-drain ensureConnected
    // can fire concurrently; both must not open a parallel connect() on the one
    // shared Ssh2SftpClient (it shares connection-level listeners, so two handshakes
    // at once is unsafe). The second call must queue behind the first's re-dial
    // and observe the now-live session rather than dialing again.
    const wrapper = wrapperMethods();
    const state = { live: true };
    // A realistic handshake: the session becomes live only AFTER an async tick, not
    // synchronously. That lag is what makes the race real -- a second concurrent
    // ensureConnected that resumes before the first's connect settles still sees a
    // cleared session, so without serialization it would open a parallel connect().
    const connect = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // A released session, then two ensureConnected fired without awaiting between.
    state.live = false;
    const [a, b] = await Promise.all([
      adapter.ensureConnected(),
      adapter.ensureConnected(),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // The initial dial plus a SINGLE cycle-start re-dial: the second call awaited
    // the first's re-dial and saw the live session, so no parallel connect().
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("no idle boundary across a recovery arm closes the session the arm is using", async () => {
    // Dialing while a release is in flight, between the ssh2 Client's end() and its
    // 'close', hands the release's stale 'close' to the temp listeners connect()
    // installs and fails the handshake, charging a healthy exchange a re-dial retry
    // (or, at max_reconnect_attempts=0, failing the operation outright) for a
    // session the adapter closed on purpose. Closing between the re-dial and the
    // re-issue is worse: the re-issue rejects on a session this side has just taken
    // away, and a rename that DID land shows up as a failure.
    //
    // What rules both out is one span: an operation is counted outstanding from
    // where it is ISSUED to where it finally settles, the failed attempt, the
    // re-dial and the re-issue all inside it, so every boundary that falls across
    // an arm is HELD. Swept across the whole arm rather than placed at one point --
    // a depth that closed would be exactly the hole this pins shut, and there is no
    // reading of the count that names it.
    const depths = 40;
    for (let depth = 0; depth < depths; depth += 1) {
      const { client, connect, state, rawClient, tearChannelWithholdingClose } =
        midWireTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      // No reconnection budget at all, so a handshake lost to a release's close is
      // terminal rather than quietly retried a second later.
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const dialsBeforeTheDrop = connect.mock.calls.length;

      const op = adapter.exists("/remote/out.json");
      tearChannelWithholdingClose();
      // An idle transition queue is entered in the calling tick, so a release
      // called at this depth is a release ENTERED there.
      for (let tick = 0; tick < depth; tick += 1) await Promise.resolve();
      const release = adapter.releaseForIdle();

      await expect(op).resolves.toBe(true);
      await release;

      // Nothing was closed at any depth: the release found the operation counted
      // and kept the boundary, so the one dial in the run is the arm's re-dial
      // rather than a cycle start behind a close.
      expect(rawClient.end, `depth ${depth}`).not.toHaveBeenCalled();
      expect(adapter.heldBoundaryCount, `depth ${depth}`).toBe(1);
      expect(state.live, `depth ${depth}`).toBe(true);
      expect(
        connect.mock.calls.length - dialsBeforeTheDrop,
        `depth ${depth}`,
      ).toBe(1);
      // One partner cut, counted once and warned once whatever the depth.
      expect(adapter.midExchangeReconnectCount, `depth ${depth}`).toBe(1);
      expect(adapter.reconnectCount, `depth ${depth}`).toBe(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("dropped mid-exchange"),
        ),
        `depth ${depth}`,
      ).toHaveLength(1);
    }
  });

  // A release landing beside the recovery arm of an operation a PARTNER tore, at
  // both widths a cut can land on. A drop that withheld the partner's connection
  // close leaves the session property still set, so the release would find
  // something to close were it not held. The width decides how many arms recover
  // from the cut, and it may not decide how many drops the operator is told about;
  // the wide arms are what put a release next to a whole fan-out of recovery arms,
  // which is the interleaving the narrow ones cannot reach.
  test.each([1, 3])(
    "one partner drop tearing %i operation(s) is counted and warned once with a " +
      "release landing beside the arm",
    async (width: number) => {
      const { client, connect, state, tearChannelWithholdingClose } =
        midWireTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        trace: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const dialsBeforeTheDrop = connect.mock.calls.length;

      // Issued in one turn, so the cut lands on the whole set rather than on
      // whichever member was left.
      const ops = Array.from({ length: width }, () =>
        adapter.exists("/remote/out.json"),
      );
      tearChannelWithholdingClose();
      // An idle transition queue is entered in the calling tick, so a release
      // called here is a release ENTERED at this reading of the count.
      expect(outstandingOperations(adapter)).toBe(width);
      const release = adapter.releaseForIdle();

      // Every torn operation recovers on its own result, whichever of them dialed.
      expect(await Promise.all(ops)).toEqual(ops.map(() => true));
      await release;

      expect(state.live).toBe(true);
      expect(adapter.heldBoundaryCount).toBe(1);
      // One partner cut, one dial to recover it, counted once in each metric and
      // warned once, however many operations it tore.
      expect(connect.mock.calls.length - dialsBeforeTheDrop).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(adapter.reconnectCount).toBe(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("dropped mid-exchange"),
        ),
      ).toHaveLength(1);
    },
  );

  test("a release that closed over a partner-ended transport charges that drop and leaves no session for the next operation", async () => {
    // The release's boundary answers two questions and only one of them is the
    // recovery path's. Recording nothing at all here -- rather than a reading that
    // answers the session question without calling the loss deliberate -- would
    // leave the next operation to be issued at the session this release took, fail
    // on it, and be recovered as a SECOND drop: one partner cut reported twice,
    // with a doomed round trip and a spurious re-dial in between.
    const { client, connect, state, socket } =
      ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The partner dropped the session and withheld its connection close with nothing
    // on the wire: ssh2 answered the disconnect by ending its own half of the
    // transport, and no listener that clears the session has run, so the release
    // still finds one to close.
    socket.writableEnded = true;
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    // Not the exempting reading -- there was a loss here, and the next operation to
    // suffer one must not inherit an exemption from it -- while the session question
    // the same boundary answers is what the gate below acts on.
    expect(releaseBoundaryStands(adapter)).toBe(false);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(true);
    // The release ended this session, so it is one of the boundaries that
    // released one -- what ENDED the transport beneath it is the separate
    // question, and the answer to that is what the loss is charged on.
    expect(adapter.releasedBoundaryCount).toBe(1);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );

    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    // The one re-establishment is the gate's, ahead of the operation's first
    // attempt: nothing was issued at the released session, so the operation adds
    // no second report of the one drop.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(adapter.reconnectCount).toBe(1);
    // Scoped to the drop line rather than to the whole log: this stand-in's ssh2
    // end() closes a transport its caller had already ended, where the real stack
    // leaves it in half-close until the release's bound expires and the forced
    // close reports that path's line instead. What an operator sees for this shape
    // is driven against a real server in
    // test/integration/ephemeralSessionExchange.test.ts.
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("dropped mid-exchange"),
      ),
    ).toHaveLength(0);
  });

  test("an ordinary per-poll release counts no reconnection at any boundary", async () => {
    // The misreport the arm's read order exists to prevent, from the side the mode
    // spends every cycle on: release, re-dial, and nothing lost. Driven over several
    // cycles rather than one, because what would fail here is a boundary reading that
    // reported the mode's own lifecycle as a drop -- which it would do at every poll
    // interval, filling a long exchange's log and burying a chronic capper.
    const { client, connect } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);
      await adapter.releaseForIdle();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
    }

    // The first dial plus one per cycle, none of them a recovery re-dial.
    expect(connect).toHaveBeenCalledTimes(4);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("the idle release waits an in-flight re-dial out instead of leaving its session held", async () => {
    // The mirror of the case above: a re-dial (a cycle-start ensureConnected, as
    // close()'s pre-drain reconnect fires, or a recovery re-dial) can be
    // mid-handshake when the poll loop reaches its idle boundary. Without the
    // wait the release reads the not-yet-established session as "nothing to
    // release" and returns having released and latched nothing, and the dial then
    // lands a session that is held across the entire idle gap -- the one thing
    // this mode exists to prevent.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let finishDial!: () => void;
    const handshake = new Promise<void>((resolve) => {
      finishDial = resolve;
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; the cycle-start re-dial is held open
      // by the test so the boundary can fall in the middle of it.
      if (dials > 1) {
        dialReached();
        await handshake;
      }
      state.live = true;
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's re-dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;

    const release = adapter.releaseForIdle();
    finishDial();
    await expect(ready).resolves.toBe(true);
    await release;

    // The release found the session the dial established and closed it, so no
    // session is held across the idle gap.
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);
  });

  test("an idle release that was waiting when teardown began releases nothing", async () => {
    // The mirror of the cycle-start case below: the release can be parked for a
    // dial's whole budget, and close() can land in the middle of that wait, so the
    // check it made on entry is stale by the time it resumes. Driving the ssh2
    // Client's end() on the far side would run this release's teardown alongside
    // close()'s own client.end() on the one shared client, and latch a deliberate
    // release over a session the teardown is what ended.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let finishDial!: () => void;
    const handshake = new Promise<void>((resolve) => {
      finishDial = resolve;
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; the cycle-start re-dial is held open
      // by the test so the boundary and the teardown can both fall inside it.
      if (dials > 1) {
        dialReached();
        await handshake;
      }
      state.live = true;
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's re-dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;

    const release = adapter.releaseForIdle();
    // The teardown begins while that release is waiting the dial out.
    const closed = adapter.end();
    finishDial();
    await Promise.all([ready, release, closed]);

    // The release drove no ssh2 Client end() of its own: close() owns the final
    // teardown, and the release classified nothing at all.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("end() waits the in-flight release out before tearing the client down", async () => {
    // The release's ssh2 Client end() and this teardown's client.end() must not
    // overlap on the one shared Ssh2SftpClient. close() can reach end() while the
    // poll loop's last release is still between the two, so end() waits it out.
    const { client, state, rawClient } = slowClosingClient(wrapperMethods());
    let sessionAtTeardown: { live: boolean; ending: boolean } | undefined;
    client.end = vi.fn(async () => {
      sessionAtTeardown = { ...state };
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const closed = adapter.end();
    await Promise.all([release, closed]);

    // The library end() ran on the far side of the release's 'close', not inside
    // the window where the connection is going away but still reads live.
    expect(sessionAtTeardown).toEqual({ live: false, ending: false });
  });

  test("the cycle-start reconnect waits the in-flight release out before dialing", async () => {
    // close()'s pre-drain reconnect can fire while the poll loop's idle release is
    // still between the ssh2 Client's end() and its 'close'. In that window the
    // session still READS live, so a reconnect that does not wait reports success
    // without dialing -- and the release's 'close' then clears the session the
    // caller was just told it had.
    const { client, connect, state, rawClient } =
      slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const ready = adapter.ensureConnected();
    await Promise.all([release, ready]);

    await expect(ready).resolves.toBe(true);
    // The initial dial plus a real re-dial taken after the close: the caller is
    // handed a session that is actually live.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("a recovery re-dial waits a concurrent dial out and re-issues on its session", async () => {
    // A partner-side drop tears a concurrent operation just as the cycle's own dial
    // re-establishes the session, so two re-establishment paths are live at once.
    // ssh2's Client.connect() on a still-writable socket ends the socket and
    // re-connects from its 'close', which kills the first handshake and rejects the
    // SECOND dial -- so a recovery that dialed alongside the cycle dial would fail
    // the very operation it exists to save. It waits that dial out, finds the
    // session it established, and re-issues on it rather than dialing at all.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let failInFlight: ((error: unknown) => void) | undefined;
    let dialsInFlight = 0;
    let peakDialsInFlight = 0;
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      dialsInFlight += 1;
      peakDialsInFlight = Math.max(peakDialsInFlight, dialsInFlight);
      try {
        // The initial dial completes at once; the re-establishment takes a real
        // handshake's worth of time, so a second dial opened while it runs -- the
        // recovery waking one microtask behind the cycle start -- is unmistakable.
        if (dials > 1) await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
      }
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        setTimeout(() => rawClient.emit("close"), 0);
      }),
    });
    const tearFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("exists"));
      failInFlight = undefined;
    };
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    // No reconnection budget at all, so a handshake lost to a concurrent dial is
    // terminal rather than quietly retried a second later.
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const torn = adapter.exists("/remote/out.json");
    // The partner drops the session with that operation on the wire, and the cycle
    // takes its own dial before the rejection has finished travelling: the recovery
    // wakes one microtask behind that dial.
    tearFromServer();
    const cycleDial = adapter.ensureConnected();

    await expect(cycleDial).resolves.toBe(true);
    await expect(torn).resolves.toBe(true);

    // One dial at a time, and only one re-establishment in total: the recovery
    // re-issued the torn operation on the session the cycle dial had established.
    expect(peakDialsInFlight).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  test("a cycle-start reconnect that was waiting when teardown began does not dial", async () => {
    // ensureConnected can be parked for a release's whole close bound or a dial's
    // whole budget, and close() can land in the middle of that wait, so the check
    // it made on entry is stale by the time it resumes. Dialing on the far side
    // would leave a session outliving the teardown, and reporting a live session
    // would hand the caller operations to issue on it.
    const { client, connect, rawClient } = slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const ready = adapter.ensureConnected();
    // The teardown begins while that reconnect is waiting the release out.
    const closed = adapter.end();
    await Promise.all([release, ready, closed]);

    await expect(ready).resolves.toBe(true);
    // The initial dial is the only one: no session was established past the
    // teardown.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("teardown never runs the client down under a recovery re-dial", async () => {
    // The recovery of an operation a partner-side drop tore off the wire and the
    // teardown both queue behind the cycle's own dial, and the recovery queues
    // FIRST, so it reaches the front first -- with the teardown latch set behind
    // it. Dialing there is wrong twice over: a handshake runs against the
    // teardown's client.end() on the one shared Ssh2SftpClient, and
    // ssh2-sftp-client's own end() short-circuits on the cleared session, resolving
    // WITHOUT ending the ssh2 Client -- so close() returns while an SSH handshake
    // still holds a ref'd socket, and the CLI's clean close lingers for the dial's
    // budget.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let failInFlight: ((error: unknown) => void) | undefined;
    let dialsInFlight = 0;
    let dials = 0;
    // Every session transition in the order it happened, each teardown holding
    // the number of handshakes live at that instant -- the sequence is the
    // assertion, since a teardown recorded alongside a dial is the overlap.
    const events: string[] = [];
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; a re-dial takes a real handshake's
      // worth of time, so a teardown that runs inside one is unmistakable.
      if (dials === 1) {
        state.live = true;
        return;
      }
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
        events.push("dial:end");
      }
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        setTimeout(() => rawClient.emit("close"), 0);
      }),
    });
    const tearFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("exists"));
      failInFlight = undefined;
    };
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn(async () => {
        events.push(`teardown:client.end (dialsInFlight=${dialsInFlight})`);
        return true;
      }),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const torn = adapter.exists("/remote/out.json");
    // The partner drops the session with that operation on the wire, and the cycle
    // takes its own dial: the recovery parks on that dial.
    tearFromServer();
    const cycleDial = adapter.ensureConnected();
    // Let the torn operation's rejection travel its promise chain into the
    // recovery path, so the recovery is parked on the cycle dial before the
    // teardown parks behind it. Draining microtasks cannot advance that dial,
    // which settles on a macrotask, so it is still in flight here.
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    const closed = adapter.end();
    await Promise.allSettled([cycleDial, torn, closed]);

    // The cycle dial ran to completion, the recovery behind it dialed nothing, and
    // the teardown's client.end() ran with no handshake live.
    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
