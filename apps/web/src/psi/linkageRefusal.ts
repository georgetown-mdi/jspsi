/**
 * The console's one reading of core's linkage-terms verdict: whether a pre-launch
 * seat may proceed, and which refusal it states when it may not.
 *
 * Every console pre-launch moment -- the direct-exchange confirm screen, both
 * inviter mint gates, the advanced-invite editor's Generate gate, the acceptor's
 * columns step, and the managed run's input guard -- grades its own input through
 * core's `decideLinkageTermsVerdict` and refuses on the rule the run boundary
 * enforces inside `prepareForExchange`: at least one linkage key declared, and
 * every declared key satisfiable and live. No seat holds a threshold of its own,
 * so none can come to admit a file the run refuses.
 *
 * {@link linkageRefusalFor} returns the refusal or `undefined`, so a seat's gate
 * and the explanation it shows are one derivation rather than two that agree: the
 * seat has a refusal exactly when it blocks, and every refusal shape has copy
 * (`@components/UnlinkableFileAlert` for the seats that render an alert, the
 * seat's own blocked-reason sentence where the gate is a disabled button).
 */

import type { LinkageField, LinkageTermsVerdict } from "@psilink/core";

/**
 * Why a seat refuses to launch, discriminated so its copy is total over the
 * blocking shapes:
 *
 * - `"no-linkable-key"` -- the terms this input would run under declare no
 *   linkage key at all. Reached where the terms are DERIVED from the operator's
 *   own columns (the direct spine and the quick mint, which narrow the built-in
 *   rule set to the keys the columns support and can narrow all the way to none),
 *   so the remedy is a file holding the field types the built-in keys need.
 * - `"shortfall"` -- keys are declared, and this input falls short of at least one
 *   of them: a key whose fields the columns cannot produce, or one whose declared
 *   cleaning drops every record. The remedy is a conforming input or terms fixed
 *   with the partner out of band.
 */
export type LinkageRefusal =
  | {
      kind: "no-linkable-key";
      /** The linkage fields to name as missing, so the copy can say which field
       * types a conforming file holds. */
      missingFields: ReadonlyArray<LinkageField>;
    }
  | {
      kind: "shortfall";
      /** The verdict the shortfall is phrased from, so the counts a seat states
       * come from core's grading rather than a re-derivation. */
      verdict: LinkageTermsVerdict;
    };

/**
 * The refusal a verdict holds, or `undefined` when it permits the run.
 *
 * `missingFields` is not always the verdict's own `unsatisfiedFields`: a seat
 * whose terms are narrowed to the keys its columns support declares no field it
 * cannot produce, so the verdict reports none, and the seat passes the fields the
 * UNNARROWED rule set declares -- the field types a conforming file would hold.
 * A seat grading terms it did not derive passes `verdict.unsatisfiedFields`.
 */
export function linkageRefusalFor(
  verdict: LinkageTermsVerdict,
  missingFields: ReadonlyArray<LinkageField>,
): LinkageRefusal | undefined {
  if (verdict.fullySatisfied) return undefined;
  return verdict.keys.length === 0
    ? { kind: "no-linkable-key", missingFields }
    : { kind: "shortfall", verdict };
}
