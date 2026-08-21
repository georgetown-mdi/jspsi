/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { ManagedExchangeDetail } from "@bench/ManagedExchangeDetail";
import { appendDisclosureRecord } from "@psi/disclosureAccounting";
import { disclosureEntries } from "@bench/disclosureAccountingModel";

import { disclosureRecord } from "../utils/disclosureFixtures";

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
