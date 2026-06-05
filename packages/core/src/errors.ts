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
