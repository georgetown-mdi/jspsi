import { describe, expect, test } from "vitest";

import {
  RECORD_AVAILABILITY_UNANSWERED_LIMIT,
  askJobExchangeRecordOffer,
  fetchJobExchangeRecordOffer,
  jobRecordDownloads,
} from "@psi/jobExchangeRecord";

import type { JobExchangeRecordOffer } from "@psi/jobExchangeRecord";

const CREATED_AT = "2026-07-08T14:32:00.000Z";
const RECORD_STAMP = "2026-07-08T14-32-00-000Z";

/** A fetch answering every request with `body` as a 200 JSON status body. */
const statusResponse =
  (body: unknown): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

function offerFor(body: unknown): Promise<JobExchangeRecordOffer> {
  return fetchJobExchangeRecordOffer("job-1", statusResponse(body));
}

describe("jobRecordDownloads", () => {
  test("names both files on the record's own stamped convention", () => {
    // The same stamp the in-browser path puts on its blobs, so one exchange's
    // artifacts file together whichever seat produced them.
    expect(jobRecordDownloads("job-1", CREATED_AT)).toEqual({
      recordUrl: "/api/jobs/job-1/record",
      recordFileName: `psilink-record-${RECORD_STAMP}.json`,
      keysUrl: "/api/jobs/job-1/keys",
      keysFileName: `psilink-record-${RECORD_STAMP}.keys.json`,
    });
  });
});

describe("fetchJobExchangeRecordOffer", () => {
  test("a terminated run's record is offered with the outcome it states", () => {
    // The run this reader exists for: it disclosed, then stopped, so it reaches
    // the seat as a failure with no completion downloads at all -- and the
    // appliance's answer is the only thing that says the record is there.
    return expect(
      offerFor({
        status: "failed",
        recordAvailable: true,
        recordCreatedAt: CREATED_AT,
        recordOutcome: "receipt-swap-terminated",
      }),
    ).resolves.toEqual({
      kind: "available",
      outcome: "receipt-swap-terminated",
      downloads: jobRecordDownloads("job-1", CREATED_AT),
    });
  });

  test("a completed run's record carries its own outcome, not a default", async () => {
    // The two are offered differently -- a terminated record's keys have nothing
    // to open -- so the value is carried through rather than inferred from the
    // run's status.
    await expect(
      offerFor({
        status: "succeeded",
        recordAvailable: true,
        recordCreatedAt: CREATED_AT,
        recordOutcome: "completed",
      }),
    ).resolves.toMatchObject({ kind: "available", outcome: "completed" });
  });

  test("a run the appliance holds no record for leaves the seat nothing to say", async () => {
    // A failure before the disclosure owes no record and wrote none. The seat
    // renders nothing rather than stating an absence it cannot name.
    await expect(
      offerFor({ status: "failed", recordAvailable: false }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("all three fields must answer together", async () => {
    // The appliance offers the pair all-or-nothing, so a partial body is not a
    // half-offer: it is no offer. An unrecognized outcome is refused for the same
    // reason -- the seat would have to guess which framing to put on the download.
    for (const body of [
      {},
      { recordAvailable: true },
      { recordAvailable: true, recordCreatedAt: CREATED_AT },
      { recordAvailable: true, recordOutcome: "completed" },
      {
        recordAvailable: "yes",
        recordCreatedAt: CREATED_AT,
        recordOutcome: "completed",
      },
      {
        recordAvailable: true,
        recordCreatedAt: 1,
        recordOutcome: "completed",
      },
      {
        recordAvailable: true,
        recordCreatedAt: CREATED_AT,
        recordOutcome: "who-knows",
      },
      null,
      "not the status body",
    ])
      await expect(offerFor(body)).resolves.toEqual({ kind: "none" });
  });

  test("an ask that fails or is refused is unanswered, not a run without a record", async () => {
    // None of these said this run has no record, and `none` renders as nothing at
    // all, so folding them into it would hide the record of a disclosure -- on the
    // one surface that also offers to delete it.
    const notFound: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    await expect(
      fetchJobExchangeRecordOffer("job-1", notFound),
    ).resolves.toEqual({ kind: "unanswered" });

    const throwing: typeof fetch = () =>
      Promise.reject(new Error("status fetch failed"));
    await expect(
      fetchJobExchangeRecordOffer("job-1", throwing),
    ).resolves.toEqual({ kind: "unanswered" });

    const unparseable: typeof fetch = () =>
      Promise.resolve(new Response("{", { status: 200 }));
    await expect(
      fetchJobExchangeRecordOffer("job-1", unparseable),
    ).resolves.toEqual({ kind: "unanswered" });
  });
});

describe("the record ask's bound on an appliance that stops answering", () => {
  /** The appliance's own status body for a terminated run. */
  const answered = (recordAvailable: boolean) => () =>
    new Response(
      JSON.stringify({
        status: "failed",
        recordAvailable,
        ...(recordAvailable
          ? {
              recordCreatedAt: CREATED_AT,
              recordOutcome: "receipt-swap-terminated",
            }
          : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  /** An ask that carries no answer about the record: the route erroring, which is
   * also how a job the appliance forgot across a restart reads. */
  const unanswerable = () => new Response("", { status: 503 });

  /** A status endpoint answering each successive ask with the next entry of the
   * script, holding the last once it runs out, and counting what it was asked. */
  function scriptedFetch(script: Array<() => Response>): {
    fetchImpl: typeof fetch;
    asks: () => number;
  } {
    let asked = 0;
    const fetchImpl: typeof fetch = () => {
      const answer = script[Math.min(asked, script.length - 1)];
      asked += 1;
      return Promise.resolve(answer());
    };
    return { fetchImpl, asks: () => asked };
  }

  /** The ask's gap between re-asks, recorded and not waited through, so a test
   * still sees that it paced itself. */
  const recordWaits =
    (waits: Array<number>) =>
    (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };

  const noWait = () => Promise.resolve();

  test("a hiccup at settlement does not hide the record the appliance holds", async () => {
    // The run settles once and the seat asks once when it does, so a single
    // failure there would withhold the download for the life of the seat -- while
    // the recovery controls beside it delete the file.
    const { fetchImpl, asks } = scriptedFetch([unanswerable, answered(true)]);
    const waits: Array<number> = [];

    await expect(
      askJobExchangeRecordOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toMatchObject({
      kind: "available",
      outcome: "receipt-swap-terminated",
    });

    expect(asks()).toBe(2);
    // A real gap between the asks: one with none would burst at an appliance that
    // has just stopped answering.
    expect(waits).toHaveLength(1);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  test("a route that never answers ends in the state the seat can show", async () => {
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);
    const waits: Array<number> = [];

    await expect(
      askJobExchangeRecordOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toEqual({ kind: "unanswered" });

    expect(asks()).toBe(RECORD_AVAILABILITY_UNANSWERED_LIMIT);
    expect(waits).toHaveLength(RECORD_AVAILABILITY_UNANSWERED_LIMIT - 1);
    // The operator waits through the bound before the seat says anything, so it is
    // a handful of asks rather than a patient retry budget.
    expect(RECORD_AVAILABILITY_UNANSWERED_LIMIT).toBeLessThanOrEqual(10);
  });

  test("an answered run is asked once, with no re-asks at all", async () => {
    // The seat asks a settled run, so the appliance's answer cannot change and
    // re-asking would spend its status route to be told the same thing.
    const { fetchImpl, asks } = scriptedFetch([answered(false)]);
    const waits: Array<number> = [];

    await expect(
      askJobExchangeRecordOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toEqual({ kind: "none" });

    expect(asks()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("an ask the caller stops leaves the seat with nothing to state", async () => {
    // The seat unmounts, or the run it was asking for is replaced by a retry's new
    // job, while the ask is waiting out its gap.
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);
    const controller = new AbortController();

    await expect(
      askJobExchangeRecordOffer("job-1", controller.signal, {
        fetchImpl,
        delay: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual({ kind: "none" });

    expect(asks()).toBe(1);
  });

  test("an already-stopped ask asks nothing at all", async () => {
    const { fetchImpl, asks } = scriptedFetch([answered(true)]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      askJobExchangeRecordOffer("job-1", controller.signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toEqual({ kind: "none" });

    expect(asks()).toBe(0);
  });
});
