import { useEffect } from "react";

import { unloadGuardArmed } from "./stepHistory";

/**
 * Arm a browser `beforeunload` confirmation prompt while a real participant file
 * is loaded and the exchange has not been created/sent (see
 * {@link unloadGuardArmed}). It catches only the navigation paths the console's
 * History integration cannot handle gracefully -- closing the tab, reloading,
 * typing a URL, or an external link. The in-console Back/Forward that
 * {@link useStepHistory} integrates keeps the component mounted and never
 * triggers this prompt, nor does the synthetic sample (`demoActive`).
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
 * {@link useUnloadGuard} arms from the console's own loss condition; every
 * other surface that hosts a live exchange -- the managed re-run and the two
 * console seats -- arms this primitive for the run's length, since an unload
 * (a tab close, typed URL, or the app-shell's Reload button) would otherwise
 * end it for both parties unnoticed. Disarming is the effect's own cleanup.
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
