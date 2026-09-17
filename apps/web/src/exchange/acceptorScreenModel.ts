import { setColumnTypeForMatching } from "@psi/metadataEditing";

import {
  RUN_DIAGNOSTICS_DEFAULT,
  runDiagnosticsAfterRetarget,
} from "@psi/runDiagnosticsModel";
import { RECEIPTS_DEFAULT } from "@psi/receiptsModel";

import { CONNECTION_TUNING_DEFAULT } from "@console/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@console/exchangeFilesModel";

import { MANAGE_OFFER_IDLE } from "./manageOfferModel";
import { acceptorInitialColumnsState } from "./acceptorColumnsModel";

import type {
  AcceptableInvitation,
  AcceptorDataEdits,
} from "@psi/acceptInvitation";
import type {
  AcceptorAcquiredCsv,
  AcceptorColumnsState,
} from "./acceptorColumnsModel";
import type { AcceptorStep } from "./acceptorModel";
import type { ManageOfferState } from "./manageOfferModel";

import type {
  Displayable,
  Metadata,
  SemanticType,
  StandardizationStep,
} from "@psilink/core";
import type {
  JobRendezvousConfig,
  ProfiledJobInput,
} from "@psi/jobClient/workInputClient";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";
import type { ReceiptsDraft } from "@psi/receiptsModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionInfo } from "@psi/jobClient/serverJobExchangeDriver";

import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";

import type { AlertContent } from "@components/csvIntake";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The acceptor console's whole state and the transitions that move it: the decoded
 * invitation, the step the work column shows, the consent gate's inputs and the
 * values it committed, the acceptor's own file and the column edits over it, the
 * per-run authoring drafts, and the launch the run keys on. No rendering and no
 * I/O -- the decode, the parse, the launch, and the console fetches run in the
 * screen and report their outcomes here as actions -- so the consent-and-launch
 * path is one value that can be read and tested without a browser.
 *
 * Fields that must agree move in one action rather than as separate writes: the
 * rendezvous lands with the decoded invitation it decides runnability for, the
 * consent gate commits the name and this party's duplicate-matching value beside
 * the file it admitted, and a launch takes the committed value rather than
 * whatever the control stands at. No transition can leave the run presenting terms
 * the consent gate did not pass.
 */

/** The columns-step sub-section: the main confirm surface, or the Cleaning tab the
 * Customize menu navigates to (mirroring how InviterScreen mounts its CleaningTab).
 * Only meaningful while {@link AcceptorStep} is `columns`. */
export type AcceptorColumnsSection = "columns" | "cleaning";

/**
 * The async decode's outcome: pending while it runs, an error message on a bad
 * or expired invitation, or the validated invitation ready to review.
 *
 * The message is rendered straight into a React text node, which neutralizes
 * HTML markup but not terminal-control, bidi-override or zero-width bytes, so
 * that render is its display sink. Declaring it `Displayable` rather than
 * `string` makes filling it from a raw partner-controlled description a compile
 * error (`describeDecodeError` returns the brand; `rawDecodeErrorDescription`,
 * which the CLI composes into an error for its own sink to escape, does not).
 */
export type DecodeState =
  | { status: "pending" }
  | { status: "error"; message: Displayable }
  | { status: "ready"; invitation: AcceptableInvitation };

/** A titled inline error rendered beside a consent-step field when a submit slips
 * past the disabled gate and fails the handler re-check. */
export interface FieldErrors {
  name?: string;
  file?: boolean;
}

/** The exchange the acceptor launched: the assembled per-party edits and this
 * party's own side of the matching cardinality. Drives the acceptor's run
 * surface (`AcceptorExchangeSection`); the run hook keys on the derived launch
 * object, so a fresh launch restarts the run.
 *
 * `deduplicate` is the value the consent gate committed, carried here for the
 * same reason the committed name is: the run presents the terms it holds, and
 * the managed-exchange deposit records them, so neither may drift with a later
 * edit to the control. */
export interface AcceptorLaunched {
  edits: AcceptorDataEdits;
  deduplicate: boolean;
}

/** The acceptor console's whole state. */
export interface AcceptorScreenState {
  /** The invitation read out of the URL fragment, and the only gate onto every
   * later step: nothing past the spinner renders until it settles. */
  decode: DecodeState;
  /** The step the work column renders. */
  step: AcceptorStep;
  /** The columns step's sub-section. */
  columnsSection: AcceptorColumnsSection;
  /** The consent attestation, one of the gate's two inputs. */
  consented: boolean;
  /** The name typed at the consent step, the gate's other input. */
  acceptorName: string;
  /** This party's own side of the matching cardinality, authored on the terms
   * review step beside what the invitation declares for the inviting party's. It
   * starts closed -- the value an acceptance derives with no control at all. */
  acceptorDeduplicate: boolean;
  /** The name recorded in the exchange record, committed through the consent gate
   * at "Accept and continue" and fixed thereafter -- the run adopts the terms
   * under this identity, so it must not drift with a later edit to the input. */
  committedName: string;
  /** This party's own deduplicate value as the same gate committed it, and the
   * only one the run presents: the consent surface states what the pair
   * discloses, so a value the operator sets after passing that gate reaches the
   * run only by passing it again (the columns step holds the launch while the
   * two disagree). */
  committedDeduplicate: boolean;
  /** The chosen file, held as an unparsed handle until "Accept and continue"
   * fires and passes the gate. */
  file: File | undefined;
  /** The original file whose parse produced `acquired`, captured at the same commit
   * so the server-job path submits the exact bytes the browser path parsed (no
   * re-serialization of rawRows). Fixed alongside `acquired` and the committed name. */
  acceptedFile: File | undefined;
  /** The File System Access handle the committed file's selection yielded, where
   * the platform gave one (a drop on Chromium in a secure context); captured so a
   * managed deposit can persist a reusable pointer to the input without a second
   * picker dialog. Absent for a click-selected file and a browser without the API. */
  sourceHandle: FileSystemFileHandle | undefined;
  /** The console profile behind the acquired shape: the console reads the file, so
   * the browser holds only the profile (name, size, mtime, columns, samples, date
   * format), committed via the picker's "Use this file" before consent. It backs the
   * columns seed, the run's mounted-file reference, the coverage sweep, and the preview
   * samples. Undefined on the hosted build, which reads the file in the browser behind
   * the consent gate instead. */
  consoleSource: ProfiledJobInput | undefined;
  /** The acceptor's own CSV as the consent gate admitted it (not discarded), so the
   * columns step and its verdict derive from it. */
  acquired: AcceptorAcquiredCsv | undefined;
  /** The layered column-step editor state (metadata plus the override layers),
   * seeded from the acquired columns. */
  columnsState: AcceptorColumnsState | undefined;
  /** The 1-based positions the read stripped control characters from, held
   * beside the acquired file so the confirm-columns step states what was removed
   * on the screen where the names are read and marked. */
  sanitizedColumnPositions: Array<number>;
  /** The consent step's inline field refusals. */
  fieldErrors: FieldErrors;
  /** Why the dropzone turned a file away. */
  rejectionMessage: string | undefined;
  /** What a refused read was about. */
  parseAlert: AlertContent | undefined;
  /** Whether a parse is in flight. */
  parsing: boolean;
  /** The operator's file-handling choices for an accept the console conducts.
   * Authored on the confirm-columns step, beside the connection, and consumed by
   * the launch. */
  exchangeFiles: ExchangeFilesDraft;
  /** The operator's connection-tuning choices for the same accept, authored and
   * consumed alongside the file-handling draft. */
  connectionTuning: ConnectionTuningDraft;
  /** The operator's per-run diagnostic and recovery choices for the same run, held
   * beside the two drafts above for the same reasons. */
  runDiagnostics: RunDiagnosticsDraft;
  /** The operator's receipt-signing and retention choices for the same run, held
   * beside the three drafts above for the same reasons. */
  receipts: ReceiptsDraft;
  /** The console's own rendezvous mount, read before the terms are revealed.
   * Undefined off the console; a console filedrop accept is runnable only when
   * `configured` is true (the exchange runs against the mounted directory), and
   * `folderName` is this console's own name for that directory -- present only
   * where the console can name it, and the only value this seat may show as the
   * shared folder's name. */
  rendezvous: JobRendezvousConfig | undefined;
  /** The console's effective SFTP connection for an accepted SFTP endpoint.
   * Undefined before the accept SFTP endpoint is known; `connection` is null when
   * none is authored, else the credential-free locator. An accepted SFTP exchange
   * is blocked from launch until this holds a connection. */
  sftpInfo: SftpConnectionInfo | undefined;
  /** The offer's progress and, for a failed deposit, what it was about when a
   * column name explains it. Held as one value so no reset can leave a refusal
   * standing over an idle offer. */
  manageOffer: ManageOfferState;
  /** The launched exchange: the assembled edits and the committed cardinality. */
  launched: AcceptorLaunched | undefined;
}

/** The console before the invitation has been read: the review step, no file, no
 * consent, and every per-run draft at its default. */
export const ACCEPTOR_SCREEN_INITIAL: AcceptorScreenState = {
  decode: { status: "pending" },
  step: "review",
  columnsSection: "columns",
  consented: false,
  acceptorName: "",
  acceptorDeduplicate: false,
  committedName: "",
  committedDeduplicate: false,
  file: undefined,
  acceptedFile: undefined,
  sourceHandle: undefined,
  consoleSource: undefined,
  acquired: undefined,
  columnsState: undefined,
  sanitizedColumnPositions: [],
  fieldErrors: {},
  rejectionMessage: undefined,
  parseAlert: undefined,
  parsing: false,
  exchangeFiles: EXCHANGE_FILES_DEFAULT,
  connectionTuning: CONNECTION_TUNING_DEFAULT,
  runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
  receipts: RECEIPTS_DEFAULT,
  rendezvous: undefined,
  sftpInfo: undefined,
  manageOffer: MANAGE_OFFER_IDLE,
  launched: undefined,
};

/** Everything that moves the acceptor console. */
export type AcceptorScreenAction =
  /** The fragment held no invitation, or the one it held was refused. */
  | { type: "decode-refused"; message: Displayable }
  /** The invitation validated, with the rendezvous mount read beside it: the
   * review step decides a console filedrop accept's runnability from the mount,
   * so the two land together rather than flashing "unavailable" while a fetch
   * settles. */
  | {
      type: "invitation-decoded";
      invitation: AcceptableInvitation;
      rendezvous: JobRendezvousConfig;
    }
  /** The work column shows a step and, on the columns step, its sub-section. The
   * browser's own history push is the screen's. */
  | {
      type: "step-shown";
      step: AcceptorStep;
      columnsSection: AcceptorColumnsSection;
    }
  /** The consent attestation moved. */
  | { type: "consent-chosen"; consented: boolean }
  /** The name was typed, which also clears the refusal the last submit left on
   * that field: the two move together so the field cannot show a stale refusal
   * of a name the operator has already replaced. */
  | { type: "name-changed"; name: string }
  /** This party's duplicate-matching control moved. */
  | { type: "deduplicate-chosen"; deduplicate: boolean }
  /** A file was chosen from the dropzone: the prior read's refusals and stripped
   * positions go with it, since both describe a file this one replaces. */
  | { type: "file-selected"; file: File }
  /** The dropzone turned a file away over its size or type. */
  | { type: "file-rejected"; message: string }
  /** A read left a column with no name at all: refused, and the positions it
   * stripped are recorded anyway -- the same read changed them, and a refused
   * file never reaches the columns step where the notice is otherwise shown. */
  | {
      type: "unnameable-columns-refused";
      positions: Array<number>;
      alert: AlertContent;
    }
  /** The console committed a mounted file (the picker's "Use this file"). The
   * columns reseed unless this is a re-profile of the same file with the same
   * columns, which keeps the operator's remaps and cleaning edits. */
  | { type: "console-file-committed"; source: ProfiledJobInput }
  /** A submit slipped past the disabled consent gate and failed the handler
   * re-check. */
  | { type: "consent-refused"; errors: FieldErrors }
  /** The consent gate passed on the console, whose file is already profiled: the
   * acquired shape is built from that profile (no rows, no parse), and the name
   * and this party's duplicate-matching value are committed beside it. */
  | {
      type: "console-accept-committed";
      name: string;
      acquired: AcceptorAcquiredCsv;
    }
  /** The consent gate passed on the hosted build; the browser parse began. */
  | { type: "parse-started" }
  /** The parse settled into a file the columns step can edit, committing the
   * gate-checked name and this party's duplicate-matching value beside it. */
  | {
      type: "file-accepted";
      name: string;
      deduplicate: boolean;
      positions: Array<number>;
      file: File;
      handle?: FileSystemFileHandle;
      acquired: AcceptorAcquiredCsv;
    }
  /** The parse failed, and settled either way. A failure keeps every input: the
   * file handle, the name, and the consent all survive so the operator can retry
   * or swap files. */
  | { type: "parse-failed"; alert: AlertContent }
  | { type: "parse-finished" }
  /** A columns-step edit over the layered state: a metadata edit replaces the
   * metadata layer, a remap re-roles the chosen column for matching (forcing role
   * linkage, not a bare retype), a cleaning edit sets an override layer, and a
   * reset returns to the seed. */
  | { type: "metadata-changed"; metadata: Metadata }
  | { type: "column-remapped"; semanticType: SemanticType; column: string }
  | {
      type: "field-steps-changed";
      output: string;
      input: string;
      steps: Array<StandardizationStep>;
    }
  | { type: "field-input-changed"; output: string; column: string }
  | { type: "columns-reset" }
  /** The columns step launched the exchange. The cardinality comes from what the
   * consent gate committed, never from the control the operator may have moved
   * since. A re-launch reached by browser Back resets the offer rather than
   * opening under a refusal the operator has already acted on. */
  | { type: "exchange-launched"; edits: AcceptorDataEdits }
  /** The config-failure recovery discarded the launch, which aborts the run via
   * the hook's effect cleanup. */
  | { type: "launch-discarded" }
  /** The accepted SFTP endpoint became known, or the operator cleared the
   * connection they had authored: either way the card stands unauthored and
   * launch blocks. A prior in-app connection is NOT assumed valid for this
   * partner -- the operator authors fresh, pre-filled from this invitation's
   * locator. */
  | { type: "accept-sftp-endpoint-resolved" }
  | { type: "sftp-connection-cleared" }
  /** The operator authored an in-console connection to the partner's server: a
   * freshly authored server is a different rendezvous directory, so any sweep
   * confirmation is re-asked. */
  | { type: "sftp-connection-authored"; connection: SftpConnectionProjection }
  /** A per-run authoring draft was edited. */
  | { type: "exchange-files-chosen"; draft: ExchangeFilesDraft }
  | { type: "connection-tuning-chosen"; draft: ConnectionTuningDraft }
  | { type: "run-diagnostics-chosen"; draft: RunDiagnosticsDraft }
  | { type: "receipts-chosen"; draft: ReceiptsDraft }
  /** The managed-exchange deposit began, landed, or failed. */
  | { type: "manage-offer-started" }
  | { type: "manage-offer-deposited" }
  | { type: "manage-offer-failed"; refusal?: AlertContent };

/** Apply one action to the acceptor console's state. */
export function acceptorScreenReducer(
  state: AcceptorScreenState,
  action: AcceptorScreenAction,
): AcceptorScreenState {
  switch (action.type) {
    case "decode-refused":
      return { ...state, decode: { status: "error", message: action.message } };
    case "invitation-decoded":
      return {
        ...state,
        rendezvous: action.rendezvous,
        decode: { status: "ready", invitation: action.invitation },
      };
    case "step-shown":
      return {
        ...state,
        step: action.step,
        columnsSection: action.columnsSection,
      };
    case "consent-chosen":
      return { ...state, consented: action.consented };
    case "name-changed":
      return {
        ...state,
        acceptorName: action.name,
        ...(state.fieldErrors.name !== undefined
          ? { fieldErrors: { ...state.fieldErrors, name: undefined } }
          : {}),
      };
    case "deduplicate-chosen":
      return { ...state, acceptorDeduplicate: action.deduplicate };
    case "file-selected":
      return {
        ...state,
        rejectionMessage: undefined,
        parseAlert: undefined,
        sanitizedColumnPositions: [],
        fieldErrors: { ...state.fieldErrors, file: false },
        file: action.file,
      };
    case "file-rejected":
      return { ...state, rejectionMessage: action.message };
    case "unnameable-columns-refused":
      return {
        ...state,
        sanitizedColumnPositions: action.positions,
        parseAlert: action.alert,
      };
    case "console-file-committed": {
      const columnsUnchanged =
        state.consoleSource !== undefined &&
        state.consoleSource.name === action.source.name &&
        state.columnsState !== undefined &&
        state.consoleSource.columns.length === action.source.columns.length &&
        state.consoleSource.columns.every(
          (column, index) => column === action.source.columns[index],
        );
      return {
        ...state,
        sanitizedColumnPositions: action.source.sanitizedColumnPositions,
        parseAlert: undefined,
        fieldErrors: { ...state.fieldErrors, file: false },
        consoleSource: action.source,
        ...(columnsUnchanged
          ? {}
          : {
              columnsState: acceptorInitialColumnsState(action.source.columns),
            }),
      };
    }
    case "consent-refused":
      return { ...state, fieldErrors: action.errors };
    case "console-accept-committed":
      return {
        ...state,
        fieldErrors: {},
        committedName: action.name,
        committedDeduplicate: state.acceptorDeduplicate,
        acquired: action.acquired,
      };
    case "parse-started":
      return {
        ...state,
        fieldErrors: {},
        parsing: true,
        parseAlert: undefined,
      };
    case "file-accepted":
      return {
        ...state,
        sanitizedColumnPositions: action.positions,
        committedName: action.name,
        committedDeduplicate: action.deduplicate,
        acceptedFile: action.file,
        sourceHandle: action.handle,
        acquired: action.acquired,
        columnsState: acceptorInitialColumnsState(action.acquired.columns),
      };
    case "parse-failed":
      return { ...state, parseAlert: action.alert };
    case "parse-finished":
      return { ...state, parsing: false };
    case "metadata-changed":
      return state.columnsState === undefined
        ? state
        : {
            ...state,
            columnsState: {
              ...state.columnsState,
              metadata: action.metadata,
            },
          };
    case "column-remapped":
      return state.columnsState === undefined
        ? state
        : {
            ...state,
            columnsState: {
              ...state.columnsState,
              metadata: setColumnTypeForMatching(
                state.columnsState.metadata,
                action.column,
                action.semanticType,
              ),
            },
          };
    case "field-steps-changed":
      return state.columnsState === undefined
        ? state
        : {
            ...state,
            columnsState: {
              ...state.columnsState,
              stepOverrides: new Map<string, FieldStepOverride>(
                state.columnsState.stepOverrides,
              ).set(action.output, {
                input: action.input,
                steps: action.steps,
              }),
            },
          };
    case "field-input-changed":
      return state.columnsState === undefined
        ? state
        : {
            ...state,
            columnsState: {
              ...state.columnsState,
              inputOverrides: new Map<string, string>(
                state.columnsState.inputOverrides,
              ).set(action.output, action.column),
            },
          };
    case "columns-reset":
      return state.columnsState === undefined || state.acquired === undefined
        ? state
        : {
            ...state,
            columnsState: acceptorInitialColumnsState(state.acquired.columns),
          };
    case "exchange-launched":
      return {
        ...state,
        manageOffer: MANAGE_OFFER_IDLE,
        launched: {
          edits: action.edits,
          deduplicate: state.committedDeduplicate,
        },
      };
    case "launch-discarded":
      return { ...state, launched: undefined, manageOffer: MANAGE_OFFER_IDLE };
    case "accept-sftp-endpoint-resolved":
    case "sftp-connection-cleared":
      return { ...state, sftpInfo: { connection: null } };
    case "sftp-connection-authored":
      return {
        ...state,
        sftpInfo: { connection: action.connection },
        runDiagnostics: runDiagnosticsAfterRetarget(state.runDiagnostics),
      };
    case "exchange-files-chosen":
      return { ...state, exchangeFiles: action.draft };
    case "connection-tuning-chosen":
      return { ...state, connectionTuning: action.draft };
    case "run-diagnostics-chosen":
      return { ...state, runDiagnostics: action.draft };
    case "receipts-chosen":
      return { ...state, receipts: action.draft };
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
  }
}
