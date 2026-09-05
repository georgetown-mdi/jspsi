/**
 * The browser-side reader for a console run's self-attested exchange record:
 * whether the console holds one for a job, how the run that wrote it ended,
 * where to download the pair from, and what to name the saved files.
 *
 * The console is the authority on all of it: a seat asks it rather than
 * inferring the record from the run's own terminal state. That is what lets
 * a re-attached run (another tab, or a return after a reload) offer the
 * record, and what lets a run that disclosed and then terminated offer one
 * too, since such a run reaches the seat as a failure
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
 *
 * The ask is made only once the run has settled, matching the console's own
 * rule of reporting no record for a running job.
 *
 * An ask the console does not answer is not a run without a record: reading
 * it as one would hide a disclosure's record behind a single hiccup, on the
 * surface that also offers to delete it. See {@link JobExchangeRecordOffer}
 * for how each outcome is told apart.
 */

import { EXCHANGE_RECORD_OUTCOMES } from "@psilink/core";

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";
import { delayUntilAborted } from "@psi/delayUntilAborted";

import { recordFileStamp } from "../runOutputs";

import type { ExchangeRecordOutcome } from "@psilink/core";
import type { RecordDownloads } from "../exchangeLifecycle";
import type { RecordUnavailableReason } from "@jobs/jobManager";

/** The console endpoint the shareable record downloads from. The browser never
 * composes the file's path: the console resolves it inside the job's own
 * workdir. */
export function jobRecordUrl(jobId: string): string {
  return `/api/jobs/${jobId}/record`;
}

/** The console endpoint the private verification keys download from, paired
 * with {@link jobRecordUrl}. */
export function jobKeysUrl(jobId: string): string {
  return `/api/jobs/${jobId}/keys`;
}

/**
 * The record pair's console download hrefs and save names for a run, stamped
 * from the record's own `createdAt` exactly as the in-browser path stamps its
 * blobs ({@link @psi/runOutputs}), so a console run and a browser run file one
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
 * What one ask told the seat about this run's exchange record: the pair with
 * the outcome the record itself states, a record held back that neither this
 * bundle nor the console can describe, nothing to say, or an ask holding no
 * answer.
 *
 * `none` is the console answering that it holds no record for this run,
 * covering both a run that owes none and a run whose record could not be
 * written -- the two are not separable from the status body, so a seat
 * renders both as nothing rather than stating an absence it cannot name.
 *
 * `undescribable` is the console answering that a record file IS in this
 * run's workdir and it cannot offer it (an `outcome` it does not know, a
 * body it cannot parse, or a missing keys half). Nothing downloads (the
 * routes 404 under the same rule), but a record of a disclosure is on disk,
 * so it is kept apart from `none`: the controls that destroy the workdir
 * confirm before doing so.
 *
 * `unanswered` is kept apart from `none` for the reason the receipt reader
 * keeps its own apart: a rejected request, a job the console forgot across a
 * restart, a lost connection, a body that will not parse -- none of those
 * said this run has no record.
 */
export type JobExchangeRecordOffer =
  | {
      kind: "available";
      outcome: ExchangeRecordOutcome;
      downloads: RecordDownloads;
    }
  | { kind: "undescribable" }
  | { kind: "none" }
  | { kind: "unanswered" };

/** The status-body fields this reader looks at, all of them unknown until read:
 * the body is JSON off the network, so nothing about its shape is given. */
interface JobStatusFields {
  recordAvailable?: unknown;
  recordCreatedAt?: unknown;
  recordOutcome?: unknown;
  recordUnavailableReason?: unknown;
}

/**
 * What each reason the console can give for withholding the pair
 * ({@link @jobs/jobManager}) leaves the seat holding.
 *
 * Written as a total map of that type rather than a test for the one value that
 * matters, so a reason added on the console side stops this bundle compiling
 * instead of silently joining the straight-through-discard answer.
 */
const OFFER_FOR_UNAVAILABLE_REASON: Record<
  RecordUnavailableReason,
  JobExchangeRecordOffer
> = {
  "not-settled": { kind: "none" },
  "no-record": { kind: "none" },
  "undescribable-record": { kind: "undescribable" },
};

/**
 * The offer a body denying availability leaves, read from the reason it gives.
 *
 * An absent reason is the answer a console that predates the field gives, and
 * is treated as the plain denial it was: the field refines that answer rather
 * than replacing it. A reason this bundle does not recognize is the
 * version-skew case one level down -- a console withholding the pair for
 * something this bundle cannot name -- and it answers `unanswered`, on the
 * same rule an unrecognized `recordOutcome` takes: an answer that cannot be
 * read is not a denial, and folding it into `none` would let it license
 * destroying the run's workdir.
 */
function offerForUnavailableRecord(reason: unknown): JobExchangeRecordOffer {
  if (reason === undefined) return { kind: "none" };
  for (const [known, offer] of Object.entries(OFFER_FOR_UNAVAILABLE_REASON))
    if (reason === known) return offer;
  return { kind: "unanswered" };
}

/** Whether a status body's `recordOutcome` is one of the values the record format
 * admits. Read strictly rather than cast: the outcome decides what the seat says
 * the record can be used for, so a body holding an unrecognized one answers
 * nothing rather than defaulting to either meaning. */
function recordOutcomeOf(value: unknown): ExchangeRecordOutcome | undefined {
  return EXCHANGE_RECORD_OUTCOMES.find((outcome) => outcome === value);
}

/**
 * Where this job's record stands, read off `GET /api/jobs/:jobId` in one ask.
 *
 * A denial is read from `recordAvailable` and then from the reason beside it:
 * a 200 whose body does not assert `recordAvailable: true` is the console not
 * offering the pair, and `recordUnavailableReason` says whether that is a
 * definitive absence or a record it holds and cannot describe
 * ({@link offerForUnavailableRecord}). Only the definitive absence licenses a
 * discard that does not ask again.
 *
 * A body asserting `recordAvailable === true` is trusted even where the rest
 * is not: a missing/non-string `recordCreatedAt` or an unrecognized
 * `recordOutcome` (version skew against a differently-versioned console)
 * answers `unanswered` rather than `none`, since folding an availability
 * assertion into the discard state would let an unparseable detail license
 * destroying a record the console just said it holds.
 *
 * An ask with no readable body at all -- a fetch that threw, a non-2xx, or
 * unparseable JSON -- is likewise `unanswered`; {@link askJobExchangeRecordOffer}
 * decides whether to ask again.
 */
export async function fetchJobExchangeRecordOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobExchangeRecordOffer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "unanswered" };
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    if (body === null || typeof body !== "object") return { kind: "none" };
    const status = body as JobStatusFields;
    if (status.recordAvailable !== true)
      return offerForUnavailableRecord(status.recordUnavailableReason);
    const outcome = recordOutcomeOf(status.recordOutcome);
    if (typeof status.recordCreatedAt !== "string" || outcome === undefined)
      return { kind: "unanswered" };
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
 * The gap between asks after one that held no answer. What a longer wait costs
 * is how long the download stays missing on a settled run the operator is already
 * looking at; what a shorter one costs is a burst of asks at a console that has
 * just stopped answering. The receipt reader's own gap, for the same reasons.
 */
const RECORD_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive asks that answer nothing about the record before the seat gives up
 * on this run. Every unanswerable shape looks alike from the browser -- a job the
 * console forgot across a restart, a route erroring, a connection that stopped
 * reaching it -- so a bound is the only thing separating a blip the next ask
 * recovers from a console that will never answer for this run.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const RECORD_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * Ask the console where this job's record stands, re-asking while the ask
 * itself holds no answer.
 *
 * One ask determines every answer the console actually gives: the seat asks a
 * run that has already settled, so `available` and `none` cannot change and
 * asking again would tell it the same thing. Only the ask that comes back
 * with nothing cannot be left alone -- a hiccup at the moment the run
 * settles would otherwise hide the record of a disclosure for the whole life
 * of the seat, on the one surface that also offers to delete it.
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
