import { default as EventEmitter } from "eventemitter3";

/**
 * Event map shared by every {@link Connection} implementation: `data` carries a
 * parsed inbound message; `error` carries an asynchronous transport or security
 * failure surfaced from the poll/receive path. Synchronous failures (send,
 * synchronize) throw instead.
 */
export type ConnectionEvents = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

/**
 * `EventEmitter` base that retains an `error` emitted while no listener is
 * registered, instead of dropping it.
 *
 * eventemitter3 silently discards unhandled errors (unlike Node's
 * `EventEmitter`, which throws); buffering them lets the next protocol-layer
 * receive observe a failure that arrived in the gap between
 * listener-registration cycles, rather than stalling against a dead transport
 * until the peer timeout fires. Only the most recent unhandled error is
 * retained, since a later error supersedes the first as the proximate cause.
 *
 * Extracted as a shared base because this buffering is a security-relevant
 * invariant whose independent reimplementation is silent when it drifts: the
 * same pattern previously lived verbatim in three transports and the copies had
 * already diverged. Per the project convention for security primitives, the
 * single correct implementation lives here.
 */
export abstract class BufferedErrorEmitter extends EventEmitter<
  ConnectionEvents,
  never
> {
  private bufferedError: unknown;

  // Override emit so that an error fired with no listener is retained rather
  // than dropped. `super.emit` returns false when the event had no listeners.
  emit<E extends keyof ConnectionEvents>(
    event: E,
    ...args: Parameters<ConnectionEvents[E]>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      const incoming = args[0];
      if (this.bufferedError !== undefined) {
        this.onErrorSuperseded(this.bufferedError);
        // Chain the prior error as `cause` so a downstream walker can still
        // surface it. Gated on `cause === undefined` so a caller-set cause is
        // never overwritten, and on `incoming !== bufferedError` so a re-emit
        // of the same Error reference cannot create a self-referential cause
        // chain that loops a downstream walker.
        if (
          incoming instanceof Error &&
          incoming.cause === undefined &&
          incoming !== this.bufferedError
        ) {
          try {
            incoming.cause = this.bufferedError;
          } catch {
            /* error object is frozen; chain is best-effort. */
          }
        }
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  /**
   * Returns and clears the most recent error that was emitted with no listener
   * attached, or `undefined` if none is buffered.
   */
  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  /**
   * Hook invoked when a buffered error is about to be superseded by a newer
   * one. Default is a no-op; a transport with a logger overrides this to
   * surface the dropped error so a chained failure is not invisible.
   */
  protected onErrorSuperseded(_previous: unknown): void {}
}
