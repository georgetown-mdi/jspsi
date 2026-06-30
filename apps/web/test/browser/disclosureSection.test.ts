/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { DisclosureSection } from "@components/DisclosureSection";

import type { Root } from "react-dom/client";

// The shared disclosure idiom both data-prep editors use (the inviter's rail
// sections and the per-field cleaning cards' sample preview). The bug class this
// pins: with respectReducedMotion enabled, a reduced-motion user's closed Mantine
// Collapse panel can go away, so a toggle's aria-controls must point at an
// ALWAYS-MOUNTED wrapper, not the panel, or the reference dangles for exactly those
// users. Assert against the accessibility tree (not visual styling) that the
// reference resolves while collapsed under a simulated reduced-motion preference,
// and that the collapsed detail is hidden from assistive tech.

const LABEL = "Legal agreement";
const PANEL_TEXT = "Attached: MOU-2025-0042";

let container: HTMLElement | undefined;
let root: Root | undefined;
let originalMatchMedia: typeof window.matchMedia;

// The panel body is a real ELEMENT, never a bare string: the collapsed-panel poll
// below reads `firstElementChild`, so an element node is what makes it discriminating.
// Were the aria-controls id wrongly placed on the Mantine Collapse panel instead of
// the always-mounted wrapper (the #269 regression this test guards), the panel
// resolved by getElementById would expose this visible element child and the
// hidden-state poll would fail; a text-only child has no element child, so the poll
// would pass vacuously and the regression would slip through. Keep this an element.
const PANEL_BODY = () =>
  createElement("p", { "data-testid": "panel-body" }, PANEL_TEXT);

// Simulate the OS prefers-reduced-motion signal the theme switch honors. Mantine's
// Collapse reads it through useReducedMotion, which resolves the matchMedia match in
// a post-mount effect (not on the first render), so the polls below wait for that
// effect to settle the reduced-motion code path rather than assuming it is immediate.
function setReducedMotion(prefersReduced: boolean) {
  window.matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? prefersReduced : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

function render(open: boolean) {
  root!.render(
    createElement(
      MantineProvider,
      { theme: { respectReducedMotion: true } },
      createElement(DisclosureSection, {
        label: LABEL,
        open,
        onToggle: () => undefined,
        headingOrder: 3,
        children: PANEL_BODY(),
      }),
    ),
  );
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.matchMedia = originalMatchMedia;
});

function toggle() {
  return page.getByRole("button", { name: LABEL });
}

describe("DisclosureSection: aria-controls resolves under a reduced-motion preference", () => {
  test("the collapsed toggle's aria-controls resolves to a present, hidden wrapper", async () => {
    setReducedMotion(true);
    render(false);

    await expect.element(toggle()).toBeInTheDocument();
    expect(toggle().element().getAttribute("aria-expanded")).toBe("false");

    const id = toggle().element().getAttribute("aria-controls");
    expect(id).toBeTruthy();

    // Since Mantine 9.4 a closed Collapse under reduced motion keeps the collapsed
    // detail out of sight one of two ways depending on the environment -- it unmounts
    // the panel, or it keeps it mounted in a hidden React Activity boundary
    // (display:none) -- and both leave the detail out of the accessibility tree and
    // the tab order. Wait for the post-mount reduced-motion effect to settle to
    // either.
    await expect
      .poll(() => {
        const panel = document.getElementById(id!)
          ?.firstElementChild as HTMLElement | null;
        return panel === null || getComputedStyle(panel).display === "none";
      })
      .toBe(true);

    // The durable invariant across both: the wrapper holding aria-controls stays a
    // present element, so the reference never dangles (the reason the id lives on the
    // wrapper, not the panel).
    expect(document.getElementById(id!)).not.toBeNull();
  });

  test("the open toggle's aria-controls resolves to the now-visible panel", async () => {
    setReducedMotion(true);
    render(true);

    await expect.element(toggle()).toBeInTheDocument();
    expect(toggle().element().getAttribute("aria-expanded")).toBe("true");

    const id = toggle().element().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    const wrapper = document.getElementById(id!);
    expect(wrapper).not.toBeNull();
    // The expanded detail is in the accessibility tree (the reference resolves to
    // content that is actually shown).
    await expect.element(page.getByText(PANEL_TEXT)).toBeVisible();
  });
});

describe("DisclosureSection: no regression without a reduced-motion preference", () => {
  test("the collapsed toggle's aria-controls still resolves to a present wrapper", async () => {
    setReducedMotion(false);
    render(false);

    await expect.element(toggle()).toBeInTheDocument();
    expect(toggle().element().getAttribute("aria-expanded")).toBe("false");

    const id = toggle().element().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });
});
