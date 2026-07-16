/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import {
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
} from "@psi/managedExchangeStore";
import { SavedExchanges } from "@bench/SavedExchanges";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The read-failed recovery listing, against real Chromium (real IndexedDB). Unlike
// savedExchangesFailed.test.ts, which mocks the strict read to always reject, this
// file seeds a genuinely unreadable record beside a good one: the strict list read
// rejects wholesale on the bad record (the untouched contract), which routes both
// routes to the read-failed surface, and the surface's diagnostic read -- which never
// rejects wholesale -- lists both stored entries, each with the one-step
// delete-by-key. Deleting the offending record and reloading recovers the now-readable
// list to the normal run surface.

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to?: string;
    children?: ReactNode;
    [prop: string]: unknown;
  }) =>
    createElement(
      "a",
      { ...rest, href: typeof to === "string" ? to : "#" },
      children,
    ),
  useNavigate: () => () => undefined,
}));

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

/** Seed an arbitrary raw value under a key, so a test can plant a future-version
 * record the strict read rejects but the diagnostic read still enumerates. */
async function rawPut(value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  await clearManagedExchanges();
});

describe("read-failed recovery listing", () => {
  test("lists the readable record and the unreadable one, then delete-and-reload recovers", async () => {
    const good = await createManagedExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    // A key that sorts after any hex-first randomUUID, so the unreadable row is
    // deterministically last in the store-key-ordered listing (the delete below
    // targets the last row).
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });
    // Precondition: the strict list read rejects wholesale on the bad record.
    await expect(listManagedExchanges()).rejects.toThrow();

    mount(createElement(SavedExchanges));

    // The read-failed surface stands, and the recovery listing shows both entries.
    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Unreadable record"))
      .toBeInTheDocument();

    // Delete the unreadable record. Two Delete buttons in the listing (one per
    // entry); the unreadable row is the second, seeded after the good one.
    const deletes = page.getByRole("button", { name: "Delete" }).all();
    await deletes[deletes.length - 1].click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();

    // With the offending record gone, the reload recovers to the normal run
    // surface: the good record renders as a runnable row.
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
    expect(page.getByText("Unreadable record").query()).toBeNull();
  });

  test("the recovery listing never renders the stored secret", async () => {
    const good = await createManagedExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    // The secret must not appear anywhere on the recovery surface.
    expect(document.body.textContent).not.toContain(good.sharedSecret);
  });
});
