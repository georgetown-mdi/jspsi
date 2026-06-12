/**
 * The rejection {@link withTimeout} raises when its deadline fires before the
 * raced promise settles. A distinct type (not a plain `Error`) so a caller can
 * tell "my own operation failed" from "the deadline elapsed" by `instanceof`
 * rather than by matching the message string. {@link retryPromise}'s
 * `shouldRetry` predicate keys on it to treat a deadline as terminal while
 * still retrying the operation's own transient errors -- see
 * `LocalFSClient.connect`, where a timed-out `fs.access` must not be retried (a
 * retry cannot un-stick a stalled mount and would only strand a second
 * thread-pool worker).
 *
 * Extends `Error`, NOT `UsageError`: a deadline on a connect probe is an
 * availability failure (the CLI's EX_UNAVAILABLE / exit 69), not a usage error
 * (exit 64) -- the same classification this rejection carried as a plain
 * `Error` before it was given a type.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Races `promise` against a `ms`-millisecond deadline. Rejects with a
 * {@link TimeoutError} carrying `message` if the deadline fires first;
 * otherwise settles with `promise`'s own result. The timer is cleared when
 * `promise` settles.
 *
 * @example
 * // Retry a network probe up to 3 times, enforcing a 5-second deadline on
 * // each individual attempt:
 * await retryPromise(
 *   () => withTimeout(probe(host), 5_000, `timed out probing ${host}`),
 *   3,
 *   1_000,
 * );
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    }),
  ]);
};

/**
 * Calls `fn` up to `retries + 1` times, waiting `delay` ms between attempts.
 * Resolves with the first successful result; rejects with the last error if
 * all attempts fail.
 *
 * `shouldRetry` gates each retry on the error just thrown (default: retry on any
 * error). A caller whose operation is not idempotent passes a predicate so only
 * errors that prove the operation did not take effect are re-issued; an error
 * for which it returns false rejects immediately without consuming a retry.
 */
export const retryPromise = <T>(
  fn: () => Promise<T>,
  retries: number,
  delay: number,
  shouldRetry: (error: unknown) => boolean = () => true,
) => {
  return new Promise<T>((resolve, reject) => {
    function attempt() {
      fn()
        .then(resolve)
        .catch((error: unknown) => {
          if (retries > 0 && shouldRetry(error)) {
            --retries;
            setTimeout(attempt, delay);
          } else {
            reject(error);
          }
        });
    }
    attempt();
  });
};
