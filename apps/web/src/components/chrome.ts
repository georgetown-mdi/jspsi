/**
 * The chrome seam between a route and the root layout, parallel to the
 * content-width seam in `contentWidth.ts`: a route (or a layout route above
 * it) declares which application chrome it renders inside, and the root
 * component reads that one value to decide whether to wrap the outlet in the
 * legacy `Shell` or hand the whole viewport to the bench, which brings its own
 * landmarks and page surface.
 */

/**
 * The application chromes a route can declare. `legacy` is the current app's
 * `Shell` (a bare `<main>` + sized container); `bench` is the linkage bench
 * redesign, which renders its own page surface and landmarks and must not be
 * nested inside another `<main>`.
 */
export type RouteChrome = "legacy" | "bench";

// Augment the module that DECLARES StaticDataRouteOption, not the re-export --
// same reasoning as the contentWidth augmentation alongside this file.
declare module "@tanstack/router-core" {
  interface StaticDataRouteOption {
    /** The chrome this route renders inside. Omit to inherit
     * {@link DEFAULT_CHROME}. */
    chrome?: RouteChrome;
  }
}

/** The chrome for routes that declare none: the legacy shell. */
export const DEFAULT_CHROME: RouteChrome = "legacy";

/**
 * Resolve the active route's chrome from its match chain: the deepest match
 * that declares one wins, so the `/bench` layout route opts its whole subtree
 * out of the legacy shell in one place. Pure over the matches so the root and
 * its test both drive it the same way.
 */
export function resolveChrome(
  matches: ReadonlyArray<{ staticData?: { chrome?: RouteChrome } }>,
): RouteChrome {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const chrome = matches[i]?.staticData?.chrome;
    if (chrome !== undefined) return chrome;
  }
  return DEFAULT_CHROME;
}
