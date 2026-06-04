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
 * - `closed`: a parked operation was cancelled by a deliberate local
 *   {@link MessageConnection.close} (e.g. a signal-driven shutdown). Nothing
 *   went wrong; it is distinct from `usage` so a clean shutdown is not
 *   mistaken for a programming error, and distinct from `transport` so it is
 *   not remapped to a peer-timeout diagnostic.
 */
export type ConnectionErrorKind =
  | "transport"
  | "security"
  | "usage"
  | "protocol"
  | "closed";

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

/**
 * Extracts a human-readable message from an arbitrary thrown value. The single
 * shared rule for turning an `unknown` error into display text: an `Error`'s
 * `message`, falling back to `String(err)` when that message is empty (so an
 * `Error` with no message yields `"Error"` rather than a blank string), and
 * `String(err)` for any non-`Error` value (so `null`/`undefined` become
 * `"null"`/`"undefined"` rather than throwing on a `.message` dereference).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || String(err) : String(err);
}

/**
 * Wraps an arbitrary thrown value as a {@link ConnectionError}, passing an
 * existing {@link ConnectionError} through unchanged. Shared by the bridges so
 * every transport classifies a raw transport failure the same way.
 */
export function asConnectionError(
  err: unknown,
  kind: ConnectionErrorKind,
): ConnectionError {
  if (err instanceof ConnectionError) return err;
  return new ConnectionError(errorMessage(err), kind, { cause: err });
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
   *
   * `timeoutMs` optionally bounds how long a parked receive waits for the next
   * message. The effective deadline is `min(connection-default inactivity,
   * timeoutMs)`: an override can only *shorten* the wait, never extend it past
   * the connection default (`undefined` on either side means "no bound from
   * that source"). On expiry the connection latches the same sticky terminal
   * `transport` {@link ConnectionError} the default inactivity deadline uses,
   * so every later call fails fast.
   */
  receive(timeoutMs?: number): Promise<unknown>;
  /** Tears down the transport. Idempotent; always resolves on a clean close. */
  close(): Promise<void>;
}

/** The transport's interface to push inbound events into the queue. */
export interface TransportControls {
  /**
   * Enqueue one inbound message (or hand it to a parked
   * {@link MessageConnection.receive}).
   */
  deliver: (message: unknown) => void;
  /** Latch a terminal error; idempotent after the first call. */
  fail: (error: ConnectionError) => void;
  /**
   * Half-close: latch a terminal error that surfaces only once any already
   * buffered messages have been drained by {@link MessageConnection.receive}.
   * If the queue is already empty it behaves exactly like {@link fail}. Use
   * for a clean remote close that may arrive with the peer's final frame still
   * queued, where {@link fail} would discard it. Idempotent once a terminal
   * state is reached.
   */
  finish: (error: ConnectionError) => void;
}

/** The transport-specific operations the queue drives. */
export interface TransportHooks {
  /**
   * Hands a message to the transport. Resolution means the message has been
   * accepted locally for delivery (buffered, or durably written), NOT that the
   * peer has received it - there is no acknowledgement at this layer. Code must
   * not infer peer receipt from this resolving; final-frame delivery is
   * guaranteed by the {@link TransportHooks.close} contract below - a durable
   * `send` or a flushing clean close, depending on the transport. See
   * docs/COMMUNICATION.md ("Message delivery and teardown").
   */
  send: (data: unknown) => void | Promise<void>;
  /**
   * Tears down the transport. `options.flush` is set on a deliberate clean
   * close ({@link MessageConnection.close}) and unset on error teardown (via
   * {@link TransportControls.fail}). A transport that buffers outbound writes
   * should drain them before closing when `flush` is set, so a final frame
   * still in flight is not lost, and close immediately otherwise; a transport
   * without an outbound buffer may ignore it.
   *
   * For a buffering transport this `flush` is the delivery contract's
   * load-bearing half: because {@link TransportHooks.send} resolves on local
   * hand-off, not on peer delivery, such a transport's final frame is
   * guaranteed only by the flush on a clean close. A transport whose `send` is
   * durable (its write outlives the connection) has nothing in flight and may
   * ignore `flush`. Every transport must satisfy one of these two; see
   * docs/COMMUNICATION.md ("Message delivery and teardown").
   */
  close: (options?: { flush?: boolean }) => void | Promise<void>;
  /**
   * Run once after wiring is complete; safe to call {@link TransportControls}
   * here.
   */
  start?: () => void;
}

type TransportConnect = (controls: TransportControls) => TransportHooks;

interface Waiter {
  resolve: (message: unknown) => void;
  reject: (error: ConnectionError) => void;
  // Per-receive deadline override (see MessageConnection.receive). Combined
  // with the connection default via min() when arming the idle timer.
  timeoutMs?: number;
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
  // Deferred terminal error from a half-close (finish): held while the queue
  // still has buffered frames and promoted to a real error by receive() once
  // the queue drains, so a clean remote close surfaces after its final frame.
  private pendingError: ConnectionError | undefined;
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
      finish: (error) => this.finish(error),
    });
    this.hooks.start?.();
  }

  private armIdle(): void {
    if (this.idleTimer !== undefined || this.waiters.length === 0) return;
    // Effective deadline = min(connection default, head waiter's override).
    // undefined on either side means "no bound from that source"; if both are
    // undefined there is no deadline to arm. Reading the head waiter (rather
    // than a single stored value) keeps this correct if more than one receive
    // is ever parked at once; lockstep callers only ever park one.
    const connectionMs = this.inactivityTimeoutMs;
    const overrideMs = this.waiters[0].timeoutMs;
    const ms =
      connectionMs === undefined
        ? overrideMs
        : overrideMs === undefined
          ? connectionMs
          : Math.min(connectionMs, overrideMs);
    if (ms === undefined) return;
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

  // deliver() is the consumer of FileSyncConnection's "data" event in
  // production (bridged via fromEventConnection's onData closure). It MUST NOT
  // throw synchronously on any failure mode it handles -- notably the inbound
  // overflow below, which latches a non-throwing fail() rather than throwing.
  // FileSyncConnection's retain-mode poll() advances recvSeq only after
  // emit("data", ...) returns, so a synchronous throw here would re-poll the
  // same never-deleted message until peer_timeout_ms (docs/FILE_SYNC.md I8).
  // messageConnection.test.ts pins this non-throwing contract.
  private deliver(message: unknown): void {
    // Once a half-close is pending, ignore further inbound: drain exactly what
    // was buffered at close time, then fail. PeerJS will not deliver after a
    // close, so this is belt-and-suspenders, but it keeps the half-closed
    // semantics crisp.
    if (this.error || this.closed || this.pendingError !== undefined) return;
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
          `inbound buffer overflow: at capacity (${this.capacity} unconsumed ` +
            "messages); the peer is sending out of turn",
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

  // Half-close: latch a terminal error to be surfaced only after the queue
  // drains. A genuine error uses fail() (discarding buffered frames is the
  // intended stance); a clean remote close that may have left the peer's final
  // frame queued uses this so receive() returns that frame before failing.
  private finish(error: ConnectionError): void {
    // Idempotent once a half-close is already pending: a second finish() (a
    // duplicate transport close, or a transport that finishes on both a close
    // and a timeout) must not overwrite the first deferred error. Mirrors the
    // pendingError guard in deliver().
    if (this.error || this.closed || this.pendingError !== undefined) return;
    if (this.queue.length > 0) {
      this.pendingError = error;
    } else {
      // Nothing buffered to drain (a parked waiter implies an empty queue), so
      // there is nothing to wait for: fail now, exactly like fail().
      this.fail(error);
    }
  }

  receive(timeoutMs?: number): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    // Drain buffered messages even after a clean close, but never after an
    // error: a latched error may mean the buffered data is untrustworthy.
    if (this.queue.length > 0) {
      const message = this.queue.shift();
      // The just-drained frame was the last one a half-close was waiting on, so
      // promote its deferred error through fail() (not a bare this.error
      // assignment) to keep terminated/hooks.close() in sync with every other
      // error path. The next receive() then rejects with it.
      if (this.queue.length === 0 && this.pendingError !== undefined) {
        const deferred = this.pendingError;
        this.pendingError = undefined;
        // fail() no-ops once closed, so a close() that raced ahead of this final
        // drain would otherwise drop the deferred error and leave the next
        // receive() reporting a generic close. Latch it directly in that case;
        // teardown already ran in close().
        if (this.closed) {
          this.error = deferred;
        } else {
          this.fail(deferred);
        }
      }
      return Promise.resolve(message);
    }
    if (this.closed)
      return Promise.reject(new ConnectionError("connection closed", "usage"));
    return new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ resolve, reject, timeoutMs });
      this.armIdle();
    });
  }

  async send(data: unknown): Promise<void> {
    if (this.error) throw this.error;
    // A half-close has latched a terminal error behind still-buffered inbound
    // frames; the peer is gone, so reject rather than write into the void.
    if (this.pendingError) throw this.pendingError;
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
    // A waiter parked before this deliberate close did nothing wrong, so reject
    // it as "closed" (a cancelled operation), not "usage" (caller misuse).
    this.rejectWaiters(new ConnectionError("connection closed", "closed"));
    // Deliberate close: ask the transport to drain buffered outbound writes
    // before tearing down. fail() closes without flush, since an error means
    // the link is already unusable.
    await this.hooks.close({ flush: true });
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
 * Minimal structural schema type accepted by {@link receiveParsed}: anything
 * with a `parse` method that returns the validated value or throws. Both Zod
 * schemas and hand-written validators satisfy it, so this helper does not pin a
 * specific Zod version.
 */
export interface ParseSchema<T> {
  parse(value: unknown): T;
}

/**
 * Awaits the next message on `conn` and validates it with `schema.parse`. On a
 * parse failure this always throws a {@link ConnectionError} of kind
 * `"protocol"` (the peer sent a frame that violates the message contract),
 * preserving the validator's error as the `cause`.
 *
 * No timeout argument: the connection's own inactivity deadline applies. This
 * is the shared receive-and-validate path for every consumer whose only
 * parse-failure response is "fail as a protocol violation". Sites that must run
 * a custom abort, or send an outbound frame before parsing, call
 * {@link MessageConnection.receive} and parse inline instead.
 */
export async function receiveParsed<T>(
  conn: MessageConnection,
  schema: ParseSchema<T>,
): Promise<T> {
  const raw = await conn.receive();
  try {
    return schema.parse(raw);
  } catch (e) {
    throw new ConnectionError(
      "received a message that failed schema validation",
      "protocol",
      { cause: e },
    );
  }
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
