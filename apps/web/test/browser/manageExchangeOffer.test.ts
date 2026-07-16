/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import { ManageExchangeOffer } from "@bench/ManageExchangeOffer";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The offer's store-availability gate, rendered. Before the form, the panel probes
// whether this browser can open the managed store at all: when it can, the label and
// max-age form renders; when it cannot (private browsing with storage blocked, an
// engine without IndexedDB), a short honest state stands in for the form so the
// operator is not invested in inputs a deposit could never honor. The probe seam is
// probeManagedStoreOpen, mocked here to resolve either answer.

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

// The availability probe is the only store surface the offer touches; resolving it
// controls the branch under test. Set per test before mount.
const probeStoreOpen = vi.fn<() => Promise<boolean>>();
vi.mock("@psi/managedExchangeStore", () => ({
  probeManagedStoreOpen: () => probeStoreOpen(),
}));

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
  probeStoreOpen.mockReset();
});

describe("manage-exchange offer store gate", () => {
  test("an available store renders the label and max-age form", async () => {
    probeStoreOpen.mockResolvedValue(true);
    mount(
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

  test("an unavailable store renders the honest state and no form inputs", async () => {
    probeStoreOpen.mockResolvedValue(false);
    mount(
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
