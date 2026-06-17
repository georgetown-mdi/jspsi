import { Readable } from "node:stream";

import {
  TransportOperationStalledError,
  sanitizeForDisplay,
} from "@psilink/core";

/**
 * Liveness enforcement primitives shared by the SFTP adapter's server-driven
 * operations ({@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}'s
 * `list()`, `get()`, `createExclusive()`, and the write/stat/delete ops
 * `put()`/`rename()`/`delete()`/`exists()`). Every one of those awaits a callback
 * the remote server controls, so a hostile (or dead) server admin -- an adversary
 * under docs/spec/CHANNEL_SECURITY.md -- can hang it forever by
 * withholding the response. These helpers bound that wait and surface a single
 * typed, terminal {@link TransportOperationStalledError}, the liveness sibling of
 * the memory-size guards in {@link ./frameSizeGuard} and {@link ./listingGuard}:
 * those cap what a hostile file or directory can allocate; this caps the time a
 * hostile server can make an operation consume.
 *
 * These are the per-operation fast-fail layer for the SFTP adapter -- now covering
 * the write/stat/delete ops as well as the reads -- not the universal backstop.
 * Each operation is bounded by the mode its shape allows: the reads
 * (`list`/`get`/`createExclusive`) and the metadata write/stat/delete ops
 * (`rename`/`delete`/`exists`) by a wall-clock deadline
 * ({@link withSftpOperationDeadline}; `list`'s deadline is inlined alongside its
 * round-trip cap), and `put` by a progress-based idle window
 * ({@link createBoundedPutSource}) rather than a flat deadline, because a
 * legitimately large upload over a slow link can exceed 60 s while still making
 * progress -- the same reason the capped `get` sink bounds its idle gap rather than
 * its total time. The local-filesystem adapter has no per-operation bound here: it
 * is covered by the whole-exchange budget in `FileSyncConnection` (`@psilink/core`),
 * which races EVERY transport await -- reads, writes, and the local-filesystem path
 * alike -- against the coarse peer-inactivity budget, the universal backstop
 * beneath this tier. (An earlier framing held the local adapter's reads to a
 * trusted `fs.opendir`/`fs.stat` kernel that withholds nothing, but a stalled
 * NFS/CIFS hard mount breaks that premise; it gets the coarse whole-exchange bound
 * rather than these tight per-operation ones, which stay SFTP-only because only the
 * SFTP path has the server-driven callback this tier exists to catch quickly. The
 * filedrop connect path separately bounds `fs.access` with a timeout.)
 *
 * This module also holds the estimate-free, non-fatal slow-operation WARNING
 * ({@link withSlowOperationWarning}) -- observability, not a control, layered
 * strictly above all of the above and never inside a terminal path.
 */

/**
 * Wall-clock budget, in milliseconds, for a server response before an SFTP
 * operation is judged stalled. One constant covers the adapter's withheld-response
 * bounds, applied in the mode each operation allows: as a whole-operation deadline
 * for `list()` (catching an `opendir`/`readdir`/`close` callback that never fires),
 * `createExclusive()` (an open/close callback that never fires), the metadata
 * write/stat/delete ops `rename()`/`delete()`/`exists()` (each a single round-trip
 * whose callback never fires), and the rarely used uncapped `get()`; and as a
 * progress-reset idle window for the capped streaming `get()` (reset on each chunk
 * received) and for `put()` (reset on each chunk uploaded, via
 * {@link createBoundedPutSource}), so it bounds a transfer that goes silent rather
 * than one that is merely large. The streamed `list()` read additionally has a
 * round-trip cap ({@link ./listingGuard.MAX_LISTING_READDIR_BATCHES}) for the
 * empty-batch flood the deadline would otherwise catch only after the full budget;
 * the metadata ops have no such progress loop, so the deadline is their sole bound.
 *
 * Value: 60,000 ms (60 s). A coarse "the server has gone silent" threshold, not a
 * tight latency budget. It sits well above any legitimate operation -- a normal
 * listing, an exclusive lock-file create, a metadata rename/delete/exists, and
 * each chunk of a healthy transfer all complete in well under a second -- at
 * roughly twice this project's 30 s per-attempt connect bound
 * (`serverConnectTimeoutMs`, applied as ssh2's `readyTimeout` even when the
 * operator leaves it unset; ssh2's own default `readyTimeout` is 20 s), so a
 * transiently slow but live server is not cut off; yet more than an order of
 * magnitude below
 * the one-hour peer-inactivity budget, so a withheld response fails the exchange
 * in a minute rather than after an hour. Applied as an idle window it never
 * rejects a slow-but-progressing large transfer, only one that stops sending.
 * Fixed, not operator-configurable, for the same reason as the size bounds: a
 * configurable budget risks an operator raising it high enough to reintroduce the
 * denial of service.
 */
export const SFTP_STALL_DEADLINE_MS = 60_000;

/**
 * Construct the typed, terminal {@link TransportOperationStalledError} for an
 * SFTP operation that did not make progress within its bound. `operation` names
 * the read (e.g. `"directory listing"`, `"file read"`, `"exclusive create"`) and
 * `detail` states how it stalled, so the one error type carries an
 * operation-specific message.
 *
 * `path` is routed through {@link sanitizeForDisplay} before interpolation:
 * read/write/delete operation paths carry a peer-supplied filename, so a hostile
 * server could otherwise inject control/ANSI or deceptive-Unicode characters into
 * the operator's terminal through this diagnostic. (The operator-configured
 * rendezvous dirPath the listing-stall builders pass is not partner-controlled,
 * but routing every caller through the same escape keeps the treatment uniform.)
 */
export function transportOperationStalledError(
  operation: string,
  path: string,
  detail: string,
): TransportOperationStalledError {
  return new TransportOperationStalledError(
    `SFTP ${operation} of ${sanitizeForDisplay(path)} stalled: ${detail}; ` +
      `refusing to wait on the server further`,
  );
}

/**
 * Bound a server-driven SFTP operation by a wall-clock deadline: settles with
 * `promise`'s own result if it finishes first, otherwise rejects with
 * `makeError()` once `ms` elapses. The timer is cleared as soon as `promise`
 * settles.
 *
 * It mirrors `@psilink/core`'s `withTimeout` but differs in two ways that matter
 * here: it rejects with a caller-built typed error (a
 * {@link TransportOperationStalledError}, so the poll loop treats the stall as
 * terminal and fails the exchange) rather than a plain `Error`, and it takes an
 * error factory rather than a message string. Like `withTimeout` it only races --
 * the underlying operation's callbacks may still fire after the deadline (a
 * harmless no-op: no busy-spin, and the session tears down on the terminal
 * error). When the deadline wins, `promise` keeps running and may reject later
 * (the underlying operation eventually fails after the stall was already
 * surfaced); that late rejection has no other consumer, so a no-op `catch`
 * absorbs it rather than letting it surface as an unhandled rejection -- without
 * changing the race outcome, since the same `promise` settlement still feeds
 * `Promise.race`. The deadline timer is `unref`'d so it never holds the process
 * open on its own. A handle opened just before a withheld close is not reclaimed,
 * since a close whose own callback is withheld cannot itself complete; the
 * operations that hold a reusable handle past a stall
 * ({@link ./ssh2SftpAdapter}'s `list()`) close it on their own bounded-failure
 * path instead of relying on this wrapper.
 */
export function withSftpOperationDeadline<T>(
  promise: Promise<T>,
  ms: number,
  makeError: () => TransportOperationStalledError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
    timer.unref();
  });
  // Clear the timer whenever `promise` settles, whichever side won. A `promise`
  // that loses the race and then rejects would otherwise be an unhandled
  // rejection, so swallow it on a separate branch; this leaves the race result
  // untouched because `settled` itself is what Promise.race observes.
  const settled = promise.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

/**
 * Chunk size, in bytes, the bounded `put` source ({@link createBoundedPutSource})
 * slices its payload into so the upload yields a continuous, server-driven
 * progress signal.
 *
 * The signal must come from chunking. ssh2's SFTP write path acknowledges a single
 * `WriteStream` write only after EVERY internal WRITE packet it split that write
 * into has been acked -- `SFTP.write` chains the overflow and fires the stream
 * callback once, at the very end -- so handing the whole payload to the library as
 * one write would surface zero progress until the entire transfer completed, and a
 * legitimately large upload would then look identical to a stalled one for its full
 * duration. Feeding the payload as a stream of bounded chunks instead makes the
 * library's `rdr.pipe(wtr)` consume one chunk per ack-driven `drain`, so the source
 * is pulled (and the idle window reset) once per chunk acknowledged. The value is
 * the bound on how much may be acked between two progress ticks.
 *
 * Value: 64 KiB. Small enough that even a slow-but-honest link ticks well within
 * the 60 s idle window -- at 64 KiB per tick the window tolerates a sustained rate
 * as low as ~1 KiB/s before a progressing transfer could be false-failed -- and
 * large enough to keep the per-chunk pipe/WRITE overhead negligible against the
 * up-to-512 MiB frame size. Not security-critical to the byte: it sets the progress
 * granularity, not a memory or time bound (the idle window is the bound).
 */
export const SFTP_PUT_PROGRESS_CHUNK_BYTES = 64 * 1024;

/** The bounded `put` source returned by {@link createBoundedPutSource}. */
export interface BoundedPutSource {
  /**
   * The chunked {@link Readable} to hand to ssh2-sftp-client's `put(source, dest)`:
   * a non-Buffer, non-string src makes the library take its stream branch, piping
   * the source into the remote write stream.
   */
  source: Readable;
  /**
   * Resolves with the underlying `put()`'s value once {@link BoundedPutSource.complete}
   * is called (the upload finished), or rejects with a
   * {@link TransportOperationStalledError} the instant the upload makes no progress
   * for the idle window -- the liveness bound, for a server that withholds write
   * acknowledgement. Like the capped `get` sink, the stall outcome is decided here,
   * at the point of detection, not reconstructed from how the library's `put()`
   * promise settles.
   */
  result: Promise<unknown>;
  /**
   * Mark the underlying `put()` resolved; resolves `result` with its value unless
   * the idle window already fired (then a no-op).
   */
  complete: (value: unknown) => void;
  /**
   * Mark the underlying `put()` rejected; rejects `result` with `err` unless it has
   * already settled (idle window fired or completed).
   */
  fail: (err: unknown) => void;
}

/**
 * Build a chunked, progress-observing SOURCE that bounds an OUTBOUND SFTP `put` by
 * LIVENESS -- the write-path mirror of the read-path
 * {@link ./frameSizeGuard.createCappedSink}. The metadata write/stat/delete ops are
 * single round-trips, so a flat {@link withSftpOperationDeadline} bounds them;
 * `put` carries a payload whose legitimate transfer can exceed the deadline over a
 * slow link, so -- exactly as the capped `get` sink bounds its idle gap rather than
 * its total time -- this bounds the gap between upload-progress ticks instead.
 *
 * The source emits `payload` in `chunkBytes`-sized slices (views, not copies).
 * ssh2-sftp-client pipes it into the remote write stream, which pulls under
 * ack-driven backpressure: a withheld write acknowledgement stalls the pipe, so the
 * source stops being pulled. An idle timer, armed before the first chunk and reset
 * on each chunk produced, fires when no chunk has been pulled within
 * `stallDeadlineMs`: it rejects `result` with a {@link TransportOperationStalledError}
 * and destroys the source WITH an error, so ssh2-sftp-client's read-stream `'error'`
 * handler tears the write stream down at the server (a bare destroy would not).
 * Bounding the idle gap rather than the total upload time never false-fails a
 * slow-but-progressing large write, only one that stops making progress. The bound
 * also covers the tail -- the wait for the final ack and close -- since the last
 * chunk's timer is cleared only by `complete()`/`fail()`. Defaults to
 * {@link SFTP_STALL_DEADLINE_MS}.
 *
 * The source is single-use (a stream cannot be re-read); the caller rebuilds a
 * fresh one from the retained payload Buffer per retry attempt.
 */
export function createBoundedPutSource(
  path: string,
  payload: Buffer,
  chunkBytes: number = SFTP_PUT_PROGRESS_CHUNK_BYTES,
  stallDeadlineMs: number = SFTP_STALL_DEADLINE_MS,
): BoundedPutSource {
  let settled = false;
  let offset = 0;
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (err: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Idle/no-progress deadline (see the doc above). Re-armed on each chunk produced
  // and cleared on every terminal path; on expiry it settles `result` and destroys
  // the source. `source` is referenced only from the timer callback, which can fire
  // only after source construction below.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectResult(
        transportOperationStalledError(
          "file write",
          path,
          `made no upload progress for ${stallDeadlineMs} ms (the server ` +
            `withheld write acknowledgement)`,
        ),
      );
      // Destroy WITH an error, not bare. ssh2-sftp-client keys its write-stream
      // teardown off the source stream's 'error' event: _put attaches a 'error'
      // handler that rejects put(), and put()'s `.finally` destroys the write
      // stream. A bare destroy() emits 'close', not 'error', so the server-side
      // write would keep running -- it leaks until session teardown. The typed
      // terminal error is already on `result`; this plain Error exists only to
      // abort the transfer at the server, exactly as the capped sink's failed write
      // callback does. The resulting put() rejection lands on the adapter's no-op
      // `fail`.
      source.destroy(new Error("outbound transfer stalled"));
    }, stallDeadlineMs);
    // The idle timer is the safety bound, not real work: every terminal path clears
    // it, so unref'ing it only matters if the program is winding down with an upload
    // still in flight, where it must not block exit.
    idleTimer.unref();
  };

  const source = new Readable({
    // Hold roughly one chunk buffered so read() is paced by the write stream's
    // ack-driven consumption rather than racing far ahead of it.
    highWaterMark: chunkBytes,
    read() {
      // A stalled (and destroyed) source must not keep producing. destroy() already
      // makes read() a no-op; this also covers any settled-but-not-yet-destroyed
      // window.
      if (settled) return;
      if (offset >= payload.length) {
        // EOF: no more payload. This path does not re-arm the idle window, so the
        // last data chunk's timer stands until complete()/fail() clears it --
        // bounding the tail (the wait for the final ack and the write stream's
        // close) as well as the body.
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkBytes, payload.length);
      const chunk = payload.subarray(offset, end); // view, no copy
      offset = end;
      // This chunk is pulled under the write stream's ack-driven backpressure, so a
      // withheld ack stops read() being called; reset the idle window on each
      // produced chunk so a slow-but-progressing upload never trips it while a
      // no-progress one does.
      armIdle();
      this.push(chunk);
    },
  });

  // Absorb the 'error' from a stall-driven destroy regardless of whether
  // ssh2-sftp-client has attached its own source 'error' handler yet (it attaches
  // one synchronously before piping, but that ordering is not contractual). The
  // real outcome is already on `result`; this only absorbs the event.
  source.on("error", () => {});

  // Arm before any chunk is pulled so a server that opens the write stream then
  // never acks even the first write is still bounded.
  armIdle();

  return {
    source,
    result,
    complete: (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      resolveResult(value);
      // Tear the source down on every terminal path, as the idle-stall path
      // already does. On a clean completion the source has already reached EOF and
      // auto-destroyed, so this is an idempotent no-op; on fail() it was left
      // mid-stream -- ssh2-sftp-client destroys a string/file source on a
      // write-stream error but NOT a provided stream like this one -- so destroying
      // it here releases its stream-internal state and pipe linkage rather than
      // leaving it to GC. destroy() is idempotent and bare (emits no 'error'), so
      // it is safe after either settlement.
      source.destroy();
    },
    fail: (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      rejectResult(err);
      source.destroy();
    },
  };
}

/**
 * Elapsed time, in milliseconds, after which an in-flight SFTP operation that has
 * not yet settled emits a non-fatal slow-operation warning. This is OBSERVABILITY,
 * not a security control: it does nothing on a headless run with no human watching
 * (the whole-exchange liveness budget in `FileSyncConnection` (`@psilink/core`)
 * defends that run), and it stays entirely outside the terminal-error paths so it
 * can never affect correctness or the liveness gate. See
 * {@link withSlowOperationWarning}.
 *
 * Value: 30,000 ms (30 s). A fixed, deliberately generous threshold -- NOT a
 * duration estimate. A false warning is cheap (the operator reads "still working"
 * and ignores it), so it may be crude: it reports OBSERVED signal (the operation,
 * elapsed time, and any cheap progress) and lets the human supply the intent the
 * machine cannot, since a slow-but-honest transfer and a deliberately slow server
 * are observationally identical. It sits well above any healthy operation (a normal
 * listing, lock create, or small transfer completes in well under a second) yet
 * below the 60 s per-operation read fast-fail ({@link SFTP_STALL_DEADLINE_MS}), so
 * for a stalled read the operator sees one "slow" warning before the read fails;
 * for an unbounded-at-the-adapter write it is the early signal beneath the coarse
 * whole-exchange budget. Fixed rather than a fraction of the (operator-tunable)
 * peer budget so the warning fires at a predictable wall-clock point regardless of
 * how high the budget is raised.
 */
export const SFTP_SLOW_OPERATION_WARNING_MS = 30_000;

/**
 * Wraps an in-flight SFTP operation with a non-fatal slow-operation warning: if
 * `promise` has not settled within `thresholdMs`, emits one `log.warn` line naming
 * the operation, the elapsed time, and -- where a cheap progress signal exists --
 * the observed progress (`progress(elapsedMs)`), then lets the operation continue
 * unchanged. The returned promise settles exactly as `promise` does (same value,
 * same rejection); the warning never alters the result, and the timer is cleared
 * the moment `promise` settles.
 *
 * It is strictly observability and is layered ABOVE the terminal bounds, never
 * inside them: the per-operation read deadline ({@link withSftpOperationDeadline} /
 * the capped sink) and the consumer-layer whole-exchange budget are what actually
 * fail a stalled operation; this only tells a watching operator that an operation
 * is taking a while. The timer is `unref`'d so it never holds the process open on
 * its own, and it fires at most once (a single `setTimeout`).
 */
export function withSlowOperationWarning<T>(
  promise: Promise<T>,
  options: {
    operation: string;
    path: string;
    log: { warn: (message: string) => void };
    thresholdMs?: number;
    progress?: (elapsedMs: number) => string;
  },
): Promise<T> {
  const thresholdMs = options.thresholdMs ?? SFTP_SLOW_OPERATION_WARNING_MS;
  const start = Date.now();
  const timer = setTimeout(() => {
    // Measure actual wall-clock elapsed rather than reusing thresholdMs: under
    // event-loop load the timer fires a little late, and the get() progress
    // callback divides bytes by this value to report a rate, so a stale
    // thresholdMs would inflate it. The two coincide only when the timer fires
    // exactly on schedule.
    const elapsedMs = Date.now() - start;
    const observed = options.progress?.(elapsedMs);
    // The path can carry a peer-supplied filename (a get/put of a partner file),
    // so escape it before it reaches the operator's terminal.
    options.log.warn(
      `SFTP ${options.operation} of ${sanitizeForDisplay(options.path)} is ` +
        `still running after ` +
        `${elapsedMs} ms${observed ? ` (${observed})` : ""}; this may be a ` +
        "slow transfer or an unresponsive server",
    );
  }, thresholdMs);
  timer.unref();
  return promise.finally(() => clearTimeout(timer));
}
