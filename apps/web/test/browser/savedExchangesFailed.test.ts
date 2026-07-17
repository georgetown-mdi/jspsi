/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import { SavedExchanges, SavedExchangesHome } from "@bench/SavedExchanges";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The read-failed behavior, rendered, for both routes. When the store opens but its
// records cannot be read (a corrupted or app-upgrade-invalidated record), records
// likely exist, so both the home route at `/` and the always-list route at `/saved`
// show the read-failed surface -- never the quick path, which would silently hide the
// loss. The failure is a real read rejection after a successful open, distinct from the
// unavailable degrade. The load's failure classification is unit-tested; this file
// proves both routes render the read-failed surface, not the quick path.

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

// The store opens, but the record read rejects: the post-open read failure the load
// classifies as `failed`. The rest of the store module is left intact.
vi.mock("@psi/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listManagedExchanges: () => Promise.reject(new Error("corrupt record")),
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

describe("store opens but the read fails", () => {
  test("the home route shows the read-failed surface, not the quick path", async () => {
    mount(createElement(SavedExchangesHome));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    // The lobby's one-off cards must not stand in for the loss.
    expect(
      page
        .getByRole("heading", { name: "Invite someone to exchange data" })
        .query(),
    ).toBeNull();
  });

  test("the always-list route shows the read-failed surface", async () => {
    mount(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });

  // The read-failed surface is not a dead end: it carries the same
  // restore-from-backup import affordance the empty state has. The list read
  // rejects wholesale on any one bad record, so the import cannot mend the list,
  // but it stores the exchange and routes straight to its run surface -- a way
  // forward the surface must still offer.
  test("the read-failed surface offers the restore-from-backup import", async () => {
    mount(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Restore from a backup", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Import a backup file" }))
      .toBeInTheDocument();
  });
});
