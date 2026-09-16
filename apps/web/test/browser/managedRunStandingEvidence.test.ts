/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import { failedRun, missedRun } from "@psi/managed/managedRunRotate";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { STANDING_CONDITION_CLEAR_LABEL } from "@recurring/managedStandingConditionModel";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// A no-show must still show a standing persist failure and its re-invite recovery,
// not the benign "not a fault on this device" reading: a one-sided persist failure
// desyncs the two parties' rendezvous ids, so they then no-show every run. Only the
// real component and store pin which record a reload classifies against -- the run
// stamps its own "missed" outcome and replaces `lastRun` wholesale before the
// reload, so a stale mount-time snapshot would show the benign copy instead.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

// The stubbed run's script for one test, reset per test: how many runs it has served,
// whether the first of them is the rotation persist failure rather than a no-show,
// and the lapsed instant to fail every run with instead (the bound the pre-connection
// check reads, whose own recovery is the re-invite).
const driver = vi.hoisted(
  (): { runs: number; persistFailsFirstRun: boolean; lapsedAt?: string } => ({
    runs: 0,
    persistFailsFirstRun: false,
  }),
);

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to the failing half of a real run: the run's own
// best-effort bookkeeping stamp through the store's real monotonic write, then the
// error rethrown for the surface to classify. Nothing dials a partner; the stamp
// and the error are what a `PartnerNoShowError` out of `runManagedRerun` produces,
// and what its `RotationPersistError` produces for the run that rotates but cannot
// save.
vi.mock("@psi/managed/managedRunDriver", async () => {
  const { PartnerNoShowError } =
    await import("@psi/transport/waitForConnection");
  const { ManagedExchangeExpiredError } =
    await import("@psi/managed/managedExpiry");
  const rotate = await import("@psi/managed/managedRunRotate");
  const store = await import("@psi/managed/managedExchangeStore");
  return {
    runManagedExchangeInBrowser: async (config: { record: { id: string } }) => {
      driver.runs += 1;
      const at = Date.now();
      // The lapse is read before any connection, so the run stamps no bookkeeping
      // of its own -- the record already holds the lapse.
      if (driver.lapsedAt !== undefined)
        throw new ManagedExchangeExpiredError(driver.lapsedAt);
      if (driver.persistFailsFirstRun && driver.runs === 1) {
        await store.recordManagedExchangeLastRun(
          config.record.id,
          rotate.storageFailureRun(at),
          at,
        );
        throw new rotate.RotationPersistError(
          at,
          new Error("the write failed"),
        );
      }
      await store.recordManagedExchangeLastRun(
        config.record.id,
        rotate.missedRun(at),
        at,
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
    failedRun(Date.now() - 60_000, "failed", "storage"),
    Date.now() - 60_000,
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
  driver.lapsedAt = undefined;
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

describe("a standing condition at the next visit", () => {
  test("survives the no-show stamp and is cleared through the gate, not by the runs after it", async () => {
    // The next visit: no live run, only what the store holds. The handshake
    // failure the first run recorded has been replaced by a no-show stamp, which
    // records no failure kind at all -- so the condition beside it is the whole of
    // what asks the operator for the confirmation.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    const missedAt = Date.now() - 60_000;
    await recordManagedExchangeLastRun(
      created.id,
      missedRun(missedAt),
      missedAt,
    );
    expect((await getManagedExchange(created.id))?.lastRun?.outcome).toBe(
      "missed",
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(page.getByText("A run failed and has not been explained"))
      .toBeInTheDocument();

    const confirmed = page.getByRole("button", {
      name: "Partner confirmed their own failure",
    });
    await expect.element(confirmed).toBeInTheDocument();
    await confirmed.click();

    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
    // The re-invite stays offered: settling the condition is not the same act as
    // re-establishing the secret it was raised over.
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();
  });
});

describe("a cleared standing condition beside this visit's own failure", () => {
  test("keeps its re-invite after a run in the same visit no-shows", async () => {
    // Clearing the condition settles what an earlier run raised; it does not
    // re-establish the secret, so the re-invite it offers stands whatever this
    // visit's run then does. The storage condition is raised by a run two stamps
    // back, and the no-show stamp over it is the state a page reads.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );
    const missedAt = Date.now() - 60_000;
    await recordManagedExchangeLastRun(
      created.id,
      missedRun(missedAt),
      missedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const clear = page.getByRole("button", {
      name: STANDING_CONDITION_CLEAR_LABEL,
    });
    await expect.element(clear).toBeInTheDocument();
    await clear.click();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
    // The section has settled: its acknowledge control is spent and gone, and the
    // re-invite below it is what the section now holds on its own.
    await expect.element(clear).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();

    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(page.getByText("Your partner did not arrive"))
      .toBeInTheDocument();
    await flushPendingUpdates();

    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();
    // The live state really is the benign no-show, whose own recovery is nothing
    // at all: without this the assertion above would pass against a failure that
    // offers the re-invite itself.
    expect(app.container.textContent).toContain("not a fault on this device");
  });
});

describe("a standing condition beside a live failure of another tier", () => {
  test("leaves the re-invite to the live failure rather than offering a second", async () => {
    // A lapsed bound over a standing persist failure: two states, one recovery
    // between them -- a single fresh invitation minted from this record. The
    // condition keeps its own words and its clearance; the offer is the live
    // failure's, so the operator has one button to press rather than two
    // identical ones whose failed mint would alert twice.
    driver.lapsedAt = "2026-07-01T00:00:00.000Z";
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 60_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(page.getByText("This exchange's stored secret has lapsed"))
      .toBeInTheDocument();
    await flushPendingUpdates();

    await expect
      .element(
        page.getByText("A run could not save this exchange's new secret"),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: STANDING_CONDITION_CLEAR_LABEL }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(1);
  });
});
