import { Writable } from "node:stream";

import { FrameSizeExceededError } from "@psilink/core";

import {
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
} from "./sftpLivenessGuard";

/**
 * Frame-size enforcement primitives shared by the file-transport adapters
 * ({@link ../connection/localFSClient.LocalFSClient | LocalFSClient} and
 * {@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}). Centralizing
 * them keeps a single, unit-tested definition of the security invariant: an
 * inbound file larger than the cap is refused with a typed, terminal
 * {@link FrameSizeExceededError} before an unbounded buffer can be allocated.
 *
 * The two adapters refuse at different moments, deliberately:
 *  - LocalFSClient fstats the open handle and refuses BEFORE allocating, so it
 *    needs only {@link frameSizeExceededError} (it never streams-and-counts; a
 *    local fstat is truthful, so an up-front size check is strictly better).
 *  - SSH2SFTPClientAdapter cannot trust a remote stat, so it streams through
 *    {@link createCappedSink}, which counts bytes and aborts once the running
 *    total crosses the cap. That sink is the backstop for a server that
 *    under-reports a file's size in its directory listing; it additionally
 *    bounds the transfer's liveness (a server that withholds data without ending
 *    the stream) via the idle deadline in {@link ./sftpLivenessGuard}.
 */

/**
 * Construct the canonical typed, terminal error for an over-cap inbound file.
 * Pass `observedBytes` when the exact size is known up front (LocalFSClient's
 * fstat); omit it on the streaming path, where only "crossed the cap" is known.
 */
export function frameSizeExceededError(
  path: string,
  maxBytes: number,
  observedBytes?: number,
): FrameSizeExceededError {
  const detail =
    observedBytes === undefined
      ? `exceeds the maximum frame size of ${maxBytes} bytes`
      : `is ${observedBytes} bytes, exceeding the maximum frame size of ` +
        `${maxBytes} bytes`;
  return new FrameSizeExceededError(
    `inbound file ${path} ${detail}; refusing to read it into memory`,
  );
}

export interface CappedSink {
  /** Writable to hand to ssh2-sftp-client's `get(path, sink)`. */
  sink: Writable;
  /**
   * Resolves with the concatenated under-cap bytes once {@link CappedSink.complete}
   * is called (the transfer finished without crossing the cap); rejects with a
   * {@link FrameSizeExceededError} the instant the running total crosses the cap,
   * or with a {@link TransportOperationStalledError} if the transfer goes idle
   * past the stall deadline (the liveness bound, for a server that withholds data
   * without ending the stream).
   *
   * The over-cap rejection is decided at the point of detection inside the
   * sink, NOT reconstructed from how the underlying `get()` promise settles.
   * ssh2-sftp-client settles a stream destination through two listeners on
   * different streams -- it resolves via the read stream's 'end' event but
   * rejects via the sink's 'error' event -- which race for a file that finishes
   * in one or two chunks. Settling this `result` from within the sink removes
   * that race: whichever way the library's promise lands, `result` already
   * carries the typed error.
   */
  result: Promise<Buffer<ArrayBufferLike>>;
  /**
   * Total bytes received from the server so far (the running count the cap is
   * checked against, including any counted-but-not-retained over-cap tail). Read
   * by the slow-operation warning as the cheap observed-progress signal for a
   * `get` that is taking a long time; it is observability only and never gates
   * the size or liveness bounds.
   */
  bytesReceived: () => number;
  /**
   * Mark the underlying transfer complete; resolves `result` with the buffered
   * bytes unless the cap already fired (in which case it is a no-op).
   */
  complete: () => void;
  /**
   * Mark the underlying transfer failed; rejects `result` with `err` unless it
   * has already settled (cap fired or completed).
   */
  fail: (err: unknown) => void;
}

/**
 * Build a counting sink that bounds an inbound stream by SIZE and by LIVENESS.
 * Bytes past `maxBytes` are counted but never retained, so the buffer it
 * accumulates never exceeds roughly `maxBytes`. On crossing the cap it (a)
 * rejects {@link CappedSink.result} with a {@link FrameSizeExceededError} at the
 * point of detection and (b) fails the write callback so ssh2-sftp-client
 * destroys the read stream and aborts the transfer at the server.
 *
 * Separately, `stallDeadlineMs` bounds liveness. A hostile (or dead) server can
 * hold the read stream open and withhold data, or trickle under-cap bytes
 * forever without ever ending, so the transfer never completes and `result`
 * never settles -- a hang the size cap cannot catch, since no allocation grows.
 * An idle timer, armed before the first chunk and reset on each chunk, fires when
 * no data arrives within the window: it rejects `result` with a
 * {@link TransportOperationStalledError} and destroys the sink so the stalled
 * transfer is torn down. Bounding the idle gap rather than the total transfer
 * time never rejects a slow-but-progressing read of a legitimately large frame.
 * Defaults to {@link SFTP_STALL_DEADLINE_MS}.
 */
export function createCappedSink(
  path: string,
  maxBytes: number,
  stallDeadlineMs: number = SFTP_STALL_DEADLINE_MS,
): CappedSink {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  let resolveResult!: (buf: Buffer<ArrayBufferLike>) => void;
  let rejectResult!: (err: unknown) => void;
  const result = new Promise<Buffer<ArrayBufferLike>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Idle/no-progress deadline (see the doc above). Re-armed on each chunk and
  // cleared on every terminal path; on expiry it settles `result` and destroys
  // the sink. `sink` is referenced only from the timer callback, which can fire
  // only after sink construction below.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectResult(
        transportOperationStalledError(
          "file read",
          path,
          `received no data for ${stallDeadlineMs} ms (the server withheld ` +
            `the transfer)`,
        ),
      );
      chunks.length = 0;
      // Destroy WITH an error, not bare. ssh2-sftp-client keys its upstream
      // read-stream teardown off the sink's 'error' event: get(path, dst) pipes
      // the read stream into the sink, rejects its promise on the sink's 'error',
      // and destroys the read stream only in that promise's `.finally`. A bare
      // destroy() emits 'close', not 'error', so get() never settles, `.finally`
      // never runs, and the server-side read keeps running -- the read stream
      // leaks until session teardown. The typed terminal error is already on
      // `result`; this plain Error exists only to abort the transfer at the
      // server, exactly as the over-cap path's failed write callback does. The
      // resulting get() rejection lands on the adapter's no-op `fail`.
      sink.destroy(new Error("inbound transfer stalled"));
    }, stallDeadlineMs);
    // The idle timer is the safety bound, not real work: it must never keep the
    // process alive on its own. Every terminal path clears it, so this only
    // matters if the program is winding down with a transfer still in flight.
    idleTimer.unref();
  };

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          clearTimeout(idleTimer);
          rejectResult(frameSizeExceededError(path, maxBytes));
        }
        // Release the buffered under-cap prefix now (up to ~maxBytes) rather
        // than holding it until the closure is GC'd; `result` has already
        // rejected, so the buffer is never read again.
        chunks.length = 0;
        // The callback error exists only to make ssh2-sftp-client abort and
        // destroy the read stream; the typed error is already on `result`.
        callback(new Error("inbound frame exceeds the maximum frame size"));
        return;
      }
      chunks.push(chunk);
      // Progress: the transfer is alive, so reset the idle deadline -- but only
      // while the read is still live. A chunk delivered after a terminal path
      // (the idle timer fired, or complete()/fail() ran) already settled
      // `result`; re-arming here would install a fresh timer that survives until
      // it fires into the no-op `settled` guard, a small leak with no effect.
      if (!settled) armIdle();
      callback();
    },
  });

  // Attach a no-op 'error' listener so a cap-fire -- which fails the write
  // callback and makes the Writable emit 'error' -- is never an unhandled event,
  // independent of whether or when the stream's reader attaches its own listener
  // (ssh2-sftp-client currently attaches one before piping, but that ordering is
  // not contractual). The real outcome is already on `result`; this only absorbs
  // the event.
  sink.on("error", () => {});

  // Arm before any data arrives so a server that opens the stream then sends
  // nothing is still bounded.
  armIdle();

  return {
    sink,
    result,
    bytesReceived: () => total,
    complete: () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      resolveResult(Buffer.concat(chunks) as Buffer<ArrayBufferLike>);
    },
    fail: (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      rejectResult(err);
    },
  };
}
