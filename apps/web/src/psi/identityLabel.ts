/**
 * The one contract for a zero-setup exchange's operator `--identity` label, shared
 * by the client-side confirm-screen guard ({@link ../bench/DirectConfirmSection})
 * and the server intent schema ({@link ../jobs/intent}). Extracted so the browser
 * guard and the server validator cannot drift -- a label one accepts, the other must
 * too -- and so the guard does not pull the server-only intent module (and its
 * `node:url` dependency) into the browser bundle for one constant.
 */

/**
 * Upper bound on the `identity` label a zero-setup intent may carry (the CLI's
 * `--identity` value: the party's name/org/contact string). Generous for a real
 * label yet refuses an unbounded string; a non-secret operator value, never a path
 * or credential.
 */
export const MAX_IDENTITY_LENGTH = 1024;
