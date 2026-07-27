import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

// End-to-end proof for connection-per-poll (ephemeral-session) SFTP mode against
// the two partner servers it is hardest on: one that accepts the client's
// disconnect and then goes quiet, never closing the connection, and one that
// enforces a maximum session duration short enough to cut the rendezvous. Only the
// in-process backend can be driven that way (a native sshd cannot be told to
// withhold a close or to cap a session), so this runs there and stands up its own
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

      const [received, logs] = await withCapturedLogs(
        async () => {
          const waiting = waiter.synchronize();
          // Hold the joiner back until the cap has cut the waiting party's
          // rendezvous session twice, so what the exchange survives is
          // unmistakably a drop DURING synchronize() rather than one in the poll
          // loop that follows it. Two cuts land in about seven seconds; the bound
          // here is generous headroom over that, not a timing assertion.
          await waitFor(() => srv.sessionControls.handshakeCount() >= 2, {
            timeoutMs: 60_000,
          });
          await Promise.all([waiting, joiner.synchronize()]);
          const message = new Promise((resolve) =>
            waiter.once("data", resolve),
          );
          waiter.start();
          await joiner.send({ message: "across the rendezvous cap" });
          const delivered = await message;
          waiter.stop();
          return delivered;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The exchange completed: both rendezvous resolved, the message crossed, and
      // nothing surfaced as an error.
      expect(failures).toEqual([]);
      expect(received).toEqual({ message: "across the rendezvous cap" });
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

// PENDING, still: the POLL-LOOP half of the connection-per-poll max-session/idle
// cap proof. The rendezvous half is the test above; the harness has the session
// caps and the forced drops (test/sftpServer/sessionControls.ts), so what remains
// is the poll-loop exchange that drives them, asserting:
//   - a full exchange completes across repeated cap-forced drops with a fresh
//     session per poll cycle, where a single held session would thrash a
//     reconnect every cycle;
//   - a failed dial in one cycle is retried on the next tick rather than aborting
//     the exchange, while a genuinely fatal condition still terminates;
//   - close() still writes the authenticated abort marker and drains the terminal
//     frame when the prior cycle's connection was already released, and a waiting
//     peer still fast-fails on the marker (see docs/spec/CHANNEL_SECURITY.md).
// The tests above cover the re-dial's reuse of the pinned host key and stored
// credentials for free: every cycle re-dials through the same pinned, fail-closed
// verifier with no re-prompt, and a cycle that did not would fail it.
test.skip("connection-per-poll SFTP poll loop survives server-forced max-session drops", () => {
  // Intentionally unimplemented; see the note above for what it must assert.
});
