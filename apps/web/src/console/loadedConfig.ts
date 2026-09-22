/**
 * Turning the configuration `GET /api/jobs/config` read off the mount into the
 * console's own authoring state: the form values, card drafts, and intent
 * fields each authoring step starts from.
 *
 * Pure, and the inverse of the composition each model already owns. A setting
 * the file leaves unset takes that model's own default constant rather than a
 * value restated here, so a loaded configuration and an untouched form start
 * the same run.
 *
 * The SFTP credential and its passphrase are the one thing the connection form
 * does not start pre-filled: neither value leaves the server, so the operator
 * picks or types the file again. The METHOD the configuration states is adopted,
 * so the form opens on the right one. Which settings a load did not adopt, and
 * which it holds without an editor, are the load's own answers
 * (`credentialFieldsNotAdopted` and `carriedThroughFields`, `@jobs/configLoad`),
 * since the values that decide them stay server-side.
 *
 * The linkage terms, the column roles, and the cleaning pipeline reach the
 * invitation editor together, through `editorWithLoadedTerms`, which needs the
 * operator's own CSV: the import rebuilds each field's binding against their
 * columns. That is a sequencing constraint, not a mapping one -- the three are
 * held until the input step has a file. What their own file cannot supply comes
 * back by name for the notice beside the load control.
 */

import {
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  INITIAL_CSV_DELIMITER_CHOICE,
} from "@components/csvDelimiterChoice";
import { OWN_COLUMNS_DEFAULT } from "@psi/ownColumnsModel";

import {
  disclosureOf,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";
import {
  editorWithFieldInput,
  editorWithFieldSteps,
  editorWithImportedTerms,
} from "@psi/inviterEditor";

import { CONNECTION_TUNING_DEFAULT } from "./connectionTuningModel";
import { EMPTY_SFTP_FORM } from "./sftpConnectionForm";
import { EXCHANGE_FILES_DEFAULT } from "./exchangeFilesModel";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type {
  DisclosedExchangeDocument,
  DisclosedFileSyncOptions,
  DisclosedSftpServer,
} from "@jobs/configLoad";
import type {
  LinkageTerms,
  Metadata,
  OutboundPayloadConsent,
  Standardization,
} from "@psilink/core";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";
import type { ReceiptsSigningMode } from "@psi/receiptsModel";

import type {
  ConnectionTuningDraft,
  DurationField,
  DurationUnit,
} from "./connectionTuningModel";
import type { ExchangeFilesDraft, FileSyncToggle } from "./exchangeFilesModel";
import type { SftpConnectionFormValues } from "./sftpConnectionForm";

/**
 * The receipt and record-keeping settings a loaded configuration supplies. The
 * rest of `ReceiptsDraft` is run state the console reads from its own signing
 * identity, never from the file.
 *
 * `mode` is the mode the file states, `session-derived` included: the card
 * offers that one disabled, so a configuration naming it shows what it names and
 * blocks the run, rather than reopening as an unsigned exchange.
 */
export interface LoadedReceiptsChoices {
  mode: ReceiptsSigningMode;
  partnerFingerprint: string;
  retentionDisposition: string;
}

/** The enforcement records a loaded configuration puts back on the job intent,
 * so a run composed here states what the file it came from stated
 * (docs/spec/EXCHANGE_FILE.md, "The records that must survive", and "The
 * acceptor's outbound consent" for the consent record). None has an editor on
 * the console: each is held as the file states it and composed back unchanged,
 * since an absent one turns its own enforcement off. */
export interface LoadedEnforcementRecords {
  expectedPayloadColumns?: Array<string>;
  expectedPartnerDeduplicate?: boolean;
  disclosedPayloadColumns?: Array<string>;
  outboundPayloadConsent?: OutboundPayloadConsent;
}

/** Everything a loaded configuration puts into the console's authoring state. */
export interface LoadedAuthoringState {
  channel: "sftp" | "filedrop";
  /** The connection form, pre-filled except for the credential. Absent for a
   * filedrop configuration, which names no host. */
  sftpForm?: SftpConnectionFormValues;
  connectionTuning: ConnectionTuningDraft;
  exchangeFiles: ExchangeFilesDraft;
  csvDelimiter: CsvDelimiterChoice;
  ownColumns: OwnColumnsChoice;
  receipts: LoadedReceiptsChoices;
  records: LoadedEnforcementRecords;
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
}

/** The unit a duration reads naturally in, coarsest first, so a value the file
 * states in whole minutes opens the field in minutes rather than as a
 * six-figure millisecond count. */
const COARSEST_FIRST: ReadonlyArray<DurationUnit> = ["h", "m", "s", "ms"];

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** One duration field from the milliseconds the file states, or the card's own
 * starting field when the file states none. */
function durationField(
  ms: number | undefined,
  unset: DurationField,
): DurationField {
  if (ms === undefined) return unset;
  const unit =
    COARSEST_FIRST.find((candidate) =>
      Number.isInteger(ms / UNIT_MS[candidate]),
    ) ?? "ms";
  return { magnitude: String(ms / UNIT_MS[unit]), unit };
}

/** One file-sync toggle from the boolean the file states: `auto` where it
 * states none, so the card leaves the key off and core's own default applies. */
function fileSyncToggle(stated: boolean | undefined): FileSyncToggle {
  if (stated === undefined) return "auto";
  return stated ? "on" : "off";
}

/**
 * The connection-tuning card's draft: the inverse of `connectionTuningOptions`.
 * An unset key takes {@link CONNECTION_TUNING_DEFAULT}'s own field, so a
 * configuration stating nothing opens the card exactly as a fresh one does.
 */
export function connectionTuningFromOptions(
  options: DisclosedFileSyncOptions | undefined,
): ConnectionTuningDraft {
  const stated = options ?? {};
  return {
    pollInterval: durationField(
      stated.pollIntervalMs,
      CONNECTION_TUNING_DEFAULT.pollInterval,
    ),
    peerTimeout: durationField(
      stated.peerTimeoutMs,
      CONNECTION_TUNING_DEFAULT.peerTimeout,
    ),
    serverConnectTimeout: durationField(
      stated.serverConnectTimeoutMs,
      CONNECTION_TUNING_DEFAULT.serverConnectTimeout,
    ),
    maxReconnectAttempts:
      stated.maxReconnectAttempts === undefined
        ? CONNECTION_TUNING_DEFAULT.maxReconnectAttempts
        : String(stated.maxReconnectAttempts),
    connectionPerPoll:
      stated.connectionPerPoll ?? CONNECTION_TUNING_DEFAULT.connectionPerPoll,
  };
}

/**
 * The file-handling card's draft: the inverse of `exchangeFilesOptions`. Retain
 * mode's two implications are read as the file states them rather than
 * re-derived, so a document written with all three reopens with all three and
 * one written with retain alone reopens the same way.
 */
export function exchangeFilesFromOptions(
  options: DisclosedFileSyncOptions | undefined,
): ExchangeFilesDraft {
  const stated = options ?? {};
  return {
    retainFiles: stated.retainFiles ?? EXCHANGE_FILES_DEFAULT.retainFiles,
    timestampInFilename: fileSyncToggle(stated.timestampInFilename),
    locklessRendezvous: fileSyncToggle(stated.locklessRendezvous),
    peerId: stated.peerId ?? EXCHANGE_FILES_DEFAULT.peerId,
    unexpectedFiles:
      stated.unexpectedFiles ?? EXCHANGE_FILES_DEFAULT.unexpectedFiles,
  };
}

/**
 * Seed the SFTP connection form from a loaded `connection.server` block, beside
 * {@link sftpFormFromLocator}'s partner-supplied case. The credential and its
 * passphrase stay EMPTY: neither value leaves the server, so the operator picks
 * or types the file again. Everything the form edits and the block states is
 * pre-filled, the host-key fingerprint included -- the console owns this mount,
 * and the fingerprint is the operator's own pin rather than a partner's claim.
 *
 * A fingerprint stated as a rotation LIST pre-fills the first entry: the form
 * holds one value, and the operator's own file still holds the rest until they
 * author the connection again.
 */
export function sftpFormFromServerBlock(
  server: DisclosedSftpServer,
): SftpConnectionFormValues {
  const fingerprint = server.hostKeyFingerprint;
  return {
    ...EMPTY_SFTP_FORM,
    host: server.host,
    port: server.port === undefined ? "" : String(server.port),
    username: server.username ?? "",
    remoteDirectory: server.path ?? server.inboundPath ?? "",
    outboundDirectory: server.outboundPath ?? "",
    hostKeyFingerprint: Array.isArray(fingerprint)
      ? (fingerprint[0] ?? "")
      : (fingerprint ?? ""),
    method:
      server.credentialMethod === "private_key" ? "private_key" : "password",
    keyboardInteractive: server.keyboardInteractive ?? false,
  };
}

/** The delimiter control's state for the delimiter the file states: a named
 * option where the value is one, else the free-text field holding it. */
export function csvDelimiterFromDocument(
  stated: string | undefined,
): CsvDelimiterChoice {
  if (stated === undefined) return INITIAL_CSV_DELIMITER_CHOICE;
  const named = CSV_DELIMITER_OPTIONS.some((option) => option.value === stated);
  return named
    ? { option: stated, other: "" }
    : { option: CSV_DELIMITER_OTHER, other: stated };
}

/**
 * The console's authoring state for a loaded configuration. Every card starts
 * from its own model's inverse, so the one place a default is written is that
 * model's exported constant.
 */
export function authoringStateFromDocument(
  document: DisclosedExchangeDocument,
): LoadedAuthoringState {
  return {
    channel: document.channel,
    ...(document.server !== undefined
      ? { sftpForm: sftpFormFromServerBlock(document.server) }
      : {}),
    connectionTuning: connectionTuningFromOptions(document.options),
    exchangeFiles: exchangeFilesFromOptions(document.options),
    csvDelimiter: csvDelimiterFromDocument(document.csvDelimiter),
    ownColumns: document.includeOwnColumns ?? OWN_COLUMNS_DEFAULT,
    receipts: {
      mode: document.signing?.mode ?? "none",
      partnerFingerprint: document.signing?.partnerFingerprint ?? "",
      retentionDisposition: document.retentionDisposition ?? "",
    },
    records: {
      ...(document.expectedPayloadColumns !== undefined
        ? { expectedPayloadColumns: document.expectedPayloadColumns }
        : {}),
      ...(document.expectedPartnerDeduplicate !== undefined
        ? { expectedPartnerDeduplicate: document.expectedPartnerDeduplicate }
        : {}),
      ...(document.disclosedPayloadColumns !== undefined
        ? { disclosedPayloadColumns: document.disclosedPayloadColumns }
        : {}),
      ...(document.outboundPayloadConsent !== undefined
        ? { outboundPayloadConsent: document.outboundPayloadConsent }
        : {}),
    },
    linkageTerms: document.linkageTerms,
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
    ...(document.standardization !== undefined
      ? { standardization: document.standardization }
      : {}),
  };
}

/** The parts of a loaded document the invitation editor takes once the input
 * file is read: the matching terms, and the column roles and cleaning pipeline
 * the document states for this party's own columns. */
export interface LoadedEditorTerms {
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
}

/**
 * The column set the import binds against: the operator's own inferred columns
 * with each role and type the document states for a column of that name put
 * back, through the same editing helpers the columns step uses, so the
 * single-identifier rule holds exactly as it does for a hand edit. A column the
 * document names that this file does not have leaves the whole setting
 * unapplied, since nothing in the editor can hold it.
 */
function metadataWithLoadedColumns(
  inferred: Metadata,
  loaded: Metadata | undefined,
): { metadata: Metadata; whole: boolean } {
  let metadata = inferred;
  let whole = true;
  for (const column of loaded ?? []) {
    if (!metadata.some((own) => own.name === column.name)) {
      whole = false;
      continue;
    }
    metadata = setColumnType(metadata, column.name, column.type).metadata;
    metadata = setColumnDisclosure(
      metadata,
      column.name,
      disclosureOf(column),
    ).metadata;
  }
  return { metadata, whole };
}

/**
 * Put a loaded configuration's terms, columns, and cleaning into the editor,
 * against the file the operator read: the import rebuilds every binding over
 * their own columns ({@link editorWithImportedTerms}), so nothing here can run
 * before a file is read.
 *
 * The document's own cleaning is adopted per field, over the binding the import
 * reconstructed, for a field the import declared whose input the document binds
 * to a `role: linkage` column -- the rule the import's own reconstruction binds
 * by, so a configuration cannot clean a column into a matching key that this
 * party's roles do not offer for matching.
 *
 * A setting the operator's file cannot supply whole is named rather than
 * dropped, as the file spells it, for the notice beside the load control: a
 * document column the file does not have, or a cleaned field whose binding
 * could not be placed, leaves that setting named there.
 */
export function editorWithLoadedTerms(
  editor: InviterEditor,
  csv: AcquiredCsv,
  loaded: LoadedEditorTerms,
): { editor: InviterEditor; notApplied: Array<string> } {
  if (editor.sealed === true) return { editor, notApplied: [] };
  const columns = metadataWithLoadedColumns(
    editor.seed.metadata,
    loaded.metadata,
  );
  let next = editorWithImportedTerms(
    editor,
    csv,
    loaded.linkageTerms,
    columns.metadata,
  );
  let cleaningWhole = true;
  for (const transformation of loaded.standardization ?? []) {
    const declared = next.draft.standardization.some(
      (declaration) => declaration.output === transformation.output,
    );
    const bindable = columns.metadata.some(
      (column) =>
        column.name === transformation.input && column.role === "linkage",
    );
    if (!declared || !bindable) {
      cleaningWhole = false;
      continue;
    }
    next = editorWithFieldSteps(
      editorWithFieldInput(next, transformation.output, transformation.input),
      transformation.output,
      transformation.steps,
    );
  }
  return {
    editor: next,
    notApplied: [
      ...(columns.whole ? [] : ["metadata"]),
      ...(cleaningWhole ? [] : ["standardization"]),
    ],
  };
}
