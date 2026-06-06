import { describe, expect, test } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { waitForIncomingConnection } from "../../src/psi/waitForConnection.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

class FakePeer extends EventEmitter {}

function makePeer(): { fake: FakePeer; peer: Peer } {
  const fake = new FakePeer();
  return { fake, peer: fake as unknown as Peer };
}

describe("waitForIncomingConnection", () => {
  test("resolves with the first incoming connection", async () => {
    const { fake, peer } = makePeer();
    const promise = waitForIncomingConnection(peer, { timeoutMs: 1000 });

    const conn = { id: "c1" } as unknown as DataConnection;
    fake.emit("connection", conn);

    expect(await promise).toBe(conn);
  });

  test("rejects if no connection arrives within the timeout", async () => {
    const { peer } = makePeer();

    await expect(
      waitForIncomingConnection(peer, { timeoutMs: 10 }),
    ).rejects.toThrow("timed out waiting for the other party to connect");
  });

  test("detaches the connection listener on timeout", async () => {
    const { fake, peer } = makePeer();

    await waitForIncomingConnection(peer, { timeoutMs: 10 }).catch(
      () => undefined,
    );

    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("rejects and tears down when the signal aborts", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();

    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("rejects immediately if the signal is already aborted", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForIncomingConnection(peer, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("settles exactly once when a connection arrives after an abort", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();

    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    // A connection arriving after the abort must not overturn the settled
    // rejection: the settle-once guard already removed the listener.
    fake.emit("connection", { id: "late" });

    await expect(promise).rejects.toThrow("aborted");
  });
});
