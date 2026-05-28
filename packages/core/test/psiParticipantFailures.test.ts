import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";

import type { Connection } from "../src/types";

const psiLibrary = await PSI();

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

// A connection that records sends and lets a test drive failures. Its `send`
// neither delivers data nor (by default) throws, so a started exchange stalls
// awaiting a reply unless the test emits an error or advances the clock.
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

function startStarterExchange(conn: StubConnection): Promise<unknown> {
  const participant = new PSIParticipant("starter", psiLibrary, {
    role: "starter",
    verbose: 0,
  });
  return participant.identifyIntersection(conn as Connection, ["a", "b"]);
}

describe("identifyIntersection failure handling", () => {
  test("rejects when the connection emits an error mid-exchange", async () => {
    const conn = new StubConnection();
    const p = startStarterExchange(conn);

    conn.emit("error", new Error("transport boom"));

    await expect(p).rejects.toThrow("transport boom");
  });

  test("rejects (does not hang) when a send throws synchronously", async () => {
    const conn = new StubConnection();
    conn.sendImpl = () => {
      throw new Error("connection closed");
    };

    const p = startStarterExchange(conn);

    await expect(p).rejects.toThrow("connection closed");
  });

  test("rejects with a transport error buffered before the phase began", async () => {
    const conn = new StubConnection();
    conn.emit("error", new Error("earlier failure")); // no listener yet

    const p = startStarterExchange(conn);

    await expect(p).rejects.toThrow("earlier failure");
  });

  test("rejects after the inactivity timeout when the peer never responds", async () => {
    vi.useFakeTimers();
    try {
      const conn = new StubConnection();
      const p = startStarterExchange(conn);
      p.catch(() => {});

      await vi.advanceTimersByTimeAsync(120_000);

      await expect(p).rejects.toThrow("PSI exchange timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
