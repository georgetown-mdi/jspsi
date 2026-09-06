import {
  APPLIED_SETTINGS,
  DEFAULT_LINKAGE_RULE_SET,
  authoredLinkageFields,
  decideLinkageTermsVerdict,
  getDefaultLinkageTerms,
  referencedLinkageFieldNames,
} from "@psilink/core";

import {
  isDraftDrawnFromLinkageRuleSet,
  linkageRuleSetReferenceForDraft,
} from "../linkageComparison";
import { payloadSendForMetadata } from "../metadataEditing";

import { outputForDirection } from "./advancedInviteTypes";

import type {
  BuiltInLinkageRuleSet,
  ExchangeDataSpec,
  LinkageField,
  LinkageKey,
  LinkageKeyFitness,
  LinkageRuleSetReference,
  LinkageTerms,
  Metadata,
  OwnColumnSelection,
  Standardization,
} from "@psilink/core";

import type { AdvancedInviteDraft, DraftKey } from "./advancedInviteTypes";

/**
 * The linkage-terms mapping: turn a draft into the {@link LinkageTerms} it
 * represents, and assemble the inviter's own {@link ExchangeDataSpec} from those
 * terms. Pure -- no validation. {@link validateAdvancedInvite} runs the built terms
 * through the core schema, which stays the single validation source.
 *
 * The rule-set citation an imported document keeps or loses is decided here too,
 * by {@link citationDropCause}; {@link importedCitationDropCause} exposes the loss
 * and its reason so the editor can say so before the document is emitted.
 *
 * The gated-setting clamp lives here: {@link buildAdvancedTerms} forces
 * deduplication and per-element fuzzy expansion to the applied behavior while
 * their {@link APPLIED_SETTINGS} flag is false, the structural half of the gate
 * that holds regardless of how the draft reached its state. The disabled editor
 * controls and the import refusal are the other layers.
 */

/** NFC-normalize and trim a free-text value. NFC is the cross-party canonical
 * form linkage-terms free text is compared in; trimming drops incidental
 * surrounding whitespace so a space-only value is treated as empty by the
 * schema's `.min(1)`. */
function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/** Whether `constraints` is an empty object (`{}`) -- a present key declaring nothing.
 * Its canonical form differs from an absent key, so the faithful import round-trip
 * preserves it verbatim for a field whose type has no default constraint rather than
 * dropping it, which would move the agreement hash and trip the refuse-on-import guard.
 * See {@link reconcileImportedFields}. */
function isEmptyConstraints(constraints: unknown): boolean {
  return (
    typeof constraints === "object" &&
    constraints !== null &&
    !Array.isArray(constraints) &&
    Object.keys(constraints).length === 0
  );
}

/**
 * The linkage fields an IMPORTED draft re-emits, reconciled against the imported
 * `linkageFields` declaration so an import-then-regenerate round-trip preserves its
 * field ORDER and any declared-but-unreferenced field. Drives {@link buildAdvancedTerms}
 * only when {@link AdvancedInviteDraft.importedLinkageFields} is set; the guided/expert/
 * seed paths keep the plain referenced-filter derivation. The four branches are handled
 * inline below; the empty-constraints type guard is the one non-obvious step.
 */
function reconcileImportedFields(
  imported: ReadonlyArray<LinkageField>,
  draftKeys: ReadonlyArray<DraftKey>,
  authored: ReadonlyArray<LinkageField>,
  referenced: ReadonlySet<string>,
): Array<LinkageField> {
  const authoredByName = new Map(authored.map((field) => [field.name, field]));
  const referencedByAnyKey = referencedLinkageFieldNames(
    draftKeys.map((entry) => entry.key),
  );
  const result: Array<LinkageField> = [];
  const emitted = new Set<string>();
  for (const field of imported) {
    if (referenced.has(field.name)) {
      const authoredField = authoredByName.get(field.name);
      // Not derivable from the inviter's columns: leave it undeclared so the
      // referencing key dangles and blocks (lockstep with declarableFieldNames).
      if (authoredField === undefined) continue;
      // Emit the editor's authored field (type-default constraints), except preserve a
      // benign empty `constraints: {}` verbatim -- and only when the imported field's
      // TYPE also agrees with the authored field's: the referential-integrity refine
      // checks a field's NAME only, so without this guard a type-confused field could be
      // committed with a type the inviter's column does not back. A type mismatch falls
      // through to the authored field.
      result.push(
        isEmptyConstraints(field.constraints) &&
          authoredField.constraints === undefined &&
          field.type === authoredField.type
          ? field
          : authoredField,
      );
      emitted.add(field.name);
    } else if (!referencedByAnyKey.has(field.name)) {
      // Declared but referenced by no key: inert, preserved verbatim.
      result.push(field);
      emitted.add(field.name);
    }
    // else: referenced only by a disabled key -> dropped (disable-and-show).
  }
  for (const field of authored) {
    if (referenced.has(field.name) && !emitted.has(field.name)) {
      result.push(field);
      emitted.add(field.name);
    }
  }
  return result;
}

/** Drop every element's `generateFuzzyComparisons`, returning the key unchanged
 * when none has one. The fuzzy half of the {@link buildAdvancedTerms} gating
 * clamp -- the built terms never propose a fuzzy expansion the run does not apply,
 * regardless of how an element acquired one. */
function stripFuzzy(key: LinkageKey): LinkageKey {
  if (key.elements.every((el) => el.generateFuzzyComparisons === undefined))
    return key;
  return {
    ...key,
    elements: key.elements.map((el) => {
      if (el.generateFuzzyComparisons === undefined) return el;
      const next = { ...el };
      delete next.generateFuzzyComparisons;
      return next;
    }),
  };
}

/**
 * The rule set an imported citation is checked against, resolved one half at a time:
 * {@link DEFAULT_LINKAGE_RULE_SET}'s own keys or fields where that half's name and
 * version match the built-in set, otherwise the document's own claimed rules for that
 * half. The two halves are composed under the document's reference, and
 * `isDraftDrawnFromLinkageRuleSet` judges fields and keys independently.
 */
function ruleSetForImportedCitation(
  cited: BuiltInLinkageRuleSet,
): BuiltInLinkageRuleSet {
  const shipped = shippedHalves(cited.reference);
  return {
    reference: cited.reference,
    linkageFields: shipped.fieldSet
      ? DEFAULT_LINKAGE_RULE_SET.linkageFields
      : cited.linkageFields,
    linkageKeys: shipped.keySet
      ? DEFAULT_LINKAGE_RULE_SET.linkageKeys
      : cited.linkageKeys,
  };
}

/** Which halves of `reference` name the set this build ships, each matched on that
 * half's name AND version -- the only halves it can resolve to rules of its own. */
function shippedHalves(reference: LinkageRuleSetReference): {
  fieldSet: boolean;
  keySet: boolean;
} {
  const builtIn = DEFAULT_LINKAGE_RULE_SET.reference;
  return {
    fieldSet:
      reference.fieldSet.name === builtIn.fieldSet.name &&
      reference.fieldSet.version === builtIn.fieldSet.version,
    keySet:
      reference.keySet.name === builtIn.keySet.name &&
      reference.keySet.version === builtIn.keySet.version,
  };
}

/**
 * Why an imported document's rule-set citation is not re-emitted over the rules a
 * draft rebuilds -- the three ways {@link buildAdvancedTerms} reaches the drop:
 *
 * - `shipped-set-unmet` -- the citation names a set this build ships, but the
 *   document's own rules never honored it, even after the editor's arrival-time
 *   narrowing (told apart from `rules-not-drawn` by the citation's
 *   `honoredAtImport` flag). No edit here restores it.
 * - `no-keys` -- the rebuilt rules declare no linkage key, so there is no
 *   provenance to claim. Re-enabling a key restores the citation, unless no key
 *   is supplyable.
 * - `rules-not-drawn` -- the rules honored the citation at import, but an edit
 *   here (a key edited, added, or reordered) took them out of the set. Undoing
 *   that edit restores the citation.
 */
export type ImportedCitationDropCause =
  "shipped-set-unmet" | "no-keys" | "rules-not-drawn";

/**
 * Whether `cited` is still re-emitted over `rules` -- the drop decision alone,
 * shared so {@link buildAdvancedTerms} and {@link citationDropCause} cannot
 * disagree about the outgoing document.
 *
 * Keyless rules are excluded here rather than in the predicate: they are drawn
 * from every set vacuously, so `isDraftDrawnFromLinkageRuleSet` alone would
 * re-emit a citation over a document asserting provenance for no key. A draft can
 * reach and export from that state (every key disabled), so this makes the same
 * exclusion `linkageRuleSetReferenceForDraft` makes on the derived branch.
 */
function citationStands(
  cited: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): boolean {
  return (
    rules.linkageKeys.length > 0 &&
    isDraftDrawnFromLinkageRuleSet(ruleSetForImportedCitation(cited), rules)
  );
}

/**
 * The cause `cited` is not re-emitted over `rules`, or `undefined` while it
 * stands ({@link citationStands}): the decision {@link buildAdvancedTerms}
 * applies and {@link importedCitationDropCause} reports, so the citation the
 * outgoing document holds and the notice the operator reads cannot disagree.
 *
 * `honoredAtImport` decides between the two has-keys causes: a citation the
 * import's own narrowed rules honored can only have been dropped by a later edit
 * (`rules-not-drawn`, undo the edit); one they never honored is the document's
 * own (`shipped-set-unmet`, no edit restores it). `shipped-set-unmet` is asked
 * only of a citation naming a set this build ships -- a citation naming no
 * shipped half resolves to the document's own rules, so it cannot fail the
 * arrival check and any later drop is `rules-not-drawn`.
 */
function citationDropCause(
  cited: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
  honoredAtImport: boolean,
): ImportedCitationDropCause | undefined {
  if (citationStands(cited, rules)) return undefined;
  if (rules.linkageKeys.length === 0) return "no-keys";
  const shipped = shippedHalves(cited.reference);
  return !honoredAtImport && (shipped.fieldSet || shipped.keySet)
    ? "shipped-set-unmet"
    : "rules-not-drawn";
}

/**
 * Why the draft's imported rule-set citation will not be re-emitted, or `undefined`
 * where it will be -- and for a draft that imported no document, or one whose
 * source cited nothing, which have no citation to lose.
 *
 * Read over the terms the draft currently builds, so it answers for the document
 * the editor would emit right now rather than for the one that was imported.
 * `builtTerms`, when given, is the caller's own `buildAdvancedTerms(draft)` result
 * for the same draft, passed to avoid rebuilding it here.
 */
export function importedCitationDropCause(
  draft: AdvancedInviteDraft,
  builtTerms?: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): ImportedCitationDropCause | undefined {
  const citation = draft.importedRuleSetCitation;
  if (citation?.kind !== "cited") return undefined;
  return citationDropCause(
    citation.ruleSet,
    builtTerms ?? buildAdvancedTerms(draft),
    citation.honoredAtImport,
  );
}

/**
 * Build the {@link LinkageTerms} a draft represents. `version` and `date`
 * come from the seed unchanged (the editor exposes no control for them);
 * `algorithm` and `deduplicate` come from the draft but are clamped to the
 * applied behavior while gated (see below); `linkageStrategy`, `identity`, the
 * `output` direction, and the optional legal agreement come from the draft (free
 * text NFC-normalized and trimmed); linkage keys are the enabled ones in draft
 * order, and linkage fields are filtered to those the enabled keys reference
 * (mirroring `getDefaultLinkageTerms`).
 *
 * The rule-set citation is re-decided against the built terms rather than
 * taken from the seed: an edited draft cites nothing, an unedited one still
 * cites the built-in set, and an IMPORTED draft re-emits its source document's
 * citation state for as long as the built rules are still drawn from the set it
 * names.
 *
 * Pure: it does not validate. {@link validateAdvancedInvite} runs the result
 * through the core schema, which stays the single validation source.
 */
export function buildAdvancedTerms(draft: AdvancedInviteDraft): LinkageTerms {
  // The recommended terms for the draft's CURRENT metadata, so a column type edit
  // re-derives the offerable fields/keys in lockstep with the grid. The base
  // contains the non-authored shape (version/date/algorithm/deduplicate); the draft
  // overrides identity, the output direction, the enabled keys, and the legal
  // agreement.
  const baseTerms = getDefaultLinkageTerms(draft.identity, draft.metadata);
  // Clamp deduplication and per-element fuzzy expansion to the applied behavior
  // while gated, so the built terms can never contain a setting the run does not yet
  // honor regardless of how the draft reached this state (a UI gap, an import) --
  // the structural half of the gate that holds even if the disabled controls or
  // import refusal are bypassed.
  const deduplicate = APPLIED_SETTINGS.deduplicate ? draft.deduplicate : false;
  const enabledKeys = draft.keys
    .filter((entry) => entry.enabled)
    .map((entry) =>
      APPLIED_SETTINGS.fuzzyComparisons ? entry.key : stripFuzzy(entry.key),
    );
  const referenced = referencedLinkageFieldNames(enabledKeys);
  // Derive the linkage fields from the authored standardization, not the
  // one-field-per-type default: a transformation per type declares its own field
  // (named by its output, bound to its input column), so two transformations of
  // one semantic type yield two distinct fields (maiden + current name). With no
  // authored cleaning this equals baseTerms.linkageFields byte-for-byte, so the
  // guided path's terms -- and the cross-party hash -- are unchanged.
  const authored = authoredLinkageFields(draft.metadata, draft.standardization);
  // The guided/expert/seed paths filter to the fields the enabled keys reference,
  // mirroring getDefaultLinkageTerms so disabling a key drops a now-unreferenced field.
  // An IMPORTED draft (draft.importedLinkageFields present) instead reconciles against
  // the imported declaration so the round-trip preserves its field ORDER and any
  // declared-but-unreferenced field, rather than re-emitting in the fixed authored
  // order and dropping the unreferenced ones (see reconcileImportedFields).
  const linkageFields =
    draft.importedLinkageFields === undefined
      ? authored.filter((field) => referenced.has(field.name))
      : reconcileImportedFields(
          draft.importedLinkageFields,
          draft.keys,
          authored,
          referenced,
        );

  const terms: LinkageTerms = {
    ...baseTerms,
    identity: normalizeText(draft.identity),
    // Unclamped, unlike its gated neighbors: the exchange honors both members, and
    // a count-only document outside the shape the specification admits is refused
    // by the count-only rules rather than narrowed here.
    algorithm: draft.algorithm,
    deduplicate,
    linkageStrategy: draft.linkageStrategy,
    output: outputForDirection(draft.outputDirection),
    linkageFields,
    linkageKeys: enabledKeys,
  };

  // The seed cites the built-in rule set; the draft may have edited its way out of
  // it (a key reordered, a field renamed). Re-decide the citation against what
  // this draft actually built rather than taking the seed's, so an edited draft
  // never claims a provenance it does not have.
  //
  // An IMPORTED document's citation is held rather than re-derived: a document
  // may cite a set this build does not ship, or decline to cite one at all, and
  // re-deriving would relabel the first or stamp a provenance on the second. The
  // import re-emits its own citation while the built rules are still drawn from
  // the set it cited (ruleSetForImportedCitation, citationStands -- the same
  // predicate citationDropCause reads to name the drop, so the citation emitted
  // here and the notice the editor shows on a drop cannot disagree).
  const importedCitation = draft.importedRuleSetCitation;
  const ruleSetReference =
    importedCitation === undefined
      ? linkageRuleSetReferenceForDraft(terms)
      : importedCitation.kind === "cited" &&
          citationStands(importedCitation.ruleSet, terms)
        ? importedCitation.ruleSet.reference
        : undefined;
  if (ruleSetReference !== undefined) terms.linkageRuleSet = ruleSetReference;
  else delete terms.linkageRuleSet;

  // Author terms.payload.send from the columns the draft metadata discloses, via the
  // shared payloadSendForMetadata derivation the quick path also uses (so the two
  // cannot drift). The send equals the disclosed set by construction, so it never
  // trips core's assertPayloadSendDisclosed. Emitted regardless of output direction so
  // the preview states accurately what transmits; the incoherent "send while only I
  // receive" case is blocked by validateAdvancedInvite, not by silently dropping the
  // still-transmitted columns from the declaration.
  const payload = payloadSendForMetadata(draft.metadata);
  if (payload !== undefined) terms.payload = payload;

  if (draft.legalAgreement !== undefined) {
    terms.legalAgreement = {
      reference: normalizeText(draft.legalAgreement.reference),
      purpose: normalizeText(draft.legalAgreement.purpose),
      // The date comes from a date input (YYYY-MM-DD), not free prose, so it is
      // not NFC-normalized; its format is validated by the schema and that it has
      // not already passed by validateAdvancedInvite.
      expirationDate: draft.legalAgreement.expirationDate.trim(),
    };
  }

  return terms;
}

/**
 * Filter a standardization to the transformations whose `output` names a field
 * the given terms declare. {@link buildAdvancedTerms} drops a disabled key's
 * now-unreferenced field from `linkageFields`, but the editable draft keeps that
 * field's (now inert) transformation so re-enabling the key restores its
 * cleaning; committing it into the inviter's own exchange would make
 * `prepareForExchange` fail closed (an output naming no linkage field). The drop
 * is lossless: an unbound transformation cleaned no matched value. Applied by
 * {@link inviterExchangeDataSpec} at the spec-assembly boundary, not in the
 * editor, so the draft retains the full authored cleaning across a
 * disable/re-enable.
 */
export function standardizationForTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): Standardization {
  const fieldNames = new Set(terms.linkageFields.map((field) => field.name));
  return standardization.filter((transformation) =>
    fieldNames.has(transformation.output),
  );
}

/** The inviter's edited per-party data settings, threaded into its own exchange
 * spec: the metadata and standardization it authored in the inviter console. Both
 * are absent on the quick (name-only) path, where they are inferred downstream.
 * The inviter analogue of `AcceptorDataEdits`. */
export interface InviterDataEdits {
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * Which of this party's own input columns its result file holds beside the
   * partner's values, already narrowed to terms that give it a result table to
   * write into -- the mint decides that once (`generateInvitation`), and every
   * surface holding a copy of a mint reads the decided value rather than
   * re-deciding it. Absent composes the result the partner's values alone make
   * up.
   */
  includeOwnColumns?: OwnColumnSelection;
}

/**
 * Assemble the inviter's {@link ExchangeDataSpec} for its own half of the
 * exchange -- the inviter analogue of `acceptorExchangeDataSpec`, and the
 * enforcement point for the invariant that an authored standardization names
 * only declared linkage fields. `prepareForExchange` fails closed on a
 * violation, so reconciling the standardization to `linkageTerms` HERE drops the
 * orphaned-output transformations any inviter flow can produce (a disabled
 * key's now-inert transformation, an import's default per-type seed) before
 * they reach core. It reconciles only that class; an unknown step function
 * stays refused by core's throw, the fail-closed safety check for any
 * contradiction this filter does not cover. See {@link standardizationForTerms}
 * for why the drop is lossless.
 *
 * The metadata, standardization, and own-column selection are per-party and
 * local; the terms are pinned to the invitation. Each is included only when
 * present, so the quick path (no authored cleaning) leaves core to infer them.
 */
export function inviterExchangeDataSpec(
  linkageTerms: LinkageTerms,
  edits?: InviterDataEdits,
): ExchangeDataSpec {
  return {
    linkageTerms,
    ...(edits?.metadata !== undefined && { metadata: edits.metadata }),
    ...(edits?.standardization !== undefined && {
      standardization: standardizationForTerms(
        edits.standardization,
        linkageTerms,
      ),
    }),
    ...(edits?.includeOwnColumns !== undefined && {
      includeOwnColumns: edits.includeOwnColumns,
    }),
  };
}

/**
 * The terms core grades a draft's authoring surface against: the AUTHORED fields
 * (not the one-field-per-type default) restated onto default terms, with the keys
 * the caller asks about. An authored same-typed second field (e.g. first_name_2) is
 * therefore judged on its own binding rather than the type's first match, which is
 * what the Generate gate grades on too. The identity is a constant because it never
 * affects the field or key set.
 */
function authoringProbeTerms(
  metadata: Metadata,
  standardization: Standardization,
  linkageKeys: ReadonlyArray<LinkageKey>,
): LinkageTerms {
  return {
    ...getDefaultLinkageTerms("", metadata),
    linkageFields: authoredLinkageFields(metadata, standardization),
    linkageKeys: [...linkageKeys],
  };
}

/**
 * How each of a draft's authored keys fares against the operator's columns, in
 * declaration order -- the per-key badge verdict, taken from core's own
 * classification ({@link decideLinkageTermsVerdict}) rather than re-derived, so a
 * badge cannot come to read `satisfiable` for a key the Generate gate, the mint,
 * and the run boundary all refuse.
 */
export function gradeAuthoredKeys(
  metadata: Metadata,
  standardization: Standardization,
  columns: ReadonlyArray<string>,
  linkageKeys: ReadonlyArray<LinkageKey>,
): Array<LinkageKeyFitness> {
  return decideLinkageTermsVerdict(
    [...columns],
    authoringProbeTerms(metadata, standardization, linkageKeys),
    standardization,
    metadata,
  ).keys.map((graded) => graded.fitness);
}
