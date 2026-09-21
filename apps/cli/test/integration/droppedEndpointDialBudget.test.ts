import { expect } from "vitest";

import { probeHostKeyLines } from "../../src/commands/probeHostKey";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import type { InProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// What the connect budget bounds against an endpoint that accepts the TCP
// connection and then answers nothing -- what a dropped endpoint looks like
// once past the SYN. An exchange dial spends the budget once per attempt, so
// the operator's whole wait is that total; the host-key probe spends it once,
// having no reconnect setting to spend a second on. Both totals are held here
// so neither drifts away from what the operator documentation states.
//
// Only the in-process backend can hold a dial open and silent -- a real sshd
// completes its handshake -- so these run there with a server of their own.
// The reasoning and the comparable tools' behavior: docs/notes/
// connect-timeout-prior-art.md.

// The connect budget each dial here is given. Far above a loopback dial (a
// served one completes in tens of milliseconds) and far below the case timeout,
// so the wait a case measures is this bound rather than anything incidental.
// One second is also the smallest the probe command can be given, its flag
// taking whole seconds.
const CONNECT_BUDGET_MS = 1_000;
// The pause the retry loop leaves between two dial attempts.
const RETRY_PAUSE_MS = 1_000;
const TEST_TIMEOUT_MS = 60_000;

// Each attempt spends the budget, and each pause between them a second.
// Measured against this server at a 1000 ms budget: 7.04 s for the four
// attempts the default reconnect setting gives, against the 7 s predicted.
function expectedTotalMs(attempts: number): number {
  return attempts * CONNECT_BUDGET_MS + (attempts - 1) * RETRY_PAUSE_MS;
}

// Scheduling slack over the predicted total, generous enough that a loaded CI
// worker does not fail a case that made the right number of attempts. It stays
// below one further attempt and its pause (2000 ms), so an extra attempt cannot
// hide inside it.
const TOTAL_TOLERANCE_MS = 1_500;

function dialOptions(srv: InProcessSftpServer): Record<string, unknown> {
  const { host, port, usera } = srv.handle;
  return {
    host,
    port,
    ...serverAuth(usera),
    readyTimeout: CONNECT_BUDGET_MS,
  };
}

inProcessOnly(
  "an exchange dial spends the connect budget once per attempt",
  async () => {
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter();
    try {
      srv.sessionControls.stallHandshakeOnConnect = true;
      const started = Date.now();
      const rejection = await adapter
        .connect({ ...dialOptions(srv), maxReconnectAttempts: 3 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const elapsedMs = Date.now() - started;

      // The pre-authentication deadline is the one that fires, so what the
      // total is made of is the connect budget rather than some later phase.
      expect((rejection as Error).message).toContain("handshake");
      // The server's own count is what proves the attempt structure: one
      // dial the operator asked for, plus the three re-dials the reconnect
      // setting allows.
      expect({
        attempts: srv.sessionControls.stalledConnectionCount(),
        withinTotal: elapsedMs < expectedTotalMs(4) + TOTAL_TOLERANCE_MS,
        pastPerAttemptBudget: elapsedMs > expectedTotalMs(2),
      }).toEqual({
        attempts: 4,
        withinTotal: true,
        pastPerAttemptBudget: true,
      });
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await adapter.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the host-key probe spends its connect budget once and is not re-dialed",
  async () => {
    const srv = await startInProcessSftpServer();
    try {
      srv.sessionControls.stallHandshakeOnConnect = true;
      const { host, port } = srv.handle;
      const started = Date.now();
      await probeHostKeyLines({
        sftpUrl: `sftp://${host}:${port}`,
        connectTimeoutSeconds: CONNECT_BUDGET_MS / 1_000,
        json: true,
        verbosity: -1,
      }).catch(() => undefined);
      const elapsedMs = Date.now() - started;

      // One attempt, so --connect-timeout is the operator's whole wait: the
      // command has no reconnect setting, and the default three re-dials would
      // otherwise put the total four budgets past what they asked for.
      expect({
        attempts: srv.sessionControls.stalledConnectionCount(),
        withinBudget: elapsedMs < expectedTotalMs(1) + TOTAL_TOLERANCE_MS,
      }).toEqual({ attempts: 1, withinBudget: true });
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
