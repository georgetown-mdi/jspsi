import { Readable } from "node:stream";

import {
  redactAndSanitizeForDisplay,
  TransportOperationStalledError,
} from "@psilink/core";

import { fittedCauseLink } from "./causeLink";

/**
 * Per-operation liveness bounds for the SFTP adapter's server-driven operations
 * ({@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}'s `list()`, `get()`,
 * `createExclusive()`, `put()`, `rename()`, `delete()`, `exists()`). Each awaits a
 * callback the remote server controls, so a hostile or dead server can hang it
 * forever by withholding the response; these helpers bound the wait and produce a
 * single typed, terminal {@link TransportOperationStalledError}.
 *
 * Reads and metadata ops are bounded by a wall-clock deadline
 * ({@link withSftpOperationDeadline}); `put` is bounded instead by a
 * progress-based idle window ({@link createBoundedPutSource}), so a
 * large-but-progressing upload is not false-failed. Covers only this adapter: the
 * local-filesystem adapter has no per-operation bound here and relies on the
 * whole-exchange budget in `FileSyncConnection` (`@psilink/core`) instead.
 *
 * Also holds the non-fatal slow-operation warning
 * ({@link withSlowOperationWarning}) -- observability, not a control, layered
 * above all of the above and never inside a terminal path.
 */

/**
 * Wall-clock budget, in milliseconds, for a server response before an SFTP
 * operation is judged stalled. One constant covers the adapter's withheld-response
 * bounds, applied in the mode each operation allows (see the module header).
 *
 * Value: 60,000 ms (60 s) -- well above any legitimate operation and well below
 * the one-hour peer-inactivity budget, so a withheld response fails the exchange
 * in a minute rather than an hour without cutting off a transiently slow server.
 * Fixed, not operator-configurable, for the same reason as the size bounds: a
 * configurable budget risks an operator raising it high enough to reintroduce the
 * denial of service.
 */
export const SFTP_STALL_DEADLINE_MS = 60_000;

/**
 * Construct the typed, terminal {@link TransportOperationStalledError} for an
 * SFTP operation that did not make progress within its bound. `operation` names
 * the op (e.g. `"directory listing"`, `"file read"`, `"exclusive create"`);
 * `detail` states how it stalled; `serverReported`, where present, relays the
 * server's own fatal error. `path` and `serverReported` are peer-controlled and
 * unbounded in length, so each value gets its own labelled cause link via
 * {@link ./causeLink.fittedCauseLink} rather than sharing one -- a shared link
 * would let an unbounded value crowd out the budget the first-party framing
 * needs.
 *
 * apps/cli/test/unit/connection/transportRefusalBudget.test.ts asserts the
 * ordinary-size fit for the enumerated CLI call sites; the adapter's other
 * stall shapes (delete, rename, exclusive create, existence check) are covered
 * by that suite's class-level flood half and are measured, not pinned.
 */
export function transportOperationStalledError(
  operation: string,
  path: string,
  detail: string,
  serverReported?: string,
): TransportOperationStalledError {
  return new TransportOperationStalledError(
    `SFTP ${operation} stalled; refusing to wait on the server further`,
    {
      details: [
        fittedCauseLink(`how the ${operation} stalled: `, detail),
        fittedCauseLink(`stalled ${operation} path: `, path),
        ...(serverReported === undefined
          ? []
          : [fittedCauseLink("error the server reported: ", serverReported)]),
      ],
    },
  );
}

/**
 * Bound a server-driven SFTP operation by a wall-clock deadline: settles with
 * `promise`'s own result if it finishes first, otherwise rejects with
 * `makeError()` once `ms` elapses; the timer clears as soon as `promise` settles.
 * Differs from `@psilink/core`'s `withTimeout` in taking an error factory (not a
 * message string) and rejecting with a typed
 * {@link TransportOperationStalledError} so the poll loop treats the stall as
 * terminal.
 *
 * It only races: the underlying operation may still fire after the deadline
 * (harmless -- the session tears down on the terminal error), and a late
 * rejection is absorbed by a no-op `catch` so it never becomes an unhandled
 * rejection. The timer is `unref`'d. A handle opened just before a withheld close
 * is not reclaimed, since a close whose own callback is withheld cannot itself
 * complete; operations that hold a reusable handle past a stall
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
 * ssh2's SFTP write path acks a `WriteStream` write only after every internal
 * WRITE packet it was split into has been acked, firing the stream callback once
 * at the very end -- so one whole-payload write would show zero progress until
 * the transfer completed, indistinguishable from a stalled one. Chunking instead
 * makes the library's `rdr.pipe(wtr)` consume one chunk per ack-driven `drain`,
 * so the source is pulled (and the idle window reset) once per chunk
 * acknowledged.
 *
 * Value: 64 KiB -- small enough to tolerate a sustained rate as low as ~1 KiB/s
 * within the 60 s idle window, and large enough to keep per-chunk overhead
 * negligible against the up-to-512 MiB frame size. Not security-critical to the
 * byte: it sets progress granularity, not a memory or time bound.
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
 * Build a chunked, progress-observing SOURCE that bounds an outbound SFTP `put`
 * by liveness -- the write-path mirror of the read-path
 * {@link ./frameSizeGuard.createCappedSink}. `put` accepts a payload whose
 * legitimate transfer can exceed a flat deadline over a slow link, so this
 * bounds the gap between upload-progress ticks instead of the total time.
 *
 * `payload` is a single `Buffer` or an ordered list of `Uint8Array` chunks (the
 * message send path's `[header, payload]` pair); the source emits the parts
 * back-to-back in `chunkBytes`-sized views, never copies, so the on-disk bytes
 * are the parts concatenated without ever concatenating them in memory.
 *
 * ssh2-sftp-client pipes the source into the remote write stream under
 * ack-driven backpressure, so a withheld write acknowledgement stops the source
 * being pulled. An idle timer, armed before the first chunk and reset on each
 * chunk produced, fires when none has been pulled within `stallDeadlineMs`: it
 * rejects `result` and destroys the source WITH an error (not bare), so
 * ssh2-sftp-client's read-stream `'error'` handler tears the write stream down
 * at the server. The bound also covers the tail, since the last chunk's timer
 * clears only on `complete()`/`fail()`. Defaults to {@link SFTP_STALL_DEADLINE_MS}.
 *
 * The source is single-use; the caller rebuilds a fresh one from the retained
 * payload per retry attempt.
 */
export function createBoundedPutSource(
  path: string,
  payload: Buffer | readonly Uint8Array[],
  chunkBytes: number = SFTP_PUT_PROGRESS_CHUNK_BYTES,
  stallDeadlineMs: number = SFTP_STALL_DEADLINE_MS,
): BoundedPutSource {
  // Normalize to an ordered list of parts. A single Buffer is a one-part list;
  // the two forms then share one slicing loop.
  const parts: readonly Uint8Array[] = Buffer.isBuffer(payload)
    ? [payload]
    : payload;
  // Zero-copy view of `view` as a Buffer: a Buffer passes through, a plain
  // Uint8Array is re-viewed over the same backing bytes (Buffer.from(view) would
  // COPY, defeating the whole point of streaming rather than concatenating). This
  // keeps every pushed chunk a Buffer -- what ssh2's write stream consumes -- with
  // no allocation proportional to the payload.
  const asBuffer = (view: Uint8Array): Buffer =>
    Buffer.isBuffer(view)
      ? view
      : Buffer.from(
          view.buffer as ArrayBuffer,
          view.byteOffset,
          view.byteLength,
        );
  let settled = false;
  let partIndex = 0;
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
      // Destroy WITH an error, not bare, so ssh2-sftp-client tears the write stream
      // down at the server (its _put keys teardown off the source's 'error' event;
      // see createCappedSink in ./frameSizeGuard for why a bare destroy leaks the
      // transfer). The typed terminal error is already on `result`; this plain Error
      // exists only to abort at the server, and the resulting put() rejection lands
      // on the adapter's no-op `fail`.
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
      // Advance past any fully-consumed (or zero-length) parts before the EOF
      // check, so a list whose only remaining parts are empty still reaches EOF.
      while (partIndex < parts.length && offset >= parts[partIndex].length) {
        partIndex += 1;
        offset = 0;
      }
      if (partIndex >= parts.length) {
        // EOF: no more payload. This path does not re-arm the idle window, so the
        // last data chunk's timer stands until complete()/fail() clears it --
        // bounding the tail (the wait for the final ack and the write stream's
        // close) as well as the body.
        this.push(null);
        return;
      }
      const part = parts[partIndex];
      const end = Math.min(offset + chunkBytes, part.length);
      const chunk = asBuffer(part.subarray(offset, end)); // view, no copy
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
      // already does. A clean completion already reached EOF and auto-destroyed,
      // so this is a no-op; on fail() it was left mid-stream -- ssh2-sftp-client
      // destroys a string/file source on a write-stream error but NOT a provided
      // stream like this one, so destroying it here releases its state and pipe
      // linkage. destroy() is idempotent and bare (emits no 'error'), safe after
      // either settlement.
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
 * Elapsed time, in milliseconds, after which an in-flight SFTP operation that
 * has not yet settled emits a non-fatal slow-operation warning. Observability,
 * not a security control: it does nothing on a headless run with no human
 * watching (the whole-exchange liveness budget in `FileSyncConnection`
 * (`@psilink/core`) defends that run), and stays outside the terminal-error
 * paths so it can never affect correctness or the liveness gate. See
 * {@link withSlowOperationWarning}.
 *
 * Value: 30,000 ms (30 s) -- a fixed, generous threshold, not a duration
 * estimate. Above any healthy operation and below the 60 s per-operation
 * fast-fail ({@link SFTP_STALL_DEADLINE_MS}), so a stalled read gets one "slow"
 * warning before it fails. Fixed rather than a fraction of the
 * operator-tunable peer budget, so it fires at a predictable wall-clock point
 * regardless of how high that budget is raised.
 */
export const SFTP_SLOW_OPERATION_WARNING_MS = 30_000;

/**
 * Wraps an in-flight SFTP operation with a non-fatal slow-operation warning: if
 * `promise` has not settled within `thresholdMs`, emits one `log.warn` line
 * naming the operation, elapsed time, and any observed progress
 * (`progress(elapsedMs)`), then lets the operation continue unchanged. Never
 * alters the result; the timer clears the moment `promise` settles.
 *
 * Strictly observability, layered above the terminal bounds, never inside
 * them: the per-operation read deadline ({@link withSftpOperationDeadline} /
 * the capped sink) and the whole-exchange budget are what actually fail a
 * stalled operation. The timer is `unref`'d and fires at most once.
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
    // `path` may be a peer-supplied filename (a get/put of a partner file), so
    // escape it before it reaches the operator's terminal.
    options.log.warn(
      `SFTP ${options.operation} of ${redactAndSanitizeForDisplay(options.path)} is ` +
        `still running after ` +
        `${elapsedMs} ms${observed ? ` (${observed})` : ""}; this may be a ` +
        "slow transfer or an unresponsive server",
    );
  }, thresholdMs);
  timer.unref();
  return promise.finally(() => clearTimeout(timer));
}
