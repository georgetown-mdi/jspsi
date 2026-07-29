import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  FileSyncConnection,
  PeerAbortError,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
  UsageError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

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
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

// Each idle boundary costs the release's own close bound (5 s) before the forced
// close lands, and the assertions want several of them.
const BOUNDARY_TEST_TIMEOUT_MS = 120_000;

// Poll a predicate until it holds, failing if it never does.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

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
        `re-dialed the maximum ${DEFAULT_MAX_RECONNECT_ATTEMPTS} times ` +
          `allowed by max_reconnect_attempts=${DEFAULT_MAX_RECONNECT_ATTEMPTS}`,
      );
      expect((rejection as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      // What ended the exchange was the budget rather than a rendezvous the server
      // never cut: every re-dial the budget permits was spent first, and the drop
      // after them is the one that raised.
      expect(waiterAdapter.midExchangeReconnectCount).toBe(
        DEFAULT_MAX_RECONNECT_ATTEMPTS,
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
      // still there after the last, with no orphaned lock or joining sentinel
      // beside it.
      expect(outcome.acrossTheCuts).toContain(`${waiter.id}-hello.json`);
      expect(
        outcome.acrossTheCuts.filter((name) => name.endsWith("-hello.json")),
      ).toEqual([`${waiter.id}-hello.json`]);
      expect(
        outcome.acrossTheCuts.filter(
          (name) =>
            name.endsWith("-lock.json") || name.endsWith("-joining.json"),
        ),
      ).toEqual([]);
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
      pollingFrequency: 10,
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
            const before = receiverAdapter.midExchangeReconnectCount;
            // The next SFTP operation this cycle issues is torn off the wire. The
            // sender is idle between its sends, so the server-wide counter can
            // only be spent by the polling party.
            srv.sessionControls.dropActiveAfterOps(1);
            await waitFor(
              () => receiverAdapter.midExchangeReconnectCount > before,
            );
            await sender.send({ message: sent });
            await waitFor(() => received.length === sent + 1);
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
