import { sanitizeForDisplay } from "@psilink/core";

/**
 * Fold one driver `onWarning` message into a seat's accumulated run warnings.
 *
 * This is the seat's display boundary: whatever a seat renders is escaped here,
 * once, before it reaches state and the shared renderer
 * ({@link RunWarningsAlert}), which adds no pass of its own -- `sanitizeForDisplay`
 * doubles a literal backslash on every pass, so escaping twice would show one
 * backslash in a partner filename as four.
 *
 * One pass is the whole count only for a warning the appliance composes itself:
 * the console's rendezvous preflight names partner-chosen directory entries and
 * its messages are buffered raw, so this is where they are first escaped. A
 * warning the CLI raises reaches this sink already escaped -- at composition, at
 * the fd-3 warning event, and again where the browser validates that stream --
 * so on that route this pass is defense in depth over text that is already
 * display-safe, and the escapes compound (docs/spec/CHANNEL_SECURITY.md,
 * "Display sanitization escape format", records those routes). The checks pin
 * this function's own single pass over the message it is handed, and the
 * rendered result for the preflight class; no check covers the composed count
 * along the CLI route.
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
