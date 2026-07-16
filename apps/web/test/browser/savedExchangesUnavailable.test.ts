/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import { SavedExchanges } from "@bench/SavedExchanges";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The store-unavailable degrade, rendered: when the managed store cannot be opened
// at all (private mode with storage blocked, an engine without IndexedDB), the home
// route degrades to the quick path with a clear message rather than erroring. The
// unavailability is a real failed-open -- the store's open here rejects -- not a
// user-agent guess. The load ordering and its classification are unit-tested; this
// file proves the degrade renders and links to the quick path.

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
  useNavigate: () => () => undefined,
}));

// Fail the store open -- the real failed-open the degrade classifies on. The rest of
// the store module is left intact (the list never reaches its reads).
vi.mock("@psi/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openManagedExchangeDatabase: () =>
      Promise.reject(new Error("storage blocked")),
  };
});

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

describe("managed exchange home list, store unavailable", () => {
  test("degrades to the quick path with a clear message, not an error", async () => {
    mount(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText("This browser cannot store recurring exchanges", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    const quick = page.getByRole("link", {
      name: "Set up or accept a one-off exchange",
    });
    await expect.element(quick).toBeInTheDocument();
    expect((await quick.element()).getAttribute("href")).toBe("/quick");

    // No error surfaced, and no empty-list affordances leaked through.
    expect(
      page.getByRole("button", { name: "Import a backup file" }).query(),
    ).toBeNull();
  });
});
