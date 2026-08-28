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
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { storageFailureRun } from "@psi/managedRunRotate";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// What a live no-show is read against, driven end to end through the real
// component and the real store. A one-sided persist failure is what desyncs the
// two parties, and a desynced pair no-shows every time -- both rendezvous ids
// derive from the shared secret, so each side waits on an address the other is not
// using. The run must therefore surface the persist failure and its re-invite
// recovery, not the benign "not a fault on this device" reading.
//
// What only the real component pins is which record the surface hands to which
// reading of the classification. The run stamps its own `"missed"` outcome before
// the surface reloads, that write replaces `lastRun` wholesale, and a no-show
// stamp carries no `failureKind` -- so a surface handing the reload to both
// readings shows the benign copy while the model itself stays correct and every
// model test stays green.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to the failing half of a real no-show run: the run's own
// best-effort bookkeeping stamp through the store's real monotonic write, then the
// no-show rethrown for the surface to classify. Nothing dials a partner; the stamp
// and the error are what a `PartnerNoShowError` out of `runManagedRerun` produces.
vi.mock("@psi/managedRunDriver", async () => {
  const { PartnerNoShowError } = await import("@psi/waitForConnection");
  const { missedRun } = await import("@psi/managedRunRotate");
  const store = await import("@psi/managedExchangeStore");
  return {
    runManagedExchangeInBrowser: async (config: { record: { id: string } }) => {
      await store.recordManagedExchangeLastRun(
        config.record.id,
        missedRun(Date.now()),
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

/** Save an exchange carrying the standing persist failure an earlier run recorded,
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
    // reads carries the no-show alone, so the list line and the run history name
    // that rather than the persist failure standing behind it.
    const stored = await getManagedExchange(id);
    expect(stored?.lastRun?.outcome).toBe("missed");
    expect(stored?.lastRun?.failureKind).toBeUndefined();
  });
});
