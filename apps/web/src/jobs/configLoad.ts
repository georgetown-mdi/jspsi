/**
 * Reading the command-line `psilink.yaml` the operator mounted into the
 * console's working directory, so the authoring forms start from the
 * configuration they already run rather than from an empty form.
 *
 * The file is read server-side and never handed to the browser whole. What the
 * response holds is an explicitly mapped projection of the settings the
 * authoring forms edit: the browser needs a host to show in a field, not the
 * `@path` whose value is a credential, and not the container path the console
 * keeps on this side of the API throughout (docs/spec/SERVER_JOB_API.md).
 *
 * The refusals, each naming the setting as the FILE spells it
 * ({@link ../psi/exchangeDocumentRefusal}):
 *
 * - a document the shared exchange-file schema rejects, an unread key included
 *   (docs/spec/EXCHANGE_FILE.md, "What a consumer does with a setting it cannot
 *   honor");
 * - a `connection` on a channel outside {@link OPENED_CHANNELS};
 * - an `authentication` block holding a shared secret or an expiry, which
 *   belong in the key file rather than the document, and which the console
 *   replaces with a new secret for each invitation it creates;
 * - one of the records whose absence turns an enforcement off that a run
 *   composed here could not state back ({@link assertRecordsSurvive});
 * - a setting inside a block the composition writes, which the export could not
 *   write back unchanged ({@link assertHeldSettingsSurvive}).
 *
 * A configuration on a channel the console opens but does not conduct -- webrtc
 * -- is not refused here: the browser edits its settings and withholds the
 * run, and the edits are saved back into the file ({@link ./configHandBack}).
 * Its `connection` is neither disclosed nor measured, since no run here
 * composes or replaces it.
 *
 * A `@path` credential reference is a WARNING and not a refusal: the operator
 * owns this mount and the reference is their own choice, so the load proceeds
 * and the response names the field whose credential the console cannot pre-fill
 * ({@link credentialFieldsNotAdopted}).
 *
 * Nothing the console cannot edit is dropped. {@link carriedThroughFields}
 * measures which of the document's settings a run composed here does not write,
 * by composing probes and diffing key paths against them rather than restating a
 * list, and the response names them so the operator knows which settings this
 * surface holds without an editor -- the settings the export writes back from
 * the document it opened, the last refusal above holding the list to those.
 */

import fs from "node:fs";

import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
  safeParseExchangeSpec,
  snakeizeKey,
} from "@psilink/core";

import {
  namedFieldList,
  refusedDocumentFields,
} from "@psi/exchangeDocumentRefusal";

import { JOB_FILE_NAMES, isJobChannel } from "./intentSchemas";

import { composeConfigDocument, composeSftpConfigSpec } from "./intentConfig";
import { resolveWorkdirFile } from "./workdir";

import type {
  ExchangeSpec,
  FileSyncOptions,
  SigningConfig,
} from "@psilink/core";
import type {
  JobExchangeIntentBase,
  JobFiledropExchangeIntent,
  JobSftpExchangeIntent,
} from "./intentSchemas";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * Upper bound, in bytes, on the configuration file this load will read, applied
 * before the bounded parse. The same cap the browser's own configuration import
 * takes ({@link ../psi/managed/managedCommandLineImport}): both are small
 * operator-held documents.
 */
const MAX_CONFIGURATION_FILE_BYTES = 1_000_000;

/**
 * Raised when the mounted file is not a configuration the console can open. Its
 * message reaches the operator, so it states what the file holds and what to do
 * about it, naming FIELD NAMES only -- a setting's value can be a credential.
 */
export class ConfigurationLoadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationLoadRefusedError";
  }
}

/** The message reaching the operator when a `psilink.yaml` sits in the mount
 * but the console could not open it as a file -- a permission, a non-regular
 * file, or a read error. Names neither the OS error nor the container path:
 * the operator can see both in their own mount. */
const UNREADABLE_CONFIGURATION_MESSAGE =
  "A psilink.yaml is in your working folder, but the console could not " +
  "read it. Check that it is a regular file with read permission, then " +
  "open it again.";

/** The message reaching the operator when a `psilink.yaml` sits in the mount
 * but exceeds {@link MAX_CONFIGURATION_FILE_BYTES}. */
const OVER_LARGE_CONFIGURATION_MESSAGE =
  "The psilink.yaml in your working folder is too large to be an " +
  "exchange configuration. Check that it is the file psilink runs " +
  "under, then open it again.";

/** A channel the console opens a configuration on. */
type OpenedChannel = "sftp" | "filedrop" | "webrtc";

/** The channels the console opens a configuration on: an allowlist, so a channel
 * a later schema version adds is refused until it is named here. Only the job
 * channels ({@link isJobChannel}) are conducted; a configuration on another is
 * opened for editing with its run withheld. */
const OPENED_CHANNELS: ReadonlySet<string> = new Set<OpenedChannel>([
  "sftp",
  "filedrop",
  "webrtc",
]);

/**
 * The SFTP connection as the response states it: the fields the console's
 * connection form edits, and a `credentialMethod` naming WHICH credential the
 * file states rather than the credential itself. `username` and
 * `hostKeyFingerprint` are here because the form edits both; the credential,
 * its passphrase, and every `@path` among them are not, and no value of theirs
 * leaves the server.
 */
export interface DisclosedSftpServer {
  host: string;
  port?: number;
  path?: string;
  inboundPath?: string;
  outboundPath?: string;
  username?: string;
  hostKeyFingerprint?: string | Array<string>;
  keyboardInteractive?: boolean;
  credentialMethod?: "password" | "private_key";
}

/** The `signing` settings the receipts card edits. The identity file and the
 * receipt output are the console's own paths, so neither is disclosed. */
export interface DisclosedSigning {
  mode: SigningConfig["mode"];
  partnerFingerprint?: string;
}

/**
 * The file-sync tuning fields the authoring forms edit, projected from core's
 * {@link FileSyncOptions} by name so a field a later schema version adds
 * reaches no browser until this states it.
 */
export interface DisclosedFileSyncOptions {
  peerTimeoutMs?: number;
  serverConnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  pollIntervalMs?: number;
  timestampInFilename?: boolean;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  unexpectedFiles?: "error" | "warn" | "ignore";
  connectionPerPoll?: boolean;
}

/**
 * The document as the browser receives it: the authoring forms' own fields and
 * nothing else. Not an {@link ExchangeSpec} -- it is a projection, so a field
 * added to the shared schema reaches no browser until this states it.
 */
export interface DisclosedExchangeDocument {
  channel: OpenedChannel;
  server?: DisclosedSftpServer;
  options?: DisclosedFileSyncOptions;
  linkageTerms: ExchangeSpec["linkageTerms"];
  metadata?: ExchangeSpec["metadata"];
  standardization?: ExchangeSpec["standardization"];
  expectedPayloadColumns?: Array<string>;
  expectedPartnerDeduplicate?: boolean;
  disclosedPayloadColumns?: Array<string>;
  outboundPayloadConsent?: ExchangeSpec["outboundPayloadConsent"];
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  csvDelimiter?: string;
  retentionDisposition?: string;
  signing?: DisclosedSigning;
}

/** The body `GET /api/jobs/config` answers with. `present: false` is a console
 * whose mount holds no configuration, which is the ordinary first run rather
 * than a fault. */
export interface LoadedConfigurationResponse {
  configured: boolean;
  present: boolean;
  document?: DisclosedExchangeDocument;
  carriedThrough: Array<string>;
  warnings: Array<string>;
}

/**
 * The intent fields every composition probe below states, each optional field
 * among them present, so what the probes measure is the widest document this
 * console composes rather than the narrowest. The column roles and the cleaning
 * pipeline are among them: the columns step edits both and a run here writes
 * what that step holds, so a document stating either is adopted rather than
 * held. Only the composed document's KEYS are read, never these values.
 */
function probeIntentFields(): JobExchangeIntentBase {
  return {
    linkageTerms: probeLinkageTerms(),
    sharedSecret: "",
    metadata: [
      {
        name: "probe_column",
        type: "other",
        role: "ignored",
        isPayload: false,
      },
    ],
    standardization: [
      { output: "probe_field", input: "probe_column", steps: [] },
    ],
    expectedPayloadColumns: [],
    expectedPartnerDeduplicate: false,
    disclosedPayloadColumns: [],
    outboundPayloadConsent: { status: "pending" },
    includeOwnColumns: "all",
    csvDelimiter: "|",
    retentionDisposition: "composition probe",
    side: "acceptor",
    signing: { mode: "certificate", partnerFingerprint: PROBE_FINGERPRINT },
    options: {
      pollIntervalMs: 1000,
      peerTimeoutMs: 1000,
      serverConnectTimeoutMs: 1000,
      maxReconnectAttempts: 1,
      timestampInFilename: true,
      locklessRendezvous: true,
      peerId: "probe",
      retainFiles: true,
      unexpectedFiles: "warn",
    },
  };
}

/** The paths a certificate-mode composition names. Server-chosen on every run,
 * so a loaded document's own two are replaced rather than held. */
const PROBE_SIGNING_PATHS = {
  identityFile: "/probe/identity.json",
  receiptOutput: "/probe/receipt",
};

/**
 * An sftp composition over one shape of authored connection, as a validated
 * spec. `server` supplies the shapes that vary: the credential, which core's
 * server schema admits one primary of at a time, and the remote directory,
 * which is either the single `path` or the inbound/outbound pair.
 */
function sftpProbeSpec(server: Partial<JobSftpServerEntry>): ExchangeSpec {
  const intent: JobSftpExchangeIntent = {
    ...probeIntentFields(),
    channel: "sftp",
    options: { ...probeIntentFields().options, connectionPerPoll: true },
  };
  return composeSftpConfigSpec(
    intent,
    {
      host: "probe.invalid",
      port: 22,
      username: "probe",
      hostKeyFingerprint: PROBE_HOST_KEY_FINGERPRINT,
      ...server,
    },
    PROBE_SIGNING_PATHS,
  );
}

/**
 * Every sftp composition this console emits, over the connection shapes the
 * authored entry can hold: a password or a private key with its passphrase,
 * and a single remote directory or the inbound/outbound pair.
 * `keyboard_interactive` rides the password shape, the only one core's schema
 * admits it beside. A credential the operator authors again is composed rather
 * than held, so measuring one shape alone would report the other's fields as
 * settings this surface keeps unchanged while
 * {@link credentialFieldsNotAdopted} warns it cannot pre-fill them.
 */
function sftpProbeSpecs(): Array<ExchangeSpec> {
  return [
    sftpProbeSpec({
      path: "/probe",
      password: "@/probe/password",
      keyboardInteractive: true,
    }),
    sftpProbeSpec({
      inboundPath: "/probe/inbound",
      outboundPath: "/probe/outbound",
      privateKey: "@/probe/key",
      privateKeyPassphrase: "@/probe/key-passphrase",
    }),
  ];
}

/**
 * A filedrop composition, in whichever rendezvous form the console was
 * provisioned for. Both are probed: a console with one shared folder composes
 * `path` and a split one composes the `inbound_path`/`outbound_path` pair, and
 * a setting either form emits is one this console writes rather than holds.
 */
function filedropProbeSpec(split: boolean): ExchangeSpec {
  const intent: JobFiledropExchangeIntent = {
    ...probeIntentFields(),
    channel: "filedrop",
  };
  const document = composeConfigDocument(
    intent,
    "/probe/rendezvous",
    split ? "/probe/rendezvous-outbound" : undefined,
    PROBE_SIGNING_PATHS,
  );
  return parseExchangeSpec(
    parseSensitiveYaml(document, "console composition probe"),
  );
}

/** A host-key fingerprint of the canonical shape, for the composition probe
 * alone: core's schema grades the value, and the probe never dials. */
const PROBE_HOST_KEY_FINGERPRINT =
  "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A signing fingerprint of the canonical shape, for the composition probe. */
const PROBE_FINGERPRINT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * The linkage terms the composition probe states: core's own defaults with both
 * halves of `output` on, since a party that shares its result is the one whose
 * composition derives an `outbound_payload_consent` record. Only the composed
 * document's KEYS are read, never what they hold.
 */
function probeLinkageTerms(): ExchangeSpec["linkageTerms"] {
  const terms = getDefaultLinkageTerms("composition probe");
  return { ...terms, output: { expectsOutput: true, shareWithPartner: true } };
}

/**
 * The blocks a composition emits KEY BY KEY, so a setting inside one the
 * composition does not emit is held without an editor and belongs in the
 * carried-through notice. Every other block is adopted or held whole -- the
 * linkage terms, the metadata, the standardization pipeline -- and comparing
 * inside one would name a key the composition simply did not need for its
 * probe values.
 */
const BLOCKS_READ_KEY_BY_KEY: ReadonlySet<string> = new Set([
  "connection",
  "connection.server",
  "connection.options",
  "signing",
  "authentication",
]);

/**
 * Every setting a document states, as the FILE spells it: snake_case keys under
 * the path of the block holding them, descending only into the blocks composed
 * key by key ({@link BLOCKS_READ_KEY_BY_KEY}).
 */
function documentKeyPaths(value: unknown, parent = ""): Array<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const camelPath = parent === "" ? key : `${parent}.${key}`;
    if (BLOCKS_READ_KEY_BY_KEY.has(camelPath))
      return documentKeyPaths(nested, camelPath);
    return [camelPath.split(".").map(snakeizeKey).join(".")];
  });
}

/**
 * The settings this console's compositions write at all, over every channel and
 * rendezvous form it composes. Measured once off the composers themselves, so a
 * field they stop emitting shows up as held rather than in a restated list that
 * would go on claiming it. A setting here is written at the composition's own
 * value, which for the rendezvous folder and the two signing paths is the
 * console's own resource rather than anything the document stated.
 */
const COMPOSED_FIELD_PATHS: ReadonlySet<string> = new Set([
  ...sftpProbeSpecs().flatMap((spec) => documentKeyPaths(spec)),
  ...documentKeyPaths(filedropProbeSpec(false)),
  ...documentKeyPaths(filedropProbeSpec(true)),
]);

/**
 * The top-level blocks a composition here writes, from the same measure.
 * Exported for the hand-off's own merge ({@link ./handoff}): the export holds
 * a mounted top-level key only outside this set, since a key inside it is the
 * composition's alone, present or absent as the run composed it -- a setting
 * INSIDE one of these cannot be held, the composition's block replaces it,
 * key for key.
 */
export const COMPOSED_BLOCKS: ReadonlySet<string> = new Set(
  [...COMPOSED_FIELD_PATHS].map((field) => field.split(".")[0]),
);

/**
 * The document's settings no composition here writes, credential fields
 * excepted: the hand-off replaces each of those with a placeholder, and the
 * response names them in its warnings ({@link credentialFieldsNotAdopted})
 * rather than as settings it keeps. A `connection` on a channel the console
 * does not conduct is left out whole: no run here composes one over it.
 */
function unadoptedFields(document: ExchangeSpec): Array<string> {
  const credentials = new Set(credentialFieldsNotAdopted(document));
  const conducted = isJobChannel(document.connection.channel);
  return documentKeyPaths(document)
    .filter(
      (field) =>
        !COMPOSED_FIELD_PATHS.has(field) &&
        !credentials.has(field) &&
        (conducted || field.split(".")[0] !== "connection"),
    )
    .sort();
}

/** Whether a setting sits inside a block the composition writes whole. */
function insideComposedBlock(field: string): boolean {
  return field.includes(".") && COMPOSED_BLOCKS.has(field.split(".")[0]);
}

/**
 * The document's settings the console's composition never writes and the export
 * keeps unchanged, named as the file spells them and sorted: the settings no
 * form here edits and no run here replaces, which the export writes back from
 * the document it opened.
 *
 * A setting inside a composed block is not among them -- the load refuses such
 * a document ({@link assertHeldSettingsSurvive}), so the name this list states
 * and the setting the export keeps are the same setting.
 */
export function carriedThroughFields(document: ExchangeSpec): Array<string> {
  return unadoptedFields(document).filter(
    (field) => !insideComposedBlock(field),
  );
}

/**
 * Refuse a load whose held setting the export could not write back: it sits
 * inside a block the composition writes, which the export writes over that
 * block whole. Naming it here is the alternative the portable-configuration
 * rule allows to holding it (docs/spec/EXCHANGE_FILE.md, "What a consumer does
 * with a setting it cannot honor"); reporting it as kept and then dropping it
 * is not.
 */
function assertHeldSettingsSurvive(document: ExchangeSpec): void {
  const lost = unadoptedFields(document).filter(insideComposedBlock);
  if (lost.length === 0) return;
  throw new ConfigurationLoadRefusedError(
    "This configuration states " +
      (lost.length === 1 ? "a setting" : "settings") +
      " the console has no control for and cannot write back, because a run " +
      "here writes the block holding " +
      (lost.length === 1 ? "it" : "them") +
      ": " +
      lost.join(", ") +
      ". Run this configuration with psilink on the command line instead.",
  );
}

/**
 * The records whose ABSENCE is a valid state turning an enforcement off, so a
 * load that could not put one back into the composed document would silently
 * release this party from it: the three of docs/spec/EXCHANGE_FILE.md, "The
 * records that must survive", and the consent record this party confirmed its
 * own outbound set with, whose absent state is read the same lazy way ("The
 * acceptor's outbound consent"). Named here as the file spells them; whether
 * the composition still emits each is measured, never assumed.
 */
const RECORDS_THAT_MUST_SURVIVE: ReadonlyArray<string> = [
  "expected_payload_columns",
  "expected_partner_deduplicate",
  "disclosed_payload_columns",
  "outbound_payload_consent",
];

/**
 * Refuse a load that would lose one of {@link RECORDS_THAT_MUST_SURVIVE}: the
 * document states it and this console's composition has no key to put it back
 * in. It cannot be held unchanged instead -- holding a record no run enforces is
 * the same failure one exchange later.
 */
function assertRecordsSurvive(document: ExchangeSpec): void {
  const stated = new Set(documentKeyPaths(document));
  const lost = RECORDS_THAT_MUST_SURVIVE.filter(
    (field) => stated.has(field) && !COMPOSED_FIELD_PATHS.has(field),
  );
  if (lost.length === 0) return;
  throw new ConfigurationLoadRefusedError(
    "This configuration states " +
      (lost.length === 1 ? "a setting" : "settings") +
      " the console cannot run and cannot keep, and each one turns off a " +
      "check this exchange is held to: " +
      lost.join(", ") +
      ". Run this configuration with psilink on the command line instead.",
  );
}

/**
 * The mounted file's bytes as a document, through the shared sensitive-parse
 * chokepoint (bounded parse, path-only errors). A file that is not YAML is
 * refused in the console's own words rather than by the parser's: the parser's
 * message locates a byte offset the operator cannot act on, and this reaches
 * them as the reason the load stopped.
 */
function parsedYaml(source: string): unknown {
  try {
    return parseSensitiveYaml(source, "mounted exchange configuration");
  } catch {
    throw new ConfigurationLoadRefusedError(
      "The psilink.yaml in your working folder could not be read as YAML. " +
        "Check the file for a formatting mistake, then open it again.",
    );
  }
}

/** The document the shared exchange-file schema reads out of the mounted file,
 * refused in the console's own words: the operator edits this file by hand, so
 * a setting it rejects is a line they can fix. The non-throwing parse is what
 * puts a file too deeply nested for the case conversion into the same refusal
 * as a schema violation rather than past this handler: its bound is reported at
 * the document root, which names no line to fix. */
function parsedDocument(raw: unknown): ExchangeSpec {
  const parsed = safeParseExchangeSpec(raw);
  if (parsed.success) return parsed.data;
  const fields = refusedDocumentFields(parsed.error, raw);
  throw new ConfigurationLoadRefusedError(
    fields.length === 0
      ? "The psilink.yaml in your working folder is not a psilink exchange " +
          "configuration. Check the file, then open it again."
      : "The psilink.yaml in your working folder is not a valid psilink " +
          "configuration. " +
          (fields.length === 1 ? "Fix this setting" : "Fix these settings") +
          " in the file, then open it again: " +
          namedFieldList(fields) +
          ".",
  );
}

/** Refuse a channel outside {@link OPENED_CHANNELS}, naming it as the file
 * spells it and saying where the exchange runs instead. */
function openedChannel(document: ExchangeSpec): OpenedChannel {
  const { channel } = document.connection;
  if (!OPENED_CHANNELS.has(channel))
    throw new ConfigurationLoadRefusedError(
      `This configuration runs over ${channel}, which the console cannot ` +
        "open. Run it with psilink on the command line instead.",
    );
  return channel;
}

/**
 * Refuse an `authentication` block holding the secret or its expiry. The
 * console creates a new secret for each invitation and writes it to the run's
 * own key file, so a secret in the document is a value it would neither use
 * nor be able to keep. `token_max_age_days` is held unchanged, which
 * {@link carriedThroughFields} names.
 */
function assertNoStatedSecret(document: ExchangeSpec): void {
  const authentication = document.authentication;
  if (authentication === undefined) return;
  const named = [
    ...(authentication.sharedSecret !== undefined ? ["shared_secret"] : []),
    ...(authentication.expires !== undefined ? ["expires"] : []),
  ];
  if (named.length === 0) return;
  throw new ConfigurationLoadRefusedError(
    "This configuration's authentication block states " +
      named.join(" and ") +
      ". The shared secret and its expiry belong in the .psilink.key file, " +
      "not the configuration, and the console creates a new secret for each " +
      "invitation, so remove " +
      (named.length === 1 ? "that line" : "those lines") +
      " and open it again.",
  );
}

/**
 * The credential fields the load reads and cannot pre-fill, named as the file
 * spells them and sorted. Names only -- a credential's value is the whole reason
 * this list exists.
 *
 * A warning rather than a refusal: the operator owns this mount and the
 * reference is their own choice, so the load proceeds and the connection form
 * opens with the credential empty for them to pick or type again. A `@path`
 * reference and a literal value draw the same warning, since neither leaves the
 * server.
 */
export function credentialFieldsNotAdopted(
  document: ExchangeSpec,
): Array<string> {
  const { connection } = document;
  if (connection.channel !== "sftp") return [];
  const server = connection.server;
  return (
    [
      ["connection.server.password", server.password],
      ["connection.server.private_key", server.privateKey],
      ["connection.server.private_key_passphrase", server.privateKeyPassphrase],
    ] as ReadonlyArray<[string, string | undefined]>
  )
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field)
    .sort();
}

/** The connection form's own fields, read off an sftp connection. */
function disclosedServer(document: ExchangeSpec): DisclosedSftpServer {
  const { connection } = document;
  if (connection.channel !== "sftp")
    throw new Error("disclosedServer read a connection that is not sftp");
  const server = connection.server;
  return {
    host: server.host,
    ...(server.port !== undefined ? { port: server.port } : {}),
    ...(server.path !== undefined ? { path: server.path } : {}),
    ...(server.inboundPath !== undefined
      ? { inboundPath: server.inboundPath }
      : {}),
    ...(server.outboundPath !== undefined
      ? { outboundPath: server.outboundPath }
      : {}),
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.hostKeyFingerprint !== undefined
      ? { hostKeyFingerprint: server.hostKeyFingerprint }
      : {}),
    ...(server.keyboardInteractive !== undefined
      ? { keyboardInteractive: server.keyboardInteractive }
      : {}),
    ...(server.privateKey !== undefined
      ? { credentialMethod: "private_key" as const }
      : server.password !== undefined
        ? { credentialMethod: "password" as const }
        : {}),
  };
}

/**
 * The `options` block as the browser receives it, named field by field so a
 * field a later {@link FileSyncOptions} version adds reaches no browser until
 * this function states it.
 */
function disclosedOptions(options: FileSyncOptions): DisclosedFileSyncOptions {
  return {
    ...(options.peerTimeoutMs !== undefined
      ? { peerTimeoutMs: options.peerTimeoutMs }
      : {}),
    ...(options.serverConnectTimeoutMs !== undefined
      ? { serverConnectTimeoutMs: options.serverConnectTimeoutMs }
      : {}),
    ...(options.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: options.maxReconnectAttempts }
      : {}),
    ...(options.pollIntervalMs !== undefined
      ? { pollIntervalMs: options.pollIntervalMs }
      : {}),
    ...(options.timestampInFilename !== undefined
      ? { timestampInFilename: options.timestampInFilename }
      : {}),
    ...(options.locklessRendezvous !== undefined
      ? { locklessRendezvous: options.locklessRendezvous }
      : {}),
    ...(options.peerId !== undefined ? { peerId: options.peerId } : {}),
    ...(options.retainFiles !== undefined
      ? { retainFiles: options.retainFiles }
      : {}),
    ...(options.unexpectedFiles !== undefined
      ? { unexpectedFiles: options.unexpectedFiles }
      : {}),
    ...(options.connectionPerPoll !== undefined
      ? { connectionPerPoll: options.connectionPerPoll }
      : {}),
  };
}

/**
 * The parsed document as the browser receives it. An explicit mapping rather
 * than a strip of the parsed object: every disclosed field is written here by
 * name, so a credential, a container path, or a field a later schema version
 * adds reaches no browser until this function states it.
 */
export function disclosedDocument(
  document: ExchangeSpec,
): DisclosedExchangeDocument {
  const { connection } = document;
  const options: FileSyncOptions | undefined =
    connection.channel === "sftp" || connection.channel === "filedrop"
      ? connection.options
      : undefined;
  return {
    channel: openedChannel(document),
    ...(connection.channel === "sftp"
      ? { server: disclosedServer(document) }
      : {}),
    ...(options !== undefined ? { options: disclosedOptions(options) } : {}),
    linkageTerms: document.linkageTerms,
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
    ...(document.standardization !== undefined
      ? { standardization: document.standardization }
      : {}),
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
    ...(document.includeOwnColumns !== undefined
      ? { includeOwnColumns: document.includeOwnColumns }
      : {}),
    ...(document.csvDelimiter !== undefined
      ? { csvDelimiter: document.csvDelimiter }
      : {}),
    ...(document.retentionDisposition !== undefined
      ? { retentionDisposition: document.retentionDisposition }
      : {}),
    ...(document.signing !== undefined
      ? {
          signing: {
            mode: document.signing.mode,
            ...(document.signing.partnerFingerprint !== undefined
              ? { partnerFingerprint: document.signing.partnerFingerprint }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Read one configuration document from its source text: the sensitive-parse
 * chokepoint, the shared schema, then the console's own refusals.
 *
 * @throws {ConfigurationLoadRefusedError} when the file is not a configuration
 *   the console can open.
 */
export function mountedConfigurationDocument(source: string): ExchangeSpec {
  const document = parsedDocument(parsedYaml(source));
  openedChannel(document);
  assertNoStatedSecret(document);
  assertRecordsSurvive(document);
  assertHeldSettingsSurvive(document);
  return document;
}

/**
 * The same read as a response body: the settings the authoring forms edit, the
 * ones the console holds without an editor, and the credential fields it cannot
 * pre-fill.
 *
 * @throws {ConfigurationLoadRefusedError} when the file is not a configuration
 *   the console can open.
 */
export function readMountedConfiguration(
  source: string,
): LoadedConfigurationResponse {
  const document = mountedConfigurationDocument(source);
  return {
    configured: true,
    present: true,
    document: disclosedDocument(document),
    carriedThrough: carriedThroughFields(document),
    warnings: credentialFieldsNotAdopted(document),
  };
}

/**
 * Load the configuration mounted at `<dataRoot>/psilink.yaml`. An absent file is
 * `present: false` and no error: a console whose operator has authored nothing
 * yet is the ordinary first run. A file that IS there but the load cannot open
 * -- unreadable, not a regular file, or over the size cap -- is refused ahead of
 * the parse instead of reported as absent, so the operator is told there is
 * something in the folder to fix rather than being pointed at authoring a
 * configuration that already exists.
 *
 * @throws {ConfigurationLoadRefusedError} when the file is not a configuration
 *   the console can open.
 */
export function loadMountedConfiguration(
  dataRoot: string,
): LoadedConfigurationResponse {
  const source = mountedConfigurationSource(dataRoot);
  if (source === null)
    return {
      configured: true,
      present: false,
      carriedThrough: [],
      warnings: [],
    };
  return readMountedConfiguration(source);
}

/**
 * The mounted configuration's bytes, or null where the mount holds no such file
 * at all.
 *
 * Every check and the read itself go through the one descriptor `openSync`
 * returns, so nothing between them can swap what `psilink.yaml` names. An
 * open failure is absent only when the entry does not exist (`ENOENT`);
 * any other open failure -- including a permission denied that a `stat`
 * would have missed -- is the unreadable refusal. The read is bounded to
 * one byte past the cap, so an over-large file is caught by what arrives
 * rather than by a size `fstat` reported earlier.
 *
 * @throws {ConfigurationLoadRefusedError} when a file IS there and the console
 *   cannot read it -- unreadable, not a regular file, or over the size cap.
 */
function mountedConfigurationSource(dataRoot: string): string | null {
  const filePath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.config);
  if (filePath === null) return null;
  let fd: number;
  try {
    // O_NONBLOCK, not the plain "r" flag: opening a FIFO for read-only blocks
    // until a writer opens it, which would wedge this synchronous server on a
    // FIFO named psilink.yaml (or a symlink to one). O_NONBLOCK makes that
    // open return immediately instead; the fstat below then refuses it as not
    // a regular file. A regular file ignores the flag, so its open and read
    // are unchanged.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigurationLoadRefusedError(UNREADABLE_CONFIGURATION_MESSAGE);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile())
      throw new ConfigurationLoadRefusedError(UNREADABLE_CONFIGURATION_MESSAGE);
    if (stat.size > MAX_CONFIGURATION_FILE_BYTES)
      throw new ConfigurationLoadRefusedError(OVER_LARGE_CONFIGURATION_MESSAGE);
    const buffer = Buffer.alloc(MAX_CONFIGURATION_FILE_BYTES + 1);
    let bytesRead = 0;
    try {
      while (bytesRead < buffer.length) {
        const read = fs.readSync(
          fd,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          null,
        );
        if (read === 0) break;
        bytesRead += read;
      }
    } catch {
      throw new ConfigurationLoadRefusedError(UNREADABLE_CONFIGURATION_MESSAGE);
    }
    if (bytesRead > MAX_CONFIGURATION_FILE_BYTES)
      throw new ConfigurationLoadRefusedError(OVER_LARGE_CONFIGURATION_MESSAGE);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The mounted configuration as a parsed document, for the export a run composes
 * ({@link ./handoff}): the settings it states that a composition here does not
 * emit are written back unchanged from this one, so the file the operator takes
 * to the command line states everything the file they opened stated.
 *
 * Undefined on every fault, a mount holding no configuration included, rather
 * than a refusal: a file this console could not have opened is not one the run
 * was composed from, and the export then states exactly what the console
 * composed. A configuration on a channel the console does not conduct is
 * undefined the same way, since the browser withholds its run.
 */
export function mountedExchangeDocument(
  dataRoot: string,
): ExchangeSpec | undefined {
  try {
    const source = mountedConfigurationSource(dataRoot);
    if (source === null) return undefined;
    const document = mountedConfigurationDocument(source);
    return isJobChannel(document.connection.channel) ? document : undefined;
  } catch (error) {
    if (error instanceof ConfigurationLoadRefusedError) return undefined;
    throw error;
  }
}

/**
 * The mounted configuration a hand-back is written over: the document the
 * operator opened on a channel the console does not conduct, read again at the
 * moment of the write so the connection it keeps is the one the file holds now.
 *
 * @throws {ConfigurationLoadRefusedError} when the mount holds no configuration,
 *   one the console cannot open, or one on a channel the console runs itself --
 *   a file changed on disk since it was opened.
 */
export function mountedUnconductedDocument(dataRoot: string): ExchangeSpec {
  const source = mountedConfigurationSource(dataRoot);
  if (source === null)
    throw new ConfigurationLoadRefusedError(
      "Your working folder no longer holds a psilink.yaml to save these " +
        "changes to. Put the configuration back, then open it again.",
    );
  const document = mountedConfigurationDocument(source);
  const { channel } = document.connection;
  if (isJobChannel(channel))
    throw new ConfigurationLoadRefusedError(
      `The psilink.yaml in your working folder has changed since you opened ` +
        `it, and runs over ${channel} now. Close the configuration and open ` +
        "it again.",
    );
  return document;
}
