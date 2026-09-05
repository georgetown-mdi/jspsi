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
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// A managed re-run is a live two-party session with no resumption, and the
// app-shell update notice renders its Reload button above every route -- so the
// one thing that must not happen is the page unloading out from under a run with
// nothing asking first. Chromium is where this belongs: `beforeunload` is the
// platform contract under test, and the surface reads real IndexedDB and a real
// File System Access handle to reach the run at all.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run driver is stubbed to a run the test itself ends, so the run is live for
// exactly as long as the assertions need and nothing dials a partner. It ends by
// rejecting -- a run that fails still leaves the surface, which is what makes the
// disarm assertion meaningful rather than a by-product of unmounting.
const liveRun = vi.hoisted(() => ({
  end: undefined as (() => void) | undefined,
}));
vi.mock("@psi/managed/managedRunDriver", () => ({
  runManagedExchangeInBrowser: () =>
    new Promise((_resolve, reject) => {
      liveRun.end = () => reject(new Error("the test ended the run"));
    }),
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

/** A handle the run surface accepts as this exchange's input pointer, so the run
 * button is live without a picker gesture the runner cannot make. */
async function inputHandle(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getFileHandle("managed-input.csv", { create: true });
}

/** Whether the page would ask the operator to confirm leaving: fire the event a
 * tab close, a reload, or a typed URL fires, and read whether anything cancelled
 * it. */
function unloadWouldBeConfirmed(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const app = createAppMount();

beforeEach(async () => {
  liveRun.end = undefined;
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("leaving the page during a managed re-run", () => {
  test("is confirmed while the run is live, and unguarded once it ends", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    // Nothing is at stake before the run, so nothing is asked.
    expect(unloadWouldBeConfirmed()).toBe(false);

    await runButton.click();

    await expect
      .element(page.getByText(/Connecting to your partner/))
      .toBeInTheDocument();
    expect(unloadWouldBeConfirmed()).toBe(true);

    liveRun.end?.();

    await expect
      .element(page.getByText(/Connecting to your partner/))
      .not.toBeInTheDocument();
    expect(unloadWouldBeConfirmed()).toBe(false);
  });
});
