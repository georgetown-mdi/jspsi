/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { getDefaultLinkageTerms } from "@psilink/core";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { ManagedExchangeDetail } from "@bench/ManagedExchangeDetail";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeLocalEdits,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The managed exchange detail sections, rendered: the read-only configuration with
// its re-invite affordance (never an edit control over the terms), the editable
// local fields, and the self-attested record view (no signed-receipt claim). The
// Link is stubbed to a plain anchor so the record view's /verify link renders
// outside a router.

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to?: string;
    children?: ReactNode;
    [prop: string]: unknown;
  }) =>
    createElement(
      "a",
      { ...rest, href: typeof to === "string" ? to : "#" },
      children,
    ),
}));

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

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("managed exchange detail configuration", () => {
  test("the inviter sees read-only terms with a re-invite affordance, not an edit control", async () => {
    mount(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
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
    // The terms carry a re-invite affordance, not an edit control over them.
    await expect
      .element(
        page.getByRole("button", { name: "Re-invite to change the terms" }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Edit terms" }).query()).toBeNull();
    expect(
      page.getByRole("button", { name: "Edit the terms" }).query(),
    ).toBeNull();
  });

  test("the acceptor is told to ask the partner rather than shown a mint button", async () => {
    mount(
      createElement(ManagedExchangeDetail, {
        record: record("acceptor"),
        onSaveLocalFields: () => Promise.resolve(),
        onReinviteToChangeTerms: () => undefined,
        canReinvite: false,
        reinviting: false,
        reinviteFailed: false,
      }),
    );

    await expect
      .element(
        page.getByText("ask your partner to send you a fresh invitation", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Re-invite to change the terms" })
        .query(),
    ).toBeNull();
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
      root?.render(
        createElement(
          MantineProvider,
          null,
          createElement(ManagedExchangeDetail, {
            record: record("inviter"),
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
        ),
      );
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render();

    const button = page.getByRole("button", {
      name: "Re-invite to change the terms",
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
    mount(
      createElement(ManagedExchangeDetail, {
        record: record("inviter"),
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
});

describe("managed exchange detail record view", () => {
  test("frames the record as self-attested and unsigned, never a signed receipt", async () => {
    const lastRun: ManagedExchangeLastRun = {
      at: "2026-07-01T09:00:00.000Z",
      outcome: "succeeded",
    };
    mount(
      createElement(ManagedExchangeDetail, {
        record: record("inviter", { lastRun }),
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
});
