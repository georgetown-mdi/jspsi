/**
 * The pure model behind the bench's Back/Forward integration: the shape of the
 * `history.state` entry each in-bench step writes, how a `popstate` event maps
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
 *
 * The bench's entries sit in the same stack as TanStack Router's: the app
 * router's history (`createBrowserHistory` from `@tanstack/history`, re-exported
 * by `@tanstack/react-router`) patches `window.history` and classifies a
 * `popstate` as Back or Forward from the delta in `state.__TSR_index`, keying
 * scroll restoration on `__TSR_key`/`key`. A bench push therefore advances that
 * index and mints a fresh key -- the same bookkeeping the router applies to its
 * own pushes -- or the router would misread every in-bench Back/Forward as an
 * in-place GO and share one scroll slot across all bench steps. Pinned against
 * the real patched history in `benchRouterHistory.test.ts`.
 */

/** Marks a `history.state` entry as one the bench wrote, carrying the step name
 * (an opaque string -- the caller's step union), so a `popstate` into an entry
 * the bench did not create (an unrelated app route, or the pre-bench entry Back
 * from the first step lands on) is distinguishable from an in-bench step move. */
export const BENCH_STEP_STATE_KEY = "psilinkBenchStep";

/** The router history's entry-index field (see the module header). */
const ROUTER_INDEX_KEY = "__TSR_index";

/** The `history.state` payload an in-bench step writes. */
export interface BenchStepState {
  [BENCH_STEP_STATE_KEY]: string;
}

function markedState(step: string, existing: unknown): Record<string, unknown> {
  const base =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, [BENCH_STEP_STATE_KEY]: step };
}

/** Build the `history.state` payload for `step`, merging over any existing state
 * so an unrelated entry's fields (including the router's) survive unchanged --
 * the replace form: the router's index and entry key are kept as-is, matching
 * replace semantics. */
export function benchStepState(
  step: string,
  existing?: unknown,
): BenchStepState {
  return markedState(step, existing) as unknown as BenchStepState;
}

/** Build the `history.state` payload for pushing `step` as a NEW entry: the
 * merged marker state with the router's index advanced by one and a fresh entry
 * key minted -- the router's own push bookkeeping (see the module header). When
 * no router index is present (no router history is attached, as in the bare
 * component tests), the marker state alone is returned. */
export function benchStepStateForPush(
  step: string,
  existing?: unknown,
): BenchStepState {
  const merged = markedState(step, existing);
  const index = merged[ROUTER_INDEX_KEY];
  if (typeof index !== "number") return merged as unknown as BenchStepState;
  const freshKey = (Math.random() + 1).toString(36).substring(7);
  return {
    ...merged,
    [ROUTER_INDEX_KEY]: index + 1,
    __TSR_key: freshKey,
    key: freshKey,
  } as unknown as BenchStepState;
}

/** Read the bench step a `popstate` event's `state` carries, or `undefined` when
 * the entry is not a bench entry -- the signal that Back/Forward left the bench
 * (an unrelated route, or the entry preceding the bench's first step) and the
 * caller must let ordinary browser navigation proceed. */
export function stepFromPopState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const step = (state as Record<string, unknown>)[BENCH_STEP_STATE_KEY];
  return typeof step === "string" ? step : undefined;
}

/**
 * Whether the browser unload guard (`beforeunload`) should be armed: while a REAL
 * participant file is loaded AND the exchange has not yet been finalized. The
 * in-bench Back/Forward this model integrates keeps the component mounted, so the
 * guard exists only to catch the navigation paths History integration cannot handle
 * gracefully -- closing the tab, reloading, typing a URL, or following an external
 * link -- before the loaded file and in-progress terms are lost.
 *
 * `finalized` covers the point of no data loss: once the invitation is minted (a
 * browser run is listening, or the appliance is running a server-job exchange the
 * recovery panel can re-attach to) or the exchange file is saved, leaving costs
 * nothing the operator has not already secured, so the guard disarms. A console
 * server-job run is deliberately NOT re-armed after finalization: leaving the page
 * does not abandon it (the recovery panel re-attaches), so a prompt would assert a
 * loss that does not happen.
 *
 * `demoActive` disarms it regardless: the loaded file is the synthetic sample
 * (pristine or with edited terms), which the visitor did not bring and nothing regrets
 * losing. A real file replacing the sample clears `demoActive`, re-arming the guard.
 */
export function unloadGuardArmed({
  hasFile,
  finalized,
  demoActive = false,
}: {
  hasFile: boolean;
  finalized: boolean;
  demoActive?: boolean;
}): boolean {
  return hasFile && !demoActive && !finalized;
}
