import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// The unattended failures the bounded session-transition wait exists for, driven
// against the real stack rather than a mock: a teardown, an idle release and a
// mid-exchange recovery re-dial, each enqueued behind a dial that will not
// settle. The partner accepts the TCP connection and never completes the SSH
// handshake, so the dial ahead of them spends its whole budget -- about two
// minutes at the defaults, more than an order of magnitude past the bound each
// wait is held to. The last group also drives the other way a queued transition
// ends without running: reaching the front of the queue with the teardown latch
// already set. Only the in-process backend can be made to stall its handshake,
// so this runs there with its own server.

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
      // The close is not counted or warned as a mid-exchange drop, and a
      // completed exchange would still report success.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
      // Nor as a partner-side dial failure. The destroy settles the parked dial with
      // the same error a genuine peer close produces, so the re-dial riding it must
      // not report a transient failure of the partner's and promise a retry on a
      // next tick this closing run does not have. Only the real stack can prove
      // this: a mock dial that stayed parked through the destroy never reaches
      // the line at all.
      expect(
        logs.filter((entry) =>
          entry.message.includes("ephemeral SFTP re-dial failed"),
        ),
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
    // The critical half, and the reason it is a child process: an in-process
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
      // And hears nothing that attributes this adapter's own close to the partner:
      // the destroy settles the parked dial with the error a peer close produces, so
      // the re-dial riding it reports no transient dial failure and promises no
      // next-tick retry on a run that is closing.
      expect(out).not.toContain("ephemeral SFTP re-dial failed");
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
      // Neither the declined releases nor the close was counted as a
      // mid-exchange drop. The merged reconnect total is not asserted here: the
      // parked dial re-attempts on its own connect-retry budget while it holds, and
      // that re-attempt is a reconnection this counter is meant to see.
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
      // Both cycle-boundary signals decline for as long as the parked dial holds,
      // and each line is paced like the forced release's, so a cause that recurs
      // every cycle does not fill an hours-long exchange's log.
      const declined = logs.filter((entry) =>
        entry.message.includes(
          "The connection-per-poll idle release did not close the SFTP session:",
        ),
      );
      expect(declined).toHaveLength(1);
      expect(declined[0].level).toBe("WARN");
      const declinedRedials = logs.filter((entry) =>
        entry.message.includes("ephemeral SFTP re-dial declined:"),
      );
      expect(declinedRedials).toHaveLength(1);
      expect(declinedRedials[0].level).toBe("WARN");
      // The teardown's destroy settles the dial that held the transition all along,
      // with the error a genuine peer close produces: the re-dial riding it reports
      // no partner-side dial failure and promises no retry on a closing run.
      expect(
        logs.filter((entry) =>
          entry.message.includes("ephemeral SFTP re-dial failed"),
        ),
      ).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// The stable opening of the rejection an operation gets when the library holds no
// session: what both cases below expect their queued operation to end with, rather
// than with anything the transition queue produced.
const SESSION_NOT_OPEN = "SFTP session is not open";

/** An adapter whose recovery re-dial is parked against a stalling server. */
interface ParkedRedial {
  srv: Awaited<ReturnType<typeof startInProcessSftpServer>>;
  adapter: SSH2SFTPClientAdapter;
  /** The served directory, as the client names it over SFTP. */
  remote: string;
  /** Dials the adapter has issued so far. */
  dials: () => number;
  /** Dials issued before the drop, so a case reads the ones that followed. */
  dialsBeforeDrop: number;
  /** The operation the drop tore, whose recovery re-dial is the parked one. */
  torn: Promise<unknown>;
  /**
   * End the parked dial from the server's own side, with the stall disarmed so a
   * re-attempt handshakes normally. What follows is either a recovered session or
   * a dial the teardown latch refuses, depending on what the case did meanwhile;
   * both warn, so a case calls this inside its own log capture.
   */
  releaseParkedDial: () => void;
  cleanup: () => Promise<void>;
}

// Bring an adapter to the state both cases below start from: a live session the
// server drops under an operation, whose recovery re-dial then parks against a
// server that accepts the TCP connection and never completes the handshake. That
// parked re-dial holds the session-transition lock for the whole of its dial
// budget, so anything enqueued after it is a transition queued behind one that
// will not settle -- which is the only way a recovery re-dial of its own reaches
// either the bounded-wait abandon or the teardown-latch skip.
async function parkRecoveryRedial(label: string): Promise<ParkedRedial> {
  const srv = await startInProcessSftpServer();
  const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, `${label}-`));
  const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
  const adapter = new SSH2SFTPClientAdapter();
  const dials = countDials(adapter);
  await adapter.connect({
    host: srv.handle.host,
    port: srv.handle.port,
    ...serverAuth(srv.handle.usera),
  });
  // One settled round trip, so the drop below lands on a session proven live.
  await adapter.list(remote);
  const dialsBeforeDrop = dials();
  // From here every handshake is one a re-dial completed, which is what a case
  // reads to say nothing established a session behind the parked dial.
  srv.sessionControls.resetHandshakeCount();
  // Armed before the drop, so the re-dial the drop triggers is the first dial the
  // stall meets and is the one that parks.
  srv.sessionControls.stallHandshakeOnConnect = true;
  srv.sessionControls.dropActiveAfterOps(1);
  const torn = adapter.list(remote).catch((err: unknown) => err);
  // Read from the server rather than after a delay: a client's socket exists from
  // the moment it starts connecting, so only the server's own count says the
  // stall has taken hold of the re-dial rather than of nothing yet.
  await waitFor(() => srv.sessionControls.stalledConnectionCount() >= 1);
  const releaseParkedDial = (): void => {
    srv.sessionControls.stallHandshakeOnConnect = false;
    srv.sessionControls.closeStalledConnections();
  };
  return {
    srv,
    adapter,
    remote,
    dials,
    dialsBeforeDrop,
    torn,
    releaseParkedDial,
    cleanup: async () => {
      srv.sessionControls.stopStallingHandshakes();
      releaseParkedDial();
      await adapter.end().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    },
  };
}

inProcessOnly(
  "a recovery re-dial enqueued behind one that will not settle declines at the " +
    "bound and reports the session loss",
  async () => {
    const parked = await parkRecoveryRedial("queued-redial");
    const { adapter, remote } = parked;
    try {
      // The whole case runs under one capture, the parked dial's release
      // included: what that release lands is a re-dial that recovered a dropped
      // session, and it warns the operator about the drop as it should.
      const [outcome, logs] = await withCapturedLogs(
        async () => {
          // This operation finds no session, so its own recovery re-dial is
          // enqueued behind the parked one and waits out the acquire bound.
          const started = Date.now();
          const error = await adapter.list(remote).then(
            () => undefined,
            (err: unknown) => err,
          );
          // Read where the declining re-dial left them, before the release below
          // lets the parked one land and move them.
          const declined = {
            error,
            elapsedMs: Date.now() - started,
            dials: parked.dials(),
            midExchangeReconnects: adapter.midExchangeReconnectCount,
            handshakes: parked.srv.sessionControls.handshakeCount(),
          };
          parked.releaseParkedDial();
          await parked.torn;
          return declined;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // It gave up at the bound rather than riding the parked dial's whole
      // budget, which is more than an order of magnitude longer.
      expect(outcome.elapsedMs).toBeGreaterThan(WAIT_FLOOR_MS);
      expect(outcome.elapsedMs).toBeLessThan(WAIT_CEILING_MS);
      // A declined re-dial reports nothing of its own: the operation fails with
      // the session loss it already had, which names the drop and its remedies.
      expect(String(outcome.error)).toContain(SESSION_NOT_OPEN);
      // Nothing was dialed or established for it. The parked attempt is the only
      // dial past the drop, and no handshake completed behind it.
      expect(outcome.dials).toBe(parked.dialsBeforeDrop + 1);
      expect(outcome.handshakes).toBe(0);
      // And nothing was charged for it: the budget counts sessions LOST, and the
      // re-dial that found this one gone had already charged it.
      expect(outcome.midExchangeReconnects).toBe(1);
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
    } finally {
      await parked.cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a recovery re-dial that reaches the front of the queue after the teardown " +
    "latch establishes nothing",
  async () => {
    const parked = await parkRecoveryRedial("redial-races-teardown");
    const { adapter, remote } = parked;
    try {
      const [outcome, logs] = await withCapturedLogs(
        async () => {
          const queued = adapter.list(remote).then(
            () => undefined,
            (err: unknown) => err,
          );
          // Let that operation's re-dial reach the queue behind the parked one
          // before the latch is set, so what skips it is the teardown latch and
          // not the entry check of a transition that was never queued.
          await new Promise((resolve) => setTimeout(resolve, 250));

          // The teardown latches synchronously, before its own transition is
          // enqueued, so the queued re-dial reads it when its turn comes.
          const closed = adapter.end();
          // Settle the parked dial the partner's way, so the queue moves while
          // the latch stands. The retry loop reads the latch between attempts,
          // so nothing re-dials behind it.
          parked.releaseParkedDial();

          const started = Date.now();
          const error = await queued;
          const skipped = {
            error,
            settledMs: Date.now() - started,
            dials: parked.dials(),
            midExchangeReconnects: adapter.midExchangeReconnectCount,
            handshakes: parked.srv.sessionControls.handshakeCount(),
          };
          await parked.torn;
          await closed;
          return skipped;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Skipped on sight rather than waited out: it never spent the acquire
      // bound, which is what separates this from the case above.
      expect(outcome.settledMs).toBeLessThan(WAIT_FLOOR_MS);
      expect(String(outcome.error)).toContain(SESSION_NOT_OPEN);
      // Nothing was dialed or established past the parked attempt, so no session
      // outlived the close, and nothing further was charged: the loss was
      // charged once, by the re-dial that found it.
      expect(outcome.dials).toBe(parked.dialsBeforeDrop + 1);
      expect(outcome.handshakes).toBe(0);
      expect(outcome.midExchangeReconnects).toBe(1);
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
    } finally {
      await parked.cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);
