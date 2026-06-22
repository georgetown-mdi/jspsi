import type { ContainerWidth } from "@theme";

/**
 * The content-width seam between a route and the application shell.
 *
 * A route declares the width its content column wants once, in its
 * `staticData.contentWidth`; the shell reads that one value (via
 * {@link resolveContentWidth}) and sizes its single content container to it, so the
 * route renders at the width it asked for. This replaces each route choosing a
 * `Container size` of its own, decoupling the width a route wants from how the
 * shell lays it out. (The seam predates removing the banner/header, which the
 * shell used to size to this same value so its edge aligned with the content;
 * the shell is now a bare `<main>` + container, so the one width sizes only it.)
 */
// Augment the module that DECLARES StaticDataRouteOption (router-core), not the
// one that merely re-exports it (react-router). Augmenting the re-export happens
// to merge today, but the base interface is empty, so if a future version
// stopped re-exporting it the augmentation would silently become a no-op a green
// typecheck would not catch; merging into the declaring module is robust to that.
declare module "@tanstack/router-core" {
  interface StaticDataRouteOption {
    /** The named content width this route renders at; the shell sizes its content
     * container to match. Omit to inherit {@link DEFAULT_CONTENT_WIDTH}. */
    contentWidth?: ContainerWidth;
  }
}

/**
 * The width the shell uses for a route that declares none -- the wide default the
 * home route sits at.
 */
export const DEFAULT_CONTENT_WIDTH: ContainerWidth = "xl";

/**
 * The reading-column width the exchange/terms screens self-constrain to, narrower
 * than their route's wide container.
 *
 * The inviter's post-generate panel and the acceptor's review and exchange screens
 * are a single vertical column of short-measure text -- the share block, the nested
 * linkage-terms list, the centered status -- not a wide table. Filling a 1400/1600px
 * route container stretches that prose to an unreadable measure, so these screens
 * opt out of the route width and cap themselves here instead: held at a 40rem
 * min-width so the panel never shrinks to a cramped column on a mid-size window,
 * growing with the viewport (80vw), and capped at a 60rem reading measure. The
 * min-width is itself guarded by `min(40rem, 100%)`, so on a viewport narrower than
 * 40rem the column falls back to the full width rather than overflowing into a
 * horizontal scroll.
 *
 * Applied as a CSS `width` with `marginInline: auto`, so the column centers within
 * the route's wider content container (see {@link resolveContentWidth}) rather than
 * filling it -- an intentional centered reading area, the way the shell already
 * centers a capped container in a wider viewport. On the home route it sits below
 * the full-width page heading, which keeps the route width. The acceptor's "Prepare
 * your data" editor likewise keeps the full route width -- it is a genuine two-column
 * editor, not a reading column -- so the constraint is phase-scoped, not route-wide.
 */
export const EXCHANGE_READING_WIDTH = "clamp(min(40rem, 100%), 80vw, 60rem)";

/**
 * Resolve the content width for the active route from its match chain: the
 * deepest match that declares a `contentWidth` wins, so a leaf route narrows the
 * content column, falling back to {@link DEFAULT_CONTENT_WIDTH} when no match
 * declares one. Pure over the matches so the shell and its test both drive it the
 * same way.
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
