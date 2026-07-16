/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import { SavedExchanges, SavedExchangesHome } from "@bench/SavedExchanges";
import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managedExchangeStore";
import {
  markManagedExchangeBackedUp,
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

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

describe("home route: conditional on a stored exchange existing", () => {
  test("populated -> the list surface renders at the home route", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    mount(createElement(SavedExchangesHome));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });

  test("empty -> the quick path renders at the home route, not an empty list", async () => {
    mount(createElement(SavedExchangesHome));

    // The first-run landing is the quick (invite/accept) path: its two primary
    // actions, not the list's designed empty state.
    await expect
      .element(page.getByRole("heading", { name: "Set up an exchange" }))
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

describe("saved list route: the always-list surface", () => {
  test("populated: a stored exchange appears as a runnable row", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });

  test("empty: the designed empty state, not a blank list", async () => {
    mount(createElement(SavedExchanges));

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
    mount(createElement(SavedExchanges));

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

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Backed up as of", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Back up this exchange"))
      .toBeInTheDocument();
  });

  test("a populated list offers the quick path as a one-off alternative", async () => {
    await createManagedExchange(newExchange());

    mount(createElement(SavedExchanges));

    const quick = page.getByRole("link", {
      name: "Set up or accept an exchange",
    });
    await expect.element(quick).toBeInTheDocument();
    expect((await quick.element()).getAttribute("href")).toBe("/quick");
  });

  test("a populated list offers a first-class create entry into the invite/configure flow", async () => {
    await createManagedExchange(newExchange());

    mount(createElement(SavedExchanges));

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

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("You invite", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("You accept", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("saved list route: delete is a first-class, always-available action", () => {
  test("delete confirms, then removes the exchange from the list", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    mount(createElement(SavedExchanges));

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

    mount(createElement(SavedExchanges));

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

    mount(createElement(SavedExchanges));

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

  test("a spent (handed-off) row offers Open and Delete", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "Handed off partnership" }),
    );
    await markManagedExchangeSpent(created.id, "2026-07-12T09:00:00.000Z");

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByRole("button", { name: "Open" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Delete" }))
      .toBeInTheDocument();
    // A spent row does not offer Run.
    expect(page.getByRole("button", { name: "Run" }).query()).toBeNull();
  });
});
