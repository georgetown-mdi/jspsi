/**
 * The one contract for a file-sync exchange's `peer_id` label, shared by the
 * console's authoring guard ({@link ../bench/exchangeFilesModel}) and the server
 * intent schema ({@link ../jobs/intent}). Extracted for the reason
 * {@link ./identityLabel} is: the browser guard and the server validator must not
 * drift, and the guard must not pull the server-only intent module (and its
 * `node:url` dependency) into the browser bundle for one constant.
 */

/**
 * Upper bound on a `peer_id`. It prefixes every filename this party writes into
 * the shared directory, alongside a suffix and (in retain mode) a timestamp and
 * counter, so a short label is the only legitimate shape; 64 leaves ample room
 * under every filesystem's component limit.
 */
export const MAX_PEER_ID_LENGTH = 64;

/**
 * The shape a `peer_id` may take when it is authored in the console: a single
 * label that starts and ends with an ASCII letter or digit and otherwise admits
 * only ASCII letters, digits, spaces, `-`, and `_`. Core permits any non-empty
 * string, but a value from the job API becomes a filename component in a
 * directory the SERVER owns, so separators, dot runs, and a leading dash that
 * could compose a path, a traversal, or a flag-shaped token are refused.
 */
export const PEER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/;

/** Whether `value` is an admissible `peer_id`: within
 * {@link MAX_PEER_ID_LENGTH} and matching {@link PEER_ID_PATTERN}. */
export function isAdmissiblePeerId(value: string): boolean {
  return value.length <= MAX_PEER_ID_LENGTH && PEER_ID_PATTERN.test(value);
}

/** The message both the console guard and the intent schema report for a
 * `peer_id` that fails {@link isAdmissiblePeerId}, so the two surfaces say the
 * same thing about the same value. It names the ASCII bound
 * {@link PEER_ID_PATTERN} enforces, so an operator who typed an accented or
 * non-Latin name reads why it was refused rather than a description of what
 * they typed. */
export const PEER_ID_SHAPE_MESSAGE =
  "The party name must be a single label of ASCII letters (A-Z, a-z), digits, " +
  "spaces, '-', or '_', beginning and ending with a letter or digit. Write an " +
  "accented or non-Latin name in ASCII instead.";
