import { describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { waitForConnectionOpen } from "../../src/psi/waitForOpen.js";

import type { DataConnection } from "peerjs";

class FakeConn extends EventEmitter {}

function makeConn(): { fake: FakeConn; conn: DataConnection } {
  const fake = new FakeConn();
  return { fake, conn: fake as unknown as DataConnection };
}

describe("waitForConnectionOpen", () => {
  test("resolves immediately when the connection is already open", async () => {
    class FakeConnOpen extends EventEmitter {
      readonly open = true;
    }
    const fake = new FakeConnOpen();
    await expect(
      waitForConnectionOpen(fake as unknown as DataConnection),
    ).resolves.toBeUndefined();
    expect(fake.listenerCount("open")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
  });

  test("resolves when 'open' fires", async () => {
    const { fake, conn } = makeConn();
    const p = waitForConnectionOpen(conn);
    fake.emit("open");
    await expect(p).resolves.toBeUndefined();
  });

  test("rejects with the error when 'error' fires before 'open'", async () => {
    const { fake, conn } = makeConn();
    const err = new Error("pre-open ICE failure");
    const p = waitForConnectionOpen(conn);
    fake.emit("error", err);
    await expect(p).rejects.toBe(err);
  });

  test("error listener is removed after 'open' fires", async () => {
    const { fake, conn } = makeConn();
    const p = waitForConnectionOpen(conn);
    fake.emit("open");
    await p;
    expect(fake.listenerCount("error")).toBe(0);
    expect(fake.listenerCount("close")).toBe(0);
  });

  test("open listener is removed after 'error' fires", async () => {
    const { fake, conn } = makeConn();
    const err = new Error("pre-open ICE failure");
    const p = waitForConnectionOpen(conn);
    fake.emit("error", err);
    await p.catch(() => {});
    expect(fake.listenerCount("open")).toBe(0);
    expect(fake.listenerCount("close")).toBe(0);
  });

  test("rejects when 'close' fires before 'open'", async () => {
    const { fake, conn } = makeConn();
    const p = waitForConnectionOpen(conn);
    fake.emit("close");
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  test("open and error listeners are removed after 'close' fires", async () => {
    const { fake, conn } = makeConn();
    const p = waitForConnectionOpen(conn);
    fake.emit("close");
    await p.catch(() => {});
    expect(fake.listenerCount("open")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
  });

  test("rejects and removes all listeners after the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const { fake, conn } = makeConn();
      const p = waitForConnectionOpen(conn, 5000);
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).rejects.toThrow("connection open timed out");
      expect(fake.listenerCount("open")).toBe(0);
      expect(fake.listenerCount("error")).toBe(0);
      expect(fake.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not reject after the timeout once 'open' has fired", async () => {
    vi.useFakeTimers();
    try {
      const { fake, conn } = makeConn();
      const p = waitForConnectionOpen(conn, 5000);
      fake.emit("open");
      await expect(p).resolves.toBeUndefined();
      // Advancing past the timeout must not produce a late rejection: the
      // timer is cleared when 'open' fires.
      await vi.advanceTimersByTimeAsync(10000);
    } finally {
      vi.useRealTimers();
    }
  });
});
