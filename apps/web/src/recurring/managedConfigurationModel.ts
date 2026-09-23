/**
 * The pure model behind a configuration-only exchange's surface and its row in
 * the list: what the operator is told about an exchange this browser holds the
 * settings of and does not run. No React and no store -- every line is derived
 * from the stored record, so it is shown where the import lands and on every
 * later visit alike.
 *
 * Four things are said, each only where it holds:
 *
 * - why nothing here runs it: the channel, where the document names one this
 *   app does not conduct, or else the key file that stayed on the command line;
 * - which settings the document states that this surface keeps unchanged
 *   without showing or editing them (docs/spec/EXCHANGE_FILE.md, "What a
 *   consumer does with a setting it cannot honor");
 * - which settings name a file by `@path`, which this browser does not read
 *   and psilink reads on the machine that runs the exported file;
 * - that the outbound payload consent it states is pending, which the command
 *   line meets at the first run that shares results with the partner.
 *
 * Every notice names a setting as the file spells it, in snake_case, and never
 * its value.
 */

import { snakeizeKey } from "@psilink/core";

import {
  connectionSettingsBeyondLocator,
  fileReferenceFields,
} from "@psi/managed/managedCommandLineDocument";
import { channelThisAppDoesNotRun } from "@psi/managed/managedExchangeRecord";

import type {
  ManagedElsewhereChannel,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

/** How the operator is told which channel a configuration runs over: the plain
 * name, then the `channel` value as the file spells it. */
const ELSEWHERE_CHANNEL_NAMES: Record<ManagedElsewhereChannel, string> = {
  sftp: "SFTP (channel: sftp)",
  filedrop: "a shared folder (channel: filedrop)",
};

/** What the list names a configuration by in place of a side, where its channel
 * has none. */
const ELSEWHERE_CHANNEL_ROW_LABELS: Record<ManagedElsewhereChannel, string> = {
  sftp: "SFTP exchange",
  filedrop: "Shared-folder exchange",
};

/** What a configuration-only exchange on this app's own channel leads with: the
 * absent key file is the whole reason it does not run here. */
const KEY_FILE_ELSEWHERE_LEAD =
  "This exchange was imported from a command-line configuration, without the " +
  ".psilink.key file it runs under. Its settings are editable here and export " +
  "back to a psilink.yaml you run with psilink; it does not run in this " +
  "browser.";

/** The list row's status for a configuration-only exchange on this app's own
 * channel. */
const KEY_FILE_ELSEWHERE_STATUS =
  "Configuration only - edit it here, run it with psilink";

/** The list row's status for a configuration on a channel this app does not
 * run. */
const CHANNEL_ELSEWHERE_STATUS =
  "Configuration only - this app cannot run it, run it with psilink";

/** The document settings the configuration surface shows: the connection and
 * the terms read-only, and the three this party's settings editor edits. Every
 * other setting the document states is held without being shown. */
const SHOWN_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
  "connection",
  "linkageTerms",
  "includeOwnColumns",
  "csvDelimiter",
  "retentionDisposition",
]);

/**
 * What a configuration-only surface leads with: why this browser does not run
 * the exchange, and where it does run. A channel this app does not conduct is
 * named first, since a key file would not change it; on this app's own channel
 * the reason is the key file that stayed with the command line.
 */
export function configurationOnlyLead(record: ManagedExchangeRecord): string {
  const channel = channelThisAppDoesNotRun(record.exchangeFile);
  if (channel === undefined) return KEY_FILE_ELSEWHERE_LEAD;
  return (
    `This configuration runs over ${ELSEWHERE_CHANNEL_NAMES[channel]}. This ` +
    "app runs only live exchanges in the browser (channel: webrtc), so it " +
    "cannot run this one: run it with psilink on the command line. Its " +
    "settings are editable here, and the psilink.yaml you download below is " +
    "the file to run."
  );
}

/** The list row's one-line status for a configuration-only exchange. */
export function configurationOnlyStatus(record: ManagedExchangeRecord): string {
  return channelThisAppDoesNotRun(record.exchangeFile) === undefined
    ? KEY_FILE_ELSEWHERE_STATUS
    : CHANNEL_ELSEWHERE_STATUS;
}

/** What the list names a sideless configuration by: the channel this app does
 * not run, where the record holds no side for the list to name. */
export function sidelessRowLabel(
  elsewhereChannel: ManagedElsewhereChannel | undefined,
): string {
  return elsewhereChannel === undefined
    ? ""
    : ELSEWHERE_CHANNEL_ROW_LABELS[elsewhereChannel];
}

/**
 * The settings a stored document states that the configuration view neither
 * shows nor edits, named in snake_case and sorted: every top-level setting but
 * the connection, the linkage terms, and the three the settings editor edits,
 * the connection's `options` block, and
 * every connection setting beyond the channel's locator, none of which the
 * connection rows show. Each is written back to the configuration the surface
 * exports exactly as it was read.
 */
export function heldSettings(record: ManagedExchangeRecord): Array<string> {
  const { exchangeFile } = record;
  const topLevel = Object.keys(exchangeFile)
    .filter((field) => !SHOWN_DOCUMENT_FIELDS.has(field))
    .map((field) => snakeizeKey(field));
  const connectionOptions =
    "options" in exchangeFile.connection &&
    exchangeFile.connection.options !== undefined
      ? ["connection.options"]
      : [];
  return [
    ...topLevel,
    ...connectionOptions,
    ...connectionSettingsBeyondLocator(exchangeFile.connection),
  ].sort();
}

/** What the operator is told about the settings {@link heldSettings} names, or
 * undefined where the document states none. */
export function heldSettingsNotice(
  record: ManagedExchangeRecord,
): string | undefined {
  const fields = heldSettings(record);
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "This configuration states " +
    (one ? "a setting" : "settings") +
    " this app keeps unchanged but does not show or edit: " +
    fields.join(", ") +
    ". The psilink.yaml you download states " +
    (one ? "it" : "each") +
    " as your file does; edit " +
    (one ? "it" : "them") +
    " in that file."
  );
}

/**
 * What the operator is told where the document names a file by `@path`, or
 * undefined where it names none: this browser never opens the file, and the
 * exported configuration keeps the reference for psilink to read on the
 * machine that runs it.
 */
export function fileReferenceNotice(
  record: ManagedExchangeRecord,
): string | undefined {
  const fields = fileReferenceFields(record.exchangeFile.connection);
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "This configuration names " +
    (one ? "a file" : "files") +
    " with @ and a path: " +
    fields.join(", ") +
    ". This browser does not open " +
    (one ? "it" : "them") +
    ". The psilink.yaml you download keeps each reference as your file wrote " +
    "it, and psilink reads the file it names on the machine that runs the " +
    "exchange, so check that each path is right there before you run it."
  );
}

/**
 * What the export panel says about the settings {@link fileReferenceNotice}
 * names, or undefined where the document names no file by `@path`.
 */
export function fileReferenceExportNote(
  record: ManagedExchangeRecord,
): string | undefined {
  const fields = fileReferenceFields(record.exchangeFile.connection);
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  return (
    "The file keeps " +
    fields.join(", ") +
    " as " +
    (one ? "an @ reference" : "@ references") +
    ", and psilink reads the file " +
    (one ? "it names" : "each names") +
    " on the machine that runs it."
  );
}

/**
 * What the export tells the operator an SFTP configuration still needs before
 * psilink runs it, or undefined where it names both a credential and a host
 * key, and on any other channel.
 */
export function sftpCredentialNote(
  record: ManagedExchangeRecord,
): string | undefined {
  const { connection } = record.exchangeFile;
  if (connection.channel !== "sftp") return undefined;
  const { server } = connection;
  const noCredential =
    server.password === undefined && server.privateKey === undefined;
  const noHostKey = server.hostKeyFingerprint === undefined;
  if (!noCredential && !noHostKey) return undefined;
  const credentialLine =
    "private_key or password under connection.server -- written as @ and " +
    "the path of the file that holds it";
  const hostKeyLine = "the server's host_key_fingerprint";
  if (noCredential && noHostKey)
    return (
      "This configuration names no SFTP credential and no host key. Before " +
      `you run it, add ${credentialLine} -- and ${hostKeyLine}.`
    );
  if (noCredential)
    return (
      "This configuration names no SFTP credential. Before you run it, add " +
      `${credentialLine}.`
    );
  return (
    "This configuration names no SFTP host key. Before you run it, add " +
    `${hostKeyLine} under connection.server.`
  );
}

/**
 * What the operator is told about an `outbound_payload_consent` the document
 * states as pending, or undefined where it states none or a confirmed set. psilink
 * asks for the confirmation at the first run that shares results with the
 * partner and refuses such a run with no terminal to ask on, so a scheduled run
 * is refused until the operator has confirmed the columns once at a terminal.
 */
export function pendingOutboundConsentNotice(
  record: ManagedExchangeRecord,
): string | undefined {
  if (record.exchangeFile.outboundPayloadConsent?.status !== "pending")
    return undefined;
  return (
    "This configuration's outbound_payload_consent is pending. A psilink run " +
    "that shares results with your partner stops to ask you to confirm the " +
    "columns it sends, and is refused when no one is at a terminal to answer, " +
    "so run it once with psilink at a terminal before you schedule it."
  );
}
