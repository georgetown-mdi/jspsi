/**
 * Whether today's PSI exchange actually honors each setting an inviter can
 * propose: `deduplicate` and per-element `generateFuzzyComparisons`. SINGLE
 * SOURCE OF TRUTH read by the shared consent summary both acceptance surfaces
 * render (to flag a proposed-but-not-applied setting), the web app's expert
 * linkage-terms editor (to gate a control off and to clamp the built terms), and
 * its import path (to refuse a document that turns one on), so they cannot
 * diverge: a control wired selectable -- or a term built or imported -- with a
 * setting active while its flag is false would let an operator mint an invitation
 * whose headline behavior silently does not happen.
 *
 * `deduplicate` is applied: the cascade matches the per-side rules the resolved
 * cardinality names, and the payload frame, the result file, and the exchange
 * record carry the multiplicity with it. What stays refused is narrower than the
 * setting -- the agreed both-sided pair under `single-pass`, which pairs no
 * `many-to-many` -- and is refused as that combination rather than as the setting
 * (`assertBothSidedDeduplicateImplemented`, reached from
 * `resolveLinkageCardinality`), so this flag does not carry it: one party's
 * `deduplicate: true` runs under either strategy. Fuzzy expansion is not applied,
 * and its not-applying is a silent no-op rather than a refusal.
 *
 * Flip a flag to `true` when the exchange wires the feature in (tracked on the
 * product board); the editor control unlocks, the clamp and import refusal stop
 * firing, and the consent annotation disappears in lockstep, and the paired tests
 * fail loudly so nothing is left stale. Bare literals so they read as the single
 * source of truth; typed `boolean` (not the literal values) so a consumer's gate
 * reads as a genuine runtime branch, not provably dead code lint would flag the
 * moment a flag is meant to flip.
 *
 * For `fuzzyComparisons`, flipping the flag is not sufficient on its own. The
 * expansion is implemented and gated on this flag in `buildKeyStrings`
 * (`standardization.ts`), which builds the role-keyed candidate set for a fuzzy
 * element, and so is the width a fuzzy key declares (`declaredKeyWidth`,
 * `fanOutFunctions.ts`), which is what a multi-candidate row needs slots for under
 * single-pass. What is still missing is downstream. The one strategy that matches
 * a candidate set is single-pass, and under every other strategy a multi-candidate
 * row is refused outright -- with the flag on, a fuzzy element's declared width
 * refuses the whole exchange off single-pass
 * (`assertDeclaredWidthMatchesStrategy`, `exchange.ts`), which diagnoses it as a
 * width rather than as the fuzzy term it is. And a record matching several partner
 * records through different candidates needs an attribution rule, which the
 * fan-out resolution settles for `split_on` (docs/spec/PROTOCOL.md, Record-level
 * resolution) and which fuzzy either inherits or replaces.
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
  deduplicate: true,
  fuzzyComparisons: false,
};
