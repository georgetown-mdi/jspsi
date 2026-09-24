import {
  assertAlgorithmImplemented,
  assertCountOnlyTransmitsNoColumn,
  assertDeduplicateImplemented,
  assertFanOutImplemented,
  assertPayloadSendDisclosed,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
} from "@alcove/core";
import type { LinkageTerms, Metadata, Standardization } from "@alcove/core";

/**
 * Refuse linkage terms that an `alcove exchange` run from a configuration
 * holding them, beside that configuration's own `metadata` and
 * `standardization`, would refuse before it sends anything. Run where terms
 * leave or enter a configuration without an exchange to check them -- an
 * offline invitation minted from the configuration, a terms update made from
 * it, and a terms update applied to it -- so neither party consents to terms
 * whose first run is refused.
 *
 * The metadata and standardization checks run only where the configuration
 * holds an explicit block: without one the run infers it from the input file,
 * which none of these commands reads.
 *
 * @throws {UsageError} naming the rule the terms break.
 */
export function assertConfigTermsRunnable(
  terms: LinkageTerms,
  local: { metadata?: Metadata; standardization?: Standardization },
): void {
  const { metadata, standardization } = local;
  // Ahead of the payload-disclosure check, so a count-only configuration whose
  // metadata transmits a column is told the specific rule it breaks.
  assertCountOnlyTransmitsNoColumn(terms.algorithm, metadata);
  // A payload.send that misstates what the metadata transmits would put a
  // dictionary on the partner's consent display that the run does not honor.
  if (metadata !== undefined)
    assertPayloadSendDisclosed(terms.payload, metadata, terms.output);
  if (standardization !== undefined)
    assertStandardizationMatchesTerms(standardization, terms);
  assertAlgorithmImplemented(terms.algorithm);
  assertDeduplicateImplemented(terms);
  assertFanOutImplemented(terms, standardization);
  // A step whose compile throws aborts the run only once the pipeline is
  // built, after the partner has agreed to the terms naming it.
  assertTransformsCompile(terms, standardization);
}
