import { Writable } from "node:stream";

import { FrameSizeExceededError } from "@psilink/core";

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
 *    under-reports a file's size in its directory listing.
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
   * {@link FrameSizeExceededError} the instant the running total crosses the cap.
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
 * Build a counting sink that bounds an inbound stream to `maxBytes`. Bytes past
 * the cap are counted but never retained, so the buffer it accumulates never
 * exceeds roughly `maxBytes`. On crossing the cap it (a) rejects
 * {@link CappedSink.result} with a {@link FrameSizeExceededError} at the point
 * of detection and (b) fails the write callback so ssh2-sftp-client destroys
 * the read stream and aborts the transfer at the server.
 */
export function createCappedSink(path: string, maxBytes: number): CappedSink {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  let resolveResult!: (buf: Buffer<ArrayBufferLike>) => void;
  let rejectResult!: (err: unknown) => void;
  const result = new Promise<Buffer<ArrayBufferLike>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
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

  return {
    sink,
    result,
    complete: () => {
      if (settled) return;
      settled = true;
      resolveResult(Buffer.concat(chunks) as Buffer<ArrayBufferLike>);
    },
    fail: (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectResult(err);
    },
  };
}
