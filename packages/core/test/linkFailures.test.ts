import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { exchangeMappedElements } from "../src/link";

import type { Connection } from "../src/types";
import type { IterationMap } from "../src/link";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

// Same stub as psiParticipantFailures.test.ts: records sends, lets tests
// drive failures, and mirrors the buffering semantics of production transports.
class StubConnection extends EventEmitter<Events, never> {
  sentMessages: Array<unknown> = [];
  sendImpl: (data: unknown) => void | Promise<void> = () => {};
  private bufferedError: unknown;

  send(data: unknown): void | Promise<void> {
    this.sentMessages.push(data);
    return this.sendImpl(data);
  }
  close() {}
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) this.bufferedError = args[0];
    return hadListeners;
  }
  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}

const noopLog = { info: () => {}, debug: () => {} };
const emptyValues: IterationMap = [];

describe("exchangeMappedElements failure handling", () => {
  test("rejects when the connection emits an error mid-exchange", async () => {
    const conn = new StubConnection();
    const p = exchangeMappedElements("t", conn as Connection, noopLog, true, emptyValues);

    conn.emit("error", new Error("transport boom"));

    await expect(p).rejects.toThrow("transport boom");
  });

  test("rejects with a transport error buffered before the phase began", async () => {
    const conn = new StubConnection();
    conn.emit("error", new Error("earlier failure")); // no listener yet

    const p = exchangeMappedElements("t", conn as Connection, noopLog, true, emptyValues);

    await expect(p).rejects.toThrow("earlier failure");
  });

  test("rejects when received data fails schema validation", async () => {
    const conn = new StubConnection();
    const p = exchangeMappedElements("t", conn as Connection, noopLog, true, emptyValues);

    conn.emit("data", "not a valid IterationMap");

    await expect(p).rejects.toThrow();
  });

  test("rejects (does not hang) when initial send throws in send-first path", async () => {
    const conn = new StubConnection();
    conn.sendImpl = () => {
      throw new Error("initial send failed");
    };

    const p = exchangeMappedElements("t", conn as Connection, noopLog, true, emptyValues);

    await expect(p).rejects.toThrow("initial send failed");
  });

  test("rejects (does not hang) when send throws in receive-first path after data arrives", async () => {
    const conn = new StubConnection();
    conn.sendImpl = () => {
      throw new Error("send failed");
    };
    const p = exchangeMappedElements("t", conn as Connection, noopLog, false, emptyValues);

    conn.emit("data", []); // valid empty IterationMap

    await expect(p).rejects.toThrow("send failed");
  });

  test("rejects after the inactivity timeout when the peer never responds", async () => {
    vi.useFakeTimers();
    try {
      const conn = new StubConnection();
      const p = exchangeMappedElements("t", conn as Connection, noopLog, true, emptyValues);
      p.catch(() => {});

      await vi.advanceTimersByTimeAsync(120_000);

      await expect(p).rejects.toThrow("PSI mapped-element exchange timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
