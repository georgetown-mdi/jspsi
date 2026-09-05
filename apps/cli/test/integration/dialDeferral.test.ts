import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// ssh2 defers a Client.connect() issued on a socket it still considers writable:
// the attempt sits behind once('close', ...) with no readyTimeout armed, so
// nothing on psilink's side bounds it (measured unsettled at 45 s on the pinned
// versions). psilink's own dial gates and forced closes keep a dial from
// reaching that state by leaving an ended transport destroyed rather than
// writable -- a property of this code, not the library, that a dependency bump
// or a change to those gates could take away.
//
// So the census below is the claim as a check: every dial the adapter's three
// dial paths issue is recorded with the state of the socket beneath it at entry,
// and none may be writable. Its companion, that each dial settles at all, is what
// catches a deferral this snapshot did not predict. See
// docs/notes/connection-per-poll-sftp.md and docs/spec/DEPENDENCY_PINS.md.
//
// Only the in-process backend can be made to withhold its close (a native sshd
// cannot), and that partner class is the one that can leave a transport in a state
// a dial might defer behind, so this runs there and stands up its own server to
// reach the session controls.

// A dial on a destroyed or merely ended socket completes in around 220 ms on the
// pinned versions. This separates "settled" from "deferred", which does not settle
// at all; it is not a performance assertion, so it sits far above the measurement.
const DIAL_SETTLE_CEILING_MS = 15_000;

const TEST_TIMEOUT_MS = 120_000;

// The state of the ssh2 Client's socket at the moment a dial was issued on it,
// plus how long that dial took to settle. `hasSocket` is false only for the first
// dial of a client's life, which has no socket beneath it to defer behind.
interface DialSnapshot {
  hasSocket: boolean;
  writable: boolean | undefined;
  writableEnded: boolean | undefined;
  destroyed: boolean | undefined;
  settledMs: number;
}

type SocketFlags = Partial<
  Record<"writable" | "writableEnded" | "destroyed", boolean>
>;

interface DialableClient {
  connect: (options: Record<string, unknown>) => Promise<unknown>;
  client?: { _sock?: SocketFlags };
}

// Record every dial the adapter issues, wrapping the ssh2-sftp-client connect()
// the adapter calls rather than the adapter's own connect(): the retry loop inside
// it dials once per attempt, and each attempt is its own chance to hit the
// deferring state.
function recordDials(adapter: SSH2SFTPClientAdapter): DialSnapshot[] {
  const dials: DialSnapshot[] = [];
  const client = (adapter as unknown as { client: DialableClient }).client;
  const connect = client.connect.bind(client);
  client.connect = async (options: Record<string, unknown>) => {
    const sock = client.client?._sock;
    const dial: DialSnapshot = {
      hasSocket: sock !== undefined,
      writable: sock?.writable,
      writableEnded: sock?.writableEnded,
      destroyed: sock?.destroyed,
      settledMs: Number.NaN,
    };
    dials.push(dial);
    const started = Date.now();
    try {
      return await connect(options);
    } finally {
      dial.settledMs = Date.now() - started;
    }
  };
  return dials;
}

// Every recorded dial was issued on a socket ssh2 would not defer behind, and
// settled. Reported as the offending snapshots so a failure names the state that
// became reachable.
function expectNoDeferrableDial(
  dials: DialSnapshot[],
  expectedCount: number,
): void {
  expect(dials).toHaveLength(expectedCount);
  expect(
    dials.filter(
      (dial) =>
        dial.writable === true ||
        !(dial.settledMs < DIAL_SETTLE_CEILING_MS) ||
        // A socket whose flags all read undefined would pass the writable test
        // without ever having been looked at, so a bump that relocated `_sock`'s
        // shape fails here rather than silently emptying the census.
        (dial.hasSocket && dial.writable === undefined),
    ),
  ).toEqual([]);
}

inProcessOnly(
  "no cycle-start or teardown dial is issued on a socket ssh2 would defer " +
    "behind, against a server that withholds its close",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "dial-"));
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const dials = recordDials(adapter);
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      // Armed before the first dial, so every connection this test makes is to a
      // partner that never closes -- the only partner class that leaves a
      // transport in a state a dial might defer behind.
      srv.sessionControls.withholdCloseOnDisconnect = true;
      // Each forced release draws the mode's own warning, which the suite's
      // console sentinel would otherwise flag; capture rather than silence.
      await withCapturedLogs(
        async () => {
          await conn.open({
            channel: "sftp",
            server: {
              host: srv.handle.host,
              port: srv.handle.port,
              ...serverAuth(srv.handle.usera),
              path: remote,
            },
          });

          // The gate that keeps a dial off a live socket, driven where it is
          // critical: with a session set, ensureConnected returns without
          // dialing at all. Removing it would show up here as a dial recorded on
          // a writable socket rather than as nothing at all.
          await expect(adapter.ensureConnected()).resolves.toBe(true);
          expect(dials).toHaveLength(1);

          // The cycle-start re-dial: the release ends the transport, the server
          // withholds its close, the release's forced close destroys the socket,
          // and the next cycle dials over that.
          await adapter.releaseForIdle();
          await expect(adapter.ensureConnected()).resolves.toBe(true);

          // The teardown pre-drain reconnect: close() re-establishes the released
          // session before the drain, then ends the connection for good.
          await adapter.releaseForIdle();
          await conn.close();
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The first connect, the cycle-start re-dial, and the pre-drain reconnect.
      expectNoDeferrableDial(dials, 3);
      // The first dial precedes any socket; the two re-dials are the assertion's
      // subject, and each ran over a socket a forced close had destroyed.
      expect(dials.slice(1).map((dial) => dial.destroyed)).toEqual([
        true,
        true,
      ]);
    } finally {
      // Ahead of any further close: a client's end() awaits a close a silenced
      // server never sends, so cleanup would spend the teardown bound instead of
      // the call under test.
      srv.sessionControls.stopWithholdingCloses();
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a mid-exchange recovery re-dial is issued on a socket ssh2 would not defer " +
    "behind",
  async () => {
    // The third dial path, driven here against a server that closes and drops the
    // session under an operation: ssh2-sftp-client clears its session property
    // itself, so the re-dial follows with no forced close of the adapter's own.
    // The withholding partner, whose close leaves that property set, is the case
    // below.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "redial-"));
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter();
    const dials = recordDials(adapter);
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      await conn.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      // A survived mid-exchange drop draws the operator warning the sentinel
      // gates; capture it rather than silencing the logger.
      await withCapturedLogs(
        async () => {
          await expect(adapter.list(remote)).resolves.toEqual([]);
          srv.sessionControls.dropActiveAfterOps(1);
          // The operation that meets the drop: it is torn off the wire, and the
          // recovery re-dials and re-issues it underneath.
          await expect(adapter.list(remote)).resolves.toEqual([]);
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(adapter.midExchangeReconnectCount).toBe(1);
      expectNoDeferrableDial(dials, 2);
      expect(dials[1].writable).toBe(false);
    } finally {
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a mid-exchange recovery re-dial for a high-level operation torn in flight " +
    "is issued on a socket ssh2 would not defer behind",
  async () => {
    // The same dial path as the case above, from the other side of the library's
    // own asymmetry: a raw-wrapper operation is torn by the transport's 'close',
    // so recovery runs after the full lifecycle; a high-level one (get, the put
    // family, delete, rename, exists) is torn by the 'end' that precedes it, so
    // recovery runs while the socket has not yet been retired and would
    // otherwise be writable -- the deferring state this census exists for. The
    // recovery retires the transport before it dials.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "inflight-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    // Large enough that the cut lands inside the read run rather than at the
    // operation's first opcode.
    await fsp.writeFile(
      path.join(dir, "transfer.bin"),
      Buffer.alloc(4 * 1024 * 1024, 7),
    );
    const adapter = new SSH2SFTPClientAdapter();
    const dials = recordDials(adapter);
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      await conn.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
      });
      await withCapturedLogs(
        async () => {
          // The drop lands on the third opcode of the read, well inside it.
          srv.sessionControls.dropActiveAfterOps(3);
          await expect(
            adapter.get(`${remote}/transfer.bin`, {
              maxBytes: 16 * 1024 * 1024,
            }),
          ).resolves.toHaveLength(4 * 1024 * 1024);
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(adapter.midExchangeReconnectCount).toBe(1);
      expectNoDeferrableDial(dials, 2);
      // Not merely not-writable: the retirement destroyed it and waited out the
      // client 'close', which is what leaves the dial nothing to be failed by.
      expect(dials[1].destroyed).toBe(true);
    } finally {
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a mid-exchange recovery re-dial against a partner that withholds its close " +
    "is issued on a destroyed socket",
  async () => {
    // The same dial path in the state this census exists for. The partner drops
    // the session and withholds its close, so ssh2-sftp-client's session property
    // stays set over a transport ssh2 has already ended -- the state a dial would
    // be deferred behind if the socket were still writable. The recovery forces
    // that transport closed before it dials, so what it dials over is a destroyed
    // socket; this is that property as a check.
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "withheld-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    // The torn operation is never answered, so the adapter's own per-operation
    // deadline is what ends it; lowered through the @internal `stallDeadlineMs`
    // option so this case does not spend the production minute waiting for a
    // rejection it only needs to have happened.
    const adapter = new SSH2SFTPClientAdapter({ stallDeadlineMs: 3_000 });
    const dials = recordDials(adapter);
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      // Armed before the first dial: every connection this case makes is to a
      // partner that will not close.
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
      await withCapturedLogs(
        async () => {
          await expect(adapter.list(remote)).resolves.toEqual([]);
          srv.sessionControls.dropActiveAfterOps(1);
          await expect(adapter.list(remote)).resolves.toEqual([]);
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(adapter.midExchangeReconnectCount).toBe(1);
      expectNoDeferrableDial(dials, 2);
      // Not merely ended: the forced close destroyed it, which is what takes the
      // library's session property with it and leaves the dial nothing to defer
      // behind.
      expect(dials[1].destroyed).toBe(true);
    } finally {
      // Ahead of any further close: a client's end() awaits a close a silenced
      // server never sends.
      srv.sessionControls.stopWithholdingCloses();
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
