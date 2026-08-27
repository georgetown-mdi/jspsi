/**
 * Resolve after `ms`, or promptly when `signal` aborts, so a wait the caller has
 * stopped leaves no timer running behind it.
 *
 * Shared by the readers that ask the appliance about one job's artifacts
 * ({@link ./jobDiagnosticLog}, {@link ./jobReceipt}), which pace their bounded
 * re-asks with it: a second copy of an abort-aware timer is a second place for a
 * listener and a timeout to outlive the seat that started them.
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
