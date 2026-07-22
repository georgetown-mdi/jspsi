/**
 * The pure name-shape admission rules for mounted work inputs and mount browsing,
 * shared so their callers cannot drift: the directory listing ({@link ./workInputs})
 * and the job intent's `inputFile` reference apply {@link isAdmissibleInputName};
 * the secrets-mount browse ({@link ./mountBrowse}) applies {@link browseSegment}.
 * Both derive from one single-segment shape predicate and differ only on the
 * leading-dot rule. Kept free of any filesystem dependency: the intent schema
 * reuses the predicate without pulling `node:fs` into its import graph, and the
 * modules avoid a circular import. A name is never trusted from these rules alone
 * -- every by-name file operation re-resolves the name under the server-anchored
 * mount and confirms the target (a `statSync`/`realpathSync`); this only bounds
 * the shape a name may take.
 */

/** The maximum length of an admissible input file name (a single path segment). */
export const MAX_INPUT_NAME_LENGTH = 255;

// C0 controls (which include NUL) and DEL: an operator-controlled name is still
// rendered through the UI, and a control character has no place in a file name.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * The single-segment shape rule shared by {@link isAdmissibleInputName} and
 * {@link browseSegment}: a single path segment (no `/`, `\`, or NUL), not
 * `.`/`..`, no control characters, length 1..255. The two callers share this
 * predicate so they cannot drift; they differ ONLY in the leading-dot rule
 * applied on top of it.
 */
function hasAdmissibleSegmentShape(name: string): boolean {
  if (name.length === 0 || name.length > MAX_INPUT_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(name)) return false;
  return true;
}

/**
 * Whether `name` is an admissible input file name: the shared single-segment
 * shape ({@link hasAdmissibleSegmentShape}) plus no leading dot, so a
 * `.psilink.key`-shaped file is excluded by construction. The listing admits
 * only a regular file (a plain `statSync` + `isFile`, which follows a symlink);
 * this predicate bounds only the name shape.
 */
export function isAdmissibleInputName(name: string): boolean {
  if (!hasAdmissibleSegmentShape(name)) return false;
  if (name.startsWith(".")) return false;
  return true;
}

/**
 * Whether `name` is an admissible mount-browse segment: the shared single-segment
 * shape ({@link hasAdmissibleSegmentShape}) with NO leading-dot ban, so a
 * dot-prefixed directory or file (`.ssh`, `.ssh/id_ed25519`) is navigable -- SSH
 * key material lives under such names. It keeps every other check
 * {@link isAdmissibleInputName} applies (separators, `.`/`..`, control
 * characters, length), differing from it only on the leading dot. Every returned
 * listing entry passes this rule, so each is itself a valid next segment; a name
 * is never trusted from the shape alone -- {@link ./mountBrowse} re-resolves it
 * under the server-anchored mount root and re-confines the realpath.
 */
export function browseSegment(name: string): boolean {
  return hasAdmissibleSegmentShape(name);
}
