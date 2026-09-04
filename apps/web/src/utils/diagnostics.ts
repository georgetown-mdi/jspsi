/**
 * The localStorage key a tester or support engineer sets to opt a single browser
 * into diagnostic logging against a deployed client. Set it from the devtools
 * console (`localStorage.setItem("psilink:diagnostics", "1")`), reload, and
 * reproduce; clear it (`localStorage.removeItem("psilink:diagnostics")`) to
 * return to the secure default. Namespaced so it cannot collide with another
 * app's key on a shared origin.
 */
export const DIAGNOSTICS_STORAGE_KEY = "psilink:diagnostics";

/**
 * Whether the stored flag value engages diagnostic mode. Any value other than
 * the explicit off-values counts as on, so a tester who types `"1"`, `"true"`,
 * or `"on"` all work; `null` (unset), `""`, `"0"`, and `"false"` stay off.
 *
 * @internal exported for unit tests; production code calls {@link isDiagnosticMode}.
 */
export function isDiagnosticsFlagValue(raw: string | null): boolean {
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "off";
}

/**
 * Gates raised-verbosity logging across the web app: a development build, or a
 * deployed client whose operator set {@link DIAGNOSTICS_STORAGE_KEY}. Every
 * diagnostic-only sink reads verbosity through this one predicate.
 *
 * localStorage access is wrapped: it throws when storage is disabled
 * (private-browsing quotas, blocked third-party storage) and is absent during
 * SSR; both resolve to the secure-by-default off.
 */
export function isDiagnosticMode(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return isDiagnosticsFlagValue(
      globalThis.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY),
    );
  } catch {
    // Absent during SSR and throws when storage is blocked; either way, off.
    return false;
  }
}

/**
 * Runs `emit` only under {@link isDiagnosticMode}. The one gate for a
 * console/devtools sink that would otherwise put raw partner-/server-influenced
 * bytes (a hostile message/cause, a partner-supplied endpoint host) into a
 * production browser console.
 *
 * Pass a closure, not a pre-stringified value, so devtools keeps the live
 * `Error` object (expandable stack, `.cause`) and the message is never built
 * outside diagnostic mode.
 */
export function whenDiagnostic(emit: () => void): void {
  if (isDiagnosticMode()) emit();
}
