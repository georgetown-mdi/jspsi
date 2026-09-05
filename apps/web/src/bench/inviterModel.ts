import {
  MAX_INVITATION_LIFETIME_SECONDS,
  authoredLinkageFields,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  hasExpiryInstantPassed,
  sanitizeForDisplay,
} from "@psilink/core";

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
} from "@psi/advancedInvite";

import {
  SEMANTIC_TYPE_LABELS,
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { isolatedColumnName } from "@components/ColumnName";

import { OFFLINE_EXCHANGE_REASON } from "./offlineExchangeGate";
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
  LinkageKeyFitness,
  LinkageStrategy,
  LinkageTerms,
  SemanticType,
} from "@psilink/core";
import type { DeploymentProfile } from "@utils/clientConfig";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { ExchangeDriverSelection } from "./exchangeDriverSelection";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { RunOutputs } from "./runOutputs";

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
 * {@link ExchangeDriverSelection} kind as the inviter chooser's UI policy. A console
 * filedrop runs as a server job against the mounted rendezvous directory when
 * `JOB_RENDEZVOUS_DIR` is set, and is disabled otherwise. */
export type TransportRunMode = ExchangeDriverSelection["kind"];

/** One transport card's placement in the chooser: whether it renders disabled,
 * how a pick would run, and -- for SFTP on a console -- whether a connection
 * still needs authoring before it can run here. */
export interface TransportOption {
  transport: Transport;
  disabled: boolean;
  runMode: TransportRunMode;
  /** The console SFTP third state: offered to run here, but no connection is
   * authored yet, so the card reveals the authoring form. False for every other
   * transport and once a connection is configured or the save-a-file alternative
   * is chosen. */
  authoringRequired: boolean;
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
 * in-tab WebRTC exchange is out of scope on the appliance) and runs its filedrop
 * card here as a server job against the mounted rendezvous directory -- disabled
 * when `JOB_RENDEZVOUS_DIR` is unset. The console default is SFTP when the appliance
 * has an authored connection, else the filedrop card when a rendezvous directory is
 * mounted, else SFTP (where the card offers authoring).
 *
 * `sftpConfigured` is "authored-and-complete"; an unconfigured console SFTP is
 * offered to run here with `authoringRequired` set (the card reveals the authoring
 * form) rather than silently degrading to save-a-file.
 * `sftpSaveFilePreferred` is the operator's deliberate choice to run SFTP through
 * their own command-line tool instead, which flips the SFTP run mode to
 * save-a-file and clears `authoringRequired`.
 */
export function availableTransports(
  consoleBuild: boolean,
  sftpConfigured: boolean,
  rendezvousConfigured: boolean,
  sftpSaveFilePreferred = false,
): AvailableTransports {
  const profile: DeploymentProfile = consoleBuild ? "console" : "hosted";
  const options = TRANSPORT_ORDER.map((transport): TransportOption => {
    const disabled =
      consoleBuild &&
      (transport === "browser" ||
        (transport === "filedrop" && !rendezvousConfigured));
    const runMode: TransportRunMode = selectExchangeDriver(
      transport,
      profile,
      sftpConfigured,
      sftpSaveFilePreferred,
    ).kind;
    const authoringRequired =
      transport === "sftp" &&
      consoleBuild &&
      !sftpConfigured &&
      !sftpSaveFilePreferred;
    return { transport, disabled, runMode, authoringRequired };
  });
  const defaultTransport: Transport = consoleBuild
    ? sftpConfigured
      ? "sftp"
      : rendezvousConfigured
        ? "filedrop"
        : "sftp"
    : "browser";
  return { options, defaultTransport };
}

/** The run mode of a chosen transport in an {@link AvailableTransports} matrix;
 * `browser` when the matrix does not model the transport, which keeps callers
 * total. That every build models all three -- so this answer is the matrix's own
 * and never the fallback -- is checked in benchInviterModel.test.ts. */
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
    .filter((option) => option.runMode === runMode && !option.disabled)
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
    parts.push(`This console runs ${joinNouns(here)} exchanges here`);
  if (cli.length > 0)
    parts.push(
      here.length > 0
        ? `${joinNouns(cli)} exchanges save a file for the command-line tool`
        : `This console saves a file for the command-line tool to run ${joinNouns(cli)} exchanges`,
    );
  parts.push("in-tab browser exchanges are out of scope on this console");
  return `${parts.join("; ")}.`;
}

/** The Review & create transport-chooser copy that changes with the deployment.
 * The hosted build keeps the browser-only phrasing and saves the two command-line
 * exchanges for the CLI. On the console appliance (`consoleBuild`) the Browser card
 * is disabled as out of scope, the filedrop card runs here against the mounted
 * rendezvous directory when one is configured (`rendezvousConfigured`, else it is
 * disabled), and the SFTP card offers to run here: with a configured connection
 * (`sftpConfigured`) it reads the file on the appliance; with none it invites the
 * operator to author one, unless they chose the save-a-file alternative
 * (`sftpSaveFilePreferred`). The SFTP copy is derived from the
 * {@link availableTransports} option so it tracks the run mode and the third
 * (authoring-required) state, and the capability note is regenerated from the same
 * matrix, so neither drifts from behavior. */
export interface TransportChooserCopy {
  browserLabel: string;
  browserDescription: string;
  filedropLabel: string;
  filedropDescription: string;
  sftpLabel: string;
  sftpDescription: string;
  capabilityNote: string;
}

/**
 * What the appliance's rendezvous mounts add to the filedrop card's copy beyond
 * "configured or not": whether they are a split inbound/outbound pair, and the
 * reason a configured pair still cannot run. Both come from the appliance's own
 * provisioning, so both are absent off a console build.
 *
 * Separate from `rendezvousConfigured` rather than folded into it because neither
 * changes which cards are OFFERED -- an appliance whose pair is incoherent reports
 * itself unconfigured, and the filedrop card is disabled by that alone. They change
 * only what the card SAYS, which is where an operator with two mounts and one
 * unusable card needs the difference.
 */
export interface RendezvousShape {
  split?: boolean;
  problem?: string;
}

export function transportChooserCopy(
  consoleBuild: boolean,
  sftpConfigured: boolean,
  rendezvousConfigured: boolean,
  sftpSaveFilePreferred = false,
  rendezvousShape: RendezvousShape = {},
): TransportChooserCopy {
  const available = availableTransports(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
  );
  const sftpOption = available.options.find(
    (option) => option.transport === "sftp",
  );
  const sftpRunsHere = sftpOption?.runMode === "server-job";
  const sftpAuthoringRequired = sftpOption?.authoringRequired === true;
  const filedropRunsHere = consoleBuild && rendezvousConfigured;
  return {
    browserLabel: "Live, in this browser",
    browserDescription: consoleBuild
      ? "In-tab browser exchanges are out of scope on this console -- they are the public psilink web app's domain. Run the exchange over SFTP or a shared directory instead."
      : "Your browsers connect directly. You get an invitation link and code to share; keep this tab open while your partner accepts.",
    filedropLabel: filedropRunsHere
      ? "Over a shared directory, run here"
      : "Over a shared directory, run by the command-line tool",
    filedropDescription: filedropRunsHere
      ? rendezvousShape.split === true
        ? 'Runs the exchange here against the two shared folders mounted on this console: it reads your partner\'s files out of one and writes yours into the other. That needs retain mode -- turn on "Keep every exchange file" below. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code and runs their half against the same two folders.'
        : "Runs the exchange here against the shared directory mounted on this console. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code and runs their half against the same synced folder."
      : consoleBuild
        ? // The appliance's own reason wins where it has one: an incoherent pair
          // reports itself unconfigured, and the generic mount-a-directory
          // sentence would send an operator who already mounted two to add a
          // third.
          (rendezvousShape.problem ??
          "Unavailable: mount a rendezvous directory and set JOB_RENDEZVOUS_DIR to run a shared-directory exchange here.")
        : "Saves an exchange file the command-line tool runs against a directory both parties can reach.",
    sftpLabel: sftpRunsHere
      ? "Over SFTP, run here"
      : "Over SFTP, run by the psilink command-line tool",
    sftpDescription: sftpRunsHere
      ? sftpAuthoringRequired
        ? "Runs the exchange here over an SFTP connection you set up below. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code."
        : "Runs the exchange here through the SFTP connection set up on this machine. Your file is read on this console, not uploaded from your browser. Your partner accepts with the same invitation code."
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

/** Enable or disable the key at `index` in the guided list, carrying an opt-in
 * type's cleaning with its key (see {@link draftWithKeyEnabled}). */
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
 * the built terms carry it as authored; a count-only draft outside the shape a
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
 * sink, so they carry the isolation as characters, the treatment every other
 * column-name sink on the step gives them. The rule can displace more than one
 * column at once, so this notice puts literal copy in one text block with the
 * names -- the separators and the sentence after them -- which is the shape the
 * isolate class's residual reaches: what the isolation does not contain there is
 * stated on `@components/ColumnName` and driven in
 * test/browser/benchInviterSharing.test.ts.
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

/** A byte count as a compact size label, e.g. `8.4 MB`, `512 KB`, `2.1 GB`. The
 * ladder floors at 1 KB and runs to GB, since CLI-scale console inputs reach
 * gigabytes; called from the inviter's and acceptor's file cards
 * ({@link fileCardMeta}, `AcceptorBench`) and the server-file picker
 * (`ServerFilePicker`). */
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
 * the link must stop being offered. False for a non-string `expiresIso`, and
 * false when the expiry or the clock cannot be read: a credential whose bound is
 * unreadable is not one to keep handing out. Otherwise the shared comparison's
 * verdict. */
export function invitationUsable(expiresIso: string, now: Date): boolean {
  // The runtime half of the `string` parameter type, for an untyped or cast
  // caller: the shared comparison reads an absent bound as none in force, which
  // would call an invitation carrying no expiry usable.
  if (typeof expiresIso !== "string") return false;
  return !hasExpiryInstantPassed(expiresIso, now, {
    onUnparseable: "fail-closed",
  });
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
 * state what actually arrived -- the matched-row count, the size of the overlap a
 * count-only exchange reported, or that the agreed terms withheld the result table
 * from this party. Discriminated on the same `kind` the run's outputs carry
 * ({@link RunOutputs}), so the three outcomes cannot be read as one another and a
 * ledger that stops handling one is a compile error. */
export type LedgerOutcome =
  | { kind: "matched"; matchedRecordCount?: number }
  | { kind: "withheld" }
  | {
      kind: "counted";
      intersectionCount: number;
      /** Whether the count arrived as the PARTNER's report rather than as a figure
       * this party computed, carried from {@link RunOutputs} rather than dropped:
       * the ledger states the count in its own words, so a ledger without it would
       * repeat the number stripped of the one fact that qualifies it. */
      countReportedByPartner: boolean;
    };

/** Fold a completed run's outputs into the ledger outcome, dropping the download
 * URLs the ledger has no use for. Shared by both seats so neither maps the
 * outcome its own way. */
export function ledgerOutcomeOf(outputs: RunOutputs): LedgerOutcome {
  switch (outputs.kind) {
    case "matched":
      return {
        kind: "matched",
        matchedRecordCount: outputs.matchedRecordCount,
      };
    case "withheld":
      return { kind: "withheld" };
    case "counted":
      return {
        kind: "counted",
        intersectionCount: outputs.intersectionCount,
        countReportedByPartner: outputs.countReportedByPartner,
      };
  }
}

/**
 * The receive row's value for a count-only exchange, shared by both seats' ledgers
 * so one wording covers the outcome. It answers the row's question in the row's own
 * vocabulary: the count is what arrived, and the matched rows and shared columns the
 * other outcomes name are what did not -- a run that reports the size of the overlap
 * produces neither, for either party.
 *
 * A count this party did not compute closes with the provenance clause, so the
 * ledger -- the condensed summary an operator skims or screenshots, away from the
 * result inset carrying the full caveat -- does not state a partner's figure and a
 * locally computed one in the same words. The clause is the row-sized form of the
 * inset's vocabulary rather than a second wording of it: this row states who
 * produced the number, and the inset states what that means. The seat that computed
 * its own count takes the sentence unchanged, since a provenance note there would
 * be false.
 */
export function countOnlyLedgerValue(
  intersectionCount: number,
  countReportedByPartner: boolean,
): string {
  return (
    `${new Intl.NumberFormat("en-US").format(intersectionCount)} records in ` +
    "common - the size of the overlap only, no matched rows and no shared columns" +
    (countReportedByPartner ? "; reported by your partner" : "")
  );
}

/**
 * The settled receive row's value for whichever outcome the run produced, shared by
 * both seats so the three readings stay one set of words. `matchedRowsSuffix` is the
 * only seat-specific part -- what rode along with the matched rows, which the inviter
 * states generically and the acceptor names from the invitation.
 */
export function settledReceiveValue(
  outcome: LedgerOutcome,
  matchedRowsSuffix: string,
): string {
  switch (outcome.kind) {
    case "counted":
      return countOnlyLedgerValue(
        outcome.intersectionCount,
        outcome.countReportedByPartner,
      );
    case "withheld":
      return "No result table - withheld by the agreed terms";
    case "matched":
      return `${new Intl.NumberFormat("en-US").format(
        outcome.matchedRecordCount ?? 0,
      )} matched rows${matchedRowsSuffix}`;
  }
}

/**
 * The disclosure ledger for the spine, filling in as the exchange takes shape:
 * before a file is read every value is the em-dash placeholder; once a session
 * exists the send list, matched-on keys, expiry, and result direction are read
 * live from the draft. Once the invitation is minted its absolute `expires`
 * moment replaces the relative lifetime phrase, and once the exchange
 * completes `outcome` replaces the forward-looking rows with what happened.
 *
 * The send row names the operator's OWN disclosed CSV headers, so they take the
 * isolation their column-name surfaces show them with ({@link isolatedColumnName})
 * rather than the escape partner-controlled text takes: this row sits beside the
 * step that sets the disclosure, and a header reading two ways across the two would
 * be a disagreement about what leaves the machine.
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
          value: sent.map(isolatedColumnName).join(", "),
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
          : settledReceiveValue(outcome, " + shared columns"),
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
   * needed, else the amber value -- the failing-field count, or the
   * coverage-unavailable state (both matching the acceptor's). */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the session's standardization,
 * the full-CSV coverage, and whether the coverage sweep failed for good. A
 * silent-empty field ({@link isSilentEmpty}) is a failing field; the count
 * de-duplicates by field name. No file (`editor` undefined) or a null (pending)
 * rate map raises nothing -- coverage is not yet known, not a collapse. A
 * `coverageUnavailable` sweep (a deterministic coverage failure) over a loaded
 * file raises attention with no field count, so the rail flags that the check
 * could not run instead of showing the plain field count as if it had.
 */
export function inviterCleaningAttention(
  editor: InviterEditor | undefined,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  coverageUnavailable: boolean,
): InviterCleaningAttention {
  const failing = new Set<string>();
  if (editor !== undefined && rates !== null)
    for (const transformation of editor.draft.standardization) {
      const rate = rates.get(transformation.output);
      if (rate !== undefined && isSilentEmpty(rate))
        failing.add(transformation.output);
    }
  const failingFieldCount = failing.size;
  const unavailable = editor !== undefined && coverageUnavailable;
  return {
    needsAttention: failingFieldCount > 0 || unavailable,
    failingFieldCount,
    railValue:
      failingFieldCount > 0
        ? `${plural(failingFieldCount, "field")} failing`
        : unavailable
          ? "Coverage unavailable"
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
  output: "review",
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

/** What holds the create on the review step, in the reading order of the screen
 * itself: the blocker no edit here clears, then the transport's own setup, then
 * the cards below it, and the spine's outstanding problems last. */
export interface InviterCreateGates {
  /** The device reports no network and the chosen transport begins a live run
   * (a save-a-file transport connects to nothing, so it is never held). */
  offlineBlocked: boolean;
  /** An SFTP exchange chosen to run here has no connection authored yet. */
  connectionIncomplete: boolean;
  /** Why the split rendezvous and the retain choice disagree, `undefined` when
   * they do not. Already a whole sentence naming its own remedy, so it is stated
   * as it stands rather than restated per surface. */
  splitDirectoryProblem: string | undefined;
  /** Whether the file-handling card holds a combination core refuses. */
  exchangeFilesBlocked: boolean;
  /** Whether the connection-tuning card holds a value the run would refuse. */
  connectionTuningBlocked: boolean;
  /** Whether the diagnostics-and-recovery card holds an unconfirmed sweep. */
  runDiagnosticsBlocked: boolean;
  /** Whether the receipts card holds a combination the run would refuse. */
  receiptsBlocked: boolean;
  /** How many spine problems the draft carries; they are named last because the
   * cards above are collapsed disclosures whose own notice is invisible until
   * opened, while a spine problem is already listed in the work column. */
  problemCount: number;
}

/** The create gate and the two sentences that state it: what the step shows
 * beside the button, and what it announces to assistive tech at the button. */
export interface InviterCreateStatus {
  /** Whether every gate is clear, which is what the create action enables on. */
  ready: boolean;
  /** The visible line under the create action. */
  statusLine: string;
  /** The live-region sentence, which names the action in full because it is read
   * apart from the button it sits beside. */
  announcement: string;
}

function heldCreate(
  statusLine: string,
  announcement: string,
): InviterCreateStatus {
  return { ready: false, statusLine, announcement };
}

/**
 * The review step's create gate with both of its sentences, derived together so
 * that the button's enabled state, the line beside it, and the announcement
 * cannot disagree -- a gate reachable by only one of the three is
 * unrepresentable here rather than merely tested against. The visible line and
 * the announcement differ in wording alone: the line sits beside an action that
 * names itself, and the announcement is read on its own.
 *
 * The chain follows the screen's reading order, so an operator working down it is
 * sent to the first unresolved surface they meet, and each sentence names the
 * card to open. Every gate but the offline one is cleared on this step.
 */
export function inviterCreateStatus(
  gates: InviterCreateGates,
): InviterCreateStatus {
  if (gates.offlineBlocked)
    return heldCreate(OFFLINE_EXCHANGE_REASON, OFFLINE_EXCHANGE_REASON);
  if (gates.connectionIncomplete)
    return heldCreate(
      "Set up the SFTP connection above to continue.",
      "Set up the SFTP connection above before you can create.",
    );
  if (gates.splitDirectoryProblem !== undefined)
    return heldCreate(gates.splitDirectoryProblem, gates.splitDirectoryProblem);
  if (gates.exchangeFilesBlocked)
    return heldCreate(
      "Resolve the file-handling settings above to continue.",
      "Resolve the file-handling settings above before you can create.",
    );
  if (gates.connectionTuningBlocked)
    return heldCreate(
      "Resolve the connection-tuning settings above to continue.",
      "Resolve the connection-tuning settings above before you can create.",
    );
  if (gates.runDiagnosticsBlocked)
    return heldCreate(
      "Resolve the diagnostics-and-recovery settings above to continue.",
      "Resolve the diagnostics-and-recovery settings above before you can create.",
    );
  if (gates.receiptsBlocked)
    return heldCreate(
      "Resolve the receipts-and-record-keeping settings above to continue.",
      "Resolve the receipts-and-record-keeping settings above before you can create.",
    );
  if (gates.problemCount > 0)
    return heldCreate(
      `Resolve ${gates.problemCount === 1 ? "the problem" : `the ${gates.problemCount} problems`} above to continue.`,
      `${gates.problemCount === 1 ? "A problem" : `${gates.problemCount} problems`} above must be resolved before you can create.`,
    );
  return {
    ready: true,
    statusLine: "Ready to create.",
    announcement: "Ready to create the invitation.",
  };
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
      value: sent.length > 0 ? sent.map(isolatedColumnName).join(", ") : "None",
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
