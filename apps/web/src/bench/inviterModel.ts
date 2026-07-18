import {
  MAX_INVITATION_LIFETIME_SECONDS,
  authoredLinkageFields,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  pipelineAlwaysDrops,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  defaultStandardizationForRows,
  draftFromTerms,
  draftWithFieldAdded,
  producibleFieldNames,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  validateAdvancedInvite,
} from "@psi/advancedInvite";

import {
  SEMANTIC_TYPE_LABELS,
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { selectExchangeDriver } from "./exchangeDriverSelection";

import type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
  DraftLegalAgreement,
  OutputDirection,
} from "@psi/advancedInvite";
import type {
  CSVRow,
  LinkageField,
  LinkageKey,
  LinkageStrategy,
  LinkageTerms,
  SemanticType,
} from "@psilink/core";
import type { DeploymentProfile } from "@utils/clientConfig";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { ExchangeDriverSelection } from "./exchangeDriverSelection";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * Where a step stands in the exchange's progression, rendered by the bench's
 * top-bar Stepper. `current` is announced to assistive tech via
 * `aria-current="step"`; the other two are conveyed by the Stepper's own
 * completed/inactive styling.
 */
export type RailStepState = "done" | "current" | "pending";

/** One entry in a step spine or timeline list, rendered as a Mantine
 * Stepper.Step. A completed step with `onSelect` is clickable, per the
 * design's done-steps-are-links rule; the current and pending steps are not. */
export interface RailStep {
  label: string;
  state: RailStepState;
  onSelect?: () => void;
}

/**
 * One row in the Customize menu: an optional-surface label and the quiet
 * fact summarizing its state ("3 fields", "2 keys"). An absent fact renders
 * as an em-dash; `tone` colors the fact only when the surface has been
 * edited or needs attention. With `onSelect` the row opens that surface;
 * `current` marks the open tab.
 */
export interface RailFact {
  label: string;
  fact?: string;
  tone?: "edited" | "attention";
  onSelect?: () => void;
  current?: boolean;
}

/** One entry in the work column's Problems block. `key` is the render key when
 * labels may repeat; absent, the label is the key. */
export interface RailProblem {
  label: string;
  key?: string;
  onSelect?: () => void;
}

/**
 * The transport an exchange runs over, chosen at Review & create. `browser`
 * runs the live WebRTC exchange in this tab; `sftp` and `filedrop` are the two
 * command-line transports whose Create routes to the save-exchange-file surface
 * instead of listening for a partner. The value is editor state so it survives
 * a trip into a Customize tab and reflects into the ledger's How-it-runs row
 * and the review answers.
 */
export type Transport = "browser" | "sftp" | "filedrop";

/** The ledger's How-it-runs row phrasing for each {@link Transport}. */
export const TRANSPORT_LEDGER_LABELS: Record<Transport, string> = {
  browser: "Browser",
  sftp: "SFTP (command-line tool)",
  filedrop: "Shared directory (command-line tool)",
};

/** The review answers-table phrasing for each {@link Transport}. */
export const TRANSPORT_ANSWER_LABELS: Record<Transport, string> = {
  browser: "Live, in this browser",
  sftp: "SFTP (command-line tool)",
  filedrop: "Shared directory (command-line tool)",
};

/** Whether a transport runs in the command-line tool rather than this browser
 * -- the discriminant Create branches on: a CLI transport mints nothing and
 * routes to the save surface, and the browser must never listen for it. A type
 * guard so a narrowed transport reaches the save surface's CLI-only model. */
export function isCliTransport(
  transport: Transport,
): transport is Exclude<Transport, "browser"> {
  return transport !== "browser";
}

/** How a chosen transport would run on this build: the
 * {@link ExchangeDriverSelection} kind as the inviter chooser's UI policy rather
 * than the raw driver mapping. The two diverge on one cell -- a console filedrop:
 * the driver plumbing can run it as a server job, but a console filedrop cannot
 * rendezvous cross-party yet, so the chooser offers it as a save-a-file (CLI)
 * card. */
export type TransportRunMode = ExchangeDriverSelection["kind"];

/** One transport card's placement in the chooser: whether it is offered (rendered
 * at all), whether it renders disabled, and how a pick would run. */
export interface TransportOption {
  transport: Transport;
  offered: boolean;
  disabled: boolean;
  runMode: TransportRunMode;
}

/** The chooser's single source of truth for which transport cards are offered,
 * which render disabled, and which is the default. The capability note and the
 * card copy are regenerated from these facts so copy cannot drift from behavior. */
export interface AvailableTransports {
  options: ReadonlyArray<TransportOption>;
  defaultTransport: Transport;
}

const TRANSPORT_ORDER: ReadonlyArray<Transport> = [
  "browser",
  "sftp",
  "filedrop",
];

/**
 * The transport matrix for a build: which cards are offered, which render
 * disabled, how each would run, and the default. Hosted offers all three live in
 * the browser or saved for the CLI, defaulting to the live browser exchange. The
 * console appliance offers the same three cards but disables the Browser card (its
 * in-tab WebRTC exchange awaits the Node WebRTC + proxy interconnectivity work) and
 * routes its filedrop card to save-a-file (a console filedrop server job cannot
 * rendezvous cross-party today, though the driver plumbing still supports it). The
 * console default is SFTP when the appliance has provisioned remotes, else the
 * filedrop save-a-file card.
 */
export function availableTransports(
  consoleBuild: boolean,
  sftpRemotesConfigured: boolean,
): AvailableTransports {
  const profile: DeploymentProfile = consoleBuild ? "console" : "hosted";
  const options = TRANSPORT_ORDER.map((transport): TransportOption => {
    const disabled = consoleBuild && transport === "browser";
    const runMode: TransportRunMode =
      consoleBuild && transport === "filedrop"
        ? "save-file"
        : selectExchangeDriver(transport, profile, sftpRemotesConfigured).kind;
    return { transport, offered: true, disabled, runMode };
  });
  const defaultTransport: Transport = consoleBuild
    ? sftpRemotesConfigured
      ? "sftp"
      : "filedrop"
    : "browser";
  return { options, defaultTransport };
}

/** The run mode of a chosen transport in an {@link AvailableTransports} matrix;
 * `browser` when the matrix does not model the transport (unreachable for the
 * closed {@link Transport} set, but keeps callers total). */
export function transportRunMode(
  available: AvailableTransports,
  transport: Transport,
): TransportRunMode {
  return (
    available.options.find((option) => option.transport === transport)
      ?.runMode ?? "browser"
  );
}

const TRANSPORT_RUN_NOUN: Record<Transport, string> = {
  browser: "live",
  sftp: "SFTP",
  filedrop: "shared-directory",
};

function joinNouns(nouns: ReadonlyArray<string>): string {
  if (nouns.length <= 1) return nouns.join("");
  if (nouns.length === 2) return `${nouns[0]} and ${nouns[1]}`;
  return `${nouns.slice(0, -1).join(", ")}, and ${nouns[nouns.length - 1]}`;
}

function transportNounsByRunMode(
  available: AvailableTransports,
  runMode: TransportRunMode,
): Array<string> {
  return available.options
    .filter((option) => option.runMode === runMode)
    .map((option) => TRANSPORT_RUN_NOUN[option.transport]);
}

/** The capability note, regenerated from {@link availableTransports} facts so the
 * copy cannot drift from which transports run here, save a file for the CLI, or are
 * a disabled roadmap capability. */
function capabilityNoteFor(
  consoleBuild: boolean,
  available: AvailableTransports,
): string {
  if (!consoleBuild)
    return "This browser runs live exchanges only; SFTP and shared-directory exchanges run in the psilink command-line tool.";
  const here = transportNounsByRunMode(available, "server-job");
  const cli = transportNounsByRunMode(available, "save-file");
  const parts: Array<string> = [];
  if (here.length > 0)
    parts.push(`This appliance runs ${joinNouns(here)} exchanges here`);
  if (cli.length > 0)
    parts.push(
      here.length > 0
        ? `${joinNouns(cli)} exchanges save a file for the command-line tool`
        : `This appliance saves a file for the command-line tool to run ${joinNouns(cli)} exchanges`,
    );
  parts.push("in-tab browser exchanges are a planned capability");
  return `${parts.join("; ")}.`;
}

/** The Review & create transport-chooser copy that changes with the deployment.
 * The hosted build keeps the browser-only phrasing and saves the two command-line
 * exchanges for the CLI. On the console appliance (`consoleBuild`) the Browser card
 * names its in-tab exchange as a planned capability, the filedrop card saves a file
 * for the CLI (its server-job cannot rendezvous cross-party yet), and -- when the
 * appliance has provisioned SFTP remotes (`sftpServerJob`) -- the SFTP card offers
 * to run here and reads the file on the appliance. The capability note is
 * regenerated from {@link availableTransports} so it cannot drift from behavior. */
export interface TransportChooserCopy {
  browserLabel: string;
  browserDescription: string;
  filedropLabel: string;
  filedropDescription: string;
  sftpLabel: string;
  sftpDescription: string;
  capabilityNote: string;
}

export function transportChooserCopy(
  consoleBuild: boolean,
  sftpServerJob: boolean,
): TransportChooserCopy {
  const available = availableTransports(consoleBuild, sftpServerJob);
  const sftpRunsHere = consoleBuild && sftpServerJob;
  return {
    browserLabel: "Live, in this browser",
    browserDescription: consoleBuild
      ? "In-tab browser exchanges are a planned capability for this appliance. They await its built-in WebRTC and connection-proxy support; until then, run the exchange over SFTP or save a file for the command-line tool."
      : "Your browsers connect directly. You get an invitation link and code to share; keep this tab open while your partner accepts.",
    filedropLabel: "Over a shared directory, run by the command-line tool",
    filedropDescription:
      "Saves an exchange file the command-line tool runs against a directory both parties can reach.",
    sftpLabel: sftpRunsHere
      ? "Over SFTP, run here"
      : "Over SFTP, run by the psilink command-line tool",
    sftpDescription: sftpRunsHere
      ? "Runs the exchange here through an SFTP server provisioned on this machine. Your file is read on this appliance, not uploaded from your browser. Your partner accepts with the same invitation code."
      : "Saves an exchange file that runs the command-line tool over your SFTP server. Your partner accepts with the same invitation code.",
    capabilityNote: capabilityNoteFor(consoleBuild, available),
  };
}

/**
 * The pure model behind the inviter bench's required spine: seeding the draft
 * from the read file, applying the two column edits step 2 offers, and the
 * view-model builders the Customize facts and the disclosure ledger render from.
 * No React, no I/O -- the tested boundary for "default terms derive from the
 * file" and "the ledger tracks term edits". The draft itself is the AdvancedInvite
 * model's ({@link AdvancedInviteDraft}); the bench re-surfaces that model, so
 * every derivation and edit goes through the same seed/reconcile helpers that
 * model is tested on.
 */

/** The read file the spine works over: identity for the file card plus the
 * parsed rows and columns every derivation binds to. `rowCount` is the file's
 * row total, held explicitly so the display surfaces do not read `rawRows.length`
 * (the console acquires only a server-side profile, not the rows). `dateInputFormat`
 * is a pre-inferred date-of-birth layout ({@link dateInputFormatForColumns}), set
 * only by sources that profile it without rows (the console); when absent, each
 * derivation infers it from the rows as before. */
export interface AcquiredCsv {
  fileName: string;
  sizeBytes: number;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  rowCount: number;
  dateInputFormat?: string;
  /** True when this shape carries no rows -- the console acquires a server-side
   * profile, not the file, so `rawRows` is a throwing getter there. The draft
   * reconciliations read rows only to infer the date-of-birth format, which the
   * console supplies as `dateInputFormat`, so a rows-withheld shape contributes an
   * empty row set to those helpers ({@link seedRows}) rather than reading the
   * getter. */
  rowsWithheld?: boolean;
}

/** The rows the draft reconciliations feed to the seed/standardization helpers,
 * whose only use of rows is date-of-birth format inference. A rows-withheld console
 * shape ({@link AcquiredCsv.rowsWithheld}) contributes an empty set -- its
 * `dateInputFormat` was already profiled, so the inference has no rows to draw on
 * and needs none -- while a hosted shape contributes its parsed rows. Keeping the
 * access here means the throwing `rawRows` getter is never touched on the console.
 * Exported so the one remaining `rawRows` consumer that lives outside this module
 * (the expert-mode terms import/export) reads rows through the same guard. */
export function seedRows(csv: AcquiredCsv): Array<CSVRow> {
  return csv.rowsWithheld === true ? [] : csv.rawRows;
}

/** An editing session over the read file: the live draft and the fixed seed it
 * derived from ({@link seedAdvancedInvite}). Once `sealed` (the invitation was
 * created), every mutator in this module returns the session unchanged -- the
 * terms a partner is consenting to can never drift from what was minted.
 * `keysAuthored` marks the key set as author-controlled (an expert edit or an
 * import): a later column edit then reconciles the metadata and standardization
 * but leaves the keys untouched, because the template-driven key reconciliation
 * would silently drop authored keys. */
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

/** Seed the editing session from the read file -- the "default terms derive
 * from the file the moment it is read" moment of the design. */
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

/** Enable or disable the key at `index` in the guided list. */
export function editorWithKeyEnabled(
  editor: InviterEditor,
  index: number,
  enabled: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      keys: editor.draft.keys.map((entry, at) =>
        at === index ? { ...entry, enabled } : entry,
      ),
    },
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

/** Set the matching algorithm. Gated: while the run does not honor psi-c the
 * control stays disabled and {@link validateAdvancedInvite}'s build clamps the
 * minted terms to `psi` regardless of this draft state. */
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

/** Restore the recommended cleaning for the current metadata -- the cleaning
 * error boundary's recovery, scoped to the cleaning alone. */
export function editorWithRecommendedCleaning(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: defaultStandardizationForRows(
        editor.draft.metadata,
        getDefaultLinkageTerms(editor.draft.identity, editor.draft.metadata),
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
 * A per-key verdict for the guided list's and expert editor's badges. Three
 * outcomes, because a shape-satisfiable key can still be self-defeating:
 * - `satisfiable`: every element field is producible and no element's transform
 *   is value-killing.
 * - `dead`: the columns can produce every element field (shape passes), but an
 *   element's authored standardization can never yield a value -- a
 *   self-defeating `parse_date` whose input format omits a component the data
 *   carries. The key would run to a silent empty result, so it warns even though
 *   the shape check passes.
 * - `unsatisfiable`: an element references a field the columns cannot produce.
 *
 * `dead` is derived from the authored terms alone (value-independent, via
 * {@link pipelineAlwaysDrops}), consistent with how the shape verdict is
 * computed without data. It matches the acceptor surface, whose `deadKeyCount`
 * counts the same self-defeating keys.
 */
export type KeyVerdict = "satisfiable" | "dead" | "unsatisfiable";

/** The per-key verdict function behind the Keys tab badges ({@link KeyVerdict}). */
export function keySatisfiabilityFor(
  editor: InviterEditor,
): (index: number) => KeyVerdict {
  const producible = producibleFieldNames(
    editor.draft.metadata,
    editor.draft.standardization,
    editor.seed.columns,
  );
  return (index) => {
    const key = editor.draft.keys[index].key;
    if (!key.elements.every((element) => producible.has(element.field)))
      return "unsatisfiable";
    if (key.elements.some((element) => pipelineAlwaysDrops(element.transform)))
      return "dead";
    return "satisfiable";
  };
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

/** The linkage keys the draft currently authors, in order. */
export function enabledKeys(draft: AdvancedInviteDraft): Array<LinkageKey> {
  return draft.keys.filter((entry) => entry.enabled).map((entry) => entry.key);
}

/** Whether the metadata sits in the two-identifier state the single-identifier
 * rule forbids -- the work column's Problems entry for step 2. */
export function identifierProblem(draft: AdvancedInviteDraft): boolean {
  return hasMultipleIdentifiers(draft.metadata);
}

/** A byte count as a compact size label, e.g. `8.4 MB`, `512 KB`, `2.1 GB`. The
 * ladder floors at 1 KB and runs to GB, since CLI-scale console inputs reach
 * gigabytes; shared by the file card and the server-file picker so their size ladders
 * cannot drift. */
export function byteSizeLabel(sizeBytes: number): string {
  if (sizeBytes >= 1024 ** 3) return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`;
  if (sizeBytes >= 1024 ** 2) return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** The file card's metadata line, e.g. `12,408 rows - 8.4 MB`. */
export function fileCardMeta(rowCount: number, sizeBytes: number): string {
  const rows = new Intl.NumberFormat("en-US").format(rowCount);
  return `${rows} rows - ${byteSizeLabel(sizeBytes)}`;
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
  { seconds: 3600, label: "1 hour" },
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

/** A calendar day phrased for display, e.g. `July 8, 2026` -- the date-granularity
 * form the backup surfaces read ("backed up as of <date>"), where the minute is
 * noise. */
export function dateLabel(moment: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(moment);
}

/** The absolute moment an invitation shared `now` would expire, phrased for
 * the live expiry hint. */
export function expiryLabel(lifetimeSeconds: number, now: Date): string {
  return dateTimeLabel(new Date(now.getTime() + lifetimeSeconds * 1000));
}

/** Whether a minted invitation's ISO `expires` moment is still ahead of `now`
 * -- past it, no partner can pass the credential, so a retry is pointless and
 * the link must stop being offered. */
export function invitationUsable(expiresIso: string, now: Date): boolean {
  return new Date(expiresIso).getTime() > now.getTime();
}

/** Ledger phrasing for who receives the matched results. */
export const RESULTS_DIRECTION_LABELS: Record<OutputDirection, string> = {
  both: "You and your partner",
  inviter: "Only you",
  partner: "Only your partner",
};

/** One disclosure-ledger row: `value` renders in the data voice, `muted`
 * renders in the empty-state voice ("None", "Nothing"), neither renders the
 * em-dash placeholder. `shareBar` marks the row as one of the headline
 * disclosure facts the narrow viewport's condensed "What you will share" bar
 * keeps -- declared here by the producer, so a relabel can never silently
 * drop a row from that trust surface. */
export interface InviterLedgerRow {
  label: string;
  reference?: string;
  value?: string | ReadonlyArray<string>;
  muted?: string;
  shareBar?: boolean;
}

/** What a completed exchange settled, folded into the ledger: the invitation
 * is consumed (its expiry no longer means anything), and the receive row can
 * state what actually arrived -- the matched-row count, or that the agreed
 * terms withheld the result table from this party. */
export interface LedgerOutcome {
  matchedRecordCount?: number;
  resultWithheld?: boolean;
}

/**
 * The disclosure ledger for the spine, filling in as the exchange takes shape:
 * before a file is read every value is the em-dash placeholder; once a session
 * exists the send list, matched-on keys, expiry, and result direction are read
 * live from the draft. Once the invitation is minted its absolute `expires`
 * moment replaces the relative lifetime phrase, and once the exchange
 * completes `outcome` replaces the forward-looking rows with what happened.
 */
export function inviterLedgerRows(
  editor: InviterEditor | undefined,
  expiresIso?: string,
  outcome?: LedgerOutcome,
): Array<InviterLedgerRow> {
  if (editor === undefined) {
    return [
      { label: "You will send", reference: "Step 2", shareBar: true },
      { label: "You will receive", reference: "Step 2" },
      { label: "Matched on", reference: "Step 2", shareBar: true },
      { label: "Expires", reference: "Step 3", shareBar: true },
      { label: "Results go to", reference: "Step 3" },
      { label: "Agreement" },
      { label: "How it runs", reference: "Step 3" },
    ];
  }
  const sent = disclosedColumnNames(editor.draft.metadata);
  const keys = enabledKeys(editor.draft);
  return [
    sent.length > 0
      ? {
          label: "You will send",
          reference: "Step 2",
          value: sent.join(", "),
          shareBar: true,
        }
      : {
          label: "You will send",
          reference: "Step 2",
          muted: "Nothing - matching only",
          shareBar: true,
        },
    {
      label: "You will receive",
      reference: "Step 2",
      value:
        outcome === undefined
          ? "Matched rows + your partner's shared columns"
          : outcome.resultWithheld === true
            ? "No result table - withheld by the agreed terms"
            : `${new Intl.NumberFormat("en-US").format(outcome.matchedRecordCount ?? 0)} matched rows + shared columns`,
    },
    keys.length > 0
      ? {
          label: "Matched on",
          reference: "Step 2",
          value: keys.map((key, index) => `${index + 1}. ${key.name}`),
          shareBar: true,
        }
      : {
          label: "Matched on",
          reference: "Step 2",
          muted: "No keys",
          shareBar: true,
        },
    {
      label: "Expires",
      reference: "Step 3",
      value:
        outcome !== undefined
          ? "Invitation used"
          : expiresIso !== undefined
            ? dateTimeLabel(new Date(expiresIso))
            : lifetimeLabel(editor.draft.lifetimeSeconds),
      shareBar: true,
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
    {
      label: "How it runs",
      reference: "Step 3",
      value: TRANSPORT_LEDGER_LABELS[editor.transport ?? "browser"],
    },
  ];
}

/** One quiet fact for the Customize menu; `target` is the tab the
 * fact's label opens. `tone` colors the fact only when the surface needs
 * attention (a failing cleaning pipeline); never conveyed by color alone. */
export interface InviterRailFact {
  label: string;
  fact?: string;
  tone?: "attention";
  target: Extract<SpineTarget, "cleaning" | "keys" | "agreement">;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The Cleaning tab's Customize-menu attention state, from the effective
 * standardization and the full-CSV coverage. A field is "failing" when its
 * transform drops every row ({@link isSilentEmpty}); the count de-duplicates
 * by field name. Invalid authored steps are NOT counted here -- they are
 * {@link validateAdvancedInvite}'s to surface, so counting them would
 * double-report in the work column's Problems block. `rates` is null before the
 * first sweep settles; a pending sweep contributes no failing fields, so
 * attention is computed only from a resolved map.
 */
export interface InviterCleaningAttention {
  /** Whether the Cleaning tab needs attention (any failing field present). */
  needsAttention: boolean;
  /** The number of fields whose pipeline produces no value in any row, for the
   * amber "N field(s) failing" value. */
  failingFieldCount: number;
  /** The Customize-menu fact string: undefined (em-dash) when no attention is
   * needed, else the amber "N field(s) failing" value (matching the acceptor's). */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the session's standardization
 * and the full-CSV coverage. A silent-empty field ({@link isSilentEmpty}) is a
 * failing field; the count de-duplicates by field name. No file (`editor`
 * undefined) or a null (pending) rate map raises nothing -- coverage is not yet
 * known, not a collapse.
 */
export function inviterCleaningAttention(
  editor: InviterEditor | undefined,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
): InviterCleaningAttention {
  const failing = new Set<string>();
  if (editor !== undefined && rates !== null)
    for (const transformation of editor.draft.standardization) {
      const rate = rates.get(transformation.output);
      if (rate !== undefined && isSilentEmpty(rate))
        failing.add(transformation.output);
    }
  const failingFieldCount = failing.size;
  return {
    needsAttention: failingFieldCount > 0,
    failingFieldCount,
    railValue:
      failingFieldCount > 0
        ? `${plural(failingFieldCount, "field")} failing`
        : undefined,
  };
}

/** The cleaning summary ("3 fields") shared by the Customize fact and the
 * check-your-answers row, so the two surfaces cannot disagree. */
export function cleaningFact(draft: AdvancedInviteDraft): string {
  return plural(draft.standardization.length, "field");
}

/** The key-count summary ("2 keys") shared by the Customize fact and the
 * check-your-answers row. */
export function keysFact(draft: AdvancedInviteDraft): string {
  return plural(enabledKeys(draft).length, "key");
}

/**
 * The Customize group's quiet facts, read live from the draft: cleaning
 * pipeline count, authored key count, and the agreement reference. Undefined
 * facts render as the em-dash "nothing yet" mark. When the cleaning coverage
 * is failing ({@link inviterCleaningAttention}), the Cleaning fact turns amber
 * and names the failing-field count instead of the plain field count, matching
 * the acceptor. `attention` is undefined before a file is read or a sweep
 * settles, where the Cleaning row shows its plain count.
 */
export function inviterRailFacts(
  editor: InviterEditor | undefined,
  attention?: InviterCleaningAttention,
): Array<InviterRailFact> {
  const cleaningAttention =
    editor !== undefined && attention?.needsAttention === true;
  return [
    {
      label: "Cleaning",
      fact:
        editor === undefined
          ? undefined
          : cleaningAttention
            ? attention.railValue
            : cleaningFact(editor.draft),
      tone: cleaningAttention ? "attention" : undefined,
      target: "cleaning",
    },
    {
      label: "Matching on",
      fact: editor === undefined ? undefined : keysFact(editor.draft),
      target: "keys",
    },
    {
      label: "Legal agreement",
      fact: editor?.draft.legalAgreement?.reference,
      target: "agreement",
    },
  ];
}

/** A bench section a Problems entry or a Change link can navigate to: a spine
 * step or a Customize tab. */
export type SpineTarget =
  "file" | "columns" | "review" | "cleaning" | "keys" | "agreement";

/** The section that owns each validation field, so a Problems entry can link
 * to where the fix lives. */
const FIELD_TARGETS: Record<AdvancedField, SpineTarget> = {
  identity: "file",
  payload: "columns",
  keys: "keys",
  standardization: "cleaning",
  lifetime: "review",
  legalReference: "agreement",
  legalPurpose: "agreement",
  legalExpiration: "agreement",
};

/** One entry in the work column's Problems block: the message and the section
 * that can resolve it. `key` is a stable per-entry render key for entries whose
 * messages may repeat (two same-typed failing fields bound to one column);
 * absent, the message is the key. */
export interface SpineProblem {
  message: string;
  target: SpineTarget;
  key?: string;
}

/** Validate the draft for the create gate -- the AdvancedInvite model's own
 * validation over the bench's session. */
export function reviewValidation(
  editor: InviterEditor,
  now: Date = new Date(),
): AdvancedValidation {
  return validateAdvancedInvite(editor.draft, editor.seed, now);
}

/**
 * The work column's Problems entries for a failing cleaning pipeline: one per
 * field whose transform produces no value in any row of the loaded file
 * ({@link isSilentEmpty}), de-duplicated by field name (the same key
 * {@link inviterCleaningAttention} counts by, so the rail count and the entry
 * count agree), each naming the field's safe semantic-type label (never the
 * partner-controlled field name) and linking into the Cleaning tab. When the
 * draft authors more than one field of a type (the expert add-field
 * affordance), the label alone cannot tell them apart, so the entry also names
 * the field's input column -- the operator's own header, shown raw as the
 * ledger's send row does. This is file-dependent, not draft-dependent
 * (it needs the full-CSV coverage), so it lives beside {@link spineProblems}
 * rather than inside {@link validateAdvancedInvite}; the bench merges the two at
 * every consumption point. Empty before a file is read, before the first sweep
 * settles (`rates` null), or when no field collapses -- so it never fires while
 * coverage is still being computed.
 */
export function cleaningCoverageProblems(
  editor: InviterEditor | undefined,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
): Array<SpineProblem> {
  if (editor === undefined || rates === null) return [];
  const typeByName = new Map(
    authoredLinkageFields(
      editor.draft.metadata,
      editor.draft.standardization,
    ).map((field) => [field.name, field.type]),
  );
  const authoredPerType = new Map<LinkageField["type"], number>();
  for (const transformation of editor.draft.standardization) {
    const type = typeByName.get(transformation.output);
    if (type !== undefined)
      authoredPerType.set(type, (authoredPerType.get(type) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const problems: Array<SpineProblem> = [];
  for (const transformation of editor.draft.standardization) {
    const rate = rates.get(transformation.output);
    if (rate === undefined || !isSilentEmpty(rate)) continue;
    if (seen.has(transformation.output)) continue;
    seen.add(transformation.output);
    const type = typeByName.get(transformation.output);
    if (type === undefined) continue;
    const label =
      (authoredPerType.get(type) ?? 0) > 1
        ? `"${SEMANTIC_TYPE_LABELS[type]}" (from ${transformation.input})`
        : `"${SEMANTIC_TYPE_LABELS[type]}"`;
    problems.push({
      key: transformation.output,
      message: `Cleaning: ${label} produces no value in any row`,
      target: "cleaning",
    });
  }
  return problems;
}

/**
 * The work column's Problems block as an error summary: the single-identifier
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
      message: "Choose a single record identifier",
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
 * of no return, each row's Change link navigating to the spine step or
 * Customize tab that owns the term. */
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
      value: `${sanitizeForDisplay(csv.fileName)} - ${new Intl.NumberFormat("en-US").format(csv.rowCount)} rows`,
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
      changeTarget: "cleaning",
    },
    {
      label: "Matching on",
      value: `${keysFact(editor.draft)}, tried in order`,
      changeTarget: "keys",
    },
    {
      label: "Legal agreement",
      value: editor.draft.legalAgreement?.reference ?? "None",
      mono: editor.draft.legalAgreement?.reference !== undefined,
      changeTarget: "agreement",
    },
    {
      label: "Invitation duration",
      value: lifetimeNoun(editor.draft.lifetimeSeconds),
      setAbove: true,
    },
    {
      label: "Results go to",
      value: RESULTS_DIRECTION_LABELS[editor.draft.outputDirection],
      setAbove: true,
    },
    {
      label: "How it runs",
      value: TRANSPORT_ANSWER_LABELS[editor.transport ?? "browser"],
      setAbove: true,
    },
  ];
}
