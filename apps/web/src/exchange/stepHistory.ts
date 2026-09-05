/**
 * The pure model behind the console's Back/Forward integration: the shape of
 * the `history.state` entry each in-console step writes, how a `popstate`
 * event maps back to a step, and the predicate that arms the unload guard. No
 * React and no `window`.
 *
 * The step lives in the session's History stack, never on disk or in the URL.
 * The participant file stays memory-only across these transitions: the
 * console component never unmounts, so its React state (the loaded file, the
 * terms, in-progress edits) survives untouched. The runtime invariant -- no
 * file contents written to IndexedDB, localStorage, or disk during navigation
 * -- is pinned as a browser test, not asserted here.
 *
 * The console's entries sit in the same stack as TanStack Router's: the app
 * router's history (`createBrowserHistory` from `@tanstack/history`,
 * re-exported by `@tanstack/react-router`) patches `window.history` and
 * classifies a `popstate` as Back or Forward from the delta in
 * `state.__TSR_index`, keying scroll restoration on `__TSR_key`/`key`. A
 * console push advances that index and mints a fresh key, matching the
 * router's own push bookkeeping. Pinned against the real patched history in
 * `routerHistory.test.ts`.
 */

/** Marks a `history.state` entry as one the console wrote, containing the step
 * name (an opaque string -- the caller's step union), so a `popstate` into an
 * entry the console did not create (an unrelated app route, or the
 * pre-console entry Back from the first step lands on) is distinguishable
 * from an in-console step move. */
export const STEP_STATE_KEY = "psilinkExchangeStep";

/** The router history's entry-index field (see the module header). */
const ROUTER_INDEX_KEY = "__TSR_index";

/** The `history.state` payload an in-console step writes. */
export interface StepHistoryState {
  [STEP_STATE_KEY]: string;
}

function markedState(step: string, existing: unknown): Record<string, unknown> {
  const base =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, [STEP_STATE_KEY]: step };
}

/** Build the `history.state` payload for `step`, merging over any existing state
 * so an unrelated entry's fields (including the router's) survive unchanged --
 * the replace form: the router's index and entry key are kept as-is, matching
 * replace semantics. */
export function stepHistoryState(
  step: string,
  existing?: unknown,
): StepHistoryState {
  return markedState(step, existing) as unknown as StepHistoryState;
}

/** Build the `history.state` payload for pushing `step` as a NEW entry: the
 * merged marker state with the router's index advanced by one and a fresh entry
 * key minted -- the router's own push bookkeeping (see the module header). When
 * no router index is present (no router history is attached, as in the bare
 * component tests), the marker state alone is returned. */
export function stepHistoryStateForPush(
  step: string,
  existing?: unknown,
): StepHistoryState {
  const merged = markedState(step, existing);
  const index = merged[ROUTER_INDEX_KEY];
  if (typeof index !== "number") return merged as unknown as StepHistoryState;
  const freshKey = (Math.random() + 1).toString(36).substring(7);
  return {
    ...merged,
    [ROUTER_INDEX_KEY]: index + 1,
    __TSR_key: freshKey,
    key: freshKey,
  } as unknown as StepHistoryState;
}

/** Read the console step a `popstate` event's `state` contains, or `undefined`
 * when the entry is not a console entry -- the signal that Back/Forward left
 * the console (an unrelated route, or the entry preceding the console's
 * first step) and the caller must let ordinary browser navigation proceed. */
export function stepFromPopState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const step = (state as Record<string, unknown>)[STEP_STATE_KEY];
  return typeof step === "string" ? step : undefined;
}

/**
 * Whether the `beforeunload` guard should be armed: a real file is loaded, it
 * is not the synthetic demo sample (`demoActive`), and the exchange is not
 * yet `finalized` (invitation minted, or exchange file saved). The live
 * browser run a mint starts is guarded separately
 * ({@link useBeforeUnloadPrompt}); a console server-job run needs none -- the
 * recovery panel re-attaches.
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
