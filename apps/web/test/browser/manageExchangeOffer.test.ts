/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { ManageExchangeOffer } from "@exchange/ManageExchangeOffer";

import { createAppMount } from "./renderApp";

// The offer's store-availability gate, rendered. Before the form, the panel probes
// whether this browser can open the managed store at all: when it can, the label and
// max-age form renders; when it cannot (private browsing with storage blocked, an
// engine without IndexedDB), a short, accurate state stands in for the form so the
// operator is not invested in inputs a deposit could never honor. The probe is
// `probeManagedStoreOpen`, mocked here to resolve either answer.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The availability probe is the only store surface the offer touches; resolving it
// controls the branch under test. Set per test before mount.
const probeStoreOpen = vi.fn<() => Promise<boolean>>();
vi.mock("@psi/managed/managedExchangeStore", () => ({
  probeManagedStoreOpen: () => probeStoreOpen(),
}));

const app = createAppMount();

afterEach(() => {
  app.unmount();
  probeStoreOpen.mockReset();
});

describe("manage-exchange offer refusal", () => {
  // A refusal names a column of the document the deposit tried to write, which
  // none of this panel's inputs changes, so the deposit must not stay clickable
  // for a retry that fails identically. A failure no column explains keeps the
  // generic try-again copy and its retry.
  const refusal = {
    title: "Could not save this recurring exchange",
    message:
      "Column 2, diagnosis_code, has a name longer than the bound. " +
      "Fix the header row in your file, then set the exchange up again to save it.",
  };

  test("blocks the deposit while a column-name refusal stands", async () => {
    probeStoreOpen.mockResolvedValue(true);
    app.render(
      createElement(ManageExchangeOffer, {
        status: "error",
        refusal,
        handleCaptured: false,
        onManage: () => undefined,
      }),
    );

    await expect
      .element(page.getByText("Column 2", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Save as a recurring exchange" }),
      )
      .toBeDisabled();
  });

  test("leaves the retry open for a failure no column explains", async () => {
    probeStoreOpen.mockResolvedValue(true);
    app.render(
      createElement(ManageExchangeOffer, {
        status: "error",
        handleCaptured: false,
        onManage: () => undefined,
      }),
    );

    await expect
      .element(
        page.getByText("Your one-off exchange is unaffected", { exact: false }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Save as a recurring exchange" }),
      )
      .toBeEnabled();
  });
});

describe("manage-exchange offer store gate", () => {
  test("an available store renders the label and max-age form", async () => {
    probeStoreOpen.mockResolvedValue(true);
    app.render(
      createElement(ManageExchangeOffer, {
        status: "idle",
        handleCaptured: false,
        onManage: () => undefined,
      }),
    );

    await expect
      .element(page.getByRole("textbox", { name: "Label" }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("checkbox", {
          name: "Set a maximum age for the stored secret",
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Save as a recurring exchange" }),
      )
      .toBeInTheDocument();
  });

  test("an unavailable store renders the accurate state and no form inputs", async () => {
    probeStoreOpen.mockResolvedValue(false);
    app.render(
      createElement(ManageExchangeOffer, {
        status: "idle",
        handleCaptured: false,
        onManage: () => undefined,
      }),
    );

    await expect
      .element(
        page.getByText("This browser cannot store recurring exchanges", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // No form was collected: neither the label, the max-age opt-in, nor the deposit
    // button leaked through the degrade.
    expect(page.getByRole("textbox", { name: "Label" }).query()).toBeNull();
    expect(
      page
        .getByRole("checkbox", {
          name: "Set a maximum age for the stored secret",
        })
        .query(),
    ).toBeNull();
    expect(
      page
        .getByRole("button", { name: "Save as a recurring exchange" })
        .query(),
    ).toBeNull();
  });
});
