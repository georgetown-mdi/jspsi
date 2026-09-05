import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// A cycle-boundary signal (the poll loop's cycle-start reconnect, the idle
// release) issued once teardown has been latched takes the session-transition
// queue like any other transition: it waits the teardown out and then returns its
// "nothing to do" value, rather than returning before the close it queued behind
// has run. Core forwards both signals unwrapped, so what bounds that wait is the
// adapter's own -- the teardown's close bounds first, and past them the acquire
// ceiling, at which a signal abandons instead of waiting. This exercises the case
// that spends the close bounds in full and still lands inside the ceiling, so the
// signals wait the teardown out rather than giving up on it: a partner that
// accepts the disconnect and never closes the connection. Only the in-process
// backend can be made to withhold its close, so this runs there and stands up its
// own server to reach the session controls.

// The teardown's close spends CLIENT_CLOSE_TIMEOUT_MS (5 s) against this partner
// before forcing the socket closed, and the wait under test is that close.
const TEST_TIMEOUT_MS = 120_000;
// Comfortably above the adapter's own close bounds and far below any hang: an
// unbounded park is the failure this measures, not a slow one.
const PARK_CEILING_MS = 20_000;

inProcessOnly(
  "a cycle-boundary signal issued after teardown is latched waits it out, bounded",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "teardown-signal-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const conn = new FileSyncConnection(adapter, {
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
          path: remote,
        },
      });
      // Every handshake from here would be a dial one of the two signals made.
      srv.sessionControls.resetHandshakeCount();

      // Both signals are issued from inside core's own teardown, in the tick that
      // latches it: end() latches synchronously before it enqueues, so these two
      // take their queue slots behind that teardown. Shadowing the method is what
      // makes the interleaving deterministic -- core reaches the transport's end()
      // by property lookup on each call.
      let ready!: Promise<boolean>;
      let released!: Promise<void>;
      let issuedAt = 0;
      // Each signal's own settle time, taken where it settles: reading the clock
      // after awaiting them would measure the enclosing close() instead.
      let readyAt = 0;
      let releasedAt = 0;
      const endTerminally = adapter.end.bind(adapter);
      adapter.end = () => {
        const teardown = endTerminally();
        issuedAt = Date.now();
        ready = adapter.ensureConnected().then((live) => {
          readyAt = Date.now();
          return live;
        });
        released = adapter.releaseForIdle().then(() => {
          releasedAt = Date.now();
        });
        return teardown;
      };

      await conn.close();
      expect(await ready).toBe(true);
      expect(await released).toBeUndefined();
      const parkedMs = Math.min(readyAt, releasedAt) - issuedAt;

      // Neither dialed and neither closed anything: they reached the front of the
      // queue with teardown already latched, which is what their "nothing to do"
      // values report.
      expect(srv.sessionControls.handshakeCount()).toBe(0);
      // They waited the teardown out rather than returning over a connection
      // still being closed -- against this partner that wait is the release's own
      // close bound, seconds rather than the microtask a pre-acquire fast return
      // would have cost -- and it ended with the teardown rather than running on.
      expect(parkedMs).toBeGreaterThan(1_000);
      expect(parkedMs).toBeLessThan(PARK_CEILING_MS);
    } finally {
      srv.sessionControls.stopWithholdingCloses();
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
