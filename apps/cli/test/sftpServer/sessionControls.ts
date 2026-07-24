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
  /** Record a completed SSH handshake and begin tracking the connection. */
  onConnectionReady(conn: DroppableConnection): void;
  /** Count one SFTP operation on a tracked connection, applying the op caps. */
  recordOp(conn: DroppableConnection): void;
  /** Stop tracking a connection and cancel its pending drops. */
  releaseConnection(conn: DroppableConnection): void;
}

/**
 * Create a session-control hub. Every cap starts disabled and no drop is armed,
 * so a backend that exposes the hub to a suite that never touches it behaves
 * exactly as before.
 *
 * @internal exported for the in-process backend and its own unit test
 */
export function createSftpSessionControls(): SftpSessionControlHub {
  const sessions = new Map<DroppableConnection, TrackedSession>();
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

  // Op-driven drop: defer past the current request's handler so the triggering
  // op still gets its reply and only the NEXT op meets a dropped session -- a
  // clean "drop after N ops" rather than a mid-handler teardown.
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
