/**
 * The browser-side reader for a console run's dual-signed receipt: whether the
 * console holds one for a job, where to download it from, and what to name the
 * saved file.
 *
 * The console is the authority on all three. A seat asks it rather than
 * remembering what it requested, which is what lets a re-attached run -- another
 * tab, or a return after a reload -- offer the receipt at all.
 *
 * The ask is independent of how the run ended. A receipt is written from the
 * mutually-verifiable facts once the signature swap completes, independent of
 * the local record build and the run's exit code -- a persistence-loss exit can
 * still have a receipt as the one artifact that survived. `GET
 * /api/jobs/:jobId/receipt` is not gated on success for that reason
 * (docs/spec/SERVER_JOB_API.md); a reader must not gate the download on a
 * successful terminal either.
 *
 * An ask the console does not answer is not a run without a receipt -- it says
 * nothing at all. Treating it as "no receipt" would silently hide one the
 * console holds, behind a single hiccup at the moment the run settled.
 * Consecutive unanswered asks are bounded instead, and the ask ends on an
 * outcome the seat can state.
 */

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobApiBody";
import { delayUntilAborted } from "@psi/delayUntilAborted";

import { recordFileStamp } from "@bench/runOutputs";

/** The console endpoint the receipt downloads from. The browser never composes
 * the file's path: the console resolves it inside the job's own workdir. */
export function jobReceiptUrl(jobId: string): string {
  return `/api/jobs/${jobId}/receipt`;
}

/**
 * What one ask told the seat about this run's receipt: the file and its download
 * name, a run that asked for a receipt the console does not hold, nothing to
 * say at all, or an ask holding no answer about the receipt.
 *
 * `missing` is kept apart from `none` for the same reason the diagnostic log
 * keeps its own two apart ({@link ./jobDiagnosticLog}): only `receiptRequested`
 * -- the console's own record of the intent it launched -- separates a receipt
 * that was never asked for from one that was asked for and is not there.
 *
 * `unanswered` is kept apart from both, for the same reason the log keeps its
 * own: a rejected request, a job the console has forgotten across a restart, a
 * lost connection, a body that will not parse -- none of those said this run
 * has no receipt, and folding them into `none` (rendered as nothing at all)
 * would hide a real receipt silently. A body that IS readable and holds
 * neither field is `none`: the console answered, and its answer establishes
 * nothing for the seat to state.
 */
export type JobReceiptOffer =
  | { kind: "available"; receiptUrl: string; receiptFileName: string }
  | { kind: "missing" }
  | { kind: "none" }
  | { kind: "unanswered" };

/**
 * The download name the operator's browser saves the receipt under. It follows
 * the record downloads' stamped convention, which is also the CLI's own default
 * receipt name off the same `createdAt` (`defaultReceiptPath` in apps/cli), so an
 * operator's console and command-line runs file the artifact under one
 * convention.
 *
 * The stamp falls back to the job id where the status body reports no record to
 * take one from: a run can hold a receipt with no record -- the case the
 * receipt endpoint is not success-gated for -- so the download must not be
 * withheld for want of a filename. The id names the run as unambiguously as the
 * timestamp does, matching the stamp the diagnostic log's own download name
 * already holds.
 */
function receiptFileName(jobId: string, status: JobStatusFields): string {
  const stamp =
    status.recordAvailable === true &&
    typeof status.recordCreatedAt === "string"
      ? recordFileStamp(status.recordCreatedAt)
      : jobId;
  return `psilink-receipt-${stamp}.json`;
}

/** The status-body fields this reader looks at, all of them unknown until read:
 * the body is JSON off the network, so nothing about its shape is given. */
interface JobStatusFields {
  receiptAvailable?: unknown;
  receiptRequested?: unknown;
  recordAvailable?: unknown;
  recordCreatedAt?: unknown;
}

/**
 * Where this job's receipt stands, read off `GET /api/jobs/:jobId` in one ask.
 *
 * The two receipt fields are read strictly and together: only a literal `true` on
 * either answers, so a readable body that omits one, holds a non-boolean, or is
 * not this endpoint's status body at all falls to `none` and the seat says
 * nothing about this run's receipt rather than reporting one missing on the
 * strength of a malformed frame.
 *
 * An ask that came back with no readable body at all -- a fetch that threw, a
 * non-2xx, a body that would not parse -- is `unanswered` rather than either
 * answer, and {@link askJobReceiptOffer} is what decides whether to ask again.
 */
export async function fetchJobReceiptOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobReceiptOffer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "unanswered" };
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    if (body === null || typeof body !== "object") return { kind: "none" };
    const status = body as JobStatusFields;
    if (status.receiptAvailable === true)
      return {
        kind: "available",
        receiptUrl: jobReceiptUrl(jobId),
        receiptFileName: receiptFileName(jobId, status),
      };
    return status.receiptRequested === true
      ? { kind: "missing" }
      : { kind: "none" };
  } catch {
    return { kind: "unanswered" };
  }
}

/**
 * The gap between asks after one that held no answer. What a longer wait
 * costs is how long the download stays missing on a settled run the operator is
 * already looking at; what a shorter one costs is a burst of asks at a
 * console that has just stopped answering.
 */
const RECEIPT_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive asks that answer nothing about the receipt before the seat gives
 * up on this run. Every unanswerable shape looks alike from the browser -- a job
 * the console forgot across a restart, a route erroring, a connection that
 * stopped reaching it -- so a bound is the only thing separating a blip the next
 * ask recovers from a console that will never answer for this run. At
 * {@link RECEIPT_AVAILABILITY_RETRY_MS} apiece this spends under ten seconds
 * before the seat says so, on a run that has already reached its terminal.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const RECEIPT_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * Ask the console where this job's receipt stands, re-asking while the ask
 * itself holds no answer.
 *
 * One ask determines every answer the console actually gives: the seat asks a run
 * that has already settled, so `available`, `missing`, and `none` cannot change
 * and asking again would tell it the same thing. Only the answer that comes
 * back with nothing gets re-asked -- a hiccup at the moment the run settles
 * would otherwise hide a receipt the console holds for the whole life of the
 * seat, silently, since `none` renders as no control at all. Consecutive
 * unanswered asks are re-asked up to
 * {@link RECEIPT_AVAILABILITY_UNANSWERED_LIMIT} times, so a transient failure
 * costs a couple of seconds while a persistent one ends in `unanswered` -- the
 * outcome a seat states rather than renders as nothing.
 *
 * A caller that stops the ask gets `none`: it established nothing, which is the
 * one outcome the seat shows nothing for.
 */
export async function askJobReceiptOffer(
  jobId: string,
  signal: AbortSignal,
  {
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobReceiptOffer> {
  // Read the live abort state through a call so the re-check after the ask is
  // not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return { kind: "none" };
    const offer = await fetchJobReceiptOffer(jobId, fetchImpl);
    if (offer.kind !== "unanswered") return offer;
    if (++unanswered >= RECEIPT_AVAILABILITY_UNANSWERED_LIMIT)
      return { kind: "unanswered" };
    if (aborted()) return { kind: "none" };
    await delay(RECEIPT_AVAILABILITY_RETRY_MS, signal);
  }
}
