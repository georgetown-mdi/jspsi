import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createSftpSessionControls,
  type ControlledSocket,
  type DroppableConnection,
} from "../../sftpServer/sessionControls";

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

  test("two armed mechanisms drop the connection exactly once", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxIdleMs = 30;
    controls.maxLifetimeMs = 50;
    controls.onConnectionReady(conn);
    vi.advanceTimersByTime(35); // idle cap fires first
    expect(end).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30); // lifetime cap fires, but the session is dropped
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("release clears the idle timer and a pending one-shot ms drop", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxIdleMs = 40;
    controls.onConnectionReady(conn);
    controls.dropActiveAfterMs(50);
    controls.releaseConnection(conn);
    vi.advanceTimersByTime(100);
    expect(end).not.toHaveBeenCalled();
  });

  test("clearing maxIdleMs mid-session disables the drop on the next op", () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.maxIdleMs = 50;
    controls.onConnectionReady(conn);
    vi.advanceTimersByTime(30);
    controls.maxIdleMs = 0;
    controls.recordOp(conn); // re-reads maxIdleMs and clears the idle timer
    vi.advanceTimersByTime(100);
    expect(end).not.toHaveBeenCalled();
  });
});

function stubSocket(): {
  socket: ControlledSocket;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  const destroy = vi.fn();
  const write = vi.fn(() => true);
  return { socket: { end, destroy, write }, end, destroy, write };
}

describe("SFTP session controls: withheld close", () => {
  test("an accepted socket keeps its real closers while the control is off", () => {
    const controls = createSftpSessionControls();
    const { socket, end, destroy } = stubSocket();
    controls.onConnectionAccepted(socket);
    socket.end();
    socket.destroy();
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("an armed control leaves an accepted connection unable to close itself", () => {
    const controls = createSftpSessionControls();
    const { socket, end, destroy } = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(socket);
    // Whatever the server does with the client's disconnect, nothing reaches the
    // wire: the client is left in half-close, waiting for a close that never comes.
    socket.end();
    socket.destroy();
    expect(end).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  test("the control governs connections accepted while it is set, not earlier ones", () => {
    const controls = createSftpSessionControls();
    const earlier = stubSocket();
    controls.onConnectionAccepted(earlier.socket);
    controls.withholdCloseOnDisconnect = true;
    const later = stubSocket();
    controls.onConnectionAccepted(later.socket);

    earlier.socket.end();
    later.socket.end();
    expect(earlier.end).toHaveBeenCalledTimes(1);
    expect(later.end).not.toHaveBeenCalled();
  });

  test("stopping hands the real closers back so a teardown can complete", () => {
    // The backend's stop() force-closes its tracked connections because
    // server.close() waits for them; a silenced socket would leave that wait
    // hanging, so this is what keeps teardown terminating.
    const controls = createSftpSessionControls();
    const { socket, end, destroy } = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(socket);
    controls.stopWithholdingCloses();

    socket.end();
    socket.destroy();
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("a socket accepted twice is silenced once, so stopping reaches the real closers", () => {
    const controls = createSftpSessionControls();
    const { socket, end } = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(socket);
    controls.onConnectionAccepted(socket);
    controls.stopWithholdingCloses();

    socket.end();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("stopping also disarms the control, so a later connection closes normally", () => {
    // Teardown typically dials once more (the pre-drain reconnect); leaving the
    // control armed would silence that connection in turn and hang the close that
    // follows it.
    const controls = createSftpSessionControls();
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(stubSocket().socket);
    controls.stopWithholdingCloses();

    const later = stubSocket();
    controls.onConnectionAccepted(later.socket);
    later.socket.end();
    expect(controls.withholdCloseOnDisconnect).toBe(false);
    expect(later.end).toHaveBeenCalledTimes(1);
  });

  test("an unreachable socket is tolerated rather than throwing", () => {
    const controls = createSftpSessionControls();
    controls.withholdCloseOnDisconnect = true;
    expect(() => controls.onConnectionAccepted(undefined)).not.toThrow();
  });
});

describe("SFTP session controls: stalled handshake", () => {
  test("an accepted socket keeps its real write while the control is off", () => {
    const controls = createSftpSessionControls();
    const { socket, write } = stubSocket();
    controls.onConnectionAccepted(socket);
    socket.write("SSH-2.0-x\r\n");
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("an armed control leaves an accepted connection unable to answer at all", () => {
    const controls = createSftpSessionControls();
    const { socket, write } = stubSocket();
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(socket);
    // Not one server byte reaches the wire, so the client's handshake cannot
    // advance past waiting for the identification string.
    expect(socket.write("SSH-2.0-x\r\n")).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  test("the control governs connections accepted while it is set, not earlier ones", () => {
    const controls = createSftpSessionControls();
    const earlier = stubSocket();
    controls.onConnectionAccepted(earlier.socket);
    controls.stallHandshakeOnConnect = true;
    const later = stubSocket();
    controls.onConnectionAccepted(later.socket);

    earlier.socket.write("x");
    later.socket.write("x");
    expect(earlier.write).toHaveBeenCalledTimes(1);
    expect(later.write).not.toHaveBeenCalled();
  });

  test("stopping hands the real write back and disarms the control", () => {
    const controls = createSftpSessionControls();
    const { socket, write } = stubSocket();
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(socket);
    controls.onConnectionAccepted(socket);
    controls.stopStallingHandshakes();

    socket.write("x");
    const later = stubSocket();
    controls.onConnectionAccepted(later.socket);
    later.socket.write("x");
    expect(controls.stallHandshakeOnConnect).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(later.write).toHaveBeenCalledTimes(1);
  });

  test("the stalled count follows the connections the control is holding", () => {
    const controls = createSftpSessionControls();
    expect(controls.stalledConnectionCount()).toBe(0);
    controls.onConnectionAccepted(stubSocket().socket);
    expect(controls.stalledConnectionCount()).toBe(0);

    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(stubSocket().socket);
    controls.onConnectionAccepted(stubSocket().socket);
    expect(controls.stalledConnectionCount()).toBe(2);

    controls.stopStallingHandshakes();
    expect(controls.stalledConnectionCount()).toBe(0);
  });

  test("a vanished session is not counted as a stalled connection", () => {
    const controls = createSftpSessionControls();
    const { conn } = stubConnection();
    controls.onConnectionReady(conn, stubSocket().socket);
    controls.vanishActiveSession();
    expect(controls.stalledConnectionCount()).toBe(0);
  });

  test("closing the stalled connections destroys them and leaves the stall armed", () => {
    const controls = createSftpSessionControls();
    const { socket, destroy } = stubSocket();
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(socket);
    controls.closeStalledConnections();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(controls.stallHandshakeOnConnect).toBe(true);
    const later = stubSocket();
    controls.onConnectionAccepted(later.socket);
    later.socket.write("x");
    expect(later.write).not.toHaveBeenCalled();
  });

  test("a closed stalled connection leaves the stalled count", () => {
    const controls = createSftpSessionControls();
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(stubSocket().socket);
    expect(controls.stalledConnectionCount()).toBe(1);
    controls.closeStalledConnections();
    expect(controls.stalledConnectionCount()).toBe(0);
  });

  test("closing the stalled connections reaches one whose closers are silenced", () => {
    const controls = createSftpSessionControls();
    const { socket, destroy } = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(socket);
    controls.closeStalledConnections();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("closing the stalled connections leaves a vanished session silent", () => {
    const controls = createSftpSessionControls();
    const { conn } = stubConnection();
    const { socket, destroy } = stubSocket();
    controls.onConnectionReady(conn, socket);
    controls.vanishActiveSession();
    controls.closeStalledConnections();

    expect(destroy).not.toHaveBeenCalled();
  });

  test("stopping one control leaves the other's hold on a socket in place", () => {
    // A socket accepted under both controls is silenced on both halves; stopping
    // one hands back only the half it took.
    const controls = createSftpSessionControls();
    const { socket, end, write } = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(socket);
    controls.stopStallingHandshakes();

    socket.write("x");
    socket.end();
    expect(write).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
  });
});

describe("SFTP session controls: vanished session", () => {
  const flushImmediate = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  test("a vanished session neither answers nor closes", () => {
    const controls = createSftpSessionControls();
    const { conn } = stubConnection();
    const { socket, end, destroy, write } = stubSocket();
    controls.onConnectionAccepted(socket);
    controls.onConnectionReady(conn, socket);
    // Nothing was armed beforehand and the client has asked for nothing: this
    // fires against a live session, unlike withholdCloseOnDisconnect.
    controls.vanishActiveSession();

    expect(socket.write("a reply the client never sees")).toBe(true);
    socket.end();
    socket.destroy();
    expect(write).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  test("restoring hands the real write and closers back", () => {
    const controls = createSftpSessionControls();
    const { conn } = stubConnection();
    const { socket, end, destroy, write } = stubSocket();
    controls.onConnectionReady(conn, socket);
    controls.vanishActiveSession();
    controls.restoreVanishedSessions();

    socket.write("x");
    socket.end();
    socket.destroy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("vanishing throws when no session is established", () => {
    const controls = createSftpSessionControls();
    expect(() => controls.vanishActiveSession()).toThrow(
      /no SSH session is currently established/,
    );
  });

  test("vanishing throws when the session's socket is unreachable", () => {
    // Silently doing nothing here would let "the client heard nothing" pass
    // against a server that was answering all along.
    const controls = createSftpSessionControls();
    controls.onConnectionReady(stubConnection().conn);
    expect(() => controls.vanishActiveSession()).toThrow(
      /transport socket is unreachable/,
    );
  });

  test("it targets the established session, leaving other sockets alone", () => {
    const controls = createSftpSessionControls();
    const earlier = stubSocket();
    controls.onConnectionReady(stubConnection().conn, earlier.socket);
    const later = stubSocket();
    controls.onConnectionReady(stubConnection().conn, later.socket);
    controls.vanishActiveSession();

    earlier.socket.write("x");
    later.socket.write("x");
    expect(earlier.write).toHaveBeenCalledTimes(1);
    expect(later.write).not.toHaveBeenCalled();
  });

  test("a cap that fires on a vanished session still reaches nobody", async () => {
    const controls = createSftpSessionControls();
    const { conn, end: connEnd } = stubConnection();
    const { socket, end, write } = stubSocket();
    controls.maxOps = 1;
    controls.onConnectionReady(conn, socket);
    controls.vanishActiveSession();
    controls.recordOp(conn);
    await flushImmediate();

    // The server both caps the session and never closes it cleanly: its own
    // teardown runs, and not a byte of it reaches the client.
    expect(connEnd).toHaveBeenCalledTimes(1);
    socket.write("x");
    socket.end();
    expect(write).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  test("restoring reaches a socket whose connection was already released", () => {
    // A capped session is released server-side while the client still hears
    // nothing, so the release cannot be what holds the restore.
    const controls = createSftpSessionControls();
    const { conn } = stubConnection();
    const { socket, end, write } = stubSocket();
    controls.onConnectionReady(conn, socket);
    controls.vanishActiveSession();
    controls.releaseConnection(conn);
    controls.restoreVanishedSessions();

    socket.write("x");
    socket.end();
    expect(write).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("either release order hands back the real methods, never a stub", () => {
    // Each replaced method is held in one place, so a socket both controls
    // silenced is restored by whichever release reaches it first and the other
    // cannot reinstate a stub over the real one.
    const withholdFirst = createSftpSessionControls();
    const a = stubSocket();
    withholdFirst.withholdCloseOnDisconnect = true;
    withholdFirst.onConnectionAccepted(a.socket);
    withholdFirst.onConnectionReady(stubConnection().conn, a.socket);
    withholdFirst.vanishActiveSession();
    withholdFirst.stopWithholdingCloses();
    withholdFirst.restoreVanishedSessions();

    a.socket.end();
    a.socket.write("x");
    expect(a.end).toHaveBeenCalledTimes(1);
    expect(a.write).toHaveBeenCalledTimes(1);

    const vanishFirst = createSftpSessionControls();
    const b = stubSocket();
    vanishFirst.withholdCloseOnDisconnect = true;
    vanishFirst.onConnectionAccepted(b.socket);
    vanishFirst.onConnectionReady(stubConnection().conn, b.socket);
    vanishFirst.vanishActiveSession();
    vanishFirst.restoreVanishedSessions();
    vanishFirst.stopWithholdingCloses();

    b.socket.end();
    b.socket.write("x");
    expect(b.end).toHaveBeenCalledTimes(1);
    expect(b.write).toHaveBeenCalledTimes(1);
  });

  test("stopping the stall control releases a vanished socket in full", () => {
    // The stall control and the vanish share one pool of muted sockets, so the
    // stop that unblocks a later dial reaches a session vanished on another
    // connection. Handing back only the write it finds there would leave that
    // socket answering again while still impossible to close.
    const controls = createSftpSessionControls();
    const stalled = stubSocket();
    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(stalled.socket);
    const vanished = stubSocket();
    controls.onConnectionReady(stubConnection().conn, vanished.socket);
    controls.vanishActiveSession();

    controls.stopStallingHandshakes();

    vanished.socket.write("x");
    vanished.socket.end();
    vanished.socket.destroy();
    expect(vanished.write).toHaveBeenCalledTimes(1);
    expect(vanished.end).toHaveBeenCalledTimes(1);
    expect(vanished.destroy).toHaveBeenCalledTimes(1);
    stalled.socket.write("x");
    expect(stalled.write).toHaveBeenCalledTimes(1);

    // The released socket is no longer vanished, so a control re-armed on it is
    // not silently disarmed by the next restore.
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(vanished.socket);
    controls.restoreVanishedSessions();
    vanished.socket.end();
    expect(vanished.end).toHaveBeenCalledTimes(1);
  });

  test("stopping the withheld-close control releases a vanished socket in full", () => {
    // The mirror image: the withheld-close control and the vanish share one pool
    // of silenced closers, and a socket left closable but mute is no more usable
    // a measurement than one left mute but closable.
    const controls = createSftpSessionControls();
    const silenced = stubSocket();
    controls.withholdCloseOnDisconnect = true;
    controls.onConnectionAccepted(silenced.socket);
    const vanished = stubSocket();
    controls.onConnectionReady(stubConnection().conn, vanished.socket);
    controls.vanishActiveSession();

    controls.stopWithholdingCloses();

    vanished.socket.write("x");
    vanished.socket.end();
    vanished.socket.destroy();
    expect(vanished.write).toHaveBeenCalledTimes(1);
    expect(vanished.end).toHaveBeenCalledTimes(1);
    expect(vanished.destroy).toHaveBeenCalledTimes(1);
    silenced.socket.end();
    expect(silenced.end).toHaveBeenCalledTimes(1);

    controls.stallHandshakeOnConnect = true;
    controls.onConnectionAccepted(vanished.socket);
    controls.restoreVanishedSessions();
    vanished.socket.write("y");
    expect(vanished.write).toHaveBeenCalledTimes(1);
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

describe("SFTP session controls: rename-tear staging", () => {
  test("a probe parked on a torn destination is released by that path's REMOVE", async () => {
    const controls = createSftpSessionControls();
    const { renameTear } = controls;
    renameTear.noteTorn("/psi/dir/id-29.json");

    let released = false;
    const parked = renameTear.waitForConsumption().then(() => {
      released = true;
    });
    // Another path's REMOVE is not this destination's consumption.
    renameTear.noteRemoved("/psi/dir/other.json");
    await Promise.resolve();
    expect(released).toBe(false);

    renameTear.noteRemoved("/psi/dir/id-29.json");
    await parked;
    expect(released).toBe(true);
    // Already consumed: a later probe of the same path is not parked at all.
    await expect(renameTear.waitForConsumption()).resolves.toBeUndefined();
  });

  test("reset disarms every flag and releases a probe nothing will consume", async () => {
    const controls = createSftpSessionControls();
    const { renameTear } = controls;
    renameTear.tearAfterRenameLands = true;
    renameTear.tearBeforeRenameLands = true;
    renameTear.consumeDestinationAtTear = true;
    renameTear.holdProbeUntilDestinationConsumed = true;
    renameTear.noteTorn("/psi/dir/id-29.json");
    const parked = renameTear.waitForConsumption();

    renameTear.reset();

    // A parked probe outliving its case would hold a reply for the whole run.
    await expect(parked).resolves.toBeUndefined();
    expect(renameTear.tearAfterRenameLands).toBe(false);
    expect(renameTear.tearBeforeRenameLands).toBe(false);
    expect(renameTear.consumeDestinationAtTear).toBe(false);
    expect(renameTear.holdProbeUntilDestinationConsumed).toBe(false);
    expect(renameTear.tornDestination).toBeUndefined();
  });

  test("tearing a session shares the one-drop claim with the caps", async () => {
    const controls = createSftpSessionControls();
    const { conn, end } = stubConnection();
    controls.onConnectionReady(conn);
    controls.dropActiveAfterOps(1);

    controls.tearSession(conn);
    expect(end).toHaveBeenCalledTimes(1);
    // The armed cap now has nothing left to end: a session is dropped once.
    controls.recordOp(conn);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(end).toHaveBeenCalledTimes(1);
  });
});
