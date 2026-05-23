/**
 * Races `promise` against a `ms`-millisecond deadline. Rejects with
 * `Error(message)` if the deadline fires first; otherwise settles with
 * `promise`'s own result. The timer is cleared when `promise` settles.
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
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
};

/**
 * Calls `fn` up to `retries + 1` times, waiting `delay` ms between attempts.
 * Resolves with the first successful result; rejects with the last error if
 * all attempts fail.
 */
export const retryPromise = <T>(
  fn: () => Promise<T>,
  retries: number,
  delay: number,
) => {
  return new Promise<T>((resolve, reject) => {
    function attempt() {
      fn()
        .then(resolve)
        .catch((error: unknown) => {
          if (retries > 0) {
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
