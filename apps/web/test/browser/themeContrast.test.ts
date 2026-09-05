/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Text,
  TextInput,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";

// tokens.css defines the --app-* custom properties app.module.css reads
// (--app-accent among them); AppPage.tsx imports it as a side effect in
// the real app, so the anchor-inside-.page case below needs it too, or
// --app-accent resolves to nothing and masks the rule this test targets.
import "@styles/tokens.css";
import appStyles from "@styles/app.module.css";

import { createAppMount } from "./renderApp";

import type { ComponentType, ReactNode } from "react";

// Button / Checkbox / Text / TextInput / Alert / ActionIcon are polymorphic factory
// components; this is a `.ts` file (the browser project globs `.ts`, not `.tsx`, so no
// JSX), and createElement cannot resolve their overloaded type directly -- cast each
// to the plain component shape this test renders.
const FilledButton = Button as unknown as ComponentType<{
  children?: ReactNode;
}>;
// Rendered with component="a" -- a bare host tag reproduces the exact selector
// clash a component={Link} render hits (Link ultimately renders a real <a>
// too), without pulling the router into this harness.
const LinkRenderedButton = Button as unknown as ComponentType<{
  component?: string;
  href?: string;
  children?: ReactNode;
}>;
const PrimaryCheckbox = Checkbox as unknown as ComponentType<{
  defaultChecked?: boolean;
  "aria-label"?: string;
}>;
const ColoredText = Text as unknown as ComponentType<{
  c?: string;
  "data-testid"?: string;
  children?: ReactNode;
}>;
const AppInput = TextInput as unknown as ComponentType<{
  placeholder?: string;
  error?: ReactNode;
  "aria-label"?: string;
}>;
const StatusAlert = Alert as unknown as ComponentType<{
  color?: string;
  title?: ReactNode;
  children?: ReactNode;
}>;
const PrimaryActionIcon = ActionIcon as unknown as ComponentType<{
  variant?: string;
  "aria-label"?: string;
  children?: ReactNode;
}>;

// Render-level counterpart to test/unit/themeContrast.test.ts: the unit test
// checks the palette arithmetic; this file measures the real computed colors
// the browser paints, in both schemes, against the WCAG 2.1 AA floors, since
// Mantine resolves several theme colors in JS color-scheme-blind.
//
// Two groups:
//  - Filled-primary surfaces (1.4.3 text, 4.5:1): the Button label, consent
//    Checkbox checkmark, and copy ActionIcon glyph, rendered as bare Mantine
//    primitives routed through --ai-color / --button-color /
//    --checkbox-icon-color. The ActionIcon glyph is checked filled (4.5:1
//    text) and variant="light" (1.4.11's 3:1, an uncustomized Mantine color).
//    The focus ring and input border stay in the unit test.
//  - Resolver-owned tokens (theme.ts cssVariablesResolver): dimmed,
//    placeholder, error, and the yellow/red/green light-variant status text.
//    Each case pins the exact resolved token color as well as the AA floor,
//    since a floor-only check would miss a token regressing to a default
//    that happens to still clear the floor (as red's does).

const app = createAppMount();

// Exact computed colours the resolver paints, pinned by the token cases below so a
// case cannot pass on a coincidental value or a default that happens to clear the
// floor. Mirror theme.ts: MUTED_TEXT (dimmed + placeholder) applies in both schemes;
// ERROR_TEXT and STATUS_TEXT (yellow warning / red error / green success) are
// light-scheme only.
const MUTED_TEXT = {
  light: "rgb(99, 107, 115)",
  dark: "rgb(146, 150, 155)",
} as const;
const ERROR_TEXT = "rgb(201, 42, 42)";
const STATUS_TEXT = {
  yellow: "rgb(146, 64, 14)",
  red: "rgb(165, 17, 17)",
  green: "rgb(34, 104, 58)",
} as const;

afterEach(app.unmount);

/** Wait for a mounted element (createRoot.render is not synchronous), then return
 * it. */
async function waitForEl(selector: string): Promise<HTMLElement> {
  await expect.poll(() => app.container.querySelector(selector)).not.toBeNull();
  return app.container.querySelector(selector) as HTMLElement;
}

/** Move the pointer off `el`, then return its resting (non-hover) background.
 * A freshly mounted surface can inherit `:hover` from the shared pointer's
 * last position, and the hover fill differs from the resting fill enough to
 * look like a contrast regression. `unhover` moves the pointer to
 * `html > body`, off this test's mount, so polling `el` off `:hover` first
 * makes the read deterministic. */
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

/** WCAG 2.1 relative luminance of a computed color string. The 0.03928 threshold is
 * the value printed in the WCAG 2.1 text (and used by Mantine's own luminance()), not
 * the more precise 0.04045; keep it as-is so this matches the spec and the byte-for-
 * byte copy in test/unit/themeContrast.test.ts (a naive "correction" would silently
 * diverge the two harnesses). */
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

describe("rendered filled-primary contrast (WCAG 2.1 AA)", () => {
  // A single >= 4.5 floor covers both schemes; expectedText pins which text
  // color renders, the half that regressed before. The background is read
  // through restingBackground so a stale-pointer hover fill is never sampled
  // in place of the resting fill; only the light scheme's fill is close
  // enough to the floor to be at risk.
  for (const { scheme, expectedText } of [
    { scheme: "light" as const, expectedText: "rgb(255, 255, 255)" },
    { scheme: "dark" as const, expectedText: "rgb(0, 0, 0)" },
  ]) {
    test(`filled-primary button label is AA-legible (${scheme})`, async () => {
      app.render(createElement(FilledButton, null, "Continue"), {
        forceColorScheme: scheme,
      });
      const btn = await waitForEl(".mantine-Button-root");
      await expect.poll(() => getComputedStyle(btn).color).toBe(expectedText);
      const backgroundColor = await restingBackground(btn);
      const { color } = getComputedStyle(btn);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`consent checkbox checkmark is AA-legible (${scheme})`, async () => {
      app.render(
        createElement(PrimaryCheckbox, {
          defaultChecked: true,
          "aria-label": "consent",
        }),
        { forceColorScheme: scheme },
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

    test(`filled-primary action-icon glyph is AA-legible (${scheme})`, async () => {
      // A bare filled-primary ActionIcon -- the theme's default variant, no colour --
      // as the app would paint a filled-primary icon button. Its glyph colour is
      // --ai-color, routed to the per-scheme contrast variable by the theme override
      // (the wiring the unit test proves for --ai-color; this pins it at the render
      // level, the half Mantine resolves color-scheme-blind).
      app.render(
        createElement(
          PrimaryActionIcon,
          { "aria-label": "copy" },
          createElement(IconCopy),
        ),
        { forceColorScheme: scheme },
      );
      const ai = await waitForEl(".mantine-ActionIcon-root");
      // Measure the glyph's OWN paint (its SVG stroke), not the ActionIcon root's
      // color. The root always reports --ai-color, but the glyph only wears that by
      // inheriting currentColor; reading the root would stay green if the glyph were
      // re-wrapped to hardcode its own colour. The two agree here; the stroke is what
      // the icon paints.
      const glyph = await waitForEl(".mantine-ActionIcon-root svg");
      await expect
        .poll(() => getComputedStyle(glyph).stroke)
        .toBe(expectedText);
      const backgroundColor = await restingBackground(ai);
      const color = getComputedStyle(glyph).stroke;
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`light-variant action-icon glyph is AA-legible (${scheme})`, async () => {
      // The variant="light" ActionIcon (the copied/secondary state a copy control
      // swaps to). The check glyph is a non-text graphic, so the WCAG 1.4.11 3:1
      // floor. Mantine owns this colour: --ai-color resolves to
      // --mantine-color-{primary}-light-color on the --mantine-color-{primary}-light
      // tint, both per scheme (light: cyan-9 on cyan-1; dark: cyan-0 on
      // darken(cyan-9, .5)) -- no override touches the light variant, so this reads
      // exactly what Mantine paints, including the dark branch.
      app.render(
        createElement(
          PrimaryActionIcon,
          { variant: "light", "aria-label": "copied" },
          createElement(IconCheck),
        ),
        { forceColorScheme: scheme },
      );
      const ai = await waitForEl(".mantine-ActionIcon-root");
      const glyph = await waitForEl(".mantine-ActionIcon-root svg");
      // Resting bg via restingBackground so a stale hover (light-variant hover =
      // cyan-2, a darker tint) is not sampled in place of the resting fill.
      const backgroundColor = await restingBackground(ai);
      const color = getComputedStyle(glyph).stroke;
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(3);
    });
  }

  // Exercises the de-flake mechanism directly: forces the stale-hover state on
  // the light button, where the hover fill (cyan-8) renders a lower contrast
  // than the resting fill (cyan-9), then proves restingBackground moves the
  // pointer off, clears :hover, and reads a resting fill clearing AA.
  test("restingBackground clears a stale hover before measuring", async () => {
    app.render(createElement(FilledButton, null, "Continue"), {
      forceColorScheme: "light",
    });
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

  // A filled-primary Button rendered as an anchor (component={Link} in the
  // app; component="a" here) inside the app's `.page` wrapper.
  // app.module.css's `.page a` rule can outrank Mantine's --button-color on
  // specificity and repaint the label --app-accent, close enough to the
  // cyan-9 background to be unreadable. This proves the label and background
  // are distinguishable colors, not just that each clears its own floor.
  test("a Button rendered as an anchor inside .page keeps its filled label legible", async () => {
    app.render(
      createElement(
        "div",
        { className: appStyles.page },
        createElement(
          LinkRenderedButton,
          { component: "a", href: "/exchange" },
          "Create an invitation",
        ),
      ),
      { forceColorScheme: "light" },
    );
    const btn = await waitForEl(".mantine-Button-root");
    const backgroundColor = await restingBackground(btn);
    const { color } = getComputedStyle(btn);
    expect(color).not.toBe(backgroundColor);
    expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("rendered resolver-owned token contrast (WCAG 2.1 AA)", () => {
  // dimmed, error, and green page text sit on the app body surface; wrap the render
  // in a container painted with --mantine-color-body so the measured background is
  // the real per-scheme body (white light / dark-7 dark), not a transparent ancestor.
  function bodySurface(node: ReactNode): ReactNode {
    return createElement(
      "div",
      {
        "data-testid": "surface",
        style: { background: "var(--mantine-color-body)" },
      },
      node,
    );
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`dimmed text is AA-legible (${scheme})`, async () => {
      // c="dimmed" -> --mantine-color-dimmed, raised by the resolver in both schemes
      // (Mantine's gray-6 / dark-2 default fails 4.5:1 on the body).
      app.render(
        bodySurface(
          createElement(
            ColoredText,
            { c: "dimmed", "data-testid": "dimmed" },
            "Secondary supporting text",
          ),
        ),
        { forceColorScheme: scheme },
      );
      const text = await waitForEl('[data-testid="dimmed"]');
      const surface = await waitForEl('[data-testid="surface"]');
      const color = getComputedStyle(text).color;
      const bg = getComputedStyle(surface).backgroundColor;
      // Pin the resolved token colour (proof the resolver reached the surface), then
      // the AA floor against the real body background.
      expect(color).toBe(MUTED_TEXT[scheme]);
      expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
    });

    test(`input placeholder is AA-legible (${scheme})`, async () => {
      // --mantine-color-placeholder, raised by the resolver in both schemes (Mantine's
      // gray-5 / dark-3 default is the lightest failing token, 2.08:1 / 2.47:1). The
      // placeholder paints on the input's own fill (white light / dark-6 dark).
      app.render(
        createElement(AppInput, {
          placeholder: "Your name",
          "aria-label": "name",
        }),
        { forceColorScheme: scheme },
      );
      const input = await waitForEl("input");
      const placeholderColor = getComputedStyle(input, "::placeholder").color;
      const bg = getComputedStyle(input).backgroundColor;
      // Pin the resolved token colour: this both proves the resolver reached the
      // placeholder and guards the vacuous pass where the ::placeholder pseudo read
      // falls back to the input's own (dark, high-contrast) text colour.
      expect(placeholderColor).toBe(MUTED_TEXT[scheme]);
      expect(contrast(placeholderColor, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // error and the yellow/red/green light-variant status text are overridden by the
  // resolver in the LIGHT scheme only (that is where the dark-on-light failures are;
  // the dark scheme keeps Mantine's inverse near-white-on-tint arrangement, which
  // passes).
  test("error validation text is AA-legible (light)", async () => {
    // --mantine-color-error, raised by the resolver in light (Mantine's red-6 default
    // = 3.28:1 on the white page fails the 1.4.3 validation-text floor).
    app.render(
      bodySurface(
        createElement(AppInput, {
          "aria-label": "field",
          error: "This field is required",
        }),
      ),
      { forceColorScheme: "light" },
    );
    // The input references its validation message (the --mantine-color-error text)
    // through aria-describedby; resolve that element within the container -- scoped
    // to this mount and polled until present, not a global getElementById that could
    // race the render or match another test's id. CSS.escape because React's useId
    // ids contain colons, which are querySelector metacharacters.
    const input = await waitForEl("input");
    const errorId = input.getAttribute("aria-describedby");
    if (errorId === null)
      throw new Error("errored input has no aria-describedby message");
    const errorEl = await waitForEl(`#${CSS.escape(errorId)}`);
    const surface = await waitForEl('[data-testid="surface"]');
    const color = getComputedStyle(errorEl).color;
    const bg = getComputedStyle(surface).backgroundColor;
    expect(color).toBe(ERROR_TEXT);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("green status token is AA-legible as page text (light)", async () => {
    // The green status token rendered as plain page text, matching how
    // TermsImportExport's import-success message uses it on a white/body
    // background (distinct from the Alert case's green tint; c="green" alone
    // is only 4.37:1 here, under the floor). This is a stand-in, not a render
    // of TermsImportExport, so it does not catch that component's own c prop
    // regressing to "green"; that call site has its own guard comment.
    app.render(
      bodySurface(
        createElement(
          ColoredText,
          {
            c: "var(--mantine-color-green-light-color)",
            "data-testid": "success",
          },
          "Terms imported",
        ),
      ),
      { forceColorScheme: "light" },
    );
    const text = await waitForEl('[data-testid="success"]');
    const surface = await waitForEl('[data-testid="surface"]');
    const color = getComputedStyle(text).color;
    const bg = getComputedStyle(surface).backgroundColor;
    expect(color).toBe(STATUS_TEXT.green);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
  });

  for (const { color, label } of [
    { color: "yellow", label: "warning" },
    { color: "green", label: "success" },
    { color: "red", label: "error" },
  ] as const) {
    test(`${label} alert title is AA-legible (light)`, async () => {
      // --mantine-color-{color}-light-color on the {color}-light tint, raised by the
      // resolver in light (Mantine's yellow-9 on yellow-1 = 2.69:1 fails even 3:1;
      // red-9 on red-1 = 4.51:1 is a fragile hairline). The Alert owns both the title
      // colour and its tint background, so this is self-contained.
      app.render(
        createElement(
          StatusAlert,
          { color, title: "Heads up" },
          "Body copy for the alert.",
        ),
        { forceColorScheme: "light" },
      );
      const alert = await waitForEl('[role="alert"]');
      // Scope the title lookup to the alert and poll for it, so a Mantine markup
      // change shows as a clear waitForEl timeout rather than a getComputedStyle
      // TypeError on a null cast.
      const title = await waitForEl('[role="alert"] [class*="title"]');
      const titleColor = getComputedStyle(title).color;
      const bg = getComputedStyle(alert).backgroundColor;
      // Pin the resolved status colour: unlike the other tokens, red's Mantine
      // default clears the floor, so only pinning the colour catches it regressing.
      expect(titleColor).toBe(STATUS_TEXT[color]);
      expect(contrast(titleColor, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
