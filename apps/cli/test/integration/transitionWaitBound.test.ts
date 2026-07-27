import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

// The two unattended failures the bounded session-transition wait exists for,
// driven against the real stack rather than a mock: a teardown and an idle release
// each enqueued behind a re-dial that will not settle. The partner is a server that
// accepts the TCP connection and never completes the SSH handshake, so the dial
// ahead of them spends its whole budget -- four attempts at the 30 s connect
// deadline plus the inter-attempt delays, about two minutes at the defaults, which
// is what each of these waits used to ride.
//
// Only the in-process backend can be made to stall its handshake (a native sshd
// cannot), so this runs there and stands up its own server to reach the session
// controls -- the shared globalSetup server hands the workers only its connection
// details.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

// The adapter's acquire bound is 10 s. Each wait is asserted to land between these:
// above the floor because the waiter did wait the bound out rather than declining on
// sight, and far below the dial budget it would otherwise have ridden.
const WAIT_FLOOR_MS = 5_000;
const WAIT_CEILING_MS = 25_000;
const TEST_TIMEOUT_MS = 180_000;

// Poll a predicate until it holds, failing if it never does.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 90_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

// Count the dials the adapter issues, so a test can wait for the parked one to be
// in flight rather than guess at a delay.
function countDials(adapter: SSH2SFTPClientAdapter): () => number {
  const client = (
    adapter as unknown as {
      client: {
        connect: (options: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).client;
  const connect = client.connect.bind(client);
  let dials = 0;
  client.connect = (options: Record<string, unknown>) => {
    dials += 1;
    return connect(options);
  };
  return () => dials;
}

inProcessOnly(
  "a teardown enqueued behind a re-dial that will not settle returns in bounded time",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "parked-teardown-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const dials = countDials(adapter);
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
      const dialsAtOpen = dials();
      const [outcome, logs] = await withCapturedLogs(
        async () => {
          // Release the session the way an idle boundary does, then arm the stall:
          // the operation below re-establishes through the adapter's own gate, and
          // that dial is the transition the teardown queues behind.
          await adapter.releaseForIdle();
          srv.sessionControls.stallHandshakeOnConnect = true;
          const parked = adapter.list(remote).then(
            () => "listed",
            () => "torn",
          );
          await waitFor(() => dials() > dialsAtOpen);

          const started = Date.now();
          await adapter.end();
          const closeMs = Date.now() - started;
          // The parked dial answers the destroy rather than running out its own
          // budget, and the operation it was re-establishing for reports the loss.
          return { closeMs, parked: await parked };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(outcome.closeMs).toBeGreaterThan(WAIT_FLOOR_MS);
      expect(outcome.closeMs).toBeLessThan(WAIT_CEILING_MS);
      expect(outcome.parked).toBe("torn");
      // No dial followed the destroy: the parked attempt was cut short by it, and
      // the retry loop reads the teardown latch between attempts, so nothing minted
      // a fresh socket behind the close.
      expect(dials()).toBe(dialsAtOpen + 1);
      // The deliberate close is neither counted nor warned as a mid-exchange drop,
      // and a completed exchange would still report success.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await conn.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the process exits after a teardown enqueued behind a re-dial that will not settle",
  async () => {
    // The load-bearing half, and the reason it is a child process: an in-process
    // check that close() settled passes even when the teardown left a live socket
    // behind, and this runner's own handles mask the leak. The parked dial holds a
    // ref'd TCP handle, so only a separate process can show that a run whose
    // teardown expired its wait actually finishes.
    const srv = await startInProcessSftpServer();
    const password = srv.handle.usera.password;
    expect(password).toBeDefined();
    const goFile = path.join(srv.handle.backingDir, "stall-now");
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(import.meta.dirname, "transitionWaitChild.ts"),
        ],
        {
          cwd: path.join(import.meta.dirname, "..", ".."),
          env: {
            ...process.env,
            PSILINK_TEST_HOST: srv.handle.host,
            PSILINK_TEST_PORT: String(srv.handle.port),
            PSILINK_TEST_USERNAME: srv.handle.usera.username,
            PSILINK_TEST_PASSWORD: password as string,
            PSILINK_TEST_HOST_KEY: srv.handle.hostKeyFingerprint,
            PSILINK_TEST_REMOTE_PATH: srv.handle.remoteRoot,
            PSILINK_TEST_GO_FILE: goFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        out += String(chunk);
      });
      let exited = false;
      const exit = new Promise<number | null>((resolve) => {
        const giveUp = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, TEST_TIMEOUT_MS - 30_000);
        child.on("exit", (code) => {
          exited = true;
          clearTimeout(giveUp);
          resolve(code);
        });
      });

      // The child opens against a server that handshakes normally and releases the
      // session; only then is the stall armed, so what parks is its re-dial.
      await waitFor(() => exited || out.includes("RELEASED"));
      srv.sessionControls.stallHandshakeOnConnect = true;
      await fsp.writeFile(goFile, "go");

      const started = Date.now();
      const code = await exit;
      expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });
      expect(Date.now() - started).toBeLessThan(TEST_TIMEOUT_MS - 60_000);
      // close() returned and the run continued past it, rather than the process
      // dying inside teardown or outliving it on a half-open socket.
      expect(out).toContain("PARKED");
      expect(out).toContain("CLOSED");
      // The operator hears it once, at the CLI's default log level, as information
      // rather than a failure.
      expect(out).toContain(
        "did not complete within the 10000 ms teardown wait",
      );
      expect(out).not.toContain("[ERROR]");
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await fsp.rm(goFile, { force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "an idle release enqueued behind a re-dial that will not settle returns in " +
    "bounded time and the poll loop keeps cycling",
  async () => {
    const srv = await startInProcessSftpServer();
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "parked-release-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sender = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });

    // Every release the poll loop issues, timed where it settles: reading the clock
    // around the loop would measure the whole cycle instead. Shadowed BEFORE the
    // connection is constructed, because core binds the two cycle-boundary signals
    // once there rather than looking them up per call.
    const releases: number[] = [];
    const release = adapter.releaseForIdle.bind(adapter);
    let parked: Promise<unknown> | undefined;
    adapter.releaseForIdle = async () => {
      const started = Date.now();
      try {
        return await release();
      } finally {
        releases.push(Date.now() - started);
        // Armed at the one instant that makes this deterministic: the session has
        // just been released and no transition holds, so the operation below
        // re-establishes through the adapter's gate and its dial -- against the
        // now-stalling server -- is what the loop's NEXT release queues behind.
        if (parked === undefined && releases.length === 2) {
          srv.sessionControls.stallHandshakeOnConnect = true;
          parked = adapter.list(remote).catch(() => undefined);
        }
      }
    };
    const receiver = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));

    try {
      // The whole exchange, teardown included, runs under one capture: a cycle
      // already inside its bounded wait when stop() lands still warns when that wait
      // expires, so a capture that ended at stop() would leak that line to the
      // console sentinel.
      const [, logs] = await withCapturedLogs(
        async () => {
          try {
            // The sender holds one session for the whole exchange and connects while
            // the server still handshakes, so the stall below never touches it.
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
            await Promise.all([sender.synchronize(), receiver.synchronize()]);
            receiver.start();
            // Two clean cycles arm the stall (above), then two more have to complete
            // with the parked dial holding: each of those spends the bound twice --
            // once on the cycle-start signal, once on the release -- so a loop that
            // stalled instead of cycling never reaches four.
            await waitFor(() => releases.length >= 4);
          } finally {
            receiver.stop();
            srv.sessionControls.stopStallingHandshakes();
            // The teardown queues behind the still-parked dial, gives up its wait,
            // and destroys the socket beneath it -- which is what settles that dial
            // and lets the operation riding it report the loss.
            await receiver.close().catch(() => {});
            await parked;
            await sender.close().catch(() => {});
          }
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The releases issued while the parked dial held the transition each returned
      // at the bound rather than riding that dial's whole budget.
      const parkedReleases = releases.slice(2);
      expect(parkedReleases.length).toBeGreaterThanOrEqual(2);
      expect(
        parkedReleases.filter(
          (ms) => ms < WAIT_FLOOR_MS || ms > WAIT_CEILING_MS,
        ),
      ).toEqual([]);
      // The loop kept cycling rather than stopping outright, and nothing failed the
      // exchange over a release that released nothing.
      expect(failures).toEqual([]);
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
      // Neither the declined releases nor the deliberate close was counted as a
      // mid-exchange drop. The merged reconnect total is not asserted here: the
      // parked dial re-attempts on its own connect-retry budget while it holds, and
      // that re-attempt is a reconnection this counter is meant to see.
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
      // The release's warning is paced like the forced release's, so a cause that
      // recurs every cycle does not fill an hours-long exchange's log.
      const declined = logs.filter((entry) =>
        entry.message.includes(
          "The connection-per-poll idle release did not close the SFTP session:",
        ),
      );
      expect(declined).toHaveLength(1);
      expect(declined[0].level).toBe("WARN");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
