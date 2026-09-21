import type { OperatorSuppliedText } from "./operatorSuppliedText";
import { operatorSuppliedValue } from "./operatorSuppliedText";

declare const displayableBrand: unique symbol;

/**
 * A string that has passed through the display boundary: what
 * {@link sanitizeForDisplay} and {@link renderOperatorSuppliedText} return
 * and what {@link displayText} composes.
 * Declaring an operator-facing display field as `Displayable` rather than
 * `string` makes omitting the sanitize call a compile error instead of a review
 * catch -- a plain `string` (any partner-controlled value) is not assignable to
 * it. The brand is transparent in the other direction: a `Displayable` IS a
 * `string`, so renderers, logs, JSX text, and concatenation consume it with no
 * cast or unwrapping.
 *
 * The brand is a phantom property keyed by a module-private `unique symbol`, so
 * nothing outside this module satisfies it structurally: the producers here
 * are the only way to obtain one, short of a deliberate `as Displayable`
 * assertion. It exists only in the type system -- no value has the property
 * at runtime, and the branded string is byte-identical to the unbranded one.
 *
 * The brand marks a value as safe to SHOW AS TEXT, never as the value to
 * use: the display form is lossy and escaped, so a comparison, storage, or
 * hashing site still takes the raw string (see {@link sanitizeForDisplay}).
 * "As text" is the whole of the claim -- the sanitizer leaves every
 * printable ASCII byte intact, `<`, `>`, `&`, `"` and `'` among them, so a
 * `Displayable` is safe in a React text child because JSX escapes it there,
 * and has no HTML-, attribute-, or URL-safety of its own. The claim is the
 * same width for an operator-supplied render, which leaves non-ASCII as the
 * operator typed it: what that producer takes out is the control class, the
 * U+2028 and U+2029 line separators, and a lone surrogate
 * ({@link replaceUnrenderableForOperatorDisplay}).
 */
export type Displayable = string & { readonly [displayableBrand]: true };

/**
 * Marker appended by {@link sanitizeForDisplay} when a value is truncated.
 * Plain ASCII so the marker itself can never reintroduce a control or
 * deceptive-Unicode character into the sanitized output.
 */
export const DISPLAY_TRUNCATION_MARKER = "...[truncated]";

/**
 * Default cap on the number of output characters {@link sanitizeForDisplay}
 * emits before truncating (excluding the {@link DISPLAY_TRUNCATION_MARKER}).
 * A bounded, defensive cap on diagnostic strings -- not a wire bound (that
 * belongs at the transport read) -- so a pathologically long partner value
 * cannot flood an operator's log or UI through an error message.
 */
export const DEFAULT_MAX_DISPLAY_LENGTH = 256;

/**
 * Cap on the output characters {@link sanitizeErrorForDisplay} emits for one
 * link of a rendered error chain, above the per-value
 * {@link DEFAULT_MAX_DISPLAY_LENGTH}. A link is a COMPOSITION: first-party
 * explanation and recovery text with fragments interpolated into it, and by
 * the single-altitude escaping rule those fragments compose RAW and are
 * escaped once, where the chain is rendered (CONTRIBUTING.md,
 * Operator-facing escaping). The per-value default is sized for one
 * fragment, so charging a whole link to it would cut the first-party
 * sentence the operator has to act on.
 *
 * Does NOT relieve a call site of keeping one chooser's bytes off another's
 * link: the budget bounds what a single link can spend, and a site mixing
 * first-party copy with a fragment somebody else chose still lets that
 * chooser spend the whole of it. A site holding a chooser's bytes gives
 * each one a labelled link of its own (the transport, host-key, and linkage
 * pre-flight refusals).
 *
 * Sized to admit the longest fixed guidance psilink composes into one
 * message plus the bounded values it names, well under
 * {@link WARNING_MESSAGE_MAX_DISPLAY_LENGTH} (a different, larger shape).
 * The whole rendered chain stays bounded without a separate total-length
 * cap: at most {@link MAX_ERROR_CAUSE_DEPTH} links at this budget each.
 */
export const COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH = 1024;

/**
 * Cap on the output characters a boundary emits for a whole composed
 * WARNING, above the per-value {@link DEFAULT_MAX_DISPLAY_LENGTH}. A
 * warning is a COMPOSITION: first-party explanation and recovery text
 * around fragments already escaped and capped where they were
 * interpolated. The per-value default is sized for one fragment, so
 * applying it here would truncate the warning's own instruction -- and the
 * cross-party host-key divergence warning is exactly what a supervisor
 * discarding stderr, or an operator watching the console, has nothing else
 * to read. The stderr log path delivers that warning whole; no other path
 * may deliver less of it.
 *
 * Four boundaries hold a whole warning message and take this cap rather
 * than the default, so none re-caps what an earlier one delivered: the
 * CLI's stderr log of a composed terms-exchange warning, the CLI's fd-3
 * warning event, the console relay re-validating that stream
 * (`validateAndSanitizeEvent`), and the console seat rendering it
 * (`appendSanitizedRunWarning`). The first two are one warning's two sinks,
 * so a differing cap would show the terminal operator less than the
 * supervisor reading the machine channel gets. A boundary holding a single
 * value keeps the default.
 *
 * Sized to admit that warning with every fragment at its own cap and
 * escaped again at each boundary it crosses. What holds the size is the
 * pair of checks that render the divergence warning with all four
 * fragments flooded -- both parties' key types and both fingerprints -- and
 * fail unless its explanation and re-pin instruction both survive.
 */
export const WARNING_MESSAGE_MAX_DISPLAY_LENGTH = 4096;

/** Options for {@link sanitizeForDisplay}. */
export interface SanitizeForDisplayOptions {
  /**
   * Maximum number of output characters to emit before truncating and appending
   * {@link DISPLAY_TRUNCATION_MARKER}. This bounds the escaped output, not
   * the number of input code points: a single code point can escape to as
   * many as ten characters, so capping the input would let the output run
   * to roughly ten times this value. Defaults to
   * {@link DEFAULT_MAX_DISPLAY_LENGTH}.
   */
  maxLength?: number;
}

/**
 * Sanitize an untrusted string for inclusion in operator-facing output
 * (terminal, logs, or UI). Intended for any string a mutually-distrusting
 * remote party can control that is then echoed to a human: linkage-terms
 * diagnostics, the partner's self-asserted identity, abort reasons, and -- in
 * any future viewer -- the cleartext governance free-text held in an exchange
 * record.
 *
 * Policy: every code point outside printable ASCII (U+0020-U+007E) is rewritten
 * to a visible `\xHH` / `\uHHHH` / `\u{HHHHH}` escape, and a literal backslash
 * is doubled so the escaping is unambiguous. This single rule neutralizes the
 * whole threat surface at once -- C0/C1 controls and the ESC that drives ANSI
 * sequences, line breaks usable for log-line spoofing, bidi overrides
 * (RLO/LRO), zero-width characters, and homoglyph/confusable characters (a
 * Cyrillic `U+0430` renders identically to a Latin "a"). The output is then
 * truncated so its length never exceeds `maxLength` (plus the marker); see
 * {@link SanitizeForDisplayOptions}.
 *
 * The trade-off is fidelity for safety: legitimate non-ASCII text (accented
 * names, non-Latin scripts) is shown as escapes rather than rendered --
 * intended for untrusted operator-facing diagnostics, where seeing the exact
 * bytes matters more than pretty rendering, and there is no dependency-free way
 * to neutralize confusables without escaping non-ASCII broadly.
 *
 * Sanitize only at the display boundary, never the value used for comparison,
 * storage, or hashing: it is lossy (truncation collapses distinct long values,
 * and the result is an escaped display form, not the original bytes), and an
 * exchange record must retain the byte-exact value it signs and that both
 * parties cross-validate.
 */
export function sanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_DISPLAY_LENGTH;

  // Iterate by code point (string iteration, not UTF-16 unit) so an astral
  // character escapes as a single unit and a lone surrogate is escaped rather
  // than split. The cap bounds the OUTPUT length, not the number of code points
  // read: an escape can expand a code point to ten characters, so a code-point
  // cap would let the output run to ~10x. A code point is appended only if its
  // whole escape fits, so the output never ends mid-escape; a cut that would
  // leave a fragment of a marker a treatment already put in the value backs off
  // to before it ({@link trimPartialControlCharacterMarker}).
  let out = "";
  let truncated = false;
  for (const ch of value) {
    let piece: string;
    if (ch === "\\") {
      piece = "\\\\";
    } else {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x20 && cp <= 0x7e) {
        piece = ch;
      } else if (cp <= 0xff) {
        piece = "\\x" + cp.toString(16).padStart(2, "0");
      } else if (cp <= 0xffff) {
        piece = "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        piece = "\\u{" + cp.toString(16) + "}";
      }
    }
    if (out.length + piece.length > maxLength) {
      truncated = true;
      break;
    }
    out += piece;
  }

  return (
    truncated
      ? trimPartialControlCharacterMarker(out) + DISPLAY_TRUNCATION_MARKER
      : out
  ) as Displayable;
}

/**
 * Render a fragment the OPERATOR supplied for operator-facing output: every
 * character {@link replaceUnrenderableForOperatorDisplay} names replaced by a
 * printable marker, every other code point left as the operator typed it, and
 * the result truncated to `maxLength` with {@link DISPLAY_TRUNCATION_MARKER}
 * in place of the rest.
 *
 * It takes the MARK rather than a string
 * ({@link ./operatorSuppliedText.operatorSuppliedText}), so the statement
 * "the operator chose these bytes" is made at the site that knows it and a
 * value nobody marked -- a plain string, a
 * {@link ./partnerOriginText.PartnerOriginText} -- is a compile error here
 * instead of a review catch. A value that arrives unmarked despite the type
 * is escaped by {@link sanitizeForDisplay} rather than rendered as given: the
 * raw render is what the mark buys, so everything else keeps the standing
 * treatment.
 *
 * The counterpart of {@link sanitizeForDisplay} on the other side of the
 * fragment boundary. That escape doubles a literal backslash to keep its
 * `\xHH` tokens unambiguous, which is right for bytes somebody else chose and
 * wrong for a path the operator typed: `C:\data\in.csv` reaches them as
 * `C:\\data\\in.csv`, a path they cannot copy back. Here the separators, the
 * accented directory name and every other printable byte read as given.
 *
 * What it does NOT leave as given is the class an operator-supplied value
 * shares its hazard with whoever else can reach it, since a path can be
 * copied into a config from an invitation the partner wrote: the control
 * characters, where an ESC drives an ANSI sequence and a break spoofs a log
 * line, the U+2028 and U+2029 line separators a reader breaks a line on, and
 * a lone surrogate, which would leave the rendered string non-well-formed.
 * Each renders to a marker of printable ASCII with no backslash, so the sink
 * has nothing left to escape.
 *
 * The bidi overrides and confusable characters {@link sanitizeForDisplay}
 * neutralizes are shown here as themselves: a value this renders is one the
 * operator chose, where fidelity is what the value is shown for. Marking a
 * fragment as operator-supplied is therefore a statement about who chose the
 * bytes, made where the value enters a message
 * ({@link ./operatorSuppliedText.operatorSuppliedText}).
 */
export function renderOperatorSuppliedText(
  value: OperatorSuppliedText,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const text = operatorSuppliedValue(value);
  return text === undefined
    ? sanitizeForDisplay(String(value), options)
    : renderOperatorSuppliedSpanText(text, options);
}

/**
 * {@link renderOperatorSuppliedText} over text whose origin the caller has
 * already established: one span of a message partitioned by
 * {@link ./operatorSuppliedText.messageWithOperatorText}, marked where the
 * value entered the message and read back off the error where the chain is
 * rendered ({@link ./sanitizeErrorForDisplay.sanitizeErrorForDisplay}). The
 * per-value entry points are where an unmarked value is refused, so a span
 * reaching here takes a plain string.
 */
export function renderOperatorSuppliedSpanText(
  text: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_DISPLAY_LENGTH;
  let out = "";
  let truncated = false;
  // By code point, like the escape above: an astral character is kept or
  // dropped whole rather than cut between its surrogates.
  for (const ch of replaceUnrenderableForOperatorDisplay(text)) {
    if (out.length + ch.length > maxLength) {
      truncated = true;
      break;
    }
    out += ch;
  }
  return (
    truncated
      ? trimPartialOperatorDisplayMarker(out) + DISPLAY_TRUNCATION_MARKER
      : out
  ) as Displayable;
}

/**
 * How {@link replaceControlCharactersForDisplay} renders one control
 * character: its code point in two lowercase hex digits, inside angle
 * brackets. Angle brackets rather than the escape's own `\xHH` shape, so a
 * value's own printable bytes cannot spell it (the marker has NO BACKSLASH,
 * while {@link sanitizeForDisplay} doubles a literal one) -- a marker built
 * from the escape's own alphabet could otherwise be spelled by the bytes it
 * is meant to be distinguishable from. Every control character is at or
 * below U+009F, so two hex digits always suffice and the marker is the same
 * four characters wide the escape would have rendered.
 *
 * Being printable ASCII, the marker is not authenticated and cannot be: a
 * value that spells the marker renders identically to one that held the
 * character it names (the same open class {@link DISPLAY_TRUNCATION_MARKER}
 * has). What an operator can rely on is the converse -- a control character
 * a composition placed ITSELF still renders as the escape's `\xHH`, which no
 * treated value can produce.
 *
 * Its domain is the control class and nothing wider, refused rather than
 * rendered: {@link PARTIAL_CONTROL_CHARACTER_MARKERS} is read off that same
 * class, so a marker for a code point outside it would have prefixes the
 * back-off does not cover, leaving standing exactly the fragment the pair
 * exists to prevent.
 */
export function controlCharacterMarker(codePoint: number): string {
  if (!CONTROL_CHARACTER.test(String.fromCodePoint(codePoint)))
    throw new RangeError(
      `control-character marker is defined over the control class only, not U+${codePoint.toString(16)}`,
    );
  return `<${codePoint.toString(16).padStart(2, "0")}>`;
}

/**
 * Every control character (Unicode `Cc`: U+0000-U+001F and U+007F-U+009F),
 * which is the class a first-party composition builds its own structure
 * out of -- the line breaks separating a block's lines.
 */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * The same class as a whole-string test over one character, built from the
 * pattern above rather than restated so the emitter's domain and the class
 * the treatment rewrites cannot drift apart. A separate regex because the
 * global one holds `lastIndex` state that a `test` call would advance.
 */
const CONTROL_CHARACTER = new RegExp(`^${CONTROL_CHARACTERS.source}$`, "u");

/**
 * Replace every control character in a value somebody else chose with
 * {@link controlCharacterMarker}, at the site where the value is
 * interpolated into a first-party composition.
 *
 * The third per-value treatment beside redaction and delimiting, answering
 * what neither does: delimiting keeps a value from spelling the clause
 * structure around it in PRINTABLE bytes, but says nothing about a
 * composition whose own structure is a control character (a block that
 * separates its lines with `\n` and is escaped whole where shown) -- the
 * escape renders the composition's line break and a value's own to the
 * SAME `\xHH` token. Replacing the value's leaves that token producible
 * only by the composition itself.
 *
 * Replacement, not escaping: the output has no backslash and no character
 * outside printable ASCII, so the sink's single {@link sanitizeForDisplay}
 * pass has nothing left to rewrite and a treated fragment is not
 * double-escaped (CONTRIBUTING.md, Operator-facing escaping). Same shape as
 * {@link ./sanitizeErrorForDisplay.redactPrivateKeyMaterial}, and
 * idempotent for the same reason: the replacement holds no control
 * character of its own.
 *
 * Applied BEFORE any fit, so a fragment fitted after this is fitted to what
 * the operator is shown rather than to a width the treatment then changes.
 * Its order against redaction does not matter -- neither treatment can
 * make or unmake the other's match, held by a check rather than by this
 * sentence (`packages/core/test/utils/sanitizeForDisplay.test.ts`). For DISPLAY
 * only, like every treatment beside it: a comparison, a hash, or a stored
 * value takes the raw string.
 */
export function replaceControlCharactersForDisplay(value: string): string {
  return value.replace(CONTROL_CHARACTERS, (character) =>
    controlCharacterMarker(character.codePointAt(0)!),
  );
}

/**
 * What an operator-supplied render replaces BEYOND the control class: the
 * U+2028 and U+2029 line separators, which several log readers and a
 * JavaScript source sink break a line on though `\p{Cc}` does not hold them,
 * and an unpaired surrogate, which is not a Unicode scalar value and leaves
 * the rendered string non-well-formed. Matched under `u`, where a surrogate
 * PAIR is one code point outside the range and only an unpaired unit matches,
 * so the class is the one {@link ./wellFormedString.loneSurrogateIndex}
 * reports -- read off both by a check rather than stated here
 * (`packages/core/test/utils/sanitizeForDisplay.test.ts`).
 *
 * The escape has no such list: it leaves printable ASCII alone and rewrites
 * every other code point, these among them.
 */
const OPERATOR_DISPLAY_REPLACED_CHARACTERS = /[\u2028\u2029\uD800-\uDFFF]/gu;

/**
 * The same class as a whole-string test over one character, built from the
 * pattern above for the reason {@link CONTROL_CHARACTER} states.
 */
const OPERATOR_DISPLAY_REPLACED_CHARACTER = new RegExp(
  `^${OPERATOR_DISPLAY_REPLACED_CHARACTERS.source}$`,
  "u",
);

/**
 * How {@link replaceUnrenderableForOperatorDisplay} renders one code point
 * outside the control class: the four hex digits {@link sanitizeForDisplay}
 * would have escaped it with, inside the angle brackets
 * {@link controlCharacterMarker} uses. The brackets rather than that escape's
 * `\uHHHH` shape for the same reason it gives: the operator render leaves a
 * literal backslash standing, so a marker spelled out of the escape's own
 * alphabet would be one more thing a path can spell.
 *
 * Its domain is that class and nothing wider, refused rather than rendered,
 * so {@link PARTIAL_OPERATOR_DISPLAY_MARKERS} covers every marker a cut can
 * land inside.
 */
export function operatorDisplayMarker(codePoint: number): string {
  if (
    !OPERATOR_DISPLAY_REPLACED_CHARACTER.test(String.fromCodePoint(codePoint))
  )
    throw new RangeError(
      `operator-display marker is defined over the line-separator and lone-surrogate classes only, not U+${codePoint.toString(16)}`,
    );
  return `<${codePoint.toString(16).padStart(4, "0")}>`;
}

/**
 * Replace everything {@link renderOperatorSuppliedText} does not show as the
 * operator typed it: the control class
 * ({@link replaceControlCharactersForDisplay}) and the class
 * {@link operatorDisplayMarker} names.
 *
 * One pass per class, in either order: neither replacement emits a character
 * of the other's class, so each of the value's own characters is replaced
 * once and the result holds no character of either.
 */
export function replaceUnrenderableForOperatorDisplay(value: string): string {
  return replaceControlCharactersForDisplay(value).replace(
    OPERATOR_DISPLAY_REPLACED_CHARACTERS,
    (character) => operatorDisplayMarker(character.codePointAt(0)!),
  );
}

/**
 * Every proper, non-empty prefix of a marker
 * ({@link replaceControlCharactersForDisplay}) -- what a cut landing inside one
 * leaves behind. Read off the treatment by running it over the code points it
 * rewrites, rather than restating the marker's shape, so a change to that shape
 * cannot leave the back-off below matching the old one.
 */
const PARTIAL_CONTROL_CHARACTER_MARKERS: ReadonlySet<string> = new Set(
  Array.from({ length: 0xa0 }, (_unused, codePoint) =>
    String.fromCodePoint(codePoint),
  ).flatMap((character) => {
    const treated = replaceControlCharactersForDisplay(character);
    if (treated === character) return [];
    return Array.from({ length: treated.length - 1 }, (_unused, index) =>
      treated.slice(0, index + 1),
    );
  }),
);

const LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER = Math.max(
  ...Array.from(PARTIAL_CONTROL_CHARACTER_MARKERS, (partial) => partial.length),
);

/**
 * The code points {@link operatorDisplayMarker} is defined over, enumerated so
 * the back-off below can be read off its markers the way
 * {@link PARTIAL_CONTROL_CHARACTER_MARKERS} is read off the control class's.
 */
const OPERATOR_DISPLAY_REPLACED_CODE_POINTS: readonly number[] = [
  0x2028,
  0x2029,
  ...Array.from(
    { length: 0xe000 - 0xd800 },
    (_unused, index) => 0xd800 + index,
  ),
];

/**
 * Every proper, non-empty prefix of a marker an OPERATOR-supplied render can
 * emit: the control class's markers, which it emits unchanged, and the wider
 * classes' beside them. Read off the markers rather than restating their
 * shape, for the reason {@link PARTIAL_CONTROL_CHARACTER_MARKERS} gives.
 */
const PARTIAL_OPERATOR_DISPLAY_MARKERS: ReadonlySet<string> = new Set([
  ...PARTIAL_CONTROL_CHARACTER_MARKERS,
  ...OPERATOR_DISPLAY_REPLACED_CODE_POINTS.flatMap((codePoint) => {
    const marker = operatorDisplayMarker(codePoint);
    return Array.from({ length: marker.length - 1 }, (_unused, index) =>
      marker.slice(0, index + 1),
    );
  }),
]);

const LONGEST_PARTIAL_OPERATOR_DISPLAY_MARKER = Math.max(
  ...Array.from(PARTIAL_OPERATOR_DISPLAY_MARKERS, (partial) => partial.length),
);

/**
 * Every proper, non-empty SUFFIX of a marker -- what a cut that keeps the END
 * of a value leaves in front of what it kept, the mirror of
 * {@link PARTIAL_CONTROL_CHARACTER_MARKERS}. Read off the treatment the same
 * way, so neither set can drift from the marker's shape.
 */
const PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES: ReadonlySet<string> = new Set(
  Array.from({ length: 0xa0 }, (_unused, codePoint) =>
    String.fromCodePoint(codePoint),
  ).flatMap((character) => {
    const treated = replaceControlCharactersForDisplay(character);
    if (treated === character) return [];
    return Array.from({ length: treated.length - 1 }, (_unused, index) =>
      treated.slice(index + 1),
    );
  }),
);

const LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIX = Math.max(
  ...Array.from(
    PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES,
    (partial) => partial.length,
  ),
);

/**
 * `text` with ONE trailing fragment of a control-character marker removed,
 * so a routine that cut `text` to a budget hands on whole markers or none.
 *
 * A marker is four printable characters standing where a control character
 * was, and a cut taken by length or by rendered cost knows nothing about
 * it: cut down to `<`, `<0`, or `<0a`, what the operator meets is neither
 * the value's bytes nor the marker. Backing the cut off to before the
 * marker's opening `<` undershoots the budget by up to three characters,
 * which every caller's arithmetic already treats as an upper bound.
 *
 * One fragment is all a cut can leave, which is why this is a single
 * back-off and not a loop: a whole marker ends in `>`, a character no
 * proper prefix of a marker holds, so removing the longest matching tail
 * removes exactly the split marker's prefix and cannot expose a second one
 * behind it. Repeated, it would instead walk back over a run of
 * marker-shaped bytes a value spelled itself and delete them without
 * bound.
 *
 * The back-off is keyed on the marker's SHAPE, which a value's own
 * printable bytes can spell just as well -- the same open class the marker
 * itself has, costing the same three characters at most. Bounded to one,
 * it leaves a residual: kept text can still end in marker-shaped literal
 * characters, the value's own bytes shown faithfully rather than a marker
 * the treatment split.
 */
export function trimPartialControlCharacterMarker(text: string): string {
  return trimLongestTrailingPartial(
    text,
    PARTIAL_CONTROL_CHARACTER_MARKERS,
    LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER,
  );
}

/**
 * `text` with ONE trailing fragment of a marker the OPERATOR-supplied render
 * emits removed, the counterpart of {@link trimPartialControlCharacterMarker}
 * over that render's wider marker vocabulary
 * ({@link replaceUnrenderableForOperatorDisplay}).
 *
 * Every constraint that one states holds here unchanged, with one width to
 * read differently: a marker outside the control class is six characters, so
 * the back-off undershoots the budget by up to five rather than three.
 */
function trimPartialOperatorDisplayMarker(text: string): string {
  return trimLongestTrailingPartial(
    text,
    PARTIAL_OPERATOR_DISPLAY_MARKERS,
    LONGEST_PARTIAL_OPERATOR_DISPLAY_MARKER,
  );
}

/**
 * `text` with its longest tail that is a fragment in `partials` removed, the
 * walk both back-offs above take. `longest` is the widest fragment the set
 * holds, where the walk starts.
 */
function trimLongestTrailingPartial(
  text: string,
  partials: ReadonlySet<string>,
  longest: number,
): string {
  for (let length = Math.min(longest, text.length); length > 0; length -= 1)
    if (partials.has(text.slice(-length)))
      return text.slice(0, text.length - length);
  return text;
}

/**
 * `text` with ONE LEADING fragment of a control-character marker removed, for a
 * cut that kept the END of a value ({@link clipToRenderedCostKeepingEnd}); the
 * mirror of {@link trimPartialControlCharacterMarker} and bounded to one
 * fragment for the mirror of its reason. No proper suffix of a marker holds the
 * marker's opening `<`, so removing the longest matching head removes exactly
 * the split marker's tail and cannot expose a second one behind it.
 *
 * It leaves the same residual: kept text can still OPEN on marker-shaped
 * literal characters the value spelled itself, shown faithfully rather than
 * trimmed as a marker the cut split.
 */
export function trimPartialControlCharacterMarkerAtStart(text: string): string {
  for (
    let length = Math.min(
      LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIX,
      text.length,
    );
    length > 0;
    length -= 1
  )
    if (PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES.has(text.slice(0, length)))
      return text.slice(length);
  return text;
}

/**
 * What a RAW fragment costs once a display boundary escapes it, which is
 * not its own length: {@link sanitizeForDisplay} expands a code point
 * outside printable ASCII to as many as ten characters and doubles a
 * literal backslash, so budget arithmetic done on raw lengths under-counts.
 *
 * A composition site fitting its message to a display budget must keep its
 * fragments RAW, since the sink is the one altitude that escapes; this
 * measures what a fragment will cost there without escaping it itself --
 * the caller keeps the raw fragment, and this lives beside the escape it
 * measures so a policy change cannot leave a fitting caller counting the
 * old one.
 *
 * Counting the cost means materializing the escaped form, roughly ten
 * times the input at worst, so the fragment must be bounded BEFORE it is
 * measured: a path, an entry name, or a composed notice is the size this
 * is for, not an uncapped span of remote content.
 */
export function renderedDisplayCost(fragment: string): number {
  return sanitizeForDisplay(fragment, { maxLength: Infinity }).length;
}

/**
 * UTF-16 code units {@link boundRawFragmentForFit} keeps per character of the
 * budget its fit is taken against.
 *
 * Two, not one, even though no code unit escapes to FEWER than one output
 * character (printable ASCII is the floor, at one each): a fragment cut to
 * exactly the budget in printable ASCII renders at exactly the budget, which
 * {@link clipToRenderedCost} returns whole and unmarked, where the longer
 * fragment it was cut from would have been clipped and marked. At twice the
 * budget a cut fragment always renders past it, so the clip runs in both
 * cases and keeps the same prefix -- at most the budget less the truncation
 * marker, well inside the cut.
 */
export const RAW_FIT_CODE_UNITS_PER_BUDGET_CHARACTER = 2;

/**
 * `value` cut to the most UTF-16 code units a fit to `budget` can read, for a
 * caller holding a fragment nothing upstream has bounded -- a wire-frame
 * record key, bounded only by the transport's frame cap.
 * {@link clipToRenderedCost} materializes the whole escaped form to measure
 * it, so measuring such a fragment costs time and memory linear in what the
 * partner sent; cutting first makes both linear in the budget, and
 * {@link RAW_FIT_CODE_UNITS_PER_BUDGET_CHARACTER} keeps the fitted text
 * identical to the uncut fragment's when the cut still renders past
 * `budget` after redaction -- true of a private key alone, text ahead of
 * one, and plain text of any length.
 *
 * Cut BEFORE redaction, which is itself before the clip: a cut landing inside
 * a private-key block leaves a `BEGIN` marker whose `END` is gone, which
 * redaction's fail-closed dangling rule takes along with everything after it,
 * and a cut landing inside the marker itself keeps no key body at all -- the
 * body follows the marker. A complete key block followed by more text falls
 * outside that: redaction can shrink the cut fragment below `budget`, and
 * the fit then shows less of the trailing text than the uncut fragment
 * would, with no truncation marker to say so. No key material survives
 * either way.
 */
export function boundRawFragmentForFit(value: string, budget: number): string {
  return value.slice(0, RAW_FIT_CODE_UNITS_PER_BUDGET_CHARACTER * budget);
}

/**
 * Longest prefix of `value` whose {@link renderedDisplayCost} fits
 * `budget`, with {@link DISPLAY_TRUNCATION_MARKER} appended -- and paid for
 * out of that same budget -- when anything was dropped. This is how a
 * COMPOSITION SITE fits a fragment somebody else chose to a display
 * budget: the fragment stays raw for the sink's single escape, and what
 * the sink then renders is bounded by `budget` rather than by whatever the
 * sink's own cap happens to be.
 *
 * {@link sanitizeForDisplay}'s own `maxLength` does not serve here: it
 * appends the marker ON TOP of the cap, and it escapes, which is the
 * sink's job, not this one's (escaping at both altitudes doubles a literal
 * backslash on every pass -- CONTRIBUTING.md, Operator-facing escaping).
 *
 * `value` arrives raw, and a code point is kept only when its WHOLE
 * rendered cost fits, so the clip falls on a code-point boundary. A clip
 * that would end inside a marker a treatment already put in `value` backs
 * off to before it ({@link trimPartialControlCharacterMarker}), which is
 * why the budget is an upper bound rather than a width the result meets.
 *
 * Redact BEFORE clipping
 * ({@link ./sanitizeErrorForDisplay.redactPrivateKeyMaterial}), never
 * after: the marker is appended here, so a planted `BEGIN` marker left in
 * the kept prefix would consume it under the fail-closed dangling rule.
 *
 * The fit check materializes the escaped form to measure it, so this
 * bounds what a fragment RENDERS to, not what it costs to measure: a
 * caller holding a fragment nothing upstream has bounded is bounding a
 * display budget here, not a memory one, and takes
 * {@link boundRawFragmentForFit} for that.
 */
export function clipToRenderedCost(value: string, budget: number): string {
  if (renderedDisplayCost(value) <= budget) return value;
  const room = budget - DISPLAY_TRUNCATION_MARKER.length;
  let kept = "";
  let cost = 0;
  for (const ch of value) {
    const next = cost + renderedDisplayCost(ch);
    if (next > room) break;
    kept += ch;
    cost = next;
  }
  return `${trimPartialControlCharacterMarker(kept)}${DISPLAY_TRUNCATION_MARKER}`;
}

/**
 * Longest SUFFIX of `value` whose {@link renderedDisplayCost} fits `budget`,
 * with {@link DISPLAY_TRUNCATION_MARKER} in FRONT of it -- and paid for out of
 * that same budget -- when anything was dropped. The mirror of
 * {@link clipToRenderedCost}, for a fragment whose LAST bytes are the ones the
 * operator needs: a failing run writes its diagnosis last, so a cut taken from
 * the front deletes exactly what the fragment was shown for.
 *
 * Every constraint {@link clipToRenderedCost} states holds here unchanged --
 * `value` arrives raw for the sink's single escape, a code point is kept only
 * when its whole rendered cost fits, and redaction runs BEFORE the cut. The
 * back-off is the mirror too: a cut landing inside a control-character marker
 * already in `value` backs off to after it
 * ({@link trimPartialControlCharacterMarkerAtStart}), so the budget is an upper
 * bound rather than a width the result meets.
 */
export function clipToRenderedCostKeepingEnd(
  value: string,
  budget: number,
): string {
  if (renderedDisplayCost(value) <= budget) return value;
  const room = budget - DISPLAY_TRUNCATION_MARKER.length;
  const points = Array.from(value);
  let kept = "";
  let cost = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const next = cost + renderedDisplayCost(points[index]!);
    if (next > room) break;
    kept = `${points[index]!}${kept}`;
    cost = next;
  }
  return `${DISPLAY_TRUNCATION_MARKER}${trimPartialControlCharacterMarkerAtStart(kept)}`;
}

/**
 * Mark a note THIS CODEBASE composed as a {@link Displayable}, so the sink
 * renders it whole: fixed operator-facing copy, with any fragment somebody
 * else chose already put through {@link sanitizeForDisplay} where it was
 * interpolated.
 *
 * The slot exists because {@link DEFAULT_MAX_DISPLAY_LENGTH} is sized for one
 * untrusted fragment, not for a sentence: a note charged to it reaches the
 * operator cut mid-instruction, losing the half that says what to do. A note
 * marked here is charged to nothing, while the fragments inside it keep the
 * cap they were escaped under, so the bound still sits on the bytes somebody
 * else chose.
 *
 * What the mark claims is checked rather than taken: a note holding any code
 * point outside printable ASCII (U+0020-U+007E) is not the composition
 * described above -- first-party copy is ASCII, and so is what
 * {@link sanitizeForDisplay} returns -- so it is escaped and capped like any
 * unmarked value instead. That refuses the control class, the bidi overrides
 * and the confusables at this slot; what it does not bound is the length of
 * printable ASCII, which is the whole of the exemption. A fragment rendered
 * by {@link renderOperatorSuppliedText}, which keeps non-ASCII as the
 * operator typed it, is therefore not composable into a note: such a message
 * takes the standing escape.
 *
 * Use {@link displayText} instead wherever the copy fits a tagged template:
 * it accepts only a `Displayable` or a `number` between its fixed spans, so
 * it needs no check. This one takes the note as a string, for prose too long
 * to sit on one source line.
 */
export function firstPartyNote(text: string): Displayable {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) return sanitizeForDisplay(text);
  }
  return text as Displayable;
}

/**
 * Compose fixed first-party copy with already-sanitized values into a
 * {@link Displayable}, as a tagged template:
 * ``displayText`${fieldLabel} (${marker})` ``. Its result is exactly the
 * string the same template literal would have produced -- the tag adds no
 * bytes -- so it is the way to keep the brand across a composition, which
 * plain concatenation and interpolation drop (both yield `string`).
 *
 * What it will accept is what makes it a guarantee rather than a cast: the
 * fixed spans are the call site's own literal text, since only the
 * compiler produces a `TemplateStringsArray`, and every interpolated value
 * is either a {@link Displayable} or a `number` (always printable ASCII).
 * No partner-controlled string reaches the output without having gone
 * through {@link sanitizeForDisplay} first.
 *
 * The bound is the tagged-template call shape, not a proof about every
 * caller: a hand-built `TemplateStringsArray` passed as an ordinary
 * argument bypasses it, as does an `as Displayable` assertion. Both are
 * deliberate acts a reviewer sees, not the accidental omission this
 * guards against.
 */
export function displayText(
  fixedSpans: TemplateStringsArray,
  ...values: Array<Displayable | number>
): Displayable {
  let composed = fixedSpans[0];
  for (let index = 0; index < values.length; index += 1)
    composed += String(values[index]) + fixedSpans[index + 1];
  return composed as Displayable;
}
