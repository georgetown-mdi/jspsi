import { useEffect, useState } from "react";

import { askJobExchangeRecordOffer } from "@psi/jobExchangeRecord";

import type { JobExchangeRecordOffer } from "@psi/jobExchangeRecord";

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
 */
export function useJobExchangeRecordOffer(
  jobId: string | undefined,
  enabled: boolean,
): JobExchangeRecordOffer | undefined {
  const [resolved, setResolved] = useState<{
    jobId: string;
    offer: JobExchangeRecordOffer;
  }>();
  // Compared through an explicit presence test rather than `resolved?.jobId ===
  // jobId`: a seat with no appliance job passes `jobId` undefined, which that
  // shorthand would match against an unresolved ask.
  const offer =
    resolved !== undefined && resolved.jobId === jobId
      ? resolved.offer
      : undefined;

  useEffect(() => {
    if (!enabled || jobId === undefined || offer !== undefined) return;
    const controller = new AbortController();
    void askJobExchangeRecordOffer(jobId, controller.signal).then((asked) => {
      if (!controller.signal.aborted) setResolved({ jobId, offer: asked });
    });
    return () => {
      controller.abort();
    };
  }, [enabled, jobId, offer]);

  return offer;
}
