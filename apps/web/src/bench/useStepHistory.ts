import { useCallback, useEffect, useRef } from "react";

import {
  benchStepState,
  depthFromState,
  stepFromPopState,
} from "./stepHistory";

/**
 * Wire a bench's internal step state to the browser History stack so Back and
 * Forward walk the steps in place instead of leaving the route. It does not own
 * the step -- the component keeps its `useState` -- but it pushes a marked
 * history entry on each forward move and, on a `popstate`, hands the caller the
 * step the target entry carries so the component can restore it without
 * remounting or losing the loaded file.
 *
 * Returns `pushStep`: call it whenever the bench moves to a new step (the same
 * places that already call the component's `setSection`/`setStep`). It pushes a
 * history entry for the new step; the component still sets its own state as
 * before. A `popstate` that lands on a bench entry calls `onRestore` with that
 * step; a `popstate` that leaves the bench (Back from the first step, an
 * unrelated route) is left to proceed as ordinary navigation.
 *
 * On mount the hook marks the current history entry as the bench's FIRST step
 * (via `replaceState`, so it adds no entry). That baseline is what makes Back
 * from a later step land on the first step in place, while Back from the first
 * step falls through to the genuinely pre-bench entry and leaves the route as
 * ordinary navigation.
 *
 * @param initialStep - the step the bench mounts on, seeded into the current
 *   history entry so Back can restore it.
 * @param onRestore - applies a step arriving from Back/Forward; must set the
 *   step state WITHOUT pushing a new entry (the browser already moved the
 *   cursor). The hook keeps a live ref to it, so an inline closure is fine.
 */
export function useStepHistory(
  initialStep: string,
  onRestore: (step: string) => void,
): {
  pushStep: (step: string) => void;
} {
  // The bench's current depth in its own step stack. The first step sits at
  // depth 0 (seeded below), so the first pushed step is depth 1. Kept in a ref
  // so the popstate listener, registered once, always reads the live value.
  const depthRef = useRef(0);
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;
  const initialStepRef = useRef(initialStep);

  // On mount, mark the current entry as the bench's first step (depth 0) so
  // Back from a later step restores it, while Back from the first step falls
  // through to the pre-bench entry and leaves the route. replaceState adds no
  // entry, so the bench occupies exactly one entry until it pushes a step; a
  // StrictMode double-mount replays this idempotently on the same entry.
  useEffect(() => {
    depthRef.current = 0;
    window.history.replaceState(
      benchStepState(initialStepRef.current, 0, window.history.state),
      "",
    );
  }, []);

  const pushStep = useCallback((step: string) => {
    const nextDepth = depthRef.current + 1;
    depthRef.current = nextDepth;
    window.history.pushState(
      benchStepState(step, nextDepth, window.history.state),
      "",
    );
  }, []);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      const step = stepFromPopState(event.state);
      // Not a bench entry: Back/Forward left the bench (the pre-first-step entry
      // or an unrelated route). Let the browser navigate normally -- nothing to
      // restore, and the component unmounts as it always did.
      if (step === undefined) return;
      const depth = depthFromState(event.state);
      if (depth !== undefined) depthRef.current = depth;
      restoreRef.current(step);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return { pushStep };
}
