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
 * The shared predicate that gates raised-verbosity logging across the web app: a
 * development build, or a deployed client whose operator set
 * {@link DIAGNOSTICS_STORAGE_KEY}. A single source of truth so the PeerJS
 * verbosity toggle and any other diagnostic-only sink agree on when verbosity is
 * raised, rather than each re-deriving "are we diagnosing?" differently.
 *
 * Reading localStorage is wrapped because it throws when storage is disabled
 * (private-browsing quotas, blocked third-party storage) and is absent during
 * SSR; either case resolves to the secure-by-default off.
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
 * Run `emit` only under {@link isDiagnosticMode}: a development build, or a
 * deployed client whose operator set {@link DIAGNOSTICS_STORAGE_KEY}. The single
 * seam for a console/devtools sink that would otherwise put raw
 * partner-/server-influenced bytes (a hostile message/cause in a transport
 * error, a partner-supplied endpoint host) into a production browser console --
 * routing every such sink through here keeps the dev-gating a uniform policy
 * rather than a per-line guard, so a future raw sink follows it by being wrapped
 * the same way.
 *
 * Pass a closure that performs the raw log, not a pre-stringified value, so the
 * devtools affordance is preserved: `whenDiagnostic(() => console.error(err))`
 * logs the live `Error` object (expandable stack and `.cause` chain) when
 * diagnosing, and never even constructs the message in an ordinary production
 * session.
 */
export function whenDiagnostic(emit: () => void): void {
  if (isDiagnosticMode()) emit();
}
