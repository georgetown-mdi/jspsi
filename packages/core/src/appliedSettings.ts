/**
 * Whether today's PSI exchange actually honors each setting an inviter can
 * propose that it does not yet apply: `deduplicate` and per-element
 * `generateFuzzyComparisons`. SINGLE SOURCE OF TRUTH read by the shared consent
 * summary both acceptance surfaces render (to flag a proposed-but-not-applied
 * setting), the web app's expert linkage-terms editor (to gate a control off and
 * to clamp the built terms), and its import path (to refuse a document that turns
 * one on), so they cannot diverge: a control wired selectable -- or a term built
 * or imported -- with a setting active while its flag is false would let an
 * operator mint an invitation whose headline behavior silently does not happen.
 *
 * The two are not alike in what not-applying them does. Matching is hard-wired
 * one-to-one, so a proposed `deduplicate` is refused at the exchange boundary
 * before the run (`assertDeduplicateImplemented`, `exchange.ts`, and the CLI
 * invite mint boundary); an operator who reached such an exchange would have the
 * run aborted whatever this says, and that refusal must be replaced by the real
 * matching path in the change that flips it. Fuzzy expansion is a silent no-op
 * instead. The same flag-driven gating applies to both.
 *
 * Flip a flag to `true` when the exchange wires the feature in (tracked on the
 * product board); the editor control unlocks, the clamp and import refusal stop
 * firing, and the consent annotation disappears in lockstep, and the paired tests
 * fail loudly so nothing is left stale. Bare literals so they read as the single
 * source of truth; typed `boolean` (not the literal `false`) so a consumer's gate
 * reads as a genuine runtime branch, not provably dead code lint would flag the
 * moment a flag is meant to flip.
 *
 * For `fuzzyComparisons`, flipping the flag is not sufficient either, for a
 * different reason. The expansion itself is implemented and gated on this flag
 * in `buildKeyStrings` (`standardization.ts`), which builds the whole candidate
 * set for a fuzzy element. What is missing is downstream: the one strategy that
 * matches a candidate set is single-pass, and it matches only the width a party's
 * declared terms and standardization account for, while
 * `declaredEffectiveKeyCount` (`fanOutFunctions.ts`) gives a fuzzy element no
 * candidate factor. So a fuzzy row overruns the value slots its own party
 * advertised and is refused as the index table is built, and under every other
 * strategy a multi-candidate row is refused outright. Flipping this flag must
 * land with the width factor fuzzy declares for itself -- and with a decision on
 * how a record matching several partner records through different candidates is
 * attributed, which the fan-out resolution rule settles for `split_on`
 * (docs/spec/PROTOCOL.md, Record-level resolution) and which fuzzy either
 * inherits or replaces.
 *
 * The count-only algorithm (`psi-c`) is NOT gated here: the exchange runs it
 * (`linkViaCountOnlyPSI`, `link.ts`), `assertAlgorithmImplemented` (`exchange.ts`)
 * admits it, and it is selectable on the authoring and acceptance surfaces. What
 * bounds it is the shape the specification admits (docs/spec/PROTOCOL.md, PSI-C),
 * enforced as its own refusals rather than as an applied-settings flag.
 */
export const APPLIED_SETTINGS: {
  readonly deduplicate: boolean;
  readonly fuzzyComparisons: boolean;
} = {
  deduplicate: false,
  fuzzyComparisons: false,
};
