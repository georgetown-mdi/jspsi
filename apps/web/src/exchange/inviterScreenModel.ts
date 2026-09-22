import {
  editorWithIdentity,
  sealEditor,
  unsealEditor,
} from "@psi/inviterEditor";

import {
  RUN_DIAGNOSTICS_DEFAULT,
  runDiagnosticsAfterRetarget,
} from "@psi/runDiagnosticsModel";
import { RECEIPTS_DEFAULT } from "@psi/receiptsModel";

import {
  MOUNTED_CONFIGURATION_UNREAD,
  mountedConfigurationRead,
} from "@console/mountedConfiguration";

import { CONNECTION_TUNING_DEFAULT } from "@console/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@console/exchangeFilesModel";

import { EMPTY_SAVE_FIELDS } from "./saveExchangeModel";
import { MANAGE_OFFER_IDLE } from "./manageOfferModel";

import type { AcceptKitExchange } from "./acceptKit";
import type { ManageOfferState } from "./manageOfferModel";
import type { SaveExchangeFields } from "./saveExchangeModel";
import type { SavedExchange } from "./SaveExchangeSection";
import type { Section } from "./stepRestore";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type {
  JobRendezvousConfig,
  ProfiledJobInput,
} from "@psi/jobClient/workInputClient";
import type { GeneratedInvitation } from "@psi/invitation";
import type { ReceiptsDraft } from "@psi/receiptsModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionInfo } from "@psi/jobClient/serverJobExchangeDriver";

import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";

import type { LinkageTerms } from "@psilink/core";
import type { LoadedEnforcementRecords } from "@console/loadedConfig";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";
import type { MountedConfigurationState } from "@console/mountedConfiguration";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";
import type { SftpConnectionFormValues } from "@console/sftpConnectionForm";

import type { AlertContent } from "@components/csvIntake";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The inviter console's whole state and the transitions that move it: the step the
 * work column shows, the read file and the draft terms derived from it, the minted
 * invitation and the accept kit fixed beside it, the console's connection and
 * rendezvous, and the per-run authoring drafts. No rendering and no I/O -- the
 * parse, the mint, the save, and the console fetches run in the screen and report
 * their outcomes here as actions -- so the consent-and-mint path is one value that
 * can be read and tested without a browser.
 *
 * Fields that must agree move in one action rather than as separate writes: a name
 * edit carries the draft's identity with it, a mint seals the terms beside the
 * invitation it minted, and a discarded read drops the file, the draft, and the
 * sample marker together. No transition can leave the ledger describing a file, a
 * party, or an invitation the screen no longer holds.
 */

/** The three required steps the top bar walks, in the order it walks them. The
 * Customize tabs and the share and save surfaces are sections outside this spine. */
export type InviterSpineStep = "file" | "columns" | "review";

/** The spine order the top bar renders and the step-state derivation walks. */
export const INVITER_SPINE_ORDER: ReadonlyArray<InviterSpineStep> = [
  "file",
  "columns",
  "review",
];

/** Whether a section is one of the required spine steps, so the step it returns
 * to after a Customize tab is the step it came from. */
export function isInviterSpineStep(
  section: Section,
): section is InviterSpineStep {
  return (INVITER_SPINE_ORDER as ReadonlyArray<Section>).includes(section);
}

/** The inviter console's whole state. */
export interface InviterScreenState {
  /** The inviter's own party name, typed on step 1 and held as the draft's identity. */
  name: string;
  /** The section the work column renders. */
  section: Section;
  /** The spine step a Customize tab was opened from, which stays navigable while
   * no spine step is current. */
  lastSpineStep: InviterSpineStep;
  /** The read file the terms derive from, and the file card's subject. */
  acquired: AcquiredCsv | undefined;
  /** The console profile behind the acquired shape: the console reads the file, so
   * the browser holds only the profile (name, size, mtime, columns, samples, date
   * format). It backs the mint (columns), the run (the mounted-file reference), the
   * coverage sweep, and the preview samples. Undefined on the hosted build, which
   * reads the file in the browser instead. */
  consoleSource: ProfiledJobInput | undefined;
  /** The retained browser File the mint re-parses at its fail-closed parse boundary. */
  sourceFile: File | undefined;
  /** The File System Access handle a drop attached to the selected file, where the
   * platform yielded one; captured so a managed deposit can persist a reusable
   * pointer to the input without a second picker dialog. Absent for a
   * click-selected file, a browser without the API, and the in-memory sample. */
  sourceHandle: FileSystemFileHandle | undefined;
  /** The draft terms seeded from the file and edited by every step-2 and step-3
   * control; sealed once an invitation is minted from them. */
  editor: InviterEditor | undefined;
  /** The file step's refusal. */
  intakeAlert: AlertContent | undefined;
  /** The boundary's column-name sanitation, held apart from intakeAlert: it is an
   * advisory about the file just read, not a refusal, and both can apply at once. */
  sanitizedNotice: AlertContent | undefined;
  /** Whether a parse is in flight. */
  reading: boolean;
  /** The matching-and-sharing step's live region. */
  announcement: string;
  /** The minted invitation the partner accepts, and the value the live run dials on. */
  invitation: GeneratedInvitation | undefined;
  /** The current invitation as the mint fixed it for the partner's accept kit: the
   * token's own locator and the run's retain-mode choice, so the sheet cannot
   * describe a regime the authoring controls moved to after the mint. Set only
   * where an invitation is minted for a partner who accepts from the command line
   * (a console sftp/filedrop run); undefined for a WebRTC exchange and for the
   * hosted build, whose CLI transports route to the save surface and mint nothing
   * here. */
  acceptKitExchange: AcceptKitExchange | undefined;
  /** Whether a mint is in flight. */
  minting: boolean;
  /** What a refused mint was about. */
  createAlert: AlertContent | undefined;
  /** The keys tab's expert authoring switch. */
  expertMode: boolean;
  /** The console's live region for edits that report what they changed. */
  editorAnnouncement: string;
  /** The save surface's authored rendezvous fields. */
  saveFields: SaveExchangeFields;
  /** The minted code and file name the save surface reports back, dropped
   * whenever the file or its profile changes: an exchange file saved for the
   * prior read no longer describes the terms. */
  savedExchange: SavedExchange | undefined;
  /** Whether a save-and-mint is in flight. */
  saving: boolean;
  /** What a refused save was about. */
  saveAlert: AlertContent | undefined;
  /** The console's effective SFTP connection, fetched once on a console build and
   * updated when the operator authors or clears one. Undefined before it resolves;
   * its `connection` is null when none is authored, else the credential-free
   * locator, which gates the SFTP transport and is authored into an sftp
   * invitation's endpoint. */
  sftpInfo: SftpConnectionInfo | undefined;
  /** The operator's deliberate choice to run SFTP through their own command-line
   * tool (save-a-file) instead of authoring a connection here. Reset on a new file. */
  sftpSaveFilePreferred: boolean;
  /** The console's rendezvous mount, fetched once on a console build. Undefined before
   * it resolves; `configured` gates the filedrop transport (offered iff a directory is
   * mounted), `locator` is the advisory locator minted into a filedrop invitation, and
   * `folderName` is the shared folder's own name, present only where the console has
   * one to show as the folder's name. */
  rendezvous: JobRendezvousConfig | undefined;
  /** The operator's file-handling choices for a console server-job run (retain mode
   * and the toggles that travel with it). Held here, beside the transport, because
   * the review step authors them and the run hook consumes them. */
  exchangeFiles: ExchangeFilesDraft;
  /** The operator's connection-tuning choices for the same run (polling, timeouts,
   * the retry budget, and the SFTP session mode), held beside the file-handling
   * draft for the same reasons. */
  connectionTuning: ConnectionTuningDraft;
  /** The operator's per-run diagnostic and recovery choices for the same run, held
   * beside the two drafts above for the same reasons. */
  runDiagnostics: RunDiagnosticsDraft;
  /** The operator's receipt-signing and retention choices for the same run, held
   * beside the three drafts above for the same reasons. */
  receipts: ReceiptsDraft;
  /** Whether the live spine holds the synthetic sample rather than a real file. */
  demoActive: boolean;
  /** The offer's progress and, for a failed deposit, what it was about when a
   * column name explains it. */
  manageOffer: ManageOfferState;
  /** The load of the configuration mounted beside the working directory: what
   * the offer shows, and the two notices it renders beside itself. */
  mountedConfiguration: MountedConfigurationState;
  /** The connection form a loaded configuration seeds, for the review step's
   * SFTP card. Undefined where no configuration is open or the open one names no
   * host, in which case the card starts from the empty form. */
  loadedSftpForm: SftpConnectionFormValues | undefined;
  /** The terms a loaded configuration supplied, held until the file step has a
   * file: the import rebuilds each field's binding against the operator's own
   * columns, so it cannot run before one is read (`editorWithImportedTerms`,
   * `@psi/inviterEditor`). Cleared the moment they are applied. */
  pendingLoadedTerms: PendingLoadedTerms | undefined;
  /** The enforcement records a loaded configuration states and this flow has no
   * control for, held so the run's composed configuration states each as the
   * file did (docs/spec/EXCHANGE_FILE.md, "The records that must survive").
   * Empty where no configuration is open, or the open one states none. */
  loadedEnforcementRecords: LoadedEnforcementRecords;
}

/** The terms and own-column choice a load holds until a file is read. Both move
 * together: the choice is an argument of the import that rebuilds the draft. */
export interface PendingLoadedTerms {
  linkageTerms: LinkageTerms;
  ownColumns: OwnColumnsChoice;
}

/** The console before a visitor has done anything: step 1, no file, no draft, and
 * every per-run draft at its default. */
export const INVITER_SCREEN_INITIAL: InviterScreenState = {
  name: "",
  section: "file",
  lastSpineStep: "file",
  acquired: undefined,
  consoleSource: undefined,
  sourceFile: undefined,
  sourceHandle: undefined,
  editor: undefined,
  intakeAlert: undefined,
  sanitizedNotice: undefined,
  reading: false,
  announcement: "",
  invitation: undefined,
  acceptKitExchange: undefined,
  minting: false,
  createAlert: undefined,
  expertMode: false,
  editorAnnouncement: "",
  saveFields: EMPTY_SAVE_FIELDS,
  savedExchange: undefined,
  saving: false,
  saveAlert: undefined,
  sftpInfo: undefined,
  sftpSaveFilePreferred: false,
  rendezvous: undefined,
  exchangeFiles: EXCHANGE_FILES_DEFAULT,
  connectionTuning: CONNECTION_TUNING_DEFAULT,
  runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
  receipts: RECEIPTS_DEFAULT,
  demoActive: false,
  manageOffer: MANAGE_OFFER_IDLE,
  mountedConfiguration: MOUNTED_CONFIGURATION_UNREAD,
  loadedSftpForm: undefined,
  pendingLoadedTerms: undefined,
  loadedEnforcementRecords: {},
};

/** Everything that moves the inviter console. */
export type InviterScreenAction =
  /** The work column shows a section; a spine step also becomes the step a
   * Customize tab returns to. The browser's own history push is the screen's. */
  | { type: "section-shown"; section: Section }
  /** The operator typed a party name, which is also the draft's identity: the two
   * move together so the ledger cannot name a party the terms do not declare. */
  | { type: "name-changed"; name: string }
  /** A read began, over a dropped file or the sample seed (which names the party
   * it seeds, so step 1 lands complete). */
  | { type: "read-started"; seedName?: string }
  /** A read failed or was refused: the prior read goes with it, since the file
   * card, the recommended-terms callout, and the Continue gate all vouch for it. */
  | { type: "read-discarded"; alert: AlertContent; notice?: AlertContent }
  /** A read settled into a file and the draft terms seeded from it. */
  | {
      type: "file-acquired";
      acquired: AcquiredCsv;
      file: File;
      handle?: FileSystemFileHandle;
      editor: InviterEditor;
      notice?: AlertContent;
      alert?: AlertContent;
    }
  /** The parse settled (or was refused); the file step's spinner stops. */
  | { type: "read-finished" }
  /** The console committed a mounted file, reseeding the draft from its profile. */
  | {
      type: "console-file-seeded";
      source: ProfiledJobInput;
      acquired: AcquiredCsv;
      editor: InviterEditor;
      notice?: AlertContent;
      alert?: AlertContent;
      announcement?: string;
    }
  /** The delimiter moved under the file the console holds: the commit and the
   * draft seeded from it go, since those columns were read by the previous
   * choice and the run would read the file by the new one. */
  | { type: "console-file-voided" }
  /** The console re-profiled the file it already holds, whose columns are
   * unchanged: the authored draft stands and only the profile-derived facts move. */
  | {
      type: "console-file-reprofiled";
      source: ProfiledJobInput;
      acquired: AcquiredCsv;
      editor: InviterEditor;
      notice?: AlertContent;
      announcement: string;
    }
  /** The sample was cleared back to a fresh exchange. */
  | { type: "sample-cleared" }
  /** A step-2 or step-3 edit that announces nothing of its own. */
  | { type: "editor-applied"; editor: InviterEditor }
  /** An edit that reports what it changed (a reset, an import, a reordering). */
  | { type: "editor-replaced"; editor: InviterEditor; announcement: string }
  /** A control announced something without changing the draft. */
  | { type: "editor-announced"; announcement: string }
  /** A column's type or disclosure changed, with the demotion it forced. */
  | { type: "column-edited"; editor: InviterEditor; announcement: string }
  /** A transport was chosen: a different transport is a different rendezvous
   * directory, so any sweep confirmation is re-asked. */
  | { type: "transport-chosen"; editor: InviterEditor }
  /** The mint began; the refusal a prior attempt left goes with it. */
  | { type: "mint-started" }
  /** An invitation was minted: the terms the mint BOUND TO seal beside it --
   * never whatever the draft moved to while the mint was in flight, which the
   * token does not declare -- and the accept kit holds what the mint fixed for a
   * partner accepting from the command line. */
  | {
      type: "invitation-minted";
      editor: InviterEditor;
      invitation: GeneratedInvitation;
      acceptKitExchange?: AcceptKitExchange;
    }
  /** The mint was refused, and settled either way. */
  | { type: "mint-failed"; alert: AlertContent }
  | { type: "mint-finished" }
  /** The terms were sealed and routed to the save surface, which mints the code
   * and the config file together rather than minting here. Carries the editor
   * the seal bound to, the same way invitation-minted does, so this case never
   * has to read state.editor to know what it sealed. */
  | { type: "save-routed"; editor: InviterEditor }
  /** The operator left a finalized exchange for a fresh one: the seal lifts with
   * every input intact and the minted artifacts are discarded. */
  | { type: "started-over" }
  /** The save surface's rendezvous fields were edited. */
  | { type: "save-fields-changed"; fields: SaveExchangeFields }
  /** The save-and-mint began, landed with the code and file it wrote, was
   * refused, and settled either way. */
  | { type: "save-started" }
  | { type: "exchange-file-saved"; saved: SavedExchange }
  | { type: "save-failed"; alert: AlertContent }
  | { type: "save-finished" }
  /** The console reported the SFTP connection it holds. */
  | { type: "console-sftp-resolved"; info: SftpConnectionInfo }
  /** The operator authored an SFTP connection in-console: the run mode flips to
   * server-job, and the fresh server is a different rendezvous directory. */
  | { type: "sftp-connection-authored"; connection: SftpConnectionProjection }
  /** The authored connection was cleared, returning the card to its empty state. */
  | { type: "sftp-connection-cleared" }
  /** The operator chose between authoring a connection here and saving a file for
   * their own command-line tool. */
  | { type: "sftp-save-file-preferred"; preferred: boolean }
  /** The console reported its rendezvous mount. */
  | { type: "console-rendezvous-resolved"; config: JobRendezvousConfig }
  /** A per-run authoring draft was edited. */
  | { type: "exchange-files-chosen"; draft: ExchangeFilesDraft }
  | { type: "connection-tuning-chosen"; draft: ConnectionTuningDraft }
  | { type: "run-diagnostics-chosen"; draft: RunDiagnosticsDraft }
  | { type: "receipts-chosen"; draft: ReceiptsDraft }
  /** The keys tab's expert authoring switch moved. */
  | { type: "expert-mode-chosen"; expertMode: boolean }
  /** The managed-exchange deposit began, landed, or failed. */
  | { type: "manage-offer-started" }
  | { type: "manage-offer-deposited" }
  | { type: "manage-offer-failed"; refusal?: AlertContent }
  /** A read of the mounted configuration is in flight. */
  | { type: "mounted-configuration-reading" }
  /** The read answered. A configuration that opens fills every card the document
   * covers in one action, so no step is left showing a value from another
   * configuration; a refusal or an absent mount fills none. */
  | { type: "mounted-configuration-read"; answer: MountedConfigurationAnswer }
  /** The held terms reached the file the import binds them against. */
  | { type: "loaded-terms-applied"; editor: InviterEditor };

/** The state a discarded or cleared read leaves: no file, no profile, no draft,
 * and no sample marker, so nothing downstream vouches for a file that is gone. */
const NO_FILE = {
  acquired: undefined,
  consoleSource: undefined,
  sourceFile: undefined,
  sourceHandle: undefined,
  editor: undefined,
  demoActive: false,
} as const;

/** Apply one action to the inviter console's state. */
export function inviterScreenReducer(
  state: InviterScreenState,
  action: InviterScreenAction,
): InviterScreenState {
  switch (action.type) {
    case "section-shown":
      return {
        ...state,
        section: action.section,
        ...(isInviterSpineStep(action.section)
          ? { lastSpineStep: action.section }
          : {}),
      };
    case "name-changed":
      return {
        ...state,
        name: action.name,
        editor:
          state.editor === undefined
            ? undefined
            : editorWithIdentity(state.editor, action.name),
      };
    case "read-started":
      return {
        ...state,
        // A real drop clears the sample marker; the sample seed sets it. Editing
        // the sample's terms never re-reads, so the marker survives edits.
        demoActive: action.seedName !== undefined,
        ...(action.seedName !== undefined ? { name: action.seedName } : {}),
        reading: true,
        intakeAlert: undefined,
        sanitizedNotice: undefined,
      };
    case "read-discarded":
      return {
        ...state,
        ...NO_FILE,
        sanitizedNotice: action.notice,
        intakeAlert: action.alert,
      };
    case "file-acquired":
      return {
        ...state,
        sanitizedNotice: action.notice,
        acquired: action.acquired,
        sourceFile: action.file,
        sourceHandle: action.handle,
        editor: action.editor,
        savedExchange: undefined,
        intakeAlert: action.alert,
      };
    case "read-finished":
      return { ...state, reading: false };
    case "console-file-seeded":
      return {
        ...state,
        sanitizedNotice: action.notice,
        consoleSource: action.source,
        acquired: action.acquired,
        editor: action.editor,
        savedExchange: undefined,
        intakeAlert: action.alert,
        ...(action.announcement !== undefined
          ? { editorAnnouncement: action.announcement }
          : {}),
      };
    case "console-file-voided":
      return {
        ...state,
        ...NO_FILE,
        intakeAlert: undefined,
        sanitizedNotice: undefined,
      };
    case "console-file-reprofiled":
      return {
        ...state,
        sanitizedNotice: action.notice,
        consoleSource: action.source,
        acquired: action.acquired,
        editor: action.editor,
        savedExchange: undefined,
        editorAnnouncement: action.announcement,
      };
    case "sample-cleared":
      return {
        ...state,
        ...NO_FILE,
        name: "",
        intakeAlert: undefined,
        sanitizedNotice: undefined,
        reading: false,
        savedExchange: undefined,
        invitation: undefined,
        acceptKitExchange: undefined,
        manageOffer: MANAGE_OFFER_IDLE,
      };
    case "editor-applied":
      // Non-announcing edits clear the live region, so a stale notice never
      // lingers and a repeated identical notice re-announces.
      return { ...state, editor: action.editor, editorAnnouncement: "" };
    case "editor-replaced":
      return {
        ...state,
        editor: action.editor,
        editorAnnouncement: action.announcement,
      };
    case "editor-announced":
      return { ...state, editorAnnouncement: action.announcement };
    case "column-edited":
      return {
        ...state,
        editor: action.editor,
        announcement: action.announcement,
      };
    case "transport-chosen":
      return {
        ...state,
        editor: action.editor,
        editorAnnouncement: "",
        runDiagnostics: runDiagnosticsAfterRetarget(state.runDiagnostics),
      };
    case "mint-started":
      return { ...state, minting: true, createAlert: undefined };
    case "save-routed":
      return {
        ...state,
        editor: sealEditor(action.editor),
        savedExchange: undefined,
        saveAlert: undefined,
      };
    case "invitation-minted":
      return {
        ...state,
        editor: sealEditor(action.editor),
        invitation: action.invitation,
        acceptKitExchange: action.acceptKitExchange,
        manageOffer: MANAGE_OFFER_IDLE,
      };
    case "mint-failed":
      return { ...state, createAlert: action.alert };
    case "mint-finished":
      return { ...state, minting: false };
    case "started-over":
      return {
        ...state,
        editor:
          state.editor === undefined ? undefined : unsealEditor(state.editor),
        invitation: undefined,
        acceptKitExchange: undefined,
        savedExchange: undefined,
        manageOffer: MANAGE_OFFER_IDLE,
      };
    case "save-fields-changed":
      return { ...state, saveFields: action.fields };
    case "save-started":
      return { ...state, saving: true, saveAlert: undefined };
    case "exchange-file-saved":
      return { ...state, savedExchange: action.saved };
    case "save-failed":
      return { ...state, saveAlert: action.alert };
    case "save-finished":
      return { ...state, saving: false };
    case "console-sftp-resolved":
      return { ...state, sftpInfo: action.info };
    case "sftp-connection-authored":
      return {
        ...state,
        sftpInfo: { connection: action.connection },
        sftpSaveFilePreferred: false,
        runDiagnostics: runDiagnosticsAfterRetarget(state.runDiagnostics),
      };
    case "sftp-connection-cleared":
      return { ...state, sftpInfo: { connection: null } };
    case "sftp-save-file-preferred":
      return { ...state, sftpSaveFilePreferred: action.preferred };
    case "console-rendezvous-resolved":
      return { ...state, rendezvous: action.config };
    case "exchange-files-chosen":
      return { ...state, exchangeFiles: action.draft };
    case "connection-tuning-chosen":
      return { ...state, connectionTuning: action.draft };
    case "run-diagnostics-chosen":
      return { ...state, runDiagnostics: action.draft };
    case "receipts-chosen":
      return { ...state, receipts: action.draft };
    case "expert-mode-chosen":
      return { ...state, expertMode: action.expertMode };
    case "manage-offer-started":
      return { ...state, manageOffer: { status: "depositing" } };
    case "manage-offer-deposited":
      return { ...state, manageOffer: { status: "deposited" } };
    case "manage-offer-failed":
      return {
        ...state,
        manageOffer: {
          status: "error",
          ...(action.refusal !== undefined ? { refusal: action.refusal } : {}),
        },
      };
    case "mounted-configuration-reading":
      return { ...state, mountedConfiguration: { status: "reading" } };
    case "mounted-configuration-read": {
      const read = mountedConfigurationRead(action.answer);
      const loaded = read.loaded;
      if (loaded === undefined)
        return { ...state, mountedConfiguration: read.state };
      return {
        ...state,
        mountedConfiguration: read.state,
        connectionTuning: loaded.connectionTuning,
        exchangeFiles: loaded.exchangeFiles,
        receipts: {
          ...state.receipts,
          mode: loaded.receipts.mode,
          partnerFingerprint: loaded.receipts.partnerFingerprint,
          retentionDisposition: loaded.receipts.retentionDisposition,
        },
        loadedSftpForm: loaded.sftpForm,
        pendingLoadedTerms: {
          linkageTerms: loaded.linkageTerms,
          ownColumns: loaded.ownColumns,
        },
        loadedEnforcementRecords: loaded.records,
      };
    }
    case "loaded-terms-applied":
      return {
        ...state,
        editor: action.editor,
        pendingLoadedTerms: undefined,
        editorAnnouncement:
          "Loaded the configuration's matching terms. Review them before creating.",
      };
  }
}

/** A function, not a constant, because the focus effect that shows a refusal
 * keys on the alert's identity. */
export function unmatchableFileAlert(): AlertContent {
  return {
    title: "This file cannot be matched",
    message:
      "None of the matching keys can be built from this file's columns. Matching needs columns like name, date of birth, Social Security number, ZIP code, phone, or email.",
  };
}
