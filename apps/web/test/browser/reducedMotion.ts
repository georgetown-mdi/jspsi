let originalMatchMedia: typeof window.matchMedia | undefined;

/**
 * Simulates the OS prefers-reduced-motion signal the theme switch honors, by
 * replacing `window.matchMedia` with a stub answering `prefersReduced` for a
 * `prefers-reduced-motion` query and no match for anything else.
 *
 * Mantine's Collapse reads the signal through `useReducedMotion`, which
 * resolves the match in a post-mount effect rather than on the first render, so
 * a test asserting the reduced-motion code path polls for the settled state
 * instead of assuming it is immediate.
 *
 * The replacement is undone by {@link restoreMatchMedia}, which every caller
 * owes its `afterEach`: the stub is a whole-window substitution and would
 * otherwise outlive the test that wanted it.
 */
export function stubReducedMotion(prefersReduced: boolean): void {
  originalMatchMedia ??= window.matchMedia;
  window.matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? prefersReduced : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/**
 * Puts the real `window.matchMedia` back. A no-op when nothing was stubbed, so
 * it composes into an `afterEach` that runs whether or not the test stubbed.
 */
export function restoreMatchMedia(): void {
  if (originalMatchMedia === undefined) return;
  window.matchMedia = originalMatchMedia;
  originalMatchMedia = undefined;
}
