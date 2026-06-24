/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";

import type { Root } from "react-dom/client";

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, node));
}

/** Throws on render while `broken`, like a tripped StandardizationCards invariant. */
function Boom({ broken }: { broken: boolean }) {
  if (broken) throw new Error("standardization invariant tripped");
  return createElement("div", { "data-testid": "cards" }, "cleaning cards");
}

/** Drives the boundary the way a host does: `onReset` clears the offending state and
 * the resetKey signature changes with it, so the boundary auto-recovers. */
function Harness() {
  const [broken, setBroken] = useState(true);
  return createElement(CleaningErrorBoundary, {
    onReset: () => setBroken(false),
    // A real host keys this off the rendered standardization; here `broken` stands
    // in for "the prepared data changed", which is what a reset/remap does.
    resetKey: String(broken),
    children: createElement(Boom, { broken }),
  });
}

describe("CleaningErrorBoundary contains a cleaning-section crash and recovers", () => {
  test("a throwing cleaning section shows a recoverable fallback, not a blank tree", async () => {
    // React logs caught render errors to console.error; silence it so the boundary
    // test does not spam the run (the error is handled, never window-unhandled).
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(createElement(Harness));

      // The fallback replaces the crashed cards in place, with an actionable reset.
      await expect
        .element(page.getByText("The cleaning editor hit an unexpected state"))
        .toBeInTheDocument();
      const resetButton = page.getByRole("button", {
        name: "Reset to recommended",
      });
      await expect.element(resetButton).toBeInTheDocument();

      // Resetting fixes the underlying state AND changes the resetKey signature, so
      // the boundary clears and the now-valid cards render.
      await resetButton.click();
      await expect.element(page.getByTestId("cards")).toBeInTheDocument();
      expect(
        page
          .getByText("The cleaning editor hit an unexpected state")
          .elements(),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
