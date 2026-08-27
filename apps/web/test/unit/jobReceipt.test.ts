import { describe, expect, test } from "vitest";

import { fetchJobReceiptOffer } from "@psi/jobReceipt";

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

  test("an ask that fails or is refused answers nothing about the receipt", async () => {
    const notFound: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    await expect(fetchJobReceiptOffer("job-1", notFound)).resolves.toEqual({
      kind: "none",
    });

    const throwing: typeof fetch = () =>
      Promise.reject(new Error("status fetch failed"));
    await expect(fetchJobReceiptOffer("job-1", throwing)).resolves.toEqual({
      kind: "none",
    });

    const unparseable: typeof fetch = () =>
      Promise.resolve(new Response("{", { status: 200 }));
    await expect(fetchJobReceiptOffer("job-1", unparseable)).resolves.toEqual({
      kind: "none",
    });
  });

  test("the stamp comes from an available record only", async () => {
    // The record downloads are offered all-or-nothing off the same pair, so a
    // body carrying a createdAt without availability is not a record this run
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
