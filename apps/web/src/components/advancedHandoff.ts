/**
 * In-memory hand-off of the inviter's compose-screen selections (their chosen CSV
 * and the name they typed) to the Advanced-options editor across a client-side
 * navigation.
 *
 * A browser `File` is a lazy handle to bytes on disk, not the bytes themselves --
 * holding it costs a reference, not the file's size, and nothing is read until a
 * parser touches it. But it is not serializable, so it cannot ride the URL or the
 * router's location state; it is stashed here instead and read on arrival.
 *
 * Client-only by construction: the sole writer is the compose screen's
 * "Advanced options" click (a browser event) and the sole reader is the
 * `/advanced` route (`ssr: false`), so this module-level value must never be
 * touched during server rendering, where it would leak across requests --
 * `assertClient` (below) enforces that rather than leaving it to this comment. It
 * is overwritten (or
 * cleared) on every Advanced click, so it always reflects the latest one, and the
 * `/advanced` route clears it once it has read the file into its own state -- so a
 * back/forward navigation that returns to `/advanced` without a fresh click finds
 * nothing stashed and falls back to the picker rather than re-seeding from a stale
 * file. A full page load likewise reinitializes it to `undefined` (the browser
 * cannot regain access to a previously chosen local file), so the route falls back
 * to its own file picker.
 */
export interface AdvancedHandoff {
  /** The CSV the inviter chose on the compose screen (a lazy handle, not bytes). */
  file: File;
  /** The name the inviter typed on the compose screen, prefilled into the editor's
   * identity field; may be empty. */
  name: string;
}

let pending: AdvancedHandoff | undefined;

/** Fail loudly if the hand-off is touched outside the browser; see the module
 * header for why this is load-bearing. */
function assertClient(): void {
  if (typeof window === "undefined")
    throw new Error(
      "advancedHandoff is client-only: it must never be read or written during " +
        "server rendering, where module state is shared across requests.",
    );
}

/** Stash the inviter's compose-screen selection, to be read by the `/advanced`
 * route after navigation. */
export function stashAdvancedHandoff(handoff: AdvancedHandoff): void {
  assertClient();
  pending = handoff;
}

/** Clear any stashed selection -- used when the inviter opens Advanced without a
 * file selected, so a stale earlier selection is not resurrected. */
export function clearAdvancedHandoff(): void {
  assertClient();
  pending = undefined;
}

/** Read the stashed selection without clearing it. Pure (no mutation), so it is
 * safe to call from a render-time state initializer (including React StrictMode's
 * double invoke); the Advanced click is the only mutator. */
export function peekAdvancedHandoff(): AdvancedHandoff | undefined {
  assertClient();
  return pending;
}
