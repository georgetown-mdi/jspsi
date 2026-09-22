/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  openManagedExchangeDatabase,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import { SavedExchanges, SavedExchangesHome } from "@recurring/SavedExchanges";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { RETAKE_ACTION_LABEL } from "@recurring/managedRetakeModel";

import { createAppMount } from "./renderApp";

import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/** A stored record narrowed to the runnable shape these fixtures all have: every
 * record here is created with a shared secret, and the export, hand-off, and run
 * paths take the record type that holds one. */
async function createRunnableExchange(
  fields: Parameters<typeof createManagedExchange>[0],
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

// A read failure after a successful open (a corrupted or app-upgrade-invalidated
// record) must render the read-failed surface on both the home route (`/`) and
// the always-list route (`/saved`), never the quick path. Failure classification
// is unit-tested elsewhere; this file checks rendering, including the import
// affordance on this surface, the refusal case for an exchange handed off
// elsewhere, and the refusal for one whose saved state this build cannot read.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The store opens, but the record read rejects: the post-open read failure the load
// classifies as `failed`. The rest of the store module is left intact.
vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listManagedExchanges: () => Promise.reject(new Error("corrupt record")),
  };
});

const app = createAppMount();

afterEach(app.unmount);

describe("store opens but the read fails", () => {
  test("the home route shows the read-failed surface, not the quick path", async () => {
    app.render(createElement(SavedExchangesHome));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    // The lobby's one-off cards must not stand in for the loss.
    expect(
      page
        .getByRole("heading", { name: "Invite someone to exchange data" })
        .query(),
    ).toBeNull();
  });

  test("the always-list route shows the read-failed surface", async () => {
    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });

  // The read-failed surface is not a dead end: it includes the same
  // restore-from-backup import affordance the empty state has. The list read
  // rejects wholesale on any one bad record, so the import cannot mend the list,
  // but it still stores the exchange and routes straight to its run surface.
  test("the read-failed surface offers the restore-from-backup import", async () => {
    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Import an exchange", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Import a file" }))
      .toBeInTheDocument();
  });
});

describe("importing a backup of an exchange handed off from here", () => {
  // The operator's own older backup of an exchange this browser has since handed to
  // the command line. The file reads fine and the exchange is still here -- it just
  // runs somewhere else now -- so the refusal must not display as an unreadable file.

  beforeEach(async () => {
    await clearManagedExchanges();
  });

  afterEach(async () => {
    await clearManagedExchanges();
  });

  /** A stored exchange, its pre-hand-off backup bytes, and the command-line spend
   * that makes those bytes an artifact of a copy this browser gave away. */
  async function handedOffBackup(): Promise<string> {
    const record = await createRunnableExchange({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      new Date().toISOString(),
      "command-line",
    );
    return bytes;
  }

  test("names the exchange and the recovery it has, not a bad file", async () => {
    const bytes = await handedOffBackup();
    app.render(createElement(SavedExchanges));
    await expect
      .element(page.getByRole("button", { name: "Import a file" }))
      .toBeInTheDocument();

    await userEvent.upload(
      page.elementLocator(
        document.querySelector('input[type="file"]') as HTMLElement,
      ),
      new File([bytes], "psilink-managed-backup-2026-07-14.json", {
        type: "application/json",
      }),
    );

    await expect
      .element(page.getByText("That exchange was handed off"))
      .toBeInTheDocument();
    // The alert names the record the store still holds and the recovery it has.
    await expect
      .element(
        page.getByText('"Riverbend quarterly" is still here', { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(`choose "${RETAKE_ACTION_LABEL}"`, { exact: false }),
      )
      .toBeInTheDocument();
    // The file was read and understood, so the unreadable-file copy would be wrong.
    expect(
      page.getByText("That file could not be imported").query(),
    ).toBeNull();
  });
});

describe("importing a backup whose stored copy cannot be read here", () => {
  // The exchange is still in this browser, but the note it keeps beside it -- the
  // one recording whether the copy was handed off -- does not parse, so a hand-off
  // can be neither confirmed nor ruled out and nothing is imported. The file reads
  // fine, so this refusal must not display as an unreadable file either.

  beforeEach(async () => {
    await clearManagedExchanges();
  });

  afterEach(async () => {
    await clearManagedExchanges();
  });

  /** A stored exchange, its backup bytes, and a sibling entry this build's schema
   * refuses -- a hand-off route a newer build recorded. Bypasses the validating
   * write, as no supported path stores one. */
  async function unreadableCustodyBackup(): Promise<string> {
    const record = await createRunnableExchange({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const db = await openManagedExchangeDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          "readwrite",
        );
        transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(
          {
            spent: {
              spentAt: "2026-07-14T13:00:00.000Z",
              handoff: "a-route-this-build-does-not-know",
            },
          },
          record.id,
        );
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
    return bytes;
  }

  test("names this browser's stored copy and what to do, not a bad file", async () => {
    const bytes = await unreadableCustodyBackup();
    app.render(createElement(SavedExchanges));
    await expect
      .element(page.getByRole("button", { name: "Import a file" }))
      .toBeInTheDocument();

    await userEvent.upload(
      page.elementLocator(
        document.querySelector('input[type="file"]') as HTMLElement,
      ),
      new File([bytes], "psilink-managed-backup-2026-07-14.json", {
        type: "application/json",
      }),
    );

    await expect
      .element(
        page.getByText("Part of that exchange's stored copy could not be read"),
      )
      .toBeInTheDocument();
    // The alert names the store's own read and the exchange it could not read for.
    await expect
      .element(
        page.getByText(
          'This browser could not read the note it keeps beside "Riverbend quarterly"',
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("delete that exchange from the list on this page", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The file was read and understood, so the unreadable-file copy would be wrong.
    expect(
      page.getByText("That file could not be imported").query(),
    ).toBeNull();
  });
});
