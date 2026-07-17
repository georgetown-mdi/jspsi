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
): string {
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

  return truncated ? out + DISPLAY_TRUNCATION_MARKER : out;
}
