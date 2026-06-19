import type { ContainerWidth } from "@theme";

/**
 * The content-width seam between a route and the application shell.
 *
 * A route declares the width its content column wants once, in its
 * `staticData.contentWidth`; the shell reads that one value (via
 * {@link resolveContentWidth}) and sizes both its chrome -- the header, and any
 * navigation/breadcrumbs the IA restructure adds -- and the route's content to
 * it, so their left/right edges align regardless of which width the route picks.
 * This replaces each route choosing a `Container size` independently of the
 * shell's, which left the chrome and a narrower route's content misaligned.
 */
// Augment the module that DECLARES StaticDataRouteOption (router-core), not the
// one that merely re-exports it (react-router). Augmenting the re-export happens
// to merge today, but the base interface is empty, so if a future version
// stopped re-exporting it the augmentation would silently become a no-op a green
// typecheck would not catch; merging into the declaring module is robust to that.
declare module "@tanstack/router-core" {
  interface StaticDataRouteOption {
    /** The named content width this route renders at; the shell sizes its
     * chrome to match. Omit to inherit {@link DEFAULT_CONTENT_WIDTH}. */
    contentWidth?: ContainerWidth;
  }
}

/**
 * The width the shell uses for a route that declares none -- the wide default
 * the home route sits at and the bare wordmark falls back to.
 */
export const DEFAULT_CONTENT_WIDTH: ContainerWidth = "xl";

/**
 * Resolve the content width for the active route from its match chain: the
 * deepest match that declares a `contentWidth` wins, so a leaf route narrows the
 * chrome to its column, falling back to {@link DEFAULT_CONTENT_WIDTH} when no
 * match declares one. Pure over the matches so the shell and its test both drive
 * it the same way.
 */
export function resolveContentWidth(
  matches: ReadonlyArray<{ staticData?: { contentWidth?: ContainerWidth } }>,
): ContainerWidth {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const width = matches[i]?.staticData?.contentWidth;
    if (width !== undefined) return width;
  }
  return DEFAULT_CONTENT_WIDTH;
}
