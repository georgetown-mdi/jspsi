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
 * The leading newline is the one control character in the assembled output, and
 * it is deliberate: a fixed formatting byte this module emits (so each cause
 * renders on its own line in a terminal), never partner-controlled input. Every
 * byte that comes from an error message is escaped by {@link sanitizeForDisplay}
 * before it is joined, so no partner-controlled control character can ride in
 * alongside this one. Consumers that render to HTML must opt into preserving the
 * newline (e.g. `white-space: pre-line`); browsers collapse it otherwise.
 */
const CAUSE_SEPARATOR = "\ncaused by: ";

/**
 * Fallback emitted for a cause-chain link whose message cannot be read -- a
 * hostile or malformed error whose `.message`/`.cause` getter or
 * `toString`/`Symbol.toPrimitive` throws, or whose `.message` is a non-string.
 * Plain ASCII, so it passes through {@link sanitizeForDisplay} unchanged and
 * keeps this renderer total: it never throws at the operator-facing, last-resort
 * boundary it exists to protect.
 */
const UNREADABLE_LINK = "[unreadable error]";

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
 *   most {@link MAX_ERROR_CAUSE_DEPTH} links, each capped by
 *   {@link sanitizeForDisplay}), so a malformed or hostile chain cannot loop or
 *   flood -- the whole output is bounded without a separate total-length cap;
 * - it suppresses a link whose raw message repeats the link before it -- the
 *   common case, since `asConnectionError` sets a wrapper's message to its
 *   cause's message -- so the same text is not printed twice;
 * - it never throws: a link whose message cannot be read (a throwing
 *   `.message`/`.cause` getter or `toString`, or a non-string `.message`)
 *   renders as `[unreadable error]` rather than propagating, since a renderer at
 *   a last-resort catch boundary must not become a second failure.
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
    // Read each link defensively. This is a last-resort display path, so a
    // hostile or malformed error -- a `.message` getter or `toString` that
    // throws, or a non-string `.message` that would make sanitizeForDisplay's
    // code-point walk throw -- must yield a marker, never crash the renderer.
    let message: string;
    try {
      const raw = errorMessage(current);
      message = typeof raw === "string" ? raw : String(raw);
    } catch {
      message = UNREADABLE_LINK;
    }
    // Suppress a link that repeats the previous link's raw message: a wrapper
    // built by asConnectionError carries its cause's message verbatim, so the
    // outer and first inner links are usually byte-identical.
    if (rawMessages[rawMessages.length - 1] !== message) {
      rawMessages.push(message);
    }
    seen.add(current);
    // Follow `.cause` on any object link (mirrors the cause walker in the CLI
    // protocol layer); a non-object link has no chain to follow. typeof null is
    // "object", so the null guard is load-bearing. A throwing `.cause` getter
    // ends the chain rather than propagating.
    let next: unknown;
    try {
      next =
        typeof current === "object" && current !== null
          ? (current as { cause?: unknown }).cause
          : undefined;
    } catch {
      next = undefined;
    }
    if (next === undefined || next === null || seen.has(next)) break;
    current = next;
  }
  return rawMessages
    .map((message) => sanitizeForDisplay(message))
    .join(CAUSE_SEPARATOR);
}
