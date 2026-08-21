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
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The run surface's hand-off confirm, rendered against real Chromium (the record
// and its sibling stores are the real IndexedDB ones). What is pinned here is the
// custody the confirm states before this device gives up its copy: the artifact
// carries the secret, and it does NOT carry the accounting of disclosures, which
// stays behind with the device -- so the operator is told to export it first, the
// same warning the delete confirm carries.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The dispatch is stubbed to the state it leaves the surface in, so the confirm is
// reached without a real artifact download in the runner. The export itself, and
// the spend it defers until the operator confirms, are covered against the real
// store in managedExchangeBackup.test.ts.
vi.mock("@psi/managedExchangeExport", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchManagedMigration: () =>
      Promise.resolve({
        backedUpAt: new Date("2026-07-10T09:00:00.000Z"),
        confirm: () => Promise.resolve(),
      }),
  };
});

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("the hand-off confirm states what does not travel", () => {
  test("the confirm says the accounting stays behind, and to export it first", async () => {
    const created = await createManagedExchange(newExchange());

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("button", { name: "Move to another device" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Move to another device" }).click();

    await expect
      .element(page.getByText("Confirm the move"))
      .toBeInTheDocument();
    // The artifact's own custody line still stands, and the accounting's is beside
    // it: the exchange moves, its account of what it disclosed does not.
    await expect
      .element(
        page.getByText("Keep the file somewhere only you can read", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("does not travel in the backup file", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("export the accounting as CSV", { exact: false }))
      .toBeInTheDocument();
  });
});
