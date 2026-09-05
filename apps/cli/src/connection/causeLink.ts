import {
  clipToRenderedCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
  redactPrivateKeyMaterial,
  renderedDisplayCost,
} from "@psilink/core";

/**
 * The single composition of a labelled cause link the bounded-transport
 * refusal builders share ({@link ./frameSizeGuard}, {@link ./listingGuard},
 * and {@link ./sftpLivenessGuard}): one label plus one fragment, fitted
 * where it is interpolated. Centralized so the order of the two transforms
 * -- redact, then clip -- is not re-derived, and gotten wrong, per site (see
 * {@link fittedCauseLink}).
 */

/**
 * What one labelled cause link may render to: the per-value display budget,
 * which is what a chooser's own value is budgeted at everywhere else. A link
 * holds its label plus one fragment and nothing else, so the whole of the link
 * is the two together.
 *
 * It is well under the per-link cap the renderer applies
 * (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`) by design: that cap is a
 * ceiling, not a quota, and each fragment fitted here is a value rather than a
 * composition, so the clip only ever bites a fragment that is itself the
 * anomaly. That each caller's fragments fit inside it at ordinary size is
 * asserted by apps/cli/test/unit/connection/transportRefusalBudget.test.ts.
 */
const CAUSE_LINK_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * Compose one labelled cause link, with `fragment` redacted and then fitted
 * to {@link CAUSE_LINK_VALUE_BUDGET} -- the label's own rendered cost
 * included -- at the composition site.
 *
 * Bounded HERE rather than at the display boundary because nothing upstream
 * bounds it -- a peer-supplied path, a charset-unconstrained configured one,
 * or text a hostile server chose -- and an unbounded value would spend the
 * renderer's whole-message cap instead of a per-value one.
 *
 * The order of the two transforms is critical: clipping first could leave a
 * `BEGIN` marker in the kept prefix for {@link clipToRenderedCost}'s
 * fail-closed dangling rule to consume. What is kept is raw and escaped once
 * where the error is rendered, so a hostile server's control or Unicode
 * characters are not escaped twice.
 */
export function fittedCauseLink(label: string, fragment: string): string {
  return `${label}${clipToRenderedCost(
    redactPrivateKeyMaterial(fragment),
    CAUSE_LINK_VALUE_BUDGET - renderedDisplayCost(label),
  )}`;
}
