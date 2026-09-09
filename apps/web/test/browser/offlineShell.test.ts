/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { AppShellStatus } from "@components/AppShellStatus";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { SavedExchanges } from "@recurring/SavedExchanges";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { restoreConnectivity, setConnectivity } from "./connectivity";
import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// What the app does with no network, against real Chromium: the shell's accurate
// statement that it is offline, the recurring-exchange list rendering from the
// browser's own store with nothing fetched, and the one action that needs a
// connection saying so instead of failing opaquely when pressed.
//
// Chromium is where this belongs because the surfaces read real IndexedDB and the
// File System Access API, and because `navigator.onLine` and its events are the
// platform signal under test. The service worker that supplies the shell document
// itself is driven directly in test/unit/utils/serviceWorker.test.ts.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
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

/** A handle the run surface accepts as this exchange's input pointer. An OPFS
 * handle is a real FileSystemFileHandle and survives the structured clone the
 * record is stored through. */
async function inputHandle(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getFileHandle("managed-input.csv", { create: true });
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  restoreConnectivity();
  await clearManagedExchanges();
});

describe("the shell says what is unavailable", () => {
  // The offline title reads twice while the strip is up: the shell's polite
  // region announces it and the visible Alert is titled with it. The region is
  // rendered first, so `.last()` is the visible one.
  const offlineTitle = () => page.getByText("You are offline");

  test("an offline browser is told, and told what still works", async () => {
    setConnectivity(false);

    app.render(createElement(AppShellStatus));

    await expect.element(offlineTitle().last()).toBeVisible();
    await expect
      .element(page.getByText(/open without a connection/))
      .toBeInTheDocument();
    // The announcement lands in the region the shell already held, and the
    // visible strip has no live role that would voice it a second time.
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("You are offline");
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  test("nothing is said while the browser has a connection", async () => {
    setConnectivity(true);

    app.render(createElement(AppShellStatus));

    // The region stays mounted and empty through the ordinary case: one that
    // appears with its strip is a freshly inserted node rather than a change to
    // something an assistive technology is already observing.
    await vi.waitFor(() => {
      expect(app.container.querySelector('[role="status"]')).not.toBeNull();
    });
    expect(app.container.querySelector('[role="status"]')?.textContent).toBe(
      "",
    );
    // Nothing is said either way: neither strip stands, and neither title is
    // announced.
    expect(offlineTitle().query()).toBeNull();
    expect(
      page.getByText("A new version of psilink is ready").query(),
    ).toBeNull();
  });

  test("the notice clears when the connection comes back", async () => {
    setConnectivity(false);
    app.render(createElement(AppShellStatus));
    await expect.element(offlineTitle().last()).toBeVisible();

    setConnectivity(true);

    await expect.element(offlineTitle()).not.toBeInTheDocument();
    // The region outlives the flip, emptied rather than unmounted, so the next
    // strip is a change to it.
    await vi.waitFor(() => {
      const region = app.container.querySelector('[role="status"]');
      expect(region).not.toBeNull();
      expect(region?.textContent).toBe("");
    });
  });
});

describe("the recurring-exchange list with no network", () => {
  test("renders from the browser's own store", async () => {
    await createManagedExchange(newExchange());
    setConnectivity(false);

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
  });
});

describe("the run action with no network", () => {
  test("is held back and says why, and comes back with the connection", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    setConnectivity(false);

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeDisabled();
    await expect
      .element(page.getByText(/This device is offline/))
      .toBeInTheDocument();

    setConnectivity(true);

    await expect.element(runButton).toBeEnabled();
    await expect
      .element(page.getByText(/This device is offline/))
      .not.toBeInTheDocument();
  });
});
