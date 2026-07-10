import { disclosedColumnNames } from "@psilink/core";

import {
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";
import { seedAdvancedInvite, setDraftMetadata } from "@psi/advancedInvite";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
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
 * derived from ({@link seedAdvancedInvite}). */
export interface InviterEditor {
  draft: AdvancedInviteDraft;
  seed: AdvancedInviteSeed;
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
  return { ...editor, draft: { ...editor.draft, identity } };
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

/** The ledger's Expires phrasing for a draft lifetime, e.g. `1 hour after you
 * share`. Whole days/hours/minutes cover every value step 3's control will
 * offer; anything else falls back to minutes. */
export function lifetimeLabel(seconds: number): string {
  const unit = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"} after you share`;
  if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.max(1, Math.round(seconds / 60)), "minute");
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
 * live from the draft.
 */
export function inviterLedgerRows(
  editor: InviterEditor | undefined,
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
      value: lifetimeLabel(editor.draft.lifetimeSeconds),
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

/** The Customize group's quiet facts, read live from the draft: cleaning
 * pipeline count, authored key count, and the agreement reference. Undefined
 * facts render as the em-dash "nothing yet" mark. */
export function inviterRailFacts(
  editor: InviterEditor | undefined,
): Array<InviterRailFact> {
  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  return [
    {
      label: "Cleaning",
      fact:
        editor === undefined
          ? undefined
          : plural(editor.draft.standardization.length, "field"),
    },
    {
      label: "Matching keys",
      fact:
        editor === undefined
          ? undefined
          : plural(enabledKeys(editor.draft).length, "key"),
    },
    {
      label: "Legal agreement",
      fact: editor?.draft.legalAgreement?.reference,
    },
  ];
}
