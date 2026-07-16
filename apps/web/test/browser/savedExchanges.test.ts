/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managedExchangeStore";
import { SavedExchanges } from "@bench/SavedExchanges";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { markManagedExchangeBackedUp } from "@psi/managedLocalState";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The managed-exchange home list, exercised against real Chromium (real IndexedDB
// and the sibling object store): the loading -> populated and loading -> empty
// transitions, the derived backup state rendering both of its values, the quick-path
// entry, and the first-run empty state's create/accept/import affordances. The
// unavailable degrade is a separate file (it mocks the store open); the pure load
// ordering and its failure classification are unit-tested without a database.

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

describe("managed exchange home list", () => {
  test("loading -> populated: a stored exchange appears as a runnable row", async () => {
    await createManagedExchange(newExchange({ label: "Riverbend quarterly" }));

    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });

  test("loading -> empty: the designed empty state, not a blank list", async () => {
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
});
