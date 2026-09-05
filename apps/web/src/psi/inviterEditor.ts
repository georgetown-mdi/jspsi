/**
 * The pure model behind the inviter spine: seeding the draft from the read
 * file and applying the edits each step offers. No React, no I/O. The draft is
 * the AdvancedInvite model's ({@link AdvancedInviteDraft}); every derivation
 * and edit goes through the same seed/reconcile helpers that model is tested
 * on.
 */

import { authoredLinkageFields, getDefaultLinkageTerms } from "@psilink/core";

import { isolatedColumnName } from "@components/ColumnName";

import {
  draftFromTerms,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  gradeAuthoredKeys,
  inviterDefaultStandardization,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  validateAdvancedInvite,
} from "./authoring/advancedInvite";

import {
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "./metadataEditing";

import { LIFETIME_CHOICES } from "./formatting";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  DraftLegalAgreement,
  OutputDirection,
} from "./authoring/advancedInvite";

import type {
  CSVRow,
  LinkageField,
  LinkageKey,
  LinkageKeyFitness,
  LinkageStrategy,
  LinkageTerms,
  SemanticType,
} from "@psilink/core";

import type { DisclosureChoice } from "./metadataEditing";

import type { Transport } from "./transportChooser";

/** The read file the spine works over: identity for the file card plus the
 * parsed rows and columns every derivation binds to. `rowCount` is the file's
 * row total, held explicitly so display surfaces do not read `rawRows.length`
 * (the console acquires only a server-side profile, not the rows).
 * `dateInputFormat` is a pre-inferred date-of-birth layout
 * ({@link dateInputFormatForColumns}), set only by sources that profile
 * without rows (the console); absent, each derivation infers it from the
 * rows. */
export interface AcquiredCsv {
  fileName: string;
  sizeBytes: number;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  rowCount: number;
  dateInputFormat?: string;
  /** True when this shape holds no rows -- the console acquires a server-side
   * profile, not the file, so `rawRows` is a throwing getter there. The draft
   * reconciliations read rows only to infer the date-of-birth format, which the
   * console supplies as `dateInputFormat`, so a rows-withheld shape contributes an
   * empty row set to those helpers ({@link seedRows}) rather than reading the
   * getter. */
  rowsWithheld?: boolean;
}

/** The rows the draft reconciliations feed to the seed/standardization helpers,
 * whose only use of rows is date-of-birth format inference. A rows-withheld
 * console shape ({@link AcquiredCsv.rowsWithheld}) contributes an empty set,
 * since its `dateInputFormat` was already profiled; a hosted shape contributes
 * its parsed rows. Exported so the expert-mode terms import/export -- the one
 * other `rawRows` consumer -- reads through the same guard. */
export function seedRows(csv: AcquiredCsv): Array<CSVRow> {
  return csv.rowsWithheld === true ? [] : csv.rawRows;
}

/** An editing session over the read file: the live draft and the fixed seed it
 * derived from ({@link seedAdvancedInvite}). Once `sealed`, every mutator in
 * this module returns the session unchanged -- the terms a partner is
 * consenting to can never drift from what was minted. `keysAuthored` marks
 * the key set as author-controlled (an expert edit or an import): a later
 * column edit reconciles the metadata and standardization but leaves the
 * keys untouched. */
export interface InviterEditor {
  draft: AdvancedInviteDraft;
  seed: AdvancedInviteSeed;
  sealed?: boolean;
  keysAuthored?: boolean;
  /** The transport chosen at Review & create ({@link Transport}); defaults to
   * `browser` until the chooser sets it. Survives a trip into a Customize tab
   * and reflects into the ledger and the review answers. */
  transport?: Transport;
}

/** Seal the session at create time; see {@link InviterEditor.sealed}. */
export function sealEditor(editor: InviterEditor): InviterEditor {
  return { ...editor, sealed: true };
}

/** Reopen the session -- the "start over with a fresh invitation" recovery
 * after a failed run. Every input survives (a failure never clears what the
 * operator authored); only the seal lifts, and the invitation it certified is
 * discarded by the caller, so the next create mints a fresh secret. */
export function unsealEditor(editor: InviterEditor): InviterEditor {
  if (editor.sealed !== true) return editor;
  const { sealed: _sealed, ...unsealed } = editor;
  return unsealed;
}

/** Seed the editing session from the read file: default terms derive from
 * the file as soon as it is read. */
export function editorFromCsv(
  inviterName: string,
  csv: AcquiredCsv,
): InviterEditor {
  return seedAdvancedInvite(
    inviterName,
    csv.columns,
    seedRows(csv),
    csv.dateInputFormat,
  );
}

/** Fold a later name edit into the draft without disturbing the derived
 * terms; the identity only labels the terms, it never changes which keys the
 * columns can produce. */
export function editorWithIdentity(
  editor: InviterEditor,
  identity: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, identity } };
}

/** Set the invitation lifetime step 3 offers ({@link LIFETIME_CHOICES}). */
export function editorWithLifetime(
  editor: InviterEditor,
  lifetimeSeconds: number,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, lifetimeSeconds } };
}

/** Set who receives the matched results. */
export function editorWithOutputDirection(
  editor: InviterEditor,
  outputDirection: OutputDirection,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, outputDirection } };
}

/** Set the transport the exchange runs over ({@link Transport}), chosen at
 * Review & create. Editor state so it survives a Customize-tab trip and drives
 * both Create's branch and the ledger/answers How-it-runs rows. */
export function editorWithTransport(
  editor: InviterEditor,
  transport: Transport,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, transport };
}

/** Replace the whole draft -- the expert key editor's change channel. Marks
 * the key set author-controlled, so later column edits stop reconciling it
 * away ({@link InviterEditor.keysAuthored}). */
export function editorWithAuthoredDraft(
  editor: InviterEditor,
  draft: AdvancedInviteDraft,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft, keysAuthored: true };
}

/** Enable or disable the key at `index` in the guided list, keeping an opt-in
 * type's cleaning attached to its key (see {@link draftWithKeyEnabled}). */
export function editorWithKeyEnabled(
  editor: InviterEditor,
  index: number,
  enabled: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: draftWithKeyEnabled(editor.draft, index, enabled),
  };
}

/** Move the key at `index` one place earlier (`-1`) or later (`+1`); a move
 * past either end is a no-op. Key order is match order, so this is the guided
 * list's reorder control. */
export function editorWithKeyMoved(
  editor: InviterEditor,
  index: number,
  offset: -1 | 1,
): InviterEditor {
  if (editor.sealed === true) return editor;
  const target = index + offset;
  if (target < 0 || target >= editor.draft.keys.length) return editor;
  const keys = [...editor.draft.keys];
  [keys[index], keys[target]] = [keys[target], keys[index]];
  return { ...editor, draft: { ...editor.draft, keys } };
}

/** Set how the agreed keys are exchanged (cascade or single-pass). */
export function editorWithLinkageStrategy(
  editor: InviterEditor,
  linkageStrategy: LinkageStrategy,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, linkageStrategy } };
}

/** Attach, edit, or (with `undefined`) detach the legal agreement. */
export function editorWithLegalAgreement(
  editor: InviterEditor,
  legalAgreement: DraftLegalAgreement | undefined,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, legalAgreement } };
}

/** Load an imported, validated terms document into the session, keeping the
 * inviter's own columns and lifetime -- an unsupplyable imported key arrives
 * disabled with its badge, never dropped ({@link draftFromTerms}). Imported
 * keys are author-controlled. */
export function editorWithImportedTerms(
  editor: InviterEditor,
  csv: AcquiredCsv,
  terms: LinkageTerms,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: draftFromTerms(
      terms,
      editor.seed,
      editor.draft.lifetimeSeconds,
      seedRows(csv),
      csv.dateInputFormat,
    ),
    keysAuthored: true,
  };
}

/** Set one cleaned field's ordered steps. */
export function editorWithFieldSteps(
  editor: InviterEditor,
  output: string,
  steps: AdvancedInviteDraft["standardization"][number]["steps"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.map((transformation) =>
        transformation.output === output
          ? { ...transformation, steps }
          : transformation,
      ),
    },
  };
}

/** Rebind a cleaned field to a different input column. */
export function editorWithFieldInput(
  editor: InviterEditor,
  output: string,
  input: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.map((transformation) =>
        transformation.output === output
          ? { ...transformation, input }
          : transformation,
      ),
    },
  };
}

/** Remove an authored same-typed field's transformation. */
export function editorWithFieldRemoved(
  editor: InviterEditor,
  output: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.filter(
        (transformation) => transformation.output !== output,
      ),
    },
  };
}

/** Append a same-typed field via the shared {@link draftWithFieldAdded}. */
export function editorWithFieldAdded(
  editor: InviterEditor,
  type: LinkageField["type"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: draftWithFieldAdded(editor.draft, type) };
}

/** Set the matching algorithm. Ungated -- the exchange honors both members -- so
 * the built terms hold it as authored; a count-only draft outside the shape a
 * count-only run admits blocks generation at {@link validateAdvancedInvite}. */
export function editorWithAlgorithm(
  editor: InviterEditor,
  algorithm: AdvancedInviteDraft["algorithm"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, algorithm } };
}

/** Set input deduplication. Gated exactly as {@link editorWithAlgorithm}: the
 * build clamps minted terms to no-dedup until the run honors it. */
export function editorWithDeduplicate(
  editor: InviterEditor,
  deduplicate: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, deduplicate } };
}

/** Restore the recommended cleaning for the current metadata and the keys the
 * draft has turned on -- the cleaning error boundary's recovery, scoped to the
 * cleaning alone. Reading the enabled keys is what keeps the reset from minting a
 * pipeline for an opt-in type whose key is off, which the terms this draft emits
 * would declare no field for. */
export function editorWithRecommendedCleaning(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: inviterDefaultStandardization(
        editor.draft.metadata,
        getDefaultLinkageTerms(editor.draft.identity, editor.draft.metadata),
        enabledKeys(editor.draft),
        seedRows(csv),
        csv.dateInputFormat,
      ),
    },
  };
}

/** The fields a key element may reference, in offer order -- the authored
 * field set, so a second same-typed field is offerable. */
export function declaredFieldsFor(
  draft: AdvancedInviteDraft,
): Array<LinkageField> {
  return authoredLinkageFields(draft.metadata, draft.standardization);
}

/**
 * A per-key verdict for the guided list's and expert editor's badges: core's own
 * {@link LinkageKeyFitness}, so a badge reads what the Generate gate, the mint, and
 * the run boundary all grade the key at. Its three outcomes -- `satisfiable`,
 * `unsatisfiable` (an element references a field the columns cannot produce), and
 * `dead` (the columns produce every element field, but an element's declared
 * cleaning can never yield a value) -- are documented on core's type.
 */
export type KeyVerdict = LinkageKeyFitness;

/** The per-key verdict function behind the Keys tab badges ({@link KeyVerdict}).
 * Grades every draft key at once, in declaration order, so the badge index is the
 * draft index. */
export function keySatisfiabilityFor(
  editor: InviterEditor,
): (index: number) => KeyVerdict {
  const fitness = gradeAuthoredKeys(
    editor.draft.metadata,
    editor.draft.standardization,
    editor.seed.columns,
    editor.draft.keys.map((entry) => entry.key),
  );
  return (index) => fitness[index];
}

/** Discard every edit and re-derive the recommended draft from the file,
 * keeping only the inviter's name -- step 3's "Reset to defaults". */
export function resetToRecommended(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return editorFromCsv(editor.draft.identity, csv);
}

/** Reconcile an existing session onto a re-profiled file whose column set is
 * unchanged: the authored draft (keys, cleaning, disclosure, transport) is kept and
 * the profile-derived date-of-birth format is threaded back through the keep-keys
 * reconciliation ({@link setDraftMetadataKeepingKeys}), so a re-profile refreshes the
 * file's facts without discarding the operator's customizations. A sealed session is
 * returned unchanged -- its terms are locked. The caller reseeds instead when the
 * columns changed. */
export function editorReprofiled(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: setDraftMetadataKeepingKeys(
      editor.draft,
      editor.draft.metadata,
      seedRows(csv),
      csv.dateInputFormat,
    ),
  };
}

/** The result of a step-2 column edit: the reconciled session plus any
 * identifier columns the single-identifier rule demoted, for the caller to
 * announce. */
export interface ColumnEditResult {
  editor: InviterEditor;
  demotedIdentifiers: Array<string>;
}

function withMetadata(
  editor: InviterEditor,
  csv: AcquiredCsv,
  metadata: AdvancedInviteDraft["metadata"],
  demotedIdentifiers: Array<string>,
): ColumnEditResult {
  return {
    editor: {
      ...editor,
      // Reconcile the standardization on every metadata edit, so a column retype
      // re-derives its cleaning and can never leave a stale transformation minting
      // a name/type-mismatched field into the agreed terms. The keysAuthored guard
      // protects only the authored/imported KEY set from the template-driven key
      // reconciliation (setDraftMetadata), never the standardization.
      draft:
        editor.keysAuthored === true
          ? setDraftMetadataKeepingKeys(
              editor.draft,
              metadata,
              seedRows(csv),
              csv.dateInputFormat,
            )
          : setDraftMetadata(
              editor.draft,
              metadata,
              seedRows(csv),
              csv.dateInputFormat,
            ),
    },
    demotedIdentifiers,
  };
}

/** Apply the "Type" select: retype a column, letting the draft reconcile its
 * offerable keys and cleaning against the new metadata. */
export function editorWithColumnType(
  editor: InviterEditor,
  csv: AcquiredCsv,
  columnName: string,
  type: SemanticType,
): ColumnEditResult {
  if (editor.sealed === true) return { editor, demotedIdentifiers: [] };
  const { metadata, demotedIdentifiers } = setColumnType(
    editor.draft.metadata,
    columnName,
    type,
  );
  return withMetadata(editor, csv, metadata, demotedIdentifiers);
}

/** Apply the "How it is used" select: change a column's disclosure choice. */
export function editorWithColumnDisclosure(
  editor: InviterEditor,
  csv: AcquiredCsv,
  columnName: string,
  choice: DisclosureChoice,
): ColumnEditResult {
  if (editor.sealed === true) return { editor, demotedIdentifiers: [] };
  const { metadata, demotedIdentifiers } = setColumnDisclosure(
    editor.draft.metadata,
    columnName,
    choice,
  );
  return withMetadata(editor, csv, metadata, demotedIdentifiers);
}

/**
 * What step 2's polite region says about a {@link ColumnEditResult}'s demoted
 * identifiers. The names are the operator's own CSV headers going into a string
 * sink, so they hold the isolation as characters, the treatment every other
 * column-name sink on the step gives them. Displacing more than one column puts
 * the names in one text block with the separators and the sentence after them;
 * what the isolation does not contain there is stated on `@components/ColumnName`
 * and driven in test/browser/inviterSharing.test.ts.
 */
export function demotionNotice(demoted: ReadonlyArray<string>): string {
  if (demoted.length === 0) return "";
  return `${demoted.map(isolatedColumnName).join(", ")} changed to Ignored - only one column can be the record identifier.`;
}

/** The linkage keys the draft currently authors, in order. */
export function enabledKeys(draft: AdvancedInviteDraft): Array<LinkageKey> {
  return draft.keys.filter((entry) => entry.enabled).map((entry) => entry.key);
}

/** Whether the metadata sits in the two-identifier state the single-identifier
 * rule forbids -- the work column's Problems entry for step 2. */
export function identifierProblem(draft: AdvancedInviteDraft): boolean {
  return hasMultipleIdentifiers(draft.metadata);
}
