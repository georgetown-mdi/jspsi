declare const displayableBrand: unique symbol;

/**
 * A string that has passed through the display boundary: what
 * {@link sanitizeForDisplay} returns and what {@link displayText} composes.
 * Declaring an operator-facing display field as `Displayable` rather than
 * `string` makes omitting the sanitize call a compile error instead of a review
 * catch -- a plain `string` (any partner-controlled value) is not assignable to
 * it. The brand is transparent in the other direction: a `Displayable` IS a
 * `string`, so renderers, logs, JSX text, and concatenation consume it with no
 * cast or unwrapping.
 *
 * The brand is a phantom property keyed by a module-private `unique symbol`, so
 * nothing outside this module satisfies it structurally: the two functions here
 * are the only way to obtain one, short of a deliberate `as Displayable`
 * assertion. It exists only in the type system -- no value carries the property
 * at runtime, and the branded string is byte-identical to the unbranded one.
 *
 * The brand marks a value as safe to SHOW AS TEXT, never as the value to use:
 * the display form is lossy and escaped, so a comparison, storage, or hashing
 * site still takes the raw string (see {@link sanitizeForDisplay}). "As text" is
 * the whole of the claim -- the sanitizer leaves every printable ASCII byte
 * intact, `<`, `>`, `&`, `"` and `'` among them, so a `Displayable` is safe in a
 * React text child because JSX escapes it there, and carries no HTML-,
 * attribute-, or URL-safety of its own.
 */
export type Displayable = string & { readonly [displayableBrand]: true };

/**
 * Marker appended by {@link sanitizeForDisplay} when a value is truncated. Plain
 * ASCII so the marker itself can never reintroduce a control or deceptive-Unicode
 * character into the sanitized output.
 */
export const DISPLAY_TRUNCATION_MARKER = "...[truncated]";

/**
 * Default cap on the number of output characters {@link sanitizeForDisplay}
 * emits before truncating (excluding the {@link DISPLAY_TRUNCATION_MARKER}). A
 * bounded, defensive cap on diagnostic strings -- not a wire bound (that belongs
 * at the transport read) -- so a pathologically long partner value cannot flood
 * an operator's log or UI through an error message.
 */
export const DEFAULT_MAX_DISPLAY_LENGTH = 256;

/**
 * Cap on the output characters a boundary emits for a whole composed WARNING,
 * above the per-value {@link DEFAULT_MAX_DISPLAY_LENGTH}.
 *
 * A warning is a COMPOSITION, not a value: first-party explanation and recovery
 * text around fragments each already escaped and capped where they were
 * interpolated. The per-value default is sized for one fragment, so applying it
 * to the composition truncates the composition's own instruction -- and the
 * cross-party host-key divergence warning is exactly the warning a supervisor
 * that discards stderr, or an operator watching a console seat, has nothing
 * else to read. The stderr log path delivers that warning whole; no other path
 * may deliver less of it.
 *
 * Three boundaries carry a whole warning message and take this cap rather than
 * the default, so none of the three re-caps what an earlier one delivered: the
 * CLI's fd-3 warning event, the console relay that re-validates that stream
 * (`validateAndSanitizeEvent`), and the console seat that renders it
 * (`appendSanitizedRunWarning`). A boundary carrying a single value keeps the
 * default -- including the CLI's stderr log of a composed terms-exchange
 * warning, which today interpolates only two date values and sits well under
 * it; a terms warning composed past the default would render cut there while
 * arriving whole on fd 3.
 *
 * Sized to admit that warning with every fragment at its own cap and escaped
 * again at each boundary it crosses (a further pass doubles an already-doubled
 * backslash), rather than to the length the copy happens to have. What holds the
 * size is the pair of checks that render the divergence warning with all four
 * fragments flooded -- both parties' key types and both fingerprints -- at the
 * fd-3 event and at the console seat, and fail unless its explanation and its
 * re-pin instruction both survive.
 */
export const WARNING_MESSAGE_MAX_DISPLAY_LENGTH = 4096;

/** Options for {@link sanitizeForDisplay}. */
export interface SanitizeForDisplayOptions {
  /**
   * Maximum number of output characters to emit before truncating and appending
   * {@link DISPLAY_TRUNCATION_MARKER}. This bounds the escaped output, not the
   * number of input code points: a single code point can escape to as many as
   * ten characters, so capping the input would let the output run to roughly ten
   * times this value. Defaults to {@link DEFAULT_MAX_DISPLAY_LENGTH}.
   */
  maxLength?: number;
}

/**
 * Sanitize an untrusted string for inclusion in operator-facing output (terminal,
 * logs, or UI). Intended for any string a mutually-distrusting remote party can
 * control that is then echoed to a human: linkage-terms diagnostics, the partner's
 * self-asserted identity, abort reasons, and -- in any future viewer -- the
 * cleartext governance free-text carried in an exchange record.
 *
 * Policy: every code point outside printable ASCII (U+0020-U+007E) is rewritten to
 * a visible `\xHH` / `\uHHHH` / `\u{HHHHH}` escape, and a literal backslash is
 * doubled so the escaping is unambiguous. This single rule neutralizes the whole
 * threat surface at once -- C0/C1 controls and the ESC that drives ANSI sequences,
 * line breaks usable for log-line spoofing, bidi overrides (RLO/LRO), zero-width
 * characters, and homoglyph/confusable characters (a Cyrillic `U+0430` renders
 * identically to a Latin "a"). The output is then truncated so its length never
 * exceeds `maxLength` (plus the marker); see {@link SanitizeForDisplayOptions}.
 *
 * The trade-off is fidelity for safety: legitimate non-ASCII text (accented names,
 * non-Latin scripts) is shown as escapes rather than rendered. That is intended for
 * untrusted operator-facing diagnostics, where seeing the exact bytes matters more
 * than pretty rendering, and there is no dependency-free way to neutralize
 * confusables without escaping non-ASCII broadly.
 *
 * Sanitize only at the display boundary, never the value used for comparison,
 * storage, or hashing: it is lossy (truncation collapses distinct long values, and
 * the result is an escaped display form, not the original bytes), and an exchange
 * record must retain the byte-exact value it signs and that both parties
 * cross-validate.
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
  // whole escape fits, so the output never ends mid-escape.
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

  return (truncated ? out + DISPLAY_TRUNCATION_MARKER : out) as Displayable;
}

/**
 * What a RAW fragment costs once a display boundary escapes it, which is not its
 * own length: {@link sanitizeForDisplay} expands a code point outside printable
 * ASCII to as many as ten characters and doubles a literal backslash, so budget
 * arithmetic done on raw lengths under-counts.
 *
 * A composition site that fits its message to a display budget has to keep its
 * fragments RAW, since the sink is the one altitude that escapes; this is how it
 * measures what a fragment will cost there without escaping it itself. Measuring
 * is not escaping -- the caller keeps the raw fragment -- and it lives beside the
 * escape it measures so a change to the escape policy cannot leave a fitting
 * caller counting the old one.
 */
export function renderedDisplayCost(fragment: string): number {
  return sanitizeForDisplay(fragment, { maxLength: Infinity }).length;
}

/**
 * Compose fixed first-party copy with already-sanitized values into a
 * {@link Displayable}, as a tagged template:
 * ``displayText`${fieldLabel} (${marker})` ``. Its result is exactly the string
 * the same template literal would have produced -- the tag adds no bytes -- so it
 * is the way to keep the brand across a composition, which plain concatenation
 * and interpolation drop (both yield `string`).
 *
 * What it will accept is what makes it a guarantee rather than a cast: the fixed
 * spans are the call site's own literal text, since only the compiler produces a
 * `TemplateStringsArray`, and every interpolated value is either a
 * {@link Displayable} or a `number` (whose string form is always printable
 * ASCII). No partner-controlled string reaches the output without having gone
 * through {@link sanitizeForDisplay} first.
 *
 * The bound is the tagged-template call shape, not a proof about every caller: a
 * hand-built `TemplateStringsArray` passed as an ordinary argument bypasses it,
 * as an `as Displayable` assertion bypasses the brand itself. Both are
 * deliberate acts a reviewer sees, which is the class of misuse this does not
 * try to stop; the accidental omission is.
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
