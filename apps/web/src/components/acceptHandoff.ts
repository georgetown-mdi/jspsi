/**
 * In-memory hand-off of the data file the acceptor chose on the home page to the
 * `/accept` consent screen across a client-side navigation.
 *
 * The home page's shared file drop feeds both compose paths: for an invitation it
 * is required, but for accepting one it is optional -- "Review invitation" works
 * without it. When the acceptor did drop a file, we carry it here so the consent
 * screen's dropzone opens pre-filled rather than asking for the same file twice.
 *
 * Like {@link AdvancedHandoff}, a browser `File` is a lazy handle to bytes on disk,
 * not the bytes themselves, and it is not serializable, so it cannot ride the URL
 * (the token already occupies the fragment) or the router's location state; it is
 * stashed here and read on arrival.
 *
 * Crucially, carrying the file does NOT pre-empt the consent gate: only a `File`
 * handle is stashed, never parsed. The accept screen seeds its dropzone selection
 * from it, but the parse still happens on the gated "Accept and continue" action,
 * behind {@link commitAcceptance} (consent + name) -- exactly as it does for a file
 * dropped on the accept screen itself.
 *
 * Client-only by construction: the sole writer is the home page's "Review
 * invitation" submit (a browser event) and the sole reader is the `/accept` route
 * (`ssr: false`), so this module-level value must never be touched during server
 * rendering, where it would leak across requests -- `assertClient` (below) enforces
 * that rather than leaving it to this comment. It is overwritten (or cleared) on
 * every "Review invitation" submit, so it always reflects the latest one, and the
 * `/accept` route clears it once it has read the file into its own state -- so a
 * back/forward navigation that returns to `/accept` without a fresh submit finds
 * nothing stashed and falls back to its own picker rather than re-seeding from a
 * stale file. A full page load likewise reinitializes it to `undefined` (the
 * browser cannot regain access to a previously chosen local file).
 */
let pending: File | undefined;

/** Fail loudly if the hand-off is touched outside the browser. The store is
 * client-only by design -- the writer is a click handler and the reader sits
 * behind the `/accept` route's `ssr: false` -- and that is load-bearing for
 * confidentiality: module-level state on the server is shared across every
 * request, so a server-side read or write would leak one user's file selection to
 * another. This turns a future regression (a render-time read on an SSR'd route,
 * or dropping `ssr: false`) into an immediate error rather than a silent
 * cross-request leak, per the repo convention of encoding a "does not happen at
 * runtime" claim as a check rather than a comment. Mirrors advancedHandoff. */
function assertClient(): void {
  if (typeof window === "undefined")
    throw new Error(
      "acceptHandoff is client-only: it must never be read or written during " +
        "server rendering, where module state is shared across requests.",
    );
}

/** Stash the acceptor's home-page file selection, to be read by the `/accept`
 * route after navigation. */
export function stashAcceptHandoff(file: File): void {
  assertClient();
  pending = file;
}

/** Clear any stashed selection -- used when the acceptor submits "Review
 * invitation" without a file chosen, so a stale earlier selection is not
 * resurrected on the accept screen. */
export function clearAcceptHandoff(): void {
  assertClient();
  pending = undefined;
}

/** Read the stashed selection without clearing it. Pure (no mutation), so it is
 * safe to call from a render-time state initializer (including React StrictMode's
 * double invoke); the "Review invitation" submit is the only mutator. */
export function peekAcceptHandoff(): File | undefined {
  assertClient();
  return pending;
}
