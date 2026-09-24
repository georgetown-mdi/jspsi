import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { ConnectionError, generateSharedSecret } from "@alcove/core";

import {
  MAX_RECORDED_ICE_ERRORS,
  iceGatheringRecordFor,
  relayFailureMessage,
  watchIceGathering,
} from "../../../src/psi/transport/iceGathering.js";
import { dialAsAcceptor } from "../../../src/psi/transport/rendezvous.js";
import { waitForConnectionOpen } from "../../../src/psi/transport/waitForOpen.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

const RELAY_URL = "turns:relay.example.org:443";

/** A peer connection holding only what the watch reads. */
class FakePeerConnection extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "new";
  constructor(private readonly iceServers: Array<RTCIceServer>) {
    super();
  }
  getConfiguration(): RTCConfiguration {
    return { iceServers: this.iceServers };
  }
  gather(type: RTCIceCandidateType): void {
    this.dispatchEvent(
      Object.assign(new Event("icecandidate"), { candidate: { type } }),
    );
  }
  finishGathering(): void {
    this.iceGatheringState = "complete";
    this.dispatchEvent(
      Object.assign(new Event("icecandidate"), { candidate: null }),
    );
  }
  fail(url: string, errorCode: number, errorText: string): void {
    this.dispatchEvent(
      Object.assign(new Event("icecandidateerror"), {
        url,
        errorCode,
        errorText,
      }),
    );
  }
}

class FakeConn extends EventEmitter {
  open = false;
  close = vi.fn();
  constructor(readonly peerConnection: FakePeerConnection) {
    super();
  }
}

function relayConn(
  iceServers: Array<RTCIceServer> = [
    { urls: [RELAY_URL], username: "u", credential: "c" },
  ],
): { fake: FakeConn; pc: FakePeerConnection; conn: DataConnection } {
  const pc = new FakePeerConnection(iceServers);
  const fake = new FakeConn(pc);
  return { fake, pc, conn: fake as unknown as DataConnection };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForConnectionOpen with a relay configured", () => {
  test("a timeout with every server healthy keeps the open-timeout wording", async () => {
    vi.useFakeTimers();
    const { pc, conn } = relayConn([
      { urls: ["stun:stun.example.org:3478"] },
      { urls: [RELAY_URL], username: "u", credential: "c" },
    ]);
    const opening = waitForConnectionOpen(conn, 1000);
    pc.gather("host");
    pc.gather("srflx");
    pc.gather("relay");
    pc.finishGathering();
    vi.advanceTimersByTime(1000);
    const error: unknown = await opening.catch((err: unknown) => err);
    expect((error as Error).message).toBe("connection open timed out");
    expect(error).not.toBeInstanceOf(ConnectionError);
  });

  test("a relay candidate outweighs a STUN server's error", async () => {
    vi.useFakeTimers();
    const { pc, conn } = relayConn([
      { urls: ["stun:stun.example.org:3478"] },
      { urls: [RELAY_URL], username: "u", credential: "c" },
    ]);
    const opening = waitForConnectionOpen(conn, 1000);
    pc.gather("relay");
    pc.fail("stun:stun.example.org:3478", 701, "STUN host lookup failed");
    vi.advanceTimersByTime(1000);
    await expect(opening).rejects.toThrow(/^connection open timed out$/);
  });

  test("a timeout with no relay configured keeps the open-timeout wording", async () => {
    vi.useFakeTimers();
    const { pc, conn } = relayConn([{ urls: ["stun:stun.example.org:3478"] }]);
    const opening = waitForConnectionOpen(conn, 1000);
    pc.fail("stun:stun.example.org:3478", 701, "STUN host lookup failed");
    pc.finishGathering();
    vi.advanceTimersByTime(1000);
    await expect(opening).rejects.toThrow(/^connection open timed out$/);
  });

  test("a relay error names the relay and the browser's error text", async () => {
    vi.useFakeTimers();
    const { pc, conn } = relayConn();
    const opening = waitForConnectionOpen(conn, 1000);
    pc.fail(
      `${RELAY_URL}?transport=tcp`,
      701,
      "Failed to establish connection",
    );
    vi.advanceTimersByTime(1000);
    const error: unknown = await opening.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).kind).toBe("transport");
    expect((error as Error).message).toBe(
      "The connection did not open: no relay candidate was gathered. The " +
        `browser reported an error for relay server ${RELAY_URL}?transport=tcp ` +
        "(error 701: Failed to establish connection). Check that the relay " +
        "address is correct and that this network allows connections to it, " +
        "then try again.",
    );
  });

  test("a timeout with the relay silent names the relay without an error", async () => {
    vi.useFakeTimers();
    const { conn } = relayConn();
    const opening = waitForConnectionOpen(conn, 1000);
    vi.advanceTimersByTime(1000);
    await expect(opening).rejects.toThrow(
      `Relay server ${RELAY_URL} did not give a relay address.`,
    );
  });

  test("an early close with the relay still gathering keeps its own error", async () => {
    const { fake, conn } = relayConn();
    const opening = waitForConnectionOpen(conn, 1000);
    fake.emit("close");
    await expect(opening).rejects.toThrow(/^connection closed before open$/);
  });

  test("an early close after a relay error names the relay", async () => {
    const { fake, pc, conn } = relayConn();
    const opening = waitForConnectionOpen(conn, 1000);
    pc.fail(RELAY_URL, 401, "Unauthorized");
    fake.emit("close");
    await expect(opening).rejects.toThrow(
      `relay server ${RELAY_URL} (error 401: Unauthorized)`,
    );
  });
});

describe("relayFailureMessage", () => {
  test("names each failed relay once and bounds how many it lists", () => {
    const { pc, conn } = relayConn([
      {
        urls: ["a", "b", "c", "d"].map((host) => `turn:${host}.example:3478`),
        username: "u",
        credential: "c",
      },
    ]);
    watchIceGathering(conn);
    for (const host of ["a", "a", "b", "c", "d"])
      pc.fail(
        `turn:${host}.example:3478`,
        701,
        "TURN allocate request timed out",
      );
    const record = iceGatheringRecordFor(conn);
    if (record === undefined) throw new Error("no record");
    const message = relayFailureMessage(record, true) ?? "";
    expect(message.match(/turn:a\.example/g)).toHaveLength(1);
    expect(message).toContain("turn:c.example");
    expect(message).not.toContain("turn:d.example");
    expect(message).toContain("and 1 more");
  });

  test("keeps at most the bounded number of errors", () => {
    const { pc, conn } = relayConn();
    watchIceGathering(conn);
    for (let index = 0; index < MAX_RECORDED_ICE_ERRORS + 5; index += 1)
      pc.fail(RELAY_URL, 701, `timed out ${String(index)}`);
    expect(iceGatheringRecordFor(conn)?.turnErrors).toHaveLength(
      MAX_RECORDED_ICE_ERRORS,
    );
  });

  test("records an error only for a configured relay url", () => {
    const { pc, conn } = relayConn();
    watchIceGathering(conn);
    pc.fail("turns:elsewhere.example:443", 701, "unconfigured");
    pc.fail(`${RELAY_URL}?transport=udp&x=1`, 701, "extra query");
    pc.fail(`${RELAY_URL}?transport=tcp`, 701, "configured");
    const record = iceGatheringRecordFor(conn);
    if (record === undefined) throw new Error("no record");
    expect(record.turnErrors.map((error) => error.url)).toEqual([
      `${RELAY_URL}?transport=tcp`,
    ]);
    const message = relayFailureMessage(record, true) ?? "";
    expect(message).toContain(
      `${RELAY_URL}?transport=tcp (error 701: configured)`,
    );
    expect(message).not.toContain("elsewhere.example");
    expect(message).not.toContain("x=1");
  });
});

describe("dialAsAcceptor with a relay configured", () => {
  /** `connect` gathers on the next microtask, as PeerJS does only after an
   * asynchronous offer. */
  class FakePeer extends EventEmitter {
    destroy = vi.fn();
    disconnect = vi.fn();
    constructor(private readonly gather: (pc: FakePeerConnection) => void) {
      super();
    }
    connect = vi.fn(() => {
      const pc = new FakePeerConnection([
        { urls: [RELAY_URL], username: "u", credential: "c" },
      ]);
      queueMicrotask(() => this.gather(pc));
      return new FakeConn(pc) as unknown as DataConnection;
    });
  }

  async function dialFailure(
    gather: (pc: FakePeerConnection) => void,
    timeouts: { openTimeoutMs: number; totalTimeoutMs?: number } = {
      openTimeoutMs: 20,
    },
  ): Promise<unknown> {
    const fake = new FakePeer(gather);
    const dialing = dialAsAcceptor(
      generateSharedSecret(),
      { channel: "webrtc", host: "127.0.0.1", port: 3000, path: "/api/" },
      {
        peerFactory: () => fake as unknown as Peer,
        ...timeouts,
      },
    ).catch((err: unknown) => err);
    await vi.waitFor(() =>
      expect(fake.listenerCount("open")).toBeGreaterThan(0),
    );
    fake.emit("open", "acceptor");
    return dialing;
  }

  test("an attempt timeout with the relay healthy keeps its wording", async () => {
    const error = await dialFailure((pc) => pc.gather("relay"));
    expect((error as Error).message).toBe(
      "timed out opening a connection to the inviter",
    );
  });

  test("an attempt timeout after a relay error names the relay", async () => {
    const error = await dialFailure((pc) =>
      pc.fail(RELAY_URL, 701, "TURN host lookup received error."),
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain(
      `relay server ${RELAY_URL} (error 701: TURN host lookup received error.)`,
    );
  });

  test("an attempt clamped by the total budget does not blame a silent relay", async () => {
    const error = await dialFailure(() => undefined, {
      openTimeoutMs: 1000,
      totalTimeoutMs: 20,
    });
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe(
      "timed out opening a connection to the inviter",
    );
  });

  test("an attempt that runs the full open timeout names a silent relay", async () => {
    const error = await dialFailure(() => undefined);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain(
      `Relay server ${RELAY_URL} did not give a relay address.`,
    );
  });
});
