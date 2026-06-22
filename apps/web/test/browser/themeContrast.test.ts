/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";
import { ActionIcon, Button, Checkbox, MantineProvider } from "@mantine/core";

import { mantineTheme } from "@theme";

import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";

// Button and Checkbox are polymorphic factory components; this is a `.ts` file (the
// browser project globs `.ts`, not `.tsx`, so no JSX), and createElement cannot
// resolve their overloaded type directly -- cast each to the plain component shape
// this test renders.
const FilledButton = Button as unknown as ComponentType<{
  children?: ReactNode;
}>;
const PrimaryCheckbox = Checkbox as unknown as ComponentType<{
  defaultChecked?: boolean;
  "aria-label"?: string;
}>;
const FilledActionIcon = ActionIcon as unknown as ComponentType<{
  children?: ReactNode;
  "aria-label"?: string;
}>;

// Render-level counterpart to test/unit/themeContrast.test.ts. The unit test
// asserts the palette arithmetic and that the theme ROUTES filled-primary text
// through --mantine-primary-color-contrast; it cannot prove the browser actually
// paints that color, because Mantine resolves a filled surface's text color
// color-scheme-blind in JS. That blind spot already shipped one regression (a dark
// button rendered white-on-cyan-6 = 2.79:1 while a unit test that modeled an
// idealized autoContrast stayed green), so this measures the REAL computed colors
// of all three contrast-routed filled-primary surfaces -- the Button label, the
// (consent-gate) Checkbox checkmark, and the copy ActionIcon glyph -- in both schemes
// and checks them against the WCAG 2.1 AA 1.4.3 text floor. The focus ring / input
// border use the per-scheme --mantine-primary-color-filled directly (a plain shade
// lookup, not the autoContrast path), so the unit test covers them.

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(scheme: "light" | "dark", node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      { theme: mantineTheme, forceColorScheme: scheme },
      node,
    ),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Wait for a mounted element (createRoot.render is not synchronous), then return
 * it. */
async function waitForEl(selector: string): Promise<HTMLElement> {
  await expect.poll(() => container!.querySelector(selector)).not.toBeNull();
  return container!.querySelector(selector) as HTMLElement;
}

/** sRGB channels of a computed `rgb(r, g, b)` / `rgba(...)` color string. */
function channels(color: string): [number, number, number] {
  const m = color.match(/-?\d+(\.\d+)?/g);
  if (!m || m.length < 3) throw new Error(`unparseable color: ${color}`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** WCAG 2.1 relative luminance of a computed color string. */
function relativeLuminance(color: string): number {
  const linear = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = channels(color).map((c) => c / 255);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two computed color strings (1..21). */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("rendered theme colour contrast (WCAG 2.1 AA)", () => {
  // Black resolves brighter on cyan-6 (7.53) than white does on cyan-9 (5.59), so a
  // single >= 4.5 floor covers both schemes; the per-scheme text assertions below
  // pin WHICH colour renders, which is the half that regressed before.
  for (const { scheme, expectedText } of [
    { scheme: "light" as const, expectedText: "rgb(255, 255, 255)" },
    { scheme: "dark" as const, expectedText: "rgb(0, 0, 0)" },
  ]) {
    test(`filled-primary button label is AA-legible (${scheme})`, async () => {
      mount(scheme, createElement(FilledButton, null, "Continue"));
      const btn = await waitForEl(".mantine-Button-root");
      await expect.poll(() => getComputedStyle(btn).color).toBe(expectedText);
      const { color, backgroundColor } = getComputedStyle(btn);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`consent checkbox checkmark is AA-legible (${scheme})`, async () => {
      mount(
        scheme,
        createElement(PrimaryCheckbox, {
          defaultChecked: true,
          "aria-label": "consent",
        }),
      );
      // The checkmark (CheckIcon, currentColor) sits in .mantine-Checkbox-icon; its
      // fill is --checkbox-icon-color and its background is the filled box (the input).
      const input = await waitForEl(".mantine-Checkbox-input");
      const icon = await waitForEl(".mantine-Checkbox-icon");
      await expect.poll(() => getComputedStyle(icon).color).toBe(expectedText);
      const fill = getComputedStyle(input).backgroundColor;
      expect(
        contrast(getComputedStyle(icon).color, fill),
      ).toBeGreaterThanOrEqual(4.5);
    });

    test(`filled-primary action icon glyph is AA-legible (${scheme})`, async () => {
      // The copy ActionIcon (ShareBlock) in its filled state; glyph colour is
      // --ai-color, routed to the contrast variable. No variant prop -> the default
      // filled, matching how the override is scoped.
      mount(
        scheme,
        createElement(
          FilledActionIcon,
          { "aria-label": "copy" },
          createElement("span", null, "i"),
        ),
      );
      const ai = await waitForEl(".mantine-ActionIcon-root");
      await expect.poll(() => getComputedStyle(ai).color).toBe(expectedText);
      const { color, backgroundColor } = getComputedStyle(ai);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
