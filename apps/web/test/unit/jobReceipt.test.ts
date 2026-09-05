import { describe, expect, test } from "vitest";

import {
  RECEIPT_AVAILABILITY_UNANSWERED_LIMIT,
  askJobReceiptOffer,
  fetchJobReceiptOffer,
} from "@psi/jobReceipt";

import type { JobReceiptOffer } from "@psi/jobReceipt";

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

function offerFor(body: unknown): Promise<JobReceiptOffer> {
  return fetchJobReceiptOffer("job-1", statusResponse(body));
}

describe("fetchJobReceiptOffer", () => {
  test("an available receipt is offered on the record's stamped convention", async () => {
    // The stamp is the record downloads' own, so one exchange's artifacts file
    // together whichever of them the operator keeps.
    await expect(
      offerFor({
        receiptRequested: true,
        receiptAvailable: true,
        recordAvailable: true,
        recordCreatedAt: CREATED_AT,
      }),
    ).resolves.toEqual({
      kind: "available",
      receiptUrl: "/api/jobs/job-1/receipt",
      receiptFileName: `psilink-receipt-${RECORD_STAMP}.json`,
    });
  });

  test("an available receipt on a run with no record is stamped with the job id", async () => {
    // Core signs the receipt from the mutually-verifiable facts whether or not
    // this party's local record built, so the receipt survives a run the record
    // did not -- and there is no createdAt to stamp its name from.
    await expect(
      offerFor({
        receiptRequested: true,
        receiptAvailable: true,
        recordAvailable: false,
      }),
    ).resolves.toEqual({
      kind: "available",
      receiptUrl: "/api/jobs/job-1/receipt",
      receiptFileName: "psilink-receipt-job-1.json",
    });
  });

  test("a receipt the run asked for and does not have is stated, not omitted", async () => {
    await expect(
      offerFor({ receiptRequested: true, receiptAvailable: false }),
    ).resolves.toEqual({ kind: "missing" });
  });

  test("a run that asked for no receipt leaves the seat nothing to say", async () => {
    await expect(
      offerFor({ receiptRequested: false, receiptAvailable: false }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("only a literal true on either field answers", async () => {
    // A malformed frame must never report a receipt MISSING: that would state
    // something the body never established.
    for (const body of [
      {},
      { receiptRequested: "yes" },
      { receiptRequested: 1, receiptAvailable: 1 },
      null,
      "not the status body",
    ])
      await expect(offerFor(body)).resolves.toEqual({ kind: "none" });
  });

  test("an ask that fails or is refused is unanswered, not a run without a receipt", async () => {
    // None of these said this run has no receipt, and `none` renders as no
    // control at all, so folding them into it would hide a receipt the
    // console holds behind one failed request.
    const notFound: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    await expect(fetchJobReceiptOffer("job-1", notFound)).resolves.toEqual({
      kind: "unanswered",
    });

    const throwing: typeof fetch = () =>
      Promise.reject(new Error("status fetch failed"));
    await expect(fetchJobReceiptOffer("job-1", throwing)).resolves.toEqual({
      kind: "unanswered",
    });

    const unparseable: typeof fetch = () =>
      Promise.resolve(new Response("{", { status: 200 }));
    await expect(fetchJobReceiptOffer("job-1", unparseable)).resolves.toEqual({
      kind: "unanswered",
    });
  });

  test("the stamp comes from an available record only", async () => {
    // The record downloads are offered all-or-nothing off the same pair, so a
    // body holding a createdAt without availability is not a record this run
    // can be named after.
    await expect(
      offerFor({
        receiptAvailable: true,
        recordAvailable: false,
        recordCreatedAt: CREATED_AT,
      }),
    ).resolves.toMatchObject({
      receiptFileName: "psilink-receipt-job-1.json",
    });
  });
});

describe("the receipt ask's bound on a console that stops answering", () => {
  /** The console's own status body for a run that asked for a receipt. */
  const answered =
    (receiptAvailable: boolean, receiptRequested = true) =>
    () =>
      new Response(
        JSON.stringify({
          status: "failed",
          receiptRequested,
          receiptAvailable,
          recordAvailable: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

  /** An ask that has no answer about the receipt: the route erroring, which
   * is also how a job the console forgot across a restart reads. */
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

  test("a hiccup at settlement does not hide the receipt the console holds", async () => {
    // The run settles once, and the seat asks once when it does: a single
    // failure there would otherwise withhold the download for the life of the
    // seat, and withhold it silently.
    const { fetchImpl, asks } = scriptedFetch([unanswerable, answered(true)]);
    const waits: Array<number> = [];

    await expect(
      askJobReceiptOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toEqual({
      kind: "available",
      receiptUrl: "/api/jobs/job-1/receipt",
      receiptFileName: "psilink-receipt-job-1.json",
    });

    expect(asks()).toBe(2);
    // A real gap between the asks: one with none would burst at a console
    // that has just stopped answering.
    expect(waits).toHaveLength(1);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  test("a route that never answers ends in the state the seat can show", async () => {
    // A console that restarted and forgot the job answers this way for as
    // long as the seat is open, so an unbounded ask would ask until the operator
    // closed the tab and tell them nothing while it did.
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);
    const waits: Array<number> = [];

    await expect(
      askJobReceiptOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toEqual({ kind: "unanswered" });

    expect(asks()).toBe(RECEIPT_AVAILABILITY_UNANSWERED_LIMIT);
    expect(waits).toHaveLength(RECEIPT_AVAILABILITY_UNANSWERED_LIMIT - 1);
    // The operator waits through the bound before the seat says anything, so it
    // is a handful of asks rather than a patient retry budget.
    expect(RECEIPT_AVAILABILITY_UNANSWERED_LIMIT).toBeLessThanOrEqual(10);
  });

  test("a run that signed nothing is answered once, with no re-asks at all", async () => {
    // The common run answers `none` on the first ask and its answer cannot
    // change, so re-asking it would spend the console's status route to be
    // told the same thing.
    const { fetchImpl, asks } = scriptedFetch([answered(false, false)]);
    const waits: Array<number> = [];

    await expect(
      askJobReceiptOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toEqual({ kind: "none" });

    expect(asks()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a receipt the console says it does not hold is not re-asked either", async () => {
    // The seat asks a settled run, so `missing` is final: the file appears at
    // the signature swap or never.
    const { fetchImpl, asks } = scriptedFetch([answered(false)]);

    await expect(
      askJobReceiptOffer("job-1", new AbortController().signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toEqual({ kind: "missing" });

    expect(asks()).toBe(1);
  });

  test("an ask the caller stops leaves the seat with nothing to state", async () => {
    // The seat unmounts, or the run it was asking for is replaced by a retry's
    // new job, while the ask is waiting out its gap.
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);
    const controller = new AbortController();

    await expect(
      askJobReceiptOffer("job-1", controller.signal, {
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
      askJobReceiptOffer("job-1", controller.signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toEqual({ kind: "none" });

    expect(asks()).toBe(0);
  });
});
