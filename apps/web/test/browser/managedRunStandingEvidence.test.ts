/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  COMPROMISE_ACKNOWLEDGE_LABEL,
  COMPROMISE_RESPONSE_TITLE,
  COMPROMISE_RESPONSE_UNSAVED_REASON,
  COMPROMISE_RESPONSE_UNSAVED_TITLE,
} from "@psi/managed/managedFailureConfirmation";
import {
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  standingCompromiseResponse,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchangeStandingCondition,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import { failedRun, missedRun } from "@psi/managed/managedRunRotate";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { REINVITE_RUN_IN_FLIGHT_REASON } from "@recurring/managedReinviteGate";
import { STANDING_CONDITION_CLEAR_LABEL } from "@recurring/managedStandingConditionModel";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { holdRunLockElsewhere, stalePollUntilClick } from "./runLockReadings";

import type * as ManagedExchangeStore from "@psi/managed/managedExchangeStore";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// A no-show must still show a standing persist failure and its re-invite recovery,
// not the benign "not a fault on this device" reading: a one-sided persist failure
// desyncs the two parties' rendezvous ids, so they then no-show every run. Only the
// real component and store pin which record a reload classifies against -- the run
// stamps its own "missed" outcome and replaces `lastRun` wholesale before the
// reload, so a stale mount-time snapshot would show the benign copy instead.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

// The stubbed run's script for one test, reset per test: how many runs it has served,
// whether the first of them is the rotation persist failure rather than a no-show, the
// lapsed instant to fail every run with instead (the bound the pre-connection check
// reads, whose own recovery is the re-invite), and whether every run's handshake fails
// closed with nothing to explain it.
const driver = vi.hoisted(
  (): {
    runs: number;
    persistFailsFirstRun: boolean;
    lapsedAt?: string;
    handshakeFailsClosed: boolean;
    handshakeStampFails: boolean;
    held: Promise<void> | undefined;
  } => ({
    runs: 0,
    persistFailsFirstRun: false,
    handshakeFailsClosed: false,
    handshakeStampFails: false,
    held: undefined,
  }),
);

// Whether the store's clear-and-acknowledge write rejects, so the page's failed-clear
// alert can be driven on both legs of the gate, and a promise the write waits on, so
// the gate can be driven while that write is still in flight.
const clearWrite = vi.hoisted(
  (): { fails: boolean; held: Promise<void> | undefined } => ({
    fails: false,
    held: undefined,
  }),
);

// Whether the store's compromise-response write rejects, so the unsaved answer -- the
// one that holds the visit and nothing beyond it -- can be driven.
const compromiseWrite = vi.hoisted((): { fails: boolean } => ({
  fails: false,
}));

// Everything but the two writes below is the real store: the records these tests read
// back are the ones the surface and the stubbed run actually wrote.
vi.mock("@psi/managed/managedExchangeStore", async () => {
  const actual = await vi.importActual<typeof ManagedExchangeStore>(
    "@psi/managed/managedExchangeStore",
  );
  return {
    ...actual,
    clearManagedExchangeStandingCondition: async (id: string) => {
      if (clearWrite.held !== undefined) await clearWrite.held;
      if (clearWrite.fails) throw new Error("the write failed");
      return await actual.clearManagedExchangeStandingCondition(id);
    },
    recordManagedExchangeCompromiseResponse: async (id: string, at: string) => {
      if (compromiseWrite.fails) throw new Error("the write failed");
      return await actual.recordManagedExchangeCompromiseResponse(id, at);
    },
  };
});

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
      // A run the test holds open, so a surface can be driven while one is in
      // flight -- the state every hand-off and the re-invite wait out.
      if (driver.held !== undefined) await driver.held;
      const at = Date.now();
      // The handshake failed closed and the store refused the run's own
      // bookkeeping write: the record keeps whatever it held, so a condition the
      // failure would have raised is not there to answer.
      if (driver.handshakeStampFails)
        throw new Error("the handshake failed closed");
      // The lapse is read before any connection, so the run stamps no bookkeeping
      // of its own -- the record already holds the lapse.
      if (driver.lapsedAt !== undefined)
        throw new ManagedExchangeExpiredError(driver.lapsedAt);
      // A handshake that failed closed with nothing on this device to explain it:
      // the run stamps its own `auth` entry and rethrows, which is the Tier-2
      // unexplained state the confirmation gate is shown for.
      if (driver.handshakeFailsClosed) {
        await store.recordManagedExchangeLastRun(
          config.record.id,
          rotate.failedRun(at, "failed", "auth"),
          at,
        );
        throw new Error("the handshake failed closed");
      }
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
  driver.handshakeFailsClosed = false;
  driver.handshakeStampFails = false;
  driver.held = undefined;
  clearWrite.fails = false;
  clearWrite.held = undefined;
  compromiseWrite.fails = false;
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

describe("a compromise response the operator has reached", () => {
  test("leaves the live failure no re-invite to offer beside it", async () => {
    // The standing gate is answered "something does not add up" while the live
    // failure is a lapsed bound, whose own recovery is a fresh invitation. The
    // compromise response says not to send one on this channel, so the page must
    // not hold a button that does exactly that.
    driver.lapsedAt = "2026-07-01T00:00:00.000Z";
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
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
    // The live failure really is offering the re-invite before the gate is
    // answered: without this the assertion below would pass against a state that
    // never had a button to withdraw.
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(1);

    await page
      .getByRole("button", { name: "Something does not add up" })
      .click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);
    // The lapse is still stated: the compromise response withdraws the offer, not
    // the account of what happened.
    expect(app.container.textContent).toContain(
      "This exchange's stored secret has lapsed",
    );
  });

  test("holds the recovery region when a later run fails the same way", async () => {
    // The standing gate is answered "something does not add up", and the next run
    // fails closed the same way the condition was raised over. The section stands
    // down for a live failure of its own tier, so the response has to hold the
    // region from the live failure's place: the question the operator answered is
    // not put again, and nothing there can mint on the channel they flagged.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    const secretBefore = (await getManagedExchange(created.id))?.sharedSecret;

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await doesNotAddUp.click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();

    driver.handshakeFailsClosed = true;
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(
        page.getByText(
          "This run failed and needs you to check with your partner",
        ),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      1,
    );
    expect(
      page
        .getByRole("button", { name: "Partner confirmed their own failure" })
        .elements(),
    ).toHaveLength(0);
    expect(doesNotAddUp.elements()).toHaveLength(0);
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);

    // Nothing rotated and nothing settled: the stored secret is the one the
    // flagged channel was using, and the condition still stands.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(secretBefore);
    expect(stored?.standingCondition).not.toEqual(NO_STANDING_CONDITION);
  });

  test("holds a live gate's response over a later run in the same visit", async () => {
    // The live failure's own gate is answered "something does not add up", and the
    // operator runs again into the same failed-closed handshake. The answer is one
    // per visit, whichever gate asked it: the question is not put again, and nothing
    // in the recovery region can mint on the channel the operator flagged.
    driver.handshakeFailsClosed = true;
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const secretBefore = (await getManagedExchange(created.id))?.sharedSecret;

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(
        page.getByText(
          "This run failed and needs you to check with your partner",
        ),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await doesNotAddUp.click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
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

    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      1,
    );
    expect(
      page
        .getByRole("button", { name: "Partner confirmed their own failure" })
        .elements(),
    ).toHaveLength(0);
    expect(doesNotAddUp.elements()).toHaveLength(0);
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);

    // Nothing rotated and nothing settled: the stored secret is the one the
    // flagged channel was using, and the condition the failures raised still stands.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(secretBefore);
    expect(stored?.standingCondition).not.toEqual(NO_STANDING_CONDITION);
  });

  test("leaves a later failure in the same visit its own gate", async () => {
    // The answer covers the failure it was given at. A second run fails closed the
    // same way, and first raise wins, so the record's condition is still the first
    // failure's -- the acknowledgement clears that one and settles nothing about
    // the failure on screen, which keeps its gate and no way around it.
    driver.handshakeFailsClosed = true;
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const secretBefore = (await getManagedExchange(created.id))?.sharedSecret;

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await doesNotAddUp.click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await vi.waitFor(async () => {
      const answered = await getManagedExchange(created.id);
      expect(answered?.standingCondition).toHaveProperty("response");
    });

    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await vi.waitFor(() => {
      expect(driver.runs).toBe(2);
    });
    // The run control is disabled for the length of a run, so its return to
    // enabled is the second run's classification having rendered.
    await expect.element(runButton).toBeEnabled();
    await flushPendingUpdates();

    await page
      .getByRole("button", { name: COMPROMISE_ACKNOWLEDGE_LABEL })
      .click();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
    await flushPendingUpdates();

    // Both outcomes are put for the second failure, and nothing on the page mints
    // until one of them is answered.
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", {
          name: "Partner confirmed their own failure",
        }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      secretBefore,
    );
  });

  test("withholds the configuration section's re-invite and says why", async () => {
    // The response tells the operator not to re-invite on this channel. The
    // configuration section far below it mints on exactly that channel with the same
    // terms, so its control is withheld too, with the reason where the operator
    // reads it rather than a button that quietly does nothing.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    const secretBefore = (await getManagedExchange(created.id))?.sharedSecret;

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const reinviteOnTerms = page.getByRole("button", {
      name: "Re-invite with the same terms",
    });
    // The control really is live before the gate is answered: without this the
    // assertion below would pass against a page that never offered it.
    await expect.element(reinviteOnTerms).toBeEnabled();

    await page
      .getByRole("button", { name: "Something does not add up" })
      .click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await flushPendingUpdates();

    await expect.element(reinviteOnTerms).toBeDisabled();
    expect(app.container.textContent).toContain(
      "no fresh invitation is offered on this channel",
    );
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(secretBefore);
  });

  test("leaves a settled condition no re-invite to offer under it", async () => {
    // The other way round: the condition was cleared earlier in this visit, so the
    // section below holds the re-invite on its own, and this visit's run then lands
    // on the unexplained state whose gate the operator answers as a compromise.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const clear = page.getByRole("button", {
      name: STANDING_CONDITION_CLEAR_LABEL,
    });
    await expect.element(clear).toBeInTheDocument();
    await clear.click();
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeInTheDocument();

    driver.handshakeFailsClosed = true;
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(
        page.getByText(
          "This run failed and needs you to check with your partner",
        ),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    await page
      .getByRole("button", { name: "Something does not add up" })
      .click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);
  });
});

describe("a compromise response this device could not save", () => {
  /** Seed the failed-closed handshake the standing gate is put for, mount the
   * surface, and answer it "something does not add up" against a store that
   * refuses the write. Returns the record's id. */
  async function answerAgainstARefusedWrite(): Promise<string> {
    compromiseWrite.fails = true;
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await doesNotAddUp.click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_UNSAVED_TITLE))
      .toBeInTheDocument();
    await flushPendingUpdates();
    return created.id;
  }

  test("holds the page, says what it cost, and asks again at the next visit", async () => {
    // A write this device refused is the side to fail to: the answer holds the
    // page as a saved one does, and the page states how far that reaches rather
    // than letting the operator read it as recorded.
    const id = await answerAgainstARefusedWrite();

    expect(app.container.textContent).toContain(
      COMPROMISE_RESPONSE_UNSAVED_REASON,
    );
    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      1,
    );
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);

    // Nothing reached the record, so the gate is put again at the next visit.
    const stored = await getManagedExchange(id);
    expect(
      stored === undefined ? undefined : standingCompromiseResponse(stored),
    ).toBeUndefined();
    app.unmount();

    app.render(createElement(ManagedRunSurface, { id }));
    await expect
      .element(page.getByRole("button", { name: "Something does not add up" }))
      .toBeInTheDocument();
    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      0,
    );
  });

  test("a fresh run in the same visit is not held behind it", async () => {
    // The unsaved answer stands until a run starts, not over whatever the page
    // shows next. A run since then has a failure of its own, classified
    // differently, and the panel whose one control clears the record's standing
    // condition must not be sitting over it.
    const id = await answerAgainstARefusedWrite();

    driver.lapsedAt = "2026-07-01T00:00:00.000Z";
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(page.getByText("This exchange's stored secret has lapsed"))
      .toBeInTheDocument();
    await flushPendingUpdates();

    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      0,
    );
    expect(
      page.getByText(COMPROMISE_RESPONSE_UNSAVED_TITLE).elements(),
    ).toHaveLength(0);
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeEnabled();
    // The lapse really is the live state the recovery belongs to, and the record
    // still holds nothing the operator answered.
    const stored = await getManagedExchange(id);
    expect(
      stored === undefined ? undefined : standingCompromiseResponse(stored),
    ).toBeUndefined();
  });
});

describe("a clear-and-acknowledge write still in flight", () => {
  test("holds both legs of the gate until it resolves", async () => {
    // The two outcomes are one answer over the same evidence. The gate stays on
    // screen while the confirming leg's write runs, so a second click on the other
    // leg would raise the compromise response over a condition that is about to be
    // cleared -- and the page would then show neither.
    let release: () => void = () => undefined;
    clearWrite.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const confirmed = page.getByRole("button", {
      name: "Partner confirmed their own failure",
    });
    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(confirmed).toBeEnabled();
    await expect.element(doesNotAddUp).toBeEnabled();
    await confirmed.click();

    await expect.element(confirmed).toBeDisabled();
    await expect.element(doesNotAddUp).toBeDisabled();

    release();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
    await flushPendingUpdates();
    // The answer the operator gave is the one that stands.
    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      0,
    );
  });

  test("holds the short clear control on the acknowledge tier", async () => {
    // The same hazard on the tier whose clearance is one button: the write is the
    // same, and a second click must not reach it.
    let release: () => void = () => undefined;
    clearWrite.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const clear = page.getByRole("button", {
      name: STANDING_CONDITION_CLEAR_LABEL,
    });
    await expect.element(clear).toBeEnabled();
    await clear.click();

    await expect.element(clear).toBeDisabled();

    release();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
  });
});

describe("a clear-and-acknowledge write that rejects", () => {
  test("states what happened on the gate's confirming leg, not only the short control", async () => {
    // The confirming option takes the same store write the acknowledge control does.
    // When it rejects, the condition stays raised -- so the operator has to be told,
    // or the click reads as having settled something it did not.
    clearWrite.fails = true;
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const confirmed = page.getByRole("button", {
      name: "Partner confirmed their own failure",
    });
    await expect.element(confirmed).toBeInTheDocument();
    await confirmed.click();

    await expect
      .element(page.getByText("Could not clear this"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain("this still stands");
    // The condition really is still raised, and the gate is still there to retry on.
    expect(
      (await getManagedExchange(created.id))?.standingCondition,
    ).not.toEqual(NO_STANDING_CONDITION);
    await expect.element(confirmed).toBeInTheDocument();
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

describe("a compromise response the operator gave at an earlier visit", () => {
  /** Seed a failed-closed handshake, mount the surface, answer the standing
   * condition's gate "something does not add up", and wait for the answer to reach
   * the store. Returns the record's id. */
  async function answerStandingGate(): Promise<string> {
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const doesNotAddUp = page.getByRole("button", {
      name: "Something does not add up",
    });
    await expect.element(doesNotAddUp).toBeInTheDocument();
    await doesNotAddUp.click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await vi.waitFor(async () => {
      const stored = await getManagedExchange(created.id);
      expect(stored?.standingCondition).toHaveProperty("response");
    });
    await flushPendingUpdates();
    return created.id;
  }

  test("stands at the next visit, with every mint still withheld", async () => {
    // The answer is on the record rather than on the page, so a reload does not
    // put the question again -- and the channel the operator flagged gets no
    // fresh secret from either control.
    const id = await answerStandingGate();
    app.unmount();

    app.render(createElement(ManagedRunSurface, { id }));
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Something does not add up" })
        .elements(),
    ).toHaveLength(0);
    expect(
      page
        .getByRole("button", { name: "Partner confirmed their own failure" })
        .elements(),
    ).toHaveLength(0);
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);
    await expect
      .element(
        page.getByRole("button", { name: "Re-invite with the same terms" }),
      )
      .toBeDisabled();
    expect(app.container.textContent).toContain(
      "no fresh invitation is offered on this channel",
    );
  });

  test("the acknowledgement clears it and puts the fresh invitation back on offer", async () => {
    // The way out of the response, and the only one this page holds: the operator
    // reached the partner another way. It settles the condition and mints nothing
    // -- the invitation is theirs to send afterwards.
    const id = await answerStandingGate();
    const secretBefore = (await getManagedExchange(id))?.sharedSecret;
    app.unmount();

    app.render(createElement(ManagedRunSurface, { id }));
    const acknowledge = page.getByRole("button", {
      name: COMPROMISE_ACKNOWLEDGE_LABEL,
    });
    await expect.element(acknowledge).toBeEnabled();
    await acknowledge.click();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(id))?.standingCondition).toEqual(
        NO_STANDING_CONDITION,
      );
    });
    await flushPendingUpdates();

    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      0,
    );
    await expect
      .element(page.getByRole("button", { name: "Create a fresh invitation" }))
      .toBeEnabled();
    await expect
      .element(
        page.getByRole("button", { name: "Re-invite with the same terms" }),
      )
      .toBeEnabled();
    // The acknowledgement is not the mint: the stored secret is the one the
    // operator still has to replace.
    expect((await getManagedExchange(id))?.sharedSecret).toBe(secretBefore);
  });

  test("a benign no-show later in the same visit does not take it", async () => {
    // The run stamps a no-show, which records no failure kind at all, and nothing
    // refreshes the page's own copy of the record. The answer is not a reading of
    // the last run, so neither costs it.
    const id = await answerStandingGate();
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await vi.waitFor(() => {
      expect(driver.runs).toBe(1);
    });
    // The run control is disabled for the length of a run, so its return to
    // enabled is the run's classification having rendered.
    await expect.element(runButton).toBeEnabled();
    await flushPendingUpdates();

    expect(page.getByText(COMPROMISE_RESPONSE_TITLE).elements()).toHaveLength(
      1,
    );
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);

    // The no-show really did land over the entry the condition was raised beside:
    // without this the assertions above would pass against a run that never wrote.
    const stored = await getManagedExchange(id);
    expect(stored?.lastRun?.outcome).toBe("missed");
    expect(
      stored === undefined ? undefined : standingCompromiseResponse(stored),
    ).toBeDefined();
  });
});

describe("a live gate answered where no condition stands", () => {
  test("raises the condition that holds the answer, and it stands at the next visit", async () => {
    // The handshake failed closed and the store refused the run's own bookkeeping
    // write, so the failure being answered raised nothing to answer. The answer
    // still needs a carrier, or the gate is put again at the next visit.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    await clearManagedExchangeStandingCondition(created.id);
    driver.handshakeStampFails = true;

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();
    await expect
      .element(
        page.getByText(
          "This run failed and needs you to check with your partner",
        ),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();
    // Nothing stands to hold the answer at the moment it is given.
    expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
      NO_STANDING_CONDITION,
    );

    await page
      .getByRole("button", { name: "Something does not add up" })
      .click();
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    await vi.waitFor(async () => {
      expect((await getManagedExchange(created.id))?.standingCondition).toEqual(
        {
          since: new Date(failedAt).toISOString(),
          kind: "auth",
          response: { kind: "compromise", at: expect.any(String) },
        },
      );
    });
    await flushPendingUpdates();
    app.unmount();

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect
      .element(page.getByText(COMPROMISE_RESPONSE_TITLE))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Create a fresh invitation" })
        .elements(),
    ).toHaveLength(0);
  });
});

describe("a re-invite control while a run is in flight", () => {
  test("both wait the run out and come back when it ends", async () => {
    // A re-invite replaces the secret the run in progress is connecting on, so
    // neither control is live for the length of it -- and both return whatever the
    // run turned out to be.
    let release: () => void = () => undefined;
    driver.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );

    app.render(createElement(ManagedRunSurface, { id: created.id }));
    const recovery = page.getByRole("button", {
      name: "Create a fresh invitation",
    });
    const terms = page.getByRole("button", {
      name: "Re-invite with the same terms",
    });
    await expect.element(recovery).toBeEnabled();
    await expect.element(terms).toBeEnabled();

    const runButton = page.getByRole("button", { name: "Run exchange" });
    await runButton.click();
    await expect.element(recovery).toBeDisabled();
    await expect.element(terms).toBeDisabled();
    expect(app.container.textContent).toContain(REINVITE_RUN_IN_FLIGHT_REASON);

    release();
    // The run control is disabled for the length of a run, so its return to
    // enabled is the run's classification having rendered.
    await expect.element(runButton).toBeEnabled();
    await flushPendingUpdates();

    await expect.element(recovery).toBeEnabled();
    await expect.element(terms).toBeEnabled();
    expect(app.container.textContent).not.toContain(
      REINVITE_RUN_IN_FLIGHT_REASON,
    );
  });

  test("a run taken since the last reading is caught at the click", async () => {
    // The reading behind the controls is a poll, so a run can take the lock while a
    // button is still enabled from the last reading. The mint takes no lock of its
    // own, so the handler's re-read at the click is the whole of what keeps a fresh
    // secret from replacing the one the run is connecting on.
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: await inputHandle() }),
    );
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      created.id,
      failedRun(failedAt, "failed", "storage"),
      failedAt,
    );
    const secretBefore = (await getManagedExchange(created.id))?.sharedSecret;
    let restorePoll: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      const recovery = page.getByRole("button", {
        name: "Create a fresh invitation",
      });
      await expect.element(recovery).toBeEnabled();

      restorePoll = stalePollUntilClick(created.id);
      release = await holdRunLockElsewhere(created.id);
      // Still enabled: the poll's readings do not see this run, which is the state
      // the click-time re-read exists for.
      await expect.element(recovery).toBeEnabled();
      await recovery.click();

      // Nothing minted, and the run is named as the reason rather than the operator
      // being left with a control that silently did nothing.
      expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
        secretBefore,
      );
      expect(app.container.textContent).toContain(
        REINVITE_RUN_IN_FLIGHT_REASON,
      );

      release();
      release = undefined;
      // The control is intact once the run releases: the withheld click consumed
      // nothing.
      await expect.element(recovery).toBeEnabled();
      await recovery.click();
      await vi.waitFor(async () => {
        expect((await getManagedExchange(created.id))?.sharedSecret).not.toBe(
          secretBefore,
        );
      });
    } finally {
      release?.();
      restorePoll?.();
    }
  });
});
