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
 * the resetKey signature changes with it, so the boundary auto-recovers. `initialBroken`
 * chooses the entry path -- catch on first render (true) or catch on a later update
 * (false, then broken via the exposed setter), the path the real hosts take. */
function Harness({
  initialBroken = true,
  onReady,
}: {
  initialBroken?: boolean;
  onReady?: (setBroken: (value: boolean) => void) => void;
}) {
  const [broken, setBroken] = useState(initialBroken);
  onReady?.(setBroken);
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
        name: "Reset to defaults",
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

  test("focus moves to the announced fallback on catch and returns to the recovered cards on reset", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Mount with valid children, then trip the boundary on an update -- the path a
      // real host takes when prepared data goes bad mid-edit.
      let breakCleaning: ((value: boolean) => void) | undefined;
      render(
        createElement(Harness, {
          initialBroken: false,
          onReady: (setBroken) => {
            breakCleaning = setBroken;
          },
        }),
      );
      await expect.element(page.getByTestId("cards")).toBeInTheDocument();
      breakCleaning?.(true);

      // The fallback is a role="alert" live region (so the swap is announced) that
      // carries an accessible name from its title, and it takes focus off the
      // unmounted crashing subtree.
      const fallback = page.getByRole("alert", {
        name: "The cleaning editor hit an unexpected state",
      });
      await expect.element(fallback).toBeInTheDocument();
      const fallbackNode = fallback.element();
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(fallbackNode);
      });

      // Reset re-renders the cards; focus returns to the recovered children region,
      // never stranded on the removed fallback.
      await page.getByRole("button", { name: "Reset to defaults" }).click();
      const cards = page.getByTestId("cards");
      await expect.element(cards).toBeInTheDocument();
      await vi.waitFor(() => {
        const active = document.activeElement;
        expect(active).not.toBe(null);
        expect(active?.isConnected).toBe(true);
        expect(active?.contains(cards.element())).toBe(true);
      });
    } finally {
      spy.mockRestore();
    }
  });
});
