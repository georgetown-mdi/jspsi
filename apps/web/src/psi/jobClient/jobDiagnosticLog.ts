/**
 * The browser-side reader for a diagnostic run's captured log: whether the
 * console holds one for a job, and where to download it from.
 *
 * The console is the authority on both. A seat asks it rather than remembering
 * what it requested, which is what lets a re-attached run -- another tab, or a
 * return after a reload, the very situation a stalled run leaves an operator in
 * -- offer the log at all.
 *
 * An ask the console does not answer is not a "not yet": it says nothing about
 * whether this run has a log, so treating it as one would leave a seat asking a
 * console that has stopped answering for the whole run and telling the
 * operator nothing. Consecutive unanswered asks are bounded instead, and the
 * watch ends on an outcome the seat can state.
 */

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";
import { delayUntilAborted } from "@psi/delayUntilAborted";

/** The console endpoint the log downloads from. The browser never composes the
 * file's path: the console resolves it inside the job's own workdir. */
export function jobDiagnosticLogUrl(jobId: string): string {
  return `/api/jobs/${jobId}/log`;
}

/** The download name the operator's browser saves the log under, stamped with
 * the job so repeated downloads across runs do not collide. */
export function jobDiagnosticLogFileName(jobId: string): string {
  return `psilink-run-${jobId}.log`;
}

/**
 * What one ask told the seat: `none` for a run whose intent asked for no log,
 * `pending` for one that did and whose file has not appeared, `available` once
 * it is on disk, and `unanswered` for an ask that had no answer about the log
 * at all -- a rejected request, a job the console has forgotten across a
 * restart, a lost connection, a body that is not the status body.
 *
 * `unanswered` is not folded into either answer. It is not `none`, because
 * nothing said this run captured no log; it is not `pending`, because nothing
 * said one is coming, and a failure that persists would then be treated as a
 * file that never arrives.
 */
type JobDiagnosticLogState = "none" | "pending" | "available" | "unanswered";

/**
 * Where this job's diagnostic log stands, read off `GET /api/jobs/:jobId`.
 *
 * The two fields are read together because either alone leaves a watcher
 * guessing: `logAvailable` false covers both a log that is coming and one that
 * never was, and it is `logRequested` -- the console's own record of the intent
 * it launched -- that separates them. A body that has neither as a boolean is
 * not this endpoint's status body, so it answers nothing about the log.
 */
export async function fetchJobLogState(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobDiagnosticLogState> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return "unanswered";
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    if (body === null || typeof body !== "object") return "unanswered";
    const status = body as { logAvailable?: unknown; logRequested?: unknown };
    if (status.logAvailable === true) return "available";
    if (status.logRequested === false) return "none";
    return status.logRequested === true ? "pending" : "unanswered";
  } catch {
    return "unanswered";
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
 * Consecutive asks that answer nothing about the log before a watch gives up on
 * this run. Every unanswerable shape looks alike from the browser -- a job the
 * console forgot across a restart, a route erroring, a connection that stopped
 * reaching it -- so a bound is what separates a blip the next ask recovers from
 * a console that will never answer for this run, costing under ten seconds at
 * {@link LOG_AVAILABILITY_RETRY_MS} apiece before the seat says so.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const LOG_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * How a watch ended: `available` once the console holds the log, `unavailable`
 * when it said this run has none (or the caller stopped the watch first), and
 * `unanswered` when it stopped answering about this run altogether.
 *
 * `unanswered` is the outcome a seat states rather than renders as nothing: the
 * operator gets told the console went quiet instead of watching a panel that
 * would never arrive.
 */
type JobDiagnosticLogWatchOutcome = "available" | "unavailable" | "unanswered";

/**
 * Ask the console where this job's log stands until it answers for good, the
 * caller aborts, or it stops answering.
 *
 * A single ask when a run starts cannot answer for that run: the console
 * yields a job id as soon as the CLI child spawns, and the child opens its log
 * after that, so the ask races a file that does not exist yet. Asking again
 * every {@link LOG_AVAILABILITY_RETRY_MS} is what makes the log readable WHILE
 * the run is in progress -- the stalled run the log exists for -- rather than
 * only once it has settled.
 *
 * Which answers are re-asked differs by answer, not by patience:
 *
 * - `none` ends it at once. The ordinary run is the common one and its answer
 *   cannot change, so asking again would poll the console for the whole
 *   exchange to be told the same thing.
 * - `pending` is re-asked while the run is unsettled, because the file is still
 *   expected to appear. Once `settled` says the run reached a terminal, one ask
 *   determines it: a log that has not been opened by then never will be.
 * - `unanswered` is re-asked up to {@link LOG_AVAILABILITY_UNANSWERED_LIMIT}
 *   times in a row, so a transient failure costs a couple of seconds while a
 *   persistent one ends the watch instead of hiding behind it. Any answered ask
 *   clears the run, whatever it said.
 */
export async function watchJobDiagnosticLog(
  jobId: string,
  signal: AbortSignal,
  {
    settled = false,
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    /** Whether the run has reached a terminal state. */
    settled?: boolean;
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobDiagnosticLogWatchOutcome> {
  // Read the live abort state through a call so the re-check after the ask is
  // not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return "unavailable";
    const state = await fetchJobLogState(jobId, fetchImpl);
    if (state === "available") return "available";
    if (state === "none") return "unavailable";
    if (state === "pending") {
      if (settled) return "unavailable";
      unanswered = 0;
    } else if (++unanswered >= LOG_AVAILABILITY_UNANSWERED_LIMIT)
      return "unanswered";
    if (aborted()) return "unavailable";
    await delay(LOG_AVAILABILITY_RETRY_MS, signal);
  }
}
