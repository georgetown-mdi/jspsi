import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  FileSyncConnection,
  PeerAbortError,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
  UsageError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  MAX_DEFERRED_CLEANUP_DELETES,
  MAX_DEFERRED_CLEANUP_REISSUES,
} from "../../src/connection/sftpDeferredCleanup";
import { SftpAdapterLedger } from "../../src/connection/sftpAdapterLedger";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// End-to-end proof for connection-per-poll (ephemeral-session) SFTP mode against
// the partner servers it is hardest on: one that accepts the client's disconnect
// and then goes quiet, never closing the connection; one that enforces a maximum
// session duration short enough to cut the rendezvous; and one that accepts the
// TCP connection and never completes the handshake, so a cycle's dial fails
// outright. The exchange is driven through each of them and through its own
// teardown -- the abort marker and the terminal-frame drain, both of which run
// after the last cycle released its session. Only the in-process backend can be
// driven that way (a native sshd cannot be told to withhold a close, cap a
// session, or stall its handshake), so this runs there and stands up its own
// server to reach the session controls -- the shared globalSetup server hands the
// workers only its connection details.

// Each idle boundary costs the release's own close bound (5 s) before the forced
// close lands, and the assertions want several of them.
const BOUNDARY_TEST_TIMEOUT_MS = 120_000;

// The protocol's own in-flight write, `temp-<uuidv4()>.tmp`: a failed publish and
// never transcript, so no run of either mode may end with one on the server.
const isProtocolTemp = (name: string): boolean =>
  name.startsWith("temp-") && name.endsWith(".tmp");

// Poll a predicate until it holds, failing if it never does.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60_000, intervalMs = 50, what = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: ${what} not met within timeout`);
}

// Count the deletes the adapter issues per remote path, so a case can assert
// that a cleanup delete the partner's server will never let succeed costs a
// bounded number of round trips rather than one per re-establishment for the
// life of the run. It wraps the ssh2-sftp-client delete() the adapter calls,
// which is one call per attempt, and leaves the real request to the real server.
function countDeletes(
  adapter: SSH2SFTPClientAdapter,
): (remotePath: string) => number {
  const client = (
    adapter as unknown as {
      client: {
        delete: (remotePath: string, notFoundOK?: boolean) => Promise<unknown>;
      };
    }
  ).client;
  const performDelete = client.delete.bind(client);
  const attempts = new Map<string, number>();
  client.delete = (remotePath: string, notFoundOK?: boolean) => {
    attempts.set(remotePath, (attempts.get(remotePath) ?? 0) + 1);
    return performDelete(remotePath, notFoundOK);
  };
  return (remotePath: string) => attempts.get(remotePath) ?? 0;
}

// The adapter's count of operations it has issued and not settled: the idle
// release's precondition, and so the state that decides whether a boundary
// closes anything. Private, with no public surface -- what a case can read from
// outside is the consequence (a boundary that closed nothing), and these cases
// assert that too.
const outstandingOperations = (adapter: SSH2SFTPClientAdapter): number =>
  (adapter as unknown as { ledger: SftpAdapterLedger }).ledger
    .outstandingOperations;

// The cleanup deletes still recorded for re-issue. Private for the same reason:
// what it holds decides whether a later re-establishment issues another round
// trip, which is exactly what a bounded retry budget must stop it doing.
const deferredCleanupPaths = (adapter: SSH2SFTPClientAdapter): string[] => [
  ...(
    adapter as unknown as {
      deferredCleanupDeletes: { recorded: ReadonlyMap<string, number> };
    }
  ).deferredCleanupDeletes.recorded.keys(),
];

// Whether the adapter's session property still reads set over a transport whose
// writable half has ended with no FIN back -- the state a partner's drop leaves
// while its close is withheld, and the reading the idle release classifies. Both
// halves are internals (ssh2-sftp-client's session property, and Node's own
// half-close flags on the socket beneath the ssh2 Client), so a case that needs
// the state staged waits on the real stack producing it rather than assuming it.
const sessionOverEndedTransport = (adapter: SSH2SFTPClientAdapter): boolean => {
  const client = (
    adapter as unknown as {
      client: {
        sftp?: unknown;
        client?: {
          _sock?: { writableEnded?: boolean; readableEnded?: boolean };
        };
      };
    }
  ).client;
  const socket = client.client?._sock;
  return (
    Boolean(client.sftp) &&
    socket?.writableEnded === true &&
    socket.readableEnded !== true
  );
};

// Count the dials the adapter issues and the dials that settle as failures, so a
// case can wait on a cycle having tried to dial, or on its attempt having
// actually failed, rather than on a delay. It wraps the ssh2-sftp-client
// connect() the adapter calls, which is one dial per attempt.
function countDials(adapter: SSH2SFTPClientAdapter): {
  issued: () => number;
  failed: () => number;
} {
  const client = (
    adapter as unknown as {
      client: {
        connect: (options: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).client;
  const connect = client.connect.bind(client);
  let issued = 0;
  let failed = 0;
  client.connect = (options: Record<string, unknown>) => {
    issued += 1;
    return connect(options).catch((error: unknown) => {
      failed += 1;
      throw error;
    });
  };
  return { issued: () => issued, failed: () => failed };
}

// The peer-inactivity budget for the abort-marker case. Generous enough that the
// fast-fail path is never the thing that expires it: a regression in the marker
// write or read makes the waiting peer ride this out and fail with a transport
// error instead of a PeerAbortError, and the assertions key on that type
// difference rather than on any wall-clock bound.
const PEER_TIMEOUT_MS = 30_000;

inProcessOnly(
  "connection-per-poll completes an exchange across repeated idle boundaries " +
    "against a server that withholds its close",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter();
    const sender = new FileSyncConnection(senderAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiverAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const receiver = new FileSyncConnection(receiverAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));

    try {
      // The sender holds one session for the whole exchange, so it connects
      // BEFORE the control is armed: a connection accepted under the control can
      // never be closed by the server, and this party's own end() would then wait
      // out a close that never comes.
      await sender.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      srv.sessionControls.withholdCloseOnDisconnect = true;
      await receiver.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
      });
      // From here every handshake is a cycle-start re-dial the poll loop made.
      srv.sessionControls.resetHandshakeCount();

      const [received, logs] = await withCapturedLogs(
        async () => {
          await Promise.all([sender.synchronize(), receiver.synchronize()]);
          const message = new Promise((resolve) =>
            receiver.once("data", resolve),
          );
          receiver.start();
          // Let the loop cycle with nothing to read: each cycle releases its
          // session at the idle boundary, the server withholds the close, and the
          // release forces it. Two such boundaries have to be behind us before the
          // message is sent, so what carries it is a session dialed after them.
          // Two boundaries land in about eleven seconds (each costs the release's
          // own close bound); the bound here is generous headroom over that, not a
          // timing assertion.
          await waitFor(() => srv.sessionControls.handshakeCount() >= 2, {
            timeoutMs: 45_000,
          });
          await sender.send({ message: "across the idle boundaries" });
          const delivered = await message;
          receiver.stop();
          return delivered;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(failures).toEqual([]);
      expect(received).toEqual({ message: "across the idle boundaries" });
      // The exchange kept dialing a fresh session per cycle rather than stalling
      // on a released one: the message arrived on a session dialed after at least
      // two forced releases.
      expect(srv.sessionControls.handshakeCount()).toBeGreaterThanOrEqual(2);
      // None of those forced releases was reported as a lost session: they are
      // this adapter's own deliberate boundary.
      expect(receiverAdapter.reconnectCount).toBe(0);
      expect(receiverAdapter.midExchangeReconnectCount).toBe(0);
      // The ledger those counters are drawn from attributes the run the same
      // way, which is what says the zero above is an absence of partner drops
      // rather than an absence of accounting: every session this run ended was
      // its own boundary's, and no data operation was re-issued over one.
      const receiverAccounting = receiverAdapter.sessionAccounting;
      expect(receiverAccounting.losses.partner).toBe(0);
      expect(receiverAccounting.losses.fatal).toBe(0);
      expect(receiverAccounting.losses.deliberate).toBeGreaterThanOrEqual(2);
      expect(receiverAdapter.transportRetryCount).toBe(0);
      // The operator hears about the partner that never closes, once -- the
      // warning is rate-escalated after the first, so a server that behaves this
      // way every cycle does not fill the log.
      const forced = logs.filter((entry) =>
        entry.message.includes("did not close the connection"),
      );
      expect(forced).toHaveLength(1);
      expect(forced[0].level).toBe("WARN");
      expect(forced[0].message).toContain("closed it from this side");
      expect(forced[0].message).toContain("dials a fresh session");
    } finally {
      receiver.stop();
      // Stop withholding before either party disconnects: a client's end() awaits
      // a close a silenced server never sends, and close() dials once more (the
      // pre-drain reconnect) that an armed control would silence in turn.
      srv.sessionControls.stopWithholdingCloses();
      await receiver.close().catch(() => {});
      await sender.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a partner drop the idle boundary closes over with nothing on the wire is " +
    "counted as the lost session it is",
  async () => {
    // The same withheld-close drop the recovery path counts, with no operation for
    // it to tear: the partner drops the session between two poll cycles and the
    // idle boundary falls afterwards, so nothing reaches session recovery and the
    // release is the only thing that meets the drop. The boundary is what charges
    // it, so `reconnects` reports the session the partner took whether or not an
    // operation happened to be on the wire when it went -- driven against the real
    // server rather than modelled, because what
    // the release's own end() does to a transport ssh2 has already ended is the
    // pinned stack's behavior (see docs/spec/DEPENDENCY_PINS.md) and a stand-in
    // that answered it differently would report a different operator experience.
    // Driven at the adapter because the poll loop does not stage a drop between
    // its cycles on demand.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-untorn-drop-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const dials = countDials(adapter);

    try {
      srv.sessionControls.withholdCloseOnDisconnect = true;
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        maxReconnectAttempts: 0,
      });

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          // The drop lands with the wire empty, so no operation is torn by it.
          srv.sessionControls.dropActiveAfterMs(1);
          await waitFor(() => sessionOverEndedTransport(adapter), {
            what: "the partner's drop leaving a session over an ended transport",
          });
          await adapter.releaseForIdle();
          const dialsAfterRelease = dials.issued();
          // Issued after the boundary: the gate ahead of it re-establishes, and
          // this operation is not one the drop could have torn.
          const exists = await adapter.exists(remote);
          return {
            exists,
            gateDials: dials.issued() - dialsAfterRelease,
            outstanding: outstandingOperations(adapter),
          };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The operation ran on a session of its own, established by the one dial the
      // gate made: a boundary that recorded nothing would have let it be issued at
      // the session the release took, fail on it, and be recovered as a second drop.
      expect(outcome.exists).toBe(true);
      expect(outcome.gateDials).toBe(1);
      expect(outcome.outstanding).toBe(0);
      // The session the partner took is counted once, by the boundary that met
      // it. No operation was torn, so no recovery re-dial ran and the recovery
      // line -- which reports a drop transparently re-dialed -- does not fire; the
      // boundary has an operator line of its own instead.
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      // And the ledger behind them charges that one session to the partner and
      // to nothing else, so the counters above are one reading of a single
      // recorded cause rather than two tallies that happen to agree. The
      // exists() this ran is not a data operation, so nothing was re-issued.
      expect(adapter.sessionAccounting.losses).toEqual({
        partner: 1,
        deliberate: 0,
        teardown: 0,
        fatal: 0,
      });
      expect(adapter.transportRetryCount).toBe(0);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
      const absorbed = logs.filter((entry) =>
        entry.message.includes("ended the SFTP session before this"),
      );
      expect(absorbed).toHaveLength(1);
      expect(absorbed[0].level).toBe("WARN");
      // What the release met was a transport its own end() could not close, so it
      // spent its bound and forced the close -- the one boundary this run reports.
      expect(adapter.forcedReleaseCount).toBe(1);
      const forced = logs.filter((entry) =>
        entry.message.includes("did not close the connection"),
      );
      expect(forced).toHaveLength(1);
      expect(forced[0].level).toBe("WARN");
    } finally {
      // Disarm before this party disconnects: end() awaits a close a silenced
      // server never sends.
      srv.sessionControls.stopWithholdingCloses();
      srv.sessionControls.dropActiveAfterMs(0);
      await adapter.end().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the backend's stop() closes a server whose connections were accepted under " +
    "the withheld-close control",
  async () => {
    // A connection accepted under that control has both of its socket's closers
    // silenced, so the backend cannot end it either: server.close() never fires its
    // callback and stop() spends its whole bounded wait, leaving the socket open
    // behind it. stop() therefore disarms the control and hands the real closers
    // back before it ends anything. Measured: 3 ms as shipped, the full 2 s bound
    // without that disarm.
    const srv = await startInProcessSftpServer();
    const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      srv.sessionControls.withholdCloseOnDisconnect = true;
      await conn.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: srv.handle.remoteRoot,
        },
      });

      const started = Date.now();
      await srv.stop();

      expect(srv.sessionControls.withholdCloseOnDisconnect).toBe(false);
      // Well inside the backend's own 2 s teardown bound: spending that bound is
      // the failure this guards against, not a merely slow teardown.
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await conn.close().catch(() => {});
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

// How long a session established under the cap survives. Long enough for the
// rendezvous to get its opening writes onto the wire, short enough that the
// waiting party's rendezvous outlives several of them.
const RENDEZVOUS_SESSION_LIFETIME_MS = 3_000;

inProcessOnly(
  "the default held-session mode fails terminally when its rendezvous " +
    "outlives the server's maximum session lifetime",
  async () => {
    // The contrast that sends an operator whose partner caps session lifetime to
    // connection-per-poll, measured beside the mode's own proof below rather than
    // asserted about it. The scenario is identical; the only difference is that
    // this waiting party holds one session, so its recovery re-dials ARE charged
    // against max_reconnect_attempts. The cap cuts the rendezvous just as often,
    // the budget runs out, and the exchange fails terminally where the mode below
    // completes.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "held-session-rendezvous-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const joiner = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const waiterAdapter = new SSH2SFTPClientAdapter();
    const waiter = new FileSyncConnection(waiterAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    joiner.on("error", (err: unknown) => failures.push(err));
    waiter.on("error", (err: unknown) => failures.push(err));

    try {
      // Same ordering as the test below, for the same reason: the joiner connects
      // BEFORE the cap is armed, so the standing cap governs only the sessions of
      // the party whose rendezvous this measures.
      await joiner.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      srv.sessionControls.maxLifetimeMs = RENDEZVOUS_SESSION_LIFETIME_MS;
      await waiter.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
      });
      // From here every handshake is a re-dial recovering a cap-forced drop.
      srv.sessionControls.resetHandshakeCount();

      const [rejection, logs] = await withCapturedLogs(
        async () =>
          // The joiner never reaches its own rendezvous, so this one waits it out
          // while the cap cuts session after session beneath it.
          waiter.synchronize().then(
            () => undefined,
            (error: unknown) => error,
          ),
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(rejection).toBeInstanceOf(UsageError);
      expect((rejection as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      expect((rejection as Error).message).toContain(
        `${DEFAULT_MAX_RECONNECT_ATTEMPTS + 1} sessions lost over the whole ` +
          `exchange against a ` +
          `max_reconnect_attempts=${DEFAULT_MAX_RECONNECT_ATTEMPTS} budget`,
      );
      // What ended the exchange was the budget rather than a rendezvous the server
      // never cut: every re-dial the budget permits was spent first, and the drop
      // after them is the one that raised -- counted like the rest, the budget
      // bounding sessions lost rather than re-dials made.
      expect(waiterAdapter.midExchangeReconnectCount).toBe(
        DEFAULT_MAX_RECONNECT_ATTEMPTS + 1,
      );
      expect(srv.sessionControls.handshakeCount()).toBeGreaterThanOrEqual(
        DEFAULT_MAX_RECONNECT_ATTEMPTS,
      );
      // The failure reached the caller as the rendezvous rejection and nothing
      // else; a party that also surfaced it as a connection error would report the
      // same drop twice.
      expect(failures).toEqual([]);
      // The operator is warned that the budget is spent before the drop that ends
      // the exchange, so the terminal error is not the first they hear of it.
      const lastRedialWarnings = logs.filter((entry) =>
        entry.message.includes("That was the last re-dial allowed by"),
      );
      expect(lastRedialWarnings).toHaveLength(1);
      expect(lastRedialWarnings[0].level).toBe("WARN");
    } finally {
      // Disarm before either party disconnects: a rejected rendezvous still leaves
      // a connection to close, and teardown re-dials.
      srv.sessionControls.maxLifetimeMs = 0;
      await waiter.close().catch(() => {});
      await joiner.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "connection-per-poll completes an exchange whose rendezvous outlives the " +
    "server's maximum session lifetime",
  async () => {
    // The mode's per-cycle session lifetime is a property of the POLL LOOP. The
    // rendezvous that precedes it -- FileSyncConnection.synchronize() -- holds one
    // session across its waits, so a party that waits for a late peer against a
    // server enforcing a maximum session duration is dropped mid-rendezvous. What
    // carries the exchange through is the mode's uncapped recovery re-dial (the
    // cumulative max_reconnect_attempts budget is gated off here), so the exchange
    // completes rather than failing terminally.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-rendezvous-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const joinerAdapter = new SSH2SFTPClientAdapter();
    const joiner = new FileSyncConnection(joinerAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const waiterAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const waiter = new FileSyncConnection(waiterAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    joiner.on("error", (err: unknown) => failures.push(err));
    waiter.on("error", (err: unknown) => failures.push(err));

    // Two orphaned protocol temp files planted either side of the entry scan are
    // what make the scan's single run observable from outside. The first is on
    // disk before the rendezvous starts, so the scan sweeps it; the second is
    // written after that sweep and left there while the cap cuts session after
    // session beneath the rendezvous. A scan that re-ran on any later cycle would
    // sweep the second one too -- and, reaching the directory-clean guard a second
    // time, would find this party's own hello and reject the exchange outright.
    const sweptOrphan = `temp-${randomUUID()}.tmp`;
    const plantedOrphan = `temp-${randomUUID()}.tmp`;
    await fsp.writeFile(path.join(dir, sweptOrphan), "");

    try {
      // The joiner holds one session for the whole exchange, so it connects BEFORE
      // the cap is armed: the standing cap governs every session established while
      // it is set, and a held session under it would thrash a reconnect of its own
      // and confound what this measures.
      await joiner.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      srv.sessionControls.maxLifetimeMs = RENDEZVOUS_SESSION_LIFETIME_MS;
      await waiter.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
      });
      // From here every handshake is a re-dial recovering a cap-forced drop.
      srv.sessionControls.resetHandshakeCount();

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          const waiting = waiter.synchronize();
          // The entry scan runs once, at the head of the rendezvous: wait for it
          // to sweep the orphan planted before it, then plant the second, which
          // nothing from here on may touch.
          await waitFor(() => !existsSync(path.join(dir, sweptOrphan)));
          await fsp.writeFile(path.join(dir, plantedOrphan), "");
          // Hold the joiner back until the cap has cut the waiting party's
          // rendezvous session twice, so what the exchange survives is
          // unmistakably a drop DURING synchronize() rather than one in the poll
          // loop that follows it. Two cuts land in about seven seconds; the bound
          // here is generous headroom over that, not a timing assertion.
          await waitFor(() => srv.sessionControls.handshakeCount() >= 2, {
            timeoutMs: 60_000,
          });
          // Snapshot while the directory is still this party's alone. The joiner's
          // synchronize() below runs an entry scan of its own, which sweeps the
          // planted orphan exactly as a first entry should.
          const acrossTheCuts = await fsp.readdir(dir);
          await Promise.all([waiting, joiner.synchronize()]);
          const atRendezvous = {
            waiterRole: waiter.role,
            waiterPeerId: waiter.peerId,
            waiterHandshakeRole: waiter.handshakeRole,
            joinerRole: joiner.role,
            joinerPeerId: joiner.peerId,
            joinerHandshakeRole: joiner.handshakeRole,
            waiterMidExchangeReconnects:
              waiterAdapter.midExchangeReconnectCount,
          };
          const afterRendezvous = await fsp.readdir(dir);
          const message = new Promise((resolve) =>
            waiter.once("data", resolve),
          );
          waiter.start();
          await joiner.send({ message: "across the rendezvous cap" });
          const delivered = await message;
          waiter.stop();
          return { delivered, acrossTheCuts, atRendezvous, afterRendezvous };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The exchange completed: both rendezvous resolved, the message crossed, and
      // nothing surfaced as an error.
      expect(failures).toEqual([]);
      expect(outcome.delivered).toEqual({
        message: "across the rendezvous cap",
      });
      // The cap actually bit. Without this the test could pass on a rendezvous the
      // server never cut, which proves nothing.
      expect(srv.sessionControls.handshakeCount()).toBeGreaterThanOrEqual(2);
      expect(waiterAdapter.midExchangeReconnectCount).toBeGreaterThanOrEqual(2);
      // The operator is told the drop may be a rendezvous wait outliving the
      // server's cap, not only a fault within a poll cycle.
      const redialWarnings = logs.filter((entry) =>
        entry.message.includes("transparently re-dialed"),
      );
      expect(redialWarnings).toHaveLength(1);
      expect(redialWarnings[0].level).toBe("WARN");
      expect(redialWarnings[0].message).toContain("within a poll cycle");
      expect(redialWarnings[0].message).toContain("rendezvous");

      // The one-time entry guard and its sweep ran once and were never re-entered
      // across the cuts: the orphan planted after that sweep is untouched, and the
      // one planted before it is gone.
      expect(outcome.acrossTheCuts).toContain(plantedOrphan);
      expect(outcome.acrossTheCuts).not.toContain(sweptOrphan);
      // Nothing else the protocol writes is temp-shaped here, so a second name in
      // this set would be a torn write the cuts left behind rather than a sweep
      // that ran twice -- distinguishable, and neither is acceptable.
      expect(
        outcome.acrossTheCuts.filter((name) => name.endsWith(".tmp")),
      ).toEqual([plantedOrphan]);

      // The durable handshake files survived the loss of the session: this party's
      // hello is the directory's single hello, written before the first cut and
      // still there after the last. The lock and the joining sentinel are not
      // asserted here: this snapshot is taken while the waiter is still the sole
      // party, so neither can exist yet and their absence would prove nothing.
      // The assertion that carries them is the post-rendezvous one below.
      expect(outcome.acrossTheCuts).toContain(`${waiter.id}-hello.json`);
      expect(
        outcome.acrossTheCuts.filter((name) => name.endsWith("-hello.json")),
      ).toEqual([`${waiter.id}-hello.json`]);
      // And the joiner's arrival consumed its sentinel rather than losing it: the
      // rendezvous leaves neither hello, no lock, and no sentinel behind.
      expect(
        outcome.afterRendezvous.filter(
          (name) =>
            name.endsWith("-hello.json") ||
            name.endsWith("-lock.json") ||
            name.endsWith("-joining.json"),
        ),
      ).toEqual([]);

      // The in-memory session state the rendezvous committed is the complete,
      // complementary pair -- not the "unknown role"/undefined sentinel a recovery
      // reset leaves -- and it was committed by a rendezvous that had already
      // survived at least two re-dials of its own.
      expect(
        outcome.atRendezvous.waiterMidExchangeReconnects,
      ).toBeGreaterThanOrEqual(2);
      expect(outcome.atRendezvous).toMatchObject({
        waiterRole: "starter",
        waiterHandshakeRole: "responder",
        waiterPeerId: joiner.id,
        joinerRole: "joiner",
        joinerHandshakeRole: "initiator",
        joinerPeerId: waiter.id,
      });
      // And it did not drift as the poll loop's own re-dials followed.
      expect({
        waiterRole: waiter.role,
        waiterPeerId: waiter.peerId,
        waiterHandshakeRole: waiter.handshakeRole,
        joinerRole: joiner.role,
        joinerPeerId: joiner.peerId,
        joinerHandshakeRole: joiner.handshakeRole,
      }).toEqual({
        waiterRole: outcome.atRendezvous.waiterRole,
        waiterPeerId: outcome.atRendezvous.waiterPeerId,
        waiterHandshakeRole: outcome.atRendezvous.waiterHandshakeRole,
        joinerRole: outcome.atRendezvous.joinerRole,
        joinerPeerId: outcome.atRendezvous.joinerPeerId,
        joinerHandshakeRole: outcome.atRendezvous.joinerHandshakeRole,
      });
    } finally {
      waiter.stop();
      // Disarm before either party disconnects: teardown re-dials and the
      // terminal-frame drain must not be cut by a cap this test is done with.
      srv.sessionControls.maxLifetimeMs = 0;
      await waiter.close().catch(() => {});
      await joiner.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

// Drops to force inside the poll loop. Above DEFAULT_MAX_RECONNECT_ATTEMPTS, so
// the exchange below survives more session losses than the budget a held session
// spends them from allows -- the mode's uncapped recovery is what carries it.
const POLL_LOOP_DROPS = DEFAULT_MAX_RECONNECT_ATTEMPTS + 2;

inProcessOnly(
  "connection-per-poll completes a full exchange across repeated poll-cycle " +
    "drops a held session's reconnection budget could not absorb",
  async () => {
    // The poll-loop half of the mode's proof. The standing max-session cap is
    // armed over the whole loop and is asserted to reach NONE of its sessions:
    // a cycle dials, works, and releases well inside the cap, which is exactly
    // what a held session spanning those same idle gaps cannot do (the default
    // mode's contrast above measures that side). What the cap cannot deliver, the
    // harness forces one drop at a time, so every session loss below is
    // attributable and the exchange is driven through more of them than
    // max_reconnect_attempts would ever permit.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-loop-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter();
    const sender = new FileSyncConnection(senderAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiverAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const receiver = new FileSyncConnection(receiverAdapter, {
      verbose: -1,
      // Slower than the 10 ms the rest of this file polls at, because the wait
      // below arms each drop on an idle wire and only this spacing gives it one.
      // The wait reads SFTP requests, which an SSH handshake is not, so at 10 ms
      // the gap it measures is the shadow of the next cycle's dial rather than
      // the cycle boundary: whether it opens at all turns on how long a handshake
      // takes on the machine running it. Measured here, that is around 53 ms
      // where this suite runs in CI -- wide enough to read as quiet -- against
      // roughly 14 ms on a fast host, where the wire never falls silent for the
      // sample's length and the wait runs out. At this spacing the silence is the
      // released cycle's own idle on either machine, which is what the arming
      // means to name.
      pollingFrequency: 200,
    });
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));
    const received: unknown[] = [];
    receiver.on("data", (message: unknown) => received.push(message));

    try {
      await sender.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      await receiver.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
      });

      const [, logs] = await withCapturedLogs(
        async () => {
          await Promise.all([sender.synchronize(), receiver.synchronize()]);
          // Armed only now, so it governs the poll loop's sessions and not the
          // rendezvous that preceded them (which the test above measures). The
          // sender established its one session before this line and is exempt,
          // the same ordering every case in this file keeps.
          srv.sessionControls.maxLifetimeMs = RENDEZVOUS_SESSION_LIFETIME_MS;
          srv.sessionControls.resetHandshakeCount();
          receiver.start();
          for (let sent = 0; sent < POLL_LOOP_DROPS; sent += 1) {
            // Arm with the polling party's wire QUIET, so the drop is spent by
            // the first request of its next operation. Every operation a cycle
            // issues takes more than one request, so a drop landing on the first
            // one cannot be completed around: the operation is torn, enters
            // session recovery, and the loss is charged to the partner -- which
            // is the counter this wait reads.
            //
            // Armed against a request already in flight, the drop can instead be
            // spent by that operation's LAST request. The backend answers a
            // READDIR and a directory CLOSE synchronously, ahead of the teardown
            // the drop defers to the check phase, so the operation succeeds and
            // the session is cut with nothing left on the wire. The
            // connection-per-poll idle release then closes over that already-cut
            // transport, and while the partner's FIN is still in flight it can
            // only read the close as its own: the loss is charged as a deliberate
            // release, no counter moves, and this wait runs out.
            //
            // Quiet needs both ends: neither count alone is it. The
            // adapter's outstanding count misses the handle close a settled
            // listing fires after it, which is issued outside the operation's
            // span and answered synchronously -- exactly the request that can
            // absorb a drop. So the server's own arrival count has to be
            // unchanged across a full interval as well: a request already
            // written when the count was first read has arrived by the time it
            // is read again.
            let requestsSeen = -1;
            await waitFor(
              () => {
                const { received } = srv.sessionControls.requests.read();
                const quiet =
                  received === requestsSeen &&
                  outstandingOperations(receiverAdapter) === 0;
                requestsSeen = received;
                return quiet;
              },
              {
                what: `the polling party's wire to go quiet before drop ${sent + 1}`,
              },
            );
            // The drop counter is server-wide, so the held session's own request
            // would spend this arming instead. The sender issues one only from
            // the send() below, which this loop has already awaited -- checked
            // rather than assumed, since a drop spent there lands on the wrong
            // party and surfaces only as this wait timing out.
            expect(outstandingOperations(senderAdapter)).toBe(0);
            const before = receiverAdapter.midExchangeReconnectCount;
            srv.sessionControls.dropActiveAfterOps(1);
            await waitFor(
              () => receiverAdapter.midExchangeReconnectCount > before,
              {
                what: `drop ${sent + 1} to be counted as a mid-exchange reconnect`,
              },
            );
            await sender.send({ message: sent });
            await waitFor(() => received.length === sent + 1, {
              what: `message ${sent} to arrive after drop ${sent + 1}`,
            });
          }
          receiver.stop();
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Every message crossed, each on the far side of a drop, and nothing
      // surfaced as an error.
      expect(failures).toEqual([]);
      expect(received).toEqual(
        Array.from({ length: POLL_LOOP_DROPS }, (_, i) => ({ message: i })),
      );
      // Exactly the forced drops and no others: the standing cap, live for every
      // one of these cycles, reached none of their sessions. A cap that had cut
      // one would show up here as an extra recovery.
      expect(receiverAdapter.midExchangeReconnectCount).toBe(POLL_LOOP_DROPS);
      expect(receiverAdapter.midExchangeReconnectCount).toBeGreaterThan(
        DEFAULT_MAX_RECONNECT_ATTEMPTS,
      );
      // The party holding one session across the whole exchange lost none of it:
      // the drops landed where they were aimed.
      expect(senderAdapter.reconnectCount).toBe(0);
      expect(senderAdapter.midExchangeReconnectCount).toBe(0);
      // A cycle dials once per poll, so the loop handshakes far more often than it
      // was dropped -- the fresh-session-per-cycle shape rather than one session
      // re-dialed after each loss.
      expect(srv.sessionControls.handshakeCount()).toBeGreaterThan(
        POLL_LOOP_DROPS,
      );
      // The operator hears about the drops once: the warning is rate-escalated,
      // so a partner that drops a session every cycle does not fill the log.
      const dropWarnings = logs.filter((entry) =>
        entry.message.includes("dropped mid-exchange"),
      );
      expect(dropWarnings).toHaveLength(1);
      expect(dropWarnings[0].level).toBe("WARN");
      expect(dropWarnings[0].message).toContain("transparently re-dialed");
    } finally {
      receiver.stop();
      srv.sessionControls.maxLifetimeMs = 0;
      srv.sessionControls.dropActiveAfterOps(0);
      await receiver.close().catch(() => {});
      await sender.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

// A stalled dial is settled by the client's own connect deadline, so the cycles
// this test spends against an unreachable partner cost that deadline each. Held
// well below the default so the case does not spend minutes proving seconds; it
// bounds the harness's stall, and nothing is asserted about its value.
const CYCLE_DIAL_DEADLINE_MS = 1_500;

inProcessOnly(
  "a poll cycle whose dial fails is retried on the next tick, while a dial the " +
    "host-key verifier refuses ends the exchange",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-dial-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sender = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiverAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const receiver = new FileSyncConnection(receiverAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const dials = countDials(receiverAdapter);
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));
    const received: unknown[] = [];
    receiver.on("data", (message: unknown) => received.push(message));

    try {
      await sender.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      await receiver.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
        options: {
          serverConnectTimeoutMs: CYCLE_DIAL_DEADLINE_MS,
          maxReconnectAttempts: 0,
        },
      });

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          await Promise.all([sender.synchronize(), receiver.synchronize()]);
          receiver.start();

          // A partner that accepts the TCP connection and never completes the SSH
          // handshake: every cycle-start dial issued while this is armed is
          // established and never ready, and spends its own connect deadline.
          srv.sessionControls.resetHandshakeCount();
          const failedBeforeStall = dials.failed();
          srv.sessionControls.stallHandshakeOnConnect = true;
          // Wait on dials that have actually FAILED, not on dials issued: the
          // stall is installed when the server accepts the socket, so a dial
          // counted the instant connect() is called may not have reached it yet,
          // and disarming on that count lets the cycle establish after all.
          await waitFor(() => dials.failed() - failedBeforeStall >= 2);
          const failuresDuringStall = failures.length;
          const handshakesDuringStall = srv.sessionControls.handshakeCount();
          srv.sessionControls.stopStallingHandshakes();

          // The exchange was not aborted by those cycles: it is still polling, and
          // the first message the partner sends after the server recovers arrives.
          await sender.send({ message: "after the failed dials" });
          await waitFor(() => received.length === 1);

          // The cycle-start dial re-runs the retained, enforcing host-key verifier
          // rather than trusting the session it is replacing. Drive that verifier
          // to the refusal a server presenting a different key would produce (the
          // harness server cannot rotate its own host key) and let the real stack
          // decide the rest: ssh2 raises its own fatal handshake error and the
          // adapter classifies it. A cycle that re-dialed WITHOUT the verifier
          // would sail past this and the exchange would never terminate.
          const connectOptions = (
            receiverAdapter as unknown as {
              originalConnectOptions: Record<string, unknown>;
            }
          ).originalConnectOptions;
          expect(connectOptions["hostVerifier"]).toBeTypeOf("function");
          connectOptions["hostVerifier"] = (
            _hostKey: unknown,
            verify: (accepted: boolean) => void,
          ): void => verify(false);
          await waitFor(() => failures.length > failuresDuringStall);
          return { failuresDuringStall, handshakesDuringStall };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // No dial completed while the partner was stalling, so the cycles that ran
      // then genuinely failed to establish a session -- and none of them was
      // surfaced as an error to the caller.
      expect(outcome.handshakesDuringStall).toBe(0);
      expect(outcome.failuresDuringStall).toBe(0);
      expect(received).toEqual([{ message: "after the failed dials" }]);
      // Each failed cycle told the operator what it did and what happens next.
      const skipWarnings = logs.filter((entry) =>
        entry.message.includes("ephemeral SFTP re-dial failed"),
      );
      expect(skipWarnings.length).toBeGreaterThanOrEqual(2);
      expect(skipWarnings[0].level).toBe("WARN");
      expect(skipWarnings[0].message).toContain(
        "skipping this poll cycle and retrying on the next tick",
      );

      // The refused dial is the other side of the same branch: terminal, reported
      // once, and not retried into a poll loop that would re-run the key exchange
      // against a server it has just refused to trust.
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(Error);
      expect((failures[0] as Error).message).toContain("Host denied");
      const dialsAtFailure = dials.issued();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(dials.issued()).toBe(dialsAtFailure);
    } finally {
      receiver.stop();
      srv.sessionControls.stopStallingHandshakes();
      await receiver.close().catch(() => {});
      await sender.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

// How long the drain case holds the frame before letting the peer list the
// directory. A close() that skipped the drain sweeps the frame within a few tens
// of milliseconds of its teardown re-dial, so a peer that still finds the frame
// this far past that re-dial found it because the drain was holding it. Generous
// headroom over that sweep, not a timing assertion.
const DRAIN_HOLD_HEADROOM_MS = 2_000;

inProcessOnly(
  "the terminal-frame drain re-establishes the released session and holds the " +
    "frame until the peer consumes it",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-drain-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const departingAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const departing = new FileSyncConnection(departingAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const peer = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    departing.on("error", (err: unknown) => failures.push(err));
    peer.on("error", (err: unknown) => failures.push(err));

    try {
      const [outcome] = await withCapturedLogs(
        async () => {
          await departing.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.usera),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await peer.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.userb),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await Promise.all([departing.synchronize(), peer.synchronize()]);

          // The terminal frame, then the idle-boundary release that leaves this
          // teardown no session at all to drain over.
          await departing.send({ message: "the terminal frame" });
          await departingAdapter.releaseForIdle();

          srv.sessionControls.resetHandshakeCount();
          const closing = departing.close();
          // close() re-establishes a session BEFORE the drain deadline starts, so
          // that handshake -- the only one this released connection can now
          // produce -- is the signal that the drain is about to begin.
          await waitFor(() => srv.sessionControls.handshakeCount() >= 1);
          await new Promise((resolve) =>
            setTimeout(resolve, DRAIN_HOLD_HEADROOM_MS),
          );

          const delivered = new Promise((resolve) =>
            peer.once("data", resolve),
          );
          peer.start();
          const frame = await delivered;
          const consumedAt = Date.now();
          peer.stop();
          await closing;
          return { frame, settledAfterConsumeMs: Date.now() - consumedAt };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The frame outlived the teardown's sweep by the whole hold above: a close()
      // that swept it before draining would have left the peer nothing to read.
      expect(outcome.frame).toEqual({ message: "the terminal frame" });
      // And the drain ended on the peer's consume rather than on its own deadline,
      // which cleanup's fallback delete would then have covered for. A drain that
      // rode the deadline out would settle a whole drain budget after the consume
      // instead of promptly; this separates the two and is not a timing assertion.
      expect(outcome.settledAfterConsumeMs).toBeLessThan(
        Math.min(TERMINAL_FRAME_DRAIN_TIMEOUT_MS, PEER_TIMEOUT_MS) / 2,
      );
      // Teardown over a released session is still best-effort and non-throwing.
      expect(failures).toEqual([]);
    } finally {
      peer.stop();
      await departing.close().catch(() => {});
      await peer.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "close() writes the authenticated abort marker over a released session and " +
    "the waiting peer fast-fails on it",
  async () => {
    // The marker's half of the same teardown, driven as its own exchange because
    // the two cannot be observed in one: the poll loop checks for the peer's
    // marker BEFORE it dispatches messages, so a peer that can see the marker
    // never consumes the frame the drain above is holding.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-marker-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const failingAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const failing = new FileSyncConnection(failingAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const waiting = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failingErrors: unknown[] = [];
    const waitingErrors: unknown[] = [];
    failing.on("error", (err: unknown) => failingErrors.push(err));
    waiting.on("error", (err: unknown) => waitingErrors.push(err));
    // The orchestrator derives these per-direction from the session key; all this
    // case needs of them is that the reader's peer token is the writer's self
    // token, which is what the marker authenticates against.
    const failingToken = new Uint8Array(32).fill(0x5a);
    const waitingToken = new Uint8Array(32).fill(0xa5);

    try {
      const [outcome] = await withCapturedLogs(
        async () => {
          await failing.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.usera),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await waiting.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.userb),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await Promise.all([failing.synchronize(), waiting.synchronize()]);
          failing.armAbort(failingToken, waitingToken);
          waiting.armAbort(waitingToken, failingToken);

          // The idle-boundary release, so the teardown below starts with no
          // session at all.
          await failingAdapter.releaseForIdle();
          waiting.start();

          // close() runs first and parks at its abort-decision gate, the ordering
          // a connection-originated fault produces: the bridge fire-and-forgets
          // the close before the error reaches the orchestrator's catch. The
          // catch's marker write then rides its own re-establishment over the
          // released session, and close() awaits it in full before ending
          // anything.
          const closing = failing.close();
          await failing.writeAbortMarker();
          const afterWrite = (await fsp.readdir(dir)).filter((name) =>
            name.endsWith("-abort.json"),
          );
          await waitFor(() => waitingErrors.length > 0);
          waiting.stop();
          await closing;
          return { afterWrite, afterClose: await fsp.readdir(dir) };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The marker was written over a released session, under this party's own id
      // and no other.
      expect(outcome.afterWrite).toEqual([`${failing.id}-abort.json`]);
      // And it is not swept by the teardown that wrote it: it has to persist for
      // the peer to read.
      expect(outcome.afterClose).toContain(`${failing.id}-abort.json`);
      // The waiting peer fast-failed on the marker rather than riding out its
      // peer-inactivity budget, which would surface as a transport error instead.
      expect(waitingErrors).toHaveLength(1);
      expect(waitingErrors[0]).toBeInstanceOf(PeerAbortError);
      // Nothing about the released session surfaced to the closing party: close()
      // is best-effort and must stay non-throwing, the marker write included.
      expect(failingErrors).toEqual([]);
    } finally {
      waiting.stop();
      await failing.close().catch(() => {});
      await waiting.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "an idle release between a publish and its cleanup leaves no temp file behind",
  async () => {
    // The one cleanup delete that reaches no session gate: send()'s catch sweeps
    // the temp it wrote, and its never-reject contract keeps it outside the
    // recovery chokepoint that re-establishes for every other operation. Issued
    // after an idle boundary it reaches no session at all, and the file it was to
    // remove is what survives -- so the assertion here is the directory, not a
    // counter. The rename is torn deliberately, with the release driven inside the
    // tear, because the two orderings that produce this state (a send resuming
    // from the protocol continuation, a failing publish) are both races the loop
    // will not stage on demand.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-temp-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const publishedRename = senderAdapter.rename.bind(senderAdapter);
    let tearNextRename = false;
    senderAdapter.rename = async (fromPath: string, toPath: string) => {
      if (!tearNextRename) return publishedRename(fromPath, toPath);
      tearNextRename = false;
      // The idle boundary falls here: the temp is on the server, the publish has
      // not landed, and the sweep that follows runs with the session released.
      await senderAdapter.releaseForIdle();
      throw new Error("the partner's server refused the rename");
    };
    const sender = new FileSyncConnection(senderAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const peer = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    peer.on("error", (err: unknown) => failures.push(err));

    try {
      const [outcome] = await withCapturedLogs(
        async () => {
          await sender.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.usera),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await peer.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.userb),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await Promise.all([sender.synchronize(), peer.synchronize()]);

          tearNextRename = true;
          const sendError = await sender
            .send({ message: "the publish that never landed" })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          const afterSweep = await fsp.readdir(dir);
          await sender.close();
          return { sendError, afterSweep, afterClose: await fsp.readdir(dir) };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The publish failed, which is what put a temp on the server with no
      // session left to remove it.
      expect(outcome.sendError).toBeInstanceOf(Error);
      // The sweep itself removed nothing -- this is the state the fix is for, and
      // asserting it keeps the case honest if the tear ever stops reaching it.
      expect(outcome.afterSweep.filter(isProtocolTemp)).toHaveLength(1);
      // And the run does not end with it: the re-establishment teardown drives
      // before its drain re-issues the cleanup the released session could not
      // perform.
      expect(outcome.afterClose.filter(isProtocolTemp)).toEqual([]);
      // The sweep never surfaced to the caller: safeDelete's contract is
      // unchanged by the record it now leaves.
      expect(failures).toEqual([]);
    } finally {
      peer.stop();
      await sender.close().catch(() => {});
      await peer.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a retain-mode run leaves no temp file behind either, with its transcript intact",
  async () => {
    // Retain mode skips the terminal-frame drain and makes cleanup() a global
    // no-op, but the re-establishment the drain rides sits ABOVE that skip and
    // must stay there: a temp-<uuidv4()>.tmp is a failed in-flight write, never
    // transcript, so no run of either mode may end holding one. Asserted on the
    // directory rather than a call count, which is what a future change moving
    // the re-establishment below the retain skip would still satisfy.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-retain-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
    });
    const publishedRename = senderAdapter.rename.bind(senderAdapter);
    let tearNextRename = false;
    senderAdapter.rename = async (fromPath: string, toPath: string) => {
      if (!tearNextRename) return publishedRename(fromPath, toPath);
      tearNextRename = false;
      await senderAdapter.releaseForIdle();
      throw new Error("the partner's server refused the rename");
    };
    // Retain mode requires the lockless rendezvous and timestamped filenames,
    // and both parties must agree: the hello envelope carries the flags and a
    // mismatch is a terminal rendezvous failure.
    const retainOptions = {
      verbose: -1 as const,
      pollingFrequency: 10,
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
    };
    const sender = new FileSyncConnection(senderAdapter, retainOptions);
    const peer = new FileSyncConnection(
      new SSH2SFTPClientAdapter(),
      retainOptions,
    );
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    peer.on("error", (err: unknown) => failures.push(err));

    try {
      const [outcome] = await withCapturedLogs(
        async () => {
          await sender.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.usera),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await peer.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.userb),
              path: remote,
            },
            options: { peerTimeoutMs: PEER_TIMEOUT_MS },
          });
          await Promise.all([sender.synchronize(), peer.synchronize()]);

          tearNextRename = true;
          const sendError = await sender
            .send({ message: "the publish that never landed" })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          const afterSweep = await fsp.readdir(dir);
          await sender.close();
          return { sendError, afterSweep, afterClose: await fsp.readdir(dir) };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(outcome.sendError).toBeInstanceOf(Error);
      expect(outcome.afterSweep.filter(isProtocolTemp)).toHaveLength(1);
      expect(outcome.afterClose.filter(isProtocolTemp)).toEqual([]);
      // The drain took the temp and nothing else: the transcript retain mode
      // exists to keep is still on the server.
      expect(
        outcome.afterClose.filter((name) => name.endsWith(".json")).length,
      ).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    } finally {
      peer.stop();
      await sender.close().catch(() => {});
      await peer.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

// Poll cycles the two re-issue cases drive. Enough that a per-cycle repetition
// separates from a bounded one by a wide margin rather than by one occurrence.
const REISSUE_CYCLES = 7;

inProcessOnly(
  "a cleanup delete the partner accepts and never answers does not pin the " +
    "idle release off",
  async () => {
    // The mode exists to give up its session at every idle boundary. A drain
    // re-issue must therefore not be able to keep one: a server that ACCEPTS
    // DELETE and withholds its callback would otherwise leave an operation
    // outstanding at every boundary, and since a boundary that closes nothing
    // leaves the session live, the next re-establishment finds one, re-runs the
    // drain, and regenerates the operation -- connection-per-poll reverting to a
    // held session for the rest of the run. Driven at the adapter rather than
    // through an exchange because the record's entry point is a cleanup delete
    // no exchange stages on demand.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-withheld-delete-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const deletesOf = countDeletes(adapter);
    const stray = `temp-${randomUUID()}.tmp`;
    await fsp.writeFile(path.join(dir, stray), "an in-flight write");

    try {
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        maxReconnectAttempts: 0,
      });

      // The idle gap, and the cleanup sweep that falls into it: the delete
      // reaches no session, so the path is recorded for the drain.
      await adapter.releaseForIdle();
      await expect(adapter.safeDelete(`${remote}/${stray}`)).resolves.toBe(
        undefined,
      );

      srv.inject.withholdOn = "REMOVE";
      srv.sessionControls.resetHandshakeCount();
      for (let cycle = 0; cycle < REISSUE_CYCLES; cycle += 1) {
        const reissuing = deferredCleanupPaths(adapter).length > 0;
        const before = deletesOf(`${remote}/${stray}`);
        const reestablishing = adapter.ensureConnected();
        // The boundary falls with the re-issue ON THE WIRE rather than behind
        // it, which is the interleaving the mode actually produces: the drain
        // and the poll interval are the same order of magnitude against a server
        // that withholds, and a re-establishment driven by a resuming send()
        // straddles the next boundary outright.
        if (reissuing)
          await waitFor(() => deletesOf(`${remote}/${stray}`) > before, {
            what: "the drain's re-issue reaching the server",
          });
        await adapter.releaseForIdle();
        await reestablishing;
      }

      // Every cycle got its own session: a cycle that had to dial is a cycle
      // whose predecessor's boundary actually closed something. Counted at the
      // bracket instead, this reads 4: the budget bounds the pin to the cycles
      // its re-issues reach rather than lifting it, so three boundaries are held
      // before the record gives up and the rest of the run dials again.
      expect(srv.sessionControls.handshakeCount()).toBe(REISSUE_CYCLES);
      expect(adapter.heldBoundaryCount).toBe(0);
      // And nothing of the drain's is left counted, which is the state a held
      // boundary reads.
      expect(outstandingOperations(adapter)).toBe(0);
      // The re-issues themselves are bounded: the record gives up rather than
      // producing a delete per cycle for the run. One for the sweep that reached
      // no session, then the re-issue budget.
      expect(deletesOf(`${remote}/${stray}`)).toBe(
        1 + MAX_DEFERRED_CLEANUP_REISSUES,
      );
    } finally {
      srv.inject.withholdOn = null;
      await adapter.end().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a cleanup delete the partner's server permanently refuses is given up on " +
    "rather than retried for the run",
  async () => {
    // The only thing that clears a record is a delete this side saw succeed, so
    // a delete that can never succeed -- the case the spec itself names, a temp
    // this party cannot unlink -- would otherwise be re-issued once per
    // re-establishment for the life of the exchange, and with the record full
    // that is a record's worth of extra DELETE round trips per poll cycle
    // against the partner's server. A real refusal drives it: the temp sits in a
    // directory this party may read but not write, so the server's own unlink
    // fails with permission denied.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-refused-delete-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sealed = path.join(dir, "sealed");
    await fsp.mkdir(sealed);
    const stray = `temp-${randomUUID()}.tmp`;
    await fsp.writeFile(path.join(sealed, stray), "an in-flight write");
    await fsp.chmod(sealed, 0o555);
    const strayPath = `${remote}/sealed/${stray}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const deletesOf = countDeletes(adapter);

    try {
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        maxReconnectAttempts: 0,
      });

      await adapter.releaseForIdle();
      await expect(adapter.safeDelete(strayPath)).resolves.toBe(undefined);

      srv.sessionControls.resetHandshakeCount();
      for (let cycle = 0; cycle < REISSUE_CYCLES; cycle += 1) {
        await adapter.ensureConnected();
        await adapter.releaseForIdle();
      }

      // Bounded by the budget, not by the run: without it this is one delete per
      // cycle for as long as the exchange lasts.
      expect(deletesOf(strayPath)).toBe(1 + MAX_DEFERRED_CLEANUP_REISSUES);
      expect(deferredCleanupPaths(adapter)).toEqual([]);
      // The refusal was the server's, and it stands: the file is still there, so
      // what the budget bought is the round trips, not the outcome.
      expect(await fsp.readdir(sealed)).toEqual([stray]);
      // Giving up costs the mode nothing else: every boundary still closed.
      expect(srv.sessionControls.handshakeCount()).toBe(REISSUE_CYCLES);
      expect(adapter.heldBoundaryCount).toBe(0);
    } finally {
      await adapter.end().catch(() => {});
      await fsp.chmod(sealed, 0o755).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a record filled by temps the partner's server refuses admits the send " +
    "path's own cleanup again within the re-issue budget",
  async () => {
    // The one input a peer influences here is how many undeletable temps the
    // record can take: core's entry sweep hands this side every orphaned
    // protocol temp it lists, the peer's own among them, and a temp under a
    // directory this party may not write is a delete that can never succeed. A
    // full record refuses a send-path cleanup, so what that refusal costs turns
    // on how long such a fill stands -- which the per-recording budget bounds
    // rather than the cap. Driven at the cap against a server whose own unlink
    // refuses for real, because the answer is a property of the drain's
    // clear-before-issue order meeting real failures rather than of any one
    // guard, and it is what the spec's second stated limit rests on.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-crowded-record-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sealed = path.join(dir, "sealed");
    await fsp.mkdir(sealed);
    const peerTemps: string[] = [];
    for (let index = 0; index < MAX_DEFERRED_CLEANUP_DELETES; index += 1) {
      const name = `temp-${randomUUID()}.tmp`;
      await fsp.writeFile(path.join(sealed, name), "a peer's in-flight write");
      peerTemps.push(`${remote}/sealed/${name}`);
    }
    await fsp.chmod(sealed, 0o555);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });

    try {
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        maxReconnectAttempts: 0,
      });

      await adapter.releaseForIdle();
      for (const temp of peerTemps)
        await expect(adapter.safeDelete(temp)).resolves.toBe(undefined);
      expect(deferredCleanupPaths(adapter)).toHaveLength(
        MAX_DEFERRED_CLEANUP_DELETES,
      );

      // One re-establishment past the point the budget gives up, so the record
      // is seen to STAY open rather than to open for a single cycle.
      const drains = MAX_DEFERRED_CLEANUP_REISSUES + 1;
      const observed: {
        drain: number;
        recorded: number;
        sendPathCleanupAdmitted: boolean;
      }[] = [];
      for (let drain = 1; drain <= drains; drain += 1) {
        await adapter.ensureConnected();
        const recorded = deferredCleanupPaths(adapter).length;
        await adapter.releaseForIdle();
        // A fresh probe path per drain, and one that was never created: an
        // ADMITTED probe takes a slot, so a reused path would itself crowd the
        // record this case is measuring, and an absent file lets the next
        // drain's re-issue clear the slot instead of spending a budget on it.
        const probe = `${remote}/temp-${randomUUID()}.tmp`;
        await expect(adapter.safeDelete(probe)).resolves.toBe(undefined);
        observed.push({
          drain,
          recorded,
          sendPathCleanupAdmitted:
            deferredCleanupPaths(adapter).includes(probe),
        });
      }

      expect(observed).toEqual(
        Array.from({ length: drains }, (_entry, index) => {
          const drain = index + 1;
          const givenUp = drain >= MAX_DEFERRED_CLEANUP_REISSUES;
          return {
            drain,
            recorded: givenUp ? 0 : MAX_DEFERRED_CLEANUP_DELETES,
            sendPathCleanupAdmitted: givenUp,
          };
        }),
      );
      // The refusals were the server's and they stand, so the record emptied on
      // its budget rather than because the deletes started landing.
      expect(await fsp.readdir(sealed)).toHaveLength(
        MAX_DEFERRED_CLEANUP_DELETES,
      );
    } finally {
      await adapter.end().catch(() => {});
      await fsp.chmod(sealed, 0o755).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a recorded cleanup delete whose file is already gone is cleared by its " +
    "re-issue rather than costing the budget",
  async () => {
    // Letting an idle release tear a re-issue rests on a DELETE of this party's
    // own temp leaving no state the re-issue can misread: the server performed
    // the unlink or it did not, and an absent file is the success it is. That
    // last reading is ssh2-sftp-client's `notFoundOK`, a library behaviour, so
    // it is driven against a real server here rather than argued -- the state a
    // torn delete leaves when the unlink landed and the tear took the reply is
    // staged directly, as a recorded path that was never created on disk. A
    // regression reads it as a failure instead: the whole re-issue budget spent
    // on round trips for a file that is gone, and a "left behind" line about it.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "per-poll-absent-delete-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const deletesOf = countDeletes(adapter);
    const gone = `temp-${randomUUID()}.tmp`;
    const gonePath = `${remote}/${gone}`;

    try {
      await adapter.connect({
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        maxReconnectAttempts: 0,
      });

      await adapter.releaseForIdle();
      await expect(adapter.safeDelete(gonePath)).resolves.toBe(undefined);
      expect(existsSync(path.join(dir, gone))).toBe(false);
      // The sweep reached no session, so the path stands recorded and its one
      // attempt is the only DELETE issued for it so far.
      expect(deferredCleanupPaths(adapter)).toEqual([gonePath]);
      expect(deletesOf(gonePath)).toBe(1);

      await adapter.ensureConnected();

      // One re-issue, read as the success it is, and the record clear.
      expect(deletesOf(gonePath)).toBe(2);
      expect(deferredCleanupPaths(adapter)).toEqual([]);

      // Cleared and not merely quiet for a cycle: no later re-establishment
      // issues another round trip for it.
      for (let cycle = 0; cycle < REISSUE_CYCLES; cycle += 1) {
        await adapter.releaseForIdle();
        await adapter.ensureConnected();
      }
      expect(deletesOf(gonePath)).toBe(2);
      expect(deferredCleanupPaths(adapter)).toEqual([]);
    } finally {
      await adapter.end().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  BOUNDARY_TEST_TIMEOUT_MS,
);
