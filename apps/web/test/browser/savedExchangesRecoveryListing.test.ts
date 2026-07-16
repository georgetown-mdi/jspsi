/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
} from "@psi/managedExchangeStore";
import {
  listManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managedLocalState";
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

/** Seed a corrupted sibling local-state value under a key, bypassing the validating
 * write, so a test can prove the diagnostic read treats an unparseable sibling
 * conservatively (backed up on doubt). */
async function rawLocalPut(id: string, value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(value, id);
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

describe("recovery listing: the delete confirm's backup custody note", () => {
  /** Seed a good record (so a readable recovery row exists to delete) beside a bad
   * one (so the surface is the read-failed one), run `seedState` to stamp any sibling
   * state on the good record BEFORE the single mount, then render the always-list
   * route. Returns the good record. Its row is first in store-key order (a hex-first
   * randomUUID sorts before "zzz-bad-record"), so the `.first()` Delete opens it. */
  async function mountReadFailedWith(
    label: string,
    seedState?: (id: string) => Promise<void>,
  ): Promise<Awaited<ReturnType<typeof createManagedExchange>>> {
    const good = await createManagedExchange(newExchange({ label }));
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "psilink-managed-exchange/v2",
    });
    if (seedState) await seedState(good.id);
    await expect(listManagedExchanges()).rejects.toThrow();
    mount(createElement(SavedExchanges));
    await expect
      .element(page.getByText(label === "" ? "(unnamed exchange)" : label))
      .toBeInTheDocument();
    return good;
  }

  test("marker present -> the custody note shows on the recovery confirm", async () => {
    await mountReadFailedWith("Backed up partnership", (id) =>
      markManagedExchangeBackedUp(id, "2026-07-10T09:00:00.000Z"),
    );

    await page.getByRole("button", { name: "Delete" }).first().click();
    await expect
      .element(
        page.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("marker absent -> the custody note is not shown on the recovery confirm", async () => {
    await mountReadFailedWith("Fresh partnership");

    await page.getByRole("button", { name: "Delete" }).first().click();
    await expect
      .element(page.getByText("your partner is not notified", { exact: false }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("A backup file you exported stays in your custody", {
          exact: false,
        })
        .query(),
    ).toBeNull();
  });

  test("an unparseable sibling entry -> the custody note shows (conservative on doubt)", async () => {
    // No bad record here: a corrupted sibling entry alone fails the strict local-state
    // read, which routes the surface to read-failed on its own. The diagnostic read
    // then treats that unparseable sibling conservatively -- backed up on doubt -- so
    // the good record's delete confirm carries the custody note.
    const good = await createManagedExchange(
      newExchange({ label: "Doubtful partnership" }),
    );
    await rawLocalPut(good.id, { backup: { backedUpAt: "not-an-instant" } });
    await expect(listManagedLocalState()).rejects.toThrow();

    mount(createElement(SavedExchanges));
    await expect
      .element(page.getByText("Doubtful partnership"))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Delete" }).first().click();
    await expect
      .element(
        page.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("an unlabeled readable entry's confirm reads 'Delete this exchange?', not the row's display text", async () => {
    // The row text is the display transform "(unnamed exchange)", but the confirm
    // must name the raw (empty) label, so the button's own empty-label branch fires.
    await mountReadFailedWith("");

    // The good (unlabeled) record's row is first; open its confirm.
    await page.getByRole("button", { name: "Delete" }).first().click();
    await expect
      .element(page.getByText("Delete this exchange?", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByText('Delete "(unnamed exchange)"?', { exact: false }).query(),
    ).toBeNull();
  });
});
