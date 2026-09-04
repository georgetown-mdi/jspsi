/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { SavedExchanges, SavedExchangesHome } from "@bench/SavedExchanges";
import {
  clearManagedExchanges,
  createManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managedExchangeStore";
import { BenchLobby } from "@bench/BenchLobby";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { markManagedExchangeBackedUp } from "@psi/managedLocalState";
import styles from "@bench/bench.module.css";

import { createAppMount } from "./renderApp";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";

// The component's delete goes through this module. It is mocked so the delete-failure
// test can make a single delete reject while every other case uses the real
// transaction; `deleteOverride`, when set, replaces the real delete for one test.
let deleteOverride: ((id: string) => Promise<void>) | undefined;
vi.mock("@psi/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realDelete = actual.deleteManagedExchange as (
    id: string,
  ) => Promise<void>;
  return {
    ...actual,
    deleteManagedExchange: (id: string) =>
      deleteOverride ? deleteOverride(id) : realDelete(id),
  };
});

// The managed-exchange list and its conditional home route, exercised against real
// Chromium (real IndexedDB and the sibling object store). The home route at `/`
// (SavedExchangesHome) is the management interface only once an exchange exists: a
// populated store renders the list, an empty store renders the quick path (the
// first-run landing), never an empty list at `/`. The canonical list route at `/saved`
// (SavedExchanges) always renders the full surface -- rows, the derived backup state's
// two values, the quick-path entry, and the designed first-run empty state's
// create/accept/import affordances. The unavailable degrade is a separate file (it
// mocks the store open); the pure load ordering and its failure classification are
// unit-tested without a database.

// Assert on hrefs rather than navigation: the router seam is stubbed to a plain
// anchor, so a rendered Link is an <a href> and useNavigate is a no-op.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

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

/** A daily cadence with a three-hour window, anchored `opensInMs` from the real
 * clock the list reads: negative puts the window's open in the past, so a window is
 * open right now; positive leaves it ahead. The list derives due-ness at render
 * against `Date.now()`, so the fixture is anchored to it rather than to a fixed
 * date that would drift into a different state. */
function schedule(
  opensInMs: number,
  overrides: Partial<ManagedExchangeSchedule> = {},
): ManagedExchangeSchedule {
  const anchor = new Date(Date.now() + opensInMs).toISOString();
  return {
    anchor,
    intervalDays: 1,
    windowSeconds: 10_800,
    nextWindow: anchor,
    consecutiveMisses: 0,
    ...overrides,
  };
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  deleteOverride = undefined;
  await clearManagedExchanges();
});

describe("home route: conditional on a stored exchange existing", () => {
  test("populated -> the list surface renders at the home route", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    app.render(createElement(SavedExchangesHome));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });

  test("empty -> the quick path renders at the home route, not an empty list", async () => {
    app.render(createElement(SavedExchangesHome));

    // The first-run landing is the quick (invite/accept) path: its two primary
    // actions, not the list's designed empty state.
    await expect
      .element(
        page.getByRole("heading", { name: "Invite someone to exchange data" }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("heading", {
          name: "Accept an invitation you were sent",
        }),
      )
      .toBeInTheDocument();

    // Neither the empty-list affordances nor any run rows leak into the home route.
    expect(
      page.getByRole("button", { name: "Import a backup file" }).query(),
    ).toBeNull();
    expect(
      page.getByText("You have none saved yet.", { exact: false }).query(),
    ).toBeNull();
    expect(page.getByRole("button", { name: "Run" }).query()).toBeNull();
  });
});

describe("lobby: the recurring-exchange pointer is gated on a saved exchange", () => {
  test("no saved exchange -> the restore-from-backup pointer stands, the run-again framing is withheld", async () => {
    app.render(createElement(BenchLobby));

    // The restore path must stay discoverable with nothing saved: a wholesale
    // eviction leaves no rows yet is exactly when a backup import matters.
    await expect
      .element(page.getByText("Cleared this browser", { exact: false }))
      .toBeInTheDocument();
    // Nothing to run again, so that framing is not offered.
    expect(
      page
        .getByText("Saved an exchange to run again?", { exact: false })
        .query(),
    ).toBeNull();
  });

  test("a saved exchange -> the run-again framing appears", async () => {
    await createManagedExchange(newExchange());

    app.render(createElement(BenchLobby));

    await expect
      .element(
        page.getByText("Saved an exchange to run again?", { exact: false }),
      )
      .toBeInTheDocument();
  });
});

describe("saved list route: the always-list surface", () => {
  test("populated: a stored exchange appears as a runnable row", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });

  test("empty: the designed empty state, not a blank list", async () => {
    app.render(createElement(SavedExchanges));

    // The empty state explains what a managed exchange is and offers create,
    // accept, and the standing import affordance.
    await expect
      .element(page.getByText("You have none saved yet.", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Set up a recurring exchange" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Accept it" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Import a backup file" }))
      .toBeInTheDocument();

    // No stale run rows leak into the empty state.
    expect(page.getByRole("button", { name: "Run" }).query()).toBeNull();
  });

  test("the empty state's create link points at the quick path, accept at the accept flow", async () => {
    app.render(createElement(SavedExchanges));

    const createLink = page.getByRole("link", {
      name: "Set up a recurring exchange",
    });
    await expect.element(createLink).toBeInTheDocument();
    expect((await createLink.element()).getAttribute("href")).toBe("/quick");
    const accept = page.getByRole("link", { name: "Accept it" });
    await expect.element(accept).toBeInTheDocument();
    expect((await accept.element()).getAttribute("href")).toBe("/accept");
  });

  test("a backed-up row reads the quiet green state; a fresh one reads backup-needed", async () => {
    const backedUp = await createManagedExchange(
      newExchange({ label: "Backed up partnership" }),
    );
    await markManagedExchangeBackedUp(backedUp.id, "2026-07-10T09:00:00.000Z");
    await createManagedExchange(newExchange({ label: "Fresh partnership" }));

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Backed up as of", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Back up this exchange"))
      .toBeInTheDocument();
  });

  test("a populated list offers the quick path as a one-off alternative", async () => {
    await createManagedExchange(newExchange());

    app.render(createElement(SavedExchanges));

    const quick = page.getByRole("link", {
      name: "Set up or accept an exchange",
    });
    await expect.element(quick).toBeInTheDocument();
    expect((await quick.element()).getAttribute("href")).toBe("/quick");
  });

  test("a populated list offers a first-class create entry into the invite/configure flow", async () => {
    await createManagedExchange(newExchange());

    app.render(createElement(SavedExchanges));

    const create = page.getByRole("link", {
      name: "Set up a recurring exchange",
    });
    await expect.element(create).toBeInTheDocument();
    expect((await create.element()).getAttribute("href")).toBe("/exchange");
  });

  test("the side facet is readable at a glance: an inviter and an acceptor row", async () => {
    await createManagedExchange(
      newExchange({ label: "Invited partnership", side: "inviter" }),
    );
    await createManagedExchange(
      newExchange({ label: "Accepted partnership", side: "acceptor" }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("You invite", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("You accept", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("saved list route: an agreed schedule surfaces its due-ness", () => {
  test("a window open right now is named as open on the row", async () => {
    await createManagedExchange(
      newExchange({
        label: "Scheduled partnership",
        schedule: schedule(-60 * 60 * 1000),
      }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Run window open now", { exact: false }))
      .toBeInTheDocument();
  });

  test("a window still ahead is named as the next one", async () => {
    await createManagedExchange(
      newExchange({
        label: "Scheduled partnership",
        schedule: schedule(2 * 60 * 60 * 1000),
      }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Next run window:", { exact: false }))
      .toBeInTheDocument();
  });

  test("a record with no schedule shows no window line at all", async () => {
    await createManagedExchange(newExchange({ label: "Attended partnership" }));

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Attended partnership"))
      .toBeInTheDocument();
    // The exact two phrasings the scheduled rows above are found by, so this
    // absence is those same queries returning nothing rather than a third one.
    expect(
      page.getByText("Run window open now", { exact: false }).query(),
    ).toBeNull();
    expect(
      page.getByText("Next run window:", { exact: false }).query(),
    ).toBeNull();
  });

  test("a single miss stays quiet: the row names the window and nothing else", async () => {
    await createManagedExchange(
      newExchange({
        label: "Drifting partnership",
        schedule: schedule(-60 * 60 * 1000, { consecutiveMisses: 1 }),
      }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Run window open now", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByText("check with your partner", { exact: false }).query(),
    ).toBeNull();
  });

  test("the second consecutive miss raises the coordination line, naming both checks", async () => {
    await createManagedExchange(
      newExchange({
        label: "Drifting partnership",
        schedule: schedule(-60 * 60 * 1000, { consecutiveMisses: 2 }),
      }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("2 scheduled runs in a row", { exact: false }))
      .toBeInTheDocument();
    // Both checks: the partner, and this device's own clock.
    await expect
      .element(page.getByText("check with your partner", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("this device's clock", { exact: false }))
      .toBeInTheDocument();
  });

  test("the coordination line is styled as caution, never as a failure", async () => {
    await createManagedExchange(
      newExchange({
        label: "Drifting partnership",
        schedule: schedule(-60 * 60 * 1000, { consecutiveMisses: 2 }),
      }),
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("2 scheduled runs in a row", { exact: false }))
      .toBeInTheDocument();
    // The escalation is a state to look into, not a failure: it takes the same
    // caution treatment the exchange's own surface renders it in, and the failure
    // red would make the miss surface the standing warning the design keeps it
    // from being (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they do not
    // auto-pause").
    expect(
      app.container.querySelector(`.${styles.statusLineWarn}`)?.textContent,
    ).toMatch(/2 scheduled runs in a row/);
    // The danger class reaches no part of the row, not just not this line.
    expect(app.container.innerHTML).not.toContain(styles.statusLineDanger);
  });
});

describe("saved list route: delete is a first-class, always-available action", () => {
  test("delete confirms, then removes the exchange from the list", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Delete" }).click();

    // The confirm names the exchange and says the partner is not notified.
    await expect
      .element(
        page.getByText('Delete "Riverbend quarterly"?', { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("your partner is not notified", { exact: false }))
      .toBeInTheDocument();

    // Confirm the delete: the modal's own Delete, scoped to the dialog so the row's
    // Delete (behind the overlay) is never the target.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();

    // The row is gone and the empty state stands in its place.
    await expect
      .element(page.getByText("You have none saved yet.", { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText("Riverbend quarterly").query()).toBeNull();
  });

  test("a backed-up exchange's confirm carries the exported-backup custody note", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Backed up partnership" }),
    );
    await markManagedExchangeBackedUp(created.id, "2026-07-10T09:00:00.000Z");

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Backed up as of", { exact: false }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect
      .element(
        page.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("remains a credential until the partnership rotates", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("a never-backed-up exchange's confirm carries no custody note", async () => {
    await createManagedExchange(newExchange({ label: "Fresh partnership" }));

    app.render(createElement(SavedExchanges));

    await page.getByRole("button", { name: "Delete" }).click();

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

  test("a command-line hand-off's confirm says the saved files keep running it", async () => {
    // The hand-off marks no backup, so the backed-up note cannot carry the custody
    // reminder for it: deleting this row leaves the CLI's two files and the schedule
    // the operator set around them running the exchange.
    const created = await createManagedExchange(
      newExchange({ label: "Handed off to cron" }),
    );
    await spendManagedExchangeIfCurrent(
      created.id,
      created.sharedSecret,
      "2026-07-12T09:00:00.000Z",
      "command-line",
    );

    app.render(createElement(SavedExchanges));

    await page.getByRole("button", { name: "Delete" }).click();

    await expect
      .element(
        page.getByText(
          "psilink.yaml and .psilink.key you saved still run this exchange",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("nor stops the runs you scheduled", { exact: false }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByText("A backup file you exported stays in your custody", {
          exact: false,
        })
        .query(),
    ).toBeNull();
  });

  test("a migration spend's confirm keeps the backup note, not the hand-off one", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Migrated partnership" }),
    );
    await markManagedExchangeBackedUp(created.id, "2026-07-12T08:00:00.000Z");
    await spendManagedExchangeIfCurrent(
      created.id,
      created.sharedSecret,
      "2026-07-12T09:00:00.000Z",
    );

    app.render(createElement(SavedExchanges));

    await page.getByRole("button", { name: "Delete" }).click();

    await expect
      .element(
        page.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByText("still run this exchange", { exact: false }).query(),
    ).toBeNull();
  });

  test("a spent (handed-off) row offers Open and Delete", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Handed off partnership" }),
    );
    await spendManagedExchangeIfCurrent(
      created.id,
      created.sharedSecret,
      "2026-07-12T09:00:00.000Z",
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByRole("button", { name: "Open" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Delete" }))
      .toBeInTheDocument();
    // A spent row does not offer Run.
    expect(page.getByRole("button", { name: "Run" }).query()).toBeNull();
    // A migration spend is the one an import brings back.
    await expect
      .element(page.getByText("Import the backup", { exact: false }))
      .toBeInTheDocument();
  });

  test("a command-line hand-off names its own recovery, not the import", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Handed off partnership" }),
    );
    await spendManagedExchangeIfCurrent(
      created.id,
      created.sharedSecret,
      "2026-07-12T09:00:00.000Z",
      "command-line",
    );

    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText("Handed off to the command line", { exact: false }),
      )
      .toBeInTheDocument();
    // The exported psilink.yaml and .psilink.key are not the artifact the import
    // flow accepts, so this row must not point the operator at one.
    expect(page.getByText("Import the backup", { exact: false }).query()).toBe(
      null,
    );
  });

  test("a rejected delete surfaces an error and leaves the row standing", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));
    // The delete rejects (a transaction abort, quota, or blocked open): the confirm
    // must not close silently over a row that is still there.
    deleteOverride = () => Promise.reject(new Error("delete failed"));

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();

    // The failure is visible, the modal stays open, and the row is still listed.
    await expect
      .element(
        page.getByText("Removing it from this browser failed", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The row's own label span still stands (exact, so the modal's "Delete
    // "Riverbend quarterly"?" copy is not what this matches).
    await expect
      .element(page.getByText("Riverbend quarterly", { exact: true }))
      .toBeInTheDocument();
  });

  test("reopening the confirm after a failed delete starts clean, and a retry succeeds", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));
    deleteOverride = () => Promise.reject(new Error("delete failed"));

    app.render(createElement(SavedExchanges));

    await page.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect
      .element(
        page.getByText("Removing it from this browser failed", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // Cancel the modal, then reopen it via the row's Delete button: the failure
    // from the last attempt must not carry over into the fresh confirm.
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Delete" }).click();

    expect(
      page
        .getByText("Removing it from this browser failed", { exact: false })
        .query(),
    ).toBeNull();
    await expect
      .element(
        page.getByText('Delete "Riverbend quarterly"?', { exact: false }),
      )
      .toBeInTheDocument();

    // Let a successful delete proceed to prove the retry path actually works.
    deleteOverride = undefined;
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();

    await expect
      .element(page.getByText("You have none saved yet.", { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText("Riverbend quarterly").query()).toBeNull();
  });
});
