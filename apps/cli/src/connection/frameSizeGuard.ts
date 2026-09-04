import { Writable } from "node:stream";

import { FrameSizeExceededError } from "@psilink/core";

import { fittedCauseLink } from "./causeLink";
import {
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
} from "./sftpLivenessGuard";

/**
 * Frame-size enforcement shared by the file-transport adapters
 * ({@link ../connection/localFSClient.LocalFSClient | LocalFSClient} and
 * {@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}): an inbound
 * file larger than the cap is refused with a {@link FrameSizeExceededError}
 * before an unbounded buffer can be allocated. Why the two adapters differ:
 * docs/spec/CHANNEL_SECURITY.md, "Inbound frame-size bound".
 */

const INBOUND_FILE_LINK_LABEL = "inbound file: ";

/**
 * Construct the canonical typed, terminal error for an over-cap inbound
 * file. Pass `observedBytes` when known up front (LocalFSClient's fstat);
 * omit it on the streaming path, where only "crossed the cap" is known.
 * `path` is fitted into its own labelled cause link via
 * {@link ./causeLink.fittedCauseLink} rather than composed into the
 * summary, so a hostile server's arbitrarily wide filename is bounded to a
 * value's budget, not the renderer's whole-message one. Why: docs/spec/
 * CHANNEL_SECURITY.md, "Display sanitization escape format".
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
    `an inbound file ${detail}; refusing to read it into memory`,
    { details: [fittedCauseLink(INBOUND_FILE_LINK_LABEL, path)] },
  );
}

export interface CappedSink {
  /** Writable to hand to ssh2-sftp-client's `get(path, sink)`. */
  sink: Writable;
  /**
   * Resolves with the concatenated under-cap bytes once
   * {@link CappedSink.complete} is called; rejects with a
   * {@link FrameSizeExceededError} once the running total crosses the cap,
   * or a {@link TransportOperationStalledError} if the transfer goes idle
   * past the stall deadline.
   *
   * Settled from within the sink itself, not from how ssh2-sftp-client's
   * own `get()` promise resolves: that promise settles through two
   * listeners on different streams -- the read stream's 'end' event vs.
   * the sink's 'error' event -- which race for a file finishing in one or
   * two chunks.
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
 * Build a counting sink that bounds an inbound stream by size and by
 * liveness: bytes past `maxBytes` are counted but never retained, and an
 * idle timer (armed before the first chunk, reset on each chunk) tears the
 * transfer down after `stallDeadlineMs` of silence, defaulting to
 * {@link SFTP_STALL_DEADLINE_MS}. Rationale for both bounds: docs/spec/
 * CHANNEL_SECURITY.md, "Inbound frame-size bound" and "Per-operation
 * liveness bounds".
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

  // Idle/no-progress deadline. Re-armed on each chunk and cleared on every
  // terminal path; on expiry it settles `result` and destroys the sink.
  // `sink` is referenced only from the timer callback, which can fire only
  // after sink construction below.
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
      // Destroy WITH an error, not bare: a bare destroy() emits 'close', not
      // 'error', risking the server-side read left running until session
      // teardown -- a reading of ssh2-sftp-client's behavior, not a
      // measurement; driven instead by frameSizeGuard.test.ts, "the idle
      // stall tears down the upstream read stream, not just the sink".
      // This Error only aborts the transfer at the server: the typed error
      // is already on `result`, and the resulting get() rejection lands on
      // the no-op `fail`.
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
