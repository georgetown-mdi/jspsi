import type { Connection } from "../types";

/**
 * Classifies a terminal {@link ConnectionError} so a consumer can decide how to
 * respond:
 * - `transport`: the link failed after the transport's own retries were
 *   exhausted (peer unreachable, dropped, inactivity timeout). Retrying the
 *   whole exchange is reasonable.
 * - `security`: an authentication/replay/ordering check failed. Must not be
 *   silently retried; surface it loudly as possible tampering.
 * - `usage`: the connection was misconfigured or used incorrectly (e.g. a send
 *   after close, a path shared by another session). The caller must fix
 *   something before retrying.
 * - `protocol`: the peer violated the message protocol (e.g. sent out of turn).
 */
export type ConnectionErrorKind =
  | "transport"
  | "security"
  | "usage"
  | "protocol";

/** A terminal connection failure, tagged with a {@link ConnectionErrorKind}. */
export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind;

  constructor(
    message: string,
    kind: ConnectionErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionError";
    this.kind = kind;
  }
}

/** Wraps an arbitrary thrown value as a {@link ConnectionError}. */
function asConnectionError(
  err: unknown,
  kind: ConnectionErrorKind,
): ConnectionError {
  if (err instanceof ConnectionError) return err;
  return new ConnectionError(
    err instanceof Error ? err.message : String(err),
    kind,
    { cause: err },
  );
}

/**
 * Pull-based transport abstraction. A consumer drives the conversation by
 * awaiting messages in order rather than registering listeners, so there is no
 * window in which an arriving message or error can be dropped. Errors surface
 * as a rejection of the awaited {@link receive}/{@link send}, or - if the
 * failure lands between awaits - as a sticky terminal state observed by the
 * next call.
 */
export interface MessageConnection {
  /**
   * Sends one message. Rejects if the connection is already in a terminal
   * state, or if the underlying transport send fails (which also makes the
   * connection terminal).
   */
  send(data: unknown): Promise<void>;
  /**
   * Resolves with the next message in order. Resolves immediately if one has
   * already arrived; otherwise parks until the next arrival. Rejects if the
   * connection enters (or has entered) a terminal error state, or once a clean
   * close has drained all buffered messages.
   */
  receive(): Promise<unknown>;
  /** Tears down the transport. Idempotent; always resolves on a clean close. */
  close(): Promise<void>;
}

/** Handle a transport hands to the queue to push inbound events. */
export interface TransportControls {
  /** Enqueue one inbound message (or hand it to a parked {@link MessageConnection.receive}). */
  deliver: (message: unknown) => void;
  /** Latch a terminal error; idempotent after the first call. */
  fail: (error: ConnectionError) => void;
}

/** The transport-specific operations the queue drives. */
export interface TransportHooks {
  send: (data: unknown) => void | Promise<void>;
  close: () => void | Promise<void>;
  /** Run once after wiring is complete; safe to call {@link TransportControls} here. */
  start?: () => void;
}

type TransportConnect = (controls: TransportControls) => TransportHooks;

interface Waiter {
  resolve: (message: unknown) => void;
  reject: (error: ConnectionError) => void;
}

// Generous upper bound on unconsumed inbound messages. A strictly lockstep
// protocol never holds more than one, so tripping this means the peer is
// sending out of turn; it exists only to bound memory against a misbehaving
// peer, not as a tuning knob.
const DEFAULT_CAPACITY = 1024;

// Maximum time a parked receive() will wait for the next inbound message
// before the connection is failed as a silent-peer transport drop. Applied by
// fromEventConnection so every real transport is protected by construction;
// the lower-level QueuedMessageConnection leaves it unset (no deadline) unless
// a caller opts in.
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;

/**
 * Core {@link MessageConnection} implementation: a bounded inbound FIFO plus a
 * sticky terminal-error latch. A transport supplies its `send`/`close` (and an
 * optional `start`) via the `connect` callback, and pushes inbound events
 * through the {@link TransportControls} it receives. Used by both
 * {@link fromEventConnection} and {@link createMessagePipe}.
 */
export class QueuedMessageConnection implements MessageConnection {
  private readonly queue: Array<unknown> = [];
  private readonly waiters: Array<Waiter> = [];
  private readonly capacity: number;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly hooks: TransportHooks;
  private error: ConnectionError | undefined;
  private closed = false;
  // Guards the single transport teardown shared by close() and fail().
  private terminated = false;
  // Armed while a receive() is parked with an empty queue; fires a terminal
  // transport failure if the peer stays silent past inactivityTimeoutMs.
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    connect: TransportConnect,
    options?: { capacity?: number; inactivityTimeoutMs?: number },
  ) {
    this.capacity = options?.capacity ?? DEFAULT_CAPACITY;
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs;
    this.hooks = connect({
      deliver: (message) => this.deliver(message),
      fail: (error) => this.fail(error),
    });
    this.hooks.start?.();
  }

  private armIdle(): void {
    const ms = this.inactivityTimeoutMs;
    if (ms === undefined) return;
    if (this.idleTimer !== undefined || this.waiters.length === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.fail(
        new ConnectionError(
          `no message received within ${ms}ms; the peer appears to have ` +
            "gone silent",
          "transport",
        ),
      );
    }, ms);
  }

  private disarmIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private rejectWaiters(error: ConnectionError): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) waiter.reject(error);
  }

  private deliver(message: unknown): void {
    if (this.error || this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      // A message just arrived: the peer is alive, so reset the idle clock,
      // re-arming only if another receive is still parked behind this one.
      this.disarmIdle();
      waiter.resolve(message);
      this.armIdle();
      return;
    }
    if (this.queue.length >= this.capacity) {
      this.fail(
        new ConnectionError(
          `inbound buffer overflow: more than ${this.capacity} unconsumed ` +
            "messages; the peer is sending out of turn",
          "protocol",
        ),
      );
      return;
    }
    this.queue.push(message);
  }

  private fail(error: ConnectionError): void {
    if (this.error || this.closed) return;
    this.disarmIdle();
    this.error = error;
    this.rejectWaiters(error);
    if (!this.terminated) {
      this.terminated = true;
      // Best-effort teardown; we are already failing, so swallow its outcome.
      void Promise.resolve(this.hooks.close()).catch(() => {});
    }
  }

  receive(): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    // Drain buffered messages even after a clean close, but never after an
    // error: a latched error may mean the buffered data is untrustworthy.
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed)
      return Promise.reject(new ConnectionError("connection closed", "usage"));
    return new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.armIdle();
    });
  }

  async send(data: unknown): Promise<void> {
    if (this.error) throw this.error;
    if (this.closed)
      throw new ConnectionError("cannot send on a closed connection", "usage");
    try {
      await this.hooks.send(data);
    } catch (err) {
      const error = asConnectionError(err, "transport");
      this.fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    this.disarmIdle();
    this.rejectWaiters(new ConnectionError("connection closed", "usage"));
    await this.hooks.close();
  }
}

/**
 * Bridges an existing event-based {@link Connection} into a pull-based
 * {@link MessageConnection}. The `data`/`error` listeners are attached for the
 * connection's whole lifetime, so - unlike per-phase listener registration -
 * there is no gap in which a message or error can be dropped. A pre-attach
 * buffered error (the gap `takeBufferedError` exists to cover) is drained once
 * on start.
 *
 * A parked {@link MessageConnection.receive} is bounded by an inactivity
 * deadline (default {@link DEFAULT_INACTIVITY_TIMEOUT_MS}, overridable via
 * `inactivityTimeoutMs`): if the peer sends nothing within the window the
 * connection fails as a `transport` error rather than hanging the exchange.
 */
export function fromEventConnection(
  conn: Connection,
  options?: { capacity?: number; inactivityTimeoutMs?: number },
): MessageConnection {
  return new QueuedMessageConnection(
    (controls) => {
      const onData = (data: unknown) => controls.deliver(data);
      const onError = (err: unknown) =>
        controls.fail(asConnectionError(err, "transport"));
      conn.on("data", onData);
      conn.on("error", onError);
      return {
        send: (data) => conn.send(data),
        close: () => {
          conn.removeListener("data", onData);
          conn.removeListener("error", onError);
          return conn.close();
        },
        start: () => {
          const buffered = conn.takeBufferedError();
          if (buffered !== undefined)
            controls.fail(asConnectionError(buffered, "transport"));
        },
      };
    },
    {
      capacity: options?.capacity,
      inactivityTimeoutMs:
        options?.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
    },
  );
}

/**
 * Creates a connected in-memory pair of {@link MessageConnection}s. Messages
 * sent on one side are delivered asynchronously to the other; closing one side
 * surfaces a `transport` {@link ConnectionError} on the other. Intended for
 * tests and local protocol exercises.
 */
export function createMessagePipe(options?: {
  capacity?: number;
}): [MessageConnection, MessageConnection] {
  const link: { a?: TransportControls; b?: TransportControls } = {};
  const peerClosed = () =>
    new ConnectionError("peer closed the connection", "transport");

  const a = new QueuedMessageConnection((controls) => {
    link.a = controls;
    return {
      send: (data) => {
        queueMicrotask(() => link.b?.deliver(data));
      },
      close: () => link.b?.fail(peerClosed()),
    };
  }, options);

  const b = new QueuedMessageConnection((controls) => {
    link.b = controls;
    return {
      send: (data) => {
        queueMicrotask(() => link.a?.deliver(data));
      },
      close: () => link.a?.fail(peerClosed()),
    };
  }, options);

  return [a, b];
}
