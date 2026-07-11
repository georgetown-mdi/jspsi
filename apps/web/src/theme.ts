import {
  ActionIcon,
  Button,
  Card,
  Checkbox,
  Container,
  Paper,
  Select,
  createTheme,
  rem,
} from "@mantine/core";

import type { CSSVariablesResolver, MantineThemeOverride } from "@mantine/core";

/**
 * True for a filled surface rendered in the primary color -- the default
 * (`filled`, no explicit `color`) Button / ActionIcon / Checkbox. Used to scope the
 * per-scheme contrast-text overrides below so they touch only the primary-filled
 * surfaces, leaving `default`/`subtle`/`light` variants and any future non-primary
 * filled surface on their own text color. See {@link FILLED_PRIMARY_CONTRAST}.
 */
const isFilledPrimary = (
  variant: string | undefined,
  color: string | undefined,
) => (variant === undefined || variant === "filled") && color === undefined;

/**
 * Route a filled-primary surface's text/icon color through Mantine's per-scheme
 * `--mantine-primary-color-contrast` variable instead of the static white its own
 * varsResolver emits.
 *
 * Mantine resolves a filled theme-color surface's text color color-scheme-blind:
 * the Button/ActionIcon/Checkbox `varsResolver`s call the variant resolver with no
 * color scheme, so `autoContrast` parses the primary against its LIGHT shade
 * (cyan-9, luminance 0.14 -> not light) and picks white for BOTH schemes. That
 * leaves the dark filled-primary text white on the brighter cyan-6 dark fill =
 * 2.79:1, below the 1.4.3 floor. `--mantine-primary-color-contrast` is the one
 * contrast value Mantine computes per scheme (white on the light cyan-9 fill, black
 * on the dark cyan-6 fill -- the latter is why `autoContrast` must stay enabled, as
 * it drives that pick), so pointing the filled-primary text at it yields black-on-
 * cyan-6 = 7.53:1 in dark while staying white in light (byte-identical to the static
 * default). Each component names this color through a different CSS variable, hence
 * three near-identical overrides. The resolved ratios are enforced by
 * test/unit/themeContrast.test.ts and the rendered colors by
 * test/browser/themeContrast.test.ts.
 */
const FILLED_PRIMARY_CONTRAST = "var(--mantine-primary-color-contrast)";

const CONTAINER_SIZES = {
  xxs: rem("200px"),
  xs: rem("300px"),
  sm: rem("400px"),
  md: rem("500px"),
  lg: rem("600px"),
  xl: rem("1400px"),
  xxl: rem("1600px"),
};

/**
 * A named content width in the {@link CONTAINER_SIZES} scale. The single
 * vocabulary the content-width seam speaks: a route declares one of these and
 * the shell sizes both its chrome and the route's content to it, so neither side
 * names a raw pixel width.
 */
export type ContainerWidth = keyof typeof CONTAINER_SIZES;

export const mantineTheme: MantineThemeOverride = createTheme({
  fontSizes: {
    xs: rem("12px"),
    sm: rem("14px"),
    md: rem("16px"),
    lg: rem("18px"),
    xl: rem("20px"),
    "2xl": rem("24px"),
    "3xl": rem("30px"),
    "4xl": rem("36px"),
    "5xl": rem("48px"),
  },
  spacing: {
    "3xs": rem("4px"),
    "2xs": rem("8px"),
    xs: rem("10px"),
    sm: rem("12px"),
    md: rem("16px"),
    lg: rem("20px"),
    xl: rem("24px"),
    "2xl": rem("28px"),
    "3xl": rem("32px"),
  },
  primaryColor: "cyan",
  // Enabled so Mantine computes `--mantine-primary-color-contrast` per scheme (white
  // on the light cyan-9 fill, black on the dark cyan-6 fill), the variable the
  // filled-primary overrides below route their text/icon color to; without it that
  // variable is white in both schemes and the dark text fix would not hold.
  // autoContrast does NOT by itself recolor filled theme-color text per scheme -- see
  // FILLED_PRIMARY_CONTRAST above for why the overrides, not autoContrast, are the fix.
  autoContrast: true,
  // Honor the OS `prefers-reduced-motion` setting: Mantine then skips the
  // transition animations its components drive in JS (Collapse, Transition, and the
  // Menu/Tooltip/Popover overlays all read this flag and zero their duration), and
  // arms the `[data-respect-reduced-motion] [data-reduce-motion]` global CSS rule
  // for the components that opt in through that attribute. Off (Mantine's default)
  // until the disclosure/overlay surfaces were audited for the class of latent bug
  // where a closed Collapse panel goes away for a reduced-motion user and a toggle's
  // aria-controls / focus target then dangles -- every such id sits on an
  // always-mounted wrapper, not the Collapse panel (the InvitationTerms,
  // ExpertKeyEditor, and DisclosureSection disclosures), pinned by the reduced-motion
  // render tests. Motion this flag does NOT reach is gated on useReducedMotion()
  // directly at its source instead: the hand-rolled chevron rotate transitions (raw
  // inline styles, not Mantine nodes) and the Status progress bar's looping `animated`
  // stripe (a Mantine CSS keyframe with no data-reduce-motion guard, and decorative --
  // the bar's fill already conveys progress without it). The Mantine `Loader` spinner
  // is likewise unreached but deliberately left animating: it is the sole "working"
  // indicator with no static channel to fall back to, so suppressing its motion would
  // remove the signal rather than just its decoration.
  respectReducedMotion: true,
  // Per-scheme primary shade, each tuned to WCAG 2.1 AA (1.4.3 text 4.5:1, 1.4.11
  // non-text 3:1) against its own surfaces; enforced by
  // test/unit/themeContrast.test.ts.
  //
  // Light raised 6 -> 9. The default cyan-6 (#15aabf) fails wherever the primary is
  // used: white-on-cyan-6 filled buttons (and the copy ActionIcon glyph and the
  // consent Checkbox checkmark) = 2.79:1; the cyan-6 anchor/link and the cyan-6
  // focus-visible outline / input focus border on the white page = 2.79:1. cyan-8
  // is also short (white text 4.35:1); cyan-9 (#0b7285) is the first shade clearing
  // it, fixing all of those at once: white-on-cyan-9 = 5.59:1 and cyan-9-on-white =
  // 5.59:1. The filled hover step resolves to cyan-8 (4.35:1) -- transient, and AA
  // is judged on the resting state.
  //
  // Dark moved 8 -> 6. No single cyan shade satisfies both dark bars with WHITE
  // filled text: cyan-8 (the old default) left the filled button text at
  // white-on-cyan-8 = 4.35:1 (under 4.5), and darkening to cyan-9 fixes the button
  // but drops the focus ring / input border on the dark body to 2.78:1 / 2.43:1
  // (under 3). cyan-6 is bright enough that the focus ring on the dark-7 body reaches
  // 5.57:1 and the input focus border on the dark-6 input 4.87:1, and the
  // filled-primary text -- routed through --mantine-primary-color-contrast (black on
  // cyan-6) by the component overrides below -- reaches 7.53:1. All three clear with
  // margin.
  primaryShade: { light: 9, dark: 6 },
  components: {
    // Filled-primary text/icon -> per-scheme contrast color (see
    // FILLED_PRIMARY_CONTRAST). Each names the color through its own CSS variable;
    // the merge keeps the rest of each component's vars (background, sizing).
    Button: Button.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--button-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    ActionIcon: ActionIcon.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--ai-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    Checkbox: Checkbox.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--checkbox-icon-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    Container: Container.extend({
      vars: (_, { size, fluid }) => ({
        root: {
          "--container-size": fluid
            ? "100%"
            : size !== undefined && size in CONTAINER_SIZES
              ? CONTAINER_SIZES[size as ContainerWidth]
              : rem(size),
        },
      }),
    }),
    Paper: Paper.extend({
      defaultProps: {
        p: "md",
        shadow: "xl",
        radius: "md",
        withBorder: true,
      },
    }),

    Card: Card.extend({
      defaultProps: {
        p: "xl",
        shadow: "xl",
        radius: "var(--mantine-radius-default)",
        withBorder: true,
      },
    }),
    Select: Select.extend({
      defaultProps: {
        checkIconPosition: "right",
      },
    }),
  },
  other: {
    style: "mantine",
  },
});

/**
 * Accessible value for Mantine's low-emphasis text tokens -- `dimmed` secondary
 * text and input `placeholder` text.
 *
 * Mantine's defaults fail WCAG 2.1 AA 1.4.3 (4.5:1 for normal-weight text):
 * - `dimmed`: gray-6 (#868e96) at 3.32:1 on the white body (light), dark-2
 *   (#828282) at 4.04:1 on the dark-7 (#242424) body (dark).
 * - `placeholder`: gray-5 (#adb5bd) at 2.08:1 on the white input (light),
 *   dark-3 (#696969) at 2.47:1 on the dark-6 (#2e2e2e) input (dark) -- even
 *   lighter than `dimmed`.
 *
 * Both are global tokens, so overriding them via {@link cssVariablesResolver}
 * raises every `c="dimmed"` site (and any code reading
 * `var(--mantine-color-dimmed)` directly) and every input placeholder at once,
 * rather than editing each call site.
 *
 * The palette has no in-scale step that both clears the floor and stays clearly
 * lower-emphasis than the body text (gray-6 fails; gray-7 (#495057) overshoots
 * to 8.18:1 and reads almost as dark as the #000 body), so these are tuned
 * values. Ratios are the WCAG relative-luminance contrast, recomputed against
 * the real surfaces:
 * - light #636b73: 5.41:1 on the white body/input, 5.13:1 on the lightest
 *   card/paper surface (gray-0 #f8f9fa); 3.88:1 against the #000 body text, so
 *   it stays visibly muted.
 * - dark #92969b: 5.22:1 on the dark-7 body, 4.56:1 on the dark-6 input (the
 *   binding dark case); stays dimmer than the dark-0 (#c9c9c9) body text.
 *
 * Inputs use Mantine's default variant (light bg white, dark bg dark-6); a
 * `filled`/`unstyled` input's darker dark-5 bg would not clear 4.5:1 with this
 * value, but the app uses none.
 */
const MUTED_TEXT = {
  light: "#636b73",
  dark: "#92969b",
} as const;

/**
 * Accessible text color for the yellow "warning", red "error", and green
 * "success" Mantine `light` variant surfaces in the light scheme -- the Alert
 * title and icon, the yellow constraint-warning Badge label (the
 * StandardizationPreview violation badge), and the green satisfiability surfaces
 * (the all-keys-covered verdict Alert in AcceptorColumnsStep; the satisfiable
 * key Badges in ExpertKeyEditor). Mantine's default
 * `--mantine-color-{c}-light-color` is the color's shade 9 on its shade-1 tint,
 * which fails WCAG 2.1 AA 1.4.3 for normal-weight text:
 * - yellow-9 (#e67700) on yellow-1 (#fff3bf) = 2.69:1 -- and no yellow/orange
 *   shade clears even the 3:1 non-text floor on that tint, so the text has to
 *   leave the yellow ramp entirely.
 * - red-9 (#c92a2a) on red-1 (#ffe3e3) = 4.51:1 -- a hairline pass, fragile to a
 *   future palette nudge.
 * - green-9 (#2b8a3e) on green-1 (#d3f9d8) = 3.81:1 -- and as plain page text
 *   (the TermsImportExport import-success message, `c="green"` = green-9) =
 *   4.37:1 on the white page.
 *
 * Darkened in-hue rather than to plain black so each title still reads as
 * amber/caution, red/error, and green/success; the meaning no longer rests on
 * the title color alone, because the Alerts also carry a severity icon (WCAG
 * 1.4.1). Ratios against the real shade-1 tints:
 * - warning #92400e on yellow-1 = 6.36:1.
 * - error #a51111 on red-1 = 6.45:1.
 * - success #22683a on green-1 = 5.89:1 (and 6.75:1 as page text on white,
 *   6.41:1 on the gray-0 card -- see the success-text call site below).
 *
 * Only the light scheme is overridden -- it is where these failures are. The
 * dark scheme is left at Mantine's defaults, where the same tokens are a
 * near-white shade-0 on a dark tint (the inverse arrangement), not the dark-on-
 * light one that fails here. The light-scheme ratios above are enforced by
 * test/unit/themeContrast.test.ts.
 */
const STATUS_TEXT = {
  warning: "#92400e",
  error: "#a51111",
  success: "#22683a",
} as const;

/**
 * Accessible color for Mantine's `error` token in the light scheme -- the input
 * validation message text, the `withAsterisk` required marker, and the
 * error-state input border. Mantine's light default is red-6 (#fa5252) = 3.28:1
 * on the white page/input, which fails WCAG 2.1 AA 1.4.3 for the normal-weight
 * validation text. red-9 (#c92a2a) = 5.46:1 on white (5.18:1 on the gray-0 card)
 * clears it with margin. This differs from {@link STATUS_TEXT}.error: that sits
 * on the red-1 Alert tint, where #c92a2a is only 4.51:1, so the two error reds
 * are tuned to their different backgrounds. Enforced by
 * test/unit/themeContrast.test.ts.
 */
const ERROR_TEXT = "#c92a2a";

/**
 * Raises the `dimmed` and input `placeholder` tokens to {@link MUTED_TEXT} in
 * both color schemes, and the yellow/red/green `light`-variant text tokens to
 * {@link STATUS_TEXT} plus the `error` token to {@link ERROR_TEXT} in the light
 * scheme. Mantine deep-merges this over the default resolver, so only the
 * overridden variables need be returned. Passed to `MantineProvider` in the root
 * route.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-dimmed": MUTED_TEXT.light,
    "--mantine-color-placeholder": MUTED_TEXT.light,
    "--mantine-color-yellow-light-color": STATUS_TEXT.warning,
    "--mantine-color-red-light-color": STATUS_TEXT.error,
    "--mantine-color-green-light-color": STATUS_TEXT.success,
    "--mantine-color-error": ERROR_TEXT,
  },
  dark: {
    "--mantine-color-dimmed": MUTED_TEXT.dark,
    "--mantine-color-placeholder": MUTED_TEXT.dark,
  },
});
