declare const operatorSuppliedBrand: unique symbol;

/**
 * One string whose bytes the OPERATOR supplied -- a path they typed, a value
 * they wrote in their own configuration -- marked where it enters a message so
 * the display sink renders it as given instead of escaping it.
 *
 * The mark is what makes the treatment opt-in: text nobody marked is escaped,
 * which is the standing assignment (CONTRIBUTING.md, Operator-facing
 * escaping), so a fragment somebody else chose keeps its escape by doing
 * nothing. Only a call site that states "the operator chose these bytes" gets
 * the other treatment, and it states it per FRAGMENT, so a message naming an
 * operator's path beside a partner's value escapes the part of itself the
 * partner chose.
 *
 * The brand keys a module-private `unique symbol`, so nothing outside this
 * module builds one: a value a partner sends can carry no such property,
 * whatever it spells, because no parse produces a symbol key.
 *
 * It marks WHO CHOSE THE BYTES and nothing else. A path copied into a
 * configuration out of an invitation the partner wrote is the partner's
 * choice sitting in the operator's file, so a site holding a value of that
 * class leaves it unmarked; what the render does leave out either way is the
 * control class ({@link ./sanitizeForDisplay.renderOperatorSuppliedText}).
 */
export interface OperatorSuppliedText {
  readonly [operatorSuppliedBrand]: string;
}

const OPERATOR_SUPPLIED_VALUE = Symbol("psilink.display.operatorSuppliedText");

/**
 * Mark one string as {@link OperatorSuppliedText}, at the site that composes
 * it into a message. Its bytes are the operator's own: a path from the command
 * line or their configuration file, not a value a remote party chose.
 */
export const operatorSuppliedText = (value: string): OperatorSuppliedText =>
  ({ [OPERATOR_SUPPLIED_VALUE]: value }) as unknown as OperatorSuppliedText;

/** One span of a composed message, with the treatment its origin takes. */
export interface DisplaySpan {
  /** The span's raw bytes, escaped or rendered where the message is shown. */
  readonly text: string;
  /**
   * Whether the operator supplied these bytes. A span nobody marked is
   * escaped, so the treatment that leaves bytes as given is reached only by
   * marking.
   */
  readonly operatorSupplied: boolean;
}

/**
 * A message composed out of first-party copy and fragments, holding both what
 * the message says and which of its spans the operator supplied.
 *
 * `text` is the string the same template literal would have produced with the
 * fragments interpolated raw -- what an `Error` built from it takes as its
 * message, so classification and message equality read the text they read
 * before the message was partitioned.
 */
export interface MessageWithOperatorText {
  readonly text: string;
  readonly spans: ReadonlyArray<DisplaySpan>;
}

/**
 * Compose a message as a tagged template, keeping each fragment's origin:
 * ``messageWithOperatorText`could not read ${operatorSuppliedText(path)}: ${detail}` ``.
 *
 * The fixed spans are the call site's own copy and every unmarked value is a
 * fragment somebody else may have chosen, so both take the escape; a marked
 * value is the one span rendered as given. A `number` is printable ASCII and
 * takes the escape like any unmarked value, which leaves it unchanged.
 *
 * The result is inert: it holds text and spans and reaches the operator only
 * through {@link keepOperatorSuppliedText}, which is what puts the partition
 * where the renderer reads it.
 */
export function messageWithOperatorText(
  fixedSpans: TemplateStringsArray,
  ...values: ReadonlyArray<OperatorSuppliedText | string | number>
): MessageWithOperatorText {
  const spans: DisplaySpan[] = [];
  const push = (text: string, operatorSupplied: boolean): void => {
    if (text !== "") spans.push({ text, operatorSupplied });
  };
  push(fixedSpans[0]!, false);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const supplied = operatorSuppliedValue(value);
    push(supplied ?? String(value), supplied !== undefined);
    push(fixedSpans[index + 1]!, false);
  }
  return { text: spans.map((span) => span.text).join(""), spans };
}

/** The string inside an {@link OperatorSuppliedText}, or `undefined`. */
function operatorSuppliedValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const held = (value as Record<symbol, unknown>)[OPERATOR_SUPPLIED_VALUE];
  return typeof held === "string" ? held : undefined;
}

/**
 * Where the spans of a partitioned message are kept for the error renderer to
 * read.
 *
 * A SYMBOL-keyed property, out of reach of the text the renderer defends
 * against: no parse produces one, so no value a partner sends can ask for the
 * treatment. Registered rather than module-private, so a process holding two
 * copies of this module reads the mark the other copy wrote instead of
 * escaping a path the operator typed.
 */
const OPERATOR_SUPPLIED_SPANS = Symbol.for(
  "psilink.errorDisplay.operatorSuppliedSpans",
);

/**
 * Mark `error` with the spans of the message it was built from, so
 * {@link ./sanitizeErrorForDisplay.sanitizeErrorForDisplay} escapes the spans
 * nobody marked and renders the operator's own as given.
 *
 * Pass the message the error's own `message` was built from: the renderer
 * escapes the whole message and ignores the mark unless the spans join back to
 * it, so a mark that does not describe the text it sits on costs a doubled
 * backslash rather than a wrong rendering. `error.message` is left as composed.
 *
 * It marks the error and returns it, the shape
 * {@link ./sanitizeErrorForDisplay.keepFirstPartyLineBreaks} takes. A message
 * with no marked span asks for nothing the escape does not already do, so it
 * is left unmarked.
 */
export function keepOperatorSuppliedText<E extends Error>(
  error: E,
  message: MessageWithOperatorText,
): E {
  if (!message.spans.some((span) => span.operatorSupplied)) return error;
  Object.defineProperty(error, OPERATOR_SUPPLIED_SPANS, {
    value: message.spans,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/**
 * The spans {@link keepOperatorSuppliedText} left on `link` whose text joins
 * back to `message`, or `undefined` for a link that asked for no such
 * treatment -- which is every link psilink does not partition itself.
 *
 * The join is checked here rather than trusted: the renderer shows what the
 * spans hold, so spans that describe some other text would put a rendering out
 * of step with the `Error.message` a log line or a test reads. Failing that
 * check falls back to escaping the message whole, the treatment of an
 * unmarked link.
 *
 * Read defensively, like every read that renderer makes: a mark of any other
 * shape -- another copy of this module's, an object built to hold the
 * registered symbol -- is no mark at all.
 */
export function operatorSuppliedSpans(
  link: unknown,
  message: string,
): ReadonlyArray<DisplaySpan> | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  // An OWN property, where the mark puts it: a class or a plain object in a
  // chain's path must not lend the treatment to everything built from it.
  if (!Object.hasOwn(link, OPERATOR_SUPPLIED_SPANS)) return undefined;
  const marked = (link as Record<symbol, unknown>)[OPERATOR_SUPPLIED_SPANS];
  if (!Array.isArray(marked)) return undefined;
  const spans: DisplaySpan[] = [];
  for (const span of marked as unknown[]) {
    if (typeof span !== "object" || span === null) return undefined;
    const { text, operatorSupplied } = span as Partial<DisplaySpan>;
    if (typeof text !== "string" || typeof operatorSupplied !== "boolean")
      return undefined;
    spans.push({ text, operatorSupplied });
  }
  return spans.map((span) => span.text).join("") === message
    ? spans
    : undefined;
}
