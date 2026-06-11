import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { deriveRendezvousPeerId, generateSharedSecret } from "@psilink/core";

import { dialAsAcceptor, listenAsInviter } from "../../src/psi/rendezvous.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";
import type { WebRTCEndpoint } from "@psilink/core";

// A fake PeerJS data channel: just the events and methods the rendezvous touches.
class FakeConn extends EventEmitter {
  close = vi.fn();
}

// A fake PeerJS peer. `connect` hands back a fresh FakeConn each call (and
// records them) so a test can drive the open/error of a specific dial attempt.
class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
  conns: Array<FakeConn> = [];
  connect = vi.fn(() => {
    const conn = new FakeConn();
    this.conns.push(conn);
    return conn as unknown as DataConnection;
  });
}

/** Capture the (id, options) the rendezvous constructs its Peer with. */
function captureFactory(fake: FakePeer): {
  factory: (id: string, options: unknown) => Peer;
  id: () => string;
} {
  let capturedId: string | undefined;
  return {
    factory: (id) => {
      capturedId = id;
      return fake as unknown as Peer;
    },
    id: () => {
      if (capturedId === undefined) throw new Error("peer not constructed");
      return capturedId;
    },
  };
}

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWindow(): void {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", port: "3000", protocol: "http:" },
  });
}

describe("listenAsInviter", () => {
  test("registers on the derived inviter id and resolves on open", async () => {
    stubWindow();
    const secret = generateSharedSecret();
    const expectedId = await deriveRendezvousPeerId(secret, "inviter");

    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = listenAsInviter(secret, { peerFactory: cap.factory });

    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    expect(cap.id()).toBe(expectedId);

    fake.emit("open", expectedId);
    expect(await promise).toBe(fake as unknown as Peer);
    expect(fake.destroy).not.toHaveBeenCalled();
  });

  test("destroys the peer and rejects on a pre-open error", async () => {
    stubWindow();
    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = listenAsInviter(generateSharedSecret(), {
      peerFactory: cap.factory,
    });

    await vi.waitFor(() =>
      expect(fake.listenerCount("error")).toBeGreaterThan(0),
    );
    fake.emit("error", new Error("broker unreachable"));

    await expect(promise).rejects.toThrow("broker unreachable");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("dialAsAcceptor", () => {
  test("registers under the acceptor id and dials the inviter id", async () => {
    stubWindow();
    const secret = generateSharedSecret();
    const inviterId = await deriveRendezvousPeerId(secret, "inviter");
    const acceptorId = await deriveRendezvousPeerId(secret, "acceptor");

    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = dialAsAcceptor(secret, endpoint, {
      peerFactory: cap.factory,
    });

    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    expect(cap.id()).toBe(acceptorId);
    fake.emit("open", acceptorId);

    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    expect(fake.connect).toHaveBeenCalledWith(inviterId, { reliable: true });
    const conn = fake.conns[0];
    await vi.waitFor(() =>
      expect(conn.listenerCount("open")).toBeGreaterThan(0),
    );
    conn.emit("open");

    const [peer, resolved] = await promise;
    expect(peer).toBe(fake as unknown as Peer);
    expect(resolved).toBe(conn as unknown as DataConnection);
    expect(fake.destroy).not.toHaveBeenCalled();
  });

  test("retries when the inviter is not yet available, then connects", async () => {
    stubWindow();
    const secret = generateSharedSecret();
    const inviterId = await deriveRendezvousPeerId(secret, "inviter");

    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = dialAsAcceptor(secret, endpoint, {
      peerFactory: cap.factory,
      retryDelayMs: 1,
    });

    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    fake.emit("open", "acceptor");

    // First attempt: the inviter has not registered yet -> peer-unavailable.
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1));
    fake.emit("error", { type: "peer-unavailable" });
    expect(fake.conns[0].close).toHaveBeenCalled();

    // After the backoff, it re-dials the same inviter id and this time opens.
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(2));
    expect(fake.connect).toHaveBeenLastCalledWith(inviterId, {
      reliable: true,
    });
    const conn = fake.conns[1];
    await vi.waitFor(() =>
      expect(conn.listenerCount("open")).toBeGreaterThan(0),
    );
    conn.emit("open");

    const [, resolved] = await promise;
    expect(resolved).toBe(conn as unknown as DataConnection);
    expect(fake.destroy).not.toHaveBeenCalled();
  });

  test("destroys the peer and rejects on a fatal dial error", async () => {
    stubWindow();
    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = dialAsAcceptor(generateSharedSecret(), endpoint, {
      peerFactory: cap.factory,
    });

    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    fake.emit("open", "acceptor");
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    // A non-`peer-unavailable` error is fatal to the dial.
    fake.emit("error", { type: "network", message: "broker dropped" });

    await expect(promise).rejects.toThrow();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  test("aborts the dial via the signal and destroys the peer", async () => {
    stubWindow();
    const controller = new AbortController();
    const fake = new FakePeer();
    const cap = captureFactory(fake);
    const promise = dialAsAcceptor(generateSharedSecret(), endpoint, {
      peerFactory: cap.factory,
      signal: controller.signal,
    });

    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});
