import { TransportOperationStalledError } from "@psilink/core";

/**
 * Liveness enforcement primitives shared by the SFTP adapter's server-driven
 * operations ({@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}'s
 * `list()`, `get()`, and `createExclusive()`). Every one of those reads awaits a
 * callback the remote server controls, so a hostile (or dead) server admin -- an
 * adversary under docs/SECURITY_DESIGN.md "Channel security" -- can hang it
 * forever by withholding the response. These helpers bound that wait and surface
 * a single typed, terminal {@link TransportOperationStalledError}, the liveness
 * sibling of the memory-size guards in {@link ./frameSizeGuard} and
 * {@link ./listingGuard}: those cap what a hostile file or directory can
 * allocate; this caps the time a hostile server can make an operation consume.
 *
 * These are the per-operation fast-fail layer for the READ path only, not the
 * universal backstop. They bound a stalled read tightly (60 s), but the always-
 * executed write/stat/delete operations (`put`/`rename`/`delete`/`exists`) carry
 * no per-operation bound here, and neither does the local-filesystem adapter.
 * Those are covered instead by the whole-exchange budget in `FileSyncConnection`
 * (`@psilink/core`), which races EVERY transport await --
 * reads, writes, and the local-filesystem path alike -- against the coarse
 * peer-inactivity budget. So the local-filesystem adapter does get a liveness
 * bound after all (an earlier framing here held its reads to a trusted
 * `fs.opendir`/`fs.stat` kernel that withholds nothing, but a stalled NFS/CIFS
 * hard mount breaks that premise); it just gets the coarse whole-exchange bound
 * rather than these tight per-operation ones, which stay SFTP-only because only
 * the SFTP read path has the server-driven callback this tier exists to catch
 * quickly. (The filedrop connect path separately bounds `fs.access` with a
 * timeout.)
 *
 * This module also holds the estimate-free, non-fatal slow-operation WARNING
 * ({@link withSlowOperationWarning}) -- observability, not a control, layered
 * strictly above all of the above and never inside a terminal path.
 */

/**
 * Wall-clock budget, in milliseconds, for a server response before an SFTP read
 * is judged stalled. One constant covers the adapter's withheld-response bounds,
 * applied in the mode each operation allows: as a whole-operation deadline for
 * `list()` (catching an `opendir`/`readdir`/`close` callback that never fires),
 * `createExclusive()` (an open/close callback that never fires), and the rarely
 * used uncapped `get()`; and as a per-chunk idle window for the capped streaming
 * `get()` (reset on each chunk, so it bounds a transfer that goes silent rather
 * than one that is merely large). The streamed `list()` read additionally has a
 * round-trip cap ({@link ./listingGuard.MAX_LISTING_READDIR_BATCHES}) for the
 * empty-batch flood the deadline would otherwise catch only after the full
 * budget; the other operations have no such progress loop, so the deadline is
 * their sole bound.
 *
 * Value: 60,000 ms (60 s). A coarse "the server has gone silent" threshold, not a
 * tight latency budget. It sits well above any legitimate operation -- a normal
 * listing, an exclusive lock-file create, and each chunk of a healthy transfer
 * all complete in well under a second -- at roughly three times the SSH stack's
 * 20 s connection-establishment unresponsiveness threshold (ssh2's default
 * `readyTimeout`, also this project's `serverConnectTimeoutMs`), so a transiently
 * slow but live server is not cut off; yet more than an order of magnitude below
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
 */
export function transportOperationStalledError(
  operation: string,
  path: string,
  detail: string,
): TransportOperationStalledError {
  return new TransportOperationStalledError(
    `SFTP ${operation} of ${path} stalled: ${detail}; refusing to wait on the ` +
      `server further`,
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
  const timer = setTimeout(() => {
    const observed = options.progress?.(thresholdMs);
    options.log.warn(
      `SFTP ${options.operation} of ${options.path} is still running after ` +
        `${thresholdMs} ms${observed ? ` (${observed})` : ""}; this may be a ` +
        "slow transfer or an unresponsive server",
    );
  }, thresholdMs);
  timer.unref();
  return promise.finally(() => clearTimeout(timer));
}
