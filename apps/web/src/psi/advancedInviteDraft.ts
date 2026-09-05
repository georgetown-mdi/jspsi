import {
  INVITATION_LIFETIME_SECONDS,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  canonicalString,
  columnValues,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferDateFormat,
  inferMetadata,
  optInLinkageKeys,
  referencedLinkageFieldNames,
} from "@psilink/core";

import { encodeKeyForComparison, isOptInDraftKey } from "./linkageComparison";
import { buildAdvancedTerms } from "./advancedInviteTerms";
import { directionForOutput } from "./advancedInviteTypes";
import { normalizeForEditor } from "./metadataEditing";

import type {
  CSVRow,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  Metadata,
  Standardization,
  StandardizationStep,
} from "@psilink/core";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  DraftKey,
} from "./advancedInviteTypes";

/**
 * The draft-editing operations for the advanced invitation editor: seeding a
 * draft from the inviter's columns, reconciling it against a metadata edit,
 * authoring linkage keys element-by-element (expert tier), and reconstructing
 * a draft from an imported terms document. Pure immutable edits -- no React,
 * no I/O. Building and validating the {@link LinkageTerms} a draft represents
 * are the sibling terms-mapping and validation modules.
 */

/**
 * The default standardization for a metadata/terms pair with the
 * `date_of_birth` pipeline's input format inferred from the operator's own
 * rows, rather than the fixed `MM/DD/YYYY` `getDefaultStandardization`
 * assumes. Needed here because the advanced path and the acceptor's
 * Prepare-data editor always supply an explicit standardization (unlike the
 * quick path, which lets the exchange infer), so without this a non-US date
 * file would silently parse with the wrong format. Mirrors the exchange's own
 * inference (first present `role: linkage` date_of_birth column drives
 * {@link inferDateFormat}, falling back to `MM/DD/YYYY`).
 *
 * The inferred format lives only in the local cleaning steps -- the
 * cross-party terms hold the field, not its cleaning -- so this never moves
 * the agreement bytes.
 */
export function defaultStandardizationForRows(
  metadata: Metadata,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
  dateInputFormat?: string,
): Standardization {
  return getDefaultStandardization(metadata, terms, {
    dateInputFormat: dateInputFormat ?? inferDateInputFormat(metadata, rawRows),
  });
}

/** {@link OPT_IN_LINKAGE_FIELD_TYPES} as a membership test, built once: the
 * question is asked per field of per metadata edit, and the list is fixed. */
const OPT_IN_TYPES: ReadonlySet<string> = new Set(OPT_IN_LINKAGE_FIELD_TYPES);

/**
 * The inviter's recommended cleaning: {@link defaultStandardizationForRows}
 * widened past the fields `terms` declare to the
 * {@link OPT_IN_LINKAGE_FIELD_TYPES} fields that `enabledKeys` reference.
 *
 * Without the widening, an opt-in key ({@link optInLinkageKeys}) matches its
 * column RAW while the accepting party cleans the same field from the terms
 * that declare it once the key is on, and the two parties match almost
 * nothing.
 *
 * Gated on the ENABLED keys, not column presence, so a guided draft with no
 * opt-in key enabled builds byte-identical terms and the guided path's
 * cross-party hash does not move; what guarantees a PERSISTED artifact's
 * cleaning matches its terms is the mint chokepoint (`generateInvitation`),
 * not this function.
 */
export function inviterDefaultStandardization(
  metadata: Metadata,
  terms: LinkageTerms,
  enabledKeys: ReadonlyArray<LinkageKey>,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): Standardization {
  const declared = new Set(terms.linkageFields.map((field) => field.name));
  const referenced = referencedLinkageFieldNames(enabledKeys);
  const widened: LinkageTerms = {
    ...terms,
    linkageFields: [
      ...terms.linkageFields,
      ...authoredLinkageFields(metadata).filter(
        (field) =>
          OPT_IN_TYPES.has(field.type) &&
          !declared.has(field.name) &&
          referenced.has(field.name),
      ),
    ],
  };
  return defaultStandardizationForRows(
    metadata,
    widened,
    rawRows,
    dateInputFormat,
  );
}

/** The keys of a draft key list that are turned on -- the set that decides
 * which fields the emitted terms declare, and so which cleaning the draft may
 * hold. */
function enabledLinkageKeys(keys: ReadonlyArray<DraftKey>): Array<LinkageKey> {
  return keys.filter((entry) => entry.enabled).map((entry) => entry.key);
}

/**
 * The date-of-birth input format the recommended cleaning parses with: inferred
 * from the first present `role: linkage` date_of_birth column's values, or
 * `undefined` (the `MM/DD/YYYY` default) when there is no such column or the layout
 * cannot be inferred. The single derivation {@link defaultStandardizationForRows}
 * falls back to when no pre-inferred format is threaded, and the value the console
 * profiles server-side so the browser can author without the rows.
 */
export function inferDateInputFormat(
  metadata: Metadata,
  rawRows: ReadonlyArray<CSVRow>,
): string | undefined {
  const dobColumn = metadata.find(
    (column) => column.type === "date_of_birth" && column.role === "linkage",
  );
  return dobColumn !== undefined
    ? inferDateFormat(columnValues(rawRows, dobColumn.name))
    : undefined;
}

/**
 * The date-of-birth input format {@link seedAdvancedInvite} derives for a set of
 * columns and their rows -- {@link inferDateInputFormat} over the same seed metadata
 * ({@link normalizeForEditor} of {@link inferMetadata}) the seed builds. The hosted
 * intake derives it once here so the value can thread every reconciliation in place
 * of the full rows, and a seed from (columns, format) reproduces one from full rows.
 */
export function dateInputFormatForColumns(
  columns: Array<string>,
  rawRows: ReadonlyArray<CSVRow>,
): string | undefined {
  return inferDateInputFormat(
    normalizeForEditor(inferMetadata(columns)),
    rawRows,
  );
}

/**
 * Seed an editor session from the inviter's identity, CSV columns, and parsed
 * rows. Terms are the metadata-aware defaults (`getDefaultLinkageTerms` over
 * {@link inferMetadata}), so only keys the columns can satisfy are present;
 * the built-in set's unused keys are offered beside them, off
 * ({@link offerableDraftKeys}). Calling this again is the "Reset to
 * defaults" action. `rawRows` defaults to empty (yielding the `MM/DD/YYYY`
 * date default); a pre-inferred `dateInputFormat`
 * ({@link dateInputFormatForColumns}) overrides that derivation.
 */
export function seedAdvancedInvite(
  identity: string,
  columns: Array<string>,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): { draft: AdvancedInviteDraft; seed: AdvancedInviteSeed } {
  // Normalized so the collapsed disclosure control opens on a faithful diagonal
  // (an inferred identifier column is not silently disclosed). Normalization only
  // re-derives isPayload from role, so the offerable key set -- which
  // getDefaultLinkageTerms derives from the `role: linkage` column TYPES -- is
  // unchanged by it.
  const metadata = normalizeForEditor(inferMetadata(columns));
  const terms = getDefaultLinkageTerms(identity, metadata);
  const keys = offerableDraftKeys(identity, metadata);
  return {
    draft: {
      identity,
      lifetimeSeconds: INVITATION_LIFETIME_SECONDS,
      // The default is the symmetric both-receive exchange, matching the quick
      // path and getDefaultLinkageTerms' output.
      outputDirection: "both",
      // Taken from the recommended terms (psi / no-dedup), so a fresh draft opens
      // on the identifier-revealing algorithm and one-to-one matching; a
      // deduplicating exchange is chosen at the control rather than defaulted to.
      algorithm: terms.algorithm,
      deduplicate: terms.deduplicate,
      // The default strategy (`cascade`). Ungated -- the control writes it straight
      // through -- so a fresh draft authors cascade exactly as before the control
      // existed.
      linkageStrategy: terms.linkageStrategy,
      metadata,
      // The recommended per-type cleaning for these columns, with the dob format
      // inferred from the rows. authoredLinkageFields over this reproduces the
      // one-field-per-type set, and the built terms filter it to the fields the
      // enabled keys reference -- which, with every offer arriving off, is exactly
      // getDefaultLinkageTerms' field set. So the editor opens on a known-good
      // valid state, byte-identical to the quick path's (the inferred format lives
      // only in the local steps, which the terms do not hold).
      standardization: inviterDefaultStandardization(
        metadata,
        terms,
        enabledLinkageKeys(keys),
        rawRows,
        dateInputFormat,
      ),
      keys,
    },
    seed: { terms, metadata, columns },
  };
}

/**
 * What the guided key list offers for `metadata`: the built-in keys the
 * columns can supply, ON, with the opt-in keys the columns can supply placed
 * among them ({@link placeOfferedKeys}) and OFF -- so a fresh draft authors
 * exactly the built-in set and the additions wait to be chosen.
 *
 * Each entry's `enabled` is the flag a key arrives with when first offered;
 * {@link reconcileKeys} keeps the operator's own flag for a key already in
 * the draft, so a metadata edit never silently re-enables an opt-in key that
 * was turned off, nor turns off one that was turned on.
 */
function offerableDraftKeys(
  identity: string,
  metadata: Metadata,
): Array<DraftKey> {
  return placeOfferedKeys(
    getDefaultLinkageTerms(identity, metadata).linkageKeys.map((key) => ({
      key,
      enabled: true,
    })),
    optInLinkageKeys(metadata).map((key) => ({ key, enabled: false })),
  );
}

/**
 * `keys` with each entry of `offers` inserted immediately above the first key
 * it REFINES -- holding that key's elements and at least one more -- and at
 * the end when it refines none of them.
 *
 * List order is cascade order: a round claims the records it matches, so a
 * refinement placed below the key it refines is left only what the looser
 * key could not claim, some of it claimed wrongly. Above it, the refinement
 * claims what both would match and the looser key still catches the rest.
 * An offer refining nothing goes last.
 */
function placeOfferedKeys(
  keys: ReadonlyArray<DraftKey>,
  offers: ReadonlyArray<DraftKey>,
): Array<DraftKey> {
  const placed = [...keys];
  for (const offer of offers) {
    const at = placed.findIndex((entry) => refines(offer.key, entry.key));
    if (at === -1) placed.push(offer);
    else placed.splice(at, 0, offer);
  }
  return placed;
}

/** Whether `key` holds every element of `coarser` and at least one more, the
 * relation that makes `key` match a subset of what `coarser` matches.
 * Elements are compared through the canonical encoding, so a transform on one
 * of them is part of the element rather than ignored; a `swap` key states a
 * matching rule its elements do not hold, so neither side of the relation may
 * have one. */
function refines(key: LinkageKey, coarser: LinkageKey): boolean {
  if (key.swap !== undefined || coarser.swap !== undefined) return false;
  if (coarser.elements.length >= key.elements.length) return false;
  const elements = new Set(key.elements.map((el) => canonicalString(el)));
  return coarser.elements.every((el) => elements.has(canonicalString(el)));
}

/**
 * Swap in a freshly-edited column metadata and reconcile the draft's
 * standardization against it ({@link reconcileStandardization}), leaving the
 * linkage keys untouched. The metadata edit for an authored or imported key
 * set, where the template-driven {@link reconcileKeys} must not run -- it
 * would silently drop keys the operator authored or imported. The
 * standardization is still reconciled, so a column retype cannot leave a
 * stale transformation declaring a field whose type no longer matches its
 * column.
 */
export function setDraftMetadataKeepingKeys(
  draft: AdvancedInviteDraft,
  metadata: Metadata,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): AdvancedInviteDraft {
  return {
    ...draft,
    metadata,
    standardization: reconcileStandardization(
      draft.standardization,
      draft.metadata,
      metadata,
      draft.identity,
      enabledLinkageKeys(draft.keys),
      rawRows,
      dateInputFormat,
    ),
  };
}

/**
 * Re-derive the editor's draft for a new column metadata: recomputes the
 * offerable key set ({@link offerableDraftKeys}) and reconciles it with the
 * current draft ({@link reconcileKeys}) -- offerable keys keep their enabled
 * flag and position, newly-offerable keys arrive at the offer's flag and
 * place, and keys no longer offerable drop. Reconciles the standardization
 * against the RECONCILED key set (not the draft's previous one), so an
 * opt-in type's cleaning follows the keys the edit leaves enabled. The
 * authored key set instead drives {@link setDraftMetadataKeepingKeys}, which
 * skips this template reconciliation.
 *
 * The reconciled cleaning then passes through
 * {@link optInCleaningForKeys}, the same withdrawal
 * {@link draftWithKeyEnabled} runs when an offer is turned off by hand: an
 * edit to a backbone column can drop an enabled offer, and its cleaning
 * would otherwise outlive the key that minted it as an orphan card in the
 * data-prep workbench.
 */
export function setDraftMetadata(
  draft: AdvancedInviteDraft,
  metadata: Metadata,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): AdvancedInviteDraft {
  const keys = reconcileKeys(
    draft.keys,
    offerableDraftKeys(draft.identity, metadata),
  );
  const enabledKeys = enabledLinkageKeys(keys);
  return {
    ...draft,
    metadata,
    keys,
    standardization: optInCleaningForKeys(
      reconcileStandardization(
        draft.standardization,
        draft.metadata,
        metadata,
        draft.identity,
        enabledKeys,
        rawRows,
        dateInputFormat,
      ),
      metadata,
      draft.identity,
      enabledKeys,
    ),
  };
}

/**
 * Turn the key at `index` on or off and bring the cleaning an opt-in type
 * holds with it: {@link optInLinkageKeys} offers a key referencing the
 * type-named field `authoredLinkageFields` synthesizes, which holds its
 * recommended pipeline exactly while an enabled key references it. Turning
 * an offer on creates its cleaning (the data-prep workbench's card appears
 * with the key); turning it off withdraws it.
 *
 * Only the offer's own cleaning moves -- a transformation an imported
 * document's field name owns is never withdrawn this way -- and a built-in
 * type's cleaning is retained across a disable so re-enabling restores what
 * the operator authored.
 *
 * Custom steps on an offered type's transformation are discarded when its
 * key goes off and the recommended pipeline is re-derived when it comes back
 * on, because the accepting party derives that same pipeline from the terms
 * and a step only one side runs matches nothing.
 */
export function draftWithKeyEnabled(
  draft: AdvancedInviteDraft,
  index: number,
  enabled: boolean,
): AdvancedInviteDraft {
  const keys = draft.keys.map((entry, at) =>
    at === index ? { ...entry, enabled } : entry,
  );
  return {
    ...draft,
    keys,
    standardization: optInCleaningForKeys(
      draft.standardization,
      draft.metadata,
      draft.identity,
      enabledLinkageKeys(keys),
    ),
  };
}

/** Whether `transformation` is the cleaning an {@link optInLinkageKeys} offer
 * mints: bound to a `role: linkage` column of an {@link OPT_IN_LINKAGE_FIELD_TYPES}
 * type and named for that type, which is the field name the offered key
 * references. Read from the input column rather than the output name alone, so a
 * field an imported document named for a type it is not (declarations name and
 * type fields independently) is not mistaken for the offer's. */
function isOfferedTypeCleaning(
  transformation: Standardization[number],
  columnByName: ReadonlyMap<string, Metadata[number]>,
): boolean {
  const column = columnByName.get(transformation.input);
  return (
    column !== undefined &&
    column.role === "linkage" &&
    OPT_IN_TYPES.has(column.type) &&
    transformation.output === column.type
  );
}

/** The standardization an opt-in offer's enabled flag implies: `standardization`
 * with the offered cleaning no enabled key references dropped, then the
 * recommended pipeline seeded for whatever the enabled keys do reference
 * ({@link seededOptInCleaning}). */
function optInCleaningForKeys(
  standardization: Standardization,
  metadata: Metadata,
  identity: string,
  enabledKeys: ReadonlyArray<LinkageKey>,
): Standardization {
  const columnByName = new Map(metadata.map((column) => [column.name, column]));
  const referenced = referencedLinkageFieldNames(enabledKeys);
  const kept = standardization.filter(
    (transformation) =>
      !isOfferedTypeCleaning(transformation, columnByName) ||
      referenced.has(transformation.output),
  );
  return seededOptInCleaning(kept, metadata, identity, enabledKeys);
}

/**
 * `standardization` with the recommended pipeline added for each
 * {@link OPT_IN_LINKAGE_FIELD_TYPES} field an enabled key references and no
 * transformation yet produces, derived exactly as the seed derives it
 * ({@link inviterDefaultStandardization}), so the key cleans its column the
 * way the accepting party -- deriving from the same terms -- cleans its own.
 *
 * Purely additive: never drops or rewrites a transformation the draft
 * already holds. Two of the three doors into such a key pass through here
 * -- the guided offer's checkbox ({@link draftWithKeyEnabled}) and the
 * expert key editor ({@link draftWithSeededOptInCleaning}); an imported
 * document reaches the same steps through its own reconstruction
 * ({@link standardizationForImportedTerms}), binding the document's field
 * names instead.
 */
function seededOptInCleaning(
  standardization: Standardization,
  metadata: Metadata,
  identity: string,
  enabledKeys: ReadonlyArray<LinkageKey>,
): Standardization {
  const columnByName = new Map(metadata.map((column) => [column.name, column]));
  const produced = new Set(
    standardization.map((transformation) => transformation.output),
  );
  const additions = inviterDefaultStandardization(
    metadata,
    getDefaultLinkageTerms(identity, metadata),
    enabledKeys,
  ).filter(
    (transformation) =>
      isOfferedTypeCleaning(transformation, columnByName) &&
      !produced.has(transformation.output),
  );
  return additions.length === 0
    ? standardization
    : [...standardization, ...additions];
}

/**
 * Reconcile the draft's standardization against a freshly-edited metadata,
 * the standardization analogue of {@link reconcileKeys}. A transformation is
 * kept when its input column is still present, `role: linkage`, and of the
 * same semantic type it had before the edit, and dropped when its column was
 * removed, re-roled off linkage, or retyped -- so a stale transformation
 * never cleans a column core would refuse to bind, nor declares a field
 * whose type no longer matches its column. The type change is read from
 * `prevMetadata` versus `metadata`, not from the transformation's `output`
 * name, so a field named unlike its type is judged by its column alone. A
 * semantic type the kept set no longer covers gains the recommended default
 * cleaning. With no edits this returns the unchanged default standardization.
 */
function reconcileStandardization(
  prev: Standardization,
  prevMetadata: Metadata,
  metadata: Metadata,
  identity: string,
  enabledKeys: ReadonlyArray<LinkageKey>,
  rawRows: ReadonlyArray<CSVRow>,
  dateInputFormat?: string,
): Standardization {
  const columnByName = new Map(metadata.map((column) => [column.name, column]));
  const prevTypeByName = new Map(
    prevMetadata.map((column) => [column.name, column.type]),
  );
  const kept = prev.filter((transformation) => {
    const column = columnByName.get(transformation.input);
    if (column === undefined || column.role !== "linkage") return false;
    const prevType = prevTypeByName.get(transformation.input);
    return prevType === undefined || prevType === column.type;
  });
  const coveredTypes = new Set(
    kept
      .map((transformation) => columnByName.get(transformation.input)?.type)
      .filter((type) => type !== undefined),
  );
  // Default cleaning for a present type the kept set does not cover. Derived the
  // same way the seed is (inviterDefaultStandardization over the metadata's default
  // terms), so a newly-typed column gains exactly the recommended per-type pipeline
  // -- including the row-inferred date format for a column just retyped to
  // date_of_birth. A column retyped to a type only an opt-in key uses gains one
  // only once such a key is enabled: the widening reads the enabled keys, so a
  // routine retype on an authored or imported draft cannot grow its cleaning by a
  // pipeline whose output that draft's terms declare nothing for.
  const fullDefault = inviterDefaultStandardization(
    metadata,
    getDefaultLinkageTerms(identity, metadata),
    enabledKeys,
    rawRows,
    dateInputFormat,
  );
  const additions = fullDefault.filter((transformation) => {
    const column = columnByName.get(transformation.input);
    return column !== undefined && !coveredTypes.has(column.type);
  });
  return [...kept, ...additions];
}

/** Reconcile the draft's keys against a freshly-derived offer
 * ({@link offerableDraftKeys}): keys that remain offered keep their order
 * and enabled flag (replaced with the fresh template); a newly-offered
 * built-in key appends at its offered flag, and a newly-offered opt-in key
 * is placed where the offer places it ({@link placeOfferedKeys}), above
 * whichever key it refines.
 *
 * A draft key is matched to an offer by the canonical encoding
 * ({@link encodeKeyForComparison}), not by NAME, so a key that merely
 * borrows an offer's name cannot inherit that offer's enabled flag. A key
 * matching no offer drops.
 *
 * An offer left unmatched by such a drop is RE-OFFERED, OFF, in the dropped
 * entry's own place -- rather than at the offer's own flag and position --
 * whenever the dropped entry held the offer's name: that name is what the
 * operator saw beside the checkbox, so a shape mismatch under it is treated
 * as a departure from the offer, not a fresh one, and must not silently turn
 * a key the operator disabled back on. An offer no dropped entry named is
 * new and arrives at the offer's own flag and place.
 *
 * The dropped entry's place is what an opt-in re-offer inherits too, since
 * position is decided by whether the list already held a key of that name:
 * a re-added opt-in offer stays where the operator put it rather than
 * jumping up the cascade on an edit that changed nothing about it. */
function reconcileKeys(
  prevKeys: Array<DraftKey>,
  offerable: Array<DraftKey>,
): Array<DraftKey> {
  const offerableByEncoding = new Map<string, DraftKey>();
  for (const entry of offerable) {
    const encoded = encodeKeyForComparison(entry.key);
    if (encoded !== null) offerableByEncoding.set(encoded, entry);
  }
  const offerFor = prevKeys.map((entry) => {
    const encoded = encodeKeyForComparison(entry.key);
    return encoded === null ? undefined : offerableByEncoding.get(encoded);
  });
  const matched = new Set(offerFor.filter((offer) => offer !== undefined));
  const droppedNames = new Set(
    prevKeys
      .filter((_, at) => offerFor[at] === undefined)
      .map((entry) => entry.key.name),
  );
  const reofferByName = new Map(
    offerable
      .filter(
        (entry) => !matched.has(entry) && droppedNames.has(entry.key.name),
      )
      .map((entry) => [entry.key.name, entry] as const),
  );
  const kept: Array<DraftKey> = [];
  const reoffered = new Set<DraftKey>();
  prevKeys.forEach((entry, at) => {
    const offer = offerFor[at];
    if (offer !== undefined) {
      kept.push({ key: offer.key, enabled: entry.enabled });
      return;
    }
    const reoffer = reofferByName.get(entry.key.name);
    if (reoffer === undefined || reoffered.has(reoffer)) return;
    reoffered.add(reoffer);
    kept.push({ key: reoffer.key, enabled: false });
  });
  const fresh = offerable.filter(
    (entry) => !matched.has(entry) && !reoffered.has(entry),
  );
  for (const entry of fresh) if (!isOptInDraftKey(entry.key)) kept.push(entry);
  return placeOfferedKeys(
    kept,
    fresh.filter((entry) => isOptInDraftKey(entry.key)),
  );
}

/** The field names a metadata/standardization pair can declare -- the universe
 * {@link buildAdvancedTerms} draws its `linkageFields` from
 * (`authoredLinkageFields`). A key element whose `field` is absent from this
 * set dangles: the built terms would reference an undeclared field, which
 * `safeParseLinkageTerms`'s referential-integrity refine rejects. */
export function declarableFieldNames(
  metadata: Metadata,
  standardization: Standardization,
): Set<string> {
  return new Set(
    authoredLinkageFields(metadata, standardization).map((field) => field.name),
  );
}

/** The steps the recommended per-type pipeline cleans a field of `type`
 * with: {@link defaultStandardizationForRows} over terms declaring that one
 * field, covering an {@link OPT_IN_LINKAGE_FIELD_TYPES} type as well as a
 * default one. `undefined` when these columns supply no `role: linkage`
 * column of the type. The date-of-birth format is the `MM/DD/YYYY` default
 * (no rows are threaded here). */
function recommendedStepsForType(
  metadata: Metadata,
  identity: string,
  type: LinkageField["type"],
): Array<StandardizationStep> | undefined {
  return defaultStandardizationForRows(
    metadata,
    {
      ...getDefaultLinkageTerms(identity, metadata),
      linkageFields: [{ name: type, type }],
    },
    [],
  )[0]?.steps;
}

/**
 * Append a linkage field of `type` bound to its first free `role: linkage`
 * column, holding the type's cleaning: the first field's own steps (including
 * any the operator edited) when the draft already declares one of that type,
 * else the recommended pipeline ({@link recommendedStepsForType}).
 *
 * The name is the type's own, suffixed `_2`, `_3`, ... only to step past a
 * name the draft already produces -- a first field named `_2` would display
 * as the second of a pair whose first does not exist.
 *
 * A type with no free column returns the draft unchanged.
 */
export function draftWithFieldAdded(
  draft: AdvancedInviteDraft,
  type: LinkageField["type"],
): AdvancedInviteDraft {
  const bound = new Set(draft.standardization.map((t) => t.input));
  const freeColumn = draft.metadata
    .filter((column) => column.role === "linkage" && column.type === type)
    .map((column) => column.name)
    .find((column) => !bound.has(column));
  if (freeColumn === undefined) return draft;
  const typeByOutput = new Map(
    authoredLinkageFields(draft.metadata, draft.standardization).map(
      (field) => [field.name, field.type],
    ),
  );
  const sibling = draft.standardization.find(
    (transformation) => typeByOutput.get(transformation.output) === type,
  );
  const base = sibling?.output ?? type;
  const taken = new Set(draft.standardization.map((t) => t.output));
  let output = base;
  for (let n = 2; taken.has(output); n++) output = `${base}_${n}`;
  return {
    ...draft,
    standardization: [
      ...draft.standardization,
      {
        output,
        input: freeColumn,
        steps:
          sibling !== undefined
            ? (sibling.steps ?? [])
            : (recommendedStepsForType(draft.metadata, draft.identity, type) ??
              []),
      },
    ],
  };
}

/** Whether the inviter's columns can supply every field `key` references (each
 * element's `field` is declarable -- see {@link declarableFieldNames}). A key that
 * is not supplyable dangles the built terms, so the import disables it
 * ({@link draftFromTerms}) and {@link validateAdvancedInvite} messages it distinctly
 * from a draft whose keys were merely turned off. */
export function keyIsSupplyable(
  key: LinkageKey,
  declarable: ReadonlySet<string>,
): boolean {
  return key.elements.every((element) => declarable.has(element.field));
}

// --- Expert key / element authoring ------------------------------------------
//
// Pure immutable edits over the draft's linkage keys, the tested boundary the
// expert-mode UI drives. Field references are chosen by the caller from the
// declared field list (the metadata-derived offerable set), so a key authored
// through these is referentially valid by construction; the core schema's
// referential-integrity refines remain the single validation source.

/**
 * `draft` with the recommended pipeline seeded for every
 * {@link OPT_IN_LINKAGE_FIELD_TYPES} field its enabled keys reference and
 * nothing cleans yet ({@link seededOptInCleaning}), returned by reference
 * when there is nothing to add.
 *
 * A key over an opt-in type's synthesized field is schema-valid and passes
 * the mint (which asserts cleaning names declared fields, not that a
 * declared field is cleaned), so without this the party would match its
 * column RAW while the accepting party matches the cleaned value.
 *
 * Seeding rather than warning keeps the expert door at the guided door's and
 * the import's behavior. Only the seeding is shared: an expert edit never
 * WITHDRAWS a pipeline the way an offer's checkbox does -- a pipeline the
 * enabled keys stop referencing is reconciled away only at the mint
 * (`standardizationForTerms`).
 */
function draftWithSeededOptInCleaning(
  draft: AdvancedInviteDraft,
): AdvancedInviteDraft {
  const standardization = seededOptInCleaning(
    draft.standardization,
    draft.metadata,
    draft.identity,
    enabledLinkageKeys(draft.keys),
  );
  return standardization === draft.standardization
    ? draft
    : { ...draft, standardization };
}

/** Replace the linkage key at `keyIndex` by applying `fn` to it, seeding the
 * cleaning an opt-in type the edit newly references needs
 * ({@link draftWithSeededOptInCleaning}). The basis for every expert key edit
 * (rename, swap, and -- via {@link updateElementAt} -- the element edits), so both
 * the immutable update and that reconciliation live in one place. */
export function updateKeyAt(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  fn: (key: LinkageKey) => LinkageKey,
): AdvancedInviteDraft {
  return draftWithSeededOptInCleaning({
    ...draft,
    keys: draft.keys.map((entry, i) =>
      i === keyIndex ? { ...entry, key: fn(entry.key) } : entry,
    ),
  });
}

/** Drop a key's `swap` when either target no longer names one of its element
 * identifiers (`name ?? field`) -- e.g. after the targeted element is removed or
 * its alias/field is edited. Without this an orphaned swap target lingers in the
 * draft and blocks Generate (the schema's swap-target refine rejects it) with a
 * key-list error rather than the swap control simply clearing; pruning keeps the
 * control and the data consistent. Returns the key unchanged when the swap (if
 * any) still resolves, so it never perturbs a valid key's identity. */
function pruneStaleSwap(key: LinkageKey): LinkageKey {
  if (key.swap === undefined) return key;
  const ids = new Set(key.elements.map((el) => el.name ?? el.field));
  if (key.swap.every((target) => ids.has(target))) return key;
  const next = { ...key };
  delete next.swap;
  return next;
}

/** Apply `fn` to one element of one key (field, alias, transform, or fuzzy). A
 * field or alias edit changes the element's identifier, so a now-orphaned swap is
 * pruned (see {@link pruneStaleSwap}). */
export function updateElementAt(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
  fn: (element: LinkageKeyElement) => LinkageKeyElement,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) =>
    pruneStaleSwap({
      ...key,
      elements: key.elements.map((el, i) => (i === elementIndex ? fn(el) : el)),
    }),
  );
}

/** Append a new, enabled linkage key with a unique name and a single element
 * referencing `fieldName` (chosen by the caller from the declared fields, so the
 * key is referentially valid and non-empty by construction). The key arrives
 * enabled, so a `fieldName` of an opt-in type is cleaned from the moment it is
 * keyed ({@link draftWithSeededOptInCleaning}). */
export function addKey(
  draft: AdvancedInviteDraft,
  fieldName: string,
): AdvancedInviteDraft {
  const name = uniqueKeyName(
    "New key",
    new Set(draft.keys.map((entry) => entry.key.name)),
  );
  const key: LinkageKey = { name, elements: [{ field: fieldName }] };
  return draftWithSeededOptInCleaning({
    ...draft,
    keys: [...draft.keys, { key, enabled: true }],
  });
}

/** Remove the linkage key at `index`. */
export function removeKey(
  draft: AdvancedInviteDraft,
  index: number,
): AdvancedInviteDraft {
  return { ...draft, keys: draft.keys.filter((_, i) => i !== index) };
}

/** Append an element referencing `fieldName` to the key at `keyIndex`. When that
 * field already identifies an element in the key, the new element is given a
 * distinct alias so the key keeps the unique element identifiers the schema
 * requires. */
export function addElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  fieldName: string,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) => {
    // An element's identifier is its alias if set, else its field name (the same
    // An element's identifier is its alias if set, else its field name (the
    // same `name ?? field` the schema requires unique within a key). A new
    // element starts as a bare field reference, so when that field already
    // identifies an element here, give the new one a distinct alias --
    // otherwise two same-field elements would share an identifier, which
    // Mantine's swap control throws on, crashing the editor before the
    // validation message can show.
    const ids = new Set(key.elements.map((el) => el.name ?? el.field));
    const element: LinkageKeyElement = { field: fieldName };
    if (ids.has(fieldName)) {
      let n = 2;
      let alias = `${fieldName}_${n}`;
      while (ids.has(alias)) alias = `${fieldName}_${++n}`;
      element.name = alias;
    }
    return { ...key, elements: [...key.elements, element] };
  });
}

/** Remove the element at `elementIndex` from the key at `keyIndex`. A key must
 * keep at least one element (the schema's `.min(1)`); the caller gates the remove
 * control so the last element cannot be removed. */
export function removeElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) =>
    pruneStaleSwap({
      ...key,
      elements: key.elements.filter((_, i) => i !== elementIndex),
    }),
  );
}

/** Move an element within its key by one position (-1 earlier, +1 later).
 * Element order is significant -- elements are concatenated and hashed in order --
 * so this is a real matching change, not cosmetic. An out-of-range move is a
 * no-op. */
export function moveElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
  direction: -1 | 1,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) => {
    const target = elementIndex + direction;
    if (target < 0 || target >= key.elements.length) return key;
    const elements = [...key.elements];
    [elements[elementIndex], elements[target]] = [
      elements[target],
      elements[elementIndex],
    ];
    return { ...key, elements };
  });
}

/** A name not already in `taken`, preferring `base` then `base 2`, `base 3`, ...
 * Keeps authored key names unique (the schema rejects duplicates). Bounded by the
 * taken-set size: among `base` and `base 2..base (size+2)` there are `taken.size + 2`
 * distinct candidates against `taken.size` taken names, so at least two are always
 * free and the loop always returns. */
function uniqueKeyName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable given the pigeonhole bound above; encode that as a check rather
  // than return a candidate that could itself collide if the bound ever regressed.
  throw new Error("uniqueKeyName exhausted its candidate range");
}

// --- Import ------------------------------------------------------------------

/**
 * Reconstruct the importer's local standardization for an imported terms
 * document. Standardization is per-party and never travels in the token, so
 * the imported {@link LinkageTerms} hold the field declarations
 * (`linkageFields`) but not the column binding that produced them; this
 * rebuilds a binding the inviter's own columns can satisfy, the import-time
 * analogue of the workbench's `addFieldForType`.
 *
 * Starts from the full per-type default ({@link defaultStandardizationForRows}
 * over the seed's default terms), then adds a binding for each imported field
 * the default does not already declare (an extra same-type field, or an
 * {@link OPT_IN_LINKAGE_FIELD_TYPES} field), reusing that type's recommended
 * cleaning steps. Each such field binds only to a free `role: linkage` column
 * -- never `identifier`- or `payload`-roled -- so a crafted document cannot
 * auto-bind a column the operator did not mark for matching.
 *
 * The base is the unwidened default rather than
 * {@link inviterDefaultStandardization}: the widening would claim an opt-in
 * type's first column ahead of the loop below, leaving an imported field the
 * document named otherwise (`cell_phone` for a `phone_number` column) with
 * nothing free to bind. The reconstructed binding is local and never enters
 * the token; {@link buildAdvancedTerms} re-declares the imported fields via
 * {@link AdvancedInviteDraft.importedLinkageFields}, so field order and any
 * declared-but-unreferenced field are preserved. A custom per-field
 * `constraint` is the one facet not held -- it is re-stamped to the type
 * default and caught fail-closed at the import door
 * ({@link importedConstraintDivergenceMessage}).
 *
 * Fail-closed: a field with no free `role: linkage` column left gets no
 * transformation and stays undeclared, so a key referencing only
 * reconstructed fields is satisfiable while one still referencing the
 * undeclared field cannot generate. An import declaring only the single
 * default field per type reconstructs the seed's default standardization
 * byte-for-byte.
 */
function standardizationForImportedTerms(
  metadata: Metadata,
  defaultTerms: LinkageTerms,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
  dateInputFormat?: string,
): Standardization {
  const base = defaultStandardizationForRows(
    metadata,
    defaultTerms,
    rawRows,
    dateInputFormat,
  );
  // The recommended steps each imported field's type cleans with, keyed by field
  // name. Derived from the default standardization over the IMPORTED terms (not the
  // seed's), so it covers every imported field's type -- including an
  // `OPT_IN_LINKAGE_FIELD_TYPES` type the inviter has columns for but no built-in
  // key uses, which the seed's default terms (and so `base`) do not hold -- and
  // bakes in the row-inferred date format. The input columns it picks collide on the
  // first per type; only the steps are read here, and the distinct columns are
  // assigned below.
  const stepsByField = new Map(
    defaultStandardizationForRows(
      metadata,
      terms,
      rawRows,
      dateInputFormat,
    ).map((transformation) => [transformation.output, transformation.steps]),
  );
  // The default-named field each type already binds; only the EXTRA same-typed
  // fields (first_name_2, ...) need a reconstructed binding.
  const baseOutputs = new Set(
    base.map((transformation) => transformation.output),
  );
  // Columns already bound -- by the default base, then by each extra added below --
  // so every reconstructed same-typed field takes its OWN column, never doubling up.
  const boundColumns = new Set(
    base.map((transformation) => transformation.input),
  );

  const extras: Standardization = [];
  for (const field of terms.linkageFields) {
    if (baseOutputs.has(field.name)) continue;
    // First of two fail-closed gates that leave a field undeclared. Here the default
    // standardization over the imported terms emitted no transformation for this
    // field at all -- its type has no `role: linkage` column, or no default cleaning
    // pipeline -- so there is no binding to reconstruct. (The second gate is the
    // `freeColumn === undefined` check below: steps exist, but no `role: linkage`
    // column is free.) Reading the steps here (rather than a separate `.has()` probe)
    // also narrows them to a defined array for the push below.
    const steps = stepsByField.get(field.name);
    if (steps === undefined) continue;
    // Bind only to a `role: linkage` column -- one the operator designated for
    // matching. An imported terms document is attacker-influenceable (any
    // schema-valid document is accepted on import), so a crafted document declaring
    // an extra same-typed field must not be able to auto-bind it to a column the
    // operator roled `identifier` (row-identifier) or `payload` (sent-to-partner)
    // and so hash that column's value into a PSI key without consent. The same
    // rule holds on every path: core's `resolveFieldColumns` binds only a
    // `role: linkage` column, and the workbench's `addFieldForType` /
    // `columnsForType` likewise offer only linkage columns. An extra field with no
    // free `linkage` column stays undeclared (fail-closed); the operator
    // establishes the binding by roling the column `linkage` and binding it in the
    // workbench. The default base's first-column-per-type binding comes from the
    // same core rule, so it too binds only `role: linkage` columns.
    const freeColumn = metadata.find(
      (column) =>
        column.type === field.type &&
        column.role === "linkage" &&
        !boundColumns.has(column.name),
    );
    if (freeColumn === undefined) continue;
    boundColumns.add(freeColumn.name);
    extras.push({
      output: field.name,
      input: freeColumn.name,
      steps,
    });
  }
  return [...base, ...extras];
}

/** Build an editor draft from imported, validated {@link LinkageTerms}.
 * identity, output direction, algorithm, deduplicate, linkage strategy, the
 * optional legal agreement, and every linkage key (all enabled) come from
 * the imported terms; the column metadata stays the inviter's own
 * (`seed.metadata`), since terms hold no per-party column binding. The local
 * standardization is reconstructed from the imported field declarations
 * against the inviter's columns ({@link standardizationForImportedTerms});
 * a field no column can satisfy stays undeclared rather than silently
 * mis-bound. The caller refuses a gated-active import first (see
 * {@link gatedActiveSettingMessage}). */
export function draftFromTerms(
  terms: LinkageTerms,
  seed: AdvancedInviteSeed,
  lifetimeSeconds: number = INVITATION_LIFETIME_SECONDS,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): AdvancedInviteDraft {
  const standardization = standardizationForImportedTerms(
    seed.metadata,
    seed.terms,
    terms,
    rawRows,
    dateInputFormat,
  );
  // Disable -- but keep -- any imported key the reconstructed binding cannot
  // supply: it would otherwise block the WHOLE import behind a
  // referential-integrity failure even when other keys are satisfiable.
  // Disabling lets the satisfiable subset generate while the key stays
  // visible, its "not satisfiable" badge readable, to re-enable once a
  // matching column exists. Disable-and-show, not silent drop.
  const declarable = declarableFieldNames(seed.metadata, standardization);
  const draft: AdvancedInviteDraft = {
    // An imported document that names nobody seeds an empty name field for the
    // operator to fill, which is what an unnamed draft is here.
    identity: terms.identity ?? "",
    lifetimeSeconds,
    outputDirection: directionForOutput(terms.output),
    algorithm: terms.algorithm,
    deduplicate: terms.deduplicate,
    // Reflect the imported strategy so the control shows it and an export
    // round-trips it. Adopted as-is rather than refused: the strategy is a
    // term the run honors whichever value it holds, so
    // gatedActiveSettingMessage has no branch for it.
    linkageStrategy: terms.linkageStrategy,
    legalAgreement:
      terms.legalAgreement !== undefined
        ? {
            reference: terms.legalAgreement.reference,
            purpose: terms.legalAgreement.purpose,
            expirationDate: terms.legalAgreement.expirationDate,
          }
        : undefined,
    metadata: seed.metadata,
    standardization,
    // Hold the imported field declaration so buildAdvancedTerms re-emits it
    // faithfully (order + declared-but-unreferenced fields + a benign empty
    // `constraints: {}`); see AdvancedInviteDraft.importedLinkageFields.
    importedLinkageFields: terms.linkageFields,
    // And what the document said about the rules' provenance -- the set it cited
    // with the rules it cited them over, or that it cited none. Both answers are
    // recorded: a document citing nothing is re-exported citing nothing, which
    // absence alone could not express (see
    // AdvancedInviteDraft.importedRuleSetCitation).
    importedRuleSetCitation:
      terms.linkageRuleSet !== undefined
        ? {
            kind: "cited",
            ruleSet: {
              reference: terms.linkageRuleSet,
              linkageFields: terms.linkageFields,
              linkageKeys: terms.linkageKeys,
            },
            // Finalized just below, once the import-time terms are built.
            honoredAtImport: false,
          }
        : { kind: "uncited" },
    keys: terms.linkageKeys.map((key) => ({
      key,
      enabled: keyIsSupplyable(key, declarable),
    })),
  };
  const citation = draft.importedRuleSetCitation;
  if (citation?.kind !== "cited") return draft;
  // Whether the editor's arrival-time narrowing (disabling the keys these columns
  // cannot supply) left the citation standing: buildAdvancedTerms holds
  // linkageRuleSet only when it does. Fixed here so a later operator edit that
  // drops the citation is attributed to that edit, not to the imported document
  // -- see ImportedRuleSetCitation.honoredAtImport.
  return {
    ...draft,
    importedRuleSetCitation: {
      ...citation,
      honoredAtImport: buildAdvancedTerms(draft).linkageRuleSet !== undefined,
    },
  };
}
