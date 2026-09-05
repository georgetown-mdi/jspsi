/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The run surface's hand-off confirm, rendered against real Chromium (the record
// and its sibling stores are the real IndexedDB ones). What is pinned here is the
// custody the confirm states before this device gives up its copy: the artifact
// holds the secret, and it does NOT hold the accounting of disclosures, which
// stays behind with the device -- so the operator is told to export it first, the
// same warning the delete confirm states.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The record read, armed for the one test whose refusal must meet a reload that
// does not answer. The surface reads the record and its sibling entry under one
// catch, so a record read that rejects is what leaves a refused run holding no
// spent entry to name the hand-off from.
const recordRead = vi.hoisted(() => ({ rejects: false }));

vi.mock("@psi/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const readRecord = actual.getManagedExchange as typeof getManagedExchange;
  return {
    ...actual,
    getManagedExchange: (id: string) =>
      recordRead.rejects
        ? Promise.reject(new Error("the stored record could not be read"))
        : readRecord(id),
  };
});

// The dispatch is stubbed to the state it leaves the surface in, so the confirm is
// reached without a real artifact download in the runner. The export itself, and
// the spend it defers until the operator confirms, are covered against the real
// store in managedExchangeBackup.test.ts.
vi.mock("@psi/managedExchangeExport", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchManagedMigration: () =>
      Promise.resolve({
        backedUpAt: new Date("2026-07-10T09:00:00.000Z"),
        confirm: () => Promise.resolve(),
      }),
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

beforeEach(async () => {
  recordRead.rejects = false;
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("the hand-off confirm states what does not travel", () => {
  test("the confirm says the accounting stays behind, and to export it first", async () => {
    const created = await createManagedExchange(newExchange());

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("button", { name: "Move to another device" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Move to another device" }).click();

    await expect
      .element(page.getByText("Confirm the move"))
      .toBeInTheDocument();
    // The artifact's own custody line still stands, and the accounting's is beside
    // it: the exchange moves, its account of what it disclosed does not.
    await expect
      .element(
        page.getByText("Keep the file somewhere only you can read", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("does not travel in the backup file", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("export the accounting as CSV", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("a run pressed after the hand-off landed", () => {
  test("the refusal fixes the surface on the spent state, with no reload", async () => {
    // The surface reads the spent state when it loads, and this operator's
    // surface loaded before the hand-off was confirmed in another tab -- so the
    // Run button in front of them is live over a copy that is no longer theirs.
    // The run path itself is what refuses; what is pinned here is that the
    // surface fixes on the state that refusal left rather than standing on
    // its run controls until something reloads it.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();

    expect(
      await spendManagedExchangeIfCurrent(
        created.id,
        created.sharedSecret,
        "2026-07-14T09:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    await runButton.click();

    // The state the refusal left, on this render rather than the next load: the
    // durable spent surface, naming the hand-off that spent the copy and what it
    // left behind. Matched on the heading exactly, the prose under it opening on
    // the same subject.
    await expect
      .element(page.getByText("This exchange was handed off", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/handed this exchange to the command line/))
      .toBeInTheDocument();
    // The run this operator started is accounted for beside it: they pressed Run,
    // and the standing state alone cannot say what became of that run.
    await expect
      .element(page.getByText(/nothing left this device/))
      .toBeInTheDocument();
    // Nothing here offers the copy again: the run controls are gone with the load
    // state, and no retry stands in their place.
    await expect
      .element(page.getByRole("button", { name: "Run exchange" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .not.toBeInTheDocument();
    // The handed-over secret still stands, and the run recorded what it met.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun?.failureKind).toBe("handed-off");
  });

  test("a refusal whose reload did not answer names no hand-off it cannot read", async () => {
    // The state is the refusal's; the hand-off's form and date are the reload's,
    // and the reload can come back with neither -- it reads the record and the
    // sibling entry under one catch, so either rejecting costs both. What the
    // surface must not do is fill that gap by guessing: the migration copy sends
    // the operator to import a backup file, which a command-line hand-off never
    // produced and no import here accepts.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();

    expect(
      await spendManagedExchangeIfCurrent(
        created.id,
        created.sharedSecret,
        "2026-07-14T09:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    recordRead.rejects = true;
    await runButton.click();

    await expect
      .element(page.getByText("This exchange was handed off", { exact: true }))
      .toBeInTheDocument();
    // The run this operator started is still accounted for: that much is the
    // refusal's own, and it needs no stored entry to be true.
    await expect
      .element(page.getByText(/nothing left this device/))
      .toBeInTheDocument();
    // Neither hand-off is named on evidence the surface does not hold.
    expect(app.container.textContent).not.toContain("Import the backup");
    expect(app.container.textContent).not.toContain("psilink.yaml");

    // The refusal really is what put that surface up: the run reached the store
    // and recorded the hand-off it met.
    recordRead.rejects = false;
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.failureKind).toBe("handed-off");
  });
});
