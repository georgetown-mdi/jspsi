/**
 * The browser-side reader for a diagnostic run's captured log: whether the
 * appliance holds one for a job, and where to download it from.
 *
 * The appliance is the authority on both. A seat asks it rather than remembering
 * what it requested, which is what lets a re-attached run -- another tab, or a
 * return after a reload, the very situation a stalled run leaves an operator in
 * -- offer the log at all. Purely informational: any failure resolves to false
 * and the panel renders nothing rather than surfacing an error.
 */

/** The appliance endpoint the log downloads from. The browser never composes the
 * file's path: the appliance resolves it inside the job's own workdir. */
export function jobDiagnosticLogUrl(jobId: string): string {
  return `/api/jobs/${jobId}/log`;
}

/** The download name the operator's browser saves the log under, stamped with
 * the job so repeated downloads across runs do not collide. */
export function jobDiagnosticLogFileName(jobId: string): string {
  return `psilink-run-${jobId}.log`;
}

/**
 * Whether the appliance holds a diagnostic log for this job, read off
 * `GET /api/jobs/:jobId`. False for a run that captured none, for a job the
 * appliance has forgotten, and for any failure.
 */
export async function fetchJobLogAvailable(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      body !== null &&
      typeof body === "object" &&
      (body as { logAvailable?: unknown }).logAvailable === true
    );
  } catch {
    return false;
  }
}

/**
 * The gap between availability asks while a run is in progress. The CLI opens
 * the log within moments of its child spawning, so the ask that answers is
 * usually the first re-ask; what a longer wait would cost is how long the panel
 * stays missing on the run an operator is already watching stall.
 */
const LOG_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Resolve true once the appliance holds a diagnostic log for this job, asking
 * again every {@link LOG_AVAILABILITY_RETRY_MS} until it does, and false when
 * `signal` aborts first.
 *
 * A single ask when a run starts cannot answer for that run: the appliance
 * yields a job id as soon as the CLI child spawns, and the child opens its log
 * after that, so the ask races a file that does not exist yet. Asking again is
 * what makes the log readable WHILE the run is in progress -- the stalled run
 * the log exists for -- rather than only once it has settled.
 *
 * A run that captured no log answers no for as long as it is watched, so the
 * caller is what bounds the watch: it stops asking when the run settles.
 */
export async function watchJobLogAvailable(
  jobId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  delay: (ms: number, signal: AbortSignal) => Promise<void> = delayUntilAborted,
): Promise<boolean> {
  // Read the live abort state through a call so the re-check after the ask is
  // not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  for (;;) {
    if (aborted()) return false;
    if (await fetchJobLogAvailable(jobId, fetchImpl)) return true;
    if (aborted()) return false;
    await delay(LOG_AVAILABILITY_RETRY_MS, signal);
  }
}

/** Resolve after `ms`, or promptly when `signal` aborts, so a watch the caller
 * has stopped leaves no timer running behind it. */
function delayUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
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
