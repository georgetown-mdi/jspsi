/**
 * Whether today's PSI exchange actually honors each setting an inviter can
 * propose: the `algorithm` (`psi-c`), `deduplicate`, and per-element
 * `generateFuzzyComparisons`. SINGLE SOURCE OF TRUTH read by the consent summary
 * (to flag a proposed-but-not-applied setting), the expert linkage-terms editor
 * (to gate a control off and to clamp the built terms), and the import path (to
 * refuse a document that turns one on), so they cannot diverge: a control wired
 * selectable -- or a term built or imported -- with a setting active while its
 * flag is false would let an operator mint an invitation whose headline behavior
 * silently does not happen.
 *
 * `psiC` is the privacy footgun -- a selectable count-only (`psi-c`) setting while
 * the run still reveals matched identifiers would let an operator believe
 * identifiers are withheld when they are not, so the editor keeps it un-selectable
 * (and clamps it out of the built terms) and the consent screen flags a proposed
 * `psi-c`, until this flips. Matching is hard-wired one-to-one: a proposed
 * `deduplicate` is refused by core before the run (like `psi-c`, below), while
 * fuzzy expansion (`fuzzyComparisons`) is a silent no-op; the same flag-driven
 * gating applies to all three.
 *
 * Flip a flag to `true` when the exchange wires the feature in (tracked on the
 * product board); the editor control unlocks, the clamp and import refusal stop
 * firing, and the consent annotation disappears in lockstep, and the paired tests
 * fail loudly so nothing is left stale. Bare literals so they read as the single
 * source of truth; typed `boolean` (not the literal `false`) so a consumer's gate
 * reads as a genuine runtime branch, not provably dead code lint would flag the
 * moment a flag is meant to flip.
 *
 * For `psiC` and `deduplicate`, flipping the flag is NOT sufficient on its own:
 * core independently refuses each at the exchange boundary
 * (`assertAlgorithmImplemented` / `assertDeduplicateImplemented` in
 * `@psilink/core`, the latter also at the CLI invite mint boundary), so a web
 * operator who reached such an exchange would have the run aborted regardless of
 * this flag. Each refusal must be replaced by the real run path in the same
 * change. The full psi-c ungate checklist across web, CLI, and core is tracked on
 * the product board (item 208371871, "Implement count-only PSI").
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
