import { expect } from "vitest";
import { TimeoutError } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import type { InProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// The bound on the phase of a dial that ssh2's own connect deadline stops
// covering: the `subsystem sftp` request issued once authentication has
// succeeded. Driven through the adapter against a server that authenticates the
// dial and then answers that request with nothing.
//
// Only the in-process backend can withhold a subsystem reply -- a real sshd
// either serves the subsystem or refuses it -- so these run there with a server
// of their own.

// The connect budget each dial here is given. Far above a loopback dial (a
// served one completes in tens of milliseconds) and far below the case timeout,
// so the wait a case measures is this bound rather than anything incidental.
const CONNECT_BUDGET_MS = 1_500;
// A dial the bound ends may spend up to the budget plus the dial that preceded
// it; two budgets is comfortably inside that and comfortably below the four the
// retry loop would spend if this failure were retried.
const BOUNDED_DIAL_CEILING_MS = 2 * CONNECT_BUDGET_MS;
const TEST_TIMEOUT_MS = 60_000;

interface AdapterInternals {
  client?: {
    _sock?: { destroyed?: boolean };
    listenerCount(event: string): number;
  };
}

function internalsOf(adapter: SSH2SFTPClientAdapter): AdapterInternals {
  return (adapter as unknown as { client: AdapterInternals }).client;
}

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
  "a dial the server authenticates and then leaves at the SFTP subsystem " +
    "fails within the connect budget",
  async () => {
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter();
    try {
      srv.sessionControls.withholdSubsystemOpen = true;
      const started = Date.now();
      const rejection = await adapter.connect(dialOptions(srv)).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = Date.now() - started;

      expect(rejection).toBeInstanceOf(TimeoutError);
      // The phase, named: what tells this apart from a rejected login and from
      // the pre-authentication connect deadline, both of which reach an
      // operator through the same channel.
      expect((rejection as Error).message).toContain(
        "accepted this connection's credentials and then did not open the " +
          "SFTP subsystem",
      );
      expect((rejection as Error).message).toContain(`${CONNECT_BUDGET_MS} ms`);

      // One budget, not one per retry: the request went unanswered on a
      // connection the server had already authenticated, so re-issuing it puts
      // the same request to the same server for the rest of the reconnect
      // budget. The server's own count is the check that no second attempt was
      // made.
      expect({
        withinCeiling: elapsedMs < BOUNDED_DIAL_CEILING_MS,
        subsystemRequests: srv.sessionControls.withheldSubsystemOpenCount(),
      }).toEqual({ withinCeiling: true, subsystemRequests: 1 });

      // The abandoned dial's transport is closed before the failure is
      // reported, so no later dial on this client is issued over a socket ssh2
      // would defer behind (docs/spec/DEPENDENCY_PINS.md).
      expect(internalsOf(adapter).client?._sock?.destroyed).toBe(true);
    } finally {
      srv.sessionControls.withholdSubsystemOpen = false;
      await adapter.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a dial the server stalls before authentication keeps its own deadline",
  async () => {
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter();
    try {
      srv.sessionControls.stallHandshakeOnConnect = true;
      const rejection = await adapter
        .connect({ ...dialOptions(srv), maxReconnectAttempts: 0 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      // ssh2's own pre-authentication deadline, unchanged and still the one
      // that fires: the subsystem-open bound is not armed until authentication
      // has succeeded, so a dial that never gets there cannot report the wrong
      // phase.
      expect(rejection).not.toBeInstanceOf(TimeoutError);
      expect((rejection as Error).message).toContain("handshake");
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await adapter.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a served dial leaves no arming subscription behind on the shared client",
  async () => {
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter();
    try {
      await adapter.connect(dialOptions(srv));
      const afterFirst = internalsOf(adapter).client?.listenerCount("ready");
      await adapter.ensureConnected();

      // The ssh2 Client outlives any one dial, so an arming subscription the
      // bound left behind would accumulate one per dial across an exchange's
      // re-dials. ssh2-sftp-client holds its own for the dial it is making;
      // what this pins is that the bound adds nothing that survives its dial.
      expect(afterFirst).toBe(0);
    } finally {
      await adapter.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the connection-per-poll cycle-start re-dial is bounded the same way",
  async () => {
    const srv = await startInProcessSftpServer();
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    try {
      await adapter.connect(dialOptions(srv));
      // The release's own warnings belong to that mode, not to this bound; the
      // suite's console sentinel would otherwise flag them.
      await withCapturedLogs(
        async () => {
          await adapter.releaseForIdle();
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      srv.sessionControls.withholdSubsystemOpen = true;
      const withheldBefore = srv.sessionControls.withheldSubsystemOpenCount();
      const started = Date.now();
      const [reconnected, logs] = await withCapturedLogs(
        () => adapter.ensureConnected(),
        (level) => level === "WARN" || level === "ERROR",
      );
      const elapsedMs = Date.now() - started;

      // The cycle-start re-dial runs the same dial sequence, so it is bounded
      // by the same budget rather than parking the poll loop forever on a
      // server that stopped opening the subsystem mid-exchange.
      expect({
        reconnected,
        withinCeiling: elapsedMs < BOUNDED_DIAL_CEILING_MS,
        subsystemRequests:
          srv.sessionControls.withheldSubsystemOpenCount() - withheldBefore,
      }).toEqual({
        reconnected: false,
        withinCeiling: true,
        subsystemRequests: 1,
      });
      // What the mode reports for the cycle it skipped names the same phase, so
      // an operator watching a poll loop go nowhere is told why.
      expect(logs.map((entry) => entry.message).join("\n")).toContain(
        "did not open the SFTP subsystem",
      );
    } finally {
      srv.sessionControls.withholdSubsystemOpen = false;
      await adapter.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
