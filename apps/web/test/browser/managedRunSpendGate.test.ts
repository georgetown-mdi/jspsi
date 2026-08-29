/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_REASON,
  SUPERSEDED_HANDOFF_TITLE,
} from "@bench/managedHandoffGate";
import {
  clearManagedExchanges,
  createManagedExchange,
  persistManagedExchangeRotation,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managedLocalState";
import { managedExchangeLockName } from "@psi/managedExchangeRun";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { CapturedDownload } from "./captureDownloads";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// Both hand-offs on the run surface spend this browser's copy of the shared secret,
// and a run rotates that secret at its handshake -- so the one thing that must not
// happen is a spend that hands over a copy the rotation has already superseded. Two
// mechanisms are measured here and they are not interchangeable: the CONFIRMATION
// re-reads the record and refuses a superseded artifact, whatever any UI saw, and
// the SURFACE withholds the hand-offs while a run is in flight in any context, so
// the refusal is rarely how the operator learns of the run. Chromium is where this
// belongs: the record, its sibling state, and the run lock the surface polls are the
// real browser ones, and the export the confirm follows is the real one.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run driver is stubbed to a run the test itself ends, so the run is in flight
// for exactly as long as the assertions need and nothing dials a partner. It keeps
// the two things about a real run this file turns on: the single-writer lock taken
// over the rotation, and the rotated secret persisted durably BEFORE the data
// exchange (managedExchangeRun.ts, "Persist-before-success") -- which is what makes
// an artifact downloaded before the run stale the moment the run gets going. It ends
// by rejecting: a failed run is the outcome that leaves the operator on the surface
// still holding the confirmation, so the confirmation coming back is observable there
// rather than a by-product of the completion surface replacing the controls.
const liveRun = vi.hoisted(() => ({
  end: undefined as (() => void) | undefined,
}));
vi.mock("@psi/managedRunDriver", () => ({
  runManagedExchangeInBrowser: async ({
    record,
  }: {
    record: { id: string };
  }) => {
    const store = await import("@psi/managedExchangeStore");
    const run = await import("@psi/managedExchangeRun");
    const core = await import("@psilink/core");
    await run.withManagedExchangeLock(
      record.id,
      () =>
        store.persistManagedExchangeRotation(record.id, {
          sharedSecret: core.generateSharedSecret(),
          expires: null,
        }),
      { ifAvailable: true },
    );
    return new Promise((_resolve, reject) => {
      liveRun.end = () => reject(new Error("the test ended the run"));
    });
  },
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

const downloadButton = () =>
  page.getByRole("button", { name: "Download psilink.yaml and .psilink.key" });

const migrateButton = () =>
  page.getByRole("button", { name: "Move to another device" });

const cronConfirm = () =>
  page.getByRole("button", {
    name: "I saved both files; hand off this exchange",
  });

const migrationConfirm = () =>
  page.getByRole("button", {
    name: "I saved the file; hand off this exchange",
  });

// Each notice is matched on its heading exactly: the superseded reason closes on the
// same words its heading opens with, so a loose match resolves to both.
const waitNotice = () =>
  page.getByText(RUN_IN_FLIGHT_HANDOFF_TITLE, { exact: true });

const supersededNotice = () =>
  page.getByText(SUPERSEDED_HANDOFF_TITLE, { exact: true });

// The in-flight reading behind the gate is a poll of the record's run lock, so an
// assertion on a state a lock change produces waits out one poll interval rather
// than the locator default.
const afterPoll = { timeout: 4000 };

/** Start a run and wait until it is in flight PAST its rotation: the stub publishes
 * its end handle only once the rotated secret is durably persisted, which is the
 * instant that supersedes anything downloaded before the run. */
async function startRun(): Promise<void> {
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await expect
    .element(page.getByText(/Connecting to your partner/))
    .toBeInTheDocument();
  await vi.waitFor(() => {
    expect(liveRun.end).toBeDefined();
  });
}

/** End the stubbed run and wait for the surface to come out of its running state. */
async function endRun(): Promise<void> {
  liveRun.end?.();
  await expect
    .element(page.getByText(/Connecting to your partner/), afterPoll)
    .not.toBeInTheDocument();
}

/** Open the collapsed command-line panel and take its two downloads, leaving the
 * hand-off confirmation on screen awaiting the operator's attestation. */
async function dispatchCommandLineExport(
  captured: Array<CapturedDownload>,
): Promise<void> {
  const before = captured.length;
  await expect.element(exportToggle()).toBeInTheDocument();
  if (exportToggle().element().getAttribute("aria-expanded") === "false")
    await exportToggle().click();
  await downloadButton().click();
  await vi.waitFor(() => {
    expect(captured).toHaveLength(before + 2);
  });
  await expect
    .element(page.getByText("Confirm the hand-off."))
    .toBeInTheDocument();
}

/** Hold this record's run+rotate lock the way a second tab's run or the scheduled
 * runtime does, until the returned release is called. */
async function holdRunLockElsewhere(id: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((granted) => {
    void navigator.locks.request(managedExchangeLockName(id), () => {
      granted();
      return untilReleased;
    });
  });
  return release;
}

beforeEach(async () => {
  liveRun.end = undefined;
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("a hand-off across a run of the same exchange", () => {
  test("the command-line hand-off waits for the run, then refuses what it superseded", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);

      // With no run in flight the attestation is the operator's to give.
      await expect.element(cronConfirm()).toBeEnabled();
      await expect.element(waitNotice()).not.toBeInTheDocument();

      await startRun();

      await expect.element(cronConfirm(), afterPoll).toBeDisabled();
      await expect.element(waitNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RUN_IN_FLIGHT_HANDOFF_REASON).first())
        .toBeInTheDocument();
      // The wait is up because nothing was spent, not after the fact.
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();

      await endRun();

      // The wait is over, but the files on the operator's disk are not this
      // exchange's any more: attesting to them is refused, and spends nothing.
      await expect.element(cronConfirm(), afterPoll).toBeEnabled();
      await cronConfirm().click();

      await expect.element(supersededNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(SUPERSEDED_HANDOFF_REASON))
        .toBeInTheDocument();
      await expect.element(cronConfirm()).toBeDisabled();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .not.toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("a command-line download taken after the run confirms and spends", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await startRun();
      await endRun();

      // The download reads the record the run left behind, so the attestation is
      // measured against the secret those files actually carry.
      await dispatchCommandLineExport(downloads.captured);
      await expect.element(cronConfirm(), afterPoll).toBeEnabled();
      await cronConfirm().click();

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

  test("the move to another device refuses a copy a run elsewhere superseded, then takes a fresh one", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect
        .element(page.getByText("Confirm the move"))
        .toBeInTheDocument();

      // A run in another context rotates and persists while this screen stands --
      // the ordering no gate on this screen can observe, since the confirm screen
      // outlives the run that superseded it.
      await persistManagedExchangeRotation(created.id, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      });

      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect.element(supersededNotice()).toBeInTheDocument();
      await expect.element(migrationConfirm()).toBeDisabled();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();

      // Downloading again reads the rotated record, and that copy hands off.
      await page
        .getByRole("button", { name: "Keep it on this device" })
        .click();
      await migrateButton().click();
      await expect.element(migrationConfirm(), afterPoll).toBeEnabled();
      await migrationConfirm().click();

      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      downloads.restore();
    }
  });
});

describe("a run held in another context", () => {
  test("the move confirmation is withheld while another context runs, and returns", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      const release = await holdRunLockElsewhere(created.id);
      try {
        await expect.element(migrationConfirm(), afterPoll).toBeDisabled();
        await expect.element(waitNotice()).toBeInTheDocument();
        expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      } finally {
        release();
      }

      await expect.element(migrationConfirm(), afterPoll).toBeEnabled();
      await expect.element(waitNotice()).not.toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("the command-line hand-off and both dispatches are withheld while another context runs", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);
      await expect.element(cronConfirm()).toBeEnabled();

      const release = await holdRunLockElsewhere(created.id);
      try {
        await expect.element(cronConfirm(), afterPoll).toBeDisabled();
        await expect.element(waitNotice()).toBeInTheDocument();
        // Creating a dispatch mid-run only manufactures the artifact the
        // confirmation would refuse, so both dispatches are withheld too.
        await expect.element(migrateButton()).toBeDisabled();
        await expect.element(downloadButton()).toBeDisabled();
        await expect
          .element(page.getByText(RUN_IN_FLIGHT_HANDOFF_REASON).first())
          .toBeInTheDocument();
      } finally {
        release();
      }

      await expect.element(cronConfirm(), afterPoll).toBeEnabled();
      await expect.element(migrateButton()).toBeEnabled();
      await expect.element(downloadButton()).toBeEnabled();
      await expect.element(waitNotice()).not.toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });
});
