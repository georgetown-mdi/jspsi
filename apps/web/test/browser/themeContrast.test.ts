/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";
import {
  Alert,
  Button,
  Checkbox,
  MantineProvider,
  Text,
  TextInput,
} from "@mantine/core";

import { ShareBlock } from "@components/ShareBlock";

import { cssVariablesResolver, mantineTheme } from "@theme";

import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";

// Button / Checkbox / Text / TextInput / Alert are polymorphic factory components;
// this is a `.ts` file (the browser project globs `.ts`, not `.tsx`, so no JSX), and
// createElement cannot resolve their overloaded type directly -- cast each to the
// plain component shape this test renders. ShareBlock is a plain function component
// and needs no cast.
const FilledButton = Button as unknown as ComponentType<{
  children?: ReactNode;
}>;
const PrimaryCheckbox = Checkbox as unknown as ComponentType<{
  defaultChecked?: boolean;
  "aria-label"?: string;
}>;
const DimmedText = Text as unknown as ComponentType<{
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

// Render-level counterpart to test/unit/themeContrast.test.ts. The unit test asserts
// the palette arithmetic (an idealized model); it cannot prove the browser actually
// paints those colors, because Mantine resolves several theme colors in JS
// color-scheme-blind. That blind spot already shipped one regression (a dark button
// rendered white-on-cyan-6 = 2.79:1 while a unit test that modeled an idealized
// autoContrast stayed green), so this measures the REAL computed colors the browser
// paints, in both schemes, against the WCAG 2.1 AA floors.
//
// Two groups:
//  - Filled-primary surfaces (1.4.3 text, 4.5:1). The copy ActionIcon glyph is driven
//    from the REAL component (ShareBlock's CopyRow), in both its filled and its copied
//    (variant="light", a non-text glyph judged on 1.4.11's 3:1) states, so a
//    contrast-affecting change authored inside that component -- an added color prop,
//    a flipped variant conditional, a re-wrapped glyph -- fails here rather than
//    slipping past a hardcoded stand-in. The Button label and consent Checkbox
//    checkmark are rendered as bare Mantine defaults on purpose: the app paints those
//    surfaces with a bare <Button>/<Checkbox> (the theme's default variant, no color)
//    and no wrapping component, so a bare primitive IS what the app paints -- there is
//    no component to author a regression into, and the theme's isFilledPrimary scoping
//    (proven by the unit test) is what routes their contrast color. The focus ring /
//    input border (a plain per-scheme shade) and the Dropzone drag-icon shades (a
//    literal inline color shared with the unit test through DROPZONE_DRAG_ICON) stay
//    in the unit test, which checks them by arithmetic.
//  - Resolver-owned tokens (theme.ts cssVariablesResolver): dimmed, placeholder,
//    error, and the yellow/red light-variant status text. The harness now mounts under
//    the app's real cssVariablesResolver (see mount below), so these are exercised at
//    the render level for the first time -- previously only the arithmetic unit test
//    saw them. Each token's raised value clears the AA floor while Mantine's default
//    (which the resolver overrides) fails it (e.g. placeholder gray-5 = 2.08:1), so a
//    case's floor assertion doubles as proof the resolver reached the surface: drop
//    the resolver and the failing default trips the floor.

let container: HTMLElement | undefined;
let root: Root | undefined;

// ShareBlock renders a copy control per artifact; the copied color is theme-driven and
// independent of the value, so any non-empty strings suffice.
const SHARE = {
  deepLink: "https://example.test/accept#invitation-token",
  encoded: "INVITATION-TOKEN",
};

function mount(scheme: "light" | "dark", node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      // The app root (routes/__root.tsx) configures the provider with BOTH the theme
      // and the cssVariablesResolver; render under the same config so a resolver
      // override on a covered surface is exercised here, not only in the idealized
      // arithmetic of the unit test.
      { theme: mantineTheme, cssVariablesResolver, forceColorScheme: scheme },
      node,
    ),
  );
}

beforeEach(() => {
  // Drive the real CopyButton without depending on the headless browser's clipboard
  // permission or secure-context state: CopyRow's guard only needs navigator.clipboard
  // to exist (it does in the browser project) and useClipboard only flips `copied`
  // once writeText RESOLVES. Stubbing writeText to resolve makes the copied-state case
  // deterministic; it is otherwise unused (the other cases never click).
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
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

describe("rendered filled-primary contrast (WCAG 2.1 AA)", () => {
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

    test(`filled copy icon glyph is AA-legible (${scheme})`, async () => {
      // The REAL copy control (ShareBlock's CopyRow) in its resting, filled state.
      // ShareBlock is the app's only filled-primary ActionIcon; its glyph colour is
      // --ai-color, routed to the per-scheme contrast variable by the theme override.
      // Query the first of the two copy buttons (the invitation-link row).
      mount(scheme, createElement(ShareBlock, SHARE));
      const ai = await waitForEl(".mantine-ActionIcon-root");
      await expect.poll(() => getComputedStyle(ai).color).toBe(expectedText);
      const backgroundColor = await restingBackground(ai);
      const { color } = getComputedStyle(ai);
      expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`copied copy icon glyph is AA-legible (${scheme})`, async () => {
      // Drive the SAME real control into its copied state: CopyRow swaps the
      // ActionIcon to variant="light" and the glyph to IconCheck once copied. The
      // check glyph is a non-text graphic, so the WCAG 1.4.11 3:1 floor. Mantine owns
      // this colour: --ai-color resolves to --mantine-color-{primary}-light-color on
      // the --mantine-color-{primary}-light tint, both per scheme (light: cyan-9 on
      // cyan-1; dark: cyan-0 on darken(cyan-9, .5)) -- no override touches the light
      // variant, so this reads exactly what Mantine paints, including the dark branch
      // the unit test's single light case never covered.
      mount(scheme, createElement(ShareBlock, SHARE));
      const ai = await waitForEl(".mantine-ActionIcon-root");
      await userEvent.click(ai);
      // The copied state is signalled by the ActionIcon's aria-label flipping to
      // "<label> copied" (CopyRow); poll it rather than a timer so the read happens
      // only once the variant has actually flipped to light.
      await expect
        .poll(() => ai.getAttribute("aria-label"))
        .toContain("copied");
      // Resting bg via restingBackground so a stale hover (light-variant hover =
      // cyan-2, a darker tint) is not sampled in place of the resting fill.
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

describe("rendered resolver-owned token contrast (WCAG 2.1 AA)", () => {
  // dimmed and error text sit on the app body surface; wrap the render in a container
  // painted with --mantine-color-body so the measured background is the real
  // per-scheme body (white light / dark-7 dark) rather than a transparent ancestor.
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
            DimmedText,
            { c: "dimmed", "data-testid": "dimmed" },
            "Secondary supporting text",
          ),
        ),
      );
      const text = await waitForEl('[data-testid="dimmed"]');
      const surface = await waitForEl('[data-testid="surface"]');
      const bg = getComputedStyle(surface).backgroundColor;
      expect(contrast(getComputedStyle(text).color, bg)).toBeGreaterThanOrEqual(
        4.5,
      );
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
      // Guard against a vacuous pass: if the ::placeholder pseudo read ever fell back
      // to the input's own (dark, high-contrast) text color, the floor below would
      // pass without measuring the placeholder token at all. The muted placeholder is
      // deliberately lower-emphasis than the entered text, so the two must differ.
      expect(placeholderColor).not.toBe(getComputedStyle(input).color);
      expect(contrast(placeholderColor, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // error and the yellow/red light-variant status text are overridden by the resolver
  // in the LIGHT scheme only (that is where the dark-on-light failures are; the dark
  // scheme keeps Mantine's inverse near-white-on-tint arrangement, which passes).
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
    const input = await waitForEl("input");
    const describedBy = input.getAttribute("aria-describedby");
    const errorEl = describedBy
      ? (document.getElementById(describedBy) as HTMLElement)
      : await waitForEl('[class*="Error"]');
    const surface = await waitForEl('[data-testid="surface"]');
    const bg = getComputedStyle(surface).backgroundColor;
    expect(
      contrast(getComputedStyle(errorEl).color, bg),
    ).toBeGreaterThanOrEqual(4.5);
  });

  for (const { color, label } of [
    { color: "yellow", label: "warning" },
    { color: "red", label: "error" },
  ]) {
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
      const title = alert.querySelector('[class*="title"]') as HTMLElement;
      const bg = getComputedStyle(alert).backgroundColor;
      expect(
        contrast(getComputedStyle(title).color, bg),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
