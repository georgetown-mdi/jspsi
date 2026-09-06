/**
 * The nine Unicode bidirectional formatting characters that open a layout scope
 * outliving themselves: the embeddings and overrides U+202A LRE, U+202B RLE,
 * U+202C PDF, U+202D LRO, U+202E RLO, and the isolates U+2066 LRI, U+2067 RLI,
 * U+2068 FSI, U+2069 PDI (Unicode UAX #9).
 *
 * A name holding one of these reorders the copy it is placed beside, so a
 * consent or disclosure sentence can be made to read as naming a different
 * column from the one it acts on. Nothing legitimate in a name -- a CSV column
 * header, a linkage terms name-class field -- needs one: a right-to-left or
 * mixed-direction label lays out correctly from its own characters.
 *
 * The implicit marks U+200E LRM, U+200F RLM and U+061C ALM are outside this
 * class. They set a direction for the neutral text immediately around them and
 * open no scope, so they cannot reach past the name they sit in.
 *
 * Letters are untouched: every code point here is in the General Punctuation
 * block, so an accented, CJK, or emoji name passes through whole.
 *
 * Written as escapes, never as raw bytes, so source about invisible characters
 * is itself readable.
 */
export const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;

/**
 * `value` with every {@link BIDI_CONTROL_PATTERN} character removed, and `value`
 * itself (by reference) when it holds none, so a caller can compare identity to
 * learn whether anything was removed.
 *
 * Split-and-join rather than a global `replace`, so the one pattern above is
 * both the membership test and the strip; a `/g` copy would be a second literal
 * to keep in step with it.
 */
export function stripBidiControls(value: string): string {
  if (!BIDI_CONTROL_PATTERN.test(value)) return value;
  return value.split(BIDI_CONTROL_PATTERN).join("");
}
