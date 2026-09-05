// What the dial does with the subsystem-open bound's rejection: which failures
// it classifies as that phase, and what it closes when it meets one. The bound
// itself is ./sftpSubsystemOpen.test.ts, and its behavior against a real server
// is test/integration/subsystemOpenBound.test.ts.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";
import { TimeoutError } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { SubsystemOpenTimeoutError } from "../../../src/connection/sftpSubsystemOpen";
import {
  adapterLog,
  captureAdapterLog,
  installClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

describe("the dial's subsystem-open bound", () => {
  // The per-attempt connect budget these dials run under, which is also the
  // bound armed over the phase after authentication.
  const CONNECT_BUDGET_MS = 5_000;

  interface DialSocket {
    setKeepAlive: () => void;
    destroyed: boolean;
    destroy?: () => void;
  }

  // An ssh2-sftp-client stand-in whose ssh2 Client reports the authentication
  // ssh2 emits as 'ready' and whose dial then goes nowhere, which is the server
  // that accepts the credentials and never answers the subsystem request.
  // `closable: false` models an ssh2 that relocated the socket beneath its
  // Client, leaving this build nothing to close the abandoned dial with, and
  // `closeDelayMs` how long after the destroy that Client reports the 'close'
  // the forced close waits out -- omitted, it reports none at all.
  function stalledAtSubsystem(
    options: { closable?: boolean; closeDelayMs?: number } = {},
  ) {
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket: DialSocket = { setKeepAlive: () => {}, destroyed: false };
    if (options.closable !== false)
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
        if (options.closeDelayMs !== undefined)
          setTimeout(() => rawClient.emit("close"), options.closeDelayMs);
      });
    Object.assign(rawClient, { setNoDelay: vi.fn(), _sock: socket });
    const connect = vi.fn(
      () =>
        new Promise<void>(() => {
          rawClient.emit("ready");
        }),
    );
    return {
      client: { connect, client: rawClient, sftp: wrapperMethods() },
      socket,
      connect,
    };
  }

  function loggedAdapter() {
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    return { adapter, log: adapterLog(adapter) };
  }

  const dialOptions = { host: "h", readyTimeout: CONNECT_BUDGET_MS };

  // The bound the forced close waits under, as ssh2SftpAdapter.ts holds it.
  const FORCED_CLOSE_BOUND_MS = 1_000;
  // A stand-in for the tick or two a real socket takes to reach the ssh2
  // Client's 'close', short enough to leave the bound above untouched.
  const CLOSE_DELAY_MS = 200;

  // The dial's settlement as a value a case can read at a chosen point on the
  // fake clock, "pending" until the adapter has reported something.
  function trackedDial(
    adapter: SSH2SFTPClientAdapter,
    options: Record<string, unknown>,
  ): { outcome: unknown } {
    const dial: { outcome: unknown } = { outcome: "pending" };
    void adapter.connect(options).then(
      () => {
        dial.outcome = "connected";
      },
      (error: unknown) => {
        dial.outcome = error;
      },
    );
    return dial;
  }

  test("closes the abandoned dial's transport and spends no retry on it", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket, connect } = stalledAtSubsystem();
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = adapter.connect({ ...dialOptions, maxReconnectAttempts: 3 });
      const assertion = expect(dial).rejects.toBeInstanceOf(
        SubsystemOpenTimeoutError,
      );
      // Past the bound, then well past several 1 s retry windows: a re-attempt
      // would put the same request to the same server, so a classifier that let
      // this one through would show up as a second call here.
      await vi.advanceTimersByTimeAsync(CONNECT_BUDGET_MS + 5_000);
      await assertion;

      // Closed before the rejection is reported: ssh2 defers a later connect()
      // on a still-writable socket behind its close and arms no readyTimeout
      // for the deferred attempt (docs/spec/DEPENDENCY_PINS.md).
      expect({
        attempts: connect.mock.calls.length,
        closed: socket.destroyed,
      }).toEqual({ attempts: 1, closed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("warns when this build cannot close the abandoned dial's transport", async () => {
    vi.useFakeTimers();
    try {
      const { client } = stalledAtSubsystem({ closable: false });
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);

      const dial = adapter.connect({ ...dialOptions, maxReconnectAttempts: 0 });
      const assertion = expect(dial).rejects.toBeInstanceOf(
        SubsystemOpenTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(CONNECT_BUDGET_MS + 1);
      await assertion;

      // The operator hears it once, and at WARN: the socket this build could
      // not close stays writable, and every later dial on this shared client
      // waits behind it with no deadline of its own.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toContain(
        "not compatible with the installed SFTP library",
      );
      expect(
        log.debug.mock.calls.map((call: unknown[]) => call[0]).join("\n"),
      ).toContain("client._sock.destroy()");
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries a dial that fails with a timeout of another kind", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket, connect } = stalledAtSubsystem();
      // A deadline raised by something other than this bound keeps the dial's
      // own classification: it is retried, and the socket beneath it is left to
      // ssh2 rather than destroyed under a dial that already settled.
      connect.mockImplementation(() =>
        Promise.reject(new TimeoutError("the connect probe gave up")),
      );
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = adapter.connect({ ...dialOptions, maxReconnectAttempts: 2 });
      const assertion = expect(dial).rejects.toThrow("the connect probe");
      await vi.advanceTimersByTimeAsync(2_001);
      await assertion;

      expect({
        attempts: connect.mock.calls.length,
        closed: socket.destroyed,
      }).toEqual({ attempts: 3, closed: false });
    } finally {
      vi.useRealTimers();
    }
  });
  test("reports the abandoned dial's failure only once its close has landed", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = stalledAtSubsystem({
        closeDelayMs: CLOSE_DELAY_MS,
      });
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter, {
        ...dialOptions,
        maxReconnectAttempts: 0,
      });
      await vi.advanceTimersByTimeAsync(CONNECT_BUDGET_MS + 1);

      // The bound has expired and the socket is destroyed, and the caller has
      // its failure only once that destroy's 'close' has landed: a dial issued
      // on this client while it is owed is failed by ssh2-sftp-client's
      // connect-time listeners while the handshake it started runs on unowned
      // at the server (docs/spec/DEPENDENCY_PINS.md).
      expect({ destroyed: socket.destroyed, outcome: dial.outcome }).toEqual({
        destroyed: true,
        outcome: "pending",
      });

      await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
      expect(dial.outcome).toBeInstanceOf(SubsystemOpenTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports it at the close wait's own bound when no close lands", async () => {
    vi.useFakeTimers();
    try {
      const { client } = stalledAtSubsystem();
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter, {
        ...dialOptions,
        maxReconnectAttempts: 0,
      });
      await vi.advanceTimersByTimeAsync(CONNECT_BUDGET_MS + 1);
      expect(dial.outcome).toBe("pending");

      // A Client that reports no 'close' for the socket this side destroyed
      // costs the caller that bound and nothing more: the wait is a bound on
      // the report, never a condition for making it.
      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS);
      expect(dial.outcome).toBeInstanceOf(SubsystemOpenTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps the dial's own failure when closing it raises", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = stalledAtSubsystem();
      socket.destroy = () => {
        throw new Error("the socket was already gone");
      };
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter, {
        ...dialOptions,
        maxReconnectAttempts: 0,
      });
      await vi.advanceTimersByTimeAsync(CONNECT_BUDGET_MS + 1);

      // The close reports its own failure beside the dial's rather than
      // replacing it: the dial's rejection is the reading the retry loop
      // classifies this failure as terminal by.
      expect(dial.outcome).toBeInstanceOf(SubsystemOpenTimeoutError);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toContain(
        "the socket was already gone",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
