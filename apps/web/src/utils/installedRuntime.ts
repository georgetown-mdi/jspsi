/**
 * Whether this page is running as an INSTALLED app rather than an ordinary
 * browser tab.
 *
 * Two things read it and must agree: the app-shell registration, which asks an
 * installed app's worker to cache every route's code, and the unattended
 * scheduled runner, which runs only in an installed runtime -- the platform
 * envelope in docs/MANAGED_EXCHANGE.md ("The automation goal and its platform
 * envelope"). An installed copy is launched at OS login and stays open; an
 * ordinary tab is opened and closed around whatever the operator came to do, so
 * a runner firing there would start an exchange under a page the operator is
 * about to navigate away from.
 *
 * The manifest declares `standalone` display, and the media query is what the
 * platform answers with once the app is launched from its installed entry. It is
 * read as a plain query rather than watched: a tab does not become an installed
 * runtime while it is open, and an installed window does not stop being one.
 *
 * Safe under SSR and on an engine without `matchMedia`, where it reports `false`
 * -- the conservative direction for both readers.
 */
export function isInstalledRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  );
}
