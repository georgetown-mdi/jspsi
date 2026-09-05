import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { expect } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  TransportOperationStalledError,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SFTP_HEARTBEAT_INTERVAL_MS } from "../../src/connection/sftpHeartbeat";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// What the adapter does with a partner server that goes SILENT rather than
// failing: nothing closes, nothing resets, and no further byte arrives, so the
// client can learn of it only from its own liveness deadline -- and a stall is
// deliberately never a reconnect trigger (docs/spec/CHANNEL_SECURITY.md). The
// recorded outcome is the deliverable, so each case observes the ssh2 Client, the
// socket beneath it, and the server's own request meter rather than reasoning
// about the adapter.
//
// Two shapes of that silence run here, one per control. The VANISH silences the
// whole session: a live session that stops answering mid-exchange, which the
// first group drives. The WITHHELD REPLY silences one request: the server accepts
// it, answers every other request on the same channel, and never writes that
// one's status -- which is what strands a single metadata round trip or a single
// transfer, and is the group at the end of this file.
//
// Only the in-process backend offers either (a native sshd cannot be told to stop
// answering), so these run there and stand up their own server to reach the
// session controls -- the shared globalSetup server hands the workers only its
// connection details. The withheld-close partner, which is the nearest neighbour
// and a materially different case (it fires only in answer to the client's own
// disconnect, and it ends the transport), is heldSessionWithheldClose.test.ts and
// ephemeralSessionExchange.test.ts.

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam. Neither a vanished session nor a withheld reply ever answers, so
// this is what ends an operation outstanding across either; at the production
// 60 s these cases would wait a minute longer for the same rejection.
const STALL_DEADLINE_MS = 3_000;

// A measured margin absorbing millisecond-truncation and timer-fire jitter on a
// Date.now()-delta taken around this deadline's own setTimeout: 2000 runs of a
// 100 ms timer, measured 2026-09-02, landed as much as 3 ms below nominal.
// Subtracted from the deadline before a >= assertion so an elapsed delta reading
// one tick short of the nominal interval still passes.
const STALL_DEADLINE_MEASUREMENT_MARGIN_MS = 4;

// How long a case watches a vanished session with nothing outstanding before
// calling it silent. Nothing schedules server traffic inside it -- see the
// heartbeat guard each idle case asserts -- so the window's length decides only
// how long the run takes.
const QUIET_OBSERVATION_MS = 5_000;

// Each idle boundary costs the release's own close bound before the forced close
// lands, and the stalled cases cost the deadline above.
const TEST_TIMEOUT_MS = 120_000;

// How long the stalled second connection is watched for the key exchange a
// served connection answers an identification string with at once. Loopback
// turns that round trip around immediately, so silence across this window is
// the stall holding that socket rather than an answer still on its way.
const STALLED_SILENCE_MS = 500;

// The bound on anything a release case waits for the server to do. Every one of
// them is loopback work the release triggers at once; the bound is here so a
// case that never gets it fails loudly instead of running to the file's timeout.
const SERVER_RESPONSE_WAIT_MS = 10_000;

// The two emitters a client learns of a lost session from: the ssh2 Client and
// the socket beneath it. Both are internals, which is the point -- a vanished
// session is defined by what does NOT reach them.
interface ObservedEmitter {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

interface ObservedSocket extends ObservedEmitter {
  bytesRead: number;
  writableEnded?: boolean;
  readableEnded?: boolean;
}

interface ObservedClient extends ObservedEmitter {
  _sock?: ObservedSocket;
}

// Whether the client's own view of the session is still an established one: the
// library's session property set over a transport neither half of which has
// ended. It is what a vanished session leaves untouched, so a case reads it as
// the positive side of the silence -- the client is not merely uninformed, it
// holds a session it has every reason to believe in.
function sessionReadsEstablished(adapter: SSH2SFTPClientAdapter): boolean {
  const client = (
    adapter as unknown as {
      client: { sftp?: unknown; client?: ObservedClient };
    }
  ).client;
  const socket = client.client?._sock;
  return (
    Boolean(client.sftp) &&
    socket !== undefined &&
    socket.writableEnded !== true &&
    socket.readableEnded !== true
  );
}

/**
 * A census of everything the server side made the client hear since it was
 * installed: the transport-loss events, and the bytes the server put on the wire.
 */
interface QuietCensus {
  /** Loss events heard, in order, as `client:end`, `socket:close` and so on. */
  heard: string[];
  /** Bytes the server has sent on this socket since the census began. */
  bytesFromServer(): number;
  /** Take the listeners back off, so a later teardown is not recorded. */
  stop(): void;
}

// Watch the live session's ssh2 Client and its socket. Throws rather than
// recording nothing when either is unreachable: an empty census taken from an
// emitter that was never found would make every "the client heard nothing"
// assertion below pass for the wrong reason. The positive-control case is the
// other half of that -- it drives an ordinary drop through this same census and
// requires it to be non-empty.
function watchForLostSession(adapter: SSH2SFTPClientAdapter): QuietCensus {
  const client = (adapter as unknown as { client: { client?: ObservedClient } })
    .client.client;
  if (!client) throw new Error("no ssh2 Client to watch beneath the adapter");
  const socket = client._sock;
  if (!socket)
    throw new Error("no transport socket to watch beneath the ssh2 Client");
  const heard: string[] = [];
  const installed: Array<[ObservedEmitter, string, () => void]> = [];
  const record = (
    emitter: ObservedEmitter,
    label: string,
    event: string,
  ): void => {
    const listener = (): void => {
      heard.push(`${label}:${event}`);
    };
    emitter.on(event, listener);
    installed.push([emitter, event, listener]);
  };
  for (const event of ["end", "close", "error"])
    record(client, "client", event);
  for (const event of ["end", "close", "error"])
    record(socket, "socket", event);
  const baseline = socket.bytesRead;
  return {
    heard,
    bytesFromServer: () => socket.bytesRead - baseline,
    stop: () => {
      for (const [emitter, event, listener] of installed) {
        emitter.removeListener(event, listener);
      }
    },
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait on something the server does, and fail naming it rather than letting a
// case go on reading a state that never arrived.
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SERVER_RESPONSE_WAIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

/** A bare TCP connection to the test server, and what the server sent it. */
interface SecondConnection {
  /** Bytes the server has written to it since it was dialed. */
  bytesFromServer(): number;
  /** Send an SSH identification string, which is what draws the key exchange. */
  sendIdentification(): void;
  close(): void;
}

// Dial the server without speaking SSH: the backend accepts and tracks this
// connection like any other, so a control armed at accept time takes hold of its
// socket, but it never authenticates, so it never becomes the established
// session the vanish targets. It is the OTHER connection each release case
// needs -- the one a per-control stop is called for, while the vanish holds a
// different one.
async function dialSecondConnection(
  host: string,
  port: number,
): Promise<SecondConnection> {
  const socket = net.connect(port, host);
  let received = 0;
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  socket.on("error", () => {});
  await once(socket, "connect");
  return {
    bytesFromServer: () => received,
    sendIdentification: () => {
      socket.write("SSH-2.0-psilinkprobe\r\n");
    },
    close: () => socket.destroy(),
  };
}

interface SilencedFixture {
  srv: Awaited<ReturnType<typeof startInProcessSftpServer>>;
  adapter: SSH2SFTPClientAdapter;
  /** The served directory on the host, where a case plants what it drives. */
  dir: string;
  /** The served directory, as the client names it over SFTP. */
  remote: string;
  cleanup: () => Promise<void>;
}

// Stand up a server, connect one adapter to it, and prove the session live with a
// single settled round trip. exists() rather than list(): the listing guard closes
// its directory handle fire-and-forget once list() has resolved, so a trailing
// CLOSE would land inside the measured window a case opens right after this.
async function startSilencedFixture(
  label: string,
  options: { ephemeralSessions?: boolean } = {},
): Promise<SilencedFixture> {
  const srv = await startInProcessSftpServer();
  const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, `${label}-`));
  const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
  const adapter = new SSH2SFTPClientAdapter({
    ...options,
    stallDeadlineMs: STALL_DEADLINE_MS,
  });
  await adapter.connect({
    host: srv.handle.host,
    port: srv.handle.port,
    ...serverAuth(srv.handle.usera),
  });
  await expect(adapter.exists(remote)).resolves.toBe(true);
  srv.sessionControls.requests.reset();
  srv.sessionControls.resetHandshakeCount();
  return {
    srv,
    adapter,
    dir,
    remote,
    cleanup: async () => {
      // Ahead of any disconnect: a client's end() awaits a close a vanished
      // server can never send, and a withheld reply left standing would strand
      // the teardown's own round trip, so teardown would otherwise spend the
      // adapter's whole close bound on every case.
      srv.inject.withholdOn = null;
      srv.sessionControls.restoreVanishedSessions();
      await adapter.end().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    },
  };
}

inProcessOnly(
  "a held session vanishing under an operation strands it until the adapter's " +
    "own deadline, with nothing reaching the client",
  async () => {
    const { srv, adapter, remote, cleanup } =
      await startSilencedFixture("held-outstanding");
    const census = watchForLostSession(adapter);
    try {
      const [rejection, logs] = await withCapturedLogs(
        async () => {
          srv.sessionControls.vanishActiveSession();
          return await adapter.list(remote).then(
            () => undefined,
            (err: unknown) => err,
          );
        },
        (level) => level === "WARN" || level === "ERROR",
      );
      census.stop();

      // The operation ends on the adapter's own wall-clock deadline, the only
      // thing that could have ended it.
      expect(rejection).toBeInstanceOf(TransportOperationStalledError);
      // Not one loss event and not one byte: from the client's side the session
      // did not end, it went quiet.
      expect(census.heard).toEqual([]);
      expect(census.bytesFromServer()).toBe(0);
      // The server did receive the request and did write its reply -- the wire is
      // what did not carry it, which is what makes this different from a server
      // that stopped serving.
      const meter = srv.sessionControls.requests.read();
      expect(meter.receivedByOp).toEqual({ OPENDIR: 1 });
      expect(meter.answeredByOp).toEqual({ OPENDIR: 1 });
      // A stall is never a reconnect trigger, so nothing re-dialed and the
      // exchange's reconnect budget -- the full default, not a zeroed one -- is
      // untouched. The terminal outcome is the stall itself, not an exhausted
      // allowance.
      expect(DEFAULT_MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(adapter.reconnectCount).toBe(0);
      expect(srv.sessionControls.handshakeCount()).toBe(0);
      // The operator is told nothing while it stands: the mid-exchange drop
      // warning reports a drop that was recovered, and there was no drop.
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
    } finally {
      census.stop();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a held session vanishing with nothing outstanding is invisible until the " +
    "next operation pays the deadline",
  async () => {
    const { srv, adapter, remote, cleanup } = await startSilencedFixture(
      "held-nothing-outstanding",
    );
    const census = watchForLostSession(adapter);
    try {
      // Nothing the adapter schedules may fall inside the quiet window, or the
      // silence measured would be an artifact of the window's length rather than
      // of the vanish. The heartbeat is the traffic that would: it is the only
      // thing the adapter puts on an idle session.
      expect(QUIET_OBSERVATION_MS).toBeLessThan(SFTP_HEARTBEAT_INTERVAL_MS);

      const [rejection, logs] = await withCapturedLogs(
        async () => {
          srv.sessionControls.vanishActiveSession();
          await delay(QUIET_OBSERVATION_MS);

          // Nothing at all: no loss event, no byte, no request the server saw,
          // and a session that still reads established from both ends.
          expect(census.heard).toEqual([]);
          expect(census.bytesFromServer()).toBe(0);
          expect(srv.sessionControls.requests.read().received).toBe(0);
          expect(srv.sessionControls.handshakeCount()).toBe(0);
          expect(sessionReadsEstablished(adapter)).toBe(true);

          // The next operation is what meets it, and pays the full deadline.
          const started = Date.now();
          const error = await adapter.list(remote).then(
            () => undefined,
            (err: unknown) => err,
          );
          return { error, elapsedMs: Date.now() - started };
        },
        (level) => level === "WARN" || level === "ERROR",
      );
      census.stop();

      expect(rejection.error).toBeInstanceOf(TransportOperationStalledError);
      expect(rejection.elapsedMs).toBeGreaterThanOrEqual(
        STALL_DEADLINE_MS - STALL_DEADLINE_MEASUREMENT_MARGIN_MS,
      );
      expect(census.heard).toEqual([]);
      expect(census.bytesFromServer()).toBe(0);
      expect(adapter.reconnectCount).toBe(0);
      // Silent to the operator too, right up to the operation that fails.
      expect(logs).toEqual([]);
    } finally {
      census.stop();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a connection-per-poll session vanishing under an operation strands it too, " +
    "and the next idle boundary closes over it",
  async () => {
    const { srv, adapter, remote, cleanup } = await startSilencedFixture(
      "per-poll-outstanding",
      { ephemeralSessions: true },
    );
    const census = watchForLostSession(adapter);
    try {
      const [outcome, logs] = await withCapturedLogs(
        async () => {
          srv.sessionControls.vanishActiveSession();
          const error = await adapter.list(remote).then(
            () => undefined,
            (err: unknown) => err,
          );
          // Read before the boundary: the release forces the socket closed from
          // this side, which the census would record as a loss the server never
          // sent.
          const heardWhileVanished = [...census.heard];
          const bytesWhileVanished = census.bytesFromServer();
          census.stop();

          // The idle boundary meets the session the stall could not end. Its own
          // end() gets no answer either, so it spends its bound and forces the
          // close; the next cycle dials a fresh session and the exchange goes on.
          await adapter.releaseForIdle();
          const exists = await adapter.exists(remote);
          return { error, heardWhileVanished, bytesWhileVanished, exists };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The mode makes no difference to the stranding itself: the same deadline
      // ends the same operation, with the same nothing on the wire.
      expect(outcome.error).toBeInstanceOf(TransportOperationStalledError);
      expect(outcome.heardWhileVanished).toEqual([]);
      expect(outcome.bytesWhileVanished).toBe(0);
      // What the mode does change is the recovery: the boundary is a close this
      // side can force, so the exchange continues over one fresh session.
      expect(adapter.forcedReleaseCount).toBe(1);
      expect(outcome.exists).toBe(true);
      expect(srv.sessionControls.handshakeCount()).toBe(1);
      // None of it is charged as a reconnect: the vanish was never seen as a lost
      // session, and the boundary's forced close is not one.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      const forced = logs.filter((entry) =>
        entry.message.includes("did not close the connection"),
      );
      expect(forced).toHaveLength(1);
      expect(forced[0].level).toBe("WARN");
    } finally {
      census.stop();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a connection-per-poll session vanishing with nothing outstanding costs " +
    "only the idle boundary's forced close",
  async () => {
    const { srv, adapter, remote, cleanup } = await startSilencedFixture(
      "per-poll-nothing-outstanding",
      { ephemeralSessions: true },
    );
    const census = watchForLostSession(adapter);
    try {
      expect(QUIET_OBSERVATION_MS).toBeLessThan(SFTP_HEARTBEAT_INTERVAL_MS);

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          srv.sessionControls.vanishActiveSession();
          await delay(QUIET_OBSERVATION_MS);
          const heardWhileVanished = [...census.heard];
          const bytesWhileVanished = census.bytesFromServer();
          const requestsWhileVanished =
            srv.sessionControls.requests.read().received;
          census.stop();

          await adapter.releaseForIdle();
          const exists = await adapter.exists(remote);
          return {
            heardWhileVanished,
            bytesWhileVanished,
            requestsWhileVanished,
            exists,
          };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Invisible right up to the boundary: no operation met it, so nothing paid
      // a deadline for it.
      expect(outcome.heardWhileVanished).toEqual([]);
      expect(outcome.bytesWhileVanished).toBe(0);
      expect(outcome.requestsWhileVanished).toBe(0);
      // The boundary is the whole cost, and the exchange continues over the one
      // fresh session that follows it.
      expect(adapter.forcedReleaseCount).toBe(1);
      expect(outcome.exists).toBe(true);
      expect(srv.sessionControls.handshakeCount()).toBe(1);
      expect(adapter.reconnectCount).toBe(0);
      const forced = logs.filter((entry) =>
        entry.message.includes("did not close the connection"),
      );
      expect(forced).toHaveLength(1);
      expect(forced[0].level).toBe("WARN");
    } finally {
      census.stop();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the same census records an ordinary drop, so a silent one is a measurement " +
    "and not a mis-wired watcher",
  async () => {
    // The positive control for every "the client heard nothing" assertion above.
    // Without it a census taken from the wrong emitter, or one whose listeners
    // never fired, would report silence for a server that was closing sessions
    // normally.
    const { srv, adapter, cleanup } =
      await startSilencedFixture("drop-control");
    const census = watchForLostSession(adapter);
    try {
      srv.sessionControls.dropActiveAfterMs(1);
      const deadline = Date.now() + 30_000;
      while (!census.heard.includes("client:close") && Date.now() < deadline) {
        await delay(50);
      }
      census.stop();

      // The partner's own disconnect: bytes on the wire, then the transport loss
      // the client learns from, on both emitters.
      expect(census.bytesFromServer()).toBeGreaterThan(0);
      expect(census.heard).toContain("client:close");
      expect(census.heard).toContain("socket:close");
    } finally {
      census.stop();
      srv.sessionControls.dropActiveAfterMs(0);
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

// The vanish silences its socket in the same pools the withheld-close and
// stalled-handshake controls draw from, so stopping either of those is a release
// path that reaches a vanished session it was never aimed at. These two cases
// hold that release to all-or-nothing over the wire: afterwards the vanished
// session both answers again AND can be hung up by the server, the two halves
// the vanish took together. A half-released session -- answering but unclosable,
// or closable but mute -- is neither the black hole a case measures over nor a
// working session, so anything read from it would mean nothing.
inProcessOnly(
  "unstalling another connection's dial releases a vanished session whole",
  async () => {
    const { srv, adapter, remote, cleanup } = await startSilencedFixture(
      "stall-release-vanished",
    );
    const census = watchForLostSession(adapter);
    srv.sessionControls.stallHandshakeOnConnect = true;
    const stalled = await dialSecondConnection(
      srv.handle.host,
      srv.handle.port,
    );
    try {
      // ssh2 writes the server's identification string as it constructs the
      // connection, before any control can reach that socket, so the stall is
      // measured by what does NOT follow it: this dial sends its own
      // identification and no key exchange comes back.
      await waitFor(
        () => stalled.bytesFromServer() > 0,
        "the server's identification string",
      );
      const identificationBytes = stalled.bytesFromServer();
      stalled.sendIdentification();
      await delay(STALLED_SILENCE_MS);
      expect(stalled.bytesFromServer()).toBe(identificationBytes);

      srv.sessionControls.vanishActiveSession();
      srv.sessionControls.stopStallingHandshakes();

      // The same dial once the stall is stopped: the key exchange the muted one
      // never got, so that socket really was in the pool this stop drains -- the
      // pool the vanish mutes the established session's socket into.
      const unstalled = await dialSecondConnection(
        srv.handle.host,
        srv.handle.port,
      );
      unstalled.sendIdentification();
      await waitFor(
        () => unstalled.bytesFromServer() > identificationBytes,
        "the unstalled dial's key exchange",
      );
      unstalled.close();

      // The vanished session's write is its own again: an operation completes,
      // and the server's bytes reach the client.
      await expect(adapter.exists(remote)).resolves.toBe(true);
      expect(census.bytesFromServer()).toBeGreaterThan(0);
      // And so are its closers, which is the half a stop of the muted pool alone
      // would leave faked: the server can end this session and the client hears
      // it go.
      srv.sessionControls.dropActiveAfterMs(1);
      await waitFor(
        () => census.heard.includes("client:close"),
        "the close the server sends the released session",
      );
      expect(census.heard).toContain("socket:close");
    } finally {
      census.stop();
      stalled.close();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "releasing another connection's withheld close releases a vanished session whole",
  async () => {
    const { srv, adapter, remote, cleanup } = await startSilencedFixture(
      "withhold-release-vanished",
    );
    const census = watchForLostSession(adapter);
    srv.sessionControls.withholdCloseOnDisconnect = true;
    const held = await dialSecondConnection(srv.handle.host, srv.handle.port);
    try {
      // Served normally -- this control takes only the closers -- so what is
      // measured here is that the server accepted this connection while the
      // control was armed, which is what hands its closers to the pool the
      // vanish silences into. The case does not rest on that: the vanished
      // socket is in that pool by the vanish alone, and this connection is only
      // why a suite would call the stop at all.
      await waitFor(
        () => held.bytesFromServer() > 0,
        "the second connection's identification string",
      );

      srv.sessionControls.vanishActiveSession();
      srv.sessionControls.stopWithholdingCloses();

      // Here it is the write that a stop of the silenced pool alone would leave
      // muted: this operation would then reach a server that answers into
      // nothing and would end on the adapter's stall deadline instead.
      await expect(adapter.exists(remote)).resolves.toBe(true);
      expect(census.bytesFromServer()).toBeGreaterThan(0);
      srv.sessionControls.dropActiveAfterMs(1);
      await waitFor(
        () => census.heard.includes("client:close"),
        "the close the server sends the released session",
      );
      expect(census.heard).toContain("socket:close");
    } finally {
      census.stop();
      held.close();
      await cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the backend's stop() closes a server holding a vanished session",
  async () => {
    // A vanished session has both of its socket's closers silenced and its write
    // muted, so the backend cannot end it either: server.close() never fires its
    // callback and stop() spends its whole bounded wait, leaving the socket open
    // behind it. stop() therefore releases every vanished session before it ends
    // anything -- the same disarm the withheld-close control needs, for the same
    // reason.
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter({
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
      });
      srv.sessionControls.vanishActiveSession();

      const started = Date.now();
      await srv.stop();

      // Well inside the backend's own 2 s teardown bound: spending that bound is
      // the failure this guards against, not a merely slow teardown.
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await adapter.end().catch(() => {});
    }
  },
  TEST_TIMEOUT_MS,
);

/**
 * One request the server accepts and never answers, and the stall the adapter is
 * expected to raise for it. Each drives ONE operation on an otherwise healthy
 * session, so what ends it can only be that operation's own deadline.
 */
interface WithheldReplyCase {
  /** The operation as the case name reads it. */
  what: string;
  /** The SFTP opcode the server accepts and leaves unanswered. */
  opcode: string;
  /** The operation the adapter names in the stall it raises. */
  operation: string;
  /** The withheld-response clause that stall carries. */
  detail: string;
  /** Whatever the driven operation needs, planted under the served directory. */
  plant?: (dir: string) => Promise<void>;
  drive: (adapter: SSH2SFTPClientAdapter, remote: string) => Promise<unknown>;
}

// The metadata round trips whose bound is a flat whole-operation deadline, plus
// the uncapped read, whose own deadline is the only bound it has (the capped read
// the transport actually issues bounds the idle GAP between chunks instead, and is
// driven by the exchange cases elsewhere in this suite). The opcode each names is
// the request the server sees, so a library that reached the same operation over a
// different one fails here rather than passing on a stall nothing withheld.
const WITHHELD_REPLY_CASES: WithheldReplyCase[] = [
  {
    what: "a rename",
    opcode: "RENAME",
    operation: "file rename",
    detail: "the server withheld the rename response",
    plant: (dir) => fsp.writeFile(path.join(dir, "from.json"), "{}"),
    drive: (adapter, remote) =>
      adapter.rename(`${remote}/from.json`, `${remote}/to.json`),
  },
  {
    what: "a delete",
    opcode: "REMOVE",
    operation: "file delete",
    detail: "the server withheld the delete response",
    plant: (dir) => fsp.writeFile(path.join(dir, "doomed.json"), "{}"),
    drive: (adapter, remote) => adapter.delete(`${remote}/doomed.json`),
  },
  {
    what: "an existence check",
    // LSTAT, not STAT: which of the two the pinned ssh2-sftp-client's exists()
    // puts on the wire is the library's choice, and this is the leg that reads
    // it from the server rather than assuming it.
    opcode: "LSTAT",
    operation: "existence check",
    detail: "the server withheld the stat response",
    plant: (dir) => fsp.writeFile(path.join(dir, "present.json"), "{}"),
    drive: (adapter, remote) => adapter.exists(`${remote}/present.json`),
  },
  {
    what: "an exclusive create",
    opcode: "OPEN",
    operation: "exclusive create",
    detail: "the server withheld the open, existence-check, or close response",
    drive: (adapter, remote) => adapter.createExclusive(`${remote}/lock.json`),
  },
  {
    what: "an uncapped read",
    opcode: "READ",
    operation: "file read",
    detail: "the server withheld the transfer",
    plant: (dir) =>
      fsp.writeFile(path.join(dir, "payload.bin"), Buffer.alloc(4096, 7)),
    drive: (adapter, remote) => adapter.get(`${remote}/payload.bin`),
  },
];

for (const withheld of WITHHELD_REPLY_CASES)
  inProcessOnly(
    `${withheld.what} the server accepts and never answers ends on the ` +
      `adapter's own deadline, with the session left live`,
    async () => {
      const { srv, adapter, dir, remote, cleanup } =
        await startSilencedFixture("withheld-reply");
      try {
        await withheld.plant?.(dir);
        srv.sessionControls.requests.reset();

        const [outcome, logs] = await withCapturedLogs(
          async () => {
            srv.inject.withholdOn = withheld.opcode;
            const started = Date.now();
            const error = await withheld.drive(adapter, remote).then(
              () => undefined,
              (err: unknown) => err,
            );
            return { error, elapsedMs: Date.now() - started };
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        // The deadline is what ended it, and it named the operation and the
        // response the server kept.
        expect(outcome.error).toBeInstanceOf(TransportOperationStalledError);
        const rendered = sanitizeErrorForDisplay(outcome.error);
        expect(rendered).toContain(`SFTP ${withheld.operation} stalled`);
        expect(rendered).toContain(withheld.detail);
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
          STALL_DEADLINE_MS - STALL_DEADLINE_MEASUREMENT_MARGIN_MS,
        );

        // The server did receive the request and did not answer it, so the
        // rejection is over a request genuinely left outstanding rather than one
        // the client never issued.
        const meter = srv.sessionControls.requests.read();
        const received = meter.receivedByOp[withheld.opcode] ?? 0;
        expect(received).toBeGreaterThanOrEqual(1);
        expect(meter.answeredByOp[withheld.opcode] ?? 0).toBeLessThan(received);

        // A stall is never a reconnect trigger: the session the request was
        // issued on is still established, nothing re-dialed, and the operator is
        // told nothing beyond the rejection the caller already has.
        expect(sessionReadsEstablished(adapter)).toBe(true);
        expect(srv.sessionControls.handshakeCount()).toBe(0);
        expect(adapter.reconnectCount).toBe(0);
        expect(adapter.midExchangeReconnectCount).toBe(0);
        expect(logs).toEqual([]);
      } finally {
        srv.inject.withholdOn = null;
        await cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
