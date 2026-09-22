/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { CRON_EXPORT_CONFIG_FILE_NAME } from "@psi/managed/managedCronExport";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { SavedExchanges } from "@recurring/SavedExchanges";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// A configuration-only exchange against real Chromium and the real store: what an
// imported command-line configuration offers in place of a run, that the Run
// control is nowhere on either surface, and that the configuration it downloads
// is the one the command line loads.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

/** The fields an imported command-line configuration installs: no shared secret,
 * which is the whole of what withholds the run. */
function configurationOnly(): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
  };
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("the surface of an imported configuration", () => {
  test("offers the command-line export in place of a run", async () => {
    const created = await createManagedExchange(configurationOnly());

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(
        page.getByText("without the .psilink.key file it runs under", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Run exchange" }).query()).toBe(
      null,
    );
    expect(
      page.getByRole("button", { name: "Back up this exchange" }).query(),
    ).toBe(null);
  });

  test("downloads the psilink.yaml the command line loads", async () => {
    const created = await createManagedExchange(configurationOnly());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));

      await expect
        .element(
          page.getByRole("button", {
            name: `Download ${CRON_EXPORT_CONFIG_FILE_NAME}`,
          }),
        )
        .toBeInTheDocument();
      await page
        .getByRole("button", {
          name: `Download ${CRON_EXPORT_CONFIG_FILE_NAME}`,
        })
        .click();
      await downloads.settled();
    } finally {
      downloads.restore();
    }

    expect(downloads.captured).toHaveLength(1);
    const [file] = downloads.captured;
    expect(file.fileName).toBe(CRON_EXPORT_CONFIG_FILE_NAME);
    expect(file.text).toContain("linkage_terms:");
    expect(file.text).toContain("role: inviter");
  });

  test("the label edit lands on the stored record", async () => {
    const created = await createManagedExchange(configurationOnly());

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByRole("textbox", { name: "Label" }))
      .toBeInTheDocument();
    await page.getByRole("textbox", { name: "Label" }).fill("Riverbend yearly");
    await page.getByRole("button", { name: "Save settings" }).click();

    await expect
      .element(page.getByText("Settings saved", { exact: false }))
      .toBeInTheDocument();
    expect((await getManagedExchange(created.id))?.label).toBe(
      "Riverbend yearly",
    );
  });
});

describe("the surface of a configuration on a channel this app does not run", () => {
  test("names the channel, withholds the run, and states each notice", async () => {
    const created = await createManagedExchange({
      label: "Riverbend quarterly",
      exchangeFile: {
        ...assembleExchangeSpec({
          connection: connectionFromLocator({
            channel: "sftp",
            host: "sftp.example.org",
            path: "/exchange",
          }),
          linkageTerms,
        }),
        outboundPayloadConsent: { status: "pending" },
        retentionDisposition: "Filed with the program office.",
      },
    });

    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByText("SFTP (channel: sftp)", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("outbound_payload_consent is pending", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("retention_disposition", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", {
          name: `Download ${CRON_EXPORT_CONFIG_FILE_NAME}`,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Run exchange" }).query()).toBe(
      null,
    );
  });
});

describe("the list row of an imported configuration", () => {
  test("says what it is and opens instead of running", async () => {
    await createManagedExchange(configurationOnly());

    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText(
          "Configuration only - edit it here, run it with psilink",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Open" }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Run" }).query()).toBe(null);
    expect(page.getByText("Back up this exchange").query()).toBe(null);
  });
});
