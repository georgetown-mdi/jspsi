import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { createAndSharePeerId } from "../../src/psi/client.js";

import type Peer from "peerjs";

import type { LinkSession } from "../../src/utils/sessions.js";

const session = { uuid: "test-uuid" } as unknown as LinkSession;

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
  connect = vi.fn();
}

describe("createAndSharePeerId destroy-on-failure", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", port: "3000", protocol: "http:" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("resolves the Peer once the id POST succeeds, without destroying it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, statusText: "OK" })),
    );
    const fake = new FakePeer();
    const promise = createAndSharePeerId(session, {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("open", "my-peer-id");

    expect(await promise).toBe(fake as unknown as Peer);
    expect(fake.destroy).not.toHaveBeenCalled();
  });

  test("destroys the Peer and rejects when the id POST returns a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, statusText: "boom" }),
      ),
    );
    const fake = new FakePeer();
    const promise = createAndSharePeerId(session, {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("open", "my-peer-id");

    await expect(promise).rejects.toThrow("error posting peer id");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  test("destroys the Peer and rejects when the id POST fetch is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const fake = new FakePeer();
    const promise = createAndSharePeerId(session, {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("open", "my-peer-id");

    await expect(promise).rejects.toThrow("network down");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  test("destroys the Peer and rejects on a pre-open error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const fake = new FakePeer();
    const promise = createAndSharePeerId(session, {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("error", new Error("broker unreachable"));

    await expect(promise).rejects.toThrow("broker unreachable");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
