import {
  Card,
  Container,
  Paper,
  Select,
  createTheme,
  rem,
} from "@mantine/core";

import type { CSSVariablesResolver, MantineThemeOverride } from "@mantine/core";

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
  /** Put your mantine theme override here */
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
  components: {
    /** Put your mantine component override here */
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
 * `var(--mantine-color-dimmed)` directly, e.g. the dropzone icon in FileSelect)
 * and every input placeholder at once, rather than editing each call site.
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
 * Raises the `dimmed` and input `placeholder` tokens to {@link MUTED_TEXT} in
 * both color schemes. Mantine deep-merges this over the default resolver, so
 * only the overridden variables need be returned. Passed to `MantineProvider`
 * in the root route.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-dimmed": MUTED_TEXT.light,
    "--mantine-color-placeholder": MUTED_TEXT.light,
  },
  dark: {
    "--mantine-color-dimmed": MUTED_TEXT.dark,
    "--mantine-color-placeholder": MUTED_TEXT.dark,
  },
});
