import { errorMessage } from "../connection/messageConnection";
import { sanitizeForDisplay } from "./sanitizeForDisplay";

/**
 * Maximum number of links {@link sanitizeErrorForDisplay} walks down an error's
 * `cause` chain before stopping. A defensive bound so a pathologically deep (or
 * adversarially constructed) chain cannot flood an operator's terminal or stall
 * the render: the cycle guard already stops a chain that revisits a link, and
 * this caps a long acyclic one.
 */
export const MAX_ERROR_CAUSE_DEPTH = 8;

/**
 * Separator placed between an error's message and each chained `cause` message.
 * Plain ASCII (the leading newline included) so the separator itself can never
 * reintroduce a control character into the assembled output.
 */
const CAUSE_SEPARATOR = "\ncaused by: ";

/**
 * Render an arbitrary thrown value as operator-safe display text: its own
 * message followed by each chained `cause` message, every link passed through
 * {@link sanitizeForDisplay} so partner- or server-controlled bytes embedded in
 * any link -- control characters, the ESC that drives ANSI sequences, CR/LF
 * usable for log-line spoofing, bidi overrides, zero-width and confusable
 * characters -- cannot reach a terminal, log line, or UI element.
 *
 * This is the display-boundary seam for rendering a raw error INSTANCE to a
 * human. The transport and message layers deliberately preserve the original
 * error object so it can still be classified by type (e.g. `transport` vs
 * `closed`); the escaping therefore cannot happen there without mis-tagging the
 * error, and must happen here, where it is finally shown. Use it in place of
 * `console.error(err)` or a direct `err.message` interpolation at any
 * operator-facing sink, never on a value used for comparison, storage, or
 * hashing (it is lossy; see {@link sanitizeForDisplay}).
 *
 * The walk is deliberately narrow and defensive:
 * - it reads only each link's `.message` (via {@link errorMessage}) and
 *   `.cause`, never `.stack` or any other property, so no stack frame or
 *   credential-bearing field is ever rendered;
 * - it is cycle-safe (a chain that revisits a link stops) and depth-bounded (at
 *   most {@link MAX_ERROR_CAUSE_DEPTH} links), so a malformed or hostile chain
 *   cannot loop or flood;
 * - it suppresses a link whose raw message repeats the link before it -- the
 *   common case, since `asConnectionError` sets a wrapper's message to its
 *   cause's message -- so the same text is not printed twice.
 *
 * An error with no `cause` renders exactly as
 * `sanitizeForDisplay(errorMessage(err))`, and a non-`Error` value (including
 * `null`/`undefined`) renders its `String(...)` form, matching
 * {@link errorMessage}.
 */
export function sanitizeErrorForDisplay(err: unknown): string {
  const rawMessages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth++) {
    const message = errorMessage(current);
    // Suppress a link that repeats the previous link's raw message: a wrapper
    // built by asConnectionError carries its cause's message verbatim, so the
    // outer and first inner links are usually byte-identical.
    if (rawMessages[rawMessages.length - 1] !== message) {
      rawMessages.push(message);
    }
    seen.add(current);
    // Follow `.cause` on any object link (mirrors the cause walker in the CLI
    // protocol layer); a non-object link has no chain to follow. typeof null is
    // "object", so the null guard is load-bearing.
    const next =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
    if (next === undefined || next === null || seen.has(next)) break;
    current = next;
  }
  return rawMessages
    .map((message) => sanitizeForDisplay(message))
    .join(CAUSE_SEPARATOR);
}
