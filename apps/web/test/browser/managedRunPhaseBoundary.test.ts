/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managedExchangeStore";
import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The classification depends on a flag the real component sets in the callback it
// hands the driver, so only a rendered test -- not a model test -- catches a
// regression that hardcodes the flag. Both directions are pinned: a literal
// `false` would show the no-show state for the post-boundary run, and a literal
// `true` would show the neutral transport state for the pre-boundary one.

const phase = vi.hoisted(() => ({ dataExchangeStarted: false }));

/** The configs the surface handed the driver, so a check can read what an
 * attended run asks for as well as how it classifies what comes back. */
const driverConfigs = vi.hoisted(() => ({
  seen: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The driver is stubbed to a run that fails with the no-show, having first
// reported the data-exchange boundary through the surface's own callback when the
// test asks for the post-boundary case. Nothing dials a partner, and nothing
// stamps the record: what the surface renders comes from the live error and this
// flag alone.
vi.mock("@psi/managedRunDriver", async () => {
  const { PartnerNoShowError } = await import("@psi/waitForConnection");
  return {
    runManagedExchangeInBrowser: (config: {
      options?: { onDataExchangeStart?: () => void };
    }) => {
      driverConfigs.seen.push(config);
      if (phase.dataExchangeStarted) config.options?.onDataExchangeStart?.();
      return Promise.reject(
        new PartnerNoShowError("timed out waiting for the other party"),
      );
    },
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

/** Mount a saved exchange's run surface and press Run, returning once the run has
 * reached the driver and left it the config to fail from. The click resolves as
 * soon as the handler starts, and the surface reads the record back from the
 * store before it dials, so the driver has not been called yet at that point --
 * a check that reads what the surface asked for has nothing to read. */
async function runUntilItFails(): Promise<void> {
  const created = await createManagedExchange(
    newExchange({ inputFileHandle: await inputHandle() }),
  );
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await vi.waitFor(() => expect(driverConfigs.seen).toHaveLength(1));
}

beforeEach(async () => {
  phase.dataExchangeStarted = false;
  driverConfigs.seen.length = 0;
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("the run surface reports its own data-exchange boundary", () => {
  test("a no-show before the boundary renders the no-show state", async () => {
    await runUntilItFails();

    await expect
      .element(page.getByText("Your partner did not arrive"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain("nothing left this device");
  });

  test("a no-show past the boundary renders the neutral transport state", async () => {
    // Payload could have flowed, so the run cannot attest that nothing left this
    // device -- whatever the error's own type says.
    phase.dataExchangeStarted = true;

    await runUntilItFails();

    await expect
      .element(page.getByText("The run could not be completed"))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "Your partner did not arrive",
    );
    expect(app.container.textContent).not.toContain("nothing left this device");
  });

  test("asks for no peer-wait bound of its own", async () => {
    // The bound the driver takes is one policy's: the scheduled runner clamps
    // its wait to the agreed window's close, so the window ends as the partner
    // no-show it is rather than as this operator's cancellation. An attended run
    // has an operator who can stop it and no window to end at, so it leaves the
    // wait on the flows' shared human-timescale budget -- and this is the one
    // check that reads the config the real component builds.
    await runUntilItFails();

    expect(driverConfigs.seen).toHaveLength(1);
    expect(driverConfigs.seen[0]).not.toHaveProperty("peerWaitTimeoutMs");
  });
});
