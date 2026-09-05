/**
 * Resolve after `ms`, or promptly when `signal` aborts, so a wait the caller has
 * stopped leaves no timer running behind it.
 *
 * Shared by the readers that ask the console about one job's artifacts
 * ({@link ./jobDiagnosticLog}, {@link ./jobReceipt}), which pace their bounded
 * retries with it, so no listener or timeout outlives the caller that started it.
 */
export function delayUntilAborted(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
