let originalMatchMedia: typeof window.matchMedia | undefined;

/**
 * Simulates the OS prefers-reduced-motion signal the theme switch honors, by
 * replacing `window.matchMedia` with a stub answering `prefersReduced` for a
 * `prefers-reduced-motion` query and no match for anything else.
 *
 * Mantine's Collapse resolves `useReducedMotion` in a post-mount effect, so a
 * test polls for the final state rather than assuming it is immediate. Undo the
 * whole-window substitution with {@link restoreMatchMedia} in every `afterEach`.
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
