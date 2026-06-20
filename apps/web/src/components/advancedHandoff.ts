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
 * `/advanced` route (`ssr: false`), so this module-level value is never touched
 * during server rendering and cannot leak across requests. It is overwritten (or
 * cleared) on every Advanced click, so it always reflects the latest one, and a
 * full page load reinitializes it to `undefined` -- the intended cold-load
 * behavior, since the browser cannot regain access to a previously chosen local
 * file, so the route falls back to its own file picker.
 */
export interface AdvancedHandoff {
  /** The CSV the inviter chose on the compose screen (a lazy handle, not bytes). */
  file: File;
  /** The name the inviter typed on the compose screen, prefilled into the editor's
   * identity field; may be empty. */
  name: string;
}

let pending: AdvancedHandoff | undefined;

/** Stash the inviter's compose-screen selection, to be read by the `/advanced`
 * route after navigation. */
export function stashAdvancedHandoff(handoff: AdvancedHandoff): void {
  pending = handoff;
}

/** Clear any stashed selection -- used when the inviter opens Advanced without a
 * file selected, so a stale earlier selection is not resurrected. */
export function clearAdvancedHandoff(): void {
  pending = undefined;
}

/** Read the stashed selection without clearing it. Pure, so it is safe to call
 * from a render-time state initializer (including React StrictMode's double
 * invoke); the Advanced click is the only mutator. */
export function peekAdvancedHandoff(): AdvancedHandoff | undefined {
  return pending;
}
