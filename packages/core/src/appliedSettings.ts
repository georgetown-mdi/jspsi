/**
 * Whether today's PSI exchange actually honors each setting an inviter can
 * propose: `deduplicate` and per-element `generateFuzzyComparisons`. SINGLE
 * SOURCE OF TRUTH read by the shared consent summary both acceptance
 * surfaces render (to flag a proposed-but-not-applied setting), the web
 * app's expert linkage-terms editor (to gate a control off and to clamp
 * the built terms), and its import path (to refuse a document that turns
 * one on), so they cannot diverge: a control wired selectable, or a term
 * built or imported, with a setting active while its flag is false would
 * let an operator mint an invitation whose headline behavior silently does
 * not happen.
 *
 * `deduplicate` is applied: the cascade, the payload frame, the result
 * file, and the exchange record all hold the resolved multiplicity. What
 * is still refused is narrower than the setting -- the agreed both-sided
 * pair under `single-pass`, which pairs no `many-to-many`
 * (`assertBothSidedDeduplicateImplemented`, reached from
 * `resolveLinkageCardinality`) -- and is refused as that combination
 * rather than as the setting, so one party's `deduplicate: true` runs
 * under either strategy. `fuzzyComparisons` is not applied: expansion is
 * a silent no-op, not a refusal, and flipping this flag alone does not
 * complete the feature (docs/notes/one-sided-fuzzy-expansion.md).
 *
 * A key's `swap` term rides this same flag even though it is not
 * `generateFuzzyComparisons`: its full variant has the receiver build the
 * key in both orders (docs/notes/one-sided-fuzzy-expansion.md), which is
 * a candidate set like any other strategy but single-pass refuses. With
 * the flag false the receiver builds the exchanged order alone, so the
 * operator-facing "matched in either order" copy overstates the current
 * behavior.
 *
 * Typed `boolean`, not the literal values, so a consumer's gate is
 * treated as a genuine runtime branch rather than code a dead-code lint
 * would flag the moment a flag is meant to flip.
 *
 * The count-only algorithm (`psi-c`) is not gated here: it is implemented
 * (`linkViaCountOnlyPSI`, `link.ts`), admitted by
 * `assertAlgorithmImplemented` (`exchange.ts`), and selectable on both
 * surfaces. Its bound is the shape the specification admits
 * (docs/spec/PROTOCOL.md, PSI-C), enforced by its own refusals rather
 * than by an applied-settings flag.
 */
export const APPLIED_SETTINGS: {
  readonly deduplicate: boolean;
  readonly fuzzyComparisons: boolean;
} = {
  deduplicate: true,
  fuzzyComparisons: false,
};
