/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";

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
const PrimaryActionIcon = ActionIcon as unknown as ComponentType<{
  children?: ReactNode;
  variant?: string;
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
// and checks them against the WCAG 2.1 AA 1.4.3 text floor.
//
// It also pins the copied-state copy ActionIcon (ShareBlock flips it to
// variant="light"): a non-text check glyph (1.4.11, 3:1) whose color Mantine owns
// through --mantine-color-{primary}-light-color and resolves per scheme, with no
// per-component constant to share -- so, like the filled surfaces, only a render
// pins what it paints. The focus ring / input border (the per-scheme
// --mantine-primary-color-filled, a plain shade lookup) and the Dropzone drag-icon
// shades (a literal inline color shared with the unit test through
// DROPZONE_DRAG_ICON) stay in the unit test, which checks them by arithmetic.

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

/** Move the pointer off `el`, then return its resting (non-hover) background.
 *
 * Under full-suite browser load a freshly mounted surface can inherit `:hover`
 * from wherever the previous test left the shared pointer -- over this test's
 * small top-left mount often enough to flake. A filled-primary surface's hover
 * fill is one shade lighter than its resting fill (light cyan-9 -> cyan-8), which
 * drops white-on-fill from 5.59:1 to 4.35:1, just under the AA floor that the
 * resting state (the one AA is judged on) clears with margin. `unhover` ignores
 * its argument and hovers `html > body`, moving the pointer to the body centre --
 * off this test's small top-left mount -- so polling `el` off `:hover` before reading
 * the live background is deterministic and reads what actually renders (a real
 * contrast regression then fails the assertion, not this poll). */
async function restingBackground(el: HTMLElement): Promise<string> {
  await userEvent.unhover(el);
  await expect.poll(() => el.matches(":hover")).toBe(false);
  return getComputedStyle(el).backgroundColor;
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
  // single >= 4.5 floor covers both schemes; expectedText pins WHICH text colour
  // renders, the half that regressed before. The background is read through
  // restingBackground so a stale-pointer hover -- a lighter fill that dips the light
  // case under the floor (only light: dark's hover fill is darker and raises the
  // black-on-fill ratio) -- is never sampled in place of the resting fill.
  for (const { scheme, expectedText } of [
    { scheme: "light" as const, expectedText: "rgb(255, 255, 255)" },
    { scheme: "dark" as const, expectedText: "rgb(0, 0, 0)" },
  ]) {
    test(`filled-primary button label is AA-legible (${scheme})`, async () => {
      mount(scheme, createElement(FilledButton, null, "Continue"));
      const btn = await waitForEl(".mantine-Button-root");
      await expect.poll(() => getComputedStyle(btn).color).toBe(expectedText);
      const backgroundColor = await restingBackground(btn);
      const { color } = getComputedStyle(btn);
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
      const fill = await restingBackground(input);
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
          PrimaryActionIcon,
          { "aria-label": "copy" },
          createElement("span", null, "i"),
        ),
      );
      const ai = await waitForEl(".mantine-ActionIcon-root");
      await expect.poll(() => getComputedStyle(ai).color).toBe(expectedText);
      const backgroundColor = await restingBackground(ai);
      const { color } = getComputedStyle(ai);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`copied-state copy icon glyph is AA-legible (${scheme})`, async () => {
      // ShareBlock swaps the copy ActionIcon to variant="light" once copied; the
      // check glyph is a non-text graphic, so the WCAG 1.4.11 3:1 floor. Mantine
      // owns this color: --ai-color resolves to --mantine-color-{primary}-light-color
      // on the --mantine-color-{primary}-light tint, both per scheme (light: cyan-9
      // on cyan-1; dark: cyan-0 on darken(cyan-9, .5)). No variant override touches
      // the light variant, so this reads exactly what Mantine paints -- the dark
      // branch in particular was never covered by the unit test's single light case.
      // Resting bg via restingBackground so a stale hover (light-variant hover =
      // cyan-2, a darker tint) is not sampled in place of the resting fill.
      mount(
        scheme,
        createElement(
          PrimaryActionIcon,
          { variant: "light", "aria-label": "copied" },
          createElement("span", null, "i"),
        ),
      );
      const ai = await waitForEl(".mantine-ActionIcon-root");
      const backgroundColor = await restingBackground(ai);
      const { color } = getComputedStyle(ai);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(3);
    });
  }

  // Exercises the de-flake mechanism directly, so the guard the cases above rely
  // on is a tested invariant rather than only the absence of a rare natural flake
  // (which a finite number of green runs cannot prove). Force the stale-hover
  // state on the light button -- where the hover fill (cyan-8) genuinely renders
  // a lower contrast than the resting fill (cyan-9) -- then prove restingBackground
  // moves the pointer off, clears :hover, and reads a resting fill clearing AA.
  test("restingBackground clears a stale hover before measuring", async () => {
    mount("light", createElement(FilledButton, null, "Continue"));
    const btn = await waitForEl(".mantine-Button-root");
    await expect
      .poll(() => getComputedStyle(btn).color)
      .toBe("rgb(255, 255, 255)");
    await userEvent.hover(btn);
    await expect.poll(() => btn.matches(":hover")).toBe(true);
    const hoverContrast = contrast(
      getComputedStyle(btn).color,
      getComputedStyle(btn).backgroundColor,
    );
    const backgroundColor = await restingBackground(btn);
    expect(btn.matches(":hover")).toBe(false);
    const { color } = getComputedStyle(btn);
    const restingContrast = contrast(color, backgroundColor);
    // The hover state is the one the cases above must avoid sampling; resting must
    // clear the floor and read brighter than the hover fill it replaced.
    expect(restingContrast).toBeGreaterThanOrEqual(4.5);
    expect(restingContrast).toBeGreaterThan(hoverContrast);
  });
});
