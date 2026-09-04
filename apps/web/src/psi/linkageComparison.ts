import {
  encodeForComparison,
  isDrawnFromLinkageRuleSet,
  isOptInLinkageKey,
  linkageRuleSetReferenceFor,
} from "@psilink/core";

import type {
  BuiltInLinkageRuleSet,
  LinkageKey,
  LinkageRuleSetReference,
  LinkageTerms,
} from "@psilink/core";

/**
 * The rule-set membership questions the inviter's editor asks about DRAFT-side
 * values -- is this key an opt-in offer, are these rules drawn from the set they
 * cite, which citation are they entitled to -- each taken over the value with its
 * explicitly-`undefined` optional properties dropped.
 *
 * Core answers all three by byte equality under the canonical encoding, which the
 * signed document format depends on and which rejects an explicit `undefined`
 * where it accepts an absent property. The values these compares take are
 * DRAFT-side: live JavaScript objects the editor holds and rebuilds, not the
 * parsed documents the predicates are otherwise handed, so both spellings of "not
 * set" are representable. A key spelling it the second way states what the offer
 * states, so an unpruned compare would answer `false` for it and drop the key's
 * opt-in badge on the console and the built terms' rule-set citation.
 *
 * The prune closes that by making the difference unrepresentable at the compare.
 * No draft-editing helper and no import builds terms carrying an explicit
 * `undefined` (`advancedInviteTerms.test.ts`), which keeps the Generate gate's
 * canonical-encode dry run clear; that sweep does not reach the expert editor's
 * own key, alias, transform, and fuzzy callbacks, which the encode gate covers
 * instead.
 *
 * A `no-restricted-imports` ban in `apps/web/eslint.config.js` routes the
 * editor's membership compares through this module rather than core's predicate
 * directly, refusing an import of `encodeForComparison`, `isOptInLinkageKey`,
 * `isDrawnFromLinkageRuleSet`, or `linkageRuleSetReferenceFor` from
 * `@psilink/core` anywhere under `apps/web/src` but this module. It reads static
 * import and re-export specifiers -- a named import, a rename, a namespace
 * binding and a blanket re-export alike -- so a predicate reached through a
 * runtime `import()` is past it;
 * `scripts/eslint-linkage-comparison-ban.test.mjs` pins the shapes it refuses.
 *
 * The prune returns a value it drops nothing from by reference, so a parsed
 * document asked through these wrappers is the same value core would have been
 * handed directly: they are the whole import surface the ban leaves, and the
 * `advancedInvite` barrel the console imports re-exports all four.
 */

/**
 * `value` with every explicitly-`undefined` property dropped, recursively, and
 * every other value returned by reference.
 *
 * Only a plain object or an array is rebuilt, and only where the prune removed
 * something, so a value outside the canonical domain for any OTHER reason -- a
 * transform param beyond the safe integer range, a non-plain object, a
 * symbol-keyed property -- reaches the encoder as it stands and stays
 * incomparable.
 */
function withoutUndefinedProperties(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const prunedEntries = value.map(withoutUndefinedProperties);
    return prunedEntries.some((entry, at) => entry !== value[at])
      ? prunedEntries
      : value;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (Object.getOwnPropertySymbols(value).length > 0) return value;
  const pruned: Record<string, unknown> = {};
  let dropped = false;
  for (const [property, child] of Object.entries(value)) {
    if (child === undefined) {
      dropped = true;
      continue;
    }
    const prunedChild = withoutUndefinedProperties(child);
    dropped ||= prunedChild !== child;
    pruned[property] = prunedChild;
  }
  return dropped ? pruned : value;
}

/** `value` in the form the compares here take it: the
 * {@link withoutUndefinedProperties} prune, typed as the value itself since
 * dropping a property stated as `undefined` leaves a value of the same type -- a
 * type admitting the explicit `undefined` admits the absent property. */
function comparableForm<TValue>(value: TValue): TValue {
  try {
    return withoutUndefinedProperties(value) as TValue;
  } catch {
    // The prune reads every enumerable property, so a getter that throws escapes
    // here rather than into the encoder's own boundary guard -- and the guided
    // list asks these compares while rendering. Such a value is compared as it
    // stands, which is the answer core gives one it cannot encode.
    return value;
  }
}

/** `rules` in the form the structure-level compares take them: the
 * {@link comparableForm} prune applied per declared field and per key, over the
 * two rule arrays core compares and nothing else.
 *
 * The prune runs per entry rather than over the whole structure: an unreadable
 * value in one rule does not cost the prune on the rules beside it. An unreadable
 * rule alone is compared unpruned, which core answers as it answers any value it
 * cannot encode. */
function comparableRules(
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): Pick<LinkageTerms, "linkageFields" | "linkageKeys"> {
  return {
    linkageFields: rules.linkageFields.map((field) => comparableForm(field)),
    linkageKeys: rules.linkageKeys.map((key) => comparableForm(key)),
  };
}

/** `key` in the byte form the editor matches a draft key to an offer under: the
 * canonical encoding of the key as {@link comparableForm} states it, or `null`
 * when the key cannot be canonically encoded at all. */
export function encodeKeyForComparison(key: LinkageKey): string | null {
  return encodeForComparison(comparableForm(key));
}

/** Whether `key` is one of the opt-in offers rather than a key the built-in rule
 * set declares -- what the guided list's marker and the guidance beside it are
 * about. */
export function isOptInDraftKey(key: LinkageKey): boolean {
  return isOptInLinkageKey(comparableForm(key));
}

/** Whether the draft-built `rules` were drawn from `ruleSet`, the predicate that
 * keeps a citation accurate over rules the editor let an operator edit. */
export function isDraftDrawnFromLinkageRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): boolean {
  return isDrawnFromLinkageRuleSet(ruleSet, comparableRules(rules));
}

/** The citation the draft-built `rules` are entitled to: the built-in rule set's
 * reference where they were drawn from it, and `undefined` where they were not. */
export function linkageRuleSetReferenceForDraft(
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): LinkageRuleSetReference | undefined {
  return linkageRuleSetReferenceFor(comparableRules(rules));
}
