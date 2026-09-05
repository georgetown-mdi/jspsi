/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managedExchangeStore";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managedLocalState";
import { CLI_BUILT_IN_STUN_URI } from "@recurring/managedCronExportModel";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { dispatchManagedCronExport } from "@psi/managedExchangeExport";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { CapturedDownload } from "./captureDownloads";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The command-line export panel on the run surface, against real Chromium: real
// IndexedDB stores, a real export, nothing stubbed. Pinned here: the hand-off
// invariant (the two files the CLI opens land, and this browser's copy is spent
// only on the operator's attestation, so a dismissed save leaves one live owner)
// and the custody line (these files are not a backup this browser restores from,
// so this export never touches the backup marker).

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

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

const app = createAppMount();

const exportToggle = () =>
  page.getByRole("button", { name: /run this from the command line/i });

/** Open the collapsed export panel on a freshly rendered run surface. */
async function openExportPanel(): Promise<void> {
  await expect.element(exportToggle()).toBeInTheDocument();
  expect(exportToggle().element().getAttribute("aria-expanded")).toBe("false");
  await exportToggle().click();
  expect(exportToggle().element().getAttribute("aria-expanded")).toBe("true");
}

/** Budget for the export dispatch: the click resolves before the dispatch reads
 * the record back out of IndexedDB, so the two anchor clicks land a store round
 * trip after the click, not with it. Bounded higher than `vi.waitFor`'s 1s
 * default, which is too tight for a store round trip while this project's files
 * run in parallel with the integration suites in CI. */
const EXPORT_DISPATCH_TIMEOUT_MS = 10_000;
/** Budget for the capture to read each downloaded blob back off its object URL,
 * the phase after the anchors are clicked. It is waited on separately so a
 * download that never fired and bytes that never came back name themselves apart,
 * rather than arriving as one empty-capture assertion. */
const DOWNLOAD_READ_BACK_TIMEOUT_MS = 10_000;

/** Click the panel's download action and wait for both files' bytes to be read
 * back off their object URLs. */
async function downloadBothFiles(
  captured: Array<CapturedDownload>,
): Promise<void> {
  await page
    .getByRole("button", { name: "Download psilink.yaml and .psilink.key" })
    .click();
  await vi.waitFor(() => expect(captured).toHaveLength(2), {
    timeout: EXPORT_DISPATCH_TIMEOUT_MS,
  });
  await vi.waitFor(
    () => expect(captured.every((file) => file.text !== "")).toBe(true),
    { timeout: DOWNLOAD_READ_BACK_TIMEOUT_MS },
  );
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("the command-line export hands over two files", () => {
  test("the CLI's config and key land, with the secret in the key half only", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);

      expect(downloads.captured.map((file) => file.fileName)).toEqual([
        "psilink.yaml",
        ".psilink.key",
      ]);
      const [config, key] = downloads.captured;
      expect(config.text).toContain("linkage_terms:");
      expect(config.text).not.toContain(created.sharedSecret);
      expect(key.text).toContain(created.sharedSecret);
      // The panel hands the secret to the operator's disk, never to the screen.
      expect(app.container.textContent).not.toContain(created.sharedSecret);
    } finally {
      downloads.restore();
    }
  });

  test("the panel names the secret, its custody, and the STUN disclosure", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(page.getByText("shared secret, in plain text", { exact: false }))
      .toBeInTheDocument();
    // The credential-at-rest posture is cited, not restated.
    await expect
      .element(page.getByRole("link", { name: "Key file security" }))
      .toBeInTheDocument();
    // A managed connection configures no ICE server, so every scheduled run falls
    // back to the CLI's built-in default and discloses the host's public address.
    await expect
      .element(page.getByText(CLI_BUILT_IN_STUN_URI, { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("backup of record", { exact: false }))
      .toBeInTheDocument();
    // The ready-to-run invocation and both schedule lines are on the panel.
    await expect
      .element(
        page.getByText("psilink exchange input.csv results.csv", {
          exact: true,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("0 2 * * *", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("schtasks /Create", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("the source is spent only on the operator's attestation", () => {
  test("dismissing the confirmation leaves this browser's copy live", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);

      await expect
        .element(page.getByText("Confirm the hand-off."))
        .toBeInTheDocument();
      await page
        .getByRole("button", { name: "Keep it in this browser" })
        .click();

      // No spend: the record still runs here, and the run affordance is still up.
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect
        .element(page.getByRole("button", { name: "Run exchange" }))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("confirming spends the source and takes down the run affordance", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);

      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await page
        .getByRole("button", {
          name: "I saved both files; hand off this exchange",
        })
        .click();

      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();
      // The spend records WHICH hand-off spent it, not just when: a migration's
      // spent state is revived by importing the artifact back, and this one has no
      // artifact to import.
      expect((await getManagedLocalState(created.id))?.spent).toMatchObject({
        handoff: "command-line",
      });
      // The run controls are gone with the copy they would have run.
      await expect
        .element(page.getByRole("button", { name: "Run exchange" }))
        .not.toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });
});

describe("the export leaves the backup indicator exactly where it was", () => {
  // The indicator answers one question -- is there a file this browser can restore
  // from -- and these two files are not one: this app's import does not accept them.
  // So no step of this export may mark the record, whichever way the operator goes.

  test("a dismissed export marks nothing, and the exchange is still backup-needed", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);
      await page
        .getByRole("button", { name: "Keep it in this browser" })
        .click();

      expect(await getManagedLocalState(created.id)).toBeUndefined();
      // Not just the stored marker: the panel above still asks for the backup this
      // operator does not have.
      await expect
        .element(page.getByText("Back up this exchange."))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("a confirmed hand-off marks nothing either", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);
      await page
        .getByRole("button", {
          name: "I saved both files; hand off this exchange",
        })
        .click();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();

      // The spend is the only thing this export writes.
      expect((await getManagedLocalState(created.id))?.backup).toBeUndefined();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      downloads.restore();
    }
  });

  test("an earlier backup's date stays untouched", async () => {
    // The other direction: a record that IS backed up must not lose or re-date its
    // marker for an export that has nothing to do with it.
    const created = await createManagedExchange(newExchange());
    await markManagedExchangeBackedUp(created.id, "2026-07-14T12:00:00.000Z");
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);

      expect((await getManagedLocalState(created.id))?.backup).toEqual({
        backedUpAt: "2026-07-14T12:00:00.000Z",
      });
      await expect
        .element(page.getByText("Backed up as of", { exact: false }))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("the panel names these files as the command line's, not a browser backup", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(
        page.getByText("not a backup file this browser can restore from", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The backup it points at is only a way back while the exchange stays here:
    // an artifact taken before a confirmed hand-off is refused on import.
    await expect
      .element(
        page.getByText(
          "a backup taken before the hand-off will not bring it back",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    // And the backup panel above says which file that is.
    await expect
      .element(
        page.getByText(
          "The backup file is the one this browser restores from",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
  });
});

describe("the durable spent surface names the hand-off that spent it", () => {
  // The "Handed off to the command line" surface a confirmation leaves on screen is
  // session state. What a LATER VISIT shows is read back from the sibling store, so
  // the stored spend is what has to hold the hand-off: a remount is the only way to
  // see the copy the operator actually lives with.

  /** Mount the run surface again from nothing, as a later visit does: the surface
   * re-reads the record and its sibling state rather than keeping what the
   * confirmation put in React state. */
  function remount(id: string): void {
    app.unmount();
    app.render(createElement(ManagedRunSurface, { id }));
  }

  test("a command-line hand-off remounts into the command-line copy", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads.captured);
      await page
        .getByRole("button", {
          name: "I saved both files; hand off this exchange",
        })
        .click();
      await expect
        .element(page.getByText("Handed off to the command line"))
        .toBeInTheDocument();

      remount(created.id);

      await expect
        .element(
          page.getByText("handed this exchange to the command line", {
            exact: false,
          }),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByText("backup of record", { exact: false }))
        .toBeInTheDocument();
      // Neither half of the migration copy is true here: no other device holds
      // this exchange, and the two files it runs from are not the artifact the
      // import flow accepts.
      expect(app.container.textContent).not.toContain("another device");
      expect(app.container.textContent).not.toContain("Import the backup");
    } finally {
      downloads.restore();
    }
  });

  test("a device migration remounts into the migration copy", async () => {
    // The path the discriminator must leave alone: a migration writes no hand-off,
    // and its spent copy still points at the import that revives it.
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await page
        .getByRole("button", { name: "Move to another device" })
        .click();
      await page
        .getByRole("button", {
          name: "I saved the file; hand off this exchange",
        })
        .click();
      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect(
        (await getManagedLocalState(created.id))?.spent?.handoff,
      ).toBeUndefined();

      remount(created.id);

      await expect
        .element(
          page.getByText("to take over on another device", { exact: false }),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Import the backup", { exact: false }))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });
});

describe("a record this app could not have composed", () => {
  /** A stored exchange the command-line composition refuses. Reachable only by
   * importing a hand-crafted artifact: the browser composes webrtc exchanges alone. */
  const refusedExchange = () =>
    newExchange({
      exchangeFile: assembleExchangeSpec({
        connection: connectionFromLocator({
          channel: "filedrop",
          path: "/srv/exchange",
        }),
        linkageTerms,
      }),
    });

  test("is refused rather than exported, and the panel says why", async () => {
    // The panel presents the composer's refusal.
    const created = await createManagedExchange(refusedExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect.element(exportToggle()).toBeInTheDocument();
    // The collapsed toggle already says there is nothing here to open into.
    await expect
      .element(page.getByText("Not available for this exchange"))
      .toBeInTheDocument();
    await exportToggle().click();

    await expect
      .element(
        page.getByText("cannot be handed to the command line", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("stored connection channel is filedrop"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", {
          name: "Download psilink.yaml and .psilink.key",
        }),
      )
      .not.toBeInTheDocument();
  });

  test("a dispatch past the panel's gate writes nothing in the real store", async () => {
    // The panel gates on the same refusal, but the gate and the click can diverge
    // (a concurrent import or rotation in another tab). The composition refuses the
    // record the store handed back, before anything is downloaded: against real
    // IndexedDB that leaves no sibling entry, no spend, and no record change.
    const created = await createManagedExchange(refusedExchange());
    const downloaded: Array<string> = [];
    const before = await getManagedExchange(created.id);

    await expect(
      dispatchManagedCronExport(created.id, {
        readRecord: getManagedExchange,
        download: (fileName) => downloaded.push(fileName),
        spendIfCurrent: spendManagedExchangeIfCurrent,
      }),
    ).rejects.toThrow(/stored connection channel is filedrop/);

    expect(downloaded).toEqual([]);
    expect(await getManagedLocalState(created.id)).toBeUndefined();
    expect(await getManagedExchange(created.id)).toEqual(before);
  });
});
