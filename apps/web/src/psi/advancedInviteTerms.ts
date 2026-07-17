import {
  assessLinkageSatisfiability,
  authoredLinkageFields,
  getDefaultLinkageTerms,
  referencedLinkageFieldNames,
} from "@psilink/core";

import { APPLIED_SETTINGS } from "./appliedSettings";
import { outputForDirection } from "./advancedInviteTypes";
import { payloadSendForMetadata } from "./metadataEditing";

import type {
  Algorithm,
  ExchangeDataSpec,
  LinkageField,
  LinkageKey,
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
 * The gated-setting clamp lives here: {@link buildAdvancedTerms} forces the
 * matching algorithm, deduplication, and per-element fuzzy expansion to the applied
 * behavior while their {@link APPLIED_SETTINGS} flag is false, the structural half
 * of the gate that holds regardless of how the draft reached its state. The
 * disabled editor controls and the import refusal are the other layers.
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
 * Build the {@link LinkageTerms} a draft represents. `version` and `date` are
 * carried from the seed unchanged (the editor exposes no control for them, so a
 * draft cannot alter them); `algorithm` and `deduplicate` come from the draft but
 * are clamped to the applied behavior while gated (see below); `linkageStrategy`,
 * `identity`, the `output` direction, and the optional legal agreement come from
 * the draft (free text NFC-normalized and trimmed); linkage keys are the enabled
 * ones in draft order,
 * and linkage fields are filtered to those the enabled keys reference (mirroring
 * `getDefaultLinkageTerms`, so disabling a key drops a now-unreferenced field).
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
  // Clamp the matching algorithm and per-element fuzzy expansion to the applied
  // behavior while gated, so the built terms can never carry a setting the run does
  // not yet honor regardless of how the draft reached this state (a UI gap, an
  // import) -- the structural half of the gate that holds even if the disabled
  // controls or import refusal are bypassed.
  const algorithm: Algorithm = APPLIED_SETTINGS.psiC ? draft.algorithm : "psi";
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
    algorithm,
    deduplicate,
    linkageStrategy: draft.linkageStrategy,
    output: outputForDirection(draft.outputDirection),
    linkageFields,
    linkageKeys: enabledKeys,
  };

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
