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
 * Where a job's diagnostic log stands with the appliance: `none` for a run whose
 * intent asked for no log, `pending` for one that did and whose file has not
 * appeared, `available` once it is on disk.
 *
 * An unreadable answer -- a rejected request, a job the appliance has forgotten,
 * a body that is not the status body -- is `pending` rather than `none`, so only
 * the appliance saying outright that this run asked for no log ends a watch.
 */
export type JobDiagnosticLogState = "none" | "pending" | "available";

/**
 * Where this job's diagnostic log stands, read off `GET /api/jobs/:jobId`.
 *
 * The two fields are read together because either alone leaves a watcher
 * guessing: `logAvailable` false covers both a log that is coming and one that
 * never was, and it is `logRequested` -- the appliance's own record of the intent
 * it launched -- that separates them.
 */
export async function fetchJobLogState(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobDiagnosticLogState> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return "pending";
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return "pending";
    const status = body as { logAvailable?: unknown; logRequested?: unknown };
    if (status.logAvailable === true) return "available";
    return status.logRequested === false ? "none" : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Whether the appliance holds a diagnostic log for this job. False for a run
 * that captured none, for a job the appliance has forgotten, and for any
 * failure.
 */
export async function fetchJobLogAvailable(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await fetchJobLogState(jobId, fetchImpl)) === "available";
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
 * A run that asked for no log is answered by the first ask and the watch stops
 * there: the ordinary run is the common one, and asking it repeatedly would
 * poll the appliance for the whole exchange to be told the same thing. Only a
 * pending answer is re-asked, which the caller still bounds by stopping the
 * watch when the run settles.
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
    const state = await fetchJobLogState(jobId, fetchImpl);
    if (state !== "pending") return state === "available";
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
