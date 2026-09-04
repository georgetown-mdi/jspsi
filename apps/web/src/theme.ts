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
 * Route a filled-primary surface's text/icon color through Mantine's
 * per-scheme `--mantine-primary-color-contrast` variable instead of the
 * static white its own varsResolver emits.
 *
 * Mantine resolves a filled theme-color surface's text color
 * color-scheme-blind: the Button/ActionIcon/Checkbox `varsResolver`s call
 * the variant resolver with no color scheme, so `autoContrast` parses the
 * primary against its LIGHT shade and picks white for BOTH schemes, leaving
 * the dark filled-primary text at 2.79:1 on the brighter cyan-6 dark fill --
 * below the 1.4.3 floor. `--mantine-primary-color-contrast` is the one
 * value Mantine computes per scheme (white on light, black on dark), so
 * routing the filled-primary text through it yields 7.53:1 in dark while
 * staying byte-identical white in light. Each component names this color
 * through a different CSS variable, hence three near-identical overrides.
 *
 * Ratios enforced by test/unit/themeContrast.test.ts; rendered colors by
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
 * A named content width in the {@link CONTAINER_SIZES} scale: the single
 * vocabulary the content-width boundary between a route and the shell
 * speaks. A route declares one of these and the shell sizes both its chrome
 * and the route's content to it, so neither side names a raw pixel width.
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
  // Honors the OS `prefers-reduced-motion` setting: Mantine skips
  // transition animations for components that read the flag (Collapse,
  // Transition, the Menu/Tooltip/Popover overlays), and arms the
  // `[data-respect-reduced-motion] [data-reduce-motion]` CSS rule for
  // components that opt in through that attribute. A disclosure using the
  // Collapse pattern keeps its toggle's aria-controls/focus target on an
  // always-mounted wrapper, never the Collapse panel itself, so a
  // reduced-motion user does not lose the target when the panel unmounts
  // (pinned by the reduced-motion render tests). Motion this flag does not
  // reach -- the hand-rolled chevron transitions, the Status progress bar's
  // `animated` stripe, and the Loader spinner -- gates on
  // useReducedMotion() directly at its own source.
  respectReducedMotion: true,
  // Per-scheme primary shade, each tuned to WCAG 2.1 AA (1.4.3 text 4.5:1,
  // 1.4.11 non-text 3:1) against its own surfaces; enforced by
  // test/unit/themeContrast.test.ts.
  //
  // Light is 9 (#0b7285): clears every primary use at 5.59:1 (white-on-fill
  // and fill-on-white). The filled hover step resolves to cyan-8 (4.35:1),
  // transient and outside the resting-state AA judgment.
  //
  // Dark is 6 (#15aabf): filled-primary text routes through
  // --mantine-primary-color-contrast (black on cyan-6, 7.53:1); the focus
  // ring and input focus border reach 5.57:1 / 4.87:1. No single shade
  // clears all three bars with plain white text, which is why the filled
  // text is routed through the contrast variable instead.
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
 * Accessible value for Mantine's low-emphasis text tokens -- `dimmed`
 * secondary text and input `placeholder` text. Mantine's defaults fail WCAG
 * 2.1 AA 1.4.3 (4.5:1 for normal-weight text) in both schemes and for both
 * tokens; no in-scale gray step both clears the floor and stays clearly
 * lower-emphasis than body text, so these are tuned values.
 *
 * Both are global tokens: overriding them via {@link cssVariablesResolver}
 * raises every `c="dimmed"` site and every input placeholder at once.
 *
 * Ratios (WCAG relative-luminance contrast, against the real surfaces):
 * - light #636b73: 5.41:1 on the white body/input, 5.13:1 on the gray-0
 *   card/paper surface.
 * - dark #92969b: 5.22:1 on the dark-7 body, 4.56:1 on the dark-6 input
 *   (the binding case).
 *
 * Inputs use Mantine's default variant (light bg white, dark bg dark-6); a
 * `filled`/`unstyled` input's darker dark-5 bg would not clear 4.5:1 with
 * this value, but the app uses none.
 */
const MUTED_TEXT = {
  light: "#636b73",
  dark: "#92969b",
} as const;

/**
 * Accessible text color for the yellow "warning", red "error", and green
 * "success" Mantine `light` variant surfaces in the light scheme -- the
 * Alert title and icon, the yellow constraint-warning Badge label, and the
 * green satisfiability surfaces (AcceptorColumnsStep, ExpertKeyEditor).
 * Mantine's default `--mantine-color-{c}-light-color` (shade 9 on shade-1
 * tint) fails WCAG 2.1 AA 1.4.3 for normal-weight text in all three hues.
 *
 * Darkened in-hue rather than to plain black so each title still displays as
 * amber/caution, red/error, and green/success; the meaning does not rest
 * on the title color alone, since the Alerts also hold a severity icon
 * (WCAG 1.4.1). Ratios against the real shade-1 tints:
 * - warning #92400e on yellow-1 = 6.36:1.
 * - error #a51111 on red-1 = 6.45:1.
 * - success #22683a on green-1 = 5.89:1 (6.75:1 as page text on white,
 *   6.41:1 on the gray-0 card).
 *
 * Only the light scheme is overridden: the dark scheme's same tokens are a
 * near-white shade-0 on a dark tint, the inverse arrangement, not the
 * dark-on-light one that fails here. Ratios enforced by
 * test/unit/themeContrast.test.ts.
 */
const STATUS_TEXT = {
  warning: "#92400e",
  error: "#a51111",
  success: "#22683a",
} as const;

/**
 * Accessible color for Mantine's `error` token in the light scheme -- the
 * input validation message text, the `withAsterisk` required marker, and
 * the error-state input border. Mantine's light default, red-6 (#fa5252) =
 * 3.28:1 on the white page/input, fails WCAG 2.1 AA 1.4.3; red-9 (#c92a2a)
 * = 5.46:1 clears it. Differs from {@link STATUS_TEXT}.error, which sits
 * on the red-1 Alert tint where #c92a2a is only 4.51:1 -- the two error
 * reds are tuned to their different backgrounds. Enforced by
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
