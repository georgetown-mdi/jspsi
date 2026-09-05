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
import { AppShellStatus } from "@components/AppShellStatus";
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { SavedExchanges } from "@bench/SavedExchanges";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { restoreConnectivity, setConnectivity } from "./connectivity";
import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// What the app does with no network, against real Chromium: the shell's accurate
// statement that it is offline, the recurring-exchange list rendering from the
// browser's own store with nothing fetched, and the one action that needs a
// connection saying so instead of failing opaquely when pressed.
//
// Chromium is where this belongs because the surfaces read real IndexedDB and the
// File System Access API, and because `navigator.onLine` and its events are the
// platform signal under test. The service worker that supplies the shell document
// itself is driven directly in test/unit/serviceWorker.test.ts.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
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
  test("an offline browser is told, and told what still works", async () => {
    setConnectivity(false);

    app.render(createElement(AppShellStatus));

    await expect.element(page.getByText("You are offline")).toBeInTheDocument();
    await expect
      .element(page.getByText(/open without a connection/))
      .toBeInTheDocument();
  });

  test("nothing is said while the browser has a connection", () => {
    setConnectivity(true);

    app.render(createElement(AppShellStatus));

    expect(app.container.textContent).toBe("");
  });

  test("the notice clears when the connection comes back", async () => {
    setConnectivity(false);
    app.render(createElement(AppShellStatus));
    await expect.element(page.getByText("You are offline")).toBeInTheDocument();

    setConnectivity(true);

    await expect
      .element(page.getByText("You are offline"))
      .not.toBeInTheDocument();
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
