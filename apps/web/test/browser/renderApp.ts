import { createElement } from "react";

import { MantineProvider } from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";

import type { ReactElement, ReactNode } from "react";
import type { MantineProviderProps } from "@mantine/core";

/**
 * Overrides a browser test may layer onto the app provider config. Only the
 * knobs a test genuinely varies are exposed; anything else stays fixed at the
 * app root's configuration so a test cannot silently diverge from what ships.
 */
export interface RenderAppOptions {
  /**
   * Pin the rendered subtree to one color scheme, for a test asserting
   * scheme-specific behavior (e.g. the light-only resolver token overrides).
   * Left unset, the provider follows its default color-scheme resolution, as
   * the app root does.
   */
  forceColorScheme?: MantineProviderProps["forceColorScheme"];
}

/**
 * Wraps `node` in a `MantineProvider` configured exactly as the app root
 * (`routes/__root.tsx`) does -- `theme={mantineTheme}` plus
 * `cssVariablesResolver={cssVariablesResolver}`, both from `theme.ts`. A
 * component reading a resolver-overridden token (`dimmed`, `placeholder`, the
 * light-variant status text, `error`) then renders the app's real value, not
 * the Mantine default the app never ships.
 *
 * Returns the provider element rather than mounting it: the browser suite owns
 * its own `createRoot`/`render` lifecycle (and some tests re-render the same
 * root), so this composes into that idiom.
 */
export function renderApp(
  node: ReactNode,
  options: RenderAppOptions = {},
): ReactElement {
  return createElement(
    MantineProvider,
    {
      theme: mantineTheme,
      cssVariablesResolver,
      ...(options.forceColorScheme !== undefined
        ? { forceColorScheme: options.forceColorScheme }
        : {}),
    },
    node,
  );
}
