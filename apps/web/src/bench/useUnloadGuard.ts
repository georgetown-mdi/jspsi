import { useEffect } from "react";

import { unloadGuardArmed } from "./stepHistory";

/**
 * Arm a browser `beforeunload` confirmation prompt while a real participant file
 * is loaded and the exchange has not been created/sent (see
 * {@link unloadGuardArmed}). It catches only the navigation paths the bench's
 * History integration cannot handle gracefully -- closing the tab, reloading,
 * typing a URL, or following an external link -- so an operator does not lose a
 * loaded file and in-progress terms to an off-hand navigation. The in-bench
 * Back/Forward that {@link useStepHistory} integrates keeps the component mounted
 * and never triggers this prompt. The synthetic sample never arms it
 * (`demoActive`), since nothing is lost by leaving it.
 */
export function useUnloadGuard({
  hasFile,
  finalized,
  demoActive = false,
}: {
  hasFile: boolean;
  finalized: boolean;
  demoActive?: boolean;
}): void {
  const armed = unloadGuardArmed({ hasFile, finalized, demoActive });
  useEffect(() => {
    if (!armed) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      // preventDefault + a non-empty returnValue is the cross-browser contract
      // that triggers the native "leave this page?" prompt; the browser shows
      // its own generic copy, never this string.
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [armed]);
}
