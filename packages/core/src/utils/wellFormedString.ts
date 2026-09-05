/**
 * Index of the first UTF-16 code unit of `value` that is an unpaired
 * surrogate, or -1 when the string is well-formed. A lone surrogate is not a
 * Unicode scalar value and has no UTF-8 encoding, so RFC 8785 section 3.2.2.2
 * requires an implementation to terminate with an error rather than emit bytes
 * for it (see docs/spec/CANONICAL_ENCODING.md).
 *
 * The single reading of "well-formed" for the whole package: the canonical
 * encoder refuses such a string (utils/canonical.ts) and the linkage-terms
 * schema refuses a document holding one (config/linkageTermsSchema.ts), so
 * the boundary that rejects and the encoder that would have thrown cannot
 * disagree about which strings are encodable.
 *
 * A code-unit scan rather than `String.prototype.isWellFormed`, which is
 * ES2024 while this package compiles against the ES2022 lib.
 */
export function loneSurrogateIndex(value: string): number {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit >= 0xdc00) return index;
    // charCodeAt past the end is NaN, which fails this range test, so a high
    // surrogate in the final position is reported as unpaired.
    const next = value.charCodeAt(index + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return index;
    index++;
  }
  return -1;
}
