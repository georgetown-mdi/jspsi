import { sanitizeForDisplay } from "@psilink/core";

/**
 * Fold one driver `onWarning` message into a seat's accumulated run warnings.
 *
 * This IS the display boundary for a run warning, and the only one: a warning
 * message is composed raw wherever it is raised -- the console's rendezvous
 * preflight names partner-chosen directory entries, the CLI's notices carry
 * partner- and server-controlled text -- and is escaped exactly once, here,
 * before it reaches state and the shared renderer ({@link RunWarningsAlert}).
 * The renderer adds no second pass: `sanitizeForDisplay` doubles a literal
 * backslash on every pass, so escaping twice would show one backslash in a
 * partner filename as four.
 *
 * Every seat that offers the driver an `onWarning` slot folds through this
 * function, so the four run surfaces cannot drift into separate escaping
 * rules. Accumulating (rather than replacing) is what keeps a later notice from
 * displacing an earlier one on a run that raises several.
 */
export function appendSanitizedRunWarning(
  current: ReadonlyArray<string>,
  message: string,
): Array<string> {
  return [...current, sanitizeForDisplay(message)];
}
