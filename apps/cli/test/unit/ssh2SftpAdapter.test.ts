import { describe, expect, test, vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

// --- connect retry -----------------------------------------------------------

describe("connect retry", () => {
  test("retries and succeeds within maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi.fn().mockImplementation(async () => {
        if (++calls < 3) throw new Error("connection refused");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 2,
      });
      // Advance past two 1 s retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(2_001);
      await p;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("throws after exhausting maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi.fn().mockImplementation(async () => {
        calls++;
        throw new Error("connection refused");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 1,
      });
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(p).rejects.toThrow("connection refused");
      // 2 total attempts (initial + 1 reconnect) with 1 s delay between each.
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("strips maxReconnectAttempts from options passed to ssh2", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    let capturedOptions: Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi
        .fn()
        .mockImplementation(async (opts: Record<string, unknown>) => {
          capturedOptions = opts;
        }),
    };

    // 0 retries = 1 total attempt.
    await adapter.connect({
      host: "sftp.example.org",
      maxReconnectAttempts: 0,
    });
    expect(capturedOptions).toHaveProperty("host", "sftp.example.org");
    expect(capturedOptions).not.toHaveProperty("maxReconnectAttempts");
  });
});
