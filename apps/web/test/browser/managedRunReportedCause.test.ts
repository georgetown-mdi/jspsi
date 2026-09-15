/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { REPORTED_CAUSE_LABEL } from "@exchange/RunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// The recurring seat shows the transport state's reported cause, and what keeps
// a partner's or a network stack's sentence from reading as this application's
// account of the failure is where the sentence lands: under the label
// attributing it to the exchange, and outside the seat's own copy. A structural
// property, so the run below fails with a chain written in this application's
// voice -- the words that would mislead if they arrived unattributed.

/** The relayed chain the stubbed run fails with: its second link tells the
 * operator the run is safe to repeat, which is advice only this application is
 * in a position to give. */
const PLANTED_ADVICE = "it is safe to run this again";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runManagedExchangeInBrowser: () =>
      Promise.reject(
        new Error("the data channel closed", {
          cause: new Error(PLANTED_ADVICE),
        }),
      ),
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
 * button is live without a picker gesture the test cannot make. */
async function inputHandle(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getFileHandle("managed-input.csv", { create: true });
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

/** The mounted transport failure: the seat's own sentence, the label over the
 * report, and the report itself. */
async function failedRun(): Promise<{
  message: HTMLElement;
  label: HTMLElement;
  report: HTMLElement;
}> {
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
  return await vi.waitFor(() => {
    const label = [...app.container.querySelectorAll("p")].find(
      (node) => node.textContent === REPORTED_CAUSE_LABEL,
    );
    const message = [...app.container.querySelectorAll("span")].find((node) =>
      node.textContent.startsWith("This run could not be completed"),
    );
    if (label === undefined || message === undefined)
      throw new Error("the failure alert is not mounted with its report");
    const report = label.nextElementSibling;
    if (!(report instanceof HTMLElement))
      throw new Error("the label stands with no report after it");
    return { message, label, report };
  });
}

test("the transport state's cause stands under the label, not in the seat's own copy", async () => {
  const { message, label, report } = await failedRun();

  // There at all, or every placement assertion below passes on an alert showing
  // no report.
  expect(report.textContent).toContain(PLANTED_ADVICE);
  // The seat's sentence is whole and holds no byte of the report, so the advice
  // cannot be read as this application's.
  expect(message.textContent).toContain("temporary connection problem");
  expect(message.textContent).not.toContain(PLANTED_ADVICE);
  expect(message.contains(report)).toBe(false);
  // Down the alert in one order: the seat's copy, then the attribution, then
  // the words it attributes -- so a reading of the alert, visual or flattened
  // to one run by an assistive technology, meets the label before the report.
  for (const [above, below] of [
    [message, label],
    [label, report],
  ])
    expect(
      above.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
});
