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
