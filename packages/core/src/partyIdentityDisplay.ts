// The one place a missing party identity becomes text. `linkage_terms.identity`
// is optional (config/linkageTerms.ts); a party that gives no name gets this
// marker, never `undefined`, an empty cell, or a stand-in such as the account
// psilink runs as. Every sink that shows a party identity routes through here
// and displays the same marker, so it is treated as an absence, not a name.

import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import { displayText, sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";

import type { Displayable } from "./utils/sanitizeForDisplay.js";

/**
 * What a surface shows in place of a party's identity when the party supplied
 * none. Parenthesized and lower-case so it states an absence -- nobody gave a
 * name, and psilink did not pick one -- rather than filling in a name of its
 * own. Display cannot separate this marker from a party that named itself the
 * same text: `identity` is unauthenticated free text, so a forged marker
 * renders exactly like a genuine one. The record document can make that
 * distinction, structurally, by the field's presence rather than its value
 * (docs/spec/EXCHANGE_RECORD.md, The parties' identities).
 */
export const UNNAMED_PARTY_LABEL: Displayable = displayText`(no name given)`;

/**
 * A party's identity as display text: the label escaped for its sink, or
 * {@link UNNAMED_PARTY_LABEL} when the party named itself none.
 */
export function displayPartyIdentity(
  identity: string | undefined,
): Displayable {
  return identity === undefined
    ? UNNAMED_PARTY_LABEL
    : sanitizeForDisplay(identity);
}

/**
 * {@link displayPartyIdentity} for a log- or prompt-bound fragment, which takes
 * the secret-redaction pass ahead of the escape for the reason
 * {@link redactAndSanitizeForDisplay} states.
 */
export function redactAndDisplayPartyIdentity(
  identity: string | undefined,
): Displayable {
  return identity === undefined
    ? UNNAMED_PARTY_LABEL
    : redactAndSanitizeForDisplay(identity);
}
