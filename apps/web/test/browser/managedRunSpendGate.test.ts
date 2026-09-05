/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "@bench/managedHandoffGate";
import {
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  persistManagedExchangeRotation,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managedLocalState";
import { managedExchangeLockName } from "@psi/managedExchangeLock";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { CapturedDownload } from "./captureDownloads";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// A spend must never hand over a copy of the shared secret that a run's rotation
// has already superseded, or is about to supersede. Two independent mechanisms
// enforce this: the confirmation's store step re-reads the record under the run's
// own lock, and the surface withholds hand-offs while a run is in flight in any
// context. This runs in Chromium because both take the real browser lock and poll.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run driver is stubbed to a run the test itself ends, so nothing dials a
// partner. It keeps two properties of a real run: the single-writer lock over the
// rotation, and the rotated secret persisted before the data exchange
// (managedExchangeRun.ts, "Persist-before-success"), which is what makes an
// artifact downloaded earlier stale. It ends by rejecting, so the operator stays on
// the surface holding the confirmation instead of a completion screen replacing it.
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
    const lock = await import("@psi/managedExchangeLock");
    const core = await import("@psilink/core");
    await lock.withManagedExchangeLock(
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

// Each notice is matched on its heading exactly, so a heading and the reason under
// it cannot resolve to the same element.
const waitNotice = () =>
  page.getByText(RUN_IN_FLIGHT_HANDOFF_TITLE, { exact: true });

const supersededNotice = () =>
  page.getByText(SUPERSEDED_HANDOFF_TITLE, { exact: true });

const recordGoneNotice = () =>
  page.getByText(RECORD_GONE_HANDOFF_TITLE, { exact: true });

// The dismiss label the record-gone refusal takes on both surfaces: neutral,
// because there is no live copy left for "keep it here" to describe.
const closeButton = () => page.getByRole("button", { name: "Close" });

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

/**
 * Filter this record's lock out of every `navigator.locks.query()` reading, so a
 * surface reads the record free while a run actually holds it -- the poll and the
 * confirm handler's re-read both rely on this reading, so filtering puts a click on
 * the far side of it deterministically without waiting out the real 400 ms interval.
 *
 * `reveal` stops the filtering, once the reading should catch up mid-click; leaving
 * it unrevealed keeps the surface from ever seeing the run.
 */
function filterLockFromReadings(id: string): {
  reveal: () => void;
  restore: () => void;
} {
  const name = managedExchangeLockName(id);
  const realQuery = navigator.locks.query.bind(navigator.locks);
  let hidden = true;
  (navigator.locks as unknown as { query: unknown }).query = async () => {
    const snapshot = await realQuery();
    if (!hidden) return snapshot;
    return {
      ...snapshot,
      held: snapshot.held?.filter((lock) => lock.name !== name),
    };
  };
  return {
    reveal: () => {
      hidden = false;
    },
    restore: () => {
      (navigator.locks as unknown as { query: typeof realQuery }).query =
        realQuery;
    },
  };
}

/**
 * Hold this record's lock reading STALE for the surfaces' poll -- their only
 * reading of a run in another context -- until a click is dispatched, from which
 * moment the reading is true again.
 *
 * This is the gap a confirm handler's click-time re-read exists for: the lock can
 * be taken between two poll readings, leaving a confirm button enabled over a run
 * already under way.
 */
function stalePollUntilClick(id: string): () => void {
  const readings = filterLockFromReadings(id);
  // Capture phase, so it runs while the click is being dispatched and before the
  // handler React invokes on it: the button cannot be disabled out from under the
  // click, and everything the handler itself reads is the truth. Only a real
  // pointer's click counts -- the download dispatches reach the page as
  // `anchor.click()`, whose untrusted event is not the operator pressing confirm.
  const revealOnClick = (event: Event) => {
    if (event.isTrusted) readings.reveal();
  };
  document.addEventListener("click", revealOnClick, { capture: true });
  return () => {
    document.removeEventListener("click", revealOnClick, { capture: true });
    readings.restore();
  };
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
      // The refusal's way out is the download button on this very panel.
      await expect
        .element(page.getByText(supersededHandoffReason("command-line")))
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
      // measured against the secret those files actually hold.
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
      // The refusal's way out is the route off THIS screen: its only download
      // control lives on the one behind it, so the copy names the button that
      // goes back rather than a download nothing here offers.
      await expect
        .element(page.getByText(supersededHandoffReason("migration")))
        .toBeInTheDocument();

      // Downloading again reads the rotated record, and that copy hands off --
      // by the two clicks the refusal above names, in that order.
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

describe("a hand-off whose record is gone", () => {
  test("the move refuses without sending the operator for a download that cannot exist", async () => {
    // The confirmation outlives the record: an operator who deleted the exchange
    // (or whose browser storage was cleared) in another tab still has this screen
    // standing, with the artifact already on their disk.
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect
        .element(page.getByText("Confirm the move"))
        .toBeInTheDocument();

      await deleteManagedExchange(created.id);
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      // Its own refusal, not the superseded one: there is no copy here to hand
      // over and none to download again either.
      await expect.element(recordGoneNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RECORD_GONE_HANDOFF_REASON))
        .toBeInTheDocument();
      await expect.element(supersededNotice()).not.toBeInTheDocument();
      await expect.element(migrationConfirm()).toBeDisabled();
      // The dismiss label is neutral rather than "Keep it on this device": there
      // is no live copy left here for that label to describe.
      await expect.element(closeButton()).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Keep it on this device" }))
        .not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
    } finally {
      downloads.restore();
    }
  });

  test("the command-line hand-off refuses the same way", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);

      await deleteManagedExchange(created.id);
      await expect.element(cronConfirm()).toBeEnabled();
      await cronConfirm().click();

      await expect.element(recordGoneNotice()).toBeInTheDocument();
      await expect.element(cronConfirm()).toBeDisabled();
      // The dismiss label is neutral rather than "Keep it in this browser": there
      // is no live copy left here for that label to describe.
      await expect.element(closeButton()).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Keep it in this browser" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
    } finally {
      downloads.restore();
    }
  });
});

describe("a confirmation clicked between two readings of the run lock", () => {
  // The poll behind the withholding reads every 400 ms, so a run can take the
  // lock while a confirm button is still enabled from the last reading. What
  // covers that gap is the handler's own re-read at the click, and these are the
  // two cases that exercise it -- one per hand-off.

  test("the move confirmation re-reads the lock at the click and holds back", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    let restorePoll: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      // Installed once the confirmation is up, so the click that dispatched the
      // export is not the one the reading is restored on.
      restorePoll = stalePollUntilClick(created.id);
      release = await holdRunLockElsewhere(created.id);
      // Still enabled: the poll's readings do not see this run, which is the
      // state the click-time re-read exists for.
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      // Nothing spent, and the run is named as the reason rather than the
      // operator being left with a confirmation that silently did nothing.
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect.element(waitNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText("Handed off to another device"))
        .not.toBeInTheDocument();

      release();
      release = undefined;
      // The confirmation is intact once the run releases: the refused click
      // consumed nothing.
      await expect.element(migrationConfirm(), afterPoll).toBeEnabled();
      await migrationConfirm().click();
      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      release?.();
      restorePoll?.();
      downloads.restore();
    }
  });

  test("the command-line confirmation re-reads the lock at the click and holds back", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    let restorePoll: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);
      await expect.element(cronConfirm()).toBeEnabled();

      restorePoll = stalePollUntilClick(created.id);
      release = await holdRunLockElsewhere(created.id);
      await expect.element(cronConfirm()).toBeEnabled();
      await cronConfirm().click();

      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect.element(waitNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .not.toBeInTheDocument();

      release();
      release = undefined;
      await expect.element(cronConfirm(), afterPoll).toBeEnabled();
      await cronConfirm().click();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toMatchObject({
        handoff: "command-line",
      });
    } finally {
      release?.();
      restorePoll?.();
      downloads.restore();
    }
  });
});

describe("a confirmation the run lock refuses at the write", () => {
  // The surface's readings are the best-effort half and can miss a run entirely --
  // the poll's interval, a query this browser will not answer. What is measured
  // here is the half that cannot: the spend takes the run+rotate lock itself, so a
  // click that reaches it mid-run spends nothing, and the run's own rotation
  // therefore supersedes nothing that was handed over. Both hand-offs, since each
  // has its own confirmation.

  test("the command-line confirmation spends nothing while a run holds the lock", async () => {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const downloads = captureDownloads();
    let readings: { reveal: () => void; restore: () => void } | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await dispatchCommandLineExport(downloads.captured);
      await expect.element(cronConfirm()).toBeEnabled();

      // A run takes the lock and nothing on this surface ever sees it: neither the
      // poll nor the confirm handler's re-read. The run has not rotated yet, so
      // the currency check would pass -- and the spend would then be superseded by
      // that run's persist, which is the ordering the lock is here to exclude.
      readings = filterLockFromReadings(created.id);
      release = await holdRunLockElsewhere(created.id);
      await expect.element(cronConfirm()).toBeEnabled();
      await cronConfirm().click();

      // Refused by the spend, in the wait's own words rather than an error tier.
      await expect.element(waitNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RUN_IN_FLIGHT_HANDOFF_REASON).first())
        .toBeInTheDocument();
      await expect
        .element(page.getByText(/could not be completed/))
        .not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .not.toBeInTheDocument();
      // The confirm control stays enabled through its own run-in-flight refusal --
      // the poll never saw this run, so nothing in the surface's own state disables
      // it -- and the wait copy above is what tells the operator to retry it.
      await expect.element(cronConfirm()).toBeEnabled();

      // The files are still this exchange's -- this run rotated nothing -- so the
      // confirmation the refusal left intact hands them off once the lock is free.
      release();
      release = undefined;
      readings.restore();
      readings = undefined;
      expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
        created.sharedSecret,
      );
      await expect.element(cronConfirm(), afterPoll).toBeEnabled();
      await cronConfirm().click();

      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toMatchObject({
        handoff: "command-line",
      });
    } finally {
      release?.();
      readings?.restore();
      downloads.restore();
    }
  });

  test("the move confirmation spends nothing while a run holds the lock", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    let readings: { reveal: () => void; restore: () => void } | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      readings = filterLockFromReadings(created.id);
      release = await holdRunLockElsewhere(created.id);
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect.element(waitNotice()).toBeInTheDocument();
      await expect.element(supersededNotice()).not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect
        .element(page.getByText("Handed off to another device"))
        .not.toBeInTheDocument();
      // The confirm control stays enabled through its own run-in-flight refusal --
      // the poll never saw this run, so nothing in the surface's own state disables
      // it -- and the wait copy above is what tells the operator to retry it.
      await expect.element(migrationConfirm()).toBeEnabled();

      release();
      release = undefined;
      readings.restore();
      readings = undefined;
      await expect.element(migrationConfirm(), afterPoll).toBeEnabled();
      await migrationConfirm().click();

      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      release?.();
      readings?.restore();
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
