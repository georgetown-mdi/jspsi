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
 *   not remapped to a peer-timeout diagnostic. A clean *remote* close is
 *   deliberately not mapped here - it stays `transport`, and a future consumer
 *   needing to act on it should add a dedicated kind (e.g. `peer-closed`); see
 *   docs/COMMUNICATION.md ("Error handling") for the rationale.
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
  /**
   * Optional: bound the next inbound frame the underlying transport reads into
   * memory to `maxBytes`, replacing its static frame-size cap for subsequent
   * reads until cleared (`undefined` restores the default). Threaded straight
   * through any decorator to the transport read gate. The single-pass receiver
   * sets it to the per-exchange derived cap ({@link singlePassReplyByteCap})
   * before reading the reply, so the read gate refuses a frame larger than the
   * exchanged record counts imply. Absent on a transport that bounds its inbound
   * path another way (the WebRTC data channel, fixed at `MAX_WEBRTC_FRAME_BYTES`),
   * where the call is a no-op. See docs/spec/CHANNEL_SECURITY.md.
   */
  setInboundFrameCap?(maxBytes: number | undefined): void;
}

/** The transport's interface to push inbound events into the queue. */
export interface TransportControls {
  /**
   * Enqueue one inbound message (or hand it to a parked
   * {@link MessageConnection.receive}).
   */
  deliver: (message: unknown) => void;
  /**
   * Latch an abnormal terminal error and tear the transport down; idempotent
   * after the first call (a later {@link fail}/{@link finish} no-ops). A frame
   * already buffered when this fires is still drained by
   * {@link MessageConnection.receive} before the error surfaces (the
   * abnormal-tail rule); only frames that arrive after the latch are dropped.
   */
  fail: (error: ConnectionError) => void;
  /**
   * Half-close: latch a terminal error to surface once any buffered messages
   * have been drained by {@link MessageConnection.receive}, and tear the
   * transport down now so an abandoned half-close cannot leak it. If the queue
   * is already empty it behaves exactly like {@link fail}. Idempotent once any
   * terminal state is reached.
   *
   * Kept distinct from {@link fail} as a named transition - a clean remote
   * close versus an abnormal drop - so a future close-capable transport can map
   * its clean-close signal here. Behaviorally the two now converge: a buffered
   * frame is drained ahead of either terminal error, so a clean close arriving
   * with the peer's final frame still queued returns that frame first either
   * way.
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
  /**
   * Optional: forward a per-exchange inbound frame cap to the transport read
   * gate (see {@link MessageConnection.setInboundFrameCap}). A transport that
   * caps its inbound path another way omits it, making the connection's
   * `setInboundFrameCap` a no-op.
   */
  setInboundFrameCap?: (maxBytes: number | undefined) => void;
}

type TransportConnect = (controls: TransportControls) => TransportHooks;

interface Waiter {
  resolve: (message: unknown) => void;
  reject: (error: ConnectionError) => void;
  // Per-receive deadline override (see MessageConnection.receive). Combined
  // with the connection default via min() when arming the idle timer.
  timeoutMs?: number;
}

// One in-flight send()'s liveness guard: the ref'd timer bounding its transport
// hand-off and the rejecter that settles its awaited promise. A terminal
// transition rejects every guard (see failSends), so a hand-off that orphans
// exactly as the connection goes terminal cannot leave the awaited send()
// hanging with the timer swept but the promise unsettled.
interface SendGuard {
  timer: ReturnType<typeof setTimeout>;
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
 * The terminal lifecycle of a {@link QueuedMessageConnection} as a single
 * source of truth: `undefined` is the only non-terminal (open) state, and every
 * transition into one of these terminal states runs transport teardown
 * ({@link TransportHooks.close}) exactly once. Each method derives its terminal
 * behavior from this one field rather than from independently-maintained flags,
 * so a new terminal condition cannot leave a stale per-method guard behind.
 *
 * - `draining`: a half-close ({@link TransportControls.finish}) latched a
 *   deferred error while frames were still buffered; teardown has already run.
 *   {@link QueuedMessageConnection.receive} keeps draining the queue and the
 *   final drain promotes this to `failed`.
 * - `failed`: an abnormal terminal error ({@link TransportControls.fail}, a
 *   promoted `draining` error, or a failed send); `error` is surfaced by
 *   `receive`/`send` once the queue is drained.
 * - `closed`: a deliberate local {@link MessageConnection.close}.
 */
type TerminalState =
  | { readonly kind: "draining"; readonly error: ConnectionError }
  | { readonly kind: "failed"; readonly error: ConnectionError }
  | { readonly kind: "closed" };

/**
 * Core {@link MessageConnection} implementation: a bounded inbound FIFO plus a
 * single sticky {@link TerminalState}. A transport supplies its `send`/`close`
 * (and an optional `start`) via the `connect` callback, and pushes inbound
 * events through the {@link TransportControls} it receives. Used by both
 * {@link fromEventConnection} and {@link createMessagePipe}.
 */
export class QueuedMessageConnection implements MessageConnection {
  private readonly queue: Array<unknown> = [];
  private readonly waiters: Array<Waiter> = [];
  private readonly capacity: number;
  private readonly inactivityTimeoutMs: number | undefined;
  // Transport-supplied clause appended to the peer-silence inactivity error.
  // Kept here (rather than baked into the message) so the generic core layer
  // stays transport-agnostic: a caller that knows the transport supplies
  // guidance about likely causes (the file-sync CLI names probable
  // receiver-side faults), while a caller that supplies none -- e.g. the WebRTC
  // transport -- gets the bare diagnostic unchanged.
  private readonly inactivityHint: string | undefined;
  private readonly hooks: TransportHooks;
  // Single source of truth for the terminal lifecycle; undefined means open.
  // Every transition into a terminal state runs transport teardown exactly
  // once (see {@link TerminalState}).
  private state: TerminalState | undefined;
  // Armed while a receive() is parked with an empty queue; fires a terminal
  // transport failure if the peer stays silent past inactivityTimeoutMs.
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  // In-flight send()s, each with the ref'd timer bounding its transport hand-off
  // and the rejecter that settles its awaited promise. The idle timer above
  // covers only a parked receive(); this covers the sender's encrypt-then-send
  // window, where no receive() is parked, so a mid-exchange drop in that window
  // cannot let the event loop silently drain to exit 0. See sendWithLiveness. A
  // set (not a single handle) so a terminal path settles every in-flight send,
  // even though lockstep parks at most one at a time.
  private readonly pendingSends = new Set<SendGuard>();

  constructor(
    connect: TransportConnect,
    options?: {
      capacity?: number;
      inactivityTimeoutMs?: number;
      inactivityHint?: string;
    },
  ) {
    this.capacity = options?.capacity ?? DEFAULT_CAPACITY;
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs;
    this.inactivityHint = options?.inactivityHint;
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
            "gone silent" +
            // Append the transport's guidance, if any, as a trailing sentence;
            // a caller that supplies none gets the bare diagnostic unchanged.
            (this.inactivityHint !== undefined
              ? `. ${this.inactivityHint}`
              : ""),
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

  // Races the transport hand-off against the same inactivity budget that bounds
  // a parked receive(), so a mid-exchange drop in the sender's encrypt-then-send
  // window is surfaced as a terminal transport error rather than a silent exit
  // 0. The parked-receive idle timer does not cover this window: nothing is
  // parked while a send is in flight, so `armIdle` early-returns and no ref'd
  // handle holds the event loop open. The per-operation transport deadlines that
  // WOULD reject an orphaned write (the CLI SFTP adapter's 60 s bounds, the
  // core whole-exchange budget) are all `.unref()`'d by design, so with nothing
  // else ref'd the loop drains before any of them can fire and the process
  // exits 0 (see docs/spec/CHANNEL_SECURITY.md, "Whole-exchange budget").
  //
  // The fix is one ref'd timer held only while the hand-off is outstanding. It
  // holds the loop open, which lets a lower, faster `.unref()`'d per-operation
  // deadline fire first and reject the write with its transport-specific cause;
  // and it stands as the transport-agnostic backstop for any transport that has
  // no such per-op bound, rejecting the send itself on expiry so the awaited
  // call returns instead of orphaning. It settles the instant the hand-off
  // settles, and every terminal path (fail/finish/close via failSends) rejects
  // any still-outstanding send -- not merely clears its timer -- so a hand-off
  // orphaned exactly as the connection goes terminal cannot leave the awaited
  // send() hanging with the guard swept but the promise unsettled, and no timer
  // survives to keep a healthy process alive at teardown. No inactivityHint is
  // appended: that guidance is written for the receive-side peer-silence case
  // ("has sent nothing since"), which misdescribes a stalled outbound write.
  private sendWithLiveness(data: unknown): Promise<void> {
    const handoff = Promise.resolve(this.hooks.send(data));
    const ms = this.inactivityTimeoutMs;
    // No configured budget (the low-level QueuedMessageConnection used without a
    // deadline, e.g. createMessagePipe): no liveness bound, exactly as a parked
    // receive() gets none there.
    if (ms === undefined) return handoff;
    return new Promise<void>((resolve, reject) => {
      const guard: SendGuard = {
        timer: setTimeout(() => {
          this.pendingSends.delete(guard);
          reject(
            new ConnectionError(
              `the transport did not accept an outbound message within ` +
                `${ms}ms; the connection to the peer appears to have been lost ` +
                "during the exchange",
              "transport",
            ),
          );
        }, ms),
        reject,
      };
      this.pendingSends.add(guard);
      handoff.then(
        (value) => {
          this.settleSend(guard);
          resolve(value);
        },
        (err: unknown) => {
          this.settleSend(guard);
          reject(err);
        },
      );
    });
  }

  // Clear one send's guard when its own hand-off settles (resolved, or rejected
  // by the transport). delete() returning false means the guard timer already
  // fired, or a terminal path already swept it, so there is nothing to clear.
  private settleSend(guard: SendGuard): void {
    if (this.pendingSends.delete(guard)) clearTimeout(guard.timer);
  }

  // Reject every in-flight send with the terminal error and clear its guard.
  // Called by every terminal transition (fail/finish/close) so a hand-off still
  // outstanding when the connection goes terminal -- and orphaned, so its own
  // then() never fires -- has its awaited send() rejected here rather than left
  // hanging with the ref'd guard swept but the promise unsettled. The send-side
  // twin of rejectWaiters.
  private failSends(error: ConnectionError): void {
    const guards = this.pendingSends;
    if (guards.size === 0) return;
    for (const guard of [...guards]) {
      guards.delete(guard);
      clearTimeout(guard.timer);
      guard.reject(error);
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
  // same never-deleted message until peer_timeout_ms (docs/spec/FILE_SYNC.md I8).
  // messageConnection.test.ts pins this non-throwing contract.
  private deliver(message: unknown): void {
    // Ignore inbound once any terminal state is reached: a `draining` half-close
    // drains exactly what was buffered at close time and accepts nothing new,
    // while `failed`/`closed` accept nothing. PeerJS will not deliver after a
    // close, so for that transport this is belt-and-suspenders, but it keeps the
    // half-closed semantics crisp.
    if (this.state !== undefined) return;
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
    if (this.state !== undefined) return;
    this.state = { kind: "failed", error };
    this.disarmIdle();
    this.failSends(error);
    this.rejectWaiters(error);
    // Best-effort teardown; we are already failing, so swallow its outcome. No
    // flush: an error means the link is already unusable.
    void Promise.resolve(this.hooks.close()).catch(() => {});
  }

  // Half-close: latch a terminal error to be surfaced only after the queue
  // drains, so a clean remote close that may have left the peer's final frame
  // queued returns that frame before failing. fail() is the abnormal
  // counterpart; both tear the transport down at call time.
  private finish(error: ConnectionError): void {
    // Idempotent once any terminal state is reached: a second finish() (a
    // duplicate transport close, or a transport that finishes on both a close
    // and a timeout), or a fail()/close() that already ran, must not overwrite
    // the first transition.
    if (this.state !== undefined) return;
    if (this.queue.length === 0) {
      // Nothing buffered to drain (a parked waiter implies an empty queue), so
      // there is nothing to wait for: fail now, exactly like fail().
      this.fail(error);
      return;
    }
    // Frames remain buffered: hold them and the deferred error in `draining` for
    // receive() to drain, but tear the transport down now (F2). Eager teardown
    // means an abandoned half-close - never drained, never closed - cannot leak
    // the transport's listeners/channel. The deferred error is promoted to
    // `failed` by receive() once the queue empties; teardown does not run again.
    this.state = { kind: "draining", error };
    // A defensive no-op here (a non-empty queue implies no parked waiter, so the
    // idle timer cannot be armed), kept so every terminal transition uniformly
    // disarms idle and a future reachable-with-timer path stays correct.
    // Rejecting the in-flight sends is not defensive: a peer half-close can land
    // while this side still has a send in flight, and that send must reject (as
    // the deferred error) rather than hang -- the peer has gone, so it can never
    // complete.
    this.disarmIdle();
    this.failSends(error);
    // No flush: a half-close means the peer has gone, so there is nothing to
    // drain outbound to.
    void Promise.resolve(this.hooks.close()).catch(() => {});
  }

  receive(timeoutMs?: number): Promise<unknown> {
    // Drain already-arrived frames before surfacing any terminal state: a frame
    // that reached the queue before the connection went terminal is returned
    // ahead of the terminal error or close, uniformly across transports and
    // orderings (a clean half-close, an abnormal drop, or a capacity overflow).
    // Safe because deliver() only ever enqueues complete, parsed frames, and a
    // security/replay check runs at the protocol layer on this output, never as
    // a transport control latched behind a queued frame.
    if (this.queue.length > 0) {
      const message = this.queue.shift();
      // The just-drained frame was the last one a half-close was waiting on:
      // promote the deferred error to `failed`. Teardown already ran at finish()
      // time, so this is a pure state transition.
      if (this.state?.kind === "draining" && this.queue.length === 0) {
        this.state = { kind: "failed", error: this.state.error };
      }
      return Promise.resolve(message);
    }
    // Queue empty: surface the terminal state, if any. A deliberate close is a
    // usage error; `failed`/`draining` surface the latched/deferred error.
    if (this.state !== undefined) {
      return this.state.kind === "closed"
        ? Promise.reject(new ConnectionError("connection closed", "usage"))
        : Promise.reject(this.state.error);
    }
    return new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ resolve, reject, timeoutMs });
      this.armIdle();
    });
  }

  async send(data: unknown): Promise<void> {
    // Reject on any terminal state. A deliberate close is local misuse;
    // `failed`/`draining` surface the terminal error - the peer is gone (a
    // half-close has latched an error behind still-buffered inbound frames), so
    // reject rather than write into the void.
    if (this.state !== undefined) {
      if (this.state.kind === "closed")
        throw new ConnectionError(
          "cannot send on a closed connection",
          "usage",
        );
      throw this.state.error;
    }
    try {
      await this.sendWithLiveness(data);
    } catch (err) {
      const error = asConnectionError(err, "transport");
      this.fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    // Idempotent, and a no-op once any terminal state is reached: fail() and
    // finish() each already ran teardown, so re-running it - or overwriting
    // their error with a generic close - would be wrong. A close() during a
    // pending drain simply returns, leaving `draining` to promote its deferred
    // error on the final receive().
    if (this.state !== undefined) return;
    this.state = { kind: "closed" };
    this.disarmIdle();
    // A send or receive in flight when this deliberate close lands did nothing
    // wrong, so reject each as "closed" (a cancelled operation), not "usage"
    // (caller misuse). Rejecting the in-flight send -- rather than only clearing
    // its guard -- is what stops a cancelled exchange (e.g. a signal-driven close
    // arriving mid-send) from leaving an awaited send() hanging when its hand-off
    // orphans; it also releases the ref'd guard, so no timer holds the loop open
    // at teardown.
    const cancelled = new ConnectionError("connection closed", "closed");
    this.failSends(cancelled);
    this.rejectWaiters(cancelled);
    // Deliberate close: ask the transport to drain buffered outbound writes
    // before tearing down. fail() closes without flush, since an error means
    // the link is already unusable.
    await this.hooks.close({ flush: true });
  }

  // Forward a per-exchange inbound frame cap to the transport, when it supports
  // one. A transport that bounds its inbound path another way (the WebRTC data
  // channel) supplies no hook, so this is a no-op there -- the caller's
  // `setInboundFrameCap?.()` is optional precisely so it can degrade silently.
  setInboundFrameCap(maxBytes: number | undefined): void {
    this.hooks.setInboundFrameCap?.(maxBytes);
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
 *
 * `inactivityHint` is an optional transport-specific clause appended to that
 * peer-silence error. The bridge is transport-agnostic, so it carries no
 * guidance of its own; a caller that knows the transport (e.g. the file-sync
 * CLI naming likely receiver-side causes) supplies one, and a caller that omits
 * it gets the bare diagnostic.
 */
export function fromEventConnection(
  conn: Connection,
  options?: {
    capacity?: number;
    inactivityTimeoutMs?: number;
    inactivityHint?: string;
  },
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
        // Forward to the underlying transport only when it bounds its inbound
        // reads (file-sync); a transport without the method leaves this undefined,
        // so the connection's setInboundFrameCap no-ops. Bound to `conn` so the
        // method keeps its receiver when invoked through the hook.
        setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
      };
    },
    {
      capacity: options?.capacity,
      inactivityTimeoutMs:
        options?.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      inactivityHint: options?.inactivityHint,
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
 * Validates an already-received value with `schema.parse`, throwing a
 * {@link ConnectionError} of kind `"protocol"` (the peer sent a frame that
 * violates the message contract) on failure, preserving the validator's error
 * as the `cause`.
 *
 * This is the parse half of {@link receiveParsed}, factored out for the
 * send-before-parse sites that must receive a frame, send an acknowledgement,
 * then parse -- and so cannot fold the receive and the parse into one call.
 * Routing those sites through it means a malformed final frame surfaces the same
 * clean `"protocol"` error there as everywhere else, instead of the validator's
 * raw throw escaping bare -- including a Zod `RangeError` ("Invalid string
 * length") built over a pathological-count payload, the residual the
 * single-issue array bounds (utils/singleIssueArray.ts) forestall at the schema
 * but which this wrap classifies cleanly regardless.
 */
export function parseOrProtocolError<T>(
  schema: ParseSchema<T>,
  raw: unknown,
): T {
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
 * Awaits the next message on `conn` and validates it with `schema.parse`. On a
 * parse failure this always throws a {@link ConnectionError} of kind
 * `"protocol"` (the peer sent a frame that violates the message contract),
 * preserving the validator's error as the `cause`.
 *
 * No timeout argument: the connection's own inactivity deadline applies. This
 * is the shared receive-and-validate path for every consumer whose only
 * parse-failure response is "fail as a protocol violation". Sites that must run
 * a custom abort, or send an outbound frame before parsing, call
 * {@link MessageConnection.receive} and parse inline (via
 * {@link parseOrProtocolError}) instead.
 */
export async function receiveParsed<T>(
  conn: MessageConnection,
  schema: ParseSchema<T>,
): Promise<T> {
  return parseOrProtocolError(schema, await conn.receive());
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
