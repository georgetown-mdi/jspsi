import { normalizeLinkageTermsText } from "./linkageTermsText";

/**
 * The single gate the accept screen consults before it commits an acceptance and
 * mounts the exchange UI. It returns the name to record only when the user has
 * BOTH explicitly consented to the displayed linkage terms and supplied a
 * non-empty name; otherwise it returns `undefined` and nothing starts.
 *
 * The invariant -- no rendezvous, key exchange, or PSI frame before explicit
 * consent -- is enforced here rather than by a button's `disabled` state, so it
 * holds independently of the UI wiring.
 *
 * The name is committed in the one form a linkage-terms document states typed
 * text in ({@link normalizeLinkageTermsText}), since it becomes this party's
 * `linkage_terms.identity`: one typed name reaches the agreed-terms hash, and
 * the identity a signing certificate is authorized against, as one string
 * whichever seat typed it.
 *
 * @returns the normalized name to record, or `undefined` if acceptance is not
 *          yet permitted.
 */
export function commitAcceptance(input: {
  consented: boolean;
  name: string;
}): string | undefined {
  const normalized = normalizeLinkageTermsText(input.name);
  if (!input.consented || normalized === "") return undefined;
  return normalized;
}
