import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// End-to-end proof for the DEFAULT held-session mode against the partner server it
// is hardest on: one that drops the SFTP session mid-exchange and then withholds
// its connection close. ssh2 is left a half-open transport with
// ssh2-sftp-client's session property still set, so the operation on the wire
// cannot complete and rides the per-operation liveness deadline; the adapter reads
// the transport rather than that property, forces the ended transport closed so
// the library clears the session, and re-dials and re-issues as it does for a
// partner that closes.
//
// Only the in-process backend can be driven that way (a native sshd cannot be told
// to withhold a close), so this runs there and stands up its own server to reach
// the session controls -- the shared globalSetup server hands the workers only its
// connection details. The connection-per-poll counterpart is
// ephemeralSessionExchange.test.ts; the socket-state census over the dials this
// path issues is dialDeferral.test.ts.

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam. The torn operation is never answered, so that deadline is what ends
// it and nothing else here depends on its value; at the production 60 s this
// exercise would simply wait a minute longer for the same rejection.
const STALL_DEADLINE_MS = 3_000;

const TEST_TIMEOUT_MS = 120_000;

inProcessOnly(
  "the held session survives a mid-exchange drop whose close the partner " +
    "withholds, and the exchange completes",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "withheld-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter();
    const sender = new FileSyncConnection(senderAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiverAdapter = new SSH2SFTPClientAdapter({
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    const receiver = new FileSyncConnection(receiverAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));

    try {
      // The sender connects BEFORE the control is armed: a connection accepted
      // under it can never be closed by the server, and this party's own end()
      // would then wait out a close that never comes. It is also the party that
      // must stay quiet while the drop is armed, so the cut lands on the receiver.
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

      const [received, logs] = await withCapturedLogs(
        async () => {
          await Promise.all([sender.synchronize(), receiver.synchronize()]);
          // Sent before the drop is armed and awaited to completion, so the sender
          // issues nothing while it stands: the next operation the server serves
          // is the receiver's, and it is the receiver's session that is cut.
          await sender.send({ message: "across the withheld close" });
          const message = new Promise((resolve, reject) => {
            receiver.once("data", resolve);
            // A drop this mode cannot recover from ends the exchange with no
            // `data` event at all, so surface that error here rather than leaving
            // the case to time out on it.
            receiver.once("error", reject);
          });
          // The server drops the session under the receiver's next operation and
          // then goes quiet: no FIN, no ssh2 'close', the session property left
          // set. Recovering it is the behavior under test.
          srv.sessionControls.dropActiveAfterOps(1);
          receiver.start();
          const delivered = await message;
          receiver.stop();
          return delivered;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(failures).toEqual([]);
      // The exchange survived the drop rather than failing terminally on it.
      expect(received).toEqual({ message: "across the withheld close" });
      // Counted as the survived server-side drop it is, in both metrics.
      expect(receiverAdapter.midExchangeReconnectCount).toBeGreaterThanOrEqual(
        1,
      );
      expect(receiverAdapter.reconnectCount).toBe(
        receiverAdapter.midExchangeReconnectCount,
      );
      // The cut landed on the party under test; a drop that hit the quiet sender
      // instead would leave the assertion above unexplained.
      expect(senderAdapter.midExchangeReconnectCount).toBe(0);
      // Reported to the operator through the existing mid-exchange drop warning,
      // whose default-mode arm names the partner's session cap and the remedy.
      const recovered = logs.filter((entry) =>
        entry.message.includes("dropped mid-exchange and was transparently"),
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0].level).toBe("WARN");
      expect(recovered[0].message).toContain("--connection-per-poll");
      // Not the connection-per-poll idle release's forced close: this mode has no
      // idle boundary to release, and the drop was the partner's.
      expect(receiverAdapter.forcedReleaseCount).toBe(0);
      expect(
        logs.filter((entry) => entry.message.includes("idle release")),
      ).toEqual([]);
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
  TEST_TIMEOUT_MS,
);
