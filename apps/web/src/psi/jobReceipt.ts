/**
 * The browser-side reader for a console run's dual-signed receipt: whether the
 * appliance holds one for a job, where to download it from, and what to name the
 * saved file.
 *
 * The appliance is the authority on all three. A seat asks it rather than
 * remembering what it requested, which is what lets a re-attached run -- another
 * tab, or a return after a reload -- offer the receipt at all.
 *
 * The ask is deliberately independent of how the run ended. A receipt is written
 * from the mutually-verifiable facts once the signature swap completes,
 * independently of the local record build and of the run's exit code, so a
 * persistence-loss exit is a completed exchange whose receipt may be precisely
 * the artifact that survived. `GET /api/jobs/:jobId/receipt` is not gated on
 * success for that reason (docs/spec/SERVER_JOB_API.md), and a reader that
 * offered the download only off a successful terminal would put the gate back on
 * the client side.
 */

import { recordFileStamp } from "@bench/runOutputs";

/** The appliance endpoint the receipt downloads from. The browser never composes
 * the file's path: the appliance resolves it inside the job's own workdir. */
export function jobReceiptUrl(jobId: string): string {
  return `/api/jobs/${jobId}/receipt`;
}

/**
 * What one ask told the seat about this run's receipt: the file and its download
 * name, a run that asked for a receipt the appliance does not hold, or nothing to
 * say at all.
 *
 * `missing` is kept apart from `none` for the same reason the diagnostic log
 * keeps its own two apart ({@link ./jobDiagnosticLog}): only `receiptRequested`
 * -- the appliance's own record of the intent it launched -- separates a receipt
 * that was never asked for from one that was asked for and is not there. `none`
 * therefore covers both a run that signed nothing and an ask that answered
 * nothing, which are the two readings that leave a seat with nothing to state.
 */
export type JobReceiptOffer =
  | { kind: "available"; receiptUrl: string; receiptFileName: string }
  | { kind: "missing" }
  | { kind: "none" };

/**
 * The download name the operator's browser saves the receipt under. It follows
 * the record downloads' stamped convention, which is also the CLI's own default
 * receipt name off the same `createdAt` (`defaultReceiptPath` in apps/cli), so an
 * operator's console and command-line runs file the artifact under one
 * convention.
 *
 * The stamp falls back to the job id where the same status body reports no
 * record to take one from: a run can hold a receipt and no record -- the case the
 * receipt endpoint is deliberately not success-gated for -- and withholding the
 * download for want of a filename would hide the one third-party-verifiable
 * artifact that survived. The id names the run as unambiguously as the timestamp
 * does, and is the stamp the diagnostic log's own download name already carries.
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
 * Where this job's receipt stands, read off `GET /api/jobs/:jobId`.
 *
 * The two receipt fields are read strictly and together: only a literal `true` on
 * either answers, so a body that omits one, carries a non-boolean, or is not this
 * endpoint's status body at all falls to `none` and the seat says nothing about
 * this run's receipt rather than reporting one missing on the strength of a
 * malformed frame. A failed or aborted ask resolves the same way -- it
 * established nothing.
 */
export async function fetchJobReceiptOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobReceiptOffer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "none" };
    const body: unknown = await response.json();
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
    return { kind: "none" };
  }
}
