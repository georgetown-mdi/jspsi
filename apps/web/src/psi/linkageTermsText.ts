/**
 * The one rule a free-text value an operator typed takes on its way into a
 * linkage-terms document, shared by the two paths that author one: the inviting
 * seat's draft (`buildAdvancedTerms`) and the accepting seat's consent gate
 * (`commitAcceptance`).
 */

/**
 * NFC-normalize and trim a free-text value. NFC is the cross-party canonical
 * form linkage-terms free text is compared in; trimming drops incidental
 * surrounding whitespace so a space-only value is treated as empty by the
 * schema's `.min(1)`.
 *
 * A party's own `identity` takes it on both paths, so the name the agreed terms
 * state -- the value the terms hash covers and a signing certificate is
 * authorized against -- has one form whichever seat typed it.
 */
export function normalizeLinkageTermsText(value: string): string {
  return value.normalize("NFC").trim();
}
