import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "@psilink/core";

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
 * Every message this boundary folds is a whole warning COMPOSITION, so the cap
 * here is the composition budget rather than the per-value default: the CLI's
 * warnings are fitted to {@link WARNING_MESSAGE_MAX_DISPLAY_LENGTH} where they
 * are built, and the appliance's own preflight notices fit themselves tighter
 * still, each to the per-value default where it is composed, so this cap sits
 * slack above them. A seat cannot tell which source handed it a message and
 * does not need to: the per-value default would cut a CLI notice off before
 * its recovery instruction, which is the part an operator acts on.
 *
 * Every seat that offers the driver an `onWarning` slot folds through this
 * function, so the run surfaces cannot drift into separate escaping rules. That
 * routing is held by a lint rule rather than by this sentence (the seat
 * warning-sink ban in `apps/web/eslint.config.js`), since a seat escaping twice
 * or not at all is a failure no test of this function can see. Accumulating
 * (rather than replacing) is what keeps a later notice from displacing an
 * earlier one on a run that raises several.
 */
export function appendSanitizedRunWarning(
  current: ReadonlyArray<string>,
  message: string,
): Array<string> {
  return [
    ...current,
    sanitizeForDisplay(message, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  ];
}
