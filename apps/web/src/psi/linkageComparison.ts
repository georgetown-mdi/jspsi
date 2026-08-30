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
 * where it accepts an absent property. A parsed document never carries one, but a
 * draft is live JavaScript objects the editor rebuilds, where a spread restates a
 * property that is not set as `undefined`. Such a key states what the offer states
 * and reads the same on every surface that displays it, so a compare answering
 * `false` for it drops the key's opt-in badge on the bench and the built terms'
 * rule-set citation -- a partner-visible provenance claim lost over a property
 * that says nothing.
 *
 * So the prune lives on this side of the boundary, where the values are drafts
 * rather than documents, and every membership compare the editor makes comes
 * through here rather than reaching for core's strict predicate directly: one
 * place answers for the whole class, not whichever call site is asked next.
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
 * Per entry rather than over the whole structure, because the callers hand these
 * compares an entire terms document: pruned in one call, a single value the prune
 * cannot read -- in a key, in a field, or anywhere else in the document -- costs
 * every clean rule beside it its prune, and so costs a document departing from the
 * built-in set in nothing but the spread its citation. Per entry, an unreadable
 * rule is the only one compared unpruned, which core answers as it answers any
 * value it cannot encode. */
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
 * keeps a citation honest over rules the editor let an operator edit. */
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
