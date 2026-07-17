import {
  CanonicalEncodingError,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assessLinkageSatisfiability,
  authoredLinkageFields,
  canonicalString,
  columnValues,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferDateFormat,
  inferMetadata,
  referencedLinkageFieldNames,
  safeParseLinkageTerms,
} from "@psilink/core";

import { normalizeForEditor, payloadSendForMetadata } from "./metadataEditing";
import { APPLIED_SETTINGS } from "./appliedSettings";
import { isStepValid } from "./standardizationAuthoring";

import type {
  Algorithm,
  CSVRow,
  ExchangeDataSpec,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  Output,
  Standardization,
} from "@psilink/core";

/** The per-element fuzzy-comparison expansion, derived from the core element type
 * (core does not export the bare union). `undefined` means no expansion. */
export type FuzzyComparison = NonNullable<
  LinkageKeyElement["generateFuzzyComparisons"]
>;

/**
 * The pure data model behind the inviter's authoring bench: seeding a draft from the
 * inviter's columns, building the {@link LinkageTerms} a draft represents, and
 * validating it. No React, no I/O -- the single tested boundary the bench
 * drives, so the seed/build/validate contract is checked here rather
 * than through the UI.
 *
 * Scope: the guided editor reviews and reorders the metadata-derived default
 * keys, edits the per-party column metadata (semantic type and disclosure -- see
 * {@link setDraftMetadata}), chooses who receives the matched results (the 3-way
 * output direction -- see {@link OutputDirection}), and attaches identity,
 * lifetime, and an optional legal agreement. An expert tier additionally authors
 * linkage keys element-by-element (a field reference chosen from the declared
 * list, a per-element transform pipeline, and a two-of-N swap -- see
 * {@link addKey}, {@link updateElementAt}, and the sibling helpers) and
 * imports/exports the whole terms document.
 *
 * `algorithm` (psi-c), `deduplicate`, and per-element fuzzy comparisons are GATED:
 * {@link buildAdvancedTerms} clamps them to the applied behavior (`psi` / no-dedup
 * / no-fuzzy) while their {@link APPLIED_SETTINGS} flag is false, the editor
 * controls are disabled to match, and an import that turns one on is refused
 * ({@link gatedActiveSettingMessage}) -- so the editor can never mint an invitation
 * whose headline behavior silently does not happen (psi-c being the privacy
 * footgun). No payload block is authored into the terms. The output direction is
 * settable now that one-sided output is honored end-to-end (the acceptor mirrors
 * the inviter's output and the exchange withholds the result from a non-receiving
 * party). The column METADATA is editable and threaded into the inviter's own
 * `prepareForExchange` (never the token), so its disclosure choices govern what
 * the inviter sends without touching the agreed terms.
 */

/** One linkage key in the editor, paired with whether it is active. Display and
 * match order is the array position (linkage keys are applied most-precise-first,
 * so order is significant); a disabled key is dropped from the built terms. */
export interface DraftKey {
  key: LinkageKey;
  enabled: boolean;
}

/**
 * Who receives the matched results, from the INVITER's point of view:
 * - `"both"`   -- both parties receive (the default, symmetric exchange).
 * - `"inviter"` -- only the inviter ("me") receives; the partner is the helper.
 * - `"partner"` -- only the partner receives; the inviter is the helper.
 *
 * This is the editor's representation of the {@link Output} pair. Modeling it as
 * a 3-value choice (rather than two independent booleans) makes the forbidden
 * "neither party receives" combination unrepresentable by construction: there is
 * no draft state that maps to `{ expectsOutput: false, shareWithPartner: false }`,
 * which `validateCompatibility` rejects ("neither party expects output").
 */
export type OutputDirection = "both" | "inviter" | "partner";

/** Map an {@link OutputDirection} to the inviter's {@link Output} pair. The three
 * cases are exactly the three valid (non-"neither") combinations, so no choice can
 * yield a forbidden pair. The acceptor derives its own (mirrored) output from
 * these terms at accept time (see `deriveAcceptedLinkageTerms` in core). */
export function outputForDirection(direction: OutputDirection): Output {
  switch (direction) {
    case "both":
      return { expectsOutput: true, shareWithPartner: true };
    case "inviter":
      return { expectsOutput: true, shareWithPartner: false };
    case "partner":
      return { expectsOutput: false, shareWithPartner: true };
  }
}

/** The optional legal-agreement block, as the editor holds it before validation.
 * Free text is NFC-normalized and trimmed when the terms are built (see
 * {@link buildAdvancedTerms}); the expiry check lives in
 * {@link validateAdvancedInvite}, not the core schema. */
export interface DraftLegalAgreement {
  reference: string;
  purpose: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  expirationDate: string;
}

/** The editor's in-progress state. `identity` and `lifetimeSeconds` and the
 * optional `legalAgreement` are author-controlled; `keys` carries the seed's
 * linkage keys with their enabled flags, reorderable in place. */
export interface AdvancedInviteDraft {
  identity: string;
  /** Invitation lifetime in seconds; threaded into `generateInvitation`, not the
   * linkage terms. Bounded in {@link validateAdvancedInvite}. */
  lifetimeSeconds: number;
  /** Who receives the matched results (see {@link OutputDirection}); applied to
   * the built terms' `output` by {@link buildAdvancedTerms}. Defaults to `"both"`
   * (the symmetric exchange). The forbidden "neither receives" pair is
   * unrepresentable -- it has no `OutputDirection`. */
  outputDirection: OutputDirection;
  /** The matching algorithm. `psi` reveals matched identifiers; `psi-c` reveals
   * only the count. Gated: {@link buildAdvancedTerms} clamps it to `psi` while
   * {@link APPLIED_SETTINGS}.psiC is false, so the built terms can never carry a
   * count-only setting the run does not yet honor (the editor control is disabled
   * to match). Carried so the control unlocks the moment the flag flips. */
  algorithm: Algorithm;
  /** Whether more than one of the holder's records may match the same partner
   * record -- deduplication of the holder's OWN inputs, which lets multiple of its
   * inputs map to the same matched output (see EXCHANGE_REFERENCE
   * `linkage_terms.deduplicate`). Gated: {@link buildAdvancedTerms} clamps it to
   * `false` while {@link APPLIED_SETTINGS}.deduplicate is false. */
  deduplicate: boolean;
  /** How the agreed linkage keys are exchanged (see {@link LinkageStrategy}).
   * `cascade` (the default) matches keys one round at a time; `single-pass`
   * batches them into one exchange for a round-trip count constant in the number
   * of keys, at the cost of disclosing the sender's full per-key value structure
   * to the receiver. Unlike {@link AdvancedInviteDraft.algorithm} and
   * `deduplicate` this is NOT gated -- single-pass is honored end-to-end -- so
   * {@link buildAdvancedTerms} writes it straight through with no clamp; the
   * consent tradeoff is surfaced at the control. Seeded from the default terms
   * (`cascade`) and reflected from an imported document. */
  linkageStrategy: LinkageStrategy;
  legalAgreement?: DraftLegalAgreement;
  /** The inviter's per-party column metadata (semantic type + disclosure role),
   * editable in the grid. Editing a column's type re-derives which keys are
   * offerable (see {@link setDraftMetadata}); the disclosure choice governs what
   * the inviter sends and is threaded into its exchange spec. Seeded from
   * {@link inferMetadata}, normalized so the collapsed disclosure control is
   * faithful. */
  metadata: Metadata;
  /**
   * The inviter's per-party standardization: the ordered cleaning steps and the
   * input-column binding for each field. Seeded from {@link getDefaultStandardization}
   * (so the editor opens on the recommended per-type cleaning, and -- with no edits --
   * {@link authoredLinkageFields} over it reproduces the guided default field set
   * byte-for-byte, keeping the cross-party terms unchanged). The data-prep workbench
   * edits it; {@link buildAdvancedTerms} derives the linkage FIELDS from it via
   * {@link authoredLinkageFields}, which is what lets two transformations of one
   * semantic type bind to distinct columns and declare two fields. Threaded into the
   * inviter's own `prepareForExchange` (never the token), so the cleaning it authors
   * is the cleaning the run applies. Reconciled against a metadata edit by
   * {@link setDraftMetadata}. */
  standardization: Standardization;
  keys: Array<DraftKey>;
  /**
   * The `linkageFields` declaration of an IMPORTED terms document, carried verbatim
   * for round-trip fidelity. Set only by {@link draftFromTerms}; absent for the seed,
   * guided, and expert paths. When present, {@link reconcileImportedFields} governs how
   * the rebuild reconciles it.
   */
  importedLinkageFields?: Array<LinkageField>;
}

/** The fixed starting point for an editor session: the auto-derived terms the
 * draft seeds from, plus the columns those terms were derived from (kept for the
 * live satisfiability check, which is over column shape). */
export interface AdvancedInviteSeed {
  /** The metadata-aware auto-derived terms ({@link getDefaultLinkageTerms} over
   * the file's inferred metadata) -- the same terms the quick path would embed for
   * these columns, so the editor opens on a known-good valid state. */
  terms: LinkageTerms;
  /** The inferred, normalized starting metadata -- the reset anchor for the grid
   * (the draft's `metadata` opens equal to this). */
  metadata: Metadata;
  /** The inviter's CSV column names. */
  columns: Array<string>;
}

/** A control an editor error attaches to, so the component can render the message
 * inline beside the offending input rather than as a page-level alert. */
export type AdvancedField =
  | "identity"
  | "lifetime"
  | "legalReference"
  | "legalPurpose"
  | "legalExpiration"
  | "payload"
  | "keys"
  | "standardization";

/** The result of validating a draft: whether Generate may proceed, the built
 * terms when they parse cleanly, and per-control error messages. */
export interface AdvancedValidation {
  /** True only when the draft parses through the core schema, every non-schema
   * gate (lifetime bounds, a future legal-agreement expiry, at least one
   * column-satisfiable key) passes, and the terms canonically encode. */
  canGenerate: boolean;
  /** The terms the draft represents, present only when {@link canGenerate}. The
   * component passes these to `generateInvitation` verbatim. */
  terms?: LinkageTerms;
  /** Per-control error messages; an absent field has no error. */
  errors: Partial<Record<AdvancedField, string>>;
}

/**
 * The default standardization for a metadata/terms pair with the `date_of_birth`
 * pipeline's input format inferred from the operator's own rows, rather than the
 * fixed `MM/DD/YYYY` {@link getDefaultStandardization} assumes. The quick path
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
 * carry the field, not its cleaning ({@link authoredLinkageFields} ignores steps),
 * so this never moves the agreement bytes.
 */
export function defaultStandardizationForRows(
  metadata: Metadata,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
): Standardization {
  const dobColumn = metadata.find(
    (column) => column.type === "date_of_birth" && column.role === "linkage",
  );
  const dateInputFormat =
    dobColumn !== undefined
      ? inferDateFormat(columnValues(rawRows, dobColumn.name))
      : undefined;
  return getDefaultStandardization(metadata, terms, { dateInputFormat });
}

/**
 * Seed an editor session from the inviter's identity, CSV columns, and parsed
 * rows. The terms are the metadata-aware defaults ({@link getDefaultLinkageTerms}
 * over {@link inferMetadata}), so only keys the columns can satisfy are present and
 * the editor never opens on a blank form; the seeded standardization infers the
 * date-of-birth format from `rawRows` (see {@link defaultStandardizationForRows}).
 * Calling this again is exactly the "Reset to defaults" action. `rawRows`
 * defaults to empty, which yields the `MM/DD/YYYY` date default.
 */
export function seedAdvancedInvite(
  identity: string,
  columns: Array<string>,
  rawRows: ReadonlyArray<CSVRow> = [],
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
      standardization: defaultStandardizationForRows(metadata, terms, rawRows),
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
    ),
  };
}

/**
 * Re-derive the editor's draft for a new column metadata: editing a column's
 * semantic type changes which linkage keys are offerable ({@link getDefaultLinkageTerms}
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
): AdvancedInviteDraft {
  const offerable = getDefaultLinkageTerms(
    draft.identity,
    metadata,
  ).linkageKeys;
  return {
    ...setDraftMetadataKeepingKeys(draft, metadata, rawRows),
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
 * matches its column ({@link authoredLinkageFields} types a field by its column, so
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
  );
  const additions = fullDefault.filter((transformation) => {
    const column = columnByName.get(transformation.input);
    return column !== undefined && !coveredTypes.has(column.type);
  });
  return [...kept, ...additions];
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

/** NFC-normalize and trim a free-text value. NFC is the cross-party canonical
 * form linkage-terms free text is compared in (see the board item's
 * implementation notes); trimming drops incidental surrounding whitespace so a
 * space-only value reads as empty to the schema's `.min(1)`. */
function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/** Whether `constraints` is an empty object (`{}`) -- a present key declaring nothing.
 * An empty `{}` is behaviorally identical to absent constraints (core's
 * `checkValueConstraints` flags nothing for it; it never affects matching), but its
 * canonical form differs from an absent key, so the faithful import round-trip preserves
 * it verbatim for a field whose type has no default constraint rather than dropping it --
 * which would move the agreement hash and (before this) trip item 203437315's
 * refuse-on-import guard. See {@link reconcileImportedFields}. */
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

/** Today's date as YYYY-MM-DD, for the legal-agreement expiry check. Matches the
 * slice `validateCompatibility` uses for the same comparison at exchange time
 * (`new Date().toISOString().slice(0, 10)`), and the editor compares it the same
 * way (strictly before today is expired), so the editor refuses exactly the
 * expired dates the exchange would. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The field names a metadata/standardization pair can declare -- the universe
 * {@link buildAdvancedTerms} draws its `linkageFields` from
 * ({@link authoredLinkageFields}). A key element whose `field` is absent from this
 * set dangles: the built terms would reference an undeclared field, which
 * {@link safeParseLinkageTerms}'s referential-integrity refine rejects. */
function declarableFieldNames(
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

/** Whether the inviter's columns can supply every field `key` references (each
 * element's `field` is declarable -- see {@link declarableFieldNames}). A key that
 * is not supplyable dangles the built terms, so the import disables it
 * ({@link draftFromTerms}) and {@link validateAdvancedInvite} messages it distinctly
 * from a draft whose keys were merely turned off. */
function keyIsSupplyable(
  key: LinkageKey,
  declarable: ReadonlySet<string>,
): boolean {
  return key.elements.every((element) => declarable.has(element.field));
}

/** Shown when generation is blocked because an enabled linkage key references a
 * field the inviter's columns cannot supply, or no key is supplyable at all --
 * distinct from {@link messageForField}'s "Enable at least one linkage key." so an
 * operator can tell "a key needs a field your columns cannot supply" apart from
 * "you turned every key off." Deliberately names no specific field: the offending
 * element's `field` reference can be partner-controlled (it rides an imported
 * document), so echoing it here would surface partner text into the UI -- the same
 * reason {@link messageForField} and core's referential-integrity refine locate the
 * offender by issue path rather than by value. The operator identifies the key from
 * its red "not satisfiable" badge in the key list instead. */
const UNSUPPLYABLE_KEY_MESSAGE =
  "A linkage key needs a field your columns cannot supply. Add a column of that " +
  "type, or turn that key off.";

/**
 * Validate a draft for the Generate gate. The core schema
 * ({@link safeParseLinkageTerms}) is the single source for everything it covers
 * (identity/legal-text presence, the date format, referential integrity); this
 * adds only the gates the schema does not express: the invitation-lifetime
 * bounds (not part of the terms), a not-yet-passed legal-agreement expiry (the
 * schema checks format, not that the date is still current -- the exchange
 * rejects an already-passed date later, so refuse it up front), at least one
 * column-satisfiable linkage key, and a
 * canonical-encode dry run (the byte form both parties hash; refuse a value that
 * cannot encode rather than fail cross-party).
 *
 * Schema errors are mapped back to the offending control by their issue path --
 * the editor re-derives the control because the referential-integrity refines
 * report at the array path by design, echoing no value.
 */
export function validateAdvancedInvite(
  draft: AdvancedInviteDraft,
  seed: AdvancedInviteSeed,
  now: Date = new Date(),
): AdvancedValidation {
  const terms = buildAdvancedTerms(draft);
  const errors: Partial<Record<AdvancedField, string>> = {};

  // Lifetime is a generateInvitation parameter, not part of the terms, so it is
  // not covered by the schema. Mirror generateInvitation's own bounds.
  if (
    !Number.isFinite(draft.lifetimeSeconds) ||
    draft.lifetimeSeconds <= 0 ||
    draft.lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS
  ) {
    errors.lifetime =
      "Choose an invitation duration between 1 second and one year.";
  }

  // A key is supplyable when the inviter's columns can declare every field it
  // references; one that is not dangles the built terms (the referential-integrity
  // refine rejects the undeclared field) and blocks generation. The two checks below
  // set the accurate keys message up front so it wins over the generic
  // schema-failure mapping, which collapses every linkageKeys-path issue to
  // "Enable at least one linkage key."
  const declarable = declarableFieldNames(
    draft.metadata,
    draft.standardization,
  );
  const enabledKeys = draft.keys.filter((entry) => entry.enabled);
  // At least one key must be active. The schema's linkageKeys .min(1) also
  // catches the none-enabled case, but a dedicated message reads better against
  // the key list.
  if (enabledKeys.length === 0) {
    // No key is active. Enabling one fixes it ONLY if a supplyable key exists --
    // checked across ALL keys, enabled or not, since the question is whether
    // enabling one COULD help. When none is supplyable (a fully-unsupplyable
    // import, every key referencing a field the columns cannot supply), "turn one
    // on" would mislead, so name the real obstacle instead, preserving the
    // fail-closed refusal.
    const someKeyIsSupplyable = draft.keys.some((entry) =>
      keyIsSupplyable(entry.key, declarable),
    );
    errors.keys = someKeyIsSupplyable
      ? "Enable at least one linkage key."
      : UNSUPPLYABLE_KEY_MESSAGE;
  } else if (
    enabledKeys.some((entry) => !keyIsSupplyable(entry.key, declarable))
  ) {
    // An enabled key references a field the columns cannot supply: the built terms
    // dangle, so block with the accurate message rather than the misleading no-keys
    // one the schema-failure mapping would otherwise produce.
    errors.keys = UNSUPPLYABLE_KEY_MESSAGE;
  }

  // The "non-receiving-party-cannot-receive" rule, enforced live: sending payload
  // to a partner that receives no result is incoherent -- the partner has no matched
  // records to attach it to, and the acceptor's mirror (receive = this send, with
  // expectsOutput false) is exactly what the schema rejects at accept time
  // (deriveAcceptedLinkageTerms throws). Block it here so the inviter never mints an
  // invitation the partner cannot accept. The check reads the same disclosed set
  // buildAdvancedTerms derives the send from, so it fires precisely when the built
  // terms carry a payload.send the chosen direction makes unacceptable.
  if (
    !outputForDirection(draft.outputDirection).shareWithPartner &&
    disclosedColumnNames(draft.metadata).length > 0
  ) {
    errors.payload =
      "Some columns are set to be sent to your partner, but you chose that only " +
      "you receive the matched results. Your partner cannot receive payload for a " +
      "result it does not get. Either share the results with your partner, or set " +
      "those columns so they are not sent.";
  }

  const parsed = safeParseLinkageTerms(terms);
  if (!parsed.success) {
    // Each control touched by a schema issue gets its control-specific message
    // (the message is keyed on the control, not the individual issue, so the set of
    // affected controls is all that matters). Keep the first message per control:
    // the keys control deliberately sets its accurate message up front so it wins
    // over the generic schema mapping, and stacking several messages on one input
    // is noise. The payload control is the one exception -- a schema payload error
    // (e.g. an over-long sent column name) is a second, distinct obstacle from the
    // direction-conflict message that may already occupy it, so both are surfaced
    // rather than letting the direction conflict mask the schema problem and leave
    // the operator unaware of an obstacle that still blocks generation.
    const schemaFields = new Set(
      parsed.error.issues.map((issue) => fieldForIssuePath(issue.path)),
    );
    for (const field of schemaFields) {
      const existing = errors[field];
      if (existing === undefined) {
        errors[field] = messageForField(field);
      } else if (field === "payload") {
        // Lead with the schema/column error and trail the direction conflict: the
        // schema error is the obstacle that persists after the operator reverses
        // the one-click direction choice, so it earns first position. Joined with a
        // newline (not a space) so the editor renders the two problems as separate
        // lines rather than one run-on paragraph.
        errors.payload = `${messageForField("payload")}\n${existing}`;
      }
    }
  }

  // An already-passed expiry is not a schema rule (it checks only the date
  // format), so add it -- mirroring the exchange, which rejects an expirationDate
  // strictly before today (config/linkageTerms.ts). A same-day expiry is still
  // honored at the exchange, so accept it here too rather than refuse an
  // invitation the exchange would. Apply it only once the date is a well-formed
  // date the schema accepted, so a malformed date shows the format error rather
  // than this one.
  const expiration = draft.legalAgreement?.expirationDate.trim();
  if (
    expiration !== undefined &&
    errors.legalExpiration === undefined &&
    expiration < todayIso(now)
  ) {
    errors.legalExpiration = "The expiration date cannot be in the past.";
  }

  // Satisfiability is over column shape, not the schema: a key all of whose
  // fields the columns can produce is satisfiable. Block when none can (the
  // exchange would emit no key strings and yield a silent empty result), the same
  // gate generateInvitation and the acceptor pre-flight apply.
  if (enabledKeys.length > 0 && errors.keys === undefined) {
    // Assess against the draft's edited metadata AND its authored standardization,
    // the same binding the inviter's exchange uses (both are threaded into the
    // spec), so the verdict matches the run: a column remap that makes a key
    // offerable is judged satisfiable here exactly when the run can produce it, and
    // two same-typed fields each resolve to their own bound column rather than the
    // type's first-match fallback (which would bind both to one column and mis-judge
    // a key needing the second).
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      terms,
      draft.standardization,
      draft.metadata,
    );
    if (satisfiableKeyCount === 0) {
      errors.keys =
        "None of the enabled keys can be satisfied by your file's columns.";
    }
  }

  // Canonical-encode dry run: the terms are hashed into the cross-party agreement
  // in this byte form, and a value outside the reproducible domain throws here
  // rather than desyncing two parties. The editor authors no transform params (the
  // only partner-reachable un-encodable value), so this is defense-in-depth.
  let encodable = true;
  try {
    canonicalString(terms);
  } catch (err) {
    if (err instanceof CanonicalEncodingError) {
      encodable = false;
      if (errors.keys === undefined)
        errors.keys = "These terms cannot be encoded; reset to defaults.";
    } else {
      throw err;
    }
  }

  // Every authored cleaning step must be well-formed before Generate -- the same
  // launch gate the acceptor applies (acceptorLaunchDisabled's step-validity
  // clause). A step left
  // mid-edit (a cleared substring.start) or a malformed/over-length raw pattern would
  // otherwise reach the exchange, where core runs it as a silent full-field exclusion
  // or throws at compile. Now that raw patterns are ungated for per-party cleaning,
  // this gate is load-bearing rather than defensive. Gated in this tested boundary (not
  // only the component wrapper) so it cannot be bypassed.
  if (
    !draft.standardization.every((transformation) =>
      (transformation.steps ?? []).every(isStepValid),
    )
  ) {
    errors.standardization =
      "Finish or fix the highlighted cleaning steps before generating.";
  }

  const canGenerate =
    parsed.success && encodable && Object.keys(errors).length === 0;
  return {
    canGenerate,
    terms: canGenerate ? terms : undefined,
    errors,
  };
}

/** Map a Zod issue path to the editor control it belongs to. The schema's
 * referential-integrity refines report at the array path (`["linkageKeys"]`),
 * which collapses to the key list here. */
function fieldForIssuePath(path: ReadonlyArray<PropertyKey>): AdvancedField {
  const head = path[0];
  if (head === "identity") return "identity";
  if (head === "legalAgreement") {
    const sub = path[1];
    if (sub === "reference") return "legalReference";
    if (sub === "purpose") return "legalPurpose";
    if (sub === "expirationDate") return "legalExpiration";
  }
  // A payload-column schema failure (e.g. a sent column whose name exceeds the
  // length bound) surfaces against the payload control, not the key list.
  if (head === "payload") return "payload";
  // linkageKeys, linkageFields, and anything else the editor can influence
  // surface against the key list (the only structural control it offers).
  return "keys";
}

/** A clear, control-specific message for a schema failure on that control. The
 * raw Zod message is not echoed: it is technical, and the offending value is
 * never partner-safe to surface here. */
function messageForField(field: AdvancedField): string {
  switch (field) {
    case "identity":
      return "Enter a name to identify yourself.";
    case "legalReference":
      return "Enter the agreement reference.";
    case "legalPurpose":
      return "Enter the purpose of the disclosure.";
    case "legalExpiration":
      return "Enter a valid date (YYYY-MM-DD).";
    case "lifetime":
      return "Choose an invitation duration between 1 second and one year.";
    case "payload":
      // The common payload error (sending while only you receive) is set with its
      // own message in validateAdvancedInvite; this covers a schema failure on a
      // sent column (e.g. an over-long column name from the CSV).
      return "One or more columns you are sending cannot be used; adjust which columns are sent.";
    case "keys":
      return "Enable at least one linkage key.";
    case "standardization":
      // Set directly in validateAdvancedInvite (not via a schema-path mapping); this
      // keeps the switch exhaustive over AdvancedField.
      return "Finish or fix the highlighted cleaning steps before generating.";
  }
}

// --- Gated-setting clamp -----------------------------------------------------

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

/** Inverse of {@link outputForDirection}: map an {@link Output} pair to the 3-way
 * direction for an imported terms set. The "neither receives"
 * `{ expectsOutput: false, shareWithPartner: false }` pair has no direction; it is
 * NOT rejected by {@link safeParseLinkageTerms} (the schema accepts any two output
 * booleans -- the "neither party expects output" check runs later, in
 * `validateCompatibility` at exchange time), so an imported set could carry it. The
 * final branch maps that (malformed, exchange-rejected) pair to the safe `"both"`
 * default, which the inviter sees selected and reviews before generating, rather
 * than loading a forbidden state silently. */
function directionForOutput(output: Output): OutputDirection {
  if (output.expectsOutput && output.shareWithPartner) return "both";
  if (output.expectsOutput) return "inviter";
  if (output.shareWithPartner) return "partner";
  return "both";
}

/** A message naming any setting an imported terms set turns on that the run does
 * not yet honor (gated by {@link APPLIED_SETTINGS}), or `undefined` when none. The
 * editor refuses such an import rather than load a draft whose headline behavior
 * silently does not happen -- the same gate the disabled GUI controls and the
 * {@link buildAdvancedTerms} clamp enforce, applied at the one door (import) that
 * could otherwise carry a gated setting in from outside. */
export function gatedActiveSettingMessage(
  terms: LinkageTerms,
): string | undefined {
  const blocked: Array<string> = [];
  if (terms.algorithm === "psi-c" && !APPLIED_SETTINGS.psiC)
    blocked.push("count-only matching (psi-c)");
  if (terms.deduplicate && !APPLIED_SETTINGS.deduplicate)
    blocked.push("duplicate matches");
  if (
    !APPLIED_SETTINGS.fuzzyComparisons &&
    terms.linkageKeys.some((key) =>
      key.elements.some((el) => el.generateFuzzyComparisons !== undefined),
    )
  )
    blocked.push("fuzzy comparisons");
  if (blocked.length === 0) return undefined;
  return (
    `These terms turn on ${blocked.join(", ")}, which this version of the ` +
    "exchange does not yet apply. Remove those settings and import again."
  );
}

/**
 * A message refusing an import whose linkage fields carry constraints the editor
 * cannot represent, or `undefined` when none does -- the constraints counterpart of
 * {@link gatedActiveSettingMessage}, applied at the same door. The draft holds no
 * per-field constraint state ({@link AdvancedInviteDraft} has none) and
 * {@link authoredLinkageFields} re-stamps each rebuilt field with its semantic
 * type's DEFAULT-template constraints, so an imported field's own `constraints` -- a
 * non-default `exclude` denylist, `validOnly`, `allowedCharacters`, or
 * `affixesAllowed` -- would be silently normalized away on rebuild. Constraints are
 * warn-not-enforce (they govern the data-quality warning surface, not which records
 * match -- see core's `checkValueConstraints`), but they ARE hashed into the
 * cross-party agreement, so a silent normalization re-generates a DIFFERENT
 * agreement than the imported document declared, with no signal to the operator.
 *
 * Refuse, not preserve: the editor has no surface to view or edit per-field
 * constraints, so preserving them would carry hash- and warning-relevant state the
 * operator can neither see nor change -- a worse footgun than refusing. Fail-closed
 * at the one door (import) that can introduce a constraint the authoring UI never
 * produces.
 *
 * Rather than enumerate the constraint shapes, it asks the precise question -- would
 * the rebuild change any field's declaration? -- by reconstructing exactly what an
 * import would generate ({@link draftFromTerms} then {@link buildAdvancedTerms}) and
 * comparing each GENERATED field against the imported field of the same name in the
 * canonical form the agreement hashes ({@link canonicalString}). Name and type are
 * reproduced verbatim, so a surviving field whose canonical form differs differs
 * only in its constraints: exactly the silent-divergence case. This also catches the
 * inverse -- an import that STRIPS a default the rebuild adds back. An import
 * carrying only type-default constraints rebuilds to identical canonical fields and
 * is accepted unchanged -- so the guided and expert paths, which never author custom
 * constraints, always pass.
 *
 * The message names no field value: an imported document is partner-influenceable,
 * the same reason {@link UNSUPPLYABLE_KEY_MESSAGE} and core's schema refines locate
 * an offender by path, not value.
 *
 * Scope -- it owns the one divergence direction the faithful round-trip does NOT close:
 * a SURVIVING field (one a key references and the columns can bind) whose custom
 * constraint the rebuild re-stamps to the type default, the genuine silent-normalization
 * case. It need not own the others, because {@link buildAdvancedTerms} now preserves the
 * imported field declaration on rebuild (see {@link reconcileImportedFields}): (1) it
 * does NOT falsely refuse the disable-and-show case -- a field a key references but the
 * inviter's columns cannot supply is dropped rather than generated, so it is not compared
 * and a legitimate partial import is not refused; (2) a declared field NO key references
 * is preserved verbatim on rebuild, so it is compared and MATCHES rather than diverging --
 * an inert field's custom constraint is carried, not refused (it is never standardized,
 * constraint-checked, or matched -- see {@link referencedLinkageFieldNames} -- so carrying
 * it moves nothing but the agreement hash, which faithful preservation keeps equal); and
 * (3) field ORDER and a benign empty `constraints: {}` (on a type whose default is absent)
 * are likewise preserved, so neither diverges here, and the empty `{}` no longer
 * over-refuses. So this guard stays scoped to the constraints a generated field actually
 * runs, while the rest of the round-trip fidelity is preserved upstream.
 */
export function importedConstraintDivergenceMessage(
  terms: LinkageTerms,
  seed: AdvancedInviteSeed,
  rawRows: ReadonlyArray<CSVRow> = [],
): string | undefined {
  const rebuilt = buildAdvancedTerms(
    draftFromTerms(terms, seed, INVITATION_LIFETIME_SECONDS, rawRows),
  );
  const importedByName = new Map(
    terms.linkageFields.map((field) => [field.name, field]),
  );
  for (const generated of rebuilt.linkageFields) {
    const imported = importedByName.get(generated.name);
    // A generated field the import did not name cannot occur for a name-matched
    // rebuild; were it to, its declaration is the editor's, not the document's, so
    // there is nothing imported for it to diverge from -- skip it.
    if (imported === undefined) continue;
    if (canonicalString(generated) !== canonicalString(imported))
      return (
        "These terms set custom constraints on one or more linkage fields that " +
        "this editor cannot represent. Importing them would silently change the " +
        "agreement the parties commit to (and the data-quality warnings shown), so " +
        "they are refused. Edit the document to use the default field constraints, " +
        "or use it directly without the editor."
      );
  }
  return undefined;
}

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
 * order ({@link reconcileImportedFields}) -- so this reconstruction only has to bind the
 * fields its keys reference. The one facet not carried is a custom per-field
 * `constraint` the editor cannot represent: it is re-stamped to the type default on
 * rebuild and caught fail-closed at the import door
 * ({@link importedConstraintDivergenceMessage} refuses a document whose custom
 * constraints that rebuild would normalize away), so it never silently reaches a
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
): Standardization {
  const base = defaultStandardizationForRows(metadata, defaultTerms, rawRows);
  // The recommended steps each imported field's type cleans with, keyed by field
  // name. Derived from the default standardization over the IMPORTED terms (not the
  // seed's), so it covers every imported field's type -- including one the inviter
  // has columns for but no default key uses, which the seed's default terms (and so
  // `base`) would not carry -- and bakes in the row-inferred date format. The input
  // columns it picks collide on the first per type; only the steps are read here,
  // and the distinct columns are assigned below.
  const stepsByField = new Map(
    defaultStandardizationForRows(metadata, terms, rawRows).map(
      (transformation) => [transformation.output, transformation.steps],
    ),
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
    // matches core's own rule on every path: {@link resolveFieldColumns} binds only
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
): AdvancedInviteDraft {
  const standardization = standardizationForImportedTerms(
    seed.metadata,
    seed.terms,
    terms,
    rawRows,
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
    // AdvancedInviteDraft.importedLinkageFields and reconcileImportedFields.
    importedLinkageFields: terms.linkageFields,
    keys: terms.linkageKeys.map((key) => ({
      key,
      enabled: keyIsSupplyable(key, declarable),
    })),
  };
}
