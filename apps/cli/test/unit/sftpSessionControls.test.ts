import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createSftpSessionControls,
  type DroppableConnection,
} from "../sftpServer/sessionControls";

// Unit coverage for the in-process SFTP harness's session-control hub -- the
// forced-drop, session-cap, and handshake-count capability -- driven directly
// against stub connections. This pins the capability's own API and timing
// semantics without the full SFTP integration bring-up (which is CI-only in the
// sandbox); the integration suite proves it against the live adapter.

function stubConnection(): {
  conn: DroppableConnection;
  end: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  return { conn: { end }, end };
}

describe("SFTP session controls: wall-clock caps and forced drops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("wall-clock lifetime cap drops a silent session with no traffic", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxLifetimeMs = 50;
    controls.onConnectionReady(conn);
    vi.advanceTimersByTime(40);
    expect(end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("a keepalive op cannot beat the wall-clock lifetime cap", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxLifetimeMs = 50;
    controls.onConnectionReady(conn);
    vi.advanceTimersByTime(40);
    controls.recordOp(conn); // traffic does not reset a lifetime cap
    vi.advanceTimersByTime(20);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("the idle cap resets on traffic, so a keepalive beats it", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxIdleMs = 50;
    controls.onConnectionReady(conn);
    vi.advanceTimersByTime(40);
    controls.recordOp(conn); // resets the idle timer
    vi.advanceTimersByTime(40);
    expect(end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20); // 60ms idle since the last op
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("a one-shot dropActiveAfterMs fires once on wall-clock", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.onConnectionReady(conn);
    controls.dropActiveAfterMs(50);
    vi.advanceTimersByTime(60);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("dropActiveAfterMs is a no-op with no established session", () => {
    const controls = createSftpSessionControls();
    controls.dropActiveAfterMs(50);
    expect(() => vi.advanceTimersByTime(60)).not.toThrow();
  });

  test("releasing a session cancels its pending lifetime cap", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxLifetimeMs = 50;
    controls.onConnectionReady(conn);
    controls.releaseConnection(conn);
    vi.advanceTimersByTime(60);
    expect(end).not.toHaveBeenCalled();
  });
});

describe("SFTP session controls: op counting and handshakes", () => {
  const flushImmediate = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  test("counts one handshake per session establishment and resets", () => {
    const controls = createSftpSessionControls();
    expect(controls.handshakeCount()).toBe(0);
    controls.onConnectionReady(stubConnection().conn);
    controls.onConnectionReady(stubConnection().conn);
    expect(controls.handshakeCount()).toBe(2);
    controls.resetHandshakeCount();
    expect(controls.handshakeCount()).toBe(0);
  });

  test("a standing op cap drops the session after N ops", async () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxOps = 3;
    controls.onConnectionReady(conn);
    controls.recordOp(conn);
    controls.recordOp(conn);
    expect(end).not.toHaveBeenCalled();
    controls.recordOp(conn);
    await flushImmediate();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("a one-shot dropActiveAfterOps fires once, then disarms", async () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.onConnectionReady(conn);
    controls.dropActiveAfterOps(2);
    controls.recordOp(conn);
    controls.recordOp(conn);
    await flushImmediate();
    expect(end).toHaveBeenCalledTimes(1);
    controls.recordOp(conn); // already dropped: no second drop
    await flushImmediate();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
