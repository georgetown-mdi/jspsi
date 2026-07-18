import {
  INVITATION_LIFETIME_SECONDS,
  authoredLinkageFields,
  columnValues,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferDateFormat,
  inferMetadata,
} from "@psilink/core";

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
 * the editor never opens on a blank form; the seeded standardization infers the
 * date-of-birth format from `rawRows` (see {@link defaultStandardizationForRows}).
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
  return {
    draft: {
      identity,
      lifetimeSeconds: INVITATION_LIFETIME_SECONDS,
      // The default is the symmetric both-receive exchange, matching the quick
      // path and getDefaultLinkageTerms' output.
      outputDirection: "both",
      // Carried from the recommended terms (psi / no-dedup); the gated controls
      // hold these at the safe defaults until APPLIED_SETTINGS flips.
      algorithm: terms.algorithm,
      deduplicate: terms.deduplicate,
      // The default strategy (`cascade`). Ungated -- the control writes it straight
      // through -- so a fresh draft authors cascade exactly as before the control
      // existed.
      linkageStrategy: terms.linkageStrategy,
      metadata,
      // The recommended per-type cleaning for these columns, with the dob format
      // inferred from the rows. authoredLinkageFields over this reproduces the
      // default per-type field set (one field per type), so the seeded draft's terms
      // equal getDefaultLinkageTerms' -- the editor opens on a known-good valid
      // state, byte-identical to the quick path's (the inferred format lives only in
      // the local steps, which the terms do not carry).
      standardization: defaultStandardizationForRows(
        metadata,
        terms,
        rawRows,
        dateInputFormat,
      ),
      keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
    },
    seed: { terms, metadata, columns },
  };
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
      rawRows,
      dateInputFormat,
    ),
  };
}

/**
 * Re-derive the editor's draft for a new column metadata: editing a column's
 * semantic type changes which linkage keys are offerable (`getDefaultLinkageTerms`
 * filters by the `role: linkage` column types present), so this recomputes the
 * offerable key set and reconciles it with the current draft -- keys still
 * offerable keep their enabled flag and position, newly-offerable keys are
 * appended (enabled), and keys no longer offerable drop. The threaded metadata is
 * what the inviter's exchange binds on, so a remap that makes a key offerable also
 * makes the run actually produce it. Reconciles the standardization too (via
 * {@link setDraftMetadataKeepingKeys}); the guided path drives this, the authored
 * key set drives the keep-keys variant so the template key reconciliation stays
 * off it.
 */
export function setDraftMetadata(
  draft: AdvancedInviteDraft,
  metadata: Metadata,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): AdvancedInviteDraft {
  const offerable = getDefaultLinkageTerms(
    draft.identity,
    metadata,
  ).linkageKeys;
  return {
    ...setDraftMetadataKeepingKeys(draft, metadata, rawRows, dateInputFormat),
    keys: reconcileKeys(draft.keys, offerable),
  };
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
  // same way the seed is (defaultStandardizationForRows over the metadata's default
  // terms), so a newly-typed column gains exactly the recommended per-type pipeline
  // -- including the row-inferred date format for a column just retyped to
  // date_of_birth.
  const fullDefault = defaultStandardizationForRows(
    metadata,
    getDefaultLinkageTerms(identity, metadata),
    rawRows,
    dateInputFormat,
  );
  const additions = fullDefault.filter((transformation) => {
    const column = columnByName.get(transformation.input);
    return column !== undefined && !coveredTypes.has(column.type);
  });
  return [...kept, ...additions];
}

/** Reconcile the draft's keys against a freshly-derived offerable set: keep the
 * order and enabled flag of keys that remain offerable (replacing the key object
 * with the fresh template), then append any newly-offerable key as enabled. */
function reconcileKeys(
  prevKeys: Array<DraftKey>,
  offerable: Array<LinkageKey>,
): Array<DraftKey> {
  const offerableByName = new Map(offerable.map((key) => [key.name, key]));
  const kept: Array<DraftKey> = [];
  const seen = new Set<string>();
  for (const entry of prevKeys) {
    const fresh = offerableByName.get(entry.key.name);
    if (fresh !== undefined) {
      kept.push({ key: fresh, enabled: entry.enabled });
      seen.add(entry.key.name);
    }
  }
  for (const key of offerable) {
    if (!seen.has(key.name)) kept.push({ key, enabled: true });
  }
  return kept;
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
 * over the seed's default terms -- the standardization a single-field import has
 * always opened on, and the seed's own), then adds a binding for each imported
 * linkage field the default does not already declare: the multi-field fields, a
 * second-or-later field of one semantic type (e.g. `first_name_2`). Each such field
 * binds to the next `role: linkage` column of its type not already bound -- one the
 * operator designated for matching, NOT an `identifier`- or `payload`-roled column
 * (see the binding rationale at the column search below) -- reusing its type's
 * recommended cleaning steps (derived from {@link defaultStandardizationForRows}
 * over the IMPORTED terms, so the steps and the row-inferred date format hold even
 * when the seed's default terms declare no field of that type).
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
  // seed's), so it covers every imported field's type -- including one the inviter
  // has columns for but no default key uses, which the seed's default terms (and so
  // `base`) would not carry -- and bakes in the row-inferred date format. The input
  // columns it picks collide on the first per type; only the steps are read here,
  // and the distinct columns are assigned below.
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
    // and so hash that column's value into a PSI key without consent. This now
    // matches core's own rule on every path: `resolveFieldColumns` binds only
    // a `role: linkage` column, and the workbench's `addFieldForType` /
    // `columnsForType` likewise offer only linkage columns -- so the import path is
    // no longer stricter than the rest, it applies the same `role: linkage`
    // requirement here. An extra field with no free `linkage` column stays
    // undeclared (fail-closed); the operator establishes the binding by roling the
    // column `linkage` and binding it in the workbench. The default base's
    // first-column-per-type binding comes from the same core rule, so it too binds
    // only `role: linkage` columns.
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
  return {
    identity: terms.identity,
    lifetimeSeconds,
    outputDirection: directionForOutput(terms.output),
    algorithm: terms.algorithm,
    deduplicate: terms.deduplicate,
    // Reflect the imported strategy so the control shows it and an export
    // round-trips it. Ungated, so unlike a gated psi-c/dedup an imported
    // single-pass is adopted as-is rather than refused (gatedActiveSettingMessage
    // deliberately carries no branch for it).
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
    keys: terms.linkageKeys.map((key) => ({
      key,
      enabled: keyIsSupplyable(key, declarable),
    })),
  };
}
