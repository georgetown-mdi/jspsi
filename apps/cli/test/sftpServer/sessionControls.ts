import type { SftpSessionControls } from "./types";

/**
 * The slice of an ssh2 server {@link import("ssh2").Connection} the session
 * controls need: the ability to terminate it. Narrowing to this lets the hub be
 * driven by a stub in its own unit test, with no live SSH connection.
 */
export interface DroppableConnection {
  /** Terminate the SSH connection, modelling the partner server's session cut. */
  end(): void;
}

/**
 * The slice of a connection's transport socket the withheld-close control
 * reaches: the two methods that would otherwise close it from the server side.
 * Narrowing to this lets the hub be driven by a stub in its own unit test, with
 * no live socket.
 */
export interface ClosableSocket {
  end(...args: unknown[]): unknown;
  destroy(...args: unknown[]): unknown;
}

/**
 * A connection's transport socket as the accept-time controls reach it: the two
 * closers the withheld-close control replaces, plus the one write the
 * stalled-handshake control replaces (every server-side byte of the SSH
 * identification exchange and key exchange goes through it).
 */
export interface ControlledSocket extends ClosableSocket {
  write(...args: unknown[]): unknown;
}

/**
 * SFTP request opcodes the in-process backend serves. Each arriving request of
 * one of these types counts as a single session operation for the op-count cap
 * and the one-shot op drop; the backend registers a counting listener per opcode
 * alongside its real handler.
 */
export const COUNTED_SFTP_OPS = [
  "OPEN",
  "READ",
  "WRITE",
  "FSTAT",
  "CLOSE",
  "OPENDIR",
  "READDIR",
  "STAT",
  "LSTAT",
  "REMOVE",
  "RENAME",
  "MKDIR",
  "RMDIR",
  "REALPATH",
] as const;

interface TrackedSession {
  opsServed: number;
  dropped: boolean;
  lifetimeTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The public {@link SftpSessionControls} surface plus the server-side wiring the
 * in-process backend invokes as connections come and go. A test sees only the
 * public surface on the server handle; the wiring methods are called only by the
 * backend.
 */
export interface SftpSessionControlHub extends SftpSessionControls {
  /**
   * Apply the withheld-close and stalled-handshake controls to a newly accepted
   * connection's socket, before any SSH traffic runs on it. A no-op while both
   * controls are off, and when the backend cannot reach the socket.
   */
  onConnectionAccepted(socket: ControlledSocket | undefined): void;
  /** Record a completed SSH handshake and begin tracking the connection. */
  onConnectionReady(conn: DroppableConnection): void;
  /** Count one SFTP operation on a tracked connection, applying the op caps. */
  recordOp(conn: DroppableConnection): void;
  /** Stop tracking a connection and cancel its pending drops. */
  releaseConnection(conn: DroppableConnection): void;
}

/**
 * Create a session-control hub. Every cap starts disabled, no drop is armed, and
 * closes are not withheld, so a backend that exposes the hub to a suite that
 * never touches it behaves exactly as before.
 *
 * @internal exported for the in-process backend and its own unit test
 */
export function createSftpSessionControls(): SftpSessionControlHub {
  const sessions = new Map<DroppableConnection, TrackedSession>();
  // Sockets the withheld-close control has silenced, against the real methods it
  // replaced, so stopWithholdingCloses can hand them back.
  const withheldSockets = new Map<
    ClosableSocket,
    { end: ClosableSocket["end"]; destroy: ClosableSocket["destroy"] }
  >();
  // The same, for the sockets the stalled-handshake control has muted, so
  // stopStallingHandshakes can hand their write back.
  const stalledSockets = new Map<
    ControlledSocket,
    { write: ControlledSocket["write"] }
  >();
  let handshakes = 0;
  let activeConnection: DroppableConnection | undefined;
  let oneShotOpsRemaining = 0;
  let pendingMsTarget: DroppableConnection | undefined;
  let pendingMsTimer: NodeJS.Timeout | undefined;

  // Claim the one-and-only drop of a session: returns it the first time, then
  // undefined, so overlapping caps or a late timer cannot double-end a
  // connection.
  const claimDrop = (conn: DroppableConnection): TrackedSession | undefined => {
    const session = sessions.get(conn);
    if (!session || session.dropped) return undefined;
    session.dropped = true;
    return session;
  };

  // Timer-driven drop: nothing is mid-request, so end the connection directly.
  const dropNow = (conn: DroppableConnection): void => {
    if (!claimDrop(conn)) return;
    try {
      conn.end();
    } catch {
      // already torn down
    }
  };

  // Op-driven drop: the op counter runs synchronously inside ssh2's poll-phase
  // packet dispatch, so defer the teardown to the check phase via setImmediate.
  // The drop is armed the moment the triggering op is counted; because that op's
  // own reply is written from a later async fs callback, the setImmediate can
  // fire first and pre-empt the reply -- a realistic mid-request cut, not a clean
  // between-ops boundary. The triggering op is not guaranteed to complete.
  const dropAfterCurrentOp = (conn: DroppableConnection): void => {
    if (!claimDrop(conn)) return;
    const handle = setImmediate(() => {
      try {
        conn.end();
      } catch {
        // already torn down
      }
    });
    handle.unref();
  };

  const armIdleTimer = (
    conn: DroppableConnection,
    session: TrackedSession,
    idleMs: number,
  ): void => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (idleMs <= 0) {
      session.idleTimer = undefined;
      return;
    }
    session.idleTimer = setTimeout(() => dropNow(conn), idleMs);
    session.idleTimer.unref();
  };

  const hub: SftpSessionControlHub = {
    maxLifetimeMs: 0,
    maxOps: 0,
    maxIdleMs: 0,
    withholdCloseOnDisconnect: false,
    stallHandshakeOnConnect: false,

    dropActiveAfterOps(ops: number): void {
      oneShotOpsRemaining = ops > 0 ? ops : 0;
    },

    dropActiveAfterMs(ms: number): void {
      if (pendingMsTimer) {
        clearTimeout(pendingMsTimer);
        pendingMsTimer = undefined;
        pendingMsTarget = undefined;
      }
      if (ms <= 0 || !activeConnection) return;
      const target = activeConnection;
      pendingMsTarget = target;
      pendingMsTimer = setTimeout(() => {
        pendingMsTimer = undefined;
        pendingMsTarget = undefined;
        dropNow(target);
      }, ms);
      pendingMsTimer.unref();
    },

    handshakeCount(): number {
      return handshakes;
    },

    resetHandshakeCount(): void {
      handshakes = 0;
    },

    onConnectionAccepted(socket: ControlledSocket | undefined): void {
      if (socket === undefined) return;
      if (hub.withholdCloseOnDisconnect && !withheldSockets.has(socket)) {
        withheldSockets.set(socket, {
          end: socket.end.bind(socket),
          destroy: socket.destroy.bind(socket),
        });
        // ssh2's server ends this socket itself when the client's DISCONNECT
        // arrives, so half-open alone does not keep it quiet: both closers have to
        // go. Reads still drain, so the connection serves traffic normally right up
        // to the disconnect it then ignores.
        socket.end = () => socket;
        socket.destroy = () => socket;
      }
      if (hub.stallHandshakeOnConnect && !stalledSockets.has(socket)) {
        stalledSockets.set(socket, { write: socket.write.bind(socket) });
        // Nothing the server produces reaches the wire, starting with its SSH
        // identification string, so the client's handshake cannot advance past
        // waiting for it. Reads still drain, so the TCP connection is genuinely
        // established and stays open -- what the client waits out is its own
        // connect deadline. `true` is write()'s "buffered, keep writing" answer,
        // so the server's own protocol code sees a healthy socket.
        socket.write = () => true;
      }
    },

    stopWithholdingCloses(): void {
      hub.withholdCloseOnDisconnect = false;
      for (const [socket, real] of withheldSockets) {
        socket.end = real.end;
        socket.destroy = real.destroy;
      }
      withheldSockets.clear();
    },

    stopStallingHandshakes(): void {
      hub.stallHandshakeOnConnect = false;
      for (const [socket, real] of stalledSockets) socket.write = real.write;
      stalledSockets.clear();
    },

    onConnectionReady(conn: DroppableConnection): void {
      handshakes += 1;
      activeConnection = conn;
      const session: TrackedSession = { opsServed: 0, dropped: false };
      sessions.set(conn, session);
      if (hub.maxLifetimeMs > 0) {
        session.lifetimeTimer = setTimeout(
          () => dropNow(conn),
          hub.maxLifetimeMs,
        );
        session.lifetimeTimer.unref();
      }
      armIdleTimer(conn, session, hub.maxIdleMs);
    },

    recordOp(conn: DroppableConnection): void {
      const session = sessions.get(conn);
      if (!session || session.dropped) return;
      session.opsServed += 1;
      // Re-read maxIdleMs each op so enabling or disabling the idle cap
      // mid-session takes effect from the next op, and each op resets the timer.
      armIdleTimer(conn, session, hub.maxIdleMs);
      if (hub.maxOps > 0 && session.opsServed >= hub.maxOps) {
        dropAfterCurrentOp(conn);
        return;
      }
      if (oneShotOpsRemaining > 0) {
        oneShotOpsRemaining -= 1;
        if (oneShotOpsRemaining === 0) dropAfterCurrentOp(conn);
      }
    },

    releaseConnection(conn: DroppableConnection): void {
      const session = sessions.get(conn);
      if (session) {
        if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
        if (session.idleTimer) clearTimeout(session.idleTimer);
      }
      sessions.delete(conn);
      if (activeConnection === conn) activeConnection = undefined;
      if (pendingMsTarget === conn) {
        if (pendingMsTimer) clearTimeout(pendingMsTimer);
        pendingMsTimer = undefined;
        pendingMsTarget = undefined;
      }
    },
  };

  return hub;
}
