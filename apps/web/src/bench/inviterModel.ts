import {
  MAX_INVITATION_LIFETIME_SECONDS,
  disclosedColumnNames,
} from "@psilink/core";

import {
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";
import {
  seedAdvancedInvite,
  setDraftMetadata,
  validateAdvancedInvite,
} from "@psi/advancedInvite";

import type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
  OutputDirection,
} from "@psi/advancedInvite";
import type { CSVRow, LinkageKey, SemanticType } from "@psilink/core";
import type { DisclosureChoice } from "@psi/metadataEditing";

/**
 * The pure model behind the inviter bench's required spine: seeding the draft
 * from the read file, applying the two column edits step 2 offers, and the
 * view-model builders the rail facts and the disclosure ledger render from.
 * No React, no I/O -- the tested boundary for "default terms derive from the
 * file" and "the ledger tracks term edits". The draft itself is the Advanced
 * editor's ({@link AdvancedInviteDraft}); the bench re-surfaces that model, so
 * every derivation and edit goes through the same seed/reconcile helpers the
 * old editor is tested on.
 */

/** The read file the spine works over: identity for the file card plus the
 * parsed rows and columns every derivation binds to. */
export interface AcquiredCsv {
  fileName: string;
  sizeBytes: number;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
}

/** An editing session over the read file: the live draft and the fixed seed it
 * derived from ({@link seedAdvancedInvite}). Once `sealed` (the invitation was
 * created), every mutator in this module returns the session unchanged -- the
 * terms a partner is consenting to can never drift from what was minted. */
export interface InviterEditor {
  draft: AdvancedInviteDraft;
  seed: AdvancedInviteSeed;
  sealed?: boolean;
}

/** Seal the session at create time; see {@link InviterEditor.sealed}. */
export function sealEditor(editor: InviterEditor): InviterEditor {
  return { ...editor, sealed: true };
}

/** Seed the editing session from the read file -- the "default terms derive
 * from the file the moment it is read" moment of the design. */
export function editorFromCsv(
  inviterName: string,
  csv: AcquiredCsv,
): InviterEditor {
  return seedAdvancedInvite(inviterName, csv.columns, csv.rawRows);
}

/** Carry a later name edit into the draft without disturbing the derived
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

/** Discard every edit and re-derive the recommended draft from the file,
 * keeping only the inviter's name -- step 3's "Reset to recommended". */
export function resetToRecommended(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return editorFromCsv(editor.draft.identity, csv);
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
      draft: setDraftMetadata(editor.draft, metadata, csv.rawRows),
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

/** The linkage keys the draft currently authors, in order. */
export function enabledKeys(draft: AdvancedInviteDraft): Array<LinkageKey> {
  return draft.keys.filter((entry) => entry.enabled).map((entry) => entry.key);
}

/** Whether the metadata sits in the two-identifier state the single-identifier
 * rule forbids -- the rail's Problems entry for step 2. */
export function identifierProblem(draft: AdvancedInviteDraft): boolean {
  return hasMultipleIdentifiers(draft.metadata);
}

/** The file card's metadata line, e.g. `12,408 rows - 8.4 MB`. */
export function fileCardMeta(rowCount: number, sizeBytes: number): string {
  const rows = new Intl.NumberFormat("en-US").format(rowCount);
  const size =
    sizeBytes >= 1024 ** 2
      ? `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${rows} rows - ${size}`;
}

/** A lifetime as a plain duration phrase, e.g. `1 hour`, `7 days`. Whole
 * days/hours cover every {@link LIFETIME_CHOICES} value; anything else falls
 * back to minutes. */
export function lifetimeNoun(seconds: number): string {
  const unit = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.max(1, Math.round(seconds / 60)), "minute");
}

/** The ledger's Expires phrasing for a draft lifetime, e.g. `1 hour after you
 * share`. */
export function lifetimeLabel(seconds: number): string {
  return `${lifetimeNoun(seconds)} after you share`;
}

/** The lifetimes step 3 offers, from the recommended hour up to the bounded
 * maximum ({@link MAX_INVITATION_LIFETIME_SECONDS}, one year). */
export const LIFETIME_CHOICES: ReadonlyArray<{
  seconds: number;
  label: string;
}> = [
  { seconds: 3600, label: "1 hour (recommended)" },
  { seconds: 6 * 3600, label: "6 hours" },
  { seconds: 86400, label: "1 day" },
  { seconds: 7 * 86400, label: "7 days" },
  { seconds: 30 * 86400, label: "30 days" },
  { seconds: MAX_INVITATION_LIFETIME_SECONDS, label: "1 year" },
];

/** An absolute moment phrased for display, e.g. `July 8, 2026, 3:32 PM EDT`
 * -- the minted expiry in the ledger. */
export function dateTimeLabel(moment: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(moment);
}

/** The absolute moment an invitation shared `now` would expire, phrased for
 * the live expiry hint. */
export function expiryLabel(lifetimeSeconds: number, now: Date): string {
  return dateTimeLabel(new Date(now.getTime() + lifetimeSeconds * 1000));
}

/** Ledger phrasing for who receives the matched results. */
export const RESULTS_DIRECTION_LABELS: Record<OutputDirection, string> = {
  both: "You and your partner",
  inviter: "Only you",
  partner: "Only your partner",
};

/** One disclosure-ledger row: `value` renders in the data voice, `muted`
 * renders in the empty-state voice ("None", "Nothing"), neither renders the
 * em-dash placeholder. */
export interface InviterLedgerRow {
  label: string;
  reference?: string;
  value?: string | ReadonlyArray<string>;
  muted?: string;
}

/**
 * The disclosure ledger for the spine, filling in as the exchange takes shape:
 * before a file is read every value is the em-dash placeholder; once a session
 * exists the send list, matched-on keys, expiry, and result direction are read
 * live from the draft. Once the invitation is minted its absolute `expires`
 * moment replaces the relative lifetime phrase.
 */
export function inviterLedgerRows(
  editor: InviterEditor | undefined,
  expiresIso?: string,
): Array<InviterLedgerRow> {
  if (editor === undefined) {
    return [
      { label: "You will send", reference: "Step 2" },
      { label: "You will receive", reference: "Step 2" },
      { label: "Matched on", reference: "Step 2" },
      { label: "Expires", reference: "Step 3" },
      { label: "Results go to", reference: "Step 3" },
      { label: "Agreement" },
      { label: "Transport", reference: "Step 3" },
    ];
  }
  const sent = disclosedColumnNames(editor.draft.metadata);
  const keys = enabledKeys(editor.draft);
  return [
    sent.length > 0
      ? { label: "You will send", reference: "Step 2", value: sent.join(", ") }
      : {
          label: "You will send",
          reference: "Step 2",
          muted: "Nothing - matching only",
        },
    {
      label: "You will receive",
      reference: "Step 2",
      value: "Matched rows + your partner's shared columns",
    },
    keys.length > 0
      ? {
          label: "Matched on",
          reference: "Step 2",
          value: keys.map((key, index) => `${index + 1}. ${key.name}`),
        }
      : { label: "Matched on", reference: "Step 2", muted: "No keys" },
    {
      label: "Expires",
      reference: "Step 3",
      value:
        expiresIso !== undefined
          ? dateTimeLabel(new Date(expiresIso))
          : lifetimeLabel(editor.draft.lifetimeSeconds),
    },
    {
      label: "Results go to",
      reference: "Step 3",
      value: RESULTS_DIRECTION_LABELS[editor.draft.outputDirection],
    },
    editor.draft.legalAgreement?.reference !== undefined &&
    editor.draft.legalAgreement.reference !== ""
      ? { label: "Agreement", value: editor.draft.legalAgreement.reference }
      : { label: "Agreement", muted: "None" },
    { label: "Transport", reference: "Step 3", value: "Browser" },
  ];
}

/** One rail quiet fact for the Customize group. */
export interface InviterRailFact {
  label: string;
  fact?: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The cleaning summary ("3 fields") shared by the rail fact and the
 * check-your-answers row, so the two surfaces cannot disagree. */
export function cleaningFact(draft: AdvancedInviteDraft): string {
  return plural(draft.standardization.length, "field");
}

/** The key-count summary ("2 keys") shared by the rail fact and the
 * check-your-answers row. */
export function keysFact(draft: AdvancedInviteDraft): string {
  return plural(enabledKeys(draft).length, "key");
}

/** The Customize group's quiet facts, read live from the draft: cleaning
 * pipeline count, authored key count, and the agreement reference. Undefined
 * facts render as the em-dash "nothing yet" mark. */
export function inviterRailFacts(
  editor: InviterEditor | undefined,
): Array<InviterRailFact> {
  return [
    {
      label: "Cleaning",
      fact: editor === undefined ? undefined : cleaningFact(editor.draft),
    },
    {
      label: "Matching keys",
      fact: editor === undefined ? undefined : keysFact(editor.draft),
    },
    {
      label: "Legal agreement",
      fact: editor?.draft.legalAgreement?.reference,
    },
  ];
}

/** A bench section a Problems entry or a Change link can navigate to. */
export type SpineTarget = "file" | "columns" | "review";

/** The section that owns each validation field, so a Problems entry can link
 * to where the fix lives. Key, cleaning, and agreement fields point at step 2
 * until their Customize tabs exist -- the column table is where those terms
 * are shaped today. */
const FIELD_TARGETS: Record<AdvancedField, SpineTarget> = {
  identity: "file",
  payload: "columns",
  keys: "columns",
  standardization: "columns",
  lifetime: "review",
  legalReference: "review",
  legalPurpose: "review",
  legalExpiration: "review",
};

/** One entry in the rail's Problems block: the message and the section that
 * can resolve it. */
export interface SpineProblem {
  message: string;
  target: SpineTarget;
}

/** Validate the draft for the create gate -- the Advanced editor's own
 * validation over the bench's session. */
export function reviewValidation(
  editor: InviterEditor,
  now: Date = new Date(),
): AdvancedValidation {
  return validateAdvancedInvite(editor.draft, editor.seed, now);
}

/**
 * The rail's Problems block as an error summary: the single-identifier
 * conflict (which only inference can seed) plus every validation error, each
 * pointing at the section that owns the fix. Empty when the draft can mint.
 */
export function spineProblems(
  editor: InviterEditor | undefined,
  now: Date = new Date(),
): Array<SpineProblem> {
  if (editor === undefined) return [];
  const problems: Array<SpineProblem> = [];
  if (identifierProblem(editor.draft))
    problems.push({
      message: "Choose a single row identifier",
      target: "columns",
    });
  const { errors } = reviewValidation(editor, now);
  for (const [field, message] of Object.entries(errors)) {
    problems.push({ message, target: FIELD_TARGETS[field as AdvancedField] });
  }
  return problems;
}

/** One check-your-answers row: the term, its display value, and either the
 * section its Change link navigates to or the "set above" mark for the terms
 * owned by step 3 itself. */
export interface AnswersRow {
  label: string;
  value: string;
  mono?: boolean;
  changeTarget?: SpineTarget;
  setAbove?: boolean;
}

/** The check-your-answers table: the full proposal restated before the point
 * of no return. Cleaning, key, and agreement rows carry no Change link until
 * their Customize tabs exist. */
export function answersRows(
  editor: InviterEditor,
  csv: AcquiredCsv,
): Array<AnswersRow> {
  const sent = disclosedColumnNames(editor.draft.metadata);
  return [
    {
      label: "Your name",
      value: editor.draft.identity,
      changeTarget: "file",
    },
    {
      label: "Your file",
      value: `${csv.fileName} - ${new Intl.NumberFormat("en-US").format(csv.rawRows.length)} rows`,
      mono: true,
      changeTarget: "file",
    },
    {
      label: "Columns shared",
      value: sent.length > 0 ? sent.join(", ") : "None",
      mono: sent.length > 0,
      changeTarget: "columns",
    },
    {
      label: "Cleaning",
      value: `${cleaningFact(editor.draft)}, filled in from your file`,
    },
    {
      label: "Matching keys",
      value: `${keysFact(editor.draft)}, recommended order`,
    },
    {
      label: "Legal agreement",
      value: editor.draft.legalAgreement?.reference ?? "None",
      mono: editor.draft.legalAgreement?.reference !== undefined,
    },
    {
      label: "Invitation lifetime",
      value: lifetimeNoun(editor.draft.lifetimeSeconds),
      setAbove: true,
    },
    {
      label: "Results go to",
      value: RESULTS_DIRECTION_LABELS[editor.draft.outputDirection],
      setAbove: true,
    },
    {
      label: "Transport",
      value: "Live, in this browser",
      setAbove: true,
    },
  ];
}
