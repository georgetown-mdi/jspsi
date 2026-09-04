// Internal constants for fileSyncConnection, not re-exported by the package
// barrel (main.ts barrels fileSyncConnection.ts, not this file): an
// `@internal` export here is reachable by a unit test's deep import without
// entering the public runtime surface. Do not fold these back into
// fileSyncConnection.ts, which IS barrelled -- any export there leaks into
// the published API.

// Retry budget for the lock-joiner fast-path mismatch advertisement, the one
// branch that must durably write a new hello at detection time so the
// lockless peer fast-fails. A failed write here degrades the peer from a
// fast-fail (exit 64) to the legacy timeout (exit 69). Five attempts at
// pollingFrequency (~400 ms at the 100 ms default) stays well under
// peerTimeoutMs. Internal-only; not a user-facing config option.
/** @internal */
export const ADVERTISE_HELLO_RETRY_ATTEMPTS = 5;

// Leak-safe cancellable sleep: resolves after `ms`, or rejects with
// `signal.reason` if the signal aborts first. Every in-session wait in
// fileSyncConnection.ts uses it, so a sleep cancels promptly when close()
// aborts the session controller. Lives here (not the barrelled
// fileSyncConnection.ts) for the same deep-import reason as
// ADVERTISE_HELLO_RETRY_ATTEMPTS. Exactly one of {timer, abort} ever runs,
// and each clears the other; a pre-aborted signal rejects immediately with no
// timer allocated, and every path rejects on abort so the surrounding poll
// loop unwinds and propagates.
/** @internal */
export function cancellableDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
