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
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The surface's own wiring of the run's phase boundary, which no pure test can
// reach: the classification decides whether the operator is told nothing left this
// device, and it decides that from a flag this component sets in the callback it
// hands the driver. A regression to a literal value keeps every model test green,
// so the flag is driven here through the real component, against a driver that
// reports the boundary the way a real run does.
//
// The two directions are both pinned: a literal `false` would show the no-show
// state for the post-boundary run, and a literal `true` would show the neutral
// transport state for the pre-boundary one.

const phase = vi.hoisted(() => ({ dataExchangeStarted: false }));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to a run that fails with the no-show, having first
// reported the data-exchange boundary through the surface's own callback when the
// test asks for the post-boundary case. Nothing dials a partner, and nothing
// stamps the record: what the surface renders comes from the live error and this
// flag alone.
vi.mock("@psi/managedRunDriver", async () => {
  const { PartnerNoShowError } = await import("@psi/waitForConnection");
  return {
    runManagedExchangeInBrowser: (config: {
      options?: { onDataExchangeStart?: () => void };
    }) => {
      if (phase.dataExchangeStarted) config.options?.onDataExchangeStart?.();
      return Promise.reject(
        new PartnerNoShowError("timed out waiting for the other party"),
      );
    },
  };
});

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

const app = createAppMount();

/** Mount a saved exchange's run surface and press Run, leaving the stubbed run to
 * fail into the surface's classification. */
async function runUntilItFails(): Promise<void> {
  const created = await createManagedExchange(
    newExchange({ inputFileHandle: await inputHandle() }),
  );
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
}

beforeEach(async () => {
  phase.dataExchangeStarted = false;
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("the run surface reports its own data-exchange boundary", () => {
  test("a no-show before the boundary renders the no-show state", async () => {
    await runUntilItFails();

    await expect
      .element(page.getByText("Your partner did not arrive"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain("nothing left this device");
  });

  test("a no-show past the boundary renders the neutral transport state", async () => {
    // Payload could have flowed, so the run cannot attest that nothing left this
    // device -- whatever the error's own type says.
    phase.dataExchangeStarted = true;

    await runUntilItFails();

    await expect
      .element(page.getByText("The run could not be completed"))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "Your partner did not arrive",
    );
    expect(app.container.textContent).not.toContain("nothing left this device");
  });
});
