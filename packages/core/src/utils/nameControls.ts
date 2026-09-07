/**
 * The characters no name may hold: the C0 controls (NUL, tab, line feed and
 * carriage return among them), DEL and the C1 controls, and the nine Unicode
 * bidirectional formatting characters {@link BIDI_CONTROL_PATTERN} names.
 *
 * None of them means anything in a name, and each is invisible where a name is
 * read. A control character can end the line a diagnostic or a CSV row is
 * composed of, and a bidirectional formatting character reorders the copy the
 * name is placed beside, so a consent or disclosure sentence can be made to
 * read as naming a different column from the one it acts on. A right-to-left or
 * mixed-direction label lays out correctly from its own letters, and letters are
 * untouched: an accented, CJK, or emoji name passes through whole.
 *
 * The same class both boundaries a name crosses act on: a CSV column header
 * loses these characters at ingestion (`file.ts`), and a linkage-terms name
 * field refuses them (`NAME_SHAPE_PATTERN`, `config/linkageTermsSchema.ts`), so
 * the two do not disagree about what a column may be called. The two are held
 * in step by a sweep over every BMP code point
 * (packages/core/test/config/nameShapeParity.test.ts), which fails if either
 * moves without the other.
 *
 * Written as escapes, never as raw bytes, so source about invisible characters
 * is itself readable.
 */
export const NAME_CONTROL_CHAR_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The nine Unicode bidirectional formatting characters that open a layout scope
 * outliving themselves: the embeddings and overrides U+202A LRE, U+202B RLE,
 * U+202C PDF, U+202D LRO, U+202E RLO, and the isolates U+2066 LRI, U+2067 RLI,
 * U+2068 FSI, U+2069 PDI (Unicode UAX #9). The half of
 * {@link NAME_CONTROL_CHAR_PATTERN} that `replaceControlCharactersForDisplay`
 * does not reach, since it replaces the Cc controls alone.
 *
 * The implicit marks U+200E LRM, U+200F RLM and U+061C ALM are outside this
 * class. They set a direction for the neutral text immediately around them and
 * open no scope, so they cannot reach past the name they sit in.
 *
 * Every code point here is in the General Punctuation block, so no letter of any
 * script is in the class.
 */
export const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;

/**
 * `value` with every {@link NAME_CONTROL_CHAR_PATTERN} character removed, and
 * `value` itself (by reference) when it holds none, so a caller can compare
 * identity to learn whether anything was removed.
 *
 * Split-and-join rather than a global `replace`, so the one pattern above is
 * both the membership test and the strip; a `/g` copy would be a second literal
 * to keep in step with it.
 */
export function stripNameControlChars(value: string): string {
  if (!NAME_CONTROL_CHAR_PATTERN.test(value)) return value;
  return value.split(NAME_CONTROL_CHAR_PATTERN).join("");
}
