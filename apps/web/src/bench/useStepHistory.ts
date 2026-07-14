import { useCallback, useEffect, useRef } from "react";

import {
  benchStepState,
  benchStepStateForPush,
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
 * A restore may be clamped: the step the entry names can require backing state
 * the bench no longer holds (its work column would render blank), so `onRestore`
 * returns the step it actually settled on. When that differs from the entry's
 * step, the hook rewrites the current entry's marker to the settled step with
 * `replaceState` -- so a later Back does not land on the same dead entry again --
 * keeping the router's index and key, since Back already moved the cursor and
 * only the bench marker is stale.
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
 *   cursor), and must validate the step against its own union, ignoring a
 *   foreign one (a stale entry from before a deploy renamed a step). Returns the
 *   step it settled on so the hook can rewrite a clamped entry; return the
 *   passed step (or nothing) when it was applied unchanged. The hook keeps a
 *   live ref to it, so an inline closure is fine.
 */
export function useStepHistory(
  initialStep: string,
  onRestore: (step: string) => string | void,
): {
  pushStep: (step: string) => void;
} {
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;
  const initialStepRef = useRef(initialStep);

  // Mark the current entry as the bench's first step. replaceState keeps the
  // router history's index and entry key untouched (replace semantics), so the
  // bench occupies exactly one entry until it pushes a step; a StrictMode
  // double-mount replays this idempotently on the same entry.
  useEffect(() => {
    window.history.replaceState(
      benchStepState(initialStepRef.current, window.history.state),
      "",
    );
  }, []);

  const pushStep = useCallback((step: string) => {
    window.history.pushState(
      benchStepStateForPush(step, window.history.state),
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
      const settled = restoreRef.current(step);
      if (settled !== undefined && settled !== step)
        window.history.replaceState(
          benchStepState(settled, window.history.state),
          "",
        );
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return { pushStep };
}
