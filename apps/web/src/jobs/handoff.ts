import {
  parseExchangeSpec,
  serializeExchangeDocument,
  snakeizeKey,
} from "@psilink/core";

import { COMPOSED_BLOCKS } from "./configLoad";

import { zeroSetupOptionsArgv, zeroSetupSftpArgv } from "./intentArgv";

import {
  composeFiledropConfigSpec,
  composeSftpConfigSpec,
} from "./intentConfig";

import { isJobChannel } from "./intentSchemas";

import type { ExchangeSpec, SigningConfig } from "@psilink/core";
import type {
  JobConfigurationHandBack,
  JobCreateIntent,
  JobExchangeIntent,
  JobHandBackSigning,
  JobSigningPaths,
  JobZeroSetupIntent,
} from "./intentSchemas";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * The recurring-run hand-off: the portable, secret-free material an operator
 * needs to graduate a prototyped console exchange to a scheduled `psilink`
 * command-line run. The console composes every path it runs the CLI over as
 * a CONTAINER-internal path, and the shared secret lives only in the on-disk
 * `.psilink.key`, which never crosses the browser. The hand-off is a
 * PORTABLE TEMPLATE, not a turnkey export: the machine-independent parts
 * (SFTP host/port/username, the host-key fingerprint pin, the linkage terms
 * exactly as they ran) are filled in, while machine-specific paths are shown
 * as labelled placeholders the operator sets for their own machine.
 *
 * The exchange mode's template is written through core's
 * {@link serializeExchangeDocument}, the writer psilink's own `saveConfig`
 * uses, and over a document the schema has validated -- so an authored
 * exchange and one opened from the mount are written by one writer, in the
 * file psilink would write for those settings (docs/spec/EXCHANGE_FILE.md,
 * "Writing a configuration back").
 *
 * Two invariants, enforced by the compose helpers below and driven in
 * jobHandoff.unit.test.ts and jobHandoffParity.unit.test.ts:
 * - No shared secret, key-file body, or inline credential value is ever
 *   present: the exchange config holds the credential only as an `@path`
 *   reference, and the zero-setup command holds no secret at all.
 * - No container-internal path is ever present: the credential `@path`,
 *   every filedrop rendezvous mount, and the signing identity file are
 *   replaced with fixed placeholder tokens before the template is composed.
 *   A configuration opened from the mount and not converted states its own
 *   shared-folder, sftp credential, and signing paths instead, as it read them
 *   ({@link withPathsAsRead}): paths of the operator's machine, never the
 *   console's.
 */
export interface JobHandoff {
  /** The mode the run used: `exchange` (invitation, config-and-key driven) or
   * `zeroSetup` (Direct, the positional `$0` command form). */
  mode: "exchange" | "zeroSetup";
  /** The channel the run used. */
  channel: "sftp" | "filedrop";
  /**
   * Whether the run wrote a `.psilink.key` the operator must copy to their
   * recurring folder. True for the exchange mode (which holds a shared secret
   * in the key file), false for the zero-setup mode (which holds none).
   */
  usedKeyFile: boolean;
  /**
   * Whether the run used the `.psilink.key` beside the configuration opened in
   * the working folder, rather than one written into the run's own folder.
   * The panel then points at that file, which the run's handshake rotated in
   * place. Always false for a zero-setup run, which uses no key file.
   */
  keyFileBesideConfiguration: boolean;
  /**
   * Whether the authored SFTP credential arrived as a PASTED value
   * (materialized to a server-owned file) rather than a file the operator
   * owns. The panel shows the save-it-to-a-file caveat when true. Always
   * false on the filedrop channel, which has no credential.
   */
  credentialPasted: boolean;
  /**
   * Whether the run signed receipts under a long-lived signing identity.
   * True for a `certificate`-mode exchange, false otherwise (every
   * zero-setup run signs nothing).
   *
   * The panel shows the reuse-the-identity caveat when true: the recurring
   * run must load the SAME signing key file, since a fresh `psilink
   * fingerprint` on the scheduling machine mints a different key the
   * partner's pin would reject.
   */
  usedSigningIdentity: boolean;
  /**
   * The settings the template's `certificate`-mode signing block needs and
   * does not have, as the file spells them, which the panel names for the
   * operator to set before scheduling. Absent when there are none. They are
   * the two the CLI refuses such a block without, before any exchange: a
   * party name in `linkage_terms.identity` and a `signing.identity_file`.
   * An unconverted opened configuration's block, handed off as read for a
   * run that signed nothing, can lack either.
   */
  signingSettingsToSet?: Array<HandoffSigningSetting>;
  /** The portable template itself: the exchange config document and the command
   * that runs it (exchange mode), or the zero-setup command tokens (zeroSetup
   * mode). */
  template: JobHandoffTemplate;
}

/** A setting a `certificate`-mode signing block requires, as the file spells
 * it. */
export type HandoffSigningSetting =
  "linkage_terms.identity" | "signing.identity_file";

/**
 * The portable template, discriminated on which artifact the mode produces: the
 * `psilink.yaml` config text an exchange-mode recurring run loads, beside the
 * argv tokens of the `psilink exchange` command that loads it, or the argv
 * tokens of the zero-setup command a Direct-mode recurring run invokes.
 */
export type JobHandoffTemplate =
  | { kind: "config"; yaml: string; argv: Array<string> }
  | { kind: "command"; argv: Array<string> };

/** The placeholder a container-internal credential `@path` is shown as. The
 * operator replaces it with the path to their own credential file. */
export const HANDOFF_CREDENTIAL_PATH_PLACEHOLDER =
  "@/path/to/your/credential-file";

/** The placeholder a container-internal private-key passphrase `@path` is shown
 * as, kept distinct from the primary credential so the two files read clearly. */
export const HANDOFF_PASSPHRASE_PATH_PLACEHOLDER =
  "@/path/to/your/passphrase-file";

/** The placeholder the filedrop rendezvous directory is shown as in the exchange
 * config's `connection.path`. */
export const HANDOFF_SHARED_DIRECTORY_PLACEHOLDER =
  "/path/to/your/shared-directory";

/** The placeholder the filedrop rendezvous directory is shown as in a zero-setup
 * command's `file://` locator (the CLI requires the three-slash URL form for a
 * filedrop positional). */
export const HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER =
  "file:///path/to/your/shared-directory";

/** The placeholder a split console's INBOUND (peer-written) rendezvous mount is
 * shown as, in the exchange config's `connection.inbound_path`. Named for the
 * direction rather than "shared": the two folders are not one. */
export const HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/inbound-directory";

/** The placeholder a split console's OUTBOUND (self-written) rendezvous mount is
 * shown as, in `connection.outbound_path` and on `--outbound-path`. */
export const HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/outbound-directory";

/** The placeholder the inbound mount is shown as in a zero-setup command's
 * `file://` locator, the split counterpart to
 * {@link HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER}. */
export const HANDOFF_INBOUND_DIRECTORY_URL_PLACEHOLDER =
  "file:///path/to/your/inbound-directory";

/**
 * The placeholder the signing identity file is shown as in the exchange
 * config's `signing.identity_file`.
 *
 * The identity is a real file on the operator's host, but the console loads
 * it by the CONTAINER's path, which their host does not have -- whether that
 * is the mounted data root's default or the secrets-mount file the operator
 * chose, since the console resolves either to a container path. The template
 * names the file rather than the location, and the panel says which file to
 * point it at.
 */
export const HANDOFF_SIGNING_IDENTITY_PLACEHOLDER =
  "/path/to/your/signing-identity.json";

/** The input/output positionals both recurring command templates name, matching
 * the console's `results.csv` download name so the two flows read consistently. */
const HANDOFF_INPUT_NAME = "input.csv";
const HANDOFF_OUTPUT_NAME = "results.csv";

/**
 * Rebuild the authored SFTP server entry with every container-internal
 * credential `@path` replaced by a placeholder, keeping every portable field
 * verbatim (host, port, username, the REMOTE working directories, the
 * host-key fingerprint, the keyboard-interactive toggle). Constructed
 * field-by-field, never by spreading the entry, so no real credential
 * `@path` and no future field can ride along. The remote directories are on
 * the partner's SFTP server and identical on any machine, so they stay;
 * only the LOCAL credential files differ per machine.
 */
function placeholderServerEntry(entry: JobSftpServerEntry): JobSftpServerEntry {
  const sanitized: JobSftpServerEntry = {
    host: entry.host,
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.path !== undefined ? { path: entry.path } : {}),
    ...(entry.inboundPath !== undefined
      ? { inboundPath: entry.inboundPath }
      : {}),
    ...(entry.outboundPath !== undefined
      ? { outboundPath: entry.outboundPath }
      : {}),
    ...(entry.keyboardInteractive !== undefined
      ? { keyboardInteractive: entry.keyboardInteractive }
      : {}),
    hostKeyFingerprint: entry.hostKeyFingerprint,
  };
  if (entry.password !== undefined)
    sanitized.password = HANDOFF_CREDENTIAL_PATH_PLACEHOLDER;
  else if (entry.privateKey !== undefined)
    sanitized.privateKey = HANDOFF_CREDENTIAL_PATH_PLACEHOLDER;
  if (entry.privateKeyPassphrase !== undefined)
    sanitized.privateKeyPassphrase = HANDOFF_PASSPHRASE_PATH_PLACEHOLDER;
  return sanitized;
}

/**
 * The signing paths the TEMPLATE names, as against the ones the live run
 * used.
 *
 * The identity is placeholdered: the console loads it by a container path
 * the operator's host does not have (see
 * {@link HANDOFF_SIGNING_IDENTITY_PLACEHOLDER}).
 *
 * The receipt output is OMITTED rather than placeholdered: with the key
 * absent, the CLI writes a timestamped receipt into the run's own working
 * directory, so a schedule accumulates one receipt per run. Reusing the
 * console's single fixed name would have each scheduled run overwrite the
 * last run's receipt. The live run pins the name because it serves that one
 * file once; a schedule wants the trail.
 */
const HANDOFF_SIGNING_PATHS: JobSigningPaths = {
  identityFile: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
};

/**
 * The exchange mode's portable template: the `psilink.yaml` text of
 * `handoffSpec` ({@link exchangeHandoffSpec}), beside the command that runs
 * it. The command ends on the same input/output positionals as the zero-setup
 * command, and names no config or key file: the panel has both copied into the
 * folder the command runs in.
 */
function buildExchangeHandoffTemplate(
  handoffSpec: ExchangeSpec,
  mountedDocument: ExchangeSpec | undefined,
): JobHandoffTemplate {
  return {
    kind: "config",
    yaml: handoffConfigDocument(handoffSpec, mountedDocument),
    argv: ["psilink", "exchange", HANDOFF_INPUT_NAME, HANDOFF_OUTPUT_NAME],
  };
}

/**
 * The exchange mode's composed blocks as the template states them, through the
 * SAME compose functions the live run used, so linkage terms, metadata,
 * standardization, and connection fields are byte-for-byte what ran, with
 * only the container paths substituted first (a placeholder-credential
 * server entry on sftp, a placeholder rendezvous path on filedrop, and
 * {@link HANDOFF_SIGNING_PATHS} on both). Recomposing, rather than reading
 * and munging the on-disk file, keeps the container path out by
 * construction. An unconverted opened document's own paths are then put back
 * ({@link withPathsAsRead}); the held settings outside these blocks are merged
 * in by {@link handoffConfigDocument}.
 */
function exchangeHandoffSpec(
  intent: JobExchangeIntent,
  serverEntry: JobSftpServerEntry | undefined,
  filedropSplit: boolean,
  mountedDocument: ExchangeSpec | undefined,
  mountedDocumentConverted: boolean,
): ExchangeSpec {
  const composed = composedHandoffSpec(intent, serverEntry, filedropSplit);
  return mountedDocument === undefined || mountedDocumentConverted
    ? composed
    : withPathsAsRead(composed, mountedDocument, intent);
}

/**
 * The settings a `certificate`-mode signing block in `handoffSpec` lacks, of
 * the two the CLI refuses the block without before it exchanges anything:
 * `linkage_terms.identity` (core's `assertCertificateModeNamesLocalParty`)
 * and `signing.identity_file` (the exchange command's
 * `assertSigningIdentityNamed`). Each test is the one its refusal makes.
 */
function unsetCertificateSigningSettings(
  handoffSpec: ExchangeSpec,
): Array<HandoffSigningSetting> {
  const { signing, linkageTerms } = handoffSpec;
  if (signing?.mode !== "certificate") return [];
  const unset: Array<HandoffSigningSetting> = [];
  if (linkageTerms.identity === undefined) unset.push("linkage_terms.identity");
  if (signing.identityFile === undefined) unset.push("signing.identity_file");
  return unset;
}

/** A filedrop connection, as core's spec types it. */
type FiledropConnection = Extract<
  ExchangeSpec["connection"],
  { channel: "filedrop" }
>;

/**
 * The composition with the paths an unconverted opened document read put back:
 * the shared folder or folder pair, where the run kept the document's filedrop
 * channel, each sftp credential `@path` ({@link withCredentialPathsAsRead}),
 * and the document's signing block exactly as read for a run that
 * signs nothing. The run's receipt mode is the run's choice; the hand-off is
 * the operator's file, so a path and a mode of theirs stay theirs until they
 * convert it. A signed run reaches here only for a document stating no signing
 * path (the create refuses the rest), and gets the block
 * {@link handBackSigning} writes for it.
 */
function withPathsAsRead(
  composed: ExchangeSpec,
  mountedDocument: ExchangeSpec,
  intent: JobExchangeIntent,
): ExchangeSpec {
  const { signing: composedSigning, ...rest } = composed;
  const signing =
    intent.signing?.mode === "certificate"
      ? handBackSigning(
          {
            mode: "certificate",
            ...(composedSigning?.partnerFingerprint !== undefined
              ? { partnerFingerprint: composedSigning.partnerFingerprint }
              : {}),
          },
          mountedDocument.signing,
        )
      : mountedDocument.signing;
  const read = mountedDocument.connection;
  const connection =
    composed.connection.channel === "filedrop" && read.channel === "filedrop"
      ? { ...withoutFolderPaths(composed.connection), ...folderPathsOf(read) }
      : composed.connection.channel === "sftp" && read.channel === "sftp"
        ? {
            ...composed.connection,
            server: withCredentialPathsAsRead(
              composed.connection.server,
              read.server,
            ),
          }
        : composed.connection;
  return {
    ...rest,
    connection,
    ...(signing !== undefined ? { signing } : {}),
  };
}

/** An sftp server, as core's spec types it. */
type SftpServer = Extract<
  ExchangeSpec["connection"],
  { channel: "sftp" }
>["server"];

/**
 * The composed server with each credential field it states set to the
 * `@path` the read server states for that field. A field the read server
 * leaves out, or states as an inline value, keeps its placeholder: an inline
 * value is the credential itself, which no template holds, and carrying only
 * fields the composition states keeps the sign-in method the run used.
 */
function withCredentialPathsAsRead(
  composed: SftpServer,
  read: SftpServer,
): SftpServer {
  const server = { ...composed };
  for (const field of [
    "password",
    "privateKey",
    "privateKeyPassphrase",
  ] as const) {
    const readValue = read[field];
    if (server[field] !== undefined && readValue?.startsWith("@") === true)
      server[field] = readValue;
  }
  return server;
}

/** A filedrop connection with neither folder form, for a read one to fill. */
function withoutFolderPaths(
  connection: FiledropConnection,
): FiledropConnection {
  const { path, inboundPath, outboundPath, ...rest } = connection;
  return rest;
}

/** The folder form a filedrop connection states, whichever of the two. */
function folderPathsOf(
  connection: FiledropConnection,
): Pick<FiledropConnection, "path" | "inboundPath" | "outboundPath"> {
  return {
    ...(connection.path !== undefined ? { path: connection.path } : {}),
    ...(connection.inboundPath !== undefined
      ? { inboundPath: connection.inboundPath }
      : {}),
    ...(connection.outboundPath !== undefined
      ? { outboundPath: connection.outboundPath }
      : {}),
  };
}

/** The composition the template states, over the placeholder paths above. */
function composedHandoffSpec(
  intent: JobExchangeIntent,
  serverEntry: JobSftpServerEntry | undefined,
  filedropSplit: boolean,
): ExchangeSpec {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp handoff reached compose without a resolved server");
    return composeSftpConfigSpec(
      intent,
      placeholderServerEntry(serverEntry),
      HANDOFF_SIGNING_PATHS,
    );
  }
  return filedropSplit
    ? composeFiledropConfigSpec(
        intent,
        HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER,
        HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER,
        HANDOFF_SIGNING_PATHS,
      )
    : composeFiledropConfigSpec(
        intent,
        HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
        undefined,
        HANDOFF_SIGNING_PATHS,
      );
}

/**
 * The template's `psilink.yaml` text: core's
 * {@link serializeExchangeDocument}, the writer the CLI's own `saveConfig`
 * uses, over the composition -- so the file an operator takes to the command
 * line is the file psilink itself would write for the same settings, guidance
 * comments included.
 *
 * A run composed from a configuration the operator opened off the mount merges
 * the mounted document's top-level keys OUTSIDE {@link COMPOSED_BLOCKS} (the
 * settings the console has no editor for, held unchanged) with the composed
 * document (every block the composition emits, whole -- the connection, the
 * linkage terms, the signing paths, each already placeholdered above or, for
 * a document the operator did not convert, put back as read). A block
 * in {@link COMPOSED_BLOCKS} the composition did not write for this run -- an
 * operator who converted a mounted `signing` block and turned signing off in
 * the console -- is therefore absent from the export rather than surviving
 * from the mount: the composition's absence is itself the operator's edit. So no
 * container path and no credential value from the opened file reaches the
 * template, and no held setting outlives a run that replaced it. What survives is the
 * settings the console has no control for and never composes, which the load
 * names for the operator ({@link ./configLoad}).
 *
 * The two agree because the load refuses a document whose held setting sits
 * inside a block a composition writes: a key-by-key merge is what such a
 * setting would need, and the name the load reports as kept is therefore a
 * setting this merge keeps.
 *
 * The merged document is re-validated before it is written, so a pair of
 * settings that only conflicts once combined is refused here rather than at the
 * operator's first scheduled run. The parse is also what fixes the key order:
 * the schema's, which is the order psilink writes a configuration it loaded.
 *
 * The shared secret cannot reach the file: the load refuses a document stating
 * one, and core's serializer strips `authentication.shared_secret` and
 * `expires` from whatever it is handed.
 *
 * @throws {ZodError} if the merged document fails exchange-file validation.
 */
function handoffConfigDocument(
  composed: ExchangeSpec,
  mountedDocument: ExchangeSpec | undefined,
): string {
  const merged =
    mountedDocument === undefined
      ? composed
      : { ...heldTopLevelKeys(mountedDocument), ...composed };
  return serializeExchangeDocument(parseExchangeSpec(merged));
}

/**
 * The mounted document's top-level keys OUTSIDE {@link COMPOSED_BLOCKS}: the
 * held settings the export carries unchanged. A key inside that set is left
 * out here even when the composition did not end up writing it for this run
 * (e.g. `signing` with signing off), since the composition's absence of the
 * block is the operator's edit, not something to carry from the mount.
 *
 * {@link COMPOSED_BLOCKS} names blocks the FILE spells (snake_case, e.g.
 * `linkage_terms`); the mounted document's own keys are the parsed spec's
 * camelCase, so each is snakeized before the membership check.
 */
function heldTopLevelKeys(
  mountedDocument: ExchangeSpec,
): Partial<ExchangeSpec> {
  return Object.fromEntries(
    Object.entries(mountedDocument).filter(
      ([key]) => !COMPOSED_BLOCKS.has(snakeizeKey(key)),
    ),
  );
}

/**
 * The configuration handed back into the mount for a document on a channel the
 * console does not conduct: the settings the authoring steps edit, from
 * `handBack`, written over the document the operator opened, through the same
 * merge and writer as a run's template ({@link handoffConfigDocument}).
 *
 * Everything else comes from `mountedDocument` on the server: its `connection`
 * whole and unchanged, credentials included, since the file stays on this
 * machine and no browser reads it; the enforcement records no step edits; and
 * every top-level key outside {@link COMPOSED_BLOCKS}. Handed back the values it
 * opened with, a document is written as `serializeExchangeDocument` writes it.
 *
 * @throws {ZodError} if the merged document fails exchange-file validation.
 */
export function handBackConfigDocument(
  handBack: JobConfigurationHandBack,
  mountedDocument: ExchangeSpec,
): string {
  if (isJobChannel(mountedDocument.connection.channel))
    throw new Error(
      "a hand-back reached compose for a channel the console runs as a job",
    );
  const {
    expectedPayloadColumns,
    expectedPartnerDeduplicate,
    disclosedPayloadColumns,
    outboundPayloadConsent,
  } = mountedDocument;
  const {
    metadata,
    standardization,
    includeOwnColumns,
    csvDelimiter,
    retentionDisposition,
  } = handBack;
  const signing = handBackSigning(handBack.signing, mountedDocument.signing);
  const composed: ExchangeSpec = {
    connection: mountedDocument.connection,
    linkageTerms: handBack.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
    ...(outboundPayloadConsent !== undefined ? { outboundPayloadConsent } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns }
      : {}),
    ...(signing !== undefined ? { signing } : {}),
    ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  };
  return handoffConfigDocument(composed, mountedDocument);
}

/**
 * The `signing` block a hand-back writes. A mode the file already states keeps
 * its block unchanged; `certificate` keeps the file's identity and receipt
 * paths, which are the operator's own, and names the placeholder identity where
 * the file names none; `none` writes no block, the CLI's "sign nothing".
 */
function handBackSigning(
  choice: JobHandBackSigning,
  mounted: SigningConfig | undefined,
): SigningConfig | undefined {
  if (choice.mode === "certificate")
    return {
      mode: "certificate",
      identityFile:
        mounted?.identityFile ?? HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
      ...(choice.partnerFingerprint !== undefined
        ? { partnerFingerprint: choice.partnerFingerprint }
        : {}),
      ...(mounted?.receiptOutput !== undefined
        ? { receiptOutput: mounted.receiptOutput }
        : {}),
    };
  if (mounted !== undefined && mounted.mode === choice.mode) return mounted;
  return choice.mode === "none" ? undefined : { mode: choice.mode };
}

/**
 * Compose the zero-setup mode's portable command tokens: `psilink` plus the
 * connection portion (sftp's `sftp://` URL and `--server-*` flags with the
 * credential `@path` placeholdered, or filedrop's placeholder `file://`
 * locator), the run's tuning flags, its identity, linkage-strategy,
 * deduplicate, and field-delimiter selectors when set, and the input/output
 * positionals.
 *
 * The sftp arm reuses {@link zeroSetupSftpArgv} against a
 * placeholder-credential entry, so the URL, username, and mandatory
 * fingerprint pin are exactly what ran while no credential `@path` is
 * emitted. The tuning flags come from {@link zeroSetupOptionsArgv} -- the
 * same builder the live run's argv uses -- and name no path or credential.
 */
function buildZeroSetupHandoffTemplate(
  intent: JobZeroSetupIntent,
  serverEntry: JobSftpServerEntry | undefined,
  filedropSplit: boolean,
): JobHandoffTemplate {
  let connectionArgs: Array<string>;
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error(
        "sftp zero-setup handoff reached compose without a resolved server",
      );
    connectionArgs = zeroSetupSftpArgv(placeholderServerEntry(serverEntry));
  } else if (filedropSplit) {
    // Composed literally rather than through zeroSetupFiledropArgv: that builder
    // turns a real directory into a `file://` URL, and a placeholder is not a
    // directory to convert. The flag form and the ordering are the ones it emits.
    connectionArgs = [
      HANDOFF_INBOUND_DIRECTORY_URL_PLACEHOLDER,
      `--outbound-path=${HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER}`,
    ];
  } else {
    connectionArgs = [HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER];
  }
  const argv: Array<string> = [
    "psilink",
    ...connectionArgs,
    ...zeroSetupOptionsArgv(intent.options),
    ...(intent.identity !== undefined ? [`--identity=${intent.identity}`] : []),
    ...(intent.linkageStrategy !== undefined
      ? [`--linkage-strategy=${intent.linkageStrategy}`]
      : []),
    ...(intent.deduplicate === true ? ["--deduplicate"] : []),
    ...(intent.csvDelimiter !== undefined
      ? [`--csv-delimiter=${handoffCsvDelimiterSpelling(intent.csvDelimiter)}`]
      : []),
    HANDOFF_INPUT_NAME,
    HANDOFF_OUTPUT_NAME,
  ];
  return { kind: "command", argv };
}

/** The delimiter as the copyable command spells it: a tab is the word `tab`,
 * which the CLI reads back as the character, since a literal tab is invisible
 * in copied text and a paste can drop it. Every other choice is itself. */
function handoffCsvDelimiterSpelling(csvDelimiter: string): string {
  return csvDelimiter === "\t" ? "tab" : csvDelimiter;
}

/**
 * What the MANAGER knows about the run that the intent does not: whether the
 * credential was pasted, and whether this console rendezvouses over a split pair.
 * A record rather than two positional flags, because the two are same-typed and a
 * transposed pair would otherwise typecheck.
 */
interface JobHandoffRunFacts {
  /**
   * Whether the sftp credential the run used was a PASTED, server-materialized
   * value rather than a file the operator owns. Forced false on the filedrop
   * channel, which has no credential.
   */
  credentialPasted: boolean;
  /**
   * Whether this console provisions the inbound/outbound rendezvous pair. Read
   * only on the filedrop channel, whose template it decides between the single
   * shared directory and the two-directory form.
   */
  filedropSplit: boolean;
  /**
   * Whether the run used the key file beside the opened configuration rather
   * than one the console wrote into the run's own folder. Absent is false.
   */
  keyFileBesideConfiguration?: boolean;
  /**
   * The configuration the operator opened off the mounted working folder, as
   * the open read it. The settings of it a run composed here does not emit are
   * written into the exchange mode's template unchanged (see
   * {@link handoffConfigDocument}). A zero-setup run composes no configuration
   * at all and reads it nowhere.
   */
  mountedDocument?: ExchangeSpec;
  /**
   * Whether the operator converted {@link mountedDocument} to the console's own
   * resources, so the template states the console's placeholders rather than
   * the paths the document read ({@link withPathsAsRead}). Absent is false.
   */
  mountedDocumentConverted?: boolean;
}

/**
 * Build the recurring-run hand-off from a job's create intent and the resources it
 * ran against, captured at job creation so it reflects exactly what ran (rather
 * than re-reading authored state that a later action could change). The exchange
 * arm recomposes the config template; the zero-setup arm the command template.
 */
export function buildJobHandoff(
  intent: JobCreateIntent,
  serverEntry: JobSftpServerEntry | undefined,
  {
    credentialPasted,
    filedropSplit,
    keyFileBesideConfiguration = false,
    mountedDocument,
    mountedDocumentConverted = false,
  }: JobHandoffRunFacts,
): JobHandoff {
  const split = intent.channel === "filedrop" && filedropSplit;
  const credentialPastedOnSftp = intent.channel === "sftp" && credentialPasted;
  if (intent.mode === "zeroSetup")
    return {
      mode: "zeroSetup",
      channel: intent.channel,
      usedKeyFile: false,
      keyFileBesideConfiguration: false,
      credentialPasted: credentialPastedOnSftp,
      usedSigningIdentity: false,
      template: buildZeroSetupHandoffTemplate(intent, serverEntry, split),
    };
  const handoffSpec = exchangeHandoffSpec(
    intent,
    serverEntry,
    split,
    mountedDocument,
    mountedDocumentConverted,
  );
  const signingSettingsToSet = unsetCertificateSigningSettings(handoffSpec);
  return {
    mode: "exchange",
    channel: intent.channel,
    usedKeyFile: true,
    keyFileBesideConfiguration,
    credentialPasted: credentialPastedOnSftp,
    usedSigningIdentity: intent.signing?.mode === "certificate",
    ...(signingSettingsToSet.length > 0 ? { signingSettingsToSet } : {}),
    template: buildExchangeHandoffTemplate(handoffSpec, mountedDocument),
  };
}
