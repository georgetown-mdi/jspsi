/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  PARKED_RESULTS_VERSION,
  parkedResultsFileName,
} from "@psi/parkedResults";
import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { readParkedResults } from "@psi/parkedResultsStore";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";

// How the run surface drives the parked-results read it owns: what the section
// shows while a read is in flight, and that the retry offered where the store did
// not answer reaches the store again. The read's own classification is the store
// suite's; the store module is stubbed here because a read that hangs, and one
// that never reaches the store, are states real IndexedDB will not produce on
// demand.

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
          fileName: parkedResultsFileName(RUN_AT),
          csv: new Blob(["id,county\nA-19,Riverbend\n"], { type: "text/csv" }),
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
