/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { SavedExchanges, SavedExchangesHome } from "@bench/SavedExchanges";

import { createAppMount } from "./renderApp";

// The store-unavailable behavior, rendered, for both routes. When the managed
// store cannot be opened at all (storage blocked, no IndexedDB), the home
// route at `/` renders the quick path directly with no degrade banner, while
// the always-list route at `/saved` shows an explicit degrade message with a
// link to the quick path. Load ordering and classification are unit-tested
// elsewhere; this file checks rendering.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// Fail the store open -- the real failed-open the degrade classifies on. The rest of
// the store module is left intact (the list never reaches its reads).
vi.mock("@psi/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openManagedExchangeDatabase: () =>
      Promise.reject(new Error("storage blocked")),
  };
});

const app = createAppMount();

afterEach(app.unmount);

describe("store unavailable", () => {
  test("the home route renders the quick path directly, no degrade banner", async () => {
    app.render(createElement(SavedExchangesHome));

    // The one-off flow itself, not the list's degrade message.
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

    // No degrade banner on landing, and no error shown.
    expect(
      page
        .getByText("This browser cannot store recurring exchanges", {
          exact: false,
        })
        .query(),
    ).toBeNull();
  });

  test("the always-list route degrades with a clear message, not an error", async () => {
    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText("This browser cannot store recurring exchanges", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    const quick = page.getByRole("link", {
      name: "Set up or accept a one-off exchange",
    });
    await expect.element(quick).toBeInTheDocument();
    expect((await quick.element()).getAttribute("href")).toBe("/quick");

    // No error shown, and no empty-list affordances leaked through.
    expect(
      page.getByRole("button", { name: "Import a backup file" }).query(),
    ).toBeNull();
  });
});
