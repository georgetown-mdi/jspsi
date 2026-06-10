/**
 * Marker appended by {@link sanitizeForDisplay} when a value is truncated. Plain
 * ASCII so the marker itself can never reintroduce a control or deceptive-Unicode
 * character into the sanitized output.
 */
export const DISPLAY_TRUNCATION_MARKER = "...[truncated]";

/**
 * Default cap on the number of Unicode code points {@link sanitizeForDisplay}
 * retains. A bounded, defensive cap on diagnostic strings -- not a wire bound
 * (that belongs at the transport read) -- so a pathologically long partner value
 * cannot flood an operator's log or UI through an error message.
 */
export const DEFAULT_MAX_DISPLAY_LENGTH = 256;

/** Options for {@link sanitizeForDisplay}. */
export interface SanitizeForDisplayOptions {
  /**
   * Maximum number of Unicode code points to retain before truncating and
   * appending {@link DISPLAY_TRUNCATION_MARKER}. Defaults to
   * {@link DEFAULT_MAX_DISPLAY_LENGTH}.
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
 * characters, and homoglyph/confusable characters (a Cyrillic "a" renders as
 * `а`, not as a Latin "a"). The output is then truncated to a bounded length.
 *
 * The trade-off is fidelity for safety: legitimate non-ASCII text (accented names,
 * non-Latin scripts) is shown as escapes rather than rendered. That is intended for
 * untrusted operator-facing diagnostics, where seeing the exact bytes matters more
 * than pretty rendering, and there is no dependency-free way to neutralize
 * confusables without escaping non-ASCII broadly.
 *
 * Sanitize only at the display boundary, never the value used for comparison,
 * storage, or hashing: the escaping is not injective across all inputs, and an
 * exchange record must retain the byte-exact value it signs and that both parties
 * cross-validate.
 */
export function sanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_DISPLAY_LENGTH;

  // Iterate by code point (not UTF-16 unit) so astral characters and the length
  // cap are counted as a human would count them, and a lone surrogate is escaped
  // rather than split.
  const codePoints = Array.from(value);
  const truncated = codePoints.length > maxLength;
  const retained = truncated ? codePoints.slice(0, maxLength) : codePoints;

  let out = "";
  for (const ch of retained) {
    if (ch === "\\") {
      out += "\\\\";
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
    } else if (cp <= 0xff) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else if (cp <= 0xffff) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      out += "\\u{" + cp.toString(16) + "}";
    }
  }

  return truncated ? out + DISPLAY_TRUNCATION_MARKER : out;
}
