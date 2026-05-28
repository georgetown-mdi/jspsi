import log from "loglevel";

import { BufferingEventEmitter } from "@psilink/core";

import { waitForConnectionOpen } from "./waitForOpen";

import type { Connection } from "@psilink/core";
import type { DataConnection } from "peerjs";

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

/**
 * Wraps a PeerJS {@link DataConnection} to satisfy the core {@link Connection}
 * interface. Provides `takeBufferedError` semantics via {@link BufferingEventEmitter}:
 * an `error` emitted while no listener is registered is retained so the next
 * protocol-layer receive can detect failures that arrived in the gap between
 * listener-registration cycles.
 *
 * A `close` event from the underlying connection (remote peer closed or network
 * drop) is forwarded as an `error` so protocol-layer receives fail immediately
 * rather than waiting for the handshake timeout; the adapter then seals itself
 * so subsequent {@link send} calls throw. Intentional closure via {@link close}
 * calls `DataConnection.close()` and clears the error buffer; a remote close
 * does not call `DataConnection.close()` (the connection is already closing)
 * and preserves the buffered close-as-error so the protocol layer can observe
 * it via {@link takeBufferedError}.
 *
 * Use the static {@link open} factory rather than the constructor when the
 * connection may not yet be open; the constructor does not wait.
 */
export class DataConnectionAdapter
  extends BufferingEventEmitter<Events>
  implements Connection
{
  private conn: DataConnection;
  private closed = false;
  private onData: (data: unknown) => void;
  private onError: (err: unknown) => void;
  private onClose: () => void;

  constructor(conn: DataConnection) {
    super();
    this.conn = conn;

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

  /**
   * Waits for `conn` to open, then returns a new {@link DataConnectionAdapter}
   * wrapping it. Prefer this over `new DataConnectionAdapter(conn)` for any
   * connection that may not be open yet so that both the outgoing (initiator)
   * and incoming (responder) paths go through the same open-wait before the
   * adapter is used.
   */
  static open(
    conn: DataConnection,
    timeoutMs?: number,
  ): Promise<DataConnectionAdapter> {
    return waitForConnectionOpen(conn, timeoutMs).then(
      () => new DataConnectionAdapter(conn),
    );
  }

  // Adds the closed guard before delegating to BufferingEventEmitter. Reads
  // bufferedError before super.emit updates it so the log can show which prior
  // error was superseded.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
    if (this.closed) return false;
    const prevBuffered = this.bufferedError;
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners && prevBuffered !== undefined) {
      log.warn(
        "DataConnectionAdapter: superseding buffered error:",
        prevBuffered,
      );
    }
    return hadListeners;
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
