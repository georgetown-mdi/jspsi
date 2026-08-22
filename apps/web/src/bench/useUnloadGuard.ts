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
  useBeforeUnloadPrompt(unloadGuardArmed({ hasFile, finalized, demoActive }));
}

/**
 * Ask the browser to confirm before it unloads the page, while `armed`.
 *
 * The primitive {@link useUnloadGuard} arms from the bench's own loss condition,
 * exposed on its own for a surface whose loss condition is a different one: the
 * managed re-run arms it for the length of a run, which an unload -- a tab
 * close, a typed URL, or the app-shell update's Reload button, which renders
 * above every route -- would otherwise end with nothing intercepting it.
 * Disarming is the effect's own cleanup, so a finished run or an unmount leaves
 * no listener behind.
 */
export function useBeforeUnloadPrompt(armed: boolean): void {
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
