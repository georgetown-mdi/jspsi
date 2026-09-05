import { useMediaQuery } from "@mantine/hooks";

/**
 * The width at or below which the console switches to its narrow layout: the
 * top-bar stepper compresses to a step strip, the standing ledger folds to a
 * collapsible "What you will share" bar as the page's first interactive element,
 * and the Customize surfaces fold behind their own disclosure. Above it the wide
 * work/ledger layout applies.
 *
 * The media query and the {@link useNarrowViewport} hook that drive the two
 * presentations both read this one value, so the CSS styling and the DOM-order
 * switch cannot disagree about where the cut-over is.
 */
const NARROW_VIEWPORT_MAX_WIDTH = 600;

/** The `max-width` media query for {@link NARROW_VIEWPORT_MAX_WIDTH}. */
const NARROW_VIEWPORT_MEDIA_QUERY = `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH}px)`;

/**
 * Whether the console is at or below {@link NARROW_VIEWPORT_MAX_WIDTH}. Reads the
 * real viewport on the first render (`getInitialValueInEffect: false`), which
 * the console routes can do because they render client-only -- so the narrow
 * layout paints without a wide-layout flash rather than correcting itself
 * after an effect.
 */
export function useNarrowViewport(): boolean {
  return useMediaQuery(NARROW_VIEWPORT_MEDIA_QUERY, false, {
    getInitialValueInEffect: false,
  });
}
