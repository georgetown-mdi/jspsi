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
const darkShade =
  typeof theme.primaryShade === "number"
    ? theme.primaryShade
    : theme.primaryShade.dark;
const darkPrimary = theme.colors[theme.primaryColor][darkShade];
const white = theme.white;
const gray0 = theme.colors.gray[0];
const yellow1 = theme.colors.yellow[1];
const red1 = theme.colors.red[1];
const green1 = theme.colors.green[1];
const dark7 = theme.colors.dark[7];
const dark6 = theme.colors.dark[6];

const warningText = vars.light["--mantine-color-yellow-light-color"];
const errorText = vars.light["--mantine-color-red-light-color"];
const successText = vars.light["--mantine-color-green-light-color"];
const errorToken = vars.light["--mantine-color-error"];
const dimmedLight = vars.light["--mantine-color-dimmed"];
const placeholderLight = vars.light["--mantine-color-placeholder"];
const dimmedDark = vars.dark["--mantine-color-dimmed"];
const placeholderDark = vars.dark["--mantine-color-placeholder"];

// Resolves Mantine's `--mantine-primary-color-contrast` for a given primary fill,
// mirroring getPrimaryContrastColor -> getContrastColor: with autoContrast on, the
// contrast color is black when the fill is "light" (luminance strictly above the
// theme's luminanceThreshold, the same comparison as Mantine's isLightColor) else
// white; with autoContrast off it is always white. The filled-primary Button /
// ActionIcon / Checkbox text is routed to this variable by the theme (Mantine
// resolves a filled surface's own text color color-scheme-blind, so it would
// otherwise be white in both schemes); the "filled-primary text is routed..." test
// below pins that wiring. Reading the value from the theme rather than hardcoding it
// means flipping autoContrast off or picking a darker dark shade re-runs the
// arithmetic here -- a real check, not a restated constant.
function primaryContrast(fill: string): string {
  return theme.autoContrast &&
    relativeLuminance(fill) > theme.luminanceThreshold
    ? theme.black
    : theme.white;
}
const darkButtonText = primaryContrast(darkPrimary);

describe("theme colour contrast (WCAG 2.1 AA)", () => {
  const cases: Array<{ name: string; fg: string; bg: string; floor: number }> =
    [
      // Primary (raised to cyan-9): one shade covers every surface it touches.
      // The text colour is read through primaryContrast (the per-scheme contrast
      // variable the filled-primary text is routed to) so this tracks what actually
      // renders; the light guard test below locks it to white (byte-identical to the
      // pre-autoContrast static default).
      {
        name: "filled button text: contrast text on primary",
        fg: primaryContrast(primary),
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
      // The copied-state copy icon (ShareBlock's variant="light" ActionIcon) is
      // pinned in test/browser/themeContrast.test.ts instead: Mantine owns that
      // glyph's color through --mantine-color-{primary}-light-color (hardcoded to
      // shade 9, independent of primaryShade), so there is no per-component
      // constant to share and re-deriving the shade here would be the same blind
      // re-statement this harness avoids -- only a real render pins what it paints.
      // Dark scheme primary (shade 6): the counterpart to the light primary fix. A
      // lighter dark shade lifts the focus indicators on the dark surfaces, and the
      // filled-primary text -- routed to --mantine-primary-color-contrast (black on
      // cyan-6) -- clears the text floor. Modeled like the light primary cases above:
      // button text on the fill, focus ring on the dark-7 body, input focus border on
      // the dark-6 input. cyan-8 (the old default) left the button text at 4.35:1
      // (under 4.5); darkening to cyan-9 instead would drop the focus ring / input
      // border to 2.78:1 / 2.43:1 (under 3), which is why the shade went lighter, not
      // darker (and why the text fix is the contrast-var route, not a shade move).
      {
        name: "filled button text (dark): contrast var on dark primary",
        fg: darkButtonText,
        bg: darkPrimary,
        floor: 4.5,
      },
      {
        name: "focus ring (dark): dark primary on dark-7 body (non-text)",
        fg: darkPrimary,
        bg: dark7,
        floor: 3,
      },
      {
        name: "input focus border (dark): dark primary on dark-6 input (non-text)",
        fg: darkPrimary,
        bg: dark6,
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
        name: "success Alert title + Badge: deep green on green-1",
        fg: successText,
        bg: green1,
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
    // Enabling autoContrast (for the dark fix) must leave the light scheme
    // byte-identical: the light primary cyan-9 sits below the luminanceThreshold, so
    // --mantine-primary-color-contrast stays white -- the same colour the static
    // default produced. A future shade light enough to flip it to black would fail
    // here.
    expect(primaryContrast(primary)).toBe(white);
  });

  test("dark primary clears AA via the per-scheme contrast variable", () => {
    // autoContrast must be on so --mantine-primary-color-contrast computes per scheme,
    // and the dark shade must be light enough (luminance above the threshold) that it
    // resolves to black -- white-on-cyan-6 is only 2.79:1, so without the flip the
    // dark filled-primary text fails. Guards both halves so dropping autoContrast or
    // choosing a darker dark shade fails here, not only through whichever case above
    // happened to still pass.
    expect(theme.autoContrast).toBe(true);
    expect(relativeLuminance(darkPrimary)).toBeGreaterThan(
      theme.luminanceThreshold,
    );
    expect(darkButtonText).toBe(theme.black);
    expect(contrast(darkButtonText, darkPrimary)).toBeGreaterThanOrEqual(4.5);
  });

  test("filled-primary text is routed through the per-scheme contrast variable", () => {
    // The dark contrast cases above model --mantine-primary-color-contrast, which the
    // filled-primary Button / ActionIcon / Checkbox text must actually be pointed at
    // (Mantine resolves a filled surface's own text colour color-scheme-blind, so it
    // would otherwise be white in both schemes -- the failure this whole change
    // corrects). Pin that wiring: each component's vars override must emit the
    // contrast variable for the filled primary (default variant, no colour) and must
    // NOT touch a default/subtle/light or explicitly-coloured instance, which keep
    // their own text colour. The rendered colours themselves are checked in
    // test/browser/themeContrast.test.ts.
    const contrastVar = "var(--mantine-primary-color-contrast)";
    const wiring: Array<[string, string]> = [
      ["Button", "--button-color"],
      ["ActionIcon", "--ai-color"],
      ["Checkbox", "--checkbox-icon-color"],
    ];
    for (const [name, cssVar] of wiring) {
      const resolve = theme.components[name].vars;
      expect(resolve, `${name} vars override`).toBeDefined();
      const at = (props: Record<string, unknown>) =>
        resolve!(theme, props, {}).root[cssVar];
      expect(at({ variant: "filled" })).toBe(contrastVar);
      expect(at({})).toBe(contrastVar); // default variant is filled
      expect(at({ variant: "default" })).toBeUndefined();
      expect(at({ variant: "filled", color: "red" })).toBeUndefined();
    }
  });
});
