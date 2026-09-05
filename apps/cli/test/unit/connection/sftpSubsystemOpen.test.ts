import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS, TimeoutError } from "@psilink/core";

import {
  subsystemOpenTimeoutMs,
  watchSubsystemOpen,
} from "../../../src/connection/sftpSubsystemOpen";

// A minimal stand-in for the ssh2 Client's EventEmitter surface, so the watch's
// arming and its cancellation can be driven without a socket. What the real
// client does at each of these points -- when 'ready' fires, and that the phase
// after it is otherwise unbounded -- is measured in
// test/integration/sftpStackPremises.test.ts, not modelled here.
function fakeClient(): {
  once(event: "close" | "ready", listener: () => void): void;
  removeListener(event: "close" | "ready", listener: () => void): void;
  emitReady(): void;
  listenerCount(): number;
} {
  const listeners = new Set<() => void>();
  return {
    once(event, listener) {
      if (event === "ready") listeners.add(listener);
    },
    removeListener(event, listener) {
      if (event === "ready") listeners.delete(listener);
    },
    emitReady() {
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe("subsystemOpenTimeoutMs", () => {
  it("is the per-attempt connect budget the dial already runs under", () => {
    expect(subsystemOpenTimeoutMs(7_500)).toBe(7_500);
  });

  it.each([
    ["unset", undefined],
    ["zero", 0],
    ["negative", -1],
    ["not a number", "30000"],
    ["not finite", Number.POSITIVE_INFINITY],
  ])(
    "falls back to the schema default when the budget is %s",
    (_label, ready) => {
      expect(subsystemOpenTimeoutMs(ready)).toBe(
        DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
      );
    },
  );
});

describe("watchSubsystemOpen", () => {
  it("stays unsettled until authentication has succeeded", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const watch = watchSubsystemOpen(client, 1_000);
      const settled = vi.fn();
      watch?.expired.catch(settled);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a subsystem that never opened once the bound has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const watch = watchSubsystemOpen(client, 1_000);
      const rejection = watch?.expired.catch((error: unknown) => error);

      client.emitReady();
      await vi.advanceTimersByTimeAsync(999);
      expect(await Promise.race([rejection, "pending"])).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      const error = await rejection;
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as Error).message).toContain(
        "did not open the SFTP subsystem",
      );
      expect((error as Error).message).toContain("1000 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops its timer and its subscription when cancelled", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const watch = watchSubsystemOpen(client, 1_000);
      const settled = vi.fn();
      watch?.expired.catch(settled);

      client.emitReady();
      watch?.cancel();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(settled).not.toHaveBeenCalled();
      expect(client.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the subscription off a client it never armed on", () => {
    const client = fakeClient();
    const watch = watchSubsystemOpen(client, 1_000);
    expect(client.listenerCount()).toBe(1);
    watch?.cancel();
    expect(client.listenerCount()).toBe(0);
  });

  it.each([
    ["no client at all", undefined],
    ["a client with no subscribe", {} as never],
    ["a client with no unsubscribe", { once: () => {} } as never],
  ])("declines to arm against %s", (_label, client) => {
    expect(watchSubsystemOpen(client, 1_000)).toBeUndefined();
  });
});
