/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

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

// tokens.css defines the --bench-* custom properties bench.module.css reads
// (--bench-accent among them); BenchPage.tsx imports it as a side effect in
// the real app, so the anchor-inside-.page case below needs it too, or
// --bench-accent resolves to nothing and masks the rule this test targets.
import "@bench/tokens.css";
import benchStyles from "@bench/bench.module.css";

import { renderApp } from "./renderApp";

import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";

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

// Render-level counterpart to test/unit/themeContrast.test.ts. The unit test asserts
// the palette arithmetic (an idealized model); it cannot prove the browser actually
// paints those colors, because Mantine resolves several theme colors in JS
// color-scheme-blind. That blind spot already shipped one regression (a dark button
// rendered white-on-cyan-6 = 2.79:1 while a unit test that modeled an idealized
// autoContrast stayed green), so this measures the REAL computed colors the browser
// paints, in both schemes, against the WCAG 2.1 AA floors.
//
// Two groups:
//  - Filled-primary surfaces (1.4.3 text, 4.5:1). The Button label, consent Checkbox
//    checkmark, and copy ActionIcon glyph are rendered as bare Mantine primitives (the
//    theme's default variant, no color): the app paints these surfaces with a bare
//    <Button>/<Checkbox>/<ActionIcon> and no wrapping component, so a bare primitive IS
//    what the app paints -- there is no component to author a regression into, and the
//    theme's isFilledPrimary scoping (proven by the unit test) is what routes their
//    contrast color through --ai-color / --button-color / --checkbox-icon-color. The
//    ActionIcon glyph is checked in both its filled (resting, 4.5:1 text) and its
//    variant="light" (a non-text glyph judged on 1.4.11's 3:1) states -- the light
//    variant's colour is Mantine's own, which no override touches. The focus ring /
//    input border (a plain per-scheme shade) stays in the unit test, which checks it by
//    arithmetic.
//  - Resolver-owned tokens (theme.ts cssVariablesResolver): dimmed, placeholder,
//    error, and the yellow/red/green light-variant status text (the last also as the
//    green import-success page text). The harness now mounts under
//    the app's real cssVariablesResolver (see mount below), so these are exercised at
//    the render level for the first time -- previously only the arithmetic unit test
//    saw them. Each case pins the EXACT resolved token colour (proof the resolver
//    reached the surface) as well as the AA floor (proof it is legible). Pinning the
//    colour, not just the floor, is necessary: one default the resolver replaces
//    (red's light-variant, red-9-on-red-1 = 4.51:1) already clears the floor, so a
//    floor-only check would not notice that token regressing back to its default.

let container: HTMLElement | undefined;
let root: Root | undefined;

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

function mount(scheme: "light" | "dark", node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(node, { forceColorScheme: scheme }));
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
  // Black resolves brighter on cyan-6 (7.53) than white does on cyan-9 (5.59), so a
  // single >= 4.5 floor covers both schemes; expectedText pins WHICH text colour
  // renders, the half that regressed before. The background is read through
  // restingBackground so a stale-pointer hover fill -- in the light scheme one shade
  // lighter (cyan-9 -> cyan-8), which drops white-on-fill under the floor -- is never
  // sampled in place of the resting fill. Only light is at risk: the dark scheme's
  // black-on-fill starts at 7.53:1 resting and clears the floor in either state.
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

    test(`filled-primary action-icon glyph is AA-legible (${scheme})`, async () => {
      // A bare filled-primary ActionIcon -- the theme's default variant, no colour --
      // as the app would paint a filled-primary icon button. Its glyph colour is
      // --ai-color, routed to the per-scheme contrast variable by the theme override
      // (the wiring the unit test proves for --ai-color; this pins it at the render
      // level, the half Mantine resolves color-scheme-blind).
      mount(
        scheme,
        createElement(
          PrimaryActionIcon,
          { "aria-label": "copy" },
          createElement(IconCopy),
        ),
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
      mount(
        scheme,
        createElement(
          PrimaryActionIcon,
          { variant: "light", "aria-label": "copied" },
          createElement(IconCheck),
        ),
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

  // A filled-primary Button rendered as an anchor (component={Link} in the
  // app; component="a" here, see LinkRenderedButton above) inside the bench's
  // .page wrapper. bench.module.css's `.page a` rule once outranked Mantine's
  // --button-color on specificity (class+type beats Mantine's single class on
  // .mantine-Button-root) and repainted the label --bench-accent -- a teal
  // close enough to the cyan-9 filled background that the label was
  // unreadable until :hover changed the background. This proves the label and
  // background are actually distinguishable colors, not just that each
  // individually clears an arithmetic floor -- the two could still be pinned
  // to the same value and pass a floor-only check.
  test("a Button rendered as an anchor inside .page keeps its filled label legible", async () => {
    mount(
      "light",
      createElement(
        "div",
        { className: benchStyles.page },
        createElement(
          LinkRenderedButton,
          { component: "a", href: "/exchange" },
          "Create an invitation",
        ),
      ),
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
      mount(
        scheme,
        bodySurface(
          createElement(
            ColoredText,
            { c: "dimmed", "data-testid": "dimmed" },
            "Secondary supporting text",
          ),
        ),
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
      mount(
        scheme,
        createElement(AppInput, {
          placeholder: "Your name",
          "aria-label": "name",
        }),
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
    mount(
      "light",
      bodySurface(
        createElement(AppInput, {
          "aria-label": "field",
          error: "This field is required",
        }),
      ),
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
    // The green status token rendered as plain page text -- the surface
    // TermsImportExport's import-success message uses, a white/body background
    // distinct from the Alert case's green tint (a bare c="green" = green-9 is only
    // 4.37:1 here, under the 1.4.3 floor). This pins the TOKEN on a page surface; it
    // is deliberately a stand-in, not a render of TermsImportExport, so it does not
    // catch that component reverting its c prop to "green" -- driving the real
    // component to its imported state would pull its import-validation deps' mocks
    // into this shared harness. That call-site is guarded by its own comment instead.
    mount(
      "light",
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
      mount(
        "light",
        createElement(
          StatusAlert,
          { color, title: "Heads up" },
          "Body copy for the alert.",
        ),
      );
      const alert = await waitForEl('[role="alert"]');
      // Scope the title lookup to the alert and poll for it, so a Mantine markup
      // change surfaces as a clear waitForEl timeout rather than a getComputedStyle
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
