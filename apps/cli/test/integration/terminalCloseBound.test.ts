import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";
import type { LogEntry } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import type { SftpTestServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// The terminal close against the partner server this defect lives on: one that
// accepts the client's disconnect and then goes quiet, consuming the FIN and
// sending neither FIN nor reset. ssh2-sftp-client's end() settles only from the
// ssh2 Client's 'close', which such a partner never produces, so an exchange
// that has already fully succeeded would otherwise never finish teardown, and
// the half-open socket left behind (a ref'd handle) keeps the process alive.
// Only the in-process backend can be made to withhold its close, so this runs
// there with its own server.

// Generous headroom over the adapter's own teardown bounds (5 s for the
// partner's close, then 1 s for the forced one). The assertion is that teardown
// is bounded at all, not that it lands on a particular millisecond.
const BOUNDED_TEARDOWN_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;

// A completed exchange against a withholding server, closed from the receiving
// side. The sender connects BEFORE the control is armed, so its own teardown is
// an ordinary one: a connection accepted under the control can never be closed by
// the server, and this suite's own cleanup would then wait out a close that never
// comes.
async function completeExchangeThenClose(options: {
  connectionPerPoll: boolean;
}): Promise<{
  closeMs: number;
  failures: unknown[];
  received: unknown;
  logs: LogEntry[];
}> {
  const srv: SftpTestServer & {
    sessionControls: Awaited<
      ReturnType<typeof startInProcessSftpServer>
    >["sessionControls"];
  } = await startInProcessSftpServer();
  const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "teardown-"));
  const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
  const sender = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  const receiverAdapter = new SSH2SFTPClientAdapter({
    ephemeralSessions: options.connectionPerPoll,
  });
  const receiver = new FileSyncConnection(receiverAdapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  const failures: unknown[] = [];
  sender.on("error", (err: unknown) => failures.push(err));
  receiver.on("error", (err: unknown) => failures.push(err));

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

    // In connection-per-poll mode each idle boundary this exchange crosses draws
    // the release's own forced-close warning, which the suite's console sentinel
    // would otherwise flag; capture rather than silence, so the assertions can
    // still read what the operator was told.
    const [result, logs] = await withCapturedLogs(
      async () => {
        await Promise.all([sender.synchronize(), receiver.synchronize()]);
        const message = new Promise((resolve) =>
          receiver.once("data", resolve),
        );
        receiver.start();
        await sender.send({ message: "delivered before teardown" });
        const received = await message;
        receiver.stop();

        // The close under test runs with the control still armed: the partner
        // will never complete it, so what returns this call is the adapter's own
        // bound.
        const started = Date.now();
        await receiver.close();
        return { closeMs: Date.now() - started, received };
      },
      (level) => level === "WARN" || level === "ERROR",
    );
    return { ...result, failures, logs };
  } finally {
    receiver.stop();
    // Stop withholding before the remaining teardown: a client's end() awaits a
    // close a silenced server never sends, so leaving it armed would spend the
    // adapter's bound in cleanup rather than in the call under test.
    srv.sessionControls.stopWithholdingCloses();
    await receiver.close().catch(() => {});
    await sender.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
    await srv.stop();
  }
}

for (const [mode, connectionPerPoll] of [
  ["the default held session", false],
  ["connection-per-poll", true],
] as const) {
  inProcessOnly(
    `a completed exchange's close returns in bounded time in ${mode}, ` +
      `against a server that withholds its close`,
    async () => {
      const { closeMs, failures, received, logs } =
        await completeExchangeThenClose({ connectionPerPoll });

      expect(closeMs).toBeLessThan(BOUNDED_TEARDOWN_MS);
      // The exchange still reports success: the bounded teardown neither failed
      // it nor reported this by-design close as a mid-exchange fault.
      expect(failures).toEqual([]);
      expect(received).toEqual({ message: "delivered before teardown" });
      expect(logs.filter((entry) => entry.level === "ERROR")).toEqual([]);
      expect(
        logs.filter((entry) => entry.message.includes("dropped mid-exchange")),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  inProcessOnly(
    `the process exits after a bounded teardown in ${mode}, against a server ` +
      `that withholds its close`,
    async () => {
      // The critical assertion, and the reason it is a child process: an
      // in-process check that close() settled passes even when the teardown left a
      // live half-open socket behind, and this runner's own handles mask the leak.
      // Only a separate process can show that a completed run actually finishes.
      const srv = await startInProcessSftpServer();
      const password = srv.handle.usera.password;
      expect(password).toBeDefined();
      try {
        srv.sessionControls.withholdCloseOnDisconnect = true;
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            path.join(import.meta.dirname, "terminalCloseChild.ts"),
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
              PSILINK_TEST_CONNECTION_PER_POLL: connectionPerPoll ? "1" : "0",
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
        const started = Date.now();
        const code = await new Promise<number | null>((resolve) => {
          const giveUp = setTimeout(() => {
            child.kill("SIGKILL");
            resolve(null);
          }, BOUNDED_TEARDOWN_MS + 20_000);
          child.on("exit", (exitCode) => {
            clearTimeout(giveUp);
            resolve(exitCode);
          });
        });

        expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });
        expect(Date.now() - started).toBeLessThan(BOUNDED_TEARDOWN_MS);
        // The child reports the mode it ran in, so a case that stopped reaching
        // the mode it names fails rather than passing as a duplicate of the other.
        expect(out).toContain(
          `MODE ${connectionPerPoll ? "connection-per-poll" : "held-session"}`,
        );
        // close() returned and the run continued past it, rather than the process
        // dying inside teardown.
        expect(out).toContain("OPENED");
        expect(out).toContain("CLOSED");
        // The operator hears it once, at the CLI's default log level, as
        // information rather than a failure.
        expect(out).toContain("did not close the connection");
        expect(out).not.toContain("[WARN]");
        expect(out).not.toContain("[ERROR]");
      } finally {
        srv.sessionControls.stopWithholdingCloses();
        await srv.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
}
