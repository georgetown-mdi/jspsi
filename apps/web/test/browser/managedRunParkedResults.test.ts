/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { PARKED_RESULTS_VERSION, runResultsFileName } from "@psi/parkedResults";
import {
  clearManagedExchanges,
  createManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { readParkedResults } from "@psi/parkedResultsStore";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { captureDownloads } from "./captureDownloads";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";

// How the run surface drives the parked-results read it owns: what the section
// shows while a read is in flight, that the retry offered where the store did
// not answer reaches the store again, and that a copy a hand-off spent still
// hands over what its earlier scheduled runs left. The read's own classification
// is the store suite's; the store module is stubbed here because a read that
// hangs, and one that never reaches the store, are states real IndexedDB will
// not produce on demand.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// Only the read the surface drives is stubbed; the rest of the module stays real.
vi.mock("@psi/parkedResultsStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readParkedResults: vi.fn(),
}));

const reads = vi.mocked(readParkedResults);

const RUN_AT = "2026-03-01T09:00:00.000Z";

/** The label the parked results file names are built from. */
const RESULTS_LABEL = "Riverbend quarterly";

/** The bytes a parked run's results hold, asserted back out of the download. */
const RESULTS_CSV = "id,county\nA-19,Riverbend\n";

/** A promise the test settles itself, standing in for a read still in flight. */
function deferredRead(): {
  promise: Promise<ParkedResultsRead>;
  resolve: (read: ParkedResultsRead) => void;
} {
  let settle: ((read: ParkedResultsRead) => void) | undefined;
  const promise = new Promise<ParkedResultsRead>((resolveWith) => {
    settle = resolveWith;
  });
  if (settle === undefined)
    throw new Error("the promise executor did not run synchronously");
  return { promise, resolve: settle };
}

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** One run's results, waiting to be collected. */
function parked(): ParkedResultsRead {
  return {
    kind: "parked",
    results: {
      version: PARKED_RESULTS_VERSION,
      entries: [
        {
          kind: "results",
          runAt: RUN_AT,
          fileName: runResultsFileName(RESULTS_LABEL, RUN_AT),
          csv: new Blob([RESULTS_CSV], { type: "text/csv" }),
          matchedRecordCount: 1,
        },
      ],
    },
  };
}

const app = createAppMount();

beforeEach(async () => {
  reads.mockReset();
  // The standing answer behind each test's own queued ones, so a read the test
  // did not stage lands as a state rather than as an undefined the effect calls
  // `.then` on.
  reads.mockResolvedValue({ kind: "none" });
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

/**
 * A read that never reached the store leaves the operator with no way back to it
 * short of leaving the page, which for this surface means ending a run. The retry
 * reads again in place, and the section returns to its in-flight state so the
 * notice does not sit under a button that looks like it did nothing.
 */
describe("a re-read of the parked results", () => {
  test("reaches the store again and replaces the transient notice while it runs", async () => {
    const created = await createManagedExchange(newExchange());
    const afterRetry = deferredRead();
    reads
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockReturnValueOnce(afterRetry.promise);

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("button", { name: "Try reading them again" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Try reading them again" }).click();

    await expect
      .element(
        page.getByText("Reading what this browser kept for you", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Try reading them again" }).query(),
    ).toBeNull();

    afterRetry.resolve(parked());

    // The second read's own answer, so the retry read the store rather than
    // re-rendering the first read's verdict.
    await expect
      .element(page.getByText("1 matched record", { exact: false }))
      .toBeInTheDocument();
    expect(reads).toHaveBeenCalledTimes(2);
  });
});

/**
 * A hand-off takes the exchange's future runs; it does not take the results its
 * earlier scheduled runs left at rest in this browser. Without this section the
 * spent surface would hold them for the rest of the retention with nothing
 * offering them, against copy telling the operator to collect them here.
 */
describe("a copy a hand-off spent", () => {
  async function spendNewExchange(): Promise<string> {
    const created = await createManagedExchange(newExchange());
    expect(
      await spendManagedExchangeIfCurrent(
        created.id,
        created.sharedSecret,
        "2026-03-02T10:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    return created.id;
  }

  test("hands over the results a scheduled run left before the hand-off", async () => {
    const downloads = captureDownloads();
    try {
      reads.mockResolvedValue(parked());
      const id = await spendNewExchange();

      app.render(createElement(ManagedRunSurface, { id }));

      await expect
        .element(page.getByText("This exchange was handed off"))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("1 matched record", { exact: false }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Download result" }).click();

      await downloads.settled();
      expect(downloads.captured).toHaveLength(1);
      expect(downloads.captured[0].fileName).toBe(
        runResultsFileName(RESULTS_LABEL, RUN_AT),
      );
      expect(downloads.captured[0].text).toBe(RESULTS_CSV);
    } finally {
      downloads.restore();
    }
  });

  test("shows no results section where no run left anything", async () => {
    reads.mockResolvedValue({ kind: "none" });
    const id = await spendNewExchange();

    app.render(createElement(ManagedRunSurface, { id }));

    await expect
      .element(page.getByText("This exchange was handed off"))
      .toBeInTheDocument();
    // The read has landed by here, so the absence is the empty state collapsing
    // rather than a section that has not rendered yet.
    await flushPendingUpdates();
    expect(page.getByText("Results from scheduled runs").query()).toBeNull();
    expect(
      page.getByRole("button", { name: "Download result" }).query(),
    ).toBeNull();
  });
});
