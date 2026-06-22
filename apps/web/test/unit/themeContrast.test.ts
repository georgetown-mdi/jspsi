import { describe, expect, test } from "vitest";

import { DEFAULT_THEME, darken, mergeMantineTheme } from "@mantine/core";

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

/** sRGB 0..255 channels of an `#rgb`/`#rrggbb` hex or an `rgb()/rgba()` string
 * -- the latter the form Mantine's `darken()` returns for the dark-scheme
 * light-variant tints, so a computed tint feeds the same arithmetic as a hex. */
function srgbChannels(color: string): [number, number, number] {
  if (color.startsWith("rgb")) {
    const [r, g, b] = color
      .slice(color.indexOf("(") + 1, color.indexOf(")"))
      .split(",", 3)
      .map((c) => parseInt(c, 10));
    return [r, g, b];
  }
  let n = color.replace("#", "");
  // Expand the 3-digit shorthand (Mantine's white is "#fff") to 6 digits.
  if (n.length === 3) {
    n = n
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.1 relative luminance of an `#rgb`/`#rrggbb` or `rgb()/rgba()` colour. */
function relativeLuminance(color: string): number {
  // 0.03928 is the threshold in WCAG 2.1's published relative-luminance formula
  // (and in Mantine's own luminance(), which drives its autoContrast picks). The
  // mathematically-exact sRGB break is 0.04045; the two differ only for a channel
  // landing in that narrow gap, which none of the tested colours do. Matching the
  // spec text and Mantine is deliberate -- do not "correct" it to 0.04045.
  const linearize = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = srgbChannels(color).map((c) => c / 255);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two colours (1..21). */
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

// Per-component Dropzone drag-state icon overrides (FileSelect.tsx), not theme
// tokens, so these are read straight off the palette and checked against the
// Dropzone's light-variant drag-over tints. The tint inverts with the scheme so
// the icon shade does too (light shade 8, dark shade 6, via light-dark):
//   - light tints: accept = primary colour shade 1 (Dropzone's acceptColor
//     defaults to theme.primaryColor), reject = red-1 (its default rejectColor);
//   - dark tints: darken(shade-9, .5), Mantine's dark `-light` variant -- the
//     real darken() so a resolver change re-runs the arithmetic, not a restated
//     constant.
const dropzoneAcceptIconLight = theme.colors.blue[8];
const dropzoneRejectIconLight = theme.colors.red[8];
const dropzoneAcceptIconDark = theme.colors.blue[6];
const dropzoneRejectIconDark = theme.colors.red[6];
const dropzoneAcceptTintLight = theme.colors[theme.primaryColor][1];
const dropzoneAcceptTintDark = darken(theme.colors[theme.primaryColor][9], 0.5);
const dropzoneRejectTintDark = darken(theme.colors.red[9], 0.5);

const warningText = vars.light["--mantine-color-yellow-light-color"];
const errorText = vars.light["--mantine-color-red-light-color"];
const errorToken = vars.light["--mantine-color-error"];
const dimmedLight = vars.light["--mantine-color-dimmed"];
const placeholderLight = vars.light["--mantine-color-placeholder"];
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
      {
        name: "error token (validation text + asterisk): on white input",
        fg: errorToken,
        bg: white,
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
        name: "placeholder text (light): on white input",
        fg: placeholderLight,
        bg: white,
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
      // Dropzone drag-state icons (FileSelect.tsx per-component overrides) on
      // their light-variant drag-over tints, both colour schemes -- non-text
      // graphics, so the 3:1 1.4.11 floor. Light shade 6 was a marginal accept
      // pass (3.04) and a reject failure (2.71); shade 8 clears both. The dark
      // tint inverts to a dark surface where shade 8 instead drops below the
      // floor (2.50 / 2.78), so dark keeps shade 6 (3.53 / 3.83) -- both branches
      // of the FileSelect light-dark() pinned here so neither scheme regresses.
      {
        name: "dropzone drag-accept icon (light): blue-8 on primary-1 tint",
        fg: dropzoneAcceptIconLight,
        bg: dropzoneAcceptTintLight,
        floor: 3,
      },
      {
        name: "dropzone drag-reject icon (light): red-8 on red-1 tint",
        fg: dropzoneRejectIconLight,
        bg: red1,
        floor: 3,
      },
      {
        name: "dropzone drag-accept icon (dark): blue-6 on darkened primary tint",
        fg: dropzoneAcceptIconDark,
        bg: dropzoneAcceptTintDark,
        floor: 3,
      },
      {
        name: "dropzone drag-reject icon (dark): red-6 on darkened red tint",
        fg: dropzoneRejectIconDark,
        bg: dropzoneRejectTintDark,
        floor: 3,
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
