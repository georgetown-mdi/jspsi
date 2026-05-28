import { describe, expect, test } from "vitest";

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
});
