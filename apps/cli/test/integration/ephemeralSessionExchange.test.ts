import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

// End-to-end proof for connection-per-poll (ephemeral-session) SFTP mode against
// the partner server the mode is hardest on: one that accepts the client's
// disconnect and then goes quiet, never closing the connection. Only the
// in-process backend can be made to withhold its close (a native sshd cannot), so
// this runs there and stands up its own server to reach the session controls --
// the shared globalSetup server hands the workers only its connection details.
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
      expect(forced[0].message).toContain("forced it closed");
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

// PENDING, still: the max-session/idle-cap half of the connection-per-poll
// end-to-end proof. The harness now has the session caps and the forced drops
// (test/sftpServer/sessionControls.ts), so what remains is the exchange that
// drives them, asserting:
//   - a full exchange completes across repeated cap-forced drops with a fresh
//     session per poll cycle, where a single held session would thrash a
//     reconnect every cycle;
//   - a failed dial in one cycle is retried on the next tick rather than aborting
//     the exchange, while a genuinely fatal condition still terminates;
//   - close() still writes the authenticated abort marker and drains the terminal
//     frame when the prior cycle's connection was already released, and a waiting
//     peer still fast-fails on the marker (see docs/spec/CHANNEL_SECURITY.md).
// The test above covers the re-dial's reuse of the pinned host key and stored
// credentials for free: every cycle re-dials through the same pinned, fail-closed
// verifier with no re-prompt, and a cycle that did not would fail it.
test.skip("connection-per-poll SFTP survives a server-forced max-session drop", () => {
  // Intentionally unimplemented; see the note above for what it must assert.
});
