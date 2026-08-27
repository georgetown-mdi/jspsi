import {
  INVITATION_LIFETIME_SECONDS,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  canonicalString,
  columnValues,
  encodeForComparison,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferDateFormat,
  inferMetadata,
  isOptInLinkageKey,
  optInLinkageKeys,
  referencedLinkageFieldNames,
} from "@psilink/core";

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
} from "@psilink/core";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  DraftKey,
} from "./advancedInviteTypes";

/**
 * The draft-editing operations behind the inviter's authoring bench: seeding a
 * draft from the inviter's columns, reconciling it against a metadata edit,
 * authoring linkage keys element-by-element (the expert tier), and reconstructing
 * a draft from an imported terms document. Pure immutable edits over the draft --
 * no React, no I/O. Building the {@link LinkageTerms} a draft represents and
 * validating it are the sibling terms-mapping and validation modules.
 */

/**
 * The default standardization for a metadata/terms pair with the `date_of_birth`
 * pipeline's input format inferred from the operator's own rows, rather than the
 * fixed `MM/DD/YYYY` `getDefaultStandardization` assumes. The quick path
 * auto-detects the layout because it supplies no explicit standardization (the
 * exchange infers when none is given); the advanced path and the acceptor's
 * Prepare-data editor always supply one, so they must infer here or they would
 * silently parse a non-US date file with the wrong format and under-match every
 * date-of-birth key. Mirrors the exchange's own inference: the first present
 * `role: linkage` date_of_birth column's values drive {@link inferDateFormat},
 * falling back to the `MM/DD/YYYY` default when there is no such column or the
 * format cannot be inferred (e.g. seeded with no rows).
 *
 * The inferred format lives only in the local cleaning steps; the cross-party terms
 * carry the field, not its cleaning (`authoredLinkageFields` ignores steps),
 * so this never moves the agreement bytes.
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
 * widened past the fields `terms` declare to the {@link OPT_IN_LINKAGE_FIELD_TYPES}
 * fields that `enabledKeys` reference.
 *
 * The widening is what makes an opt-in key ({@link optInLinkageKeys}) match the
 * way the built-in keys do. No built-in key references one of those types, so the
 * default terms declare no field for it and cleaning derived from those terms
 * carries no pipeline for its column -- leaving an opted-in key to match the column
 * RAW, while the accepting party derives its own cleaning from the terms that DO
 * declare the field once the key is on, and cleans it. Two parties cleaning one
 * field differently match almost nothing.
 *
 * It is the ENABLED keys, not the columns, that decide it: on the guided paths a
 * draft carries the OFFER's own type-named cleaning exactly while an enabled key
 * references that field. The rule governs the offer's cleaning alone -- an
 * imported document's declared-but-unreferenced fields, and the document-named
 * bindings {@link draftWithKeyEnabled} deliberately retains, are cleaning a draft
 * holds against terms that declare nothing for it -- so what guarantees every
 * PERSISTED artifact is the mint chokepoint instead, where `generateInvitation`
 * reconciles the cleaning to the terms it embeds and asserts the two agree before
 * a secret exists. Widening on column presence would put a pipeline in every
 * guided draft over a file with such a column, serving no key and reconciled away
 * at that mint.
 *
 * A transformation the widening adds declares its field through
 * `authoredLinkageFields`' explicit branch instead of that function's synthetic
 * one, which emits the same `{ name, type }` field for a type with no default
 * field -- so a draft with no opt-in key enabled builds byte-identical terms,
 * and the guided path's cross-party hash does not move.
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

/** The keys of a draft key list that are turned on -- the set that decides which
 * fields the emitted terms declare, and so which cleaning the draft may carry. */
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
 * rows. The terms are the metadata-aware defaults (`getDefaultLinkageTerms`
 * over {@link inferMetadata}), so only keys the columns can satisfy are present and
 * the editor never opens on a blank form; the keys the built-in set does not use
 * are offered beside them, off ({@link offerableDraftKeys}). The seeded
 * standardization infers the date-of-birth format from `rawRows` and covers the
 * fields the enabled keys reference -- which, with every offer arriving off, is the
 * built-in set's own (see {@link inviterDefaultStandardization}).
 * Calling this again is exactly the "Reset to defaults" action. `rawRows`
 * defaults to empty, which yields the `MM/DD/YYYY` date default; a pre-inferred
 * `dateInputFormat` ({@link dateInputFormatForColumns}) overrides that derivation,
 * so a seed from (columns, format) matches one from full rows without them.
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
      // Carried from the recommended terms (psi / no-dedup), so a fresh draft opens
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
      // only in the local steps, which the terms do not carry).
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
 * What the guided key list offers for `metadata`: the built-in keys the columns
 * can supply, ON, with the opt-in keys the columns can supply placed among them
 * ({@link placeOfferedKeys}) and OFF -- so a fresh draft authors exactly the
 * built-in set it always did and the additions wait to be chosen.
 *
 * Each entry's `enabled` is the flag a key arrives with when it is offered for
 * the first time; {@link reconcileKeys} keeps the operator's own flag for a key
 * already in the draft, so a metadata edit never silently re-enables an opt-in
 * key that was turned off, nor turns off one that was turned on.
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
 * `keys` with each entry of `offers` inserted immediately above the first key it
 * REFINES -- carrying that key's elements and at least one more -- and at the end
 * when it refines none of them.
 *
 * List order is cascade order, and a round claims the records it matches, so a
 * refinement below the key it refines is left only what the looser key could not
 * attribute: the precision the extra element buys is spent on records the looser
 * key has already taken, several of which it may have taken wrongly. Above it,
 * the refinement claims the records both would match and the looser key still
 * catches the rest -- the most-precise-first order the built-in set is already
 * in. An offer refining nothing (`FN + EMAIL`) goes last, where a thin key
 * belongs.
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

/** Whether `key` carries every element of `coarser` and at least one more, the
 * relation that makes `key` match a subset of what `coarser` matches. Elements
 * are compared through the canonical encoding, so a transform on one of them is
 * part of the element rather than ignored; a `swap` key states a matching rule
 * its elements do not carry, so neither side of the relation may have one. */
function refines(key: LinkageKey, coarser: LinkageKey): boolean {
  if (key.swap !== undefined || coarser.swap !== undefined) return false;
  if (coarser.elements.length >= key.elements.length) return false;
  const elements = new Set(key.elements.map((el) => canonicalString(el)));
  return coarser.elements.every((el) => elements.has(canonicalString(el)));
}

/**
 * Swap in a freshly-edited column metadata and reconcile the draft's
 * standardization against it ({@link reconcileStandardization}), leaving the
 * linkage keys untouched. This is the metadata edit for an AUTHORED or IMPORTED
 * key set, where the template-driven {@link reconcileKeys} must NOT run (it would
 * silently drop keys the operator authored element-by-element or imported). The
 * standardization is still reconciled, so a column retype re-derives its cleaning
 * and cannot leave a stale transformation declaring a field whose type no longer
 * matches its column -- the protection {@link reconcileStandardization} provides
 * is orthogonal to the key set and applies on every path.
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
 * Re-derive the editor's draft for a new column metadata: editing a column's
 * semantic type changes which linkage keys are offerable (the built-in set is
 * filtered by the `role: linkage` column types present, and the opt-in keys are
 * offered on the same rule), so this recomputes the offerable key set
 * ({@link offerableDraftKeys}) and reconciles it with the current draft -- keys
 * still offerable keep their enabled flag and position, newly-offerable keys
 * arrive at the flag and the place the offer gives them ({@link reconcileKeys}),
 * and keys no longer offerable drop. The threaded metadata is
 * what the inviter's exchange binds on, so a remap that makes a key offerable also
 * makes the run actually produce it. Reconciles the standardization too, against
 * the RECONCILED key set rather than the draft's previous one, so the cleaning an
 * opt-in type gains follows the keys the edit leaves enabled; the guided path
 * drives this, the authored key set drives {@link setDraftMetadataKeepingKeys} so
 * the template key reconciliation stays off it.
 *
 * The reconciled cleaning then passes through {@link optInCleaningForKeys}, the
 * same withdrawal {@link draftWithKeyEnabled} runs when the operator turns an offer
 * off by hand: an edit to a BACKBONE column can drop an enabled offer (the offer is
 * satisfiable only while every element's column is there), and the offered type's
 * own column is untouched by that edit, so its cleaning would otherwise outlive the
 * key that minted it and leave an orphan card in the data-prep workbench. The mint
 * reconciles such a transformation away before anything persists, so this decides
 * what the workbench shows rather than what an invitation carries.
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
 * Turn the key at `index` on or off and bring the cleaning an opt-in type carries
 * with it: {@link optInLinkageKeys} offers a key referencing the type-named field
 * `authoredLinkageFields` synthesizes for a column of that type, and that field
 * holds its recommended pipeline exactly while an enabled key references it. So
 * turning an offer on is what creates its cleaning -- the data-prep workbench's
 * card for the column appears with the key -- and turning it off withdraws it,
 * leaving the draft's transformation outputs naming fields the emitted terms
 * declare.
 *
 * Only the offer's own cleaning moves. A transformation an imported document's
 * field name owns (`cell_phone` for a `phone_number` column) is not the offer's to
 * withdraw -- dropping it would leave the document's key unsupplyable and its
 * re-enabled cleaning re-derived under the wrong name -- and a built-in type's
 * cleaning is deliberately retained across a disable so re-enabling restores what
 * the operator authored, which the mint reconciles to the terms it emits
 * (`standardizationForTerms`).
 *
 * The offer's cleaning is the one an operator's own steps do not survive: custom
 * steps on an offered type's transformation are discarded when its key goes off
 * and the recommended pipeline is re-derived when it comes back on, deliberately,
 * because the accepting party derives that same pipeline from the terms and a
 * step only one side runs matches nothing.
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
 * with the offered cleaning no enabled key references dropped, and the recommended
 * pipeline added for each offered field an enabled key references and no
 * transformation yet produces. The addition is derived exactly as the seed derives
 * it ({@link inviterDefaultStandardization} over the metadata's default terms), so
 * an offer turned on cleans its column the way the accepting party -- deriving from
 * the same terms -- cleans its own. */
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
  const produced = new Set(kept.map((transformation) => transformation.output));
  const additions = inviterDefaultStandardization(
    metadata,
    getDefaultLinkageTerms(identity, metadata),
    enabledKeys,
  ).filter(
    (transformation) =>
      isOfferedTypeCleaning(transformation, columnByName) &&
      !produced.has(transformation.output),
  );
  return [...kept, ...additions];
}

/**
 * Reconcile the draft's standardization against a freshly-edited metadata, the
 * standardization analogue of {@link reconcileKeys}. A transformation is kept when
 * its input column is still present, `role: linkage`, and of the same semantic type
 * it had before the edit (so an operator's authored cleaning and any second-column
 * binding it added survive a metadata edit), and dropped when its column was
 * removed, re-roled off linkage, or RETYPED to a different type -- so a stale
 * transformation never cleans a column the core would refuse to bind (matching
 * participation requires `role: linkage`) nor declares a field whose type no longer
 * matches its column (`authoredLinkageFields` types a field by its column, so
 * a kept `first_name`-column transformation on a column retyped to `last_name` would
 * emit a `first_name`-named `last_name` field). The type change is read from the
 * column's `prevMetadata` type versus its `metadata` type, not from the
 * transformation's `output` name, so an imported field whose name does not match its
 * type (declarations name and type fields independently) is judged by its column
 * alone. A semantic type the kept set no longer covers (a newly-typed column, or one
 * whose only transformation was just dropped for a type change) gains the recommended
 * default cleaning, mirroring how {@link reconcileKeys} appends a newly-offerable key.
 * With no edits this returns the unchanged default standardization (every default
 * transformation is kept and every type covered), so a metadata-untouched draft stays
 * byte-identical.
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

/**
 * `value` with every explicitly-`undefined` property dropped, recursively, and
 * every other value returned by reference.
 *
 * An optional property set to `undefined` states the same linkage key an absent
 * one does, and every surface reads the two the same way, but only the absent
 * form is inside the canonical domain: {@link encodeForComparison} answers `null`
 * for the explicit form. Unpruned, such a key matches no offer -- so a draft
 * whose keys all carry the property (a spread of the whole list is all it takes)
 * would arrive entirely off, the operator's built-in set and their own chosen
 * offer together.
 *
 * Only a plain object or an array is rebuilt, and only where the prune removed
 * something, so a key outside the canonical domain for any OTHER reason -- a
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

/** `key` in the byte form {@link reconcileKeys} matches a draft key to an offer
 * under: the canonical encoding of the key with its explicitly-`undefined`
 * optional properties dropped (see {@link withoutUndefinedProperties}), or
 * `null` when the key cannot be canonically encoded at all. */
function encodeKeyForComparison(key: LinkageKey): string | null {
  try {
    return encodeForComparison(withoutUndefinedProperties(key));
  } catch {
    // The prune reads every enumerable property, so a getter that throws escapes
    // here rather than into the encoder's own boundary guard. A key that cannot
    // be read is incomparable, the answer encodeForComparison gives a key it
    // cannot encode.
    return null;
  }
}

/** Reconcile the draft's keys against a freshly-derived offer
 * ({@link offerableDraftKeys}): keep the order and enabled flag of keys that
 * remain offered (replacing the key object with the fresh template), then append
 * any newly-offered built-in key at the flag it is offered at and place a
 * newly-offered opt-in key where the offer places it ({@link placeOfferedKeys}),
 * which is above whichever key it refines wherever the operator has moved that
 * one. Appending an opt-in key instead would land a retype-driven offer below the
 * key it refines, the one position where turning it on buys nothing.
 *
 * A draft key is matched to an offer through the canonical encoding
 * ({@link encodeKeyForComparison}), the equality the two parties' terms are
 * compared under, rather than by NAME. What the match carries over is the
 * operator's enabled flag onto the offer's own shape, so under name equality a key
 * that merely borrows an offer's name -- one element of it, or an unrelated key an
 * imported document declares under that name -- would hand its enabled flag to the
 * full offered key and turn on an addition the operator never chose. A key matching
 * no offer is no longer offered and drops, the same as a built-in key whose columns
 * went away.
 *
 * An offer left unmatched by such a drop is RE-OFFERED in the dropped entry's own
 * place and OFF, rather than at the flag and the position the offer gives it,
 * whenever the dropped entry carried the offer's name. The name is what the
 * operator saw beside the checkbox, so a key of that name whose shape no longer
 * matches the offer -- a stored draft carrying an older shape of a built-in key --
 * is a departure from the offer rather than a fresh one: arriving at the offer's
 * own flag would turn a built-in key back on over the operator's decision to turn
 * it off, on a consent surface, and moving it would change what the cascade claims
 * ahead of the keys below it. An offer no dropped entry named is genuinely new and
 * arrives at the flag and the place the offer gives it (off, for an opt-in key).
 *
 * The dropped entry's place is what an OPT-IN re-offer inherits too. Position is
 * decided by whether the list already held a key of that name, not by which set
 * the offer comes from: a list the operator has read and arranged states where its
 * keys sit, and {@link placeOfferedKeys} chooses a position only for a key that
 * list did not already hold. So an opt-in offer re-added over an older shape of
 * itself stays put -- including below the key it refines, where the operator
 * themselves moved it -- rather than jumping up the cascade on a metadata edit
 * that changed nothing about it. */
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
  for (const entry of fresh)
    if (!isOptInLinkageKey(entry.key)) kept.push(entry);
  return placeOfferedKeys(
    kept,
    fresh.filter((entry) => isOptInLinkageKey(entry.key)),
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

/**
 * Append a same-typed linkage field bound to the type's first free
 * `role: linkage` column, named uniquely off the type's first field and seeded
 * with its steps -- so the second field starts from the same recommended
 * pipeline. A type with no free column returns the draft unchanged (the
 * add-field affordance is gated on one existing).
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
  let n = 2;
  let output = `${base}_${n}`;
  while (taken.has(output)) output = `${base}_${++n}`;
  return {
    ...draft,
    standardization: [
      ...draft.standardization,
      { output, input: freeColumn, steps: sibling?.steps ?? [] },
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

/** Replace the linkage key at `keyIndex` by applying `fn` to it. The basis for
 * every expert key edit (rename, swap, and -- via {@link updateElementAt} -- the
 * element edits), so the immutable update lives in one place. */
export function updateKeyAt(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  fn: (key: LinkageKey) => LinkageKey,
): AdvancedInviteDraft {
  return {
    ...draft,
    keys: draft.keys.map((entry, i) =>
      i === keyIndex ? { ...entry, key: fn(entry.key) } : entry,
    ),
  };
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
 * key is referentially valid and non-empty by construction). */
export function addKey(
  draft: AdvancedInviteDraft,
  fieldName: string,
): AdvancedInviteDraft {
  const name = uniqueKeyName(
    "New key",
    new Set(draft.keys.map((entry) => entry.key.name)),
  );
  const key: LinkageKey = { name, elements: [{ field: fieldName }] };
  return { ...draft, keys: [...draft.keys, { key, enabled: true }] };
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
    // `name ?? field` the schema requires unique within a key, and the value the
    // swap control lists as an option). A new element starts as a bare field
    // reference, so when that field already identifies an element here -- the common
    // case, since the field picker defaults to the first declared field -- give the
    // new one a distinct alias. Otherwise two same-field elements would share an
    // identifier: a state the schema rejects (blocking Generate) AND one that feeds
    // the swap control duplicate option values, which Mantine throws on -- crashing
    // the editor before the validation message can surface. The operator can rename
    // or clear the alias afterward. Mirrors addKey/addFieldForType, which likewise
    // construct unique names rather than emitting a collision.
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
 * Reconstruct the importer's local standardization for an imported terms document.
 * Standardization is per-party and never travels in the token, so the imported
 * {@link LinkageTerms} carry the field DECLARATIONS (`linkageFields`) but not the
 * column BINDING that produced them; this rebuilds a binding the inviter's own
 * columns can satisfy, the import-time analogue of the workbench's `addFieldForType`
 * (the producer of these bindings).
 *
 * It starts from the full per-type default ({@link defaultStandardizationForRows}
 * over the seed's default terms -- the standardization a single-field import opens
 * on), then adds a binding for each imported linkage field the default does not
 * already declare: the multi-field fields, a second-or-later field of one semantic
 * type (e.g. `first_name_2`), and every field of an `OPT_IN_LINKAGE_FIELD_TYPES`
 * type, which the default terms declare under no name at all. Each such field
 * binds to the next `role: linkage` column of its type not already bound -- one the
 * operator designated for matching, NOT an `identifier`- or `payload`-roled column
 * (see the binding rationale at the column search below) -- reusing its type's
 * recommended cleaning steps (derived from {@link defaultStandardizationForRows}
 * over the IMPORTED terms, so the steps and the row-inferred date format hold even
 * when the seed's default terms declare no field of that type).
 *
 * The base is that unwidened default rather than the seed path's
 * {@link inviterDefaultStandardization}: the widening binds an opt-in type's first
 * column to a field named for the type, which on this path claims the column ahead
 * of the loop below and leaves an imported field the document named otherwise
 * (`cell_phone` for a `phone_number` column) with nothing free to bind. Here the
 * imported document's own field names decide the binding; the widening serves the
 * guided path, where no document has named anything.
 *
 * The reconstructed binding is local and never enters the token, so it cannot move
 * the cross-party hash; `authoredLinkageFields` over the result re-declares the
 * imported fields by name and type, bound to their reconstructed columns, which lets
 * {@link buildAdvancedTerms} build and validate terms referencing them. For terms the
 * editor itself produced this reproduces the imported `linkageFields` exactly (see the
 * import round-trip test). For an externally-authored document the FIELD declaration
 * itself is preserved by {@link buildAdvancedTerms} via
 * {@link AdvancedInviteDraft.importedLinkageFields} -- field order and any
 * declared-but-unreferenced field are kept rather than normalized to the fixed authored
 * order -- so this reconstruction only has to bind the fields its keys reference. The
 * one facet not carried is a custom per-field `constraint` the editor cannot
 * represent: it is re-stamped to the type default on rebuild and caught fail-closed at
 * the import door ({@link importedConstraintDivergenceMessage} refuses a document whose
 * custom constraints that rebuild would normalize away), so it never silently reaches a
 * generated agreement.
 *
 * Fail-closed: a field whose type has no free `role: linkage` column left (the
 * inviter's columns cannot supply a distinct binding the operator marked for
 * matching) gets no transformation -- it is never bound to an absent, `ignored`,
 * `identifier`/`payload`-roled, wrong-typed, or already-taken column, so a
 * reconstructed binding is never a silent mis-bind. The field stays undeclared; a key
 * that references only reconstructed fields is satisfiable, while one that still
 * references the undeclared field cannot generate (the built terms would reference an
 * undeclared field, which the schema rejects). An import that declares only the single
 * default field per type adds nothing, so it reconstructs the seed's default
 * standardization byte-for-byte.
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
  // key uses, which the seed's default terms (and so `base`) do not carry -- and
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

/** Build an editor draft from imported, validated {@link LinkageTerms}. identity,
 * output direction, algorithm, deduplicate, linkage strategy, the optional legal
 * agreement, and every linkage key (all enabled) come from the imported terms; the
 * column
 * metadata stays the inviter's own (`seed.metadata`), since terms carry no
 * per-party column binding, and the lifetime is the caller's (terms do not carry
 * it). The local standardization is reconstructed from the imported field
 * declarations against the inviter's columns (see
 * {@link standardizationForImportedTerms}), so a multi-field document's distinct
 * same-typed bindings are restored when the columns can supply them and the editor's
 * own multi-field export round-trips; a field no column can satisfy stays undeclared
 * and is never silently mis-bound (see {@link standardizationForImportedTerms} for the
 * round-trip's limits on an externally-authored document). The caller refuses a
 * gated-active import first (see {@link gatedActiveSettingMessage}). */
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
  // supply: one referencing a field no column declares (more same-typed fields than
  // columns of that type, or the type absent entirely). Such a key dangles the built
  // terms and would otherwise block the WHOLE import behind a referential-integrity
  // failure (the misleading "Enable at least one linkage key." on the keys control)
  // even when other keys are satisfiable. Disabling it lets the satisfiable subset
  // still generate, while the key stays visible -- its red "not satisfiable" badge is
  // the reason the operator can read -- to re-enable once a matching column exists.
  // Disable-and-show, not silent drop, so the import never hides what the document
  // asked for. validateAdvancedInvite carries the matching message when an
  // unsupplyable key is re-enabled or none is supplyable at all.
  const declarable = declarableFieldNames(seed.metadata, standardization);
  const draft: AdvancedInviteDraft = {
    identity: terms.identity,
    lifetimeSeconds,
    outputDirection: directionForOutput(terms.output),
    algorithm: terms.algorithm,
    deduplicate: terms.deduplicate,
    // Reflect the imported strategy so the control shows it and an export
    // round-trips it. Adopted as-is rather than refused: the strategy is a term
    // the run honors whichever value it carries, so gatedActiveSettingMessage
    // deliberately carries no branch for it.
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
    // Carry the imported field declaration so buildAdvancedTerms re-emits it faithfully
    // (order + declared-but-unreferenced fields + a benign empty `constraints: {}`); see
    // AdvancedInviteDraft.importedLinkageFields.
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
  // cannot supply) left the citation standing: buildAdvancedTerms carries
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
