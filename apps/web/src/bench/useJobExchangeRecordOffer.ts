import { useEffect, useState } from "react";

import { askJobExchangeRecordOffer } from "@psi/jobExchangeRecord";

import type { JobExchangeRecordOffer } from "@psi/jobExchangeRecord";

/**
 * Where a seat's record ask stands: the answer once the appliance gave one, or
 * `asking` while the ask this seat put is still in flight.
 *
 * The two are kept apart because a seat that reads them alike reads an ask still
 * running as one that answered nothing -- and the answer decides whether a control
 * that DELETEs the run confirms first, on a run that may hold the record of a
 * disclosure. A seat with no ask to make (no appliance job, or a run the seat does
 * not ask about) is neither, and takes the `undefined` every consumer here already
 * carries.
 */
export type JobExchangeRecordOfferState =
  JobExchangeRecordOffer | { kind: "asking" };

/** The one `asking` value the hook hands out, so a render that has not changed
 * state does not hand its consumers a new object. */
const ASKING: JobExchangeRecordOfferState = { kind: "asking" };

/**
 * Ask the appliance where a console run's exchange record stands, once the run has
 * settled, and hold the answer for the seat.
 *
 * A hook rather than state inside the panel because two things on one seat turn on
 * the same answer, and a second ask to learn it twice would be a second request for
 * one fact: the panel that OFFERS the record ({@link ./RecordDownload}), and the
 * failure surface's recovery controls, which discard the run -- and the record with
 * it -- and so confirm first while one is standing untaken.
 *
 * `jobId` is undefined on a seat with no appliance job (a browser run, or a console
 * run before its job exists) and nothing is asked. `enabled` is the seat's own
 * gate: it passes false while the run has not settled -- the CLI writes the pair
 * near the end of a run, so an earlier ask could read a run mid-write as one with
 * no record -- and false again where the run's completion downloads already carry
 * the pair, which is the ordinary successful run and needs no second offer.
 *
 * The answer is held against the job it was asked for, so a seat handed a
 * different id (a retry creates a new job) asks for that run rather than showing
 * the previous one's.
 *
 * Until that answer lands the hook reports `asking` rather than nothing, so a
 * consumer can tell an ask in flight from a seat that never put one: the ask is
 * bounded but not instant, and on the failure it exists for -- an appliance that
 * stopped answering -- it runs for the whole of that bound.
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
  // jobId`: a seat with no appliance job passes `jobId` undefined, which that
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
