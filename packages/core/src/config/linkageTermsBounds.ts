/**
 * The entry-count bound the linkage-terms schema applies, declared apart from
 * the schema module.
 *
 * `fanOutFunctions.ts` derives `MAX_EFFECTIVE_KEY_COUNT` from it while the
 * module is evaluated, and `linkageTermsSchema.ts` reads that module's width
 * refusal in its refines. Declaring the bound in the schema module puts the
 * two in an evaluation cycle whose order decides whether the derivation reads
 * an initialized binding, so the bound sits below both instead.
 * `linkageTermsSchema.ts` re-exports it, which is where consumers read it.
 */

/**
 * Upper bound on the COUNT of entries in the `linkageFields` and
 * `linkageKeys` arrays, applied before per-element validation. The `.min(1)`
 * floor and the most-to-least-precise ordering of `linkageKeys` are
 * unaffected.
 */
export const MAX_LINKAGE_ENTRIES = 256;
