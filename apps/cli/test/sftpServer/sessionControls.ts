import type {
  SftpRenameTearControls,
  SftpRequestMeter,
  SftpRequestMeterReading,
  SftpSessionControls,
} from "./types";

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
 * The slice of a connection's transport socket the silencing controls reach to
 * stop it closing: the two methods that would otherwise close it from the server
 * side. Narrowing to this lets the hub be driven by a stub in its own unit test,
 * with no live socket.
 */
interface ClosableSocket {
  end(...args: unknown[]): unknown;
  destroy(...args: unknown[]): unknown;
}

/**
 * A connection's transport socket as the silencing controls reach it: the two
 * closers plus the one write every server-side byte goes through, from the SSH
 * identification exchange to each SFTP reply.
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
  // The connection's transport socket, when the backend could reach it: what
  // vanishActiveSession silences on a session that is already established.
  socket?: ControlledSocket;
  lifetimeTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The request meter's per-SFTP-session half, handed to the backend when it
 * accepts an SFTP subsystem so arrivals and replies are matched by request id
 * within that session. Request ids are only unique per session, so each session
 * gets its own recorder rather than sharing one id space.
 */
export interface SftpSessionRequestRecorder {
  /** Note an arriving request of `op` holding request id `reqid`. */
  received(op: string, reqid: number): void;
  /** Note the reply being written for request id `reqid`. */
  answered(reqid: number): void;
  /** Drop this session's in-flight ids when its connection closes. */
  release(): void;
}

/**
 * The public {@link SftpRenameTearControls} surface plus the wiring the RENAME,
 * REMOVE, and STAT/LSTAT handlers invoke as they serve a staged tear.
 */
export interface SftpRenameTearControlHub extends SftpRenameTearControls {
  /** Record the destination of the RENAME a tear has just fired on. */
  noteTorn(virtualPath: string): void;
  /** Record a REMOVE, releasing any probe parked on that path. */
  noteRemoved(virtualPath: string): void;
  /**
   * Resolve once {@link SftpRenameTearControls.tornDestination} has been
   * REMOVEd, or at once when it already has been.
   */
  waitForConsumption(): Promise<void>;
}

/**
 * The public {@link SftpSessionControls} surface plus the server-side wiring the
 * in-process backend invokes as connections come and go. A test sees only the
 * public surface on the server handle; the wiring methods are called only by the
 * backend.
 */
export interface SftpSessionControlHub extends SftpSessionControls {
  renameTear: SftpRenameTearControlHub;
  /**
   * Open per-request accounting for one accepted SFTP session, feeding
   * {@link SftpSessionControls.requests}.
   */
  trackSftpSession(): SftpSessionRequestRecorder;
  /**
   * End the connection serving a staged rename tear. Shares the one-drop claim
   * with the caps, so a tear and an armed cap cannot both end one connection.
   */
  tearSession(conn: DroppableConnection): void;
  /**
   * Apply the withheld-close and stalled-handshake controls to a newly accepted
   * connection's socket, before any SSH traffic runs on it. A no-op while both
   * controls are off, and when the backend cannot reach the socket.
   */
  onConnectionAccepted(socket: ControlledSocket | undefined): void;
  /**
   * Record a completed SSH handshake and begin tracking the connection. The
   * socket is kept against the connection so a mid-exchange control can reach
   * the established session's transport; the hub tolerates a backend that cannot
   * supply it, and {@link SftpSessionControls.vanishActiveSession} then throws
   * rather than pretending to have silenced it.
   */
  onConnectionReady(
    conn: DroppableConnection,
    socket?: ControlledSocket | undefined,
  ): void;
  /** Count one SFTP operation on a tracked connection, applying the op caps. */
  recordOp(conn: DroppableConnection): void;
  /**
   * Note one `subsystem sftp` request the backend is leaving unanswered under
   * {@link SftpSessionControls.withholdSubsystemOpen}, feeding
   * {@link SftpSessionControls.withheldSubsystemOpenCount}.
   */
  recordWithheldSubsystemOpen(): void;
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
  // Sockets whose closers have been silenced, against the real methods they
  // replaced. Both the withheld-close control and the vanish control silence
  // closers; holding each socket's real pair in ONE place is what makes the
  // releases order-independent -- whichever runs first hands the real closers
  // back and the other finds nothing left to restore.
  const silencedSockets = new Map<
    ClosableSocket,
    { end: ClosableSocket["end"]; destroy: ClosableSocket["destroy"] }
  >();
  // The same, for the sockets whose write has been muted by the
  // stalled-handshake control or the vanish control.
  const mutedSockets = new Map<
    ControlledSocket,
    { write: ControlledSocket["write"] }
  >();
  // Sockets the vanish control has silenced. Membership only: the real methods
  // live in the two maps above. Kept independently of `sessions` so a vanished
  // connection that is then released -- by a cap ending it server-side, say --
  // can still be handed its real methods back.
  const vanishedSockets = new Set<ControlledSocket>();

  // Stop a socket ever closing itself. Reads still drain, so the connection
  // serves traffic normally; ssh2's server ends this socket itself when a
  // client's DISCONNECT arrives, so half-open alone does not keep it quiet and
  // both closers have to go.
  const silenceClosers = (socket: ClosableSocket): void => {
    if (silencedSockets.has(socket)) return;
    silencedSockets.set(socket, {
      end: socket.end.bind(socket),
      destroy: socket.destroy.bind(socket),
    });
    socket.end = () => socket;
    socket.destroy = () => socket;
  };

  const restoreClosers = (socket: ClosableSocket): void => {
    const real = silencedSockets.get(socket);
    if (!real) return;
    socket.end = real.end;
    socket.destroy = real.destroy;
    silencedSockets.delete(socket);
  };

  // Stop a socket ever writing. Nothing the server produces reaches the wire,
  // while reads still drain, so the TCP connection is established and
  // stays open. `true` is write()'s "buffered, keep writing" answer, so the
  // server's own protocol code sees a healthy socket.
  const muteWrites = (socket: ControlledSocket): void => {
    if (mutedSockets.has(socket)) return;
    mutedSockets.set(socket, { write: socket.write.bind(socket) });
    socket.write = () => true;
  };

  const restoreWrites = (socket: ControlledSocket): void => {
    const real = mutedSockets.get(socket);
    if (!real) return;
    socket.write = real.write;
    mutedSockets.delete(socket);
  };

  // Hand every vanished socket back both halves the vanish took. A vanish
  // mutes a socket's write and silences its closers in one act, drawing on
  // the same pools the withheld-close and stalled-handshake controls use, so
  // a release of either reaches a vanished socket too and must finish the
  // job -- half-released is neither the black hole a case measured nor a
  // real socket. Every release path ends here.
  const releaseVanished = (): void => {
    for (const socket of vanishedSockets) {
      restoreWrites(socket);
      restoreClosers(socket);
    }
    vanishedSockets.clear();
  };
  // Request-meter state. `inFlight` holds one reqid -> opcode map per live SFTP
  // session; the maps are cleared in place on reset() so a recorder keeps its
  // reference across windows.
  const inFlight = new Set<Map<number, string>>();
  let received = 0;
  let answered = 0;
  let outstanding = 0;
  let peakOutstanding = 0;
  const receivedByOp = new Map<string, number>();
  const answeredByOp = new Map<string, number>();
  const firstReceivedAtByOp = new Map<string, number>();
  const lastAnsweredAtByOp = new Map<string, number>();

  const requests: SftpRequestMeter = {
    read(): SftpRequestMeterReading {
      const spanMsByOp: Record<string, number> = {};
      for (const [op, first] of firstReceivedAtByOp) {
        const last = lastAnsweredAtByOp.get(op);
        if (last !== undefined) spanMsByOp[op] = last - first;
      }
      return {
        received,
        answered,
        outstanding,
        peakOutstanding,
        receivedByOp: Object.fromEntries(receivedByOp),
        answeredByOp: Object.fromEntries(answeredByOp),
        spanMsByOp,
      };
    },
    reset(): void {
      for (const pending of inFlight) pending.clear();
      received = 0;
      answered = 0;
      outstanding = 0;
      peakOutstanding = 0;
      receivedByOp.clear();
      answeredByOp.clear();
      firstReceivedAtByOp.clear();
      lastAnsweredAtByOp.clear();
    },
  };

  let handshakes = 0;
  let withheldSubsystemOpens = 0;
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

  // Probes parked by holdProbeUntilDestinationConsumed, released by the REMOVE of
  // the torn destination or by reset().
  let probeWaiters: Array<() => void> = [];
  let tornDestinationConsumed = false;
  const releaseProbes = (): void => {
    const waiting = probeWaiters;
    probeWaiters = [];
    for (const release of waiting) release();
  };

  const renameTear: SftpRenameTearControlHub = {
    tearAfterRenameLands: false,
    tearBeforeRenameLands: false,
    consumeDestinationAtTear: false,
    holdProbeUntilDestinationConsumed: false,
    refuseProbeOfTornDestination: false,
    preserveTornDestinationOnRemove: false,
    tornDestination: undefined,

    noteTorn(virtualPath: string): void {
      renameTear.tornDestination = virtualPath;
      tornDestinationConsumed = false;
    },

    noteRemoved(virtualPath: string): void {
      if (renameTear.tornDestination !== virtualPath) return;
      tornDestinationConsumed = true;
      releaseProbes();
    },

    waitForConsumption(): Promise<void> {
      if (tornDestinationConsumed) return Promise.resolve();
      return new Promise<void>((resolve) => probeWaiters.push(resolve));
    },

    reset(): void {
      renameTear.tearAfterRenameLands = false;
      renameTear.tearBeforeRenameLands = false;
      renameTear.consumeDestinationAtTear = false;
      renameTear.holdProbeUntilDestinationConsumed = false;
      renameTear.refuseProbeOfTornDestination = false;
      renameTear.preserveTornDestinationOnRemove = false;
      renameTear.tornDestination = undefined;
      tornDestinationConsumed = false;
      releaseProbes();
    },
  };

  const hub: SftpSessionControlHub = {
    renameTear,
    requests,
    maxLifetimeMs: 0,
    maxOps: 0,
    maxIdleMs: 0,
    withholdCloseOnDisconnect: false,
    stallHandshakeOnConnect: false,
    withholdSubsystemOpen: false,

    withheldSubsystemOpenCount(): number {
      return withheldSubsystemOpens;
    },

    recordWithheldSubsystemOpen(): void {
      withheldSubsystemOpens += 1;
    },

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

    tearSession(conn: DroppableConnection): void {
      dropNow(conn);
    },

    trackSftpSession(): SftpSessionRequestRecorder {
      const pending = new Map<number, string>();
      inFlight.add(pending);
      return {
        received(op: string, reqid: number): void {
          received += 1;
          outstanding += 1;
          if (outstanding > peakOutstanding) peakOutstanding = outstanding;
          receivedByOp.set(op, (receivedByOp.get(op) ?? 0) + 1);
          if (!firstReceivedAtByOp.has(op))
            firstReceivedAtByOp.set(op, Date.now());
          pending.set(reqid, op);
        },
        answered(reqid: number): void {
          const op = pending.get(reqid);
          // No entry means the request arrived before the current window began,
          // or its reply was written by a fault injection that bypassed the
          // backend's reply methods. Neither belongs to this window's counts.
          if (op === undefined) return;
          pending.delete(reqid);
          answered += 1;
          outstanding -= 1;
          answeredByOp.set(op, (answeredByOp.get(op) ?? 0) + 1);
          lastAnsweredAtByOp.set(op, Date.now());
        },
        release(): void {
          outstanding -= pending.size;
          pending.clear();
          inFlight.delete(pending);
        },
      };
    },

    handshakeCount(): number {
      return handshakes;
    },

    resetHandshakeCount(): void {
      handshakes = 0;
    },

    onConnectionAccepted(socket: ControlledSocket | undefined): void {
      if (socket === undefined) return;
      // The client's disconnect is served normally right up to the close this
      // then ignores.
      if (hub.withholdCloseOnDisconnect) silenceClosers(socket);
      // Muted as the connection is accepted, which is after ssh2 has written the
      // server's identification string and before its key exchange: the client
      // hears that one line and nothing after it, so its handshake cannot
      // advance and the dial waits out its own connect deadline.
      if (hub.stallHandshakeOnConnect) muteWrites(socket);
    },

    stopWithholdingCloses(): void {
      hub.withholdCloseOnDisconnect = false;
      for (const socket of [...silencedSockets.keys()]) restoreClosers(socket);
      // A vanished socket's closers are in that pool, so the loop above has just
      // half-released every vanished session; the rest of each release follows.
      releaseVanished();
    },

    stopStallingHandshakes(): void {
      hub.stallHandshakeOnConnect = false;
      for (const socket of [...mutedSockets.keys()]) restoreWrites(socket);
      // The same on the muted half: a vanish mutes as well as silences, so this
      // loop reaches every vanished session too.
      releaseVanished();
    },

    stalledConnectionCount(): number {
      return [...mutedSockets.keys()].filter(
        (socket) => !vanishedSockets.has(socket),
      ).length;
    },

    closeStalledConnections(): void {
      for (const socket of [...mutedSockets.keys()]) {
        // A vanished socket is muted in this same pool, and closing it would
        // undo the half of the vanish that makes it a black hole.
        if (vanishedSockets.has(socket)) continue;
        // Through the real closer where one has been taken away, so a
        // connection accepted under the withheld-close control is closable here
        // even though its own server-side close is silenced.
        const real = silencedSockets.get(socket);
        if (real) real.destroy();
        else socket.destroy();
        // Out of the pool without restoreWrites: the socket is gone, and
        // handing back its real write would let a late server flush hit a
        // destroyed stream instead of the mute that was absorbing it.
        mutedSockets.delete(socket);
      }
    },

    vanishActiveSession(): void {
      if (!activeConnection) {
        throw new Error(
          "vanishActiveSession: no SSH session is currently established",
        );
      }
      const socket = sessions.get(activeConnection)?.socket;
      if (!socket) {
        throw new Error(
          "vanishActiveSession: the active session's transport socket is " +
            "unreachable, so nothing would be silenced",
        );
      }
      // Both halves make the black hole: muting alone leaves the server free to
      // close the connection, which the client would hear as an 'end'.
      muteWrites(socket);
      silenceClosers(socket);
      vanishedSockets.add(socket);
    },

    restoreVanishedSessions(): void {
      releaseVanished();
    },

    onConnectionReady(
      conn: DroppableConnection,
      socket?: ControlledSocket | undefined,
    ): void {
      handshakes += 1;
      activeConnection = conn;
      const session: TrackedSession = { opsServed: 0, dropped: false, socket };
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
