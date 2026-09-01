import {
  clipToRenderedCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
  redactPrivateKeyMaterial,
  renderedDisplayCost,
} from "@psilink/core";

/**
 * The single composition of a labelled cause link the bounded-transport refusal
 * builders share ({@link ./frameSizeGuard}, {@link ./listingGuard}, and
 * {@link ./sftpLivenessGuard}). Each of those refusals gives every fragment
 * somebody else chose a labelled link of its own, so what those builders have in
 * common is one label plus one value, fitted where it is interpolated. Holding
 * that in one place is what keeps the ORDER of the two transforms -- redact,
 * then clip -- from being re-derived per site, which is the way it silently
 * comes out wrong (see {@link fittedCauseLink}).
 */

/**
 * What one labelled cause link may render to: the per-value display budget,
 * which is what a chooser's own value is budgeted at everywhere else. A link
 * carries its label plus one fragment and nothing else, so the whole of the link
 * is the two together.
 *
 * It is well under the per-link cap the renderer applies
 * (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`), which is deliberate: that cap is a
 * ceiling, not a quota, and each fragment fitted here is a value rather than a
 * composition, so the clip only ever bites a fragment that is itself the
 * anomaly. That each caller's fragments fit inside it at ordinary size is
 * asserted by apps/cli/test/unit/transportRefusalBudget.test.ts.
 */
const CAUSE_LINK_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * Compose one labelled cause link, with `fragment` redacted and then fitted to
 * {@link CAUSE_LINK_VALUE_BUDGET} -- the label's own rendered cost included --
 * at the composition site.
 *
 * The fragment is bounded HERE rather than at the display boundary because
 * nothing upstream bounds it: each caller's is a peer-supplied path, a
 * charset-unconstrained configured one, or the text a hostile server chose. A
 * value that reaches the renderer unbounded spends whatever the renderer's own
 * cap allows, which is the budget sized for a whole composed message rather than
 * for one value.
 *
 * The order of the two transforms is load-bearing: the clip appends the
 * truncation marker itself, so a `BEGIN` marker left in the kept prefix would
 * consume it under the display boundary's fail-closed dangling rule (see
 * {@link clipToRenderedCost}). What is kept is raw, and is escaped once where
 * the error is rendered, so a hostile server's control/ANSI or deceptive-Unicode
 * characters are neutralized at that boundary rather than here, where escaping
 * them would leave the sink to escape them a second time.
 */
export function fittedCauseLink(label: string, fragment: string): string {
  return `${label}${clipToRenderedCost(
    redactPrivateKeyMaterial(fragment),
    CAUSE_LINK_VALUE_BUDGET - renderedDisplayCost(label),
  )}`;
}
