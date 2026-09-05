/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managedExchangeStore";
import {
  readDisclosureAccounting,
  resetDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import { DISCLOSURE_ACCOUNTING_VERSION } from "@psi/disclosureAccounting";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { disclosureRecord } from "../utils/disclosureFixtures";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// How the run surface drives the accounting read it owns: what the section shows
// while a read is in flight, and what it shows when one never lands. The read's
// own classification is the store suite's; what is pinned here is the surface's
// handling of it, which is why the store module is the one thing stubbed -- a
// read that hangs, and one that rejects, are states real IndexedDB will not
// produce on demand.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// Only the two entry points the surface drives are stubbed; the rest of the
// module stays real, since the run driver appends through it.
vi.mock("@psi/disclosureAccountingStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDisclosureAccounting: vi.fn(),
  resetDisclosureAccounting: vi.fn(),
}));

const reads = vi.mocked(readDisclosureAccounting);
const resets = vi.mocked(resetDisclosureAccounting);

/** A promise the test settles itself, standing in for a read still in flight. */
function deferredRead(): {
  promise: Promise<DisclosureAccountingRead>;
  resolve: (read: DisclosureAccountingRead) => void;
} {
  let settle: ((read: DisclosureAccountingRead) => void) | undefined;
  const promise = new Promise<DisclosureAccountingRead>((resolveWith) => {
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

/** A stored value this build refuses, so the surface stands on the recovery state
 * the reset is offered from. */
async function unreadable(): Promise<DisclosureAccountingRead> {
  const filed = await disclosureRecord();
  return {
    kind: "unreadable",
    stored: {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [{ ...filed, version: `${filed.version}-moved` }],
    },
  };
}

const app = createAppMount();

beforeEach(async () => {
  reads.mockReset();
  resets.mockReset();
  // The standing answer behind each test's own queued ones, so a read the test did
  // not stage lands as a state rather than as an undefined the effect calls
  // `.then` on.
  reads.mockResolvedValue({ kind: "none" });
  resets.mockResolvedValue(undefined);
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

/**
 * A re-read is asked for from two places -- after the destructive reset, and on an
 * explicit retry -- and both sit beside a control the operator must not press
 * twice. The section returns to its in-flight state so the previous verdict does
 * not sit under a button that looks like it did nothing.
 */
describe("a re-read of the accounting shows that it is under way", () => {
  test("the reset's re-read replaces the verdict it destroyed, not the buttons beside it", async () => {
    const created = await createManagedExchange(newExchange());
    const afterReset = deferredRead();
    reads
      .mockResolvedValueOnce(await unreadable())
      .mockReturnValueOnce(afterReset.promise);

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("button", { name: "Start a fresh accounting" }))
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();
    await page.getByRole("button", { name: "Delete these records" }).click();

    // The destructive step took, and the surface says the store is being read
    // again rather than standing on the verdict that step just invalidated.
    await expect
      .element(
        page.getByText("Reading this browser's copy of the accounting", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: /Download the stored records/ }).query(),
    ).toBeNull();

    afterReset.resolve({ kind: "none" });

    await expect
      .element(
        page.getByText("No run of this exchange has completed", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("the retry's re-read replaces the transient notice while it runs", async () => {
    const created = await createManagedExchange(newExchange());
    const afterRetry = deferredRead();
    reads
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockReturnValueOnce(afterRetry.promise);

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("button", { name: "Try reading it again" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Try reading it again" }).click();

    await expect
      .element(
        page.getByText("Reading this browser's copy of the accounting", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Try reading it again" }).query(),
    ).toBeNull();

    afterRetry.resolve({ kind: "none" });

    await expect
      .element(
        page.getByText("No run of this exchange has completed", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });
});

/**
 * The read classifies every failure rather than rejecting, so the rejection
 * handler is a safety check against that contract lapsing, not a second failure
 * path. It must not leave the section on its spinner with the rejection
 * unhandled.
 */
describe("a read that rejects rather than classifying", () => {
  test("lands on the transient state instead of stranding the spinner", async () => {
    const created = await createManagedExchange(newExchange());
    reads.mockRejectedValueOnce(new Error("the read contract lapsed"));

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    // The safe direction: it claims nothing about what is stored and offers no
    // destructive arm.
    await expect
      .element(page.getByText("could not be read right now", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("Reading this browser's copy of the accounting", {
          exact: false,
        })
        .query(),
    ).toBeNull();
  });
});
