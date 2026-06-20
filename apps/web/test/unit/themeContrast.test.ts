import { describe, expect, test } from "vitest";

import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";

// Enforces the WCAG 2.1 AA contrast invariants the theme is tuned to: 4.5:1 for
// normal-weight text (1.4.3) and 3:1 for non-text UI / focus indicators (1.4.11).
// The JSDoc in theme.ts records the chosen colors and their ratios; this is the
// executable form of those claims, so a future palette nudge or Mantine bump that
// silently drops a surface under its floor fails here instead of shipping.
//
// Colours are read from the MERGED theme (createTheme is the identity function,
// so mantineTheme alone has no `colors`) and from the cssVariablesResolver output
// rather than hardcoded hex, so changing primaryShade or an override re-runs the
// arithmetic against the new value -- a real check, not a restatement.

/** WCAG 2.1 relative luminance of an `#rgb` or `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const linearize = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  let n = hex.replace("#", "");
  // Expand the 3-digit shorthand (Mantine's white is "#fff") to 6 digits.
  if (n.length === 3) {
    n = n
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours (1..21). */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const theme = mergeMantineTheme(DEFAULT_THEME, mantineTheme);
const vars = cssVariablesResolver(theme);

const lightShade =
  typeof theme.primaryShade === "number"
    ? theme.primaryShade
    : theme.primaryShade.light;
const primary = theme.colors[theme.primaryColor][lightShade];
const white = theme.white;
const gray0 = theme.colors.gray[0];
const cyan1 = theme.colors.cyan[1];
const yellow1 = theme.colors.yellow[1];
const red1 = theme.colors.red[1];
const dark7 = theme.colors.dark[7];
const dark6 = theme.colors.dark[6];

const warningText = vars.light["--mantine-color-yellow-light-color"];
const errorText = vars.light["--mantine-color-red-light-color"];
const dimmedLight = vars.light["--mantine-color-dimmed"];
const dimmedDark = vars.dark["--mantine-color-dimmed"];
const placeholderDark = vars.dark["--mantine-color-placeholder"];

describe("theme colour contrast (WCAG 2.1 AA)", () => {
  const cases: Array<{ name: string; fg: string; bg: string; floor: number }> =
    [
      // Primary (raised to cyan-9): one shade covers every surface it touches.
      {
        name: "filled button text: white on primary",
        fg: white,
        bg: primary,
        floor: 4.5,
      },
      {
        name: "anchor/link text: primary on white page",
        fg: primary,
        bg: white,
        floor: 4.5,
      },
      {
        name: "anchor/link text: primary on gray-0 surface",
        fg: primary,
        bg: gray0,
        floor: 4.5,
      },
      {
        name: "focus ring + input border: primary on page (non-text)",
        fg: primary,
        bg: white,
        floor: 3,
      },
      {
        name: "copied-state copy icon: primary on cyan-1 (non-text)",
        fg: primary,
        bg: cyan1,
        floor: 3,
      },
      // Status light-variant text (overridden tokens) on their shade-1 tints.
      {
        name: "warning Alert title + Badge: amber on yellow-1",
        fg: warningText,
        bg: yellow1,
        floor: 4.5,
      },
      {
        name: "error Alert title: deep red on red-1",
        fg: errorText,
        bg: red1,
        floor: 4.5,
      },
      // Locks the prior dimmed/placeholder fix in both schemes.
      {
        name: "dimmed text (light): on white body",
        fg: dimmedLight,
        bg: white,
        floor: 4.5,
      },
      {
        name: "dimmed text (light): on gray-0 surface",
        fg: dimmedLight,
        bg: gray0,
        floor: 4.5,
      },
      {
        name: "dimmed text (dark): on dark-7 body",
        fg: dimmedDark,
        bg: dark7,
        floor: 4.5,
      },
      {
        name: "placeholder text (dark): on dark-6 input",
        fg: placeholderDark,
        bg: dark6,
        floor: 4.5,
      },
    ];

  test.each(cases)("$name >= $floor:1", ({ fg, bg, floor }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(floor);
  });

  test("primary uses the AA-tuned light shade, not the failing default", () => {
    // cyan-6 (Mantine's default light primary shade) reintroduces the 2.79:1
    // button/anchor/focus failures, and cyan-8 is short at 4.35:1; cyan-9 is the
    // first shade clearing the 4.5 text floor with white text. Guards the choice
    // itself, since the cases above would still pass at a wrongly-low shade only
    // if every other surface happened to compensate.
    expect(lightShade).toBeGreaterThanOrEqual(9);
    expect(contrast(white, primary)).toBeGreaterThanOrEqual(4.5);
  });
});
