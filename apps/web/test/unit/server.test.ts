import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { openPeerConnection, waitForPeerId } from "../../src/psi/server.js";

import type Peer from "peerjs";

// --- waitForPeerId -----------------------------------------------------------

type MessageEventLike = { data: string };

class FakeEventSource {
  url: string;
  readyState = 0; // CONNECTING
  close = vi.fn(() => {
    this.readyState = 2; // CLOSED
  });
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, handler: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  emit(type: string, ev?: unknown) {
    for (const handler of this.listeners[type] ?? []) handler(ev);
  }
}

function withFakeEventSource(): {
  factory: (url: string) => EventSource;
  current: () => FakeEventSource;
} {
  let fake: FakeEventSource | undefined;
  return {
    factory: (url: string) => {
      fake = new FakeEventSource(url);
      return fake as unknown as EventSource;
    },
    current: () => {
      if (!fake) throw new Error("event source not yet constructed");
      return fake;
    },
  };
}

describe("waitForPeerId", () => {
  test("resolves with the invited peer id", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", { eventSourceFactory: es.factory });

    es.current().emit("message", {
      data: JSON.stringify({ invitedPeerId: "peer-123" }),
    } satisfies MessageEventLike);

    expect(await promise).toBe("peer-123");
    expect(es.current().close).toHaveBeenCalledTimes(1);
  });

  test("rejects with 'session expired' on the application-level error frame", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", { eventSourceFactory: es.factory });

    es.current().emit("message", {
      data: JSON.stringify({ error: "session uuid timed-out waiting" }),
    } satisfies MessageEventLike);

    await expect(promise).rejects.toThrow("session expired");
  });

  test("rejects on a genuinely unexpected message", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", { eventSourceFactory: es.factory });

    es.current().emit("message", {
      data: JSON.stringify({ something: "else" }),
    } satisfies MessageEventLike);

    await expect(promise).rejects.toThrow("unexpected message from server");
  });

  test("tolerates a transient reconnect (CONNECTING) and resolves on a later id", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", { eventSourceFactory: es.factory });

    // readyState is CONNECTING (the browser is reconnecting): not fatal.
    es.current().emit("error");
    es.current().emit("message", {
      data: JSON.stringify({ invitedPeerId: "peer-after-blip" }),
    } satisfies MessageEventLike);

    expect(await promise).toBe("peer-after-blip");
  });

  test("rejects when the stream is CLOSED", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", { eventSourceFactory: es.factory });

    es.current().readyState = 2; // CLOSED
    es.current().emit("error");

    await expect(promise).rejects.toThrow("event source connection closed");
  });

  test("rejects and closes the stream on timeout", async () => {
    const es = withFakeEventSource();
    const promise = waitForPeerId("uuid", {
      timeoutMs: 10,
      eventSourceFactory: es.factory,
    });

    await expect(promise).rejects.toThrow("timed out");
    expect(es.current().close).toHaveBeenCalled();
  });

  test("rejects and closes the stream when the signal aborts", async () => {
    const es = withFakeEventSource();
    const controller = new AbortController();
    const promise = waitForPeerId("uuid", {
      timeoutMs: 10_000,
      signal: controller.signal,
      eventSourceFactory: es.factory,
    });

    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(es.current().close).toHaveBeenCalledTimes(1);
  });

  test("settles exactly once when an abort follows a resolution", async () => {
    const es = withFakeEventSource();
    const controller = new AbortController();
    const promise = waitForPeerId("uuid", {
      timeoutMs: 10_000,
      signal: controller.signal,
      eventSourceFactory: es.factory,
    });

    es.current().emit("message", {
      data: JSON.stringify({ invitedPeerId: "peer-1" }),
    } satisfies MessageEventLike);
    controller.abort(); // races the already-settled resolution

    expect(await promise).toBe("peer-1");
    expect(es.current().close).toHaveBeenCalledTimes(1);
  });
});

// --- openPeerConnection (destroy-on-failure) ---------------------------------

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
  connect = vi.fn(() => ({ id: "data-conn" }));
}

describe("openPeerConnection destroy-on-failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("destroys the constructed Peer and rejects on a pre-open error", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", port: "3000", protocol: "http:" },
    });
    const fake = new FakePeer();
    const promise = openPeerConnection("remote-id", {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("error", new Error("broker unreachable"));

    await expect(promise).rejects.toThrow("broker unreachable");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fake.connect).not.toHaveBeenCalled();
  });

  test("does not destroy the Peer once it has opened (the caller owns it)", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", port: "3000", protocol: "http:" },
    });
    const fake = new FakePeer();
    const promise = openPeerConnection("remote-id", {
      peerFactory: () => fake as unknown as Peer,
    });

    fake.emit("open", "my-id");
    const [peer] = await promise;
    expect(peer).toBe(fake as unknown as Peer);

    // A late error after the handle was surfaced belongs to the caller's Peer.
    fake.emit("error", new Error("late drop"));
    expect(fake.destroy).not.toHaveBeenCalled();
  });
});
