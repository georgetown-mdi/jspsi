import { useEffect, useState } from "react";

import { askJobExchangeRecordOffer } from "@psi/jobClient/jobExchangeRecord";

import type { JobExchangeRecordOffer } from "@psi/jobClient/jobExchangeRecord";

/**
 * Where a seat's record ask stands: the answer once the console gave one, or
 * `asking` while the ask this seat put is still in flight.
 *
 * The two are kept apart because a seat that reads them alike reads an ask still
 * running as one that answered nothing -- and the answer decides whether a control
 * that DELETEs the run confirms first, on a run that may hold the record of a
 * disclosure. A seat with no ask to make (no console job, or a run the seat does
 * not ask about) is neither, and takes the `undefined` every consumer here already
 * holds.
 */
export type JobExchangeRecordOfferState =
  JobExchangeRecordOffer | { kind: "asking" };

/** The one `asking` value the hook hands out, so a render that has not changed
 * state does not hand its consumers a new object. */
const ASKING: JobExchangeRecordOfferState = { kind: "asking" };

/**
 * Ask the console where a console run's exchange record stands, once the run has
 * settled, and hold the answer for the seat.
 *
 * A hook, not panel-local state: the same answer drives both the panel that
 * offers the record ({@link ./RecordDownload}) and the failure surface's
 * recovery controls, which must confirm before discarding a run that may hold
 * the record.
 *
 * `jobId` undefined means no console job, and nothing is asked. `enabled` gates
 * the ask: false while the run has not settled (the CLI writes the pair near the
 * end of a run, so an earlier ask would race the write), and false again once
 * the run's completion downloads already hold the pair.
 *
 * The answer is keyed to the job it was asked for, so a retry's new job id asks
 * again rather than showing the previous run's answer.
 *
 * The hook reports `asking`, not `undefined`, while the ask is in flight, so a
 * consumer can tell a bounded ask still running from a seat that never asked.
 */
export function useJobExchangeRecordOffer(
  jobId: string | undefined,
  enabled: boolean,
): JobExchangeRecordOfferState | undefined {
  const [resolved, setResolved] = useState<{
    jobId: string;
    offer: JobExchangeRecordOffer;
  }>();
  // Compared through an explicit presence test rather than `resolved?.jobId ===
  // jobId`: a seat with no console job passes `jobId` undefined, which that
  // shorthand would match against an unresolved ask.
  const answer =
    resolved !== undefined && resolved.jobId === jobId
      ? resolved.offer
      : undefined;

  useEffect(() => {
    if (!enabled || jobId === undefined || answer !== undefined) return;
    const controller = new AbortController();
    void askJobExchangeRecordOffer(jobId, controller.signal).then((asked) => {
      if (!controller.signal.aborted) setResolved({ jobId, offer: asked });
    });
    return () => {
      controller.abort();
    };
  }, [enabled, jobId, answer]);

  if (answer !== undefined) return answer;
  return enabled && jobId !== undefined ? ASKING : undefined;
}
