/**
 * Thrown by {@link FileSyncConnection} when the caller has supplied an
 * invalid configuration or attempted an operation that violates usage
 * constraints: wrong directory state, stale handshake files, multiple
 * concurrent sessions sharing a path, or a send timeout. This is the
 * public API contract for the 64-vs-69 exit-code split: callers outside
 * `packages/core` -- notably the CLI -- check `instanceof UsageError` to
 * distinguish a configuration problem from a transport failure and exit
 * with 64 (EX_USAGE) rather than 69 (EX_UNAVAILABLE). Future throw sites
 * added to `synchronize()` or `send()` should throw this class rather
 * than a plain `Error` with `{ cause: "usage" }`.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * A {@link UsageError} subclass marking a bilateral-mode mismatch detected at
 * rendezvous: the peer advertised a `lockless_rendezvous` or `retain_files`
 * setting in its hello payload that differs from this party's. These flags are
 * bilateral agreements with no negotiation (see FILE_SYNC.md "Bilateral
 * configuration"), so a difference is fatal and is surfaced fast on both
 * parties rather than stalling until the peer timeout.
 *
 * It is a distinct type, not a plain `UsageError`, so the rendezvous cleanup
 * paths can branch on it deterministically: on a mismatch the detecting party
 * leaves its own advertised hello (and the peer's) in the directory as the
 * terminal state -- skipping the on-disk sweep so the peer reads the
 * advertisement and fails too -- while still being classified as a usage error
 * (CLI exit 64) by the `instanceof UsageError` check at the CLI catch sites.
 */
export class BilateralModeMismatchError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "BilateralModeMismatchError";
  }
}

/**
 * Thrown when a transport read encounters an inbound file larger than the
 * maximum frame size ({@link MAX_FRAME_SIZE_BYTES}). Raised at the transport
 * read layer -- the poll loop and rendezvous gate's pre-`get()` size check, and
 * the hard per-read byte cap inside each {@link FileTransportClient} adapter --
 * so an oversized file is refused before it is ingested into memory rather than
 * exhausting it (see docs/SECURITY_DESIGN.md, "Channel security").
 *
 * It is a {@link UsageError} subclass for two reasons. First, it must be a
 * terminal failure in the poll loop: {@link FileSyncConnection}'s poller stops
 * on a `UsageError` (re-reading an over-cap file cannot help and would re-incur
 * the very allocation this guards against) and reschedules on any other error,
 * so deriving from `UsageError` makes the refusal terminal without changing the
 * poller's classification. Second, an over-cap file in the shared directory is
 * the same family as the other directory-state conditions `UsageError` already
 * covers (a stray, malformed, or foreign file), so it shares the exit-64
 * (EX_USAGE) classification that tells the operator to inspect the directory or
 * peer rather than retry as if the transport were merely flaky.
 *
 * Adapters in `apps/` throw this class (re-exported on the package surface) from
 * their capped `get()` so a server that under-reports a file's size in its
 * directory listing -- evading the pre-`get()` check -- still surfaces the same
 * terminal, typed failure once the read itself crosses the cap.
 */
export class FrameSizeExceededError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "FrameSizeExceededError";
  }
}

/**
 * Thrown into an in-flight {@link FileSyncConnection} wait when the connection
 * is closed mid-rendezvous or mid-send. `close()` aborts a shared
 * `AbortController` whose `reason` is an instance of this class, so any wait
 * parked between polls/retries rejects promptly instead of resuming against a
 * connection that is tearing down.
 *
 * Unlike {@link UsageError}, this is a plain `Error`: a deliberate local
 * teardown is a transport-availability condition, so the CLI's
 * `instanceof UsageError` check classifies it as exit 69 (EX_UNAVAILABLE),
 * not the 64 (EX_USAGE) reserved for caller misconfiguration. In practice it
 * almost never surfaces as the process exit code -- `close()` only races an
 * in-flight wait under a signal, where `signalReceived` owns the code
 * (130/143) and this rejection is logged and swallowed.
 *
 * It lives here in `errors.ts` -- and is therefore re-exported on the package's
 * public surface by main.ts's `export *` -- deliberately: this file is the
 * single home for the connection error taxonomy ({@link UsageError},
 * {@link BilateralModeMismatchError}), and splitting one error type out into a
 * non-barrelled module to hide it would be the more surprising inconsistency.
 * (`cancellableDelay` is hidden in the non-barrelled fileSyncConstants.ts for
 * the opposite reason: it is an internal helper with no taxonomy home.) Treat
 * this class as an internal teardown signal, not a stability contract -- the
 * plain-`Error`/exit-69 classification above is the contract; consumers should
 * not depend on catching it by type.
 */
export class ConnectionClosedError extends Error {
  constructor(message = "connection closed during wait") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}
