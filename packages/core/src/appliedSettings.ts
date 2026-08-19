/**
 * Whether today's PSI exchange actually honors each setting an inviter can
 * propose: the `algorithm` (`psi-c`), `deduplicate`, and per-element
 * `generateFuzzyComparisons`. SINGLE SOURCE OF TRUTH read by the shared consent
 * summary both acceptance surfaces render (to flag a proposed-but-not-applied
 * setting), the web app's expert linkage-terms editor (to gate a control off and
 * to clamp the built terms), and its import path (to refuse a document that turns
 * one on), so they cannot diverge: a control wired selectable -- or a term built
 * or imported -- with a setting active while its flag is false would let an
 * operator mint an invitation whose headline behavior silently does not happen.
 *
 * `psiC` is the privacy footgun -- a selectable count-only (`psi-c`) setting while
 * the run still reveals matched identifiers would let an operator believe
 * identifiers are withheld when they are not, so the editor keeps it un-selectable
 * (and clamps it out of the built terms) and both consent surfaces flag a proposed
 * `psi-c`, until this flips. Matching is hard-wired one-to-one: a proposed
 * `deduplicate` is refused at the exchange boundary before the run, while fuzzy
 * expansion (`fuzzyComparisons`) is a silent no-op; the same flag-driven gating
 * applies to all three.
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
 * set for a fuzzy element. What is missing is downstream: a PSI round consumes
 * ONE value per record (`linkViaPSI` and `linkViaSinglePassPSI` refuse a
 * multi-candidate row, and take one value per row that they exclude when it
 * recurs locally), so several candidates per record have nowhere to go. Flipping this
 * flag must land with the round that consumes a candidate set -- including a
 * decision on how a record matching several partner records through different
 * candidates is attributed, which the current one-to-one accounting has no
 * answer for.
 *
 * `psiC` is the one flag the exchange boundary itself reads: the count-only run
 * path exists (`linkViaCountOnlyPSI`, `link.ts`), and `assertAlgorithmImplemented`
 * (`exchange.ts`) admits `psi-c` exactly while this flag is true -- so flipping it
 * is what makes a count-only exchange runnable, at the same moment it becomes
 * selectable on the acceptance surfaces. `deduplicate` is not there yet: the
 * exchange boundary refuses it regardless of this flag
 * (`assertDeduplicateImplemented` in `exchange.ts`, and the CLI invite mint
 * boundary), so an operator who reached such an exchange would have the run
 * aborted whatever this says, and that refusal must be replaced by the real
 * matching path in the change that flips it. The full psi-c ungate checklist
 * across web, CLI, and core is tracked on the product board under "Implement
 * count-only PSI".
 */
export const APPLIED_SETTINGS: {
  readonly psiC: boolean;
  readonly deduplicate: boolean;
  readonly fuzzyComparisons: boolean;
} = {
  psiC: false,
  deduplicate: false,
  fuzzyComparisons: false,
};
