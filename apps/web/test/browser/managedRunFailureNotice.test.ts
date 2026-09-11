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
import { STOPPED_DISCLOSURE_NOT_FILED_WARNING } from "@psi/managed/managedRunDriver";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// A run that stopped after sending raises its own notice when the disclosure
// could not be filed, and then fails. The notice has to reach the operator on the
// state that run lands in: the completion surface that renders the run's notices
// is the one surface such a run never gets to, so a failed run that dropped them
// would leave the accounting's own promise -- every run that sent your payload
// files its record here, and warns you if it cannot -- unkept.

const raised = vi.hoisted(() => ({ notice: "" }));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to the shape of a run cut past its payload send: the
// notice through the caller's own slot, then the failure. Nothing dials a
// partner, and the notice is the driver's real constant rather than a literal.
vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runManagedExchangeInBrowser: (config: {
      options?: { onDataExchangeStart?: () => void };
      onWarning?: (message: string) => void;
    }) => {
      config.options?.onDataExchangeStart?.();
      if (raised.notice !== "") config.onWarning?.(raised.notice);
      return Promise.reject(new Error("the data channel closed"));
    },
  };
});

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
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

/** Mount a saved exchange's run surface and press Run, returning once the stubbed
 * run has failed into the surface's classification. */
async function runUntilItFails(): Promise<void> {
  const created = await createManagedExchange(
    newExchange({ inputFileHandle: await inputHandle() }),
  );
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await expect
    .element(page.getByText("The run could not be completed"))
    .toBeInTheDocument();
}

beforeEach(async () => {
  raised.notice = "";
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("a notice raised by a run that then failed", () => {
  test("shows beside the failure, so a disclosure that could not be filed is not lost with the run", async () => {
    raised.notice = STOPPED_DISCLOSURE_NOT_FILED_WARNING;

    await runUntilItFails();

    await expect
      .element(
        page.getByText(
          "could not be saved to this exchange's accounting of disclosures",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    // Beside the failure, not instead of it: the run still reports what went
    // wrong with the run itself.
    expect(app.container.textContent).toContain("The run could not be");
    expect(app.container.textContent).not.toContain("Run complete");
  });

  test("leaves the failure alone on a run that raised none", async () => {
    await runUntilItFails();

    expect(app.container.textContent).not.toContain(
      "accounting of disclosures",
    );
  });
});
