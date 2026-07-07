import { describe, expect, test, vi } from "vitest";

import {
  SFTP_HEARTBEAT_INTERVAL_MS,
  SFTP_TCP_KEEPALIVE_DELAY_MS,
  SftpHeartbeat,
} from "../../src/connection/sftpHeartbeat";

// The application-layer keepalive that defeats a server's SFTP-command idle
// timeout (board item 208035324). These pin the behaviors the adapter relies on:
// it beats only after a genuine idle interval, never while a real operation is in
// flight (ssh2-sftp-client forbids concurrent ops on one client), never stacks
// beats, and stops dead on teardown so nothing outlives the session.

const log = () => ({ trace: vi.fn() });

// A controllable ping: resolves immediately by default, or parks until released
// so a "slow keepalive" can be modeled.
function makePing() {
  const calls: Array<{ resolve: () => void; reject: (e: unknown) => void }> =
    [];
  const ping = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { ping, calls };
}

describe("SftpHeartbeat", () => {
  test("interval and TCP-keepalive constants hold their documented values", () => {
    // The interval must stay at half of Azure Blob SFTP's fixed 2-minute idle
    // timeout so a delayed beat still lands with a full interval of margin; the
    // TCP-keepalive delay must stay below it as the transport-layer backstop.
    expect(SFTP_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(SFTP_TCP_KEEPALIVE_DELAY_MS).toBe(30_000);
    expect(SFTP_TCP_KEEPALIVE_DELAY_MS).toBeLessThan(
      SFTP_HEARTBEAT_INTERVAL_MS,
    );
  });

  test("issues a keepalive after a full idle interval and reschedules", async () => {
    vi.useFakeTimers();
    try {
      // Each keepalive resolves at once, so the next beat re-arms on its settle.
      const ping = vi.fn(() => Promise.resolve());
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // Just short of the interval: still idle, no beat yet.
      await vi.advanceTimersByTimeAsync(999);
      expect(ping).not.toHaveBeenCalled();
      // Crossing the interval issues exactly one keepalive.
      await vi.advanceTimersByTimeAsync(1);
      expect(ping).toHaveBeenCalledTimes(1);
      // The settled ping re-arms the next beat: a second interval issues a second.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("suppresses the keepalive while an operation is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { ping } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // A long operation spans the interval boundary: the operation itself keeps
      // the session alive, so no concurrent keepalive is issued (which would be
      // an unsafe second op on the one ssh2-sftp-client connection).
      hb.opStarted();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ping).not.toHaveBeenCalled();
      // Once it settles the idle clock restarts; a keepalive follows one interval
      // of genuine quiet later, not immediately.
      hb.opSettled();
      await vi.advanceTimersByTimeAsync(999);
      expect(ping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("resets the idle clock on activity, deferring the beat by the remainder", async () => {
    vi.useFakeTimers();
    try {
      const { ping } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // A brief operation lands halfway through the window and resets the clock,
      // so the pending beat must not fire at the original interval.
      await vi.advanceTimersByTimeAsync(500);
      hb.opStarted();
      hb.opSettled();
      await vi.advanceTimersByTimeAsync(500);
      expect(ping).not.toHaveBeenCalled();
      // A full interval after the activity, the beat fires.
      await vi.advanceTimersByTimeAsync(500);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not stack beats while a keepalive is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const { ping, calls } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // First beat fires and parks (the server is slow to answer the realPath).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      // Several more intervals elapse with the first ping unresolved: no second
      // ping is issued, since the next beat is only armed once a ping settles.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ping).toHaveBeenCalledTimes(1);
      // Releasing it re-arms the schedule; the next interval issues the next beat.
      calls[0].resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed keepalive is swallowed and the heartbeat keeps beating", async () => {
    vi.useFakeTimers();
    try {
      const { ping, calls } = makePing();
      const trace = vi.fn();
      const hb = new SftpHeartbeat({
        ping,
        log: { trace },
        intervalMs: 1_000,
      });
      hb.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      // The server rejects the keepalive: it is logged at trace, never rethrown,
      // and the next beat still arms.
      calls[0].reject(new Error("channel closed"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(2);
      expect(trace).toHaveBeenCalledWith(
        expect.stringContaining("SFTP keepalive failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop() halts all further beats, including one already scheduled", async () => {
    vi.useFakeTimers();
    try {
      const { ping } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      hb.stop();
      // No beat ever fires after stop, however long the process idles.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ping).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a keepalive settling after stop() does not re-arm a torn-down heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const { ping, calls } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      // Teardown lands while the keepalive is still in flight; its late settle
      // must not schedule another beat.
      hb.stop();
      calls[0].resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("start() after stop() re-arms cleanly (reconnect)", async () => {
    vi.useFakeTimers();
    try {
      const { ping } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      hb.stop();
      // A reconnect re-arms the heartbeat; a fresh idle interval issues a beat.
      hb.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reconnect while a prior keepalive is still in flight still beats, and the stale ping is inert", async () => {
    vi.useFakeTimers();
    try {
      const { ping, calls } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // A beat fires and its keepalive is still unanswered (the server is slow)...
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      // ...when a fatal error tears the session down mid-ping and the adapter then
      // reconnects. The new session must beat on its own interval, not stay
      // suppressed by the prior cycle's stuck `pinging` flag.
      hb.stop();
      hb.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(2);
      // The interrupted first ping settling late is inert: it must not reschedule
      // onto the new session (which would stack a second, racing beat). With the new
      // session's own ping still in flight (so no beat is armed on a timer), nothing
      // else can fire, so the count holds.
      calls[0].resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ping).toHaveBeenCalledTimes(2);
      // The new session's own ping still drives its next beat normally.
      calls[1].resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("start() clears a stuck in-flight count left by a torn-down session", async () => {
    vi.useFakeTimers();
    try {
      const { ping } = makePing();
      const hb = new SftpHeartbeat({ ping, log: log(), intervalMs: 1_000 });
      hb.start();
      // An operation is in flight when the session is torn down (a fatal error),
      // and is never balanced by opSettled on that dead session.
      hb.opStarted();
      hb.stop();
      // Reconnect: the new session must not inherit the stale in-flight count, which
      // would make every tick skip the beat.
      hb.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
