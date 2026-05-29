import { describe, expect, test, vi, afterEach } from "vitest";

import { runReceiveSequence } from "../src/utils/receiveSequence";
import { StubConnection } from "./utils/stubConnection";

import type { Connection } from "../src/types";

describe("runReceiveSequence timer cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("no stale timer after synchronous last handler completes", async () => {
    vi.useFakeTimers();
    const conn = new StubConnection();
    let handlerRan = false;
    const promise = runReceiveSequence(conn as Connection, [
      (_rawData: unknown) => {
        handlerRan = true;
      },
    ]);

    // Drive one data event so the synchronous handler fires and the phase resolves.
    conn.emit("data", { type: "message" });
    expect(handlerRan).toBe(true);

    // Advance past the 120-second inactivity timeout.
    await vi.advanceTimersByTimeAsync(125_000);

    // The promise should still resolve cleanly — no stale timer fired fail().
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("runReceiveSequence with empty handlers", () => {
  test("resolves immediately when handlers is empty and no initialSend", async () => {
    const conn = new StubConnection();
    await expect(
      runReceiveSequence(conn as Connection, []),
    ).resolves.toBeUndefined();
  });

  test("resolves after initialSend when handlers is empty", async () => {
    const conn = new StubConnection();
    let sent = false;
    await expect(
      runReceiveSequence(conn as Connection, [], () => {
        sent = true;
      }),
    ).resolves.toBeUndefined();
    expect(sent).toBe(true);
  });

  test("rejects if initialSend throws and handlers is empty", async () => {
    const conn = new StubConnection();
    await expect(
      runReceiveSequence(conn as Connection, [], () => {
        throw new Error("send failed");
      }),
    ).rejects.toThrow("send failed");
  });

  test("rejects if initialSend returns a rejected promise and handlers is empty", async () => {
    const conn = new StubConnection();
    await expect(
      runReceiveSequence(conn as Connection, [], () =>
        Promise.reject(new Error("async send failed")),
      ),
    ).rejects.toThrow("async send failed");
  });

  test("rejects with a buffered error even when handlers is empty", async () => {
    const conn = new StubConnection();
    conn.emit("error", new Error("earlier failure"));
    await expect(
      runReceiveSequence(conn as Connection, []),
    ).rejects.toThrow("earlier failure");
  });
});
