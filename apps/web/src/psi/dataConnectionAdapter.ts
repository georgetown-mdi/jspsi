import log from "loglevel";

import { default as EventEmitter } from "eventemitter3";

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

    conn.on("data", this.onData);
    conn.on("error", this.onError);
  }

  // Override emit so that an error fired with no listener is retained rather
  // than dropped. EventEmitter3 silently discards unhandled errors; buffering
  // them lets the next protocol-layer receive observe failures that occurred
  // in the gap between listener-registration cycles.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
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

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  send(data: unknown, chunked?: boolean): void | Promise<void> {
    return this.conn.send(data, chunked);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.off("data", this.onData);
    this.conn.off("error", this.onError);
    this.conn.close();
  }
}
