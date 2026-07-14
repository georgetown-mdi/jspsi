/**
 * The pure model behind the bench's Back/Forward integration: the shape of the
 * `history.state` entry each in-bench step pushes, how a `popstate` event maps
 * back to a step, and the predicate that arms the unload guard. No React and no
 * `window` -- the tested boundary for "Back moves the step backward", "Forward
 * moves it forward", and "the guard is armed exactly while a file is loaded and
 * the exchange is not yet created or sent".
 *
 * The step lives in the session's History stack, never on disk or in the URL:
 * each forward step pushes a marked entry carrying the step name, so the browser
 * Back/Forward buttons walk the stack the bench already tracks internally instead
 * of leaving the route. The participant file stays memory-only across every one
 * of these transitions -- the bench component never unmounts, so its React state
 * (the loaded file, the terms, in-progress edits) survives untouched. The
 * corresponding runtime invariant -- no file contents written to IndexedDB,
 * localStorage, or disk during navigation -- is pinned as a browser test, not
 * asserted here.
 */

/** Marks a `history.state` entry as one the bench pushed, so a `popstate` into
 * an entry the bench did not create (an unrelated app route, or the pre-bench
 * entry Back from the first step lands on) is distinguishable from an in-bench
 * step move. */
export const BENCH_STEP_STATE_KEY = "psilinkBenchStep";

/** The `history.state` payload a single in-bench step pushes: the marker key
 * carries the step name (an opaque string -- the caller's step union), and the
 * depth pins the entry's position in the bench's step stack so a `popstate`
 * cannot be mistaken for a same-named entry at another depth. */
export interface BenchStepState {
  [BENCH_STEP_STATE_KEY]: { step: string; depth: number };
}

/** Build the `history.state` payload for `step` at stack position `depth`,
 * merging over any existing state so an unrelated entry's fields survive. */
export function benchStepState(
  step: string,
  depth: number,
  existing?: unknown,
): BenchStepState {
  const base =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, [BENCH_STEP_STATE_KEY]: { step, depth } };
}

/** Read the bench step a `popstate` event's `state` carries, or `undefined` when
 * the entry is not a bench entry -- the signal that Back/Forward left the bench
 * (an unrelated route, or the entry preceding the bench's first step) and the
 * caller must let ordinary browser navigation proceed. */
export function stepFromPopState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const marker = (state as Record<string, unknown>)[BENCH_STEP_STATE_KEY];
  if (typeof marker !== "object" || marker === null) return undefined;
  const step = (marker as Record<string, unknown>).step;
  return typeof step === "string" ? step : undefined;
}

/** Read the stack depth a bench `history.state` entry carries, or `undefined`
 * when the entry is not a bench entry. Lets the caller tell a Back (smaller
 * depth) from a Forward (larger depth) without tracking its own cursor. */
export function depthFromState(state: unknown): number | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const marker = (state as Record<string, unknown>)[BENCH_STEP_STATE_KEY];
  if (typeof marker !== "object" || marker === null) return undefined;
  const depth = (marker as Record<string, unknown>).depth;
  return typeof depth === "number" ? depth : undefined;
}

/**
 * Whether the browser unload guard (`beforeunload`) should be armed: exactly
 * while a participant file is loaded AND the exchange has not yet been finalized
 * (created and listening, or its exchange file saved/sent). The in-bench
 * Back/Forward this model integrates keeps the component mounted, so the guard
 * exists only to catch the navigation paths History integration cannot handle
 * gracefully -- closing the tab, reloading, typing a URL, or following an
 * external link -- before the loaded file and in-progress terms would be lost.
 *
 * `finalized` covers every state past the point of no data loss: once the
 * invitation is minted (the live run is listening) or the exchange file is
 * saved, leaving costs nothing the operator has not already secured, so the
 * guard disarms.
 */
export function unloadGuardArmed({
  hasFile,
  finalized,
}: {
  hasFile: boolean;
  finalized: boolean;
}): boolean {
  return hasFile && !finalized;
}
