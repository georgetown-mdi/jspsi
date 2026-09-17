/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
} from "@psi/disclosureAccounting";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeScheduleAdvance,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import { ManagedExchangeDetail } from "@recurring/ManagedExchangeDetail";

import {
  FILEABLE_DISCLOSURE_NOTE,
  PARTIAL_DISCLOSURE_LABEL,
  UNBUILT_DISCLOSURE_NOTE,
  UNREADABLE_DISCLOSURE_NOTE,
  disclosureEntries,
} from "@recurring/disclosureAccountingModel";

import {
  NO_PARKED_RESULTS_NOTE,
  PARKED_RESULTS_RETENTION_NOTE,
  PARKED_RESULTS_SCHEDULE_NOTE,
  UNAVAILABLE_PARKED_RESULTS_NOTE,
  UNREADABLE_PARKED_RESULTS_NOTE,
} from "@recurring/parkedResultsModel";
import { PARKED_RESULTS_VERSION, runResultsFileName } from "@psi/parkedResults";
import { OUTPUT_FOLDER_UNSCHEDULED_NOTE } from "@recurring/scheduleEntryModel";
import { UNCHANGED_INPUT_TITLE } from "@recurring/scheduleSurfacingModel";

import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../utils/disclosureFixtures";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { captureDownloads } from "./captureDownloads";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeSchedule,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";
import type { UnfiledDisclosureRead } from "@psi/unfiledDisclosureStore";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The managed exchange detail sections, rendered: the read-only configuration with
// its re-invite affordance (never an edit control over the terms), the editable
// local fields, and the accounting of disclosures (no signed-receipt claim, and a
// failed read that is never treated as "nothing was disclosed"). The stubbed Link is
// what lets the accounting's /verify link render outside a router.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function exchangeFile() {
  return composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
}

function record(
  side: ManagedExchangeSide,
  overrides: Partial<NewManagedExchange> = {},
) {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: exchangeFile(),
    side,
    sharedSecret: "A".repeat(43),
    ...overrides,
  });
}

const app = createAppMount();

/** The origin-private-file-system directories a grant test made, removed after
 * it. */
const GRANTED_FOLDERS: Array<string> = [];

afterEach(app.unmount);

afterEach(async () => {
  const root = await navigator.storage.getDirectory();
  for (const name of GRANTED_FOLDERS.splice(0))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
});

describe("managed exchange detail configuration", () => {
  test("the inviter sees read-only terms with a re-invite affordance, not an edit control", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The agreed identity renders read-only in the configuration view.
    await expect
      .element(page.getByText("County Health Dept"))
      .toBeInTheDocument();
    // The terms have a fast re-invite affordance (same terms, new secret), not an
    // edit control over them, and the button is labeled to what it does.
    await expect
      .element(
        page.getByRole("button", { name: "Re-invite with the same terms" }),
      )
      .toBeInTheDocument();
    // The stale "change the terms" label -- which the flow could not honor -- is gone.
    expect(
      page
        .getByRole("button", { name: "Re-invite to change the terms" })
        .query(),
    ).toBeNull();
    // To change the terms the operator sets up a new exchange, linked here.
    await expect
      .element(page.getByRole("link", { name: "new exchange" }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Edit terms" }).query()).toBeNull();
    expect(
      page.getByRole("button", { name: "Edit the terms" }).query(),
    ).toBeNull();
  });

  test("the acceptor is told different terms mean a new exchange, not shown a mint button", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("acceptor"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: false,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(
        page.getByText("your partner cannot re-invite you onto different", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Re-invite with the same terms" })
        .query(),
    ).toBeNull();
  });

  test("a value list renders one entry per item, and a hostile name reaches the DOM escaped", async () => {
    // Two properties of the same surface, driven over one document. A key name may
    // include the list separator, so joined text would present one agreed term as
    // two -- the entries are their own list items instead. And a name may hold a
    // bidi override, which JSX escaping does not touch: it must arrive as an
    // escape, not as a code point that reorders the term a compliance user is
    // confirming.
    //
    // The terms name shape refuses that name at both the mint and the store's
    // own parse, so it is written into the record after it is built. The
    // component escapes the record it is handed rather than trusting what
    // produced it, and that is the property driven here.
    const separatorName = "SSN, DOB";
    const hostileName = "LN\u202eEVIL";
    const stored = record("inviter", {
      exchangeFile: composeManagedExchangeFile({
        connection: webrtcLocator,
        linkageTerms: {
          ...getDefaultLinkageTerms("County Health Dept"),
          linkageKeys: [
            { name: separatorName, elements: [{ field: "ssn" }] },
            { name: "LN", elements: [{ field: "last_name" }] },
          ],
        },
      }),
    });
    stored.exchangeFile.linkageTerms.linkageKeys[1].name = hostileName;
    app.render(
      createElement(ManagedExchangeDetail, {
        record: stored,
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect.element(page.getByText("Matched on")).toBeInTheDocument();
    const entries = [...app.container.querySelectorAll("li")].map(
      (item) => item.textContent,
    );
    expect(entries).toContain(separatorName);
    expect(entries).toContain("LN\\u202eEVIL");
    expect(app.container.textContent).not.toContain("\u202e");
  });

  test("a rejecting re-invite on the healthy detail surface shows the error and the button loads while pending", async () => {
    // The re-invite button lives on the healthy detail surface, where no failure
    // branch renders -- so its in-flight and failed state must be visible here, not
    // only under the run surface's failure recovery. The surface owns the reinviting/
    // reinviteFailed state; this drives them through the props exactly as it does.
    let reject: (reason: Error) => void = () => undefined;
    const promise = new Promise<void>((_resolve, rejectFn) => {
      reject = rejectFn;
    });
    let reinviting = false;
    let reinviteFailed = false;

    function render() {
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter"),
          parkedResultsRead: { kind: "none" },
          accountingRead: { kind: "none" },
          onResetAccounting: () => Promise.resolve(),
          onRetryAccountingRead: () => undefined,
          onRetryParkedResultsRead: () => undefined,
          onClearParkedResults: () => Promise.resolve(),
          onGrantOutputFolder: () => Promise.resolve(),
          onStopUsingOutputFolder: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => {
            reinviting = true;
            reinviteFailed = false;
            render();
            void promise.catch(() => {
              reinviting = false;
              reinviteFailed = true;
              render();
            });
          },
          canReinvite: true,
          compromiseResponse: false,
          reinviting,
          reinviteFailed,
          unfiledDisclosureRead: { kind: "none" },
          unrecordedRunFlagged: false,
          onUnrecordedRunFlagShown: () => undefined,
          onFileUnfiledDisclosures: () => Promise.resolve(),
        }),
      );
    }

    render();

    const button = page.getByRole("button", {
      name: "Re-invite with the same terms",
    });
    await button.click();

    // While the re-invite is pending, the button is in its loading state (Mantine
    // marks a loading Button with data-loading and disables it).
    await vi.waitFor(() =>
      expect(button.element().hasAttribute("data-loading")).toBe(true),
    );

    reject(new Error("re-invite rejected"));

    // The failure shows beside the button, in the file's existing error voice.
    await expect
      .element(
        page.getByText("Could not create a fresh invitation", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The button is no longer loading once the attempt settled.
    await vi.waitFor(() =>
      expect(button.element().hasAttribute("data-loading")).toBe(false),
    );
  });
});

describe("managed exchange detail local fields", () => {
  test("the label and max-age policy edit in place, calling the save with the edits", async () => {
    const saved: Array<ManagedExchangeLocalEdits> = [];
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: (edits) => {
          saved.push(edits);
          return Promise.resolve();
        },
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The label edits in place -- a textbox pre-filled with the current label.
    const label = page.getByRole("textbox", { name: "Label" });
    await expect.element(label).toBeInTheDocument();
    await label.fill("Riverbend monthly");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].label).toBe("Riverbend monthly");
    // The policy was off (no tokenMaxAgeDays on the record), so the edit clears it.
    expect(saved[0].tokenMaxAgeDays).toBeNull();
    // A saved confirmation renders.
    await expect.element(page.getByText("Settings saved.")).toBeInTheDocument();
  });

  test("reads back the current derived bound: a lapse date when expires is set", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", {
          tokenMaxAgeDays: 90,
          expires: "2026-10-01T00:00:00.000Z",
        }),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // Anchored so it targets the derived readback line, not the checkbox description
    // or the cadence note, which also contain "stored secret lapses".
    await expect
      .element(page.getByText(/^Stored secret lapses /))
      .toBeInTheDocument();
  });

  test("reads back no age bound when expires is absent", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(
        page.getByText("the stored secret does not lapse by age", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });
});

describe("managed exchange detail schedule entry", () => {
  /** Render the detail sections over `stored`, collecting the edits each save
   * holds, and the calls the output-folder grant makes. */
  function renderEntry(
    stored?: ManagedExchangeSchedule,
    folder?: FileSystemDirectoryHandle,
    stopUsingRejects?: boolean,
  ): {
    saved: Array<ManagedExchangeLocalEdits>;
    granted: Array<string>;
  } {
    const saved: Array<ManagedExchangeLocalEdits> = [];
    const granted: Array<string> = [];
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", {
          ...(stored !== undefined ? { schedule: stored } : {}),
          ...(folder !== undefined ? { outputDirectoryHandle: folder } : {}),
        }),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => {
          granted.push("chose");
          return Promise.resolve();
        },
        onStopUsingOutputFolder: () => {
          granted.push("stopped");
          return stopUsingRejects === true
            ? Promise.reject(new Error("store failed"))
            : Promise.resolve();
        },
        onSaveLocalFields: (edits) => {
          saved.push(edits);
          return Promise.resolve();
        },
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
    return { saved, granted };
  }

  const scheduleCheckbox = () =>
    page.getByRole("checkbox", {
      name: "Run this exchange on an agreed schedule",
    });

  /** An origin-private-file-system directory, standing in for a granted folder:
   * the surface reads only its name and the runtime's support for handles. */
  async function opfsDirectory(
    name: string,
  ): Promise<FileSystemDirectoryHandle> {
    GRANTED_FOLDERS.push(name);
    return (await navigator.storage.getDirectory()).getDirectoryHandle(name, {
      create: true,
    });
  }

  test("offers the results folder first, with keeping results here as what happens without one", async () => {
    renderEntry();
    await scheduleCheckbox().click();

    // The grant is the path offered, and the browser-storage statement is
    // titled as the case without a folder rather than as the only outcome.
    const grant = page
      .getByRole("heading", { name: "Results folder" })
      .element();
    const fallback = page
      .getByText("Where a scheduled run's results go without a folder")
      .element();
    expect(
      grant.compareDocumentPosition(fallback) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect
      .element(page.getByRole("button", { name: "Choose folder" }))
      .toBeInTheDocument();
  });

  test("the choose-folder control reaches the grant, which the run never asks for", async () => {
    const { granted } = renderEntry();
    await scheduleCheckbox().click();
    await page.getByRole("button", { name: "Choose folder" }).click();
    expect(granted).toEqual(["chose"]);
  });

  test("a granted folder is named, re-pointable, and droppable", async () => {
    const { granted } = renderEntry(
      undefined,
      await opfsDirectory("results-granted"),
    );
    await scheduleCheckbox().click();

    await expect
      .element(page.getByText("results-granted", { exact: false }))
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: "Choose a different folder" })
      .click();
    await page
      .getByRole("button", { name: "Stop writing to this folder" })
      .click();
    expect(granted).toEqual(["chose", "stopped"]);
  });

  test("a failed stop says the folder is still being written to, not that a choice did not take", async () => {
    renderEntry(undefined, await opfsDirectory("results-kept"), true);
    await scheduleCheckbox().click();
    await page
      .getByRole("button", { name: "Stop writing to this folder" })
      .click();

    await expect
      .element(page.getByText("That folder was not removed"))
      .toBeInTheDocument();
    expect(page.getByText("That folder was not set").query()).toBeNull();
  });

  test("a granted folder stays shown with scheduling off, and can still be dropped", async () => {
    // Turning the schedule off stops the runs, not the grant: a surface gated on
    // the schedule would leave the folder granted with nothing naming it and no
    // way to drop it short of deleting the exchange.
    const anchor = new Date(Date.now() + 3600_000).toISOString();
    const { granted } = renderEntry(
      {
        anchor,
        intervalDays: 7,
        windowSeconds: 10_800,
        nextWindow: anchor,
        consecutiveMisses: 0,
      },
      await opfsDirectory("results-unscheduled"),
    );

    await expect.element(scheduleCheckbox()).toBeChecked();
    await scheduleCheckbox().click();

    // The cadence fields are gone with the schedule; the grant is not.
    expect(
      page.getByLabelText("A window opens every (days)").query(),
    ).toBeNull();
    await expect
      .element(page.getByText("results-unscheduled", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(OUTPUT_FOLDER_UNSCHEDULED_NOTE))
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: "Stop writing to this folder" })
      .click();
    expect(granted).toEqual(["stopped"]);
  });

  test("shows nothing of the results folder with scheduling off and no folder granted", async () => {
    renderEntry();

    await expect.element(scheduleCheckbox()).not.toBeChecked();
    expect(page.getByRole("heading", { name: "Results folder" }).query()).toBe(
      null,
    );
    expect(page.getByRole("button", { name: "Choose folder" }).query()).toBe(
      null,
    );
    expect(
      page
        .getByText("Where a scheduled run's results go without a folder")
        .query(),
    ).toBe(null);
  });

  test("scheduling is off by default, and the fields appear only once it is on", async () => {
    renderEntry();

    await expect.element(scheduleCheckbox()).not.toBeChecked();
    expect(
      page.getByLabelText("A window opens every (days)").query(),
    ).toBeNull();

    await scheduleCheckbox().click();

    await expect
      .element(page.getByLabelText("A window opens every (days)"))
      .toBeInTheDocument();
  });

  test("an entered cadence saves as a schedule, resolved to a stored instant", async () => {
    const { saved } = renderEntry();

    await scheduleCheckbox().click();
    await page
      .getByLabelText("First agreed run window (date)")
      .fill("2026-08-04");
    await page.getByLabelText("Time the window opens").fill("09:00");
    await page.getByLabelText("A window opens every (days)").fill("7");
    await page.getByLabelText("Each window stays open (hours)").fill("3");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    const entered = saved[0].schedule;
    expect(entered).not.toBeNull();
    expect(entered?.intervalDays).toBe(7);
    expect(entered?.windowSeconds).toBe(3 * 3600);
    // Resolved to the instant the operator's own clock names, which is what both
    // runners meet at; the wall clock itself is never stored.
    expect(entered?.anchor).toBe(
      new Date(2026, 7, 4, 9, 0, 0, 0).toISOString(),
    );
    expect(entered?.consecutiveMisses).toBe(0);
  });

  test("turning scheduling off drops the stored schedule", async () => {
    const anchor = new Date(Date.now() + 3600_000).toISOString();
    const { saved } = renderEntry({
      anchor,
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: anchor,
      consecutiveMisses: 0,
    });

    await expect.element(scheduleCheckbox()).toBeChecked();
    await scheduleCheckbox().click();
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].schedule).toBeNull();
  });

  test("a save with scheduling off on a record that never had one includes no schedule edit", async () => {
    // The toggle is a three-way edit and the untouched-off corner is its quiet
    // one: `null` would be a drop of a schedule that is not there, which the
    // store would apply as a write. Omitting the key leaves the record's
    // attended-only shape exactly as it is.
    const { saved } = renderEntry();

    await expect.element(scheduleCheckbox()).not.toBeChecked();
    await page.getByRole("textbox", { name: "Label" }).fill("Attended only");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].label).toBe("Attended only");
    expect("schedule" in saved[0]).toBe(false);
  });

  test("a save that touched only the label includes no schedule edit at all", async () => {
    // The planned window and the miss count are the runner's bookkeeping; a label
    // edit must not reset either, must not re-resolve the agreed instant, and must
    // not write the mount-time object back over what the runner has since advanced.
    const stored: ManagedExchangeSchedule = {
      anchor: new Date(2026, 7, 4, 9, 0, 0, 0).toISOString(),
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: new Date(2026, 8, 1, 9, 0, 0, 0).toISOString(),
      consecutiveMisses: 2,
    };
    const { saved } = renderEntry(stored);

    await page
      .getByRole("textbox", { name: "Label" })
      .fill("Riverbend monthly");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].label).toBe("Riverbend monthly");
    expect("schedule" in saved[0]).toBe(false);
  });

  test("a stored width finer than the field's unit is shown and saved as it is", async () => {
    // An imported or hand-edited record can hold a width and an anchor at a
    // finer resolution than the fields hold. Both must survive an edit to some
    // other field, and the width the operator reads has to be the one their
    // partner agreed rather than a round number standing in for it.
    const stored: ManagedExchangeSchedule = {
      anchor: new Date(2026, 7, 4, 9, 0, 30, 500).toISOString(),
      intervalDays: 7,
      windowSeconds: 5400,
      nextWindow: new Date(2026, 8, 1, 9, 0, 30, 500).toISOString(),
      consecutiveMisses: 2,
    };
    const { saved } = renderEntry(stored);

    await expect
      .element(page.getByLabelText("Each window stays open (hours)"))
      .toHaveValue("1.5");

    await page.getByLabelText("A window opens every (days)").fill("14");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].schedule?.intervalDays).toBe(14);
    expect(saved[0].schedule?.windowSeconds).toBe(5400);
    expect(saved[0].schedule?.anchor).toBe(stored.anchor);
  });

  test("a stored width below the entry floor still lets an edit to another field save", async () => {
    // A width entry's own floor refuses can only arrive from an import or a hand
    // edit. Holding the operator to it would withhold the label edit in front of
    // them over a value they never typed, and the form will not rewrite the width
    // their partner agreed on their behalf either.
    const stored: ManagedExchangeSchedule = {
      anchor: new Date(2026, 7, 4, 9, 0, 0, 0).toISOString(),
      intervalDays: 7,
      windowSeconds: 60,
      nextWindow: new Date(2026, 8, 1, 9, 0, 0, 0).toISOString(),
      consecutiveMisses: 2,
    };
    const { saved } = renderEntry(stored);

    await page
      .getByRole("textbox", { name: "Label" })
      .fill("Riverbend monthly");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].label).toBe("Riverbend monthly");
    expect("schedule" in saved[0]).toBe(false);
  });

  test("a stored width below the entry floor survives a focus and a blur", async () => {
    // The widget's own clamp is what this turns off: a NumberInput with bounds
    // rewrites a value outside them when it loses focus, so an operator who
    // merely tabbed through the width field on their way to the label would
    // push the floor into the save and change the width their partner agreed.
    // The bounds are the entry model's, which states them at the field rather
    // than editing the value under the operator.
    const stored: ManagedExchangeSchedule = {
      anchor: new Date(2026, 7, 4, 9, 0, 0, 0).toISOString(),
      intervalDays: 7,
      windowSeconds: 60,
      nextWindow: new Date(2026, 8, 1, 9, 0, 0, 0).toISOString(),
      consecutiveMisses: 2,
    };
    const { saved } = renderEntry(stored);

    const width = page.getByLabelText("Each window stays open (hours)");
    await expect.element(width).toBeInTheDocument();
    const shown = () => (width.element() as HTMLInputElement).value;
    expect(Number(shown())).toBeCloseTo(60 / 3600, 10);

    await userEvent.click(width);
    await userEvent.click(page.getByRole("textbox", { name: "Label" }));

    expect(Number(shown())).toBeCloseTo(60 / 3600, 10);

    await page
      .getByRole("textbox", { name: "Label" })
      .fill("Riverbend monthly");
    await page.getByRole("button", { name: "Save settings" }).click();

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    // No schedule edit at all is the proof the clamp left the width alone: a
    // rewritten width would be treated as an operator edit and rebuild the cadence.
    expect("schedule" in saved[0]).toBe(false);
  });

  test("an out-of-range window width blocks the save at its own field", async () => {
    renderEntry();

    await scheduleCheckbox().click();
    await page.getByLabelText("Each window stays open (hours)").fill("0");

    // The error names what the width buys rather than only the range, and the
    // save is withheld until it is fixed -- an unusable cadence must not reach
    // the store write as a generic failure after the click.
    await expect
      .element(page.getByText("clock difference", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Save settings" }))
      .toBeDisabled();
  });

  test("a cadence that outruns the max-age bound is shown, not silently accepted", async () => {
    const { saved } = renderEntry();

    await scheduleCheckbox().click();
    await page.getByLabelText("A window opens every (days)").fill("30");
    await page
      .getByRole("checkbox", {
        name: "Set a maximum age for the stored secret",
      })
      .click();
    await page.getByLabelText("Maximum age in days").fill("7");

    await expect
      .element(page.getByText("This cadence outruns the maximum age"))
      .toBeInTheDocument();
    // The bound's own terms, and the cadence it is weighed against.
    await expect
      .element(
        page.getByText(
          "must run or be renewed within 7 days, but a run window opens only every 30 days",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    // Shown rather than refused: an operator who renews by hand is entitled to
    // this cadence, and the problem stands beside the save rather than blocking
    // it.
    await page.getByRole("button", { name: "Save settings" }).click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].schedule?.intervalDays).toBe(30);
    expect(saved[0].tokenMaxAgeDays).toBe(7);
  });

  test("a cadence inside the bound raises no problem", async () => {
    renderEntry();

    await scheduleCheckbox().click();
    await page.getByLabelText("A window opens every (days)").fill("7");
    await page
      .getByRole("checkbox", {
        name: "Set a maximum age for the stored secret",
      })
      .click();
    await page.getByLabelText("Maximum age in days").fill("30");

    await expect
      .element(page.getByLabelText("Maximum age in days"))
      .toHaveValue("30");
    expect(
      page.getByText("This cadence outruns the maximum age").query(),
    ).toBeNull();
  });
});

describe("managed exchange detail local fields against the real store", () => {
  // The editor holds the record the page mounted on, while the unattended runner
  // advances the same record's schedule underneath it. What the save holds has to
  // be the operator's edit and nothing else, which only a store behind the page can
  // show: the mount-time snapshot is a valid schedule, so a write-back of it is
  // accepted by the store and silently rewinds the runner's own bookkeeping.
  beforeEach(clearManagedExchanges);
  afterEach(clearManagedExchanges);

  const savingTo = (id: string) => (edits: ManagedExchangeLocalEdits) =>
    updateManagedExchangeLocalFields(id, edits).then(() => undefined);

  const dailySchedule = (): ManagedExchangeSchedule => {
    const anchor = new Date(2026, 7, 4, 9, 0, 0, 0).toISOString();
    return {
      anchor,
      intervalDays: 1,
      windowSeconds: 10_800,
      nextWindow: anchor,
      consecutiveMisses: 0,
    };
  };

  /** The schedule one missed window later: the plan advanced to the next window
   * and the miss counted, which is what the runner's own advance writes. */
  function afterOneMissedWindow(
    schedule: ManagedExchangeSchedule,
  ): ManagedExchangeSchedule {
    return {
      ...schedule,
      nextWindow: new Date(
        Date.parse(schedule.nextWindow) + schedule.intervalDays * 86_400_000,
      ).toISOString(),
      consecutiveMisses: schedule.consecutiveMisses + 1,
    };
  }

  test("a label-only save leaves the schedule the runner advanced behind the page", async () => {
    const schedule = dailySchedule();
    const stored = await createManagedExchange({
      label: "Riverbend quarterly",
      exchangeFile: exchangeFile(),
      side: "inviter",
      sharedSecret: "A".repeat(43),
      schedule,
    });

    app.render(
      createElement(ManagedExchangeDetail, {
        record: stored,
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: savingTo(stored.id),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
    // The form has read the record before the store moves under it.
    await expect
      .element(page.getByLabelText("A window opens every (days)"))
      .toHaveValue("1");

    // The window opens, nobody arrives, and the runner writes its advance while the
    // operator's page sits open on the schedule as it stood at mount.
    const advanced = afterOneMissedWindow(schedule);
    await persistManagedExchangeScheduleAdvance(stored.id, {
      schedule: advanced,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
    });

    await page
      .getByRole("textbox", { name: "Label" })
      .fill("Riverbend monthly");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect.element(page.getByText("Settings saved.")).toBeInTheDocument();

    const saved = await getManagedExchange(stored.id);
    expect(saved?.label).toBe("Riverbend monthly");
    // The advance stands: the plan is not rewound to the window already accounted
    // for, and the miss the escalation counts is not erased.
    expect(saved?.schedule?.nextWindow).toBe(advanced.nextWindow);
    expect(saved?.schedule?.consecutiveMisses).toBe(1);
  });

  test("an edited cadence replaces the schedule, bookkeeping and all", async () => {
    const schedule = dailySchedule();
    const stored = await createManagedExchange({
      label: "Riverbend quarterly",
      exchangeFile: exchangeFile(),
      side: "inviter",
      sharedSecret: "A".repeat(43),
      schedule,
    });

    app.render(
      createElement(ManagedExchangeDetail, {
        record: stored,
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: savingTo(stored.id),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
    await expect
      .element(page.getByLabelText("A window opens every (days)"))
      .toHaveValue("1");

    await persistManagedExchangeScheduleAdvance(stored.id, {
      schedule: afterOneMissedWindow(schedule),
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
    });

    await page.getByLabelText("A window opens every (days)").fill("7");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect.element(page.getByText("Settings saved.")).toBeInTheDocument();

    // A cadence the operator did edit is a new lattice, so the count the old one
    // accumulated goes with it -- the omission above is scoped to a cadence nobody
    // touched, not a general refusal to write the schedule.
    const saved = await getManagedExchange(stored.id);
    expect(saved?.schedule?.intervalDays).toBe(7);
    expect(saved?.schedule?.consecutiveMisses).toBe(0);
    expect(saved?.schedule?.anchor).toBe(schedule.anchor);
  });
});

describe("managed exchange detail run schedule", () => {
  /** A daily cadence with a three-hour window, anchored `opensInMs` from the real
   * clock the section reads: negative puts the window's open in the past, so a
   * window is open right now; positive leaves it ahead. */
  function schedule(
    opensInMs: number,
    overrides: Partial<ManagedExchangeSchedule> = {},
  ): ManagedExchangeSchedule {
    const anchor = new Date(Date.now() + opensInMs).toISOString();
    return {
      anchor,
      intervalDays: 1,
      windowSeconds: 10_800,
      nextWindow: anchor,
      consecutiveMisses: 0,
      ...overrides,
    };
  }

  function renderWithSchedule(
    scheduled?: ManagedExchangeSchedule,
    overrides: Partial<NewManagedExchange> = {},
  ) {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", {
          ...(scheduled !== undefined ? { schedule: scheduled } : {}),
          ...overrides,
        }),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
  }

  test("a record with no agreed schedule renders no schedule section", async () => {
    renderWithSchedule();

    // The other sections still render, so this is not a blank surface passing.
    await expect
      .element(page.getByRole("heading", { name: "Run history" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("heading", { name: "Run schedule" }).query(),
    ).toBeNull();
  });

  test("an open window is named as open, beside the agreed cadence", async () => {
    renderWithSchedule(schedule(-60 * 60 * 1000));

    await expect
      .element(page.getByRole("heading", { name: "Run schedule" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Run window open now", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("A run window opens every day and stays open 3 hours", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("a window still ahead is named as the next one", async () => {
    renderWithSchedule(schedule(2 * 60 * 60 * 1000));

    await expect
      .element(page.getByText("Next run window:", { exact: false }))
      .toBeInTheDocument();
  });

  test("the section promises no run this tab will not make, and points at the editor", async () => {
    // The suite runs in an ordinary browser tab rather than an installed app, so
    // the accurate reading here is the one that promises nothing.
    renderWithSchedule(schedule(-60 * 60 * 1000));

    await expect
      .element(
        page.getByText("never runs this exchange on its own", { exact: false }),
      )
      .toBeInTheDocument();
    // The cadence is editable, in the local-fields form above, and the section
    // names where rather than implying it is nowhere.
    await expect
      .element(
        page.getByText("Change it under Local settings above", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("a record holding no input handle says nothing can run with nobody present", async () => {
    // A scheduled record and a persisted input handle are independent: this one
    // has a cadence and no File System Access handle, which is the state of
    // every record on a browser without the API and of every imported one. The
    // note is what the runner's own silent skip of such a record owes the
    // operator.
    renderWithSchedule(schedule(-60 * 60 * 1000));

    await expect
      .element(
        page.getByText(
          "no run of this exchange can happen with nobody present",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
  });

  test("a single miss raises no coordination prompt", async () => {
    renderWithSchedule(schedule(-60 * 60 * 1000, { consecutiveMisses: 1 }));

    await expect
      .element(page.getByRole("heading", { name: "Run schedule" }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("Runs are not happening on schedule", { exact: false })
        .query(),
    ).toBeNull();
  });

  test("the second consecutive miss raises the coordination prompt, naming both checks", async () => {
    renderWithSchedule(schedule(-60 * 60 * 1000, { consecutiveMisses: 2 }));

    await expect
      .element(
        page.getByText("Runs are not happening on schedule", { exact: false }),
      )
      .toBeInTheDocument();
    // Both checks -- the partner, and this device's own clock -- and no pause
    // taken on the operator's behalf.
    await expect
      .element(page.getByText("still running this exchange", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("this device's clock", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("the schedule stands", { exact: false }))
      .toBeInTheDocument();
  });

  /** A stub input-file pointer that counts the platform reads made through it and
   * hands back a file stamped at `lastModifiedMs`. A picker handle, the only real
   * one carrying the permission extension, cannot be summoned from a test, and an
   * origin-private file is stamped at the moment the suite writes it. */
  function inputHandleStub(lastModifiedMs: number) {
    const reads: Array<string> = [];
    const handle = {
      kind: "file",
      name: "input.csv",
      queryPermission: () => {
        reads.push("queryPermission");
        return Promise.resolve("granted");
      },
      getFile: () => {
        reads.push("getFile");
        return Promise.resolve(
          new File(["id\n1\n"], "input.csv", { lastModified: lastModifiedMs }),
        );
      },
    };
    return { handle: handle as unknown as FileSystemFileHandle, reads };
  }

  const succeededAt = "2026-07-14T12:00:00.000Z";

  test("an input file last changed before the last successful run raises the note", async () => {
    const input = inputHandleStub(Date.parse("2026-07-10T09:15:00.000Z"));
    renderWithSchedule(schedule(-60 * 60 * 1000), {
      inputFileHandle: input.handle,
      lastRun: { at: succeededAt, outcome: "succeeded" },
    });

    // The instant arrives from an asynchronous platform read, so the note appears
    // a beat after the section around it.
    await expect
      .element(page.getByText(UNCHANGED_INPUT_TITLE, { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("link the same data again", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("Put this period's extract at that file's name", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("an input file refreshed since that run raises nothing", async () => {
    const input = inputHandleStub(Date.parse("2026-07-15T06:00:00.000Z"));
    renderWithSchedule(schedule(-60 * 60 * 1000), {
      inputFileHandle: input.handle,
      lastRun: { at: succeededAt, outcome: "succeeded" },
    });

    // Absence is asserted only once the read has resolved and the render it would
    // have caused has landed, so a note arriving late cannot pass as none.
    await vi.waitFor(() => {
      expect(input.reads).toContain("getFile");
    });
    await flushPendingUpdates();
    expect(
      page.getByText(UNCHANGED_INPUT_TITLE, { exact: false }).query(),
    ).toBeNull();
  });

  test("a record with no agreed schedule never reads the input file", async () => {
    // No schedule section means no note to feed, and the operator's file is left
    // untouched rather than read for a reading nothing renders.
    const input = inputHandleStub(Date.parse("2026-07-10T09:15:00.000Z"));
    renderWithSchedule(undefined, {
      inputFileHandle: input.handle,
      lastRun: { at: succeededAt, outcome: "succeeded" },
    });

    await expect
      .element(page.getByRole("heading", { name: "Run history" }))
      .toBeInTheDocument();
    await flushPendingUpdates();
    expect(input.reads).toEqual([]);
  });
});

describe("managed exchange detail accounting of disclosures", () => {
  test("frames the accounting as self-attested and unsigned, never a signed receipt", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(page.getByText("self-attested", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("not a signed or", { exact: false }))
      .toBeInTheDocument();
    // The verify page is linked, not modified.
    const verify = page.getByRole("link", { name: "verify page" });
    await expect.element(verify).toBeInTheDocument();
    expect(verify.element().getAttribute("href")).toBe("/verify");
    // No claim of a signed/non-repudiable receipt appears as a positive assertion.
    expect(
      page.getByText("signed receipt", { exact: true }).query(),
    ).toBeNull();
  });

  test("a never-run exchange states what is recorded here, and offers no export", async () => {
    // A device that imported the exchange from a backup file holds no accounting
    // -- the artifact does not contain one -- so an unqualified "it has disclosed
    // nothing" would be treated there as the partnership's whole disclosure history.
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(
        page.getByText(
          "This browser's copy of the accounting is empty: no run of this exchange has filed a disclosure here.",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "an exchange imported from a backup file arrives without the accounting kept on the device it came from",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    // The claim the copy must never make on its own: that the exchange itself
    // disclosed nothing.
    expect(
      page.getByText("it has disclosed nothing", { exact: false }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: /Export this accounting/ }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("Export it if you need to keep it", { exact: false })
        .query(),
    ).toBeNull();
  });

  test.each([
    { failureKind: "cancelled" as const, how: "an operator cancelled it" },
    { failureKind: "transport" as const, how: "the connection dropped" },
  ])(
    "an empty accounting beside a run that stopped when $how does not deny the send",
    async ({ failureKind }) => {
      // A run that stopped after sending files its entry best-effort, and a filing
      // that fails there is reported to the diagnostic log alone (see
      // docs/spec/MANAGED_EXCHANGE_RECORD.md, "When an entry is written"), so an
      // empty accounting is not evidence the payload never left this browser.
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter", {
            lastRun: {
              at: "2026-07-01T09:00:00.000Z",
              outcome: "failed",
              failureKind,
            },
          }),
          parkedResultsRead: { kind: "none" },
          accountingRead: { kind: "none" },
          onResetAccounting: () => Promise.resolve(),
          onRetryAccountingRead: () => undefined,
          onRetryParkedResultsRead: () => undefined,
          onClearParkedResults: () => Promise.resolve(),
          onGrantOutputFolder: () => Promise.resolve(),
          onStopUsingOutputFolder: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => undefined,
          canReinvite: true,
          reinviting: false,
          reinviteFailed: false,
          compromiseResponse: false,
          unfiledDisclosureRead: { kind: "none" },
          unrecordedRunFlagged: false,
          onUnrecordedRunFlagShown: () => undefined,
          onFileUnfiledDisclosures: () => Promise.resolve(),
        }),
      );

      await expect
        .element(
          page.getByText(
            "no run of this exchange has filed a disclosure here",
            {
              exact: false,
            },
          ),
        )
        .toBeInTheDocument();
      await expect
        .element(
          page.getByText("not a record that nothing was sent", {
            exact: false,
          }),
        )
        .toBeInTheDocument();
      // The limit is stated in the run history's own words for the same run, so
      // the two sections of this page cannot say different things about it.
      expect(
        page
          .getByText(
            "Whether any data reached your partner is not recorded here",
            {
              exact: false,
            },
          )
          .elements(),
      ).toHaveLength(2);
      // The plain empty state, which reads as an absence of disclosures, is the
      // one this run must not get.
      expect(
        page
          .getByText("That is not necessarily the exchange's whole history", {
            exact: false,
          })
          .query(),
      ).toBeNull();
    },
  );

  test("an accounting emptied beside a completed run states the emptiness, not an absence of runs", async () => {
    // What a recovery reset leaves: the entries destroyed, the record's own run
    // history still holding the run that filed them. An auditor reads this surface,
    // so the copy must not show a deliberate destruction as "nothing has run".
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", {
          lastRun: { at: "2026-07-01T09:00:00.000Z", outcome: "succeeded" },
        }),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The run the record remembers is on the same screen, which is what makes the
    // flat claim false here.
    await expect
      .element(page.getByText("Succeeded", { exact: false }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("no run of this exchange has filed a disclosure here", {
          exact: false,
        })
        .query(),
    ).toBeNull();
    // What is true instead: the copy is empty, and the two ways an operator
    // reaches an empty copy after a run has filed one.
    await expect
      .element(
        page.getByText(
          "This browser's copy of the accounting is empty, while the run history above records a completed run",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText('destroyed by "Start a fresh accounting"', {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("restored from an export or backup file", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The state is still an empty one: nothing to export, and no recovery arm --
    // the read succeeded and refused nothing.
    expect(
      page.getByRole("button", { name: /Export this accounting/ }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
  });

  test("a run that stopped after sending is marked partial without opening the entry", async () => {
    // The list shows one collapsed line per entry, so an accounting read off the
    // list must not take an unconfirmed send for a delivered one. The mark rides
    // the toggle's own name, which is also what a screen reader announces.
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );
    const [entry] = disclosureEntries(accounting);
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    expect(entry.partial).toBe(true);
    const toggle = page.getByRole("button", {
      name: `${entry.when} - ${PARTIAL_DISCLOSURE_LABEL}`,
      exact: false,
    });
    await expect.element(toggle).toBeInTheDocument();
    await expect
      .element(page.getByText("1 of them stopped before the run finished"))
      .toBeInTheDocument();

    await toggle.click();

    // Opened, the entry states what it cannot attest beside the outcome it holds.
    await expect
      .element(
        page.getByText("Disclosed, then stopped before the run finished"),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText("whether it reached your partner is not confirmed", {
          exact: false,
        }),
      )
      .toBeVisible();
  });

  test("a filed disclosure opens to the facts of that run, with the partner escaped", async () => {
    // The record keeps the partner's identity byte-exact for the cross-party
    // validation, so this surface is where the bidi override becomes visible.
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord({ partnerIdentity: "Riverbend‮Schools" }),
    );
    const [entry] = disclosureEntries(accounting);
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The entry is named by its own instant, and the partner reaches the DOM
    // escaped -- in the collapsed summary and again in the opened row.
    const toggle = page.getByRole("button", {
      name: entry.when,
      exact: false,
    });
    await expect.element(toggle).toBeInTheDocument();
    expect(
      page.getByText("Riverbend\\u202eSchools").elements().length,
    ).toBeGreaterThan(0);

    await toggle.click();

    await expect.element(page.getByText("MOU-2025-0042")).toBeVisible();
    await expect
      .element(page.getByText("Evaluate shared program enrollment"))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Export this accounting/ }))
      .toBeInTheDocument();
    // The count states whose account it is, and the footer's export offer stands
    // where the export button that honors it does.
    await expect
      .element(page.getByText("1 disclosure recorded in this browser."))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("Export it if you need to keep it", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("an opened disclosure shows the cited rule set under core's recorded-citation caveat", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord({ linkageRuleSet: true }),
    );
    const [entry] = disclosureEntries(accounting);
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await page.getByRole("button", { name: entry.when, exact: false }).click();

    await expect
      .element(page.getByText('Keys: "hmis-keys" 2.1.0'))
      .toBeVisible();
    await expect
      .element(page.getByText('Fields: "baseline-pii" 1.0.0'))
      .toBeVisible();
    // The citation is the authoring party's own declaration; the screen says so
    // beside it rather than letting the row display as a checked provenance, and
    // sends a reader after this build's own finding to the record's verdict --
    // which this surface does not restate, by design.
    await expect
      .element(
        page.getByText(RECORDED_LINKAGE_RULE_SET_CAVEAT, { exact: false }),
      )
      .toBeVisible();
  });

  test("a crafted set name is treated as one run in the opened disclosure, not as a citation of another set", async () => {
    // The names are the authoring party's free text, and this row is the one a
    // HIPAA or FERPA reader consults, so a name holding the delimiter and a
    // version-shaped token must not be able to stand in the rendered line as a
    // shorter name at a version the record does not hold. Driven through the
    // real view rather than the model alone: what a reader is held to is the
    // text the detail renders.
    //
    // The imitated pair names the two sets the standing fixture cites, at a
    // version neither half is recorded at, so neither string can reach the
    // screen from anywhere but a run the crafted name broke out of.
    const imitated = {
      keys: 'Keys: "hmis-keys" 9.9.9',
      fields: 'Fields: "baseline-pii" 9.9.9',
    };
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord({
        linkageRuleSet: {
          fieldSet: { name: 'baseline-pii" 9.9.9', version: "1.0.0" },
          keySet: { name: 'hmis-keys" 9.9.9', version: "1.0.0" },
        },
      }),
    );
    const [entry] = disclosureEntries(accounting);
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await page.getByRole("button", { name: entry.when, exact: false }).click();

    await expect
      .element(
        page.getByText('Keys: "hmis-keys"" 9.9.9" 1.0.0', { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText('Fields: "baseline-pii"" 9.9.9" 1.0.0', { exact: true }),
      )
      .toBeVisible();
    expect(app.container.textContent).not.toContain(imitated.keys);
    expect(app.container.textContent).not.toContain(imitated.fields);
  });

  test("a disclosure whose terms cited no rule set says so, with no caveat to qualify", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );
    const [entry] = disclosureEntries(accounting);
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await page.getByRole("button", { name: entry.when, exact: false }).click();

    await expect
      .element(
        page.getByText("Not cited - the agreed terms' rules were authored", {
          exact: false,
        }),
      )
      .toBeVisible();
    expect(
      page
        .getByText(RECORDED_LINKAGE_RULE_SET_CAVEAT, { exact: false })
        .query(),
    ).toBeNull();
  });

  test("two disclosures sharing a createdAt open and close independently", async () => {
    // createdAt is millisecond-resolution and not guaranteed unique across runs;
    // only the record's own bindingNonce distinguishes them, so the view must key
    // and toggle on it rather than on the shared instant.
    const sharedCreatedAt = "2026-07-01T09:00:00.000Z";
    const accounting = appendDisclosureRecord(
      appendDisclosureRecord(
        undefined,
        await disclosureRecord({
          partnerIdentity: "Riverbend Schools",
          createdAt: sharedCreatedAt,
          recordsExposed: 11,
        }),
      ),
      await disclosureRecord({
        partnerIdentity: "Falls County Clinic",
        createdAt: sharedCreatedAt,
        recordsExposed: 23,
      }),
    );
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(page.getByText("2 disclosures recorded in this browser."))
      .toBeInTheDocument();

    const firstToggle = page.getByRole("button", {
      name: "Riverbend Schools",
      exact: false,
    });
    const secondToggle = page.getByRole("button", {
      name: "Falls County Clinic",
      exact: false,
    });

    await secondToggle.click();

    await expect.element(page.getByText("23", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("11", { exact: true }))
      .not.toBeVisible();

    await firstToggle.click();

    await expect.element(page.getByText("11", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("23", { exact: true }))
      .not.toBeVisible();
  });

  test("an accounting that could not be read is never shown as an empty one", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "unreadable", stored: undefined },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await expect
      .element(page.getByText("This accounting could not be read"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("does not mean nothing was disclosed", { exact: false }),
      )
      .toBeInTheDocument();
    // The empty-accounting copy would be a claim this read cannot support.
    expect(
      page
        .getByText("copy of the accounting is empty", { exact: false })
        .query(),
    ).toBeNull();
  });

  test("an unreadable accounting names the upgrade case and offers no remedy it cannot deliver", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "unreadable", stored: undefined },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The cause an operator can act on, and the two accurate limits: nothing to
    // export from this state, and a record file only where one was downloaded --
    // which an unattended run never offered.
    await expect
      .element(page.getByText("An app upgrade can leave", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("no export of it from here", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("record file you downloaded yourself", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("finished unattended left none", { exact: false }),
      )
      .toBeInTheDocument();
    // The export affordance is absent, so no copy may point at one -- including
    // the standing footer's offer, which would contradict the alert above it.
    expect(
      page.getByRole("button", { name: /Export this accounting/ }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("Export it if you need to keep it", { exact: false })
        .query(),
    ).toBeNull();
    // The rest of the footer stands: a record file downloaded at a run's
    // completion is still checkable, which is the only remedy this state has.
    await expect
      .element(
        page.getByText("This accounting is kept in this browser", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "verify page" }))
      .toBeInTheDocument();
  });
});

/**
 * The recovery affordance on an accounting this build can no longer read -- an
 * app upgrade moved the record version, leaving the entries at rest and every
 * later run filing nothing. The two arms are tested for what each alone does NOT
 * do: the export retains the record but leaves the store un-appendable, and the
 * reset restores appendability but destroys the record. The export must come
 * first, hand over the stored form verbatim, and the reset must always confirm.
 */
describe("recovering an accounting this version cannot read", () => {
  /** Entries as an upgrade leaves them at rest: the record's own fields, under a
   * version this build does not admit. */
  async function strandedEntries(): Promise<Array<unknown>> {
    const filed = await disclosureRecord({
      partnerIdentity: "Riverbend Schools",
    });
    return [{ ...filed, version: `${filed.version}-moved` }];
  }

  test("offers the export before the reset, and names why the reset is needed", async () => {
    const entries = await strandedEntries();
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: {
          kind: "unreadable",
          stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
        },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    const download = page.getByRole("button", {
      name: /Download the stored records/,
    });
    const reset = page.getByRole("button", {
      name: "Start a fresh accounting",
    });
    await expect.element(download).toBeInTheDocument();
    await expect.element(reset).toBeInTheDocument();
    // The order IS the affordance: the export does not restore appendability and
    // the reset destroys what the export would have saved, so the screen must not
    // reach the destructive arm first.
    expect(
      download.element().compareDocumentPosition(reset.element()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The consequence an operator cannot see for themselves: a still-scheduled
    // exchange keeps disclosing and files nothing until this is cleared.
    await expect
      .element(page.getByText("cannot add to it either", { exact: false }))
      .toBeInTheDocument();
    // The claim the state held when it had no way out.
    expect(
      page.getByText("no export of it from here", { exact: false }).query(),
    ).toBeNull();
    // Nor the opposite direction's copy: this build is the current one, so
    // nothing here tells the operator to reload a page that is behind.
    expect(
      page.getByText("older version of psilink", { exact: false }).query(),
    ).toBeNull();
  });

  test("the export hands over the stored entries verbatim, not a reading of them", async () => {
    const entries = await strandedEntries();
    const downloads = captureDownloads();
    try {
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter"),
          parkedResultsRead: { kind: "none" },
          accountingRead: {
            kind: "unreadable",
            stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
          },
          onResetAccounting: () => Promise.resolve(),
          onRetryAccountingRead: () => undefined,
          onRetryParkedResultsRead: () => undefined,
          onClearParkedResults: () => Promise.resolve(),
          onGrantOutputFolder: () => Promise.resolve(),
          onStopUsingOutputFolder: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => undefined,
          canReinvite: true,
          reinviting: false,
          reinviteFailed: false,
          compromiseResponse: false,
          unfiledDisclosureRead: { kind: "none" },
          unrecordedRunFlagged: false,
          onUnrecordedRunFlagShown: () => undefined,
          onFileUnfiledDisclosures: () => Promise.resolve(),
        }),
      );

      await page
        .getByRole("button", { name: /Download the stored records/ })
        .click();

      // The click's handler downloads inside the event dispatch, so the anchor
      // has fired by the time it resolves; only the capture's read of the blob
      // is still outstanding, and it is awaited rather than polled for.
      await downloads.settled();
      expect(downloads.captured).toHaveLength(1);
      expect(downloads.captured[0].fileName).toMatch(
        /^psilink-disclosures-stored-.*\.json$/,
      );
      // Deep equality against what was staged at rest: the file loses no entry
      // and no field, which is the export's only claim.
      expect(JSON.parse(downloads.captured[0].text)).toEqual({
        version: DISCLOSURE_ACCOUNTING_VERSION,
        entries,
      });
    } finally {
      downloads.restore();
    }
  });

  test("the reset destroys nothing until the confirm is taken, and says what it destroys and keeps", async () => {
    const onResetAccounting = vi.fn(() => Promise.resolve());
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: {
          kind: "unreadable",
          stored: {
            version: DISCLOSURE_ACCOUNTING_VERSION,
            entries: await strandedEntries(),
          },
        },
        onResetAccounting,
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();

    // Opening the confirm is not the act, so a read of this surface destroys
    // nothing.
    expect(onResetAccounting).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("destroyed permanently", { exact: false }))
      .toBeInTheDocument();
    // What is KEPT, which is what separates this from deleting the exchange.
    await expect
      .element(page.getByText("The exchange itself is kept", { exact: false }))
      .toBeInTheDocument();
    // The export is offered once more here, where it is last available.
    await expect
      .element(
        page.getByText("You have not downloaded the stored records", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Delete these records" }).click();

    await vi.waitFor(() => expect(onResetAccounting).toHaveBeenCalledTimes(1));
  });

  test("the confirm's re-offered export leaves one button under that name, not two", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: {
          kind: "unreadable",
          stored: {
            version: DISCLOSURE_ACCOUNTING_VERSION,
            entries: await strandedEntries(),
          },
        },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
    const download = () =>
      page.getByRole("button", { name: /Download the stored records/ });
    await expect.element(download()).toBeInTheDocument();
    expect(download().elements()).toHaveLength(1);

    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();

    // The confirm renders OVER the surface rather than replacing it, so leaving
    // both mounted puts two buttons under one accessible name: a screen reader
    // user hears the same action twice with nothing to tell them apart, and
    // cannot know which one the confirm is re-offering. Queried by role and
    // name, which is how that user reaches it.
    await expect
      .element(page.getByRole("button", { name: "Delete these records" }))
      .toBeInTheDocument();
    expect(download().elements()).toHaveLength(1);

    // And it is the confirm's own copy that stands beside it, so the one button
    // left is the re-offer rather than the withdrawn outer one.
    await expect
      .element(
        page.getByText("You have not downloaded the stored records", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("the confirm stops warning about the download once it has been taken", async () => {
    const downloads = captureDownloads();
    try {
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter"),
          parkedResultsRead: { kind: "none" },
          accountingRead: {
            kind: "unreadable",
            stored: {
              version: DISCLOSURE_ACCOUNTING_VERSION,
              entries: await strandedEntries(),
            },
          },
          onResetAccounting: () => Promise.resolve(),
          onRetryAccountingRead: () => undefined,
          onRetryParkedResultsRead: () => undefined,
          onClearParkedResults: () => Promise.resolve(),
          onGrantOutputFolder: () => Promise.resolve(),
          onStopUsingOutputFolder: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => undefined,
          canReinvite: true,
          reinviting: false,
          reinviteFailed: false,
          compromiseResponse: false,
          unfiledDisclosureRead: { kind: "none" },
          unrecordedRunFlagged: false,
          onUnrecordedRunFlagShown: () => undefined,
          onFileUnfiledDisclosures: () => Promise.resolve(),
        }),
      );

      await page
        .getByRole("button", { name: /Download the stored records/ })
        .click();
      await page
        .getByRole("button", { name: "Start a fresh accounting" })
        .click();

      // The prompt tracks the click alone -- the browser reports nothing back
      // about the saved file -- so what replaces the warning is an instruction to
      // check for it, never a claim that it is saved.
      expect(
        page
          .getByText("You have not downloaded the stored records", {
            exact: false,
          })
          .query(),
      ).toBeNull();
      await expect
        .element(
          page.getByText("reached your downloads folder", { exact: false }),
        )
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("a reset that fails keeps the confirm open and says nothing was deleted", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: {
          kind: "unreadable",
          stored: {
            version: DISCLOSURE_ACCOUNTING_VERSION,
            entries: await strandedEntries(),
          },
        },
        onResetAccounting: () => Promise.reject(new Error("store failed")),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();
    await page.getByRole("button", { name: "Delete these records" }).click();

    // A destructive step that did not take must not be treated as one that did: the
    // confirm stands, so the operator retries rather than believing it is done.
    await expect
      .element(page.getByText("That accounting could not be reset"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Delete these records" }))
      .toBeInTheDocument();
  });

  test("an accounting whose stored form is gone too offers the reset and no export", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "unreadable", stored: undefined },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // No download it cannot honor, and the accurate reason for its absence.
    expect(
      page.getByRole("button", { name: /Download the stored records/ }).query(),
    ).toBeNull();
    await expect
      .element(page.getByText("no export of it from here", { exact: false }))
      .toBeInTheDocument();
    // The reset still stands: it is what lets the exchange file disclosures again.
    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();

    await expect
      .element(page.getByText("nothing to download first", { exact: false }))
      .toBeInTheDocument();
  });

  test("an accounting this version can read has no recovery affordance", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: { kind: "accounting", accounting },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );

    // The readable accounting is untouched: its own CSV export stands, and
    // neither recovery arm is reachable from it.
    await expect
      .element(page.getByRole("button", { name: /Export this accounting/ }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: /Download the stored records/ }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
  });
});

/**
 * The reverse skew: entries a NEWER build filed, read by a page still running the
 * code it loaded with. The app makes this reachable -- a new deployment's worker
 * waits rather than swapping code under a running tab -- and the records are fine,
 * so the destructive arm would destroy what the current build reads. What the
 * operator needs here is the reload, which is all this state offers besides the
 * harmless export.
 */
describe("an accounting a newer version of the app filed", () => {
  /** Entries as a later build leaves them at rest: this app's own record fields,
   * under the record version one ordinal ahead of this build's. */
  async function entriesFromALaterBuild(): Promise<Array<unknown>> {
    const filed = await disclosureRecord({
      partnerIdentity: "Riverbend Schools",
    });
    return [{ ...filed, version: neighbouringRecordVersion(1) }];
  }

  const stalePage = (entries: Array<unknown>) =>
    createElement(ManagedExchangeDetail, {
      record: record("inviter"),
      parkedResultsRead: { kind: "none" },
      accountingRead: {
        kind: "stale-page",
        stored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
      },
      onResetAccounting: () => Promise.resolve(),
      onRetryAccountingRead: () => undefined,
      onRetryParkedResultsRead: () => undefined,
      onClearParkedResults: () => Promise.resolve(),
      onGrantOutputFolder: () => Promise.resolve(),
      onStopUsingOutputFolder: () => Promise.resolve(),
      onSaveLocalFields: () => Promise.resolve(),
      onReinviteToChangeTerms: () => undefined,
      canReinvite: true,
      reinviting: false,
      reinviteFailed: false,
      compromiseResponse: false,
      unfiledDisclosureRead: { kind: "none" },
      unrecordedRunFlagged: false,
      onUnrecordedRunFlagShown: () => undefined,
      onFileUnfiledDisclosures: () => Promise.resolve(),
    });

  test("names the page as the stale side and asks for a reload", async () => {
    app.render(stalePage(await entriesFromALaterBuild()));

    await expect
      .element(
        page.getByText("running an older version of psilink", { exact: false }),
      )
      .toBeInTheDocument();
    // The remedy, and the one cost of taking it on a surface that sits below the
    // run controls.
    await expect
      .element(page.getByText("Reload this page", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("reloading ends it", { exact: false }))
      .toBeInTheDocument();
    // Why it is urgent rather than cosmetic: this build's read failure is an
    // append failure too, so a run from this page would file nothing.
    await expect
      .element(page.getByText("file no record here either", { exact: false }))
      .toBeInTheDocument();
  });

  test("offers no reset, and does not blame an upgrade for records this app reads", async () => {
    app.render(stalePage(await entriesFromALaterBuild()));

    // The finding this state exists for: the destructive arm was offered under
    // copy blaming an app upgrade, over records the current build reads fine.
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("An app upgrade can leave a stored accounting", {
          exact: false,
        })
        .query(),
    ).toBeNull();
    // The stranded state's remedy sentence goes with it: nothing here says the
    // records have to be cleared before this exchange files again.
    expect(
      page.getByText("Until it is cleared", { exact: false }).query(),
    ).toBeNull();
    // Nothing was destroyed and nothing is claimed about the records.
    await expect
      .element(page.getByText("has been changed or deleted", { exact: false }))
      .toBeInTheDocument();
  });

  test("never renders as an empty accounting, and keeps the harmless export", async () => {
    const entries = await entriesFromALaterBuild();
    const downloads = captureDownloads();
    try {
      app.render(stalePage(entries));

      // "Nothing was disclosed" is a claim this read refutes rather than
      // supports, and the CSV speaks for entries this build did not read.
      expect(
        page
          .getByText("copy of the accounting is empty", { exact: false })
          .query(),
      ).toBeNull();
      expect(
        page.getByRole("button", { name: /Export this accounting/ }).query(),
      ).toBeNull();

      await page
        .getByRole("button", { name: /Download the stored records/ })
        .click();

      // The click's handler downloads inside the event dispatch, so the anchor
      // has fired by the time it resolves; only the capture's read of the blob
      // is still outstanding, and it is awaited rather than polled for.
      await downloads.settled();
      expect(downloads.captured).toHaveLength(1);
      // The same stored-form export the other direction hands over: verbatim, so
      // it asserts nothing about entries this build cannot read.
      expect(JSON.parse(downloads.captured[0].text)).toEqual({
        version: DISCLOSURE_ACCOUNTING_VERSION,
        entries,
      });
    } finally {
      downloads.restore();
    }
  });
});

/**
 * The state where the accounting was never obtained: the browser's store did not
 * open, or the read did not complete. Its documented cause is transient (another
 * tab holding an older version of the store open), and nothing about it says the
 * stored records are damaged -- so the surface must not route it into the
 * recovery, whose only irreversible arm destroys exactly those records.
 */
describe("an accounting that could not be read at all", () => {
  const unavailable = (onRetryAccountingRead: () => void) =>
    createElement(ManagedExchangeDetail, {
      record: record("inviter"),
      parkedResultsRead: { kind: "none" },
      accountingRead: { kind: "unavailable" },
      onResetAccounting: () => Promise.resolve(),
      onRetryAccountingRead,
      onRetryParkedResultsRead: () => undefined,
      onClearParkedResults: () => Promise.resolve(),
      onGrantOutputFolder: () => Promise.resolve(),
      onStopUsingOutputFolder: () => Promise.resolve(),
      onSaveLocalFields: () => Promise.resolve(),
      onReinviteToChangeTerms: () => undefined,
      canReinvite: true,
      reinviting: false,
      reinviteFailed: false,
      compromiseResponse: false,
      unfiledDisclosureRead: { kind: "none" },
      unrecordedRunFlagged: false,
      onUnrecordedRunFlagShown: () => undefined,
      onFileUnfiledDisclosures: () => Promise.resolve(),
    });

  test("is treated as transient, and offers nothing destructive", async () => {
    app.render(unavailable(() => undefined));

    await expect
      .element(page.getByText("could not be read right now", { exact: false }))
      .toBeInTheDocument();
    // Nothing was destroyed, and nothing is claimed about what is stored.
    await expect
      .element(page.getByText("has been changed or deleted", { exact: false }))
      .toBeInTheDocument();
    // The destructive arm is the whole point of the separation: this state has
    // no evidence the records are damaged, so it must not offer to destroy them
    // -- nor the export, which it has nothing to fill.
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: /Download the stored records/ }).query(),
    ).toBeNull();
    // And it is not the app-upgrade copy: nothing here says an upgrade stranded
    // the records or that the exchange can no longer add to them.
    expect(
      page.getByText("cannot add to it either", { exact: false }).query(),
    ).toBeNull();
  });

  test("never renders as an empty accounting", async () => {
    app.render(unavailable(() => undefined));
    await expect
      .element(page.getByText("could not be read right now", { exact: false }))
      .toBeInTheDocument();

    // "Nothing was disclosed" is a claim, and a read that never reached the
    // store cannot make it. The CSV export speaks for entries too, so it is gone
    // with them.
    expect(
      page
        .getByText("this browser's copy of the accounting is empty", {
          exact: false,
        })
        .query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: /Export this accounting/ }).query(),
    ).toBeNull();
  });

  test("the way out is reading again, not a reload that would end a run", async () => {
    const onRetryAccountingRead = vi.fn();
    app.render(unavailable(onRetryAccountingRead));

    await page.getByRole("button", { name: "Try reading it again" }).click();

    await vi.waitFor(() =>
      expect(onRetryAccountingRead).toHaveBeenCalledTimes(1),
    );
  });
});

/**
 * The read still in flight, which every mount of this surface passes through and
 * every retry returns to. No classification has landed, so the surface knows
 * nothing about the accounting yet -- least of all that it is empty, which is the
 * one reading that claims nothing was disclosed.
 */
describe("an accounting read still in flight", () => {
  const inFlight = () =>
    createElement(ManagedExchangeDetail, {
      record: record("inviter"),
      parkedResultsRead: { kind: "none" },
      accountingRead: undefined,
      onResetAccounting: () => Promise.resolve(),
      onRetryAccountingRead: () => undefined,
      onRetryParkedResultsRead: () => undefined,
      onClearParkedResults: () => Promise.resolve(),
      onGrantOutputFolder: () => Promise.resolve(),
      onStopUsingOutputFolder: () => Promise.resolve(),
      onSaveLocalFields: () => Promise.resolve(),
      onReinviteToChangeTerms: () => undefined,
      canReinvite: true,
      reinviting: false,
      reinviteFailed: false,
      compromiseResponse: false,
      unfiledDisclosureRead: { kind: "none" },
      unrecordedRunFlagged: false,
      onUnrecordedRunFlagShown: () => undefined,
      onFileUnfiledDisclosures: () => Promise.resolve(),
    });

  test("says the read is under way and claims nothing about what is stored", async () => {
    app.render(inFlight());

    await expect
      .element(
        page.getByText("Reading this browser's copy of the accounting", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The empty-accounting copy, in either reading, would make a claim on a read
    // that has not happened.
    expect(
      page
        .getByText("copy of the accounting is empty", { exact: false })
        .query(),
    ).toBeNull();
    expect(
      page
        .getByText("no run of this exchange has filed a disclosure here", {
          exact: false,
        })
        .query(),
    ).toBeNull();
    // Nor is it either failed state: nothing here says the records are stranded or
    // that the store refused.
    expect(
      page.getByText("could not be read", { exact: false }).query(),
    ).toBeNull();
  });

  test("offers no affordance, destructive or otherwise", async () => {
    app.render(inFlight());

    // The section itself is on screen, so the absences below are absences from a
    // rendered accounting rather than from an unrendered one.
    await expect
      .element(page.getByText("Reading this browser's copy", { exact: false }))
      .toBeInTheDocument();
    // Every arm belongs to a read that reached a verdict: the CSV export speaks
    // for entries, the recovery pair for a value refused, the retry for a store
    // that did not answer.
    expect(
      page.getByRole("button", { name: /Export this accounting/ }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: /Download the stored records/ }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Start a fresh accounting" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Try reading it again" }).query(),
    ).toBeNull();
  });
});

describe("the results a scheduled run left for this visit", () => {
  const RUN_AT = "2026-03-01T09:00:00.000Z";
  /** The label the parked results file names are built from. */
  const RESULTS_LABEL = "Riverbend quarterly";
  const RESULTS_CSV = "id,county\nA-19,Riverbend\n";
  /** The two titles the projected-size warning stands under, one where the
   * schedule is entered and one in the run history. Both state a worst case, so
   * neither is asserted as a prediction of what the next run will match. */
  const SCHEDULE_SIZE_WARNING_TITLE =
    "A result on these terms could exceed what this browser keeps";
  const HISTORY_SIZE_WARNING_TITLE =
    "The next run's results could exceed what this browser keeps";

  const scheduled = (): ManagedExchangeSchedule => {
    const anchor = new Date(2026, 7, 4, 9, 0, 0, 0).toISOString();
    return {
      anchor,
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: anchor,
      consecutiveMisses: 0,
    };
  };

  /** Render the detail sections over one parked-results read, for an exchange
   * that has a schedule unless the caller takes it away. */
  function renderParked(
    parkedResultsRead: ParkedResultsRead | undefined,
    {
      schedule = true,
      onRetryParkedResultsRead = () => undefined,
      onClearParkedResults = () => Promise.resolve(),
    }: {
      schedule?: boolean;
      onRetryParkedResultsRead?: () => void;
      onClearParkedResults?: () => Promise<void>;
    } = {},
  ) {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", schedule ? { schedule: scheduled() } : {}),
        parkedResultsRead,
        accountingRead: { kind: "none" },
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead,
        onClearParkedResults,
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
        unfiledDisclosureRead: { kind: "none" },
        unrecordedRunFlagged: false,
        onUnrecordedRunFlagShown: () => undefined,
        onFileUnfiledDisclosures: () => Promise.resolve(),
      }),
    );
  }

  function parkedRead(): ParkedResultsRead {
    return {
      kind: "parked",
      results: {
        version: PARKED_RESULTS_VERSION,
        entries: [
          {
            kind: "results",
            runAt: RUN_AT,
            fileName: runResultsFileName(RESULTS_LABEL, RUN_AT),
            csv: new Blob([RESULTS_CSV], { type: "text/csv" }),
            matchedRecordCount: 1,
          },
        ],
      },
    };
  }

  test("hands over the results file the run built, under its stamped name", async () => {
    const downloads = captureDownloads();
    try {
      renderParked(parkedRead());

      await expect
        .element(page.getByText("1 matched record", { exact: false }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Download result" }).click();

      await downloads.settled();
      expect(downloads.captured).toHaveLength(1);
      expect(downloads.captured[0].fileName).toBe(
        runResultsFileName(RESULTS_LABEL, RUN_AT),
      );
      expect(downloads.captured[0].text).toBe(RESULTS_CSV);
    } finally {
      downloads.restore();
    }
  });

  test("states where the results are, how long they stay, and what removes them", async () => {
    renderParked(parkedRead());
    await expect
      .element(page.getByText(PARKED_RESULTS_RETENTION_NOTE))
      .toBeInTheDocument();
  });

  test("stops offering them once the store holds nothing, which is what a delete leaves", async () => {
    renderParked({ kind: "none" });
    expect(
      page.getByRole("button", { name: "Download result" }).query(),
    ).toBeNull();
    await expect
      .element(page.getByText(NO_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
  });

  test("reports a run this browser would not store the results of, and offers no file", async () => {
    renderParked({
      kind: "parked",
      results: {
        version: PARKED_RESULTS_VERSION,
        entries: [{ kind: "storage-refused", runAt: RUN_AT }],
      },
    });

    await expect
      .element(page.getByText("would not store", { exact: false }))
      .toBeInTheDocument();
    // The run itself stands: the state speaks for the results, not the exchange.
    await expect
      .element(page.getByText("filed its disclosure", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Download result" }).query(),
    ).toBeNull();
  });

  test("a store that did not answer never renders as nothing being here", async () => {
    renderParked({ kind: "unavailable" });
    await expect
      .element(page.getByText(UNAVAILABLE_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    expect(page.getByText(NO_PARKED_RESULTS_NOTE).query()).toBeNull();
  });

  test("the way out of that state is reading again, not a reload that would end a run", async () => {
    const onRetryParkedResultsRead = vi.fn();
    renderParked({ kind: "unavailable" }, { onRetryParkedResultsRead });

    await page.getByRole("button", { name: "Try reading them again" }).click();

    await vi.waitFor(() =>
      expect(onRetryParkedResultsRead).toHaveBeenCalledTimes(1),
    );
  });

  test("a value this build cannot read offers no download and no empty-state note", async () => {
    renderParked({ kind: "unreadable" });

    await expect
      .element(page.getByText(UNREADABLE_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Download result" }).query(),
    ).toBeNull();
    expect(page.getByText(NO_PARKED_RESULTS_NOTE).query()).toBeNull();
    // The retention it states is the one that does not apply to such a value,
    // so it is not left standing above the statement saying so.
    expect(page.getByText(PARKED_RESULTS_RETENTION_NOTE).query()).toBeNull();
  });

  test("a store that did not answer says so on an exchange with no schedule too", async () => {
    renderParked({ kind: "unavailable" }, { schedule: false });

    // Turning a schedule off does not settle what a run parked while it was on,
    // so the section stands here on exactly the reading it stands on elsewhere.
    await expect
      .element(page.getByText(UNAVAILABLE_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Try reading them again" }))
      .toBeInTheDocument();
  });

  test("an exchange with no schedule and nothing kept renders no section at all", async () => {
    renderParked({ kind: "none" }, { schedule: false });

    // The sections below it are on screen, so this is an absent section rather
    // than an unrendered page.
    await expect
      .element(page.getByRole("heading", { name: "Accounting of disclosures" }))
      .toBeInTheDocument();
    expect(page.getByText(PARKED_RESULTS_RETENTION_NOTE).query()).toBeNull();
    expect(page.getByText(NO_PARKED_RESULTS_NOTE).query()).toBeNull();
  });

  test("an exchange with no schedule renders no section while the read is still in flight", async () => {
    renderParked(undefined, { schedule: false });

    // The sections below it are on screen, so this is an absent section rather
    // than an unrendered page, and no spinner flashes before the read resolves.
    await expect
      .element(page.getByRole("heading", { name: "Accounting of disclosures" }))
      .toBeInTheDocument();
    expect(page.getByText(PARKED_RESULTS_RETENTION_NOTE).query()).toBeNull();
    expect(page.getByText(NO_PARKED_RESULTS_NOTE).query()).toBeNull();
  });

  test("the schedule fields state what a scheduled run will keep here, before it runs", async () => {
    renderParked({ kind: "none" });
    await expect
      .element(page.getByText(PARKED_RESULTS_SCHEDULE_NOTE))
      .toBeInTheDocument();
  });

  test("a run too large to keep reads as its own state, with no file offered", async () => {
    renderParked({
      kind: "parked",
      results: {
        version: PARKED_RESULTS_VERSION,
        entries: [
          { kind: "too-large", runAt: RUN_AT, resultBytes: 210 * 1024 ** 2 },
        ],
      },
    });

    await expect
      .element(page.getByText("210.0 MB", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("none were cut down to fit", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Download result" }).query(),
    ).toBeNull();
  });

  test("a projection past the bound warns at schedule entry and in the run history", async () => {
    // Both, and before the run it speaks about: the operator editing the
    // schedule is present to grant a folder, and the one who is only visiting
    // reads it beside what the last run did.
    renderParked({
      kind: "parked",
      results: {
        version: PARKED_RESULTS_VERSION,
        entries: [
          {
            kind: "results",
            runAt: RUN_AT,
            fileName: runResultsFileName(RESULTS_LABEL, RUN_AT),
            csv: new Blob([RESULTS_CSV], { type: "text/csv" }),
            pairTableFactors: { local: 12_000, partner: 9_000 },
          },
        ],
      },
    });

    await expect
      .element(page.getByText(SCHEDULE_SIZE_WARNING_TITLE))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(HISTORY_SIZE_WARNING_TITLE))
      .toBeInTheDocument();
    // The same figures in both places, composed once: the two alerts differ in
    // where they stand, not in what they say.
    expect(
      page.getByText("108,000,000 matched pairs", { exact: false }).elements(),
    ).toHaveLength(2);
  });

  test("no such warning in the run history once the schedule is off", async () => {
    // The size bound applies only to an unattended scheduled run: an attended
    // run downloads its result directly rather than parking it, so the
    // warning does not belong in the run history once the schedule is off,
    // even where the last run's own counts still project past the bound.
    renderParked(
      {
        kind: "parked",
        results: {
          version: PARKED_RESULTS_VERSION,
          entries: [
            {
              kind: "results",
              runAt: RUN_AT,
              fileName: runResultsFileName(RESULTS_LABEL, RUN_AT),
              csv: new Blob([RESULTS_CSV], { type: "text/csv" }),
              pairTableFactors: { local: 12_000, partner: 9_000 },
            },
          ],
        },
      },
      { schedule: false },
    );

    // Waited on so the assertions below run against a rendered page rather
    // than one still mounting.
    await expect
      .element(page.getByRole("heading", { name: "Run history" }))
      .toBeInTheDocument();
    expect(page.getByText(SCHEDULE_SIZE_WARNING_TITLE).query()).toBeNull();
    expect(page.getByText(HISTORY_SIZE_WARNING_TITLE).query()).toBeNull();
  });

  test("no such warning where the last run projects a result this browser keeps", async () => {
    renderParked(parkedRead());
    // Waited on so the assertions below run against a rendered section rather
    // than an empty one.
    await expect
      .element(page.getByText(PARKED_RESULTS_RETENTION_NOTE))
      .toBeInTheDocument();
    expect(page.getByText(SCHEDULE_SIZE_WARNING_TITLE).query()).toBeNull();
    expect(page.getByText(HISTORY_SIZE_WARNING_TITLE).query()).toBeNull();
  });

  test("clearing removes what is kept here, behind a confirm, and reads the store again", async () => {
    const onClearParkedResults = vi.fn(() => Promise.resolve());
    renderParked(parkedRead(), { onClearParkedResults });

    await page.getByRole("button", { name: "Clear what is kept here" }).click();
    await page.getByRole("button", { name: "Clear these results" }).click();

    await vi.waitFor(() =>
      expect(onClearParkedResults).toHaveBeenCalledTimes(1),
    );
  });

  test("a clear that did not take says so and leaves the confirm open", async () => {
    const onClearParkedResults = vi.fn(() =>
      Promise.reject(new Error("the store is gone")),
    );
    renderParked(parkedRead(), { onClearParkedResults });

    await page.getByRole("button", { name: "Clear what is kept here" }).click();
    await page.getByRole("button", { name: "Clear these results" }).click();

    await expect
      .element(page.getByText("Nothing was cleared"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Clear these results" }))
      .toBeInTheDocument();
  });

  test("clears a value this build cannot read, which the statement beside it offers", async () => {
    // The clear needs no parse, so it is the way out of the unreadable state
    // short of deleting the exchange -- and the statement standing above the
    // control says so. Re-rendering on the read the clear leaves is how the
    // surface learns the value is gone.
    const onClearParkedResults = vi.fn(() => Promise.resolve());
    renderParked({ kind: "unreadable" }, { onClearParkedResults });

    await expect
      .element(page.getByText(UNREADABLE_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Clear what is kept here" }).click();
    await page.getByRole("button", { name: "Clear these results" }).click();

    await vi.waitFor(() =>
      expect(onClearParkedResults).toHaveBeenCalledTimes(1),
    );

    renderParked({ kind: "none" }, { onClearParkedResults });
    await expect
      .element(page.getByText(NO_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    expect(page.getByText(UNREADABLE_PARKED_RESULTS_NOTE).query()).toBeNull();
  });

  test("offers no clear where the read found nothing to clear", async () => {
    renderParked({ kind: "none" });
    await expect
      .element(page.getByText(NO_PARKED_RESULTS_NOTE))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Clear what is kept here" }).query(),
    ).toBeNull();
  });
});

/**
 * The runs the accounting owes and does not hold. An unattended run that could
 * not file raises a notice nobody is there for, so this is where the shortfall
 * reaches a person: stated above the entries, counted beside them, and offering
 * only the remedy each state supports.
 */
describe("a run whose record never reached the accounting", () => {
  function renderUnfiled(
    unfiledDisclosureRead: UnfiledDisclosureRead,
    overrides: {
      accountingRead?: DisclosureAccountingRead;
      unrecordedRunFlagged?: boolean;
      onFileUnfiledDisclosures?: () => Promise<void>;
      onUnrecordedRunFlagShown?: () => void;
    } = {},
  ) {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        parkedResultsRead: { kind: "none" },
        accountingRead: overrides.accountingRead ?? { kind: "none" },
        unfiledDisclosureRead,
        unrecordedRunFlagged: overrides.unrecordedRunFlagged ?? false,
        onUnrecordedRunFlagShown:
          overrides.onUnrecordedRunFlagShown ?? (() => undefined),
        onFileUnfiledDisclosures:
          overrides.onFileUnfiledDisclosures ?? (() => Promise.resolve()),
        onResetAccounting: () => Promise.resolve(),
        onRetryAccountingRead: () => undefined,
        onRetryParkedResultsRead: () => undefined,
        onClearParkedResults: () => Promise.resolve(),
        onGrantOutputFolder: () => Promise.resolve(),
        onStopUsingOutputFolder: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
        compromiseResponse: false,
      }),
    );
  }

  test("a retained record is named, and filing it is offered", async () => {
    const missed = await disclosureRecord();
    const onFileUnfiledDisclosures = vi.fn(() => Promise.resolve());

    renderUnfiled(
      {
        kind: "unfiled",
        disclosures: [{ at: missed.createdAt, record: missed }],
      },
      { onFileUnfiledDisclosures },
    );

    await expect
      .element(page.getByText(FILEABLE_DISCLOSURE_NOTE))
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: "Add this record to the accounting" })
      .click();

    expect(onFileUnfiledDisclosures).toHaveBeenCalledTimes(1);
  });

  test("the entry count states what is missing beside what is here", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );
    const missed = await disclosureRecord({
      createdAt: "2026-08-01T09:00:00.000Z",
    });

    renderUnfiled(
      {
        kind: "unfiled",
        disclosures: [{ at: missed.createdAt, record: missed }],
      },
      { accountingRead: { kind: "accounting", accounting } },
    );

    // The count of entries is the claim that needs qualifying: one entry here is
    // not one disclosure made.
    await expect
      .element(
        page.getByText(
          "1 further run of this exchange disclosed and has no entry here",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });

  test("a run with no record left is told so, and offered nothing", async () => {
    renderUnfiled({
      kind: "unfiled",
      disclosures: [{ at: "2026-08-01T09:00:00.000Z" }],
    });

    await expect
      .element(page.getByText(UNBUILT_DISCLOSURE_NOTE))
      .toBeInTheDocument();
    // A control that would do nothing is worse than none: there is no record to
    // add, and the copy says where to record the disclosure instead.
    expect(
      page.getByRole("button", { name: /Add .* to the accounting/ }).query(),
    ).toBeNull();
  });

  test("a run whose record this build cannot read is not told none is kept", async () => {
    renderUnfiled({
      kind: "unfiled",
      disclosures: [
        { at: "2026-08-01T09:00:00.000Z", unreadableRecordRetained: true },
      ],
    });

    // The record is at rest; only this version's refusal makes it unfilable, so
    // the copy states that rather than denying the browser holds anything.
    await expect
      .element(page.getByText(UNREADABLE_DISCLOSURE_NOTE))
      .toBeInTheDocument();
    expect(page.getByText(UNBUILT_DISCLOSURE_NOTE).query()).toBeNull();
    expect(
      page.getByRole("button", { name: /Add .* to the accounting/ }).query(),
    ).toBeNull();
  });

  test("a failed filing keeps the records and names the state to clear first", async () => {
    const missed = await disclosureRecord();

    renderUnfiled(
      {
        kind: "unfiled",
        disclosures: [{ at: missed.createdAt, record: missed }],
      },
      {
        onFileUnfiledDisclosures: () =>
          Promise.reject(new Error("the accounting refused the append")),
      },
    );
    await page
      .getByRole("button", { name: "Add this record to the accounting" })
      .click();

    await expect
      .element(
        page.getByText(
          "could not be added and are still kept in this browser",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
  });

  test("a note this build cannot read still says a run is missing", async () => {
    renderUnfiled({ kind: "unreadable" });

    await expect
      .element(
        page.getByText("its record was not saved to the accounting below", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: /Add .* to the accounting/ }).query(),
    ).toBeNull();
  });

  test("a run this browser could record nowhere names where to look", async () => {
    const onUnrecordedRunFlagShown = vi.fn();

    renderUnfiled(
      { kind: "none" },
      { unrecordedRunFlagged: true, onUnrecordedRunFlagShown },
    );

    await expect
      .element(
        page.getByText(
          "At least one run of this exchange could not be recorded",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
    // The run history may not name the run the flag stands for, so the alert
    // names the other place it is stated rather than that one alone.
    await expect
      .element(
        page.getByText("keeps only the most recent run", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("diagnostic log", { exact: false }))
      .toBeInTheDocument();
    // The alert reports that it has been shown, which is what drops the flag:
    // the fact is kept until an operator has read it.
    await vi.waitFor(() =>
      expect(onUnrecordedRunFlagShown).toHaveBeenCalledTimes(1),
    );
  });

  test("nothing missing says nothing, and drops no flag", async () => {
    const onUnrecordedRunFlagShown = vi.fn();

    renderUnfiled({ kind: "none" }, { onUnrecordedRunFlagShown });

    expect(
      page.getByText("missing from this accounting", { exact: false }).query(),
    ).toBeNull();
    expect(
      page.getByText("could not be recorded", { exact: false }).query(),
    ).toBeNull();
    await flushPendingUpdates();
    expect(onUnrecordedRunFlagShown).not.toHaveBeenCalled();
  });
});
