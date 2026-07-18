/**
 * The pure name-shape admission rule for mounted work inputs, shared by the
 * directory listing ({@link ./workInputs}) and the job intent's `inputFile`
 * reference so the two apply the SAME single-segment shape and cannot drift. Kept
 * free of any filesystem dependency: the intent schema reuses the predicate without
 * pulling `node:fs` into its import graph, and the two modules avoid a circular
 * import. The name is never trusted from this rule alone -- every by-name file
 * operation re-resolves the name under the server-anchored mount and confirms a
 * regular file (a plain `statSync` + `isFile`); this only bounds the shape a name
 * may take.
 */

/** The maximum length of an admissible input file name (a single path segment). */
export const MAX_INPUT_NAME_LENGTH = 255;

// C0 controls (which include NUL) and DEL: an operator-controlled name is still
// rendered through the UI, and a control character has no place in a file name.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Whether `name` is an admissible input file name: a single path segment (no `/`,
 * `\`, or NUL), not `.`/`..`, no leading dot (so a `.psilink.key`-shaped file is
 * excluded by construction), no control characters, length 1..255. The listing
 * admits only a regular file (a plain `statSync` + `isFile`, which follows a
 * symlink); this predicate bounds only the name shape.
 */
export function isAdmissibleInputName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_INPUT_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(name)) return false;
  return true;
}
