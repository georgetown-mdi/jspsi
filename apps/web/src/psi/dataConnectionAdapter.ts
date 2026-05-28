import log from "loglevel";

import { default as EventEmitter } from "eventemitter3";

import { chainAsCause } from "@psilink/core";

import type { Connection } from "@psilink/core";
import type { DataConnection } from "peerjs";

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

/**
 * Wraps a PeerJS {@link DataConnection} to satisfy the core {@link Connection}
 * interface. Provides `takeBufferedError` semantics: an `error` emitted while
 * no listener is registered is retained so the next protocol-layer receive
 * can detect failures that arrived in the gap between listener-registration
 * cycles. Reading the buffer clears it; only the most recent unhandled error
 * is retained.
 *
 * A `close` event from the underlying connection (remote peer closed or network
 * drop) is forwarded as an `error` so protocol-layer receives fail immediately
 * rather than waiting for the handshake timeout; the adapter then seals itself
 * so subsequent {@link send} calls throw. Intentional closure via {@link close}
 * calls `DataConnection.close()` and clears the error buffer; a remote close
 * does not call `DataConnection.close()` (the connection is already closing)
 * and preserves the buffered close-as-error so the protocol layer can observe
 * it via {@link takeBufferedError}.
 */
export class DataConnectionAdapter
  extends EventEmitter<Events, never>
  implements Connection
{
  private conn: DataConnection;
  private bufferedError: unknown;
  private closed = false;
  private onData: (data: unknown) => void;
  private onError: (err: unknown) => void;
  private onClose: () => void;

  constructor(conn: DataConnection) {
    super();
    this.conn = conn;
    this.bufferedError = undefined;

    this.onData = (data: unknown) => {
      this.emit("data", data);
    };
    this.onError = (err: unknown) => {
      this.emit("error", err);
    };
    this.onClose = () => {
      this.emit("error", new Error("peer connection closed unexpectedly"));
      // Don't call conn.close() — the connection is already closing. The
      // buffered close-as-error is intentionally preserved so takeBufferedError
      // can surface it if no listener was registered at the time of the close.
      this.seal(false);
    };

    conn.on("data", this.onData);
    conn.on("error", this.onError);
    conn.on("close", this.onClose);
  }

  // Override emit so that an error fired with no listener is retained rather
  // than dropped. EventEmitter3 silently discards unhandled errors; buffering
  // them lets the next protocol-layer receive observe failures that occurred
  // in the gap between listener-registration cycles.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
    if (this.closed) return false;
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      // Only the most recent unhandled error is retained; a subsequent error
      // supersedes the first as the proximate cause. Chain the prior error as
      // `cause` when possible so downstream diagnostics can still surface it.
      const incoming = args[0];
      if (this.bufferedError !== undefined) {
        log.warn(
          "DataConnectionAdapter: superseding buffered error:",
          this.bufferedError,
        );
        chainAsCause(incoming, this.bufferedError);
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  /**
   * Returns the most recent error buffered while no listener was registered,
   * clearing it; returns `undefined` if none is buffered. See the class
   * description for the buffering semantics.
   */
  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  /**
   * Sends `data` over the underlying connection. Throws synchronously if the
   * adapter is closed, matching the {@link Connection} contract that
   * synchronous send failures throw, so a send to a peer that has already
   * dropped fails fast rather than being silently discarded.
   */
  send(data: unknown, chunked?: boolean): void | Promise<void> {
    if (this.closed) throw new Error("connection closed");
    return this.conn.send(data, chunked);
  }

  // Removes forwarding listeners, optionally closes the underlying connection,
  // and clears the error buffer when called as an intentional close. Idempotent.
  private seal(callConnClose: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (callConnClose) this.bufferedError = undefined;
    this.conn.off("data", this.onData);
    this.conn.off("error", this.onError);
    this.conn.off("close", this.onClose);
    if (callConnClose) this.conn.close();
  }

  /**
   * Detaches the forwarding listeners, closes the underlying connection, and
   * clears the error buffer. Idempotent: a second call is a no-op. The `close`
   * listener is removed before calling `DataConnection.close()` so an
   * intentional close does not surface as an error.
   */
  close(): void {
    this.seal(true);
  }
}
