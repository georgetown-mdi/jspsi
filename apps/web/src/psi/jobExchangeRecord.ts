/**
 * The browser-side reader for a console run's self-attested exchange record:
 * whether the appliance holds one for a job, how the run that wrote it ended,
 * where to download the pair from, and what to name the saved files.
 *
 * The appliance is the authority on all of it. A seat asks it rather than
 * inferring the record from the run's own terminal, which is what lets a
 * re-attached run -- another tab, or a return after a reload -- offer the record
 * at all, and what lets a run that DISCLOSED AND THEN TERMINATED offer one: such a
 * run reaches the seat as a failure, so a control hung off the completion outputs
 * would render nothing for precisely the run whose accounting entry matters most
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
 *
 * The ask is deliberately made only once the run has SETTLED. The CLI writes the
 * pair near the end of a run, so an ask before the terminal could read a run
 * mid-write as one with no record; the appliance applies the same rule on its side
 * and reports no record for a running job.
 *
 * An ask the appliance does not answer is not a run without a record: it says
 * nothing at all, and a seat that read it as one would hide the record of a
 * disclosure behind a single hiccup at the moment the run settled -- on the very
 * surface that also offers to delete it. Consecutive unanswered asks are bounded
 * instead, and the ask ends on an outcome the seat can state.
 *
 * What the seat cannot do is state an ABSENCE. The receipt reader
 * ({@link ./jobReceipt}) can, because `receiptRequested` names a run that expected
 * one; there is no counterpart for the record, since whether one is owed at all
 * depends on how far the run got. So a body that answers and reports no record is
 * `none`, which renders as nothing rather than as a claim the run has none.
 */

import { EXCHANGE_RECORD_OUTCOMES } from "@psilink/core";

import { delayUntilAborted } from "@psi/delayUntilAborted";

import { recordFileStamp } from "@bench/runOutputs";

import type { ExchangeRecordOutcome } from "@psilink/core";
import type { RecordDownloads } from "./exchangeLifecycle";

/** The appliance endpoint the shareable record downloads from. The browser never
 * composes the file's path: the appliance resolves it inside the job's own
 * workdir. */
export function jobRecordUrl(jobId: string): string {
  return `/api/jobs/${jobId}/record`;
}

/** The appliance endpoint the private verification keys download from, paired
 * with {@link jobRecordUrl}. */
export function jobKeysUrl(jobId: string): string {
  return `/api/jobs/${jobId}/keys`;
}

/**
 * The record pair's appliance download hrefs and save names for a run, stamped
 * from the record's own `createdAt` exactly as the in-browser path stamps its
 * blobs ({@link @bench/runOutputs}), so a console run and a browser run file one
 * exchange's artifacts under one convention.
 */
export function jobRecordDownloads(
  jobId: string,
  createdAt: string,
): RecordDownloads {
  const stamp = recordFileStamp(createdAt);
  return {
    recordUrl: jobRecordUrl(jobId),
    recordFileName: `psilink-record-${stamp}.json`,
    keysUrl: jobKeysUrl(jobId),
    keysFileName: `psilink-record-${stamp}.keys.json`,
  };
}

/**
 * What one ask told the seat about this run's exchange record: the pair with the
 * outcome the record itself states, nothing to say, or an ask carrying no answer.
 *
 * `none` is the appliance answering that it holds no record for this run, which
 * covers a run that owes none and a run whose record could not be written. The two
 * are not separable from the status body and a seat renders both as nothing: it
 * states an absence only where it can name what is absent.
 *
 * `unanswered` is kept apart from `none` for the reason the receipt reader keeps
 * its own apart: a rejected request, a job the appliance forgot across a restart,
 * a lost connection, a body that will not parse. None of those said this run has
 * no record.
 */
export type JobExchangeRecordOffer =
  | {
      kind: "available";
      outcome: ExchangeRecordOutcome;
      downloads: RecordDownloads;
    }
  | { kind: "none" }
  | { kind: "unanswered" };

/** The status-body fields this reader looks at, all of them unknown until read:
 * the body is JSON off the network, so nothing about its shape is given. */
interface JobStatusFields {
  recordAvailable?: unknown;
  recordCreatedAt?: unknown;
  recordOutcome?: unknown;
}

/** Whether a status body's `recordOutcome` is one of the values the record format
 * admits. Read strictly rather than cast: the outcome decides what the seat says
 * the record can be used for, so a body carrying an unrecognized one answers
 * nothing rather than defaulting to either meaning. */
function recordOutcomeOf(value: unknown): ExchangeRecordOutcome | undefined {
  return EXCHANGE_RECORD_OUTCOMES.find((outcome) => outcome === value);
}

/**
 * Where this job's record stands, read off `GET /api/jobs/:jobId` in one ask.
 *
 * The three fields are read strictly and together, matching the appliance's own
 * all-or-nothing rule: only a literal `true` availability alongside a string
 * `createdAt` and a recognized `outcome` is an offer, so a readable body that
 * omits one, carries the wrong type, or is not this endpoint's status body at all
 * falls to `none`.
 *
 * An ask that came back with no readable body at all -- a fetch that threw, a
 * non-2xx, a body that would not parse -- is `unanswered` rather than `none`, and
 * {@link askJobExchangeRecordOffer} is what decides whether to ask again.
 */
export async function fetchJobExchangeRecordOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobExchangeRecordOffer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "unanswered" };
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return { kind: "none" };
    const status = body as JobStatusFields;
    const outcome = recordOutcomeOf(status.recordOutcome);
    if (
      status.recordAvailable !== true ||
      typeof status.recordCreatedAt !== "string" ||
      outcome === undefined
    )
      return { kind: "none" };
    return {
      kind: "available",
      outcome,
      downloads: jobRecordDownloads(jobId, status.recordCreatedAt),
    };
  } catch {
    return { kind: "unanswered" };
  }
}

/**
 * The gap between asks after one that carried no answer. What a longer wait costs
 * is how long the download stays missing on a settled run the operator is already
 * looking at; what a shorter one costs is a burst of asks at an appliance that has
 * just stopped answering. The receipt reader's own gap, for the same reasons.
 */
const RECORD_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive asks that answer nothing about the record before the seat gives up
 * on this run. Every unanswerable shape looks alike from the browser -- a job the
 * appliance forgot across a restart, a route erroring, a connection that stopped
 * reaching it -- so a bound is the only thing separating a blip the next ask
 * recovers from an appliance that will never answer for this run.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const RECORD_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * Ask the appliance where this job's record stands, re-asking while the ask itself
 * carries no answer.
 *
 * One ask settles every answer the appliance actually gives: the seat asks a run
 * that has already settled, so `available` and `none` cannot change and asking
 * again would tell it the same thing. It is the ask that comes back with nothing
 * that cannot be left alone -- a hiccup at the moment the run settles would
 * otherwise hide the record of a disclosure for the whole life of the seat, on the
 * one surface that also offers to delete it.
 *
 * A caller that stops the ask gets `none`: it established nothing.
 */
export async function askJobExchangeRecordOffer(
  jobId: string,
  signal: AbortSignal,
  {
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobExchangeRecordOffer> {
  // Read the live abort state through a call so the re-check after the ask is not
  // narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return { kind: "none" };
    const offer = await fetchJobExchangeRecordOffer(jobId, fetchImpl);
    if (offer.kind !== "unanswered") return offer;
    if (++unanswered >= RECORD_AVAILABILITY_UNANSWERED_LIMIT)
      return { kind: "unanswered" };
    if (aborted()) return { kind: "none" };
    await delay(RECORD_AVAILABILITY_RETRY_MS, signal);
  }
}
