/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  openManagedExchangeDatabase,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import {
  clearUnfiledExchangeFlag,
  flagUnfiledExchange,
  unfiledExchangeFlagged,
} from "@psi/unfiledDisclosureFlag";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";

/**
 * The last-resort marker for a run this browser could store nothing about, and
 * the one visit that is allowed to drop it.
 *
 * The flag names the exchange and nothing else, so the visit that shows it is
 * the only account of that run an operator ever gets. The run surface shows
 * nothing at all for an exchange that is missing, unloadable or spent, which is
 * why the drop belongs to the alert rather than to the visit: this suite drives
 * those branches against the real store and the real localStorage.
 */

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const FLAG_ALERT_TITLE =
  "At least one run of this exchange could not be recorded";

function newExchange(): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  };
}

/** Overwrite a record with a value this build's schema refuses, bypassing the
 * validating write path, so the surface loads the exchange the way it does after
 * an app upgrade it cannot follow. */
async function seedUnloadable(record: ManagedExchangeRecord): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_STORE_NAME)
        .put({ ...record, schemaVersion: 99 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const app = createAppMount();

beforeEach(clearManagedExchanges);

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("a flagged exchange whose page shows the operator nothing", () => {
  test("keeps its flag across a visit that cannot find it", async () => {
    const created = await createManagedExchange(newExchange());
    await deleteManagedExchange(created.id);
    expect(await flagUnfiledExchange(created.id)).toBe(true);

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(page.getByRole("heading", { name: "Exchange not found" }))
      .toBeInTheDocument();
    await flushPendingUpdates();

    // Nothing on this screen states the run, so dropping the flag here would
    // destroy the only trace of a disclosure unseen.
    expect(unfiledExchangeFlagged(created.id)).toBe(true);
    await clearUnfiledExchangeFlag(created.id);
  });

  test("keeps its flag across a visit that cannot load it", async () => {
    const created = await createManagedExchange(newExchange());
    await seedUnloadable(created);
    expect(await flagUnfiledExchange(created.id)).toBe(true);

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(
        page.getByRole("heading", { name: "This exchange cannot be loaded" }),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(unfiledExchangeFlagged(created.id)).toBe(true);
    await clearUnfiledExchangeFlag(created.id);
  });

  test("keeps its flag across a visit to a spent copy", async () => {
    const created = await createManagedExchange(newExchange());
    expect(
      await spendManagedExchangeIfCurrent(
        created.id,
        created.sharedSecret,
        "2026-07-14T09:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    expect(await flagUnfiledExchange(created.id)).toBe(true);

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(
        page.getByRole("heading", { name: "This exchange was handed off" }),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(unfiledExchangeFlagged(created.id)).toBe(true);
    await clearUnfiledExchangeFlag(created.id);
  });
});

describe("a flagged exchange whose page states the run", () => {
  test("drops the flag once the alert has rendered", async () => {
    const created = await createManagedExchange(newExchange());
    expect(await flagUnfiledExchange(created.id)).toBe(true);

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(page.getByText(FLAG_ALERT_TITLE, { exact: false }))
      .toBeInTheDocument();

    // The alert has no detail to come back to, so it is shown once: the flag goes
    // as it renders, and a second visit is not told again.
    await vi.waitFor(() =>
      expect(unfiledExchangeFlagged(created.id)).toBe(false),
    );

    app.unmount();
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(page.getByText("Accounting of disclosures"))
      .toBeInTheDocument();
    expect(
      page.getByText(FLAG_ALERT_TITLE, { exact: false }).query(),
    ).toBeNull();
  });
});
