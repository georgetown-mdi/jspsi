/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
} from "@bench/managedHandoffGate";
import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managedLocalState";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { CapturedDownload } from "./captureDownloads";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// Both hand-offs on the run surface spend this browser's copy of the shared
// secret, and a run rotates that secret at its handshake -- so the one thing
// that must not happen is a spend confirmed while a run of that exchange is in
// flight, which hands the new owner a copy the rotation has already superseded.
// Chromium is where this belongs: the record, its sibling state, and the input
// pointer the run reads are the real browser stores, and the export the confirm
// follows is the real one.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run driver is stubbed to a run the test itself ends, so the run is in
// flight for exactly as long as the assertions need and nothing dials a partner.
// It ends by rejecting: a failed run is the outcome that leaves the operator on
// the surface holding the confirmation, so the confirmation coming back is
// observable there rather than a by-product of the completion surface replacing
// the controls.
const liveRun = vi.hoisted(() => ({
  end: undefined as (() => void) | undefined,
}));
vi.mock("@psi/managedRunDriver", () => ({
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
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
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

const exportToggle = () =>
  page.getByRole("button", { name: /run this from the command line/i });

const gateNotice = () => page.getByText(RUN_IN_FLIGHT_HANDOFF_TITLE);

/** Start a run and wait for the surface to report it in flight. */
async function startRun(): Promise<void> {
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await expect
    .element(page.getByText(/Connecting to your partner/))
    .toBeInTheDocument();
}

/** Open the collapsed command-line panel and take its two downloads, leaving the
 * hand-off confirmation on screen awaiting the operator's attestation. */
async function dispatchCommandLineExport(
  captured: Array<CapturedDownload>,
): Promise<void> {
  await expect.element(exportToggle()).toBeInTheDocument();
  await exportToggle().click();
  await page
    .getByRole("button", { name: "Download psilink.yaml and .psilink.key" })
    .click();
  await vi.waitFor(() => {
    expect(captured).toHaveLength(2);
  });
  await expect
    .element(page.getByText("Confirm the hand-off."))
    .toBeInTheDocument();
}

beforeEach(async () => {
  liveRun.end = undefined;
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("a spend hand-off while a run of that exchange is in flight", () => {
  test("the command-line hand-off waits for the run, then confirms", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);

      const confirm = page.getByRole("button", {
        name: "I saved both files; hand off this exchange",
      });
      // With no run in flight the attestation is the operator's to give.
      await expect.element(confirm).toBeEnabled();
      await expect.element(gateNotice()).not.toBeInTheDocument();

      await startRun();

      await expect.element(confirm).toBeDisabled();
      await expect.element(gateNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RUN_IN_FLIGHT_HANDOFF_REASON))
        .toBeInTheDocument();
      // The gate is up because nothing was spent, not after the fact.
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();

      liveRun.end?.();

      await expect.element(confirm).toBeEnabled();
      await expect.element(gateNotice()).not.toBeInTheDocument();
      await confirm.click();

      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toMatchObject({
        handoff: "command-line",
      });
    } finally {
      downloads.restore();
    }
  });

  test("the move to another device waits for the run, then confirms", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await startRun();
      // The move is dispatched mid-run: its confirm screen replaces the run
      // controls, so the notice is the only thing naming the live run.
      await page
        .getByRole("button", { name: "Move to another device" })
        .click();
      await expect
        .element(page.getByText("Confirm the move"))
        .toBeInTheDocument();

      const confirm = page.getByRole("button", {
        name: "I saved the file; hand off this exchange",
      });
      await expect.element(confirm).toBeDisabled();
      await expect.element(gateNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RUN_IN_FLIGHT_HANDOFF_REASON))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();

      liveRun.end?.();

      await expect.element(confirm).toBeEnabled();
      await expect.element(gateNotice()).not.toBeInTheDocument();
      await confirm.click();

      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      downloads.restore();
    }
  });
});
