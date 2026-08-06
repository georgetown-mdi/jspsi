import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  TransportOperationStalledError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SFTP_HEARTBEAT_INTERVAL_MS } from "../../src/connection/sftpHeartbeat";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

// What the adapter does with a partner server that VANISHES: a live session that
// stops answering mid-exchange with no close, no reset and nothing further on the
// wire. Every other partner failure this suite drives ends the transport one way
// or another, so the client learns of it from the transport itself; this one it
// can learn of only from its own liveness deadline, and a stall is deliberately
// never a reconnect trigger (docs/spec/CHANNEL_SECURITY.md). The recorded
// outcome is the deliverable, so each case observes the ssh2 Client, the socket
// beneath it, and the server's own request meter rather than reasoning about the
// adapter.
//
// Only the in-process backend can be made to vanish (a native sshd cannot be told
// to stop answering), so these run there and stand up their own server to reach
// the session controls -- the shared globalSetup server hands the workers only its
// connection details. The withheld-close partner, which is the nearest neighbour
// and a materially different case (it fires only in answer to the client's own
// disconnect, and it ends the transport), is heldSessionWithheldClose.test.ts and
// ephemeralSessionExchange.test.ts.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam. A vanished session never answers, so this is what ends an operation
// outstanding across one; at the production 60 s these cases would wait a minute
// longer for the same rejection.
const STALL_DEADLINE_MS = 3_000;

// How long a case watches a vanished session with nothing outstanding before
// calling it silent. Nothing schedules server traffic inside it -- see the
// heartbeat guard each idle case asserts -- so the window's length decides only
// how long the run takes.
const QUIET_OBSERVATION_MS = 5_000;

// Each idle boundary costs the release's own close bound before the forced close
// lands, and the stalled cases cost the deadline above.
const TEST_TIMEOUT_MS = 120_000;

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

interface VanishFixture {
  srv: Awaited<ReturnType<typeof startInProcessSftpServer>>;
  adapter: SSH2SFTPClientAdapter;
  /** The served directory, as the client names it over SFTP. */
  remote: string;
  cleanup: () => Promise<void>;
}

// Stand up a server, connect one adapter to it, and prove the session live with a
// single settled round trip. exists() rather than list(): the listing guard closes
// its directory handle fire-and-forget once list() has resolved, so a trailing
// CLOSE would land inside the measured window a case opens right after this.
async function startVanishFixture(
  label: string,
  options: { ephemeralSessions?: boolean } = {},
): Promise<VanishFixture> {
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
    remote,
    cleanup: async () => {
      // Ahead of any disconnect: a client's end() awaits a close a vanished
      // server can never send, so teardown would otherwise spend the adapter's
      // whole close bound on every case.
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
      await startVanishFixture("held-outstanding");
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
    const { srv, adapter, remote, cleanup } = await startVanishFixture(
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
      expect(rejection.elapsedMs).toBeGreaterThanOrEqual(STALL_DEADLINE_MS);
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
    const { srv, adapter, remote, cleanup } = await startVanishFixture(
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
    const { srv, adapter, remote, cleanup } = await startVanishFixture(
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
    const { srv, adapter, cleanup } = await startVanishFixture("drop-control");
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
