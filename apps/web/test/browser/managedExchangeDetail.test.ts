/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
} from "@psi/disclosureAccounting";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { ManagedExchangeDetail } from "@bench/ManagedExchangeDetail";
import { disclosureEntries } from "@bench/disclosureAccountingModel";

import { disclosureRecord } from "../utils/disclosureFixtures";

import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The managed exchange detail sections, rendered: the read-only configuration with
// its re-invite affordance (never an edit control over the terms), the editable
// local fields, and the accounting of disclosures (no signed-receipt claim, and a
// failed read that never reads as "nothing was disclosed"). The stubbed Link is
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

afterEach(app.unmount);

describe("managed exchange detail configuration", () => {
  test("the inviter sees read-only terms with a re-invite affordance, not an edit control", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    // The agreed identity renders read-only in the configuration view.
    await expect
      .element(page.getByText("County Health Dept"))
      .toBeInTheDocument();
    // The terms carry a fast re-invite affordance (same terms, new secret), not an
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
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: false,
        reinviting: false,
        reinviteFailed: false,
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
    // carry the list separator, so joined text would present one agreed term as
    // two -- the entries are their own list items instead. And a name may carry a
    // bidi override, which JSX escaping does not touch: it must arrive as an
    // escape, not as a code point that reorders the term a compliance user is
    // confirming.
    const separatorName = "SSN, DOB";
    const hostileName = "LN\u202eEVIL";
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", {
          exchangeFile: composeManagedExchangeFile({
            connection: webrtcLocator,
            linkageTerms: {
              ...getDefaultLinkageTerms("County Health Dept"),
              linkageKeys: [
                { name: separatorName, elements: [{ field: "ssn" }] },
                { name: hostileName, elements: [{ field: "last_name" }] },
              ],
            },
          }),
        }),
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
          accounting: undefined,
          accountingUnreadable: false,
          accountingStored: undefined,
          onResetAccounting: () => Promise.resolve(),
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
          reinviting,
          reinviteFailed,
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

    // The failure surfaces beside the button, in the file's existing error voice.
    await expect
      .element(
        page.getByText("The fresh invitation could not be created", {
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
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: (edits) => {
          saved.push(edits);
          return Promise.resolve();
        },
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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

describe("managed exchange detail accounting of disclosures", () => {
  test("frames the accounting as self-attested and unsigned, never a signed receipt", async () => {
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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

  test("an exchange with no completed run scopes the empty state to this browser's copy, and offers no export", async () => {
    // A device that imported the exchange from a backup file holds no accounting
    // -- the artifact does not carry one -- so an unqualified "it has disclosed
    // nothing" would read there as the partnership's whole disclosure history.
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        accounting: undefined,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    await expect
      .element(
        page.getByText(
          "No run of this exchange has completed in this browser, so this browser's copy of the accounting is empty.",
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
        accounting,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
    // beside it rather than letting the row read as a checked provenance, and
    // sends a reader after this build's own finding to the record's verdict --
    // which this surface deliberately does not restate.
    await expect
      .element(
        page.getByText(RECORDED_LINKAGE_RULE_SET_CAVEAT, { exact: false }),
      )
      .toBeVisible();
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
        accounting,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    // The cause an operator can act on, and the two honest limits: nothing to
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
 * The recovery affordance on an accounting this build can no longer read -- the
 * state an app upgrade that moved the exchange-record version leaves an operator
 * in, with the entries still at rest and every later run filing nothing.
 *
 * Two arms in one fixed order, and these tests are written around what each one
 * alone does not do: the export retains the record and leaves the store
 * un-appendable, the reset restores appendability and destroys the record. So the
 * assertions are that the export comes first, that it hands over the stored form
 * rather than a reading of it, and that the reset never fires without an explicit
 * confirm naming what is destroyed and what is kept.
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
    // The claim the state carried when it had no way out.
    expect(
      page.getByText("no export of it from here", { exact: false }).query(),
    ).toBeNull();
  });

  test("the export hands over the stored entries verbatim, not a reading of them", async () => {
    const entries = await strandedEntries();
    const downloads = captureDownloads();
    try {
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter"),
          accounting: undefined,
          accountingUnreadable: true,
          accountingStored: { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
          onResetAccounting: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => undefined,
          canReinvite: true,
          reinviting: false,
          reinviteFailed: false,
        }),
      );

      await page
        .getByRole("button", { name: /Download the stored records/ })
        .click();

      await vi.waitFor(() => {
        expect(downloads.captured).toHaveLength(1);
        expect(downloads.captured[0].text).not.toBe("");
      });
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: {
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: await strandedEntries(),
        },
        onResetAccounting,
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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

  test("the confirm stops warning about the download once it has been taken", async () => {
    const downloads = captureDownloads();
    try {
      app.render(
        createElement(ManagedExchangeDetail, {
          record: record("inviter"),
          accounting: undefined,
          accountingUnreadable: true,
          accountingStored: {
            version: DISCLOSURE_ACCOUNTING_VERSION,
            entries: await strandedEntries(),
          },
          onResetAccounting: () => Promise.resolve(),
          onSaveLocalFields: () => Promise.resolve(),
          onReinviteToChangeTerms: () => undefined,
          canReinvite: true,
          reinviting: false,
          reinviteFailed: false,
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: {
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: await strandedEntries(),
        },
        onResetAccounting: () => Promise.reject(new Error("store failed")),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    await page
      .getByRole("button", { name: "Start a fresh accounting" })
      .click();
    await page.getByRole("button", { name: "Delete these records" }).click();

    // A destructive step that did not take must not read as one that did: the
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
        accounting: undefined,
        accountingUnreadable: true,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    // No download it cannot honor, and the honest reason for its absence.
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

  test("an accounting this version can read carries no recovery affordance", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );
    app.render(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
        accounting,
        accountingUnreadable: false,
        accountingStored: undefined,
        onResetAccounting: () => Promise.resolve(),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: true,
        reinviting: false,
        reinviteFailed: false,
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
