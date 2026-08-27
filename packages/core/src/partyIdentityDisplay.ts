// The one place a missing party identity becomes text. `linkage_terms.identity`
// is optional (config/linkageTerms.ts): a party that supplied no name sends
// none, and psilink stands in nothing -- not the account it runs as, not a
// placeholder posing as a name. A surface that rendered `undefined`, an empty
// cell, or a locally-chosen stand-in would either lose the fact or assert one, so
// every sink that shows a party identity routes through here and shows the same
// marker, which reads as an absence rather than as a name.

import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import { displayText, sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";

import type { Displayable } from "./utils/sanitizeForDisplay.js";

/**
 * What a surface shows in place of a party's identity when the party supplied
 * none. Parenthesized and lower-case so it cannot be mistaken for the name
 * itself, and it states what happened rather than the field being empty: nobody
 * gave a name, and psilink did not pick one.
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
