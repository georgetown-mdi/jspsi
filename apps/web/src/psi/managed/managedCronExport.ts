/**
 * The command-line export of a managed (recurring) exchange: the record
 * composed into the two files `alcove exchange` opens -- `alcove.yaml` and
 * `.alcove.key` -- plus the command that runs them, letting an operator with
 * a host scheduler move a managed exchange onto the CLI
 * (docs/MANAGED_EXCHANGE.md, "Who this is for").
 *
 * This module is the pure half -- no download, no store write, no spend.
 *
 * - It SPLITS the export artifact rather than serializing a second format.
 *   The config text is core's {@link serializeExchangeDocument}, the writer
 *   Alcove's own `saveConfig` uses, and the key fields are the artifact
 *   module's {@link keyFileFieldsFromRecord}: the CLI's own file shapes
 *   (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"). This adds only
 *   the two files' framing and the two fields the artifact does not hold.
 * - It INJECTS a webrtc `connection.role` from the record's local `side`, at
 *   export time only: the stored document holds none (the spec's "Role: a
 *   local `side` field, not the document"), while the CLI derives its
 *   rendezvous peer id from `role` (`apps/cli/src/protocol.ts`). The sftp and
 *   filedrop connections have no `role`, and their records no `side`. Nothing
 *   here writes back.
 * - It INCLUDES the max-age policy in the document as
 *   `authentication.token_max_age_days`: the CLI stamps a rotated token's
 *   `expires` only from that config key. The EXPORTED document may hold an
 *   `authentication` block while the STORED document must not (the read-path
 *   refine in {@link ./managedExchangeRecord.ts}); the spelling is the
 *   block's operator-authored, secret-free one, and the block is a strict
 *   object, so a typo fails closed.
 * - It REFUSES any stored document the app could not have held: a
 *   connection holding a field outside what a configuration on its channel
 *   holds, or a literal credential, a stored `authentication` block, or a
 *   top-level document field outside what a command-line configuration holds.
 *   Each is reachable only by importing a hand-crafted artifact, whose embedded
 *   document validates against the full exchange schema -- which can represent
 *   a TURN `credential`, a `provider_options` map, an `ice_provision` auth
 *   block, a PeerJS `server.key`/`server.username`, and a shared secret. A
 *   connection on a channel this app does not run exports like any other:
 *   exporting it is how the operator runs it, and an sftp `@path` reference it
 *   holds is written back as read, for the CLI to resolve
 *   (`apps/cli/src/util/atSignRefs.ts`). A `signing` block a configuration-only
 *   record holds is written back as read too; the record schema refuses one
 *   beside a secret, so no artifact installs it.
 *
 * The key file is a plaintext credential under the CLI key file's own trust
 * model: custody and storage permissions, never a passphrase (the spec's
 * "Plaintext, custody-protected"; docs/SECURITY_DESIGN.md, "Key file
 * security"). The configuration half holds no secret -- the shared secret
 * and any `expires` ride the key file alone.
 */

import { ExchangeSpecSchema, serializeExchangeDocument } from "@alcove/core";

import {
  connectionFieldsNotHeld,
  fieldsOutsideComposableDocument,
  literalCredentialFields,
} from "./managedCommandLineDocument";
import { keyFileFieldsFromRecord } from "./managedExchangeArtifact";

import type { ConnectionConfig, ExchangeSpec } from "@alcove/core";
import type {
  ManagedExchangeKeyFields,
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";

/** The config file name `alcove exchange` reads at its default config path
 * (`DEFAULT_CONFIG_PATH`, `apps/cli/src/config.ts`), so a run in the folder
 * holding the exported files needs no `--config-file`. */
export const CRON_EXPORT_CONFIG_FILE_NAME = "alcove.yaml";

/** The key file name `alcove exchange` reads at its default key path
 * (`DEFAULT_KEY_PATH`, `apps/cli/src/keyFile.ts`), so a run in the folder holding
 * the exported files needs no `--key-file`. */
export const CRON_EXPORT_KEY_FILE_NAME = ".alcove.key";

/** The input CSV the emitted command links. Which of the operator's files to
 * link is the one value a record cannot supply, and it is a positional argument
 * of the command rather than a hole in the exported configuration. */
export const CRON_EXPORT_INPUT_FILE_NAME = "input.csv";

/** The results file the emitted command writes. Passing an output path (rather
 * than defaulting to stdout) is what gets the matched-records CSV the owner-only
 * treatment the key file gets -- a shell redirect leaves it at the umask (see
 * docs/SECURITY_DESIGN.md, "Key file security", Result CSV output). */
export const CRON_EXPORT_OUTPUT_FILE_NAME = "results.csv";

/** The media type the configuration half is written to disk under: the exchange
 * document is the YAML the CLI's config loader reads. */
export const CRON_EXPORT_CONFIG_MIME = "application/yaml";

/** The media type the key half is written to disk under: `.alcove.key` is the
 * JSON document the CLI's key-file reader parses. */
export const CRON_EXPORT_KEY_MIME = "application/json";

/** One exported file: the name it must be saved under for the emitted command to
 * find it, its exact contents, and the media type it is written under. */
interface ManagedCronExportFile {
  /** The file name the CLI opens this content at. */
  fileName: string;
  /** The file's contents, ready to write verbatim. */
  text: string;
  /** The media type a download writes the file under. */
  mimeType: string;
}

/**
 * The configuration half of the command-line hand-off: the `alcove.yaml` the
 * CLI loads, and the invocation that runs it. The command names no path from
 * any machine -- the config and key are read at their defaults -- so it runs in
 * the folder the file is saved to, rather than a template with placeholders to
 * fill. It holds no secret, which is what lets a configuration-only record
 * compose it: an sftp credential it names is an `@path` reference.
 */
export interface ManagedCommandLineConfig {
  /** The `alcove.yaml` half: the exchange-file document, with `role` injected
   * and any max-age policy held, and no secret. */
  config: ManagedCronExportFile;
  /** The command to run in the folder holding that file, and the key file where
   * the exchange has one. */
  command: string;
}

/**
 * Everything the operator needs to run a managed exchange from the command
 * line: the two files and the invocation.
 */
export interface ManagedCronExport extends ManagedCommandLineConfig {
  /** The `.alcove.key` half: the shared secret and any `expires`. A plaintext
   * credential -- this is the file the handover's custody rules are about. */
  key: ManagedCronExportFile;
}

/**
 * Narrow a record's stored connection to what a configuration on its channel
 * holds, refusing any field outside it -- the exchange-file schema alone
 * admits the credential-bearing fields -- and any credential stated as a
 * literal value rather than an `@path`. A hard refusal, not a warning: this is
 * content the import would have refused, reachable only through a hand-crafted
 * artifact.
 */
function heldConnectionOrRefuse(exchangeFile: ExchangeSpec): ConnectionConfig {
  const connection = exchangeFile.connection;
  const outside = connectionFieldsNotHeld(connection);
  if (outside.length > 0)
    throw new Error(
      "a managed exchange is exported to the command line only from the " +
        `connection settings this app holds on ${connection.channel}; the ` +
        "stored connection carries field(s) outside them, which the exported " +
        "alcove.yaml would republish for the CLI to resolve. Remove: " +
        outside.join(", "),
    );
  const literal = literalCredentialFields(connection);
  if (literal.length > 0)
    throw new Error(
      "a managed exchange's exported alcove.yaml names a credential only as " +
        "an @path reference; the stored connection states one as a value. " +
        "Remove: " +
        literal.join(", "),
    );
  return connection;
}

/**
 * The connection the export writes: the stored one, with a webrtc `role` set
 * from the record's `side`. A webrtc record always holds a side (the record
 * schema binds the two), so a missing one is refused rather than exported
 * roleless for the CLI to refuse at the operator's first scheduled run.
 */
function exportedConnection(
  connection: ConnectionConfig,
  record: ManagedExchangeRecord,
): ConnectionConfig {
  if (connection.channel !== "webrtc") return connection;
  if (record.side === undefined)
    throw new Error(
      "a managed webrtc exchange is exported with the side it runs as; the " +
        "stored record holds none",
    );
  return { ...connection, role: record.side };
}

/**
 * Refuse a stored document holding an `authentication` block: the composed
 * document's block is injected from the record's local max-age policy alone,
 * so a stored one would ride the document spread into the configuration half
 * -- `shared_secret` and all. The record read path refines such a document
 * away ({@link ./managedExchangeRecord.ts}); this is that invariant enforced
 * as a check on the shape the composer is actually handed.
 */
function assertNoStoredAuthentication(exchangeFile: ExchangeSpec): void {
  if (exchangeFile.authentication !== undefined)
    throw new Error(
      "a managed exchange's stored document carries no authentication block; " +
        "the exported configuration's block is composed from the local " +
        "max-age policy alone, so a stored one is refused rather than " +
        "republished",
    );
}

/**
 * Refuse a document holding a top-level field outside what a command-line
 * configuration holds ({@link fieldsOutsideComposableDocument}), so the
 * document spread cannot republish a field no import admitted into the
 * emitted alcove.yaml.
 */
function assertComposableDocumentFields(document: ExchangeSpec): void {
  const outside = fieldsOutsideComposableDocument(document);
  if (outside.length > 0)
    throw new Error(
      "a managed exchange is exported to the command line only from the " +
        "document fields a command-line configuration holds here; the stored " +
        "document carries field(s) outside them, which the exported " +
        "alcove.yaml would republish. Remove: " +
        outside.join(", "),
    );
}

/**
 * Compose the exchange-file document the export holds: the stored document
 * with a webrtc `role` set from the record's `side` and, when the record holds
 * a max-age policy, an `authentication` block holding it. Returns the schema's
 * parse result rather than the assembled input, matching
 * `assembleExchangeSpec`'s discipline, so a value the exchange-file schema
 * would not accept fails here rather than at the operator's first scheduled
 * run.
 *
 * @throws {Error} if the stored connection holds a field or a literal
 *   credential the app does not hold, a webrtc record holds no side, the
 *   stored document holds an `authentication` block, or it holds a top-level
 *   field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
function composeCronExportDocument(
  record: ManagedExchangeRecord,
): ExchangeSpec {
  const connection = heldConnectionOrRefuse(record.exchangeFile);
  assertNoStoredAuthentication(record.exchangeFile);
  const document = ExchangeSpecSchema.parse({
    ...record.exchangeFile,
    connection: exportedConnection(connection, record),
    ...(record.tokenMaxAgeDays !== undefined
      ? { authentication: { tokenMaxAgeDays: record.tokenMaxAgeDays } }
      : {}),
  });
  assertComposableDocumentFields(document);
  return document;
}

/**
 * Serialize the key pair to the `.alcove.key` bytes the CLI reads: pretty-printed
 * JSON with a trailing newline, `camelCase` keys, matching the CLI's own key-file
 * write (`saveKeyFile`, `apps/cli/src/keyFile.ts`) so the exported file is
 * byte-shaped like one the CLI wrote itself.
 */
function serializeKeyFile(fields: ManagedExchangeKeyFields): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

/**
 * Compose a managed record's configuration half: the `alcove.yaml` file and
 * the command that runs it. Pure, and available to every stored record --
 * including a configuration-only one, whose key file stayed with the machine
 * that runs it and which has no key half to compose.
 *
 * The emitted command is `alcove exchange`'s real invocation --
 * `[options] INPUT_FILE [OUTPUT_FILE]`, with the config and key read at their
 * defaults (`apps/cli/src/commands/exchange.ts`).
 *
 * @throws {Error} if the record's stored connection holds a field or a
 *   literal credential the app does not hold, or its stored document holds an
 *   `authentication` block or a top-level field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExportConfig(
  record: ManagedExchangeRecord,
): ManagedCommandLineConfig {
  return {
    config: {
      fileName: CRON_EXPORT_CONFIG_FILE_NAME,
      text: serializeExchangeDocument(composeCronExportDocument(record)),
      mimeType: CRON_EXPORT_CONFIG_MIME,
    },
    command:
      `alcove exchange ${CRON_EXPORT_INPUT_FILE_NAME} ` +
      CRON_EXPORT_OUTPUT_FILE_NAME,
  };
}

/**
 * Compose a managed record into the CLI's two files and the command that runs
 * them: the configuration half above, plus the key file. Pure: the record is
 * read, never written, and no marker, spend, or download is involved. The
 * record type is the runnable one, so the key half cannot be asked of a record
 * that holds no secret.
 *
 * @throws {Error} if the record's stored connection holds a field or a
 *   literal credential the app does not hold, or its stored document holds an
 *   `authentication` block or a top-level field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExport(
  record: RunnableManagedExchangeRecord,
): ManagedCronExport {
  const { config, command } = composeManagedCronExportConfig(record);
  return {
    config,
    key: {
      fileName: CRON_EXPORT_KEY_FILE_NAME,
      text: serializeKeyFile(keyFileFieldsFromRecord(record)),
      mimeType: CRON_EXPORT_KEY_MIME,
    },
    command,
  };
}
