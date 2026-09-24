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
import {
  CanonicalEncodingError,
  DEFAULT_LINKAGE_RULE_SET,
  canonicalString,
  isDisclosedToPartner,
  partnerBoundTerms,
} from "@alcove/core";

import { OPT_IN_TOKEN_MAX_AGE_DAYS } from "@psi/tokenMaxAge";
import { OWN_COLUMNS_DEFAULT } from "@psi/ownColumnsModel";
import { buildAdvancedTerms } from "@psi/authoring/advancedInviteTerms";

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

import { EMPTY_SFTP_FORM, hostKeyFingerprintField } from "./sftpConnectionForm";
import { CONNECTION_TUNING_DEFAULT } from "./connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "./exchangeFilesModel";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type {
  ColumnMetadata,
  LinkageField,
  LinkageTerms,
  Metadata,
  OutboundPayloadConsent,
  Standardization,
} from "@alcove/core";
import type {
  DisclosedExchangeDocument,
  DisclosedFileSyncOptions,
  DisclosedSftpServer,
} from "@jobs/configLoad";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { DisclosureChoice } from "@psi/metadataEditing";
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
  /** Whether the file states `authentication.token_max_age_days`. */
  maxAgeEnabled: boolean;
  /** The day count it states, or the control's own starting value where it
   * states none. */
  maxAgeDays: number;
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
  /** The channel the file states, a webrtc one included: the console opens it
   * for editing and withholds its run. */
  channel: DisclosedExchangeDocument["channel"];
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
 * A fingerprint stated as a rotation list pre-fills every entry.
 */
export function sftpFormFromServerBlock(
  server: DisclosedSftpServer,
): SftpConnectionFormValues {
  return {
    ...EMPTY_SFTP_FORM,
    host: server.host,
    port: server.port === undefined ? "" : String(server.port),
    username: server.username ?? "",
    remoteDirectory: server.path ?? server.inboundPath ?? "",
    outboundDirectory: server.outboundPath ?? "",
    hostKeyFingerprint: hostKeyFingerprintField(server.hostKeyFingerprint),
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
      maxAgeEnabled: document.tokenMaxAgeDays !== undefined,
      maxAgeDays: document.tokenMaxAgeDays ?? OPT_IN_TOKEN_MAX_AGE_DAYS,
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

/** The constraints the editor writes for a field of `type`: the type's default
 * field's own, or none for a type with no default field. */
function editorConstraintsFor(
  type: LinkageField["type"],
): LinkageField["constraints"] {
  return DEFAULT_LINKAGE_RULE_SET.linkageFields.find(
    (field) => field.type === type,
  )?.constraints;
}

/** Whether a field states constraints of its own: ones that are neither empty
 * nor the ones the editor writes for the field's type. An empty or absent set
 * states no constraint to name. */
function statesOwnConstraints(field: LinkageField): boolean {
  if (
    field.constraints === undefined ||
    Object.keys(field.constraints).length === 0
  )
    return false;
  return (
    canonicalString(field.constraints) !==
    canonicalString(editorConstraintsFor(field.type) ?? null)
  );
}

/**
 * The linkage-terms settings a loaded document states that no control here
 * edits, named as the file spells them, for the carry-through notice. Each is
 * held on the draft ({@link editorWithLoadedTerms}) and stated by the run and
 * the hand-back as the file states it. A field's constraints are named only
 * where they state something other than what the editor itself writes for that
 * field's type ({@link statesOwnConstraints}).
 */
export function termsSettingsWithNoControl(terms: LinkageTerms): Array<string> {
  const ownConstraints = terms.linkageFields.some(statesOwnConstraints);
  return [
    ...(ownConstraints ? [HELD_TERMS_SETTINGS.constraints] : []),
    ...(terms.payload?.send?.some((column) => column.description !== undefined)
      ? [HELD_TERMS_SETTINGS.description]
      : []),
    ...(terms.payload?.receive !== undefined
      ? [HELD_TERMS_SETTINGS.receive]
      : []),
  ];
}

/** The settings {@link termsSettingsWithNoControl} names that the terms
 * `editor`'s draft builds still state: none of the held ones once a terms
 * import replaces the terms a load held, and no receive list once this party
 * takes no result. */
export function termsSettingsStatedBy(editor: InviterEditor): Array<string> {
  return termsSettingsWithNoControl(buildAdvancedTerms(editor.draft));
}

/** The part of the terms `editor`'s draft builds that the partner refuses an
 * exchange over when its copy differs (`partnerBoundTerms`), in the canonical
 * form two builds are compared in ({@link termsEditedSinceOpened}). Undefined
 * for a draft whose terms the encoding refuses, which the editor reports as a
 * problem of its own. */
export function canonicalPartnerBoundTerms(
  editor: InviterEditor,
): string | undefined {
  try {
    return canonicalString(partnerBoundTerms(buildAdvancedTerms(editor.draft)));
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return undefined;
    throw err;
  }
}

/** Whether the terms `editor`'s draft builds differ from `baseline`, the terms
 * the opened configuration built the moment they reached the input file, in a
 * field the partner refuses an exchange over, which the party's own name is
 * not. A change undone is no change, since the terms are compared rather than
 * the edits. A baseline the encoding refused compares as unchanged: there is no
 * opened state to hold the draft against. */
export function termsEditedSinceOpened(
  baseline: string | undefined,
  editor: InviterEditor,
): boolean {
  if (baseline === undefined) return false;
  return canonicalPartnerBoundTerms(editor) !== baseline;
}

/** The names {@link termsSettingsWithNoControl} gives, as the file spells
 * them. */
export const HELD_TERMS_SETTINGS = {
  constraints: "linkage_terms.linkage_fields.constraints",
  description: "linkage_terms.payload.send.description",
  receive: "linkage_terms.payload.receive",
} as const;

/** The parts of a loaded document the invitation editor takes once the input
 * file is read: the matching terms, and the column roles and cleaning pipeline
 * the document states for this party's own columns. */
export interface LoadedEditorTerms {
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
}

/** One column's description as the document states it, over the set the merge
 * is building. The document states the column set whole, so a column it
 * describes takes that description and one it leaves undescribed keeps none. */
function withColumnDescription(
  metadata: Metadata,
  name: string,
  description: string | undefined,
): Metadata {
  return metadata.map((column) => {
    if (column.name !== name) return column;
    if (description === undefined) {
      const without = { ...column };
      delete without.description;
      return without;
    }
    return { ...column, description };
  });
}

/**
 * The disclosure choice a loaded column takes, read from what core transmits it
 * as ({@link isDisclosedToPartner}) rather than from its `role` alone, so the
 * merged draft sends exactly the columns the document sends.
 *
 * The columns step holds `role` and `isPayload` as one collapsed choice, so a
 * pair core admits off that diagonal has no choice of its own: a `role: payload`
 * column with `is_payload: false` sends nothing and takes `ignored`, while a
 * `role: linkage` or `role: identifier` column with `is_payload: true` does
 * send, so it takes `payload` and loses its matching or identifier half. Each
 * such pair is reported by the merge rather than passed over as applied.
 */
function loadedDisclosureOf(column: ColumnMetadata): DisclosureChoice {
  if (isDisclosedToPartner(column)) return "payload";
  return column.role === "payload" ? "ignored" : disclosureOf(column);
}

/**
 * The column set the import binds against: the operator's own inferred columns
 * with each role, type, and description the document states for a column of
 * that name put back, through the same editing helpers the columns step uses,
 * so the single-identifier rule holds exactly as it does for a hand edit. A
 * column the document names that this file does not have leaves the whole
 * setting unapplied, since nothing in the editor can hold it.
 *
 * A document stating `metadata` states the column set whole, as the command
 * line reads it (`resolveExchangeInputs` takes the config's metadata in place of
 * inference, never beside it), so a file column the document does not name is
 * held back at `ignored` rather than keeping inference's disclosed default.
 * `covered` reports whether the document's set reached every column the file
 * has, for the notice beside the load control.
 *
 * What the merge lands on is read back against the `role` and `is_payload` the
 * document states for each column, so a pair the columns step cannot hold --
 * the off-diagonal ones {@link loadedDisclosureOf} collapses, and a column the
 * single-identifier rule demoted, a document naming two identifier columns
 * keeping the last one and sending the other to `ignored` -- counts as a
 * setting this file could not take whole, rather than a silent divergence
 * between the run and the file it was opened from.
 */
function metadataWithLoadedColumns(
  inferred: Metadata,
  loaded: Metadata | undefined,
): { metadata: Metadata; whole: boolean; covered: boolean } {
  if (loaded === undefined)
    return { metadata: inferred, whole: true, covered: true };
  let metadata = inferred;
  for (const column of loaded) {
    if (!metadata.some((own) => own.name === column.name)) continue;
    metadata = setColumnType(metadata, column.name, column.type).metadata;
    metadata = setColumnDisclosure(
      metadata,
      column.name,
      loadedDisclosureOf(column),
    ).metadata;
    metadata = withColumnDescription(metadata, column.name, column.description);
  }
  const stated = new Set(loaded.map((column) => column.name));
  const unstated = inferred
    .filter((own) => !stated.has(own.name))
    .map((own) => own.name);
  for (const name of unstated) {
    metadata = setColumnDisclosure(metadata, name, "ignored").metadata;
  }
  const whole = loaded.every((column) => {
    const own = metadata.find((merged) => merged.name === column.name);
    return (
      own !== undefined &&
      own.role === column.role &&
      own.isPayload === column.isPayload
    );
  });
  return { metadata, whole, covered: unstated.length === 0 };
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
 * could not be placed, leaves that setting named there. `notCovered` names the
 * other direction, the file holding columns the document's own set does not
 * state, each of which is held back rather than disclosed.
 *
 * A document stating no `metadata` has no column roles to put back, so the
 * import binds against the roles the draft already holds, the operator's own
 * edits included.
 *
 * The terms settings no control here edits -- each field's own constraints, a
 * sent column's description, the columns expected back -- are held on the draft
 * as the document states them, so the built terms state them unchanged; the
 * notice beside the load names them ({@link termsSettingsWithNoControl}).
 */
export function editorWithLoadedTerms(
  editor: InviterEditor,
  csv: AcquiredCsv,
  loaded: LoadedEditorTerms,
): {
  editor: InviterEditor;
  notApplied: Array<string>;
  notCovered: Array<string>;
} {
  if (editor.sealed === true) return { editor, notApplied: [], notCovered: [] };
  const columns = metadataWithLoadedColumns(
    loaded.metadata === undefined
      ? editor.draft.metadata
      : editor.seed.metadata,
    loaded.metadata,
  );
  const imported = editorWithImportedTerms(
    editor,
    csv,
    loaded.linkageTerms,
    columns.metadata,
  );
  const { payload } = loaded.linkageTerms;
  let next: InviterEditor = {
    ...imported,
    draft: {
      ...imported.draft,
      heldTermsSettings: payload === undefined ? {} : { payload },
    },
  };
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
    notCovered: columns.covered ? [] : ["metadata"],
  };
}
