import {
  APPLIED_SETTINGS,
  DEFAULT_LINKAGE_RULE_SET,
  assessLinkageSatisfiability,
  authoredLinkageFields,
  getDefaultLinkageTerms,
  isDrawnFromLinkageRuleSet,
  linkageRuleSetReferenceFor,
  referencedLinkageFieldNames,
} from "@psilink/core";

import { outputForDirection } from "./advancedInviteTypes";
import { payloadSendForMetadata } from "./metadataEditing";

import type {
  BuiltInLinkageRuleSet,
  ExchangeDataSpec,
  LinkageField,
  LinkageKey,
  LinkageRuleSetReference,
  LinkageTerms,
  Metadata,
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
 * surrounding whitespace so a space-only value reads as empty to the schema's
 * `.min(1)`. */
function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/** Whether `constraints` is an empty object (`{}`) -- a present key declaring nothing.
 * An empty `{}` is behaviorally identical to absent constraints (core's
 * `checkValueConstraints` flags nothing for it; it never affects matching), but its
 * canonical form differs from an absent key, so the faithful import round-trip preserves
 * it verbatim for a field whose type has no default constraint rather than dropping it --
 * which would move the agreement hash and trip the refuse-on-import guard. See
 * {@link reconcileImportedFields}. */
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
      // Emit the editor's authored field (type-default constraints), EXCEPT preserve a
      // benign empty `constraints: {}` verbatim -- but only when the imported field also
      // agrees with the authored field's TYPE. This is the one place a referenced field
      // is emitted from the imported declaration rather than re-derived, so without the
      // type guard a schema-valid name/type-confused field (the referential-integrity
      // refine checks a field's NAME only, so a `date_of_birth`-named field can be typed
      // `ssn`) would be committed with a type the inviter's column does not back --
      // binding the two parties' key element to different-typed columns -- and slip
      // importedConstraintDivergenceMessage. A type mismatch falls through to the
      // authored field, so that guard refuses the divergence as it did before this fix.
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
 * when none carries one. The fuzzy half of the {@link buildAdvancedTerms} gating
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
 * {@link DEFAULT_LINKAGE_RULE_SET}'s own keys where the citation's key-set half names
 * the built-in key set, its own fields where the field-set half names the built-in
 * field set -- each matched on that half's name and version, the only halves this
 * build can resolve -- and otherwise the rules the importing document claimed for the
 * set it named, which is all there is to check a name this build cannot resolve
 * against. The two chosen halves are composed under the document's own reference, and
 * `isDrawnFromLinkageRuleSet` judges fields and keys independently.
 *
 * The substitution is what keeps psilink from re-emitting its OWN set's name over rules
 * that are not that set. A partner document is free to cite the built-in name over
 * anything, but the build that ships those rules knows what they are, so it re-emits the
 * name only over rules drawn from them; a name it cannot resolve keeps the round-trip
 * fidelity behavior instead. Resolving per half is what the design that names, versions,
 * and edits the halves separately requires: pairing one built-in name with a foreign one
 * would otherwise buy the built-in half a pass it could not earn alone.
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
 * draft rebuilds -- the three ways {@link buildAdvancedTerms} reaches the drop,
 * which an operator needs told apart because the remedy differs:
 *
 * - `shipped-set-unmet` -- the citation names a set this build ships and the
 *   DOCUMENT's own rules are not that set's, so the citation never described the
 *   rules it arrived over. Nothing edited here reaches or undoes it.
 * - `no-keys` -- the rebuilt rules declare no linkage key, so there is no
 *   provenance to claim. Re-enabling a key restores the citation.
 * - `rules-not-drawn` -- the rebuilt rules are not drawn from the cited set: a key
 *   edited, added, or reordered out of it. Undoing that edit restores the citation.
 */
export type ImportedCitationDropCause =
  "shipped-set-unmet" | "no-keys" | "rules-not-drawn";

/**
 * The cause `cited` is not re-emitted over `rules`, or `undefined` while it stands:
 * the one decision {@link buildAdvancedTerms} applies and
 * {@link importedCitationDropCause} reports, so the citation the outgoing document
 * carries and the notice the operator reads cannot disagree.
 *
 * Whether the citation goes is settled first and alone, by the two conditions
 * below; only then is the cause chosen. Naming a cause never costs a document its
 * citation -- an import whose offending key the editor disabled rebuilds rules that
 * ARE drawn from the set, and it keeps the citation it would have kept with nothing
 * said. The order within the drop is root cause first: a citation the document's
 * own rules never met is not a state an edit here reached, and the remedies the
 * other two causes offer would be instructions that cannot work.
 *
 * The keyless condition sits beside the predicate rather than inside it: keyless
 * rules are drawn from every set vacuously, so `isDrawnFromLinkageRuleSet` alone
 * would re-emit a citation over a document carrying none of the keys it asserts
 * provenance for -- including one whose leftover imported field declarations
 * survive their keys. The draft reaches that state as an intermediate (disabling
 * every key), and the built terms can leave the browser from there via the terms
 * export, so exclude it here -- the same exclusion `linkageRuleSetReferenceFor`
 * makes on the derived branch.
 */
function citationDropCause(
  cited: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): ImportedCitationDropCause | undefined {
  const resolved = ruleSetForImportedCitation(cited);
  const declaresNoKeys = rules.linkageKeys.length === 0;
  if (!declaresNoKeys && isDrawnFromLinkageRuleSet(resolved, rules))
    return undefined;
  // Dropped -- now why. Judge the document's OWN rules against the same resolved
  // set: where a half names a set this build ships, that is the check the citation
  // had to pass on arrival, so failing it is a fault of the document rather than of
  // anything done here. A citation naming no shipped half resolves to the
  // document's own rules and cannot fail against them, so the question is asked
  // only of a shipped half; asked of the predicate alone it would file a
  // canonically incomparable foreign document under this cause. The two arrays are
  // copied only to meet the predicate's parameter type, the terms' mutable pair.
  const shipped = shippedHalves(cited.reference);
  if (
    (shipped.fieldSet || shipped.keySet) &&
    !isDrawnFromLinkageRuleSet(resolved, {
      linkageFields: [...cited.linkageFields],
      linkageKeys: [...cited.linkageKeys],
    })
  )
    return "shipped-set-unmet";
  return declaresNoKeys ? "no-keys" : "rules-not-drawn";
}

/**
 * Why the draft's imported rule-set citation will not be re-emitted, or `undefined`
 * where it will be -- and for a draft that imported no document, or one whose
 * source cited nothing, which have no citation to lose.
 *
 * Read over the terms the draft currently builds, so it answers for the document
 * the editor would emit right now rather than for the one that was imported.
 */
export function importedCitationDropCause(
  draft: AdvancedInviteDraft,
): ImportedCitationDropCause | undefined {
  const citation = draft.importedRuleSetCitation;
  if (citation?.kind !== "cited") return undefined;
  return citationDropCause(citation.ruleSet, buildAdvancedTerms(draft));
}

/**
 * Build the {@link LinkageTerms} a draft represents. `version` and `date` are
 * carried from the seed unchanged (the editor exposes no control for them, so a
 * draft cannot alter them); `algorithm` and `deduplicate` come from the draft but
 * are clamped to the applied behavior while gated (see below); `linkageStrategy`,
 * `identity`, the `output` direction, and the optional legal agreement come from
 * the draft (free text NFC-normalized and trimmed); linkage keys are the enabled
 * ones in draft order,
 * and linkage fields are filtered to those the enabled keys reference (mirroring
 * `getDefaultLinkageTerms`, so disabling a key drops a now-unreferenced field).
 * The rule-set citation is re-decided against the built terms rather than carried
 * from the seed, so an edited draft cites nothing and an unedited one still cites
 * the built-in set; an IMPORTED draft instead re-emits its source document's
 * citation state, whether that document cited a set or none, for as long as the
 * built rules are still drawn from the set that citation names.
 *
 * Pure: it does not validate. {@link validateAdvancedInvite} runs the result
 * through the core schema, which stays the single validation source.
 */
export function buildAdvancedTerms(draft: AdvancedInviteDraft): LinkageTerms {
  // The recommended terms for the draft's CURRENT metadata, so a column type edit
  // re-derives the offerable fields/keys in lockstep with the grid. The base
  // carries the non-authored shape (version/date/algorithm/deduplicate); the draft
  // overrides identity, the output direction, the enabled keys, and the legal
  // agreement.
  const baseTerms = getDefaultLinkageTerms(draft.identity, draft.metadata);
  // Clamp deduplication and per-element fuzzy expansion to the applied behavior
  // while gated, so the built terms can never carry a setting the run does not yet
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
  // (named by its output, bound to its input column), so two transformations of one
  // semantic type yield two distinct fields (maiden + current name). With no authored
  // cleaning this equals baseTerms.linkageFields byte-for-byte (the seed's
  // standardization is getDefaultStandardization, whose outputs are the default field
  // names), so the guided path's terms -- and the cross-party hash -- are unchanged.
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

  // The seed cites the built-in rule set, and the draft may have edited its way
  // out of it -- a key reordered, a field renamed by an authored cleaning. Re-decide
  // the citation against what this draft actually built rather than carrying the
  // seed's: a citation over edited rules would claim a provenance they do not have.
  // A guided draft that changed none of them still cites the set, which is what
  // keeps the guided path's terms (and the acceptor's reading of them) unchanged.
  //
  // An IMPORTED document's citation is carried rather than re-derived, on the same
  // round-trip-fidelity grounds the imported field declaration is re-emitted on: a
  // document may cite a set this build does not ship, and a document may decline to
  // cite one at all -- re-deriving would relabel the first and stamp a provenance on
  // the second its author declined, moving the terms hash in both directions. So the
  // import re-emits its own citation while the built rules are still drawn from the
  // set it cited (narrowing by disabling a key keeps it, editing or adding one drops
  // it), and an import that cited nothing emits nothing whatever its rules match.
  // Which rules "the set it cited" means is ruleSetForImportedCitation's answer, taken
  // one half at a time: the built-in half's own rules where the citation names it, the
  // document's claim for that half otherwise. The whole condition is citationDropCause's,
  // so the citation emitted here and the notice the editor shows when it is dropped
  // cannot disagree.
  const importedCitation = draft.importedRuleSetCitation;
  const ruleSetReference =
    importedCitation === undefined
      ? linkageRuleSetReferenceFor(terms)
      : importedCitation.kind === "cited" &&
          citationDropCause(importedCitation.ruleSet, terms) === undefined
        ? importedCitation.ruleSet.reference
        : undefined;
  if (ruleSetReference !== undefined) terms.linkageRuleSet = ruleSetReference;
  else delete terms.linkageRuleSet;

  // Author terms.payload.send from the columns the draft metadata discloses, via the
  // shared payloadSendForMetadata derivation the quick path also uses (so the two
  // cannot drift). The send equals the disclosed set by construction, so it never
  // trips core's assertPayloadSendDisclosed. Emitted regardless of output direction so
  // the preview states honestly what transmits; the incoherent "send while only I
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
 * Filter a standardization to the transformations whose `output` names a field the
 * given terms declare. {@link buildAdvancedTerms} drops a disabled key's
 * now-unreferenced field from `linkageFields`, but the editable draft keeps that
 * field's (now inert) transformation so re-enabling the key restores its cleaning.
 * Committing that transformation into the inviter's own exchange would make
 * `prepareForExchange` fail closed, rejecting the spec as an authoritative
 * standardization that contradicts its terms (an output naming no linkage field).
 * The drop is lossless: a transformation whose output is not a declared linkage
 * field is never bound, so it cleaned no matched value. Applied by
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
 * spec: the metadata and standardization it authored in the inviter bench. Both
 * are absent on the quick (name-only) path, where they are inferred downstream.
 * The inviter analogue of `AcceptorDataEdits`. */
export interface InviterDataEdits {
  metadata?: Metadata;
  standardization?: Standardization;
}

/**
 * Assemble the inviter's {@link ExchangeDataSpec} for its own half of the exchange
 * -- the inviter analogue of `acceptorExchangeDataSpec`, and the structural
 * enforcement point of the invariant that an authored standardization names only
 * declared linkage fields. `prepareForExchange` fails closed on a violation, so
 * reconciling the standardization to `linkageTerms` HERE, where the spec is handed
 * to core, drops the orphaned-output transformations any inviter flow can produce
 * (a disabled key's now-inert transformation, an import's default per-type seed)
 * before they reach core. It reconciles only that class -- an unknown step
 * function is out of its remit and stays refused by core's throw, which remains
 * the fail-closed backstop for any contradiction this filter does not cover. See
 * {@link standardizationForTerms} for why the drop is lossless. The metadata and
 * standardization are per-party and local; the terms are pinned to the invitation.
 * Each is included only when present, so the quick path (no authored cleaning)
 * leaves core to infer them.
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
  };
}

/**
 * The authored field names the operator's columns can actually PRODUCE -- the
 * satisfiability universe a key's badge is judged against. Derived from the
 * authored fields (not the one-field-per-type default) and resolved through
 * the given standardization -- the same inputs the Generate gate uses -- so an
 * authored same-typed second field (e.g. first_name_2) reads as satisfiable.
 * The probe restates the authored fields onto default terms; only its
 * linkageFields are read (resolveFieldColumns ignores linkageKeys), and the
 * identity is a constant because it never affects the field or key set.
 */
export function producibleFieldNames(
  metadata: Metadata,
  standardization: Standardization,
  columns: ReadonlyArray<string>,
): Set<string> {
  const fields = authoredLinkageFields(metadata, standardization);
  const probe: LinkageTerms = {
    ...getDefaultLinkageTerms("", metadata),
    linkageFields: fields,
  };
  const { unsatisfied } = assessLinkageSatisfiability(
    [...columns],
    probe,
    standardization,
    metadata,
  );
  const unsatisfiedNames = new Set(unsatisfied.map((field) => field.name));
  return new Set(
    fields
      .map((field) => field.name)
      .filter((name) => !unsatisfiedNames.has(name)),
  );
}
