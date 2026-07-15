import { useMediaQuery } from "@mantine/hooks";

/**
 * The width at or below which the bench switches to its narrow-viewport
 * information architecture: the top-bar stepper compresses to a step strip,
 * the standing ledger folds to a collapsible "What you will share" bar pinned
 * as the page's first interactive element, and the Customize surfaces fold
 * behind their own disclosure. Above it the wide work/ledger layout holds.
 *
 * The media query and the {@link useNarrowBench} hook that drive the two
 * presentations both read this one value, so the CSS styling and the DOM-order
 * switch cannot disagree about where the cut-over is.
 */
export const NARROW_BENCH_MAX_WIDTH = 600;

/** The `max-width` media query for {@link NARROW_BENCH_MAX_WIDTH}. */
export const NARROW_BENCH_MEDIA_QUERY = `(max-width: ${NARROW_BENCH_MAX_WIDTH}px)`;

/**
 * Whether the bench is at or below {@link NARROW_BENCH_MAX_WIDTH}. Reads the
 * real viewport on the first render (`getInitialValueInEffect: false`), which
 * the bench routes can do because they render client-only -- so the narrow IA
 * paints without a wide-layout flash rather than settling after an effect.
 */
export function useNarrowBench(): boolean {
  return useMediaQuery(NARROW_BENCH_MEDIA_QUERY, false, {
    getInitialValueInEffect: false,
  });
}
