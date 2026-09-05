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
  recordManagedExchangeLastRun,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { storageFailureRun } from "@psi/managedRunRotate";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// A no-show must still show a standing persist failure and its re-invite recovery,
// not the benign "not a fault on this device" reading: a one-sided persist failure
// desyncs the two parties' rendezvous ids, so they then no-show every run. Only the
// real component and store pin which record a reload classifies against -- the run
// stamps its own "missed" outcome and replaces `lastRun` wholesale before the
// reload, so a stale mount-time snapshot would show the benign copy instead.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

// The stubbed run's script for one test, reset per test: how many runs it has served
// and whether the first of them is the rotation persist failure rather than a
// no-show.
const driver = vi.hoisted(() => ({ runs: 0, persistFailsFirstRun: false }));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to the failing half of a real run: the run's own
// best-effort bookkeeping stamp through the store's real monotonic write, then the
// error rethrown for the surface to classify. Nothing dials a partner; the stamp
// and the error are what a `PartnerNoShowError` out of `runManagedRerun` produces,
// and what its `RotationPersistError` produces for the run that rotates but cannot
// save.
vi.mock("@psi/managedRunDriver", async () => {
  const { PartnerNoShowError } = await import("@psi/waitForConnection");
  const rotate = await import("@psi/managedRunRotate");
  const store = await import("@psi/managedExchangeStore");
  return {
    runManagedExchangeInBrowser: async (config: { record: { id: string } }) => {
      driver.runs += 1;
      const at = Date.now();
      if (driver.persistFailsFirstRun && driver.runs === 1) {
        await store.recordManagedExchangeLastRun(
          config.record.id,
          rotate.storageFailureRun(at),
        );
        throw new rotate.RotationPersistError(
          at,
          new Error("the write failed"),
        );
      }
      await store.recordManagedExchangeLastRun(
        config.record.id,
        rotate.missedRun(at),
      );
      throw new PartnerNoShowError("timed out waiting for the other party");
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

/** Save an exchange with the standing persist failure an earlier run recorded,
 * mount its run surface, and press Run -- leaving the stubbed run to stamp its
 * no-show and fail into the surface's classification. Returns the record's id. */
async function runUntilItNoShows(): Promise<string> {
  const created = await createManagedExchange(
    newExchange({ inputFileHandle: await inputHandle() }),
  );
  await recordManagedExchangeLastRun(
    created.id,
    storageFailureRun(Date.now() - 60_000),
  );
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  return created.id;
}

beforeEach(async () => {
  driver.runs = 0;
  driver.persistFailsFirstRun = false;
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("a live no-show is read against the evidence standing at launch", () => {
  test("a standing persist failure outranks the no-show and offers re-invite", async () => {
    const id = await runUntilItNoShows();

    await expect
      .element(page.getByText("The last run could not be saved"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "Your partner did not arrive",
    );
    expect(app.container.textContent).not.toContain(
      "not a fault on this device",
    );

    // The stamp really did land and really did erase the kind: without this the
    // assertions above would pass against a run that never wrote its bookkeeping.
    // It is also where the guarantee stops -- the stored record a later visit
    // reads holds the no-show alone, so the list line and the run history name
    // that rather than the persist failure standing behind it.
    const stored = await getManagedExchange(id);
    expect(stored?.lastRun?.outcome).toBe("missed");
    expect(stored?.lastRun?.failureKind).toBeUndefined();
  });

  test("a persist failure earlier in this visit outranks a later run's no-show", async () => {
    // Two runs in one mounted visit, which the run control allows: the first
    // rotates and cannot save, the second meets the no-show that a pair left on
    // different secrets produces every time. Nothing is seeded, so the only
    // standing evidence the second run can be read against is what the first run
    // itself wrote -- which a surface weighing its mount-time record never sees.
    driver.persistFailsFirstRun = true;
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();

    await runButton.click();
    await expect
      .element(page.getByText("The last run could not be saved"))
      .toBeInTheDocument();
    await expect.element(runButton).toBeEnabled();

    await runButton.click();
    await vi.waitFor(() => {
      expect(driver.runs).toBe(2);
    });
    // The run control is disabled for the length of a run, so its return to
    // enabled is the second run's classification having rendered.
    await expect.element(runButton).toBeEnabled();
    await flushPendingUpdates();

    await expect
      .element(page.getByText("The last run could not be saved"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "Your partner did not arrive",
    );
    expect(app.container.textContent).not.toContain("nothing left this device");

    // The second run reached the store and stamped its own no-show over the
    // storage entry: without this the assertions above would pass against the
    // first run's alert, which renders the same copy and is still on screen.
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("missed");
    expect(stored?.lastRun?.failureKind).toBeUndefined();
  });
});
