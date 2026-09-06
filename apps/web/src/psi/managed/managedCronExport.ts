/**
 * The command-line export of a managed (recurring) exchange: the record
 * composed into the two files `psilink exchange` opens -- `psilink.yaml` and
 * `.psilink.key` -- plus the command that runs them, letting an operator with
 * a host scheduler move a managed exchange onto the CLI
 * (docs/MANAGED_EXCHANGE.md, "Who this is for").
 *
 * This module is the pure half -- no download, no store write, no spend.
 *
 * - It SPLITS the export artifact rather than serializing a second format.
 *   The config text and the key fields come from the artifact module's own
 *   two derivations ({@link serializeExchangeDocument},
 *   {@link keyFileFieldsFromRecord}), which are the CLI's own file shapes
 *   (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"). This adds only
 *   the two files' framing and the two fields the artifact does not hold.
 * - It INJECTS `connection.role` from the record's local `side`, at export
 *   time only: the stored document holds none (the spec's "Role: a local
 *   `side` field, not the document"), while the CLI derives its rendezvous
 *   peer id from `role` (`apps/cli/src/protocol.ts`). Nothing here writes
 *   back.
 * - It INCLUDES the max-age policy in the document as
 *   `authentication.token_max_age_days`: the CLI stamps a rotated token's
 *   `expires` only from that config key. The EXPORTED document may hold an
 *   `authentication` block while the STORED document must not (the read-path
 *   refine in {@link ./managedExchangeRecord.ts}); the spelling is the
 *   block's operator-authored, secret-free one, and the block is a strict
 *   object, so a typo fails closed.
 * - It REFUSES any stored document the app could not have composed: a
 *   connection on another channel (as the re-run dispatch gate refuses one,
 *   {@link ./managedRendezvous.ts}), a webrtc connection holding a field
 *   outside the credential-free locator subset, a stored `authentication`
 *   block, or a top-level document field outside the record composer's own
 *   input. Each is reachable only by importing a hand-crafted artifact, whose
 *   embedded document validates against the full exchange schema -- which can
 *   represent a TURN `credential`, a `provider_options` map, an
 *   `ice_provision` auth block, a PeerJS `server.key`/`server.username`, a
 *   shared secret, and a `signing` block (`identity_file`, `receipt_output`,
 *   `partner_fingerprint`), and the CLI resolves an `@path` in the file it
 *   loads (`apps/cli/src/util/atSignRefs.ts`). Republishing one would aim the
 *   operator's scheduled run at another party's credential file.
 *
 * The key file is a plaintext credential under the CLI key file's own trust
 * model: custody and storage permissions, never a passphrase (the spec's
 * "Plaintext, custody-protected"; docs/SECURITY_DESIGN.md, "Key file
 * security"). The configuration half holds no secret -- the shared secret
 * and any `expires` ride the key file alone.
 */

import {
  ExchangeSpecSchema,
  connectionFromLocator,
  getDefaultLinkageTerms,
  snakeizeKey,
} from "@psilink/core";

import {
  keyFileFieldsFromRecord,
  serializeExchangeDocument,
} from "./managedExchangeArtifact";
import { composeManagedExchangeFile } from "./managedExchangeRecord";

import type {
  ExchangeSpec,
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type {
  ManagedExchangeFileComposition,
  ManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { ManagedExchangeArtifactKey } from "./managedExchangeArtifact";

/** The config file name `psilink exchange` reads at its default config path
 * (`DEFAULT_CONFIG_PATH`, `apps/cli/src/config.ts`), so a run in the folder
 * holding the exported files needs no `--config-file`. */
export const CRON_EXPORT_CONFIG_FILE_NAME = "psilink.yaml";

/** The key file name `psilink exchange` reads at its default key path
 * (`DEFAULT_KEY_PATH`, `apps/cli/src/keyFile.ts`), so a run in the folder holding
 * the exported files needs no `--key-file`. */
export const CRON_EXPORT_KEY_FILE_NAME = ".psilink.key";

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

/** The media type the key half is written to disk under: `.psilink.key` is the
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
 * Everything the operator needs to run a managed exchange from the command line:
 * the two files and the invocation. Nothing here is machine-specific -- a managed
 * connection is a credential-free webrtc locator with no path, no credential, and
 * no rendezvous directory -- so the command is turnkey in the folder the two files
 * are saved to, rather than a template with placeholders to fill.
 */
export interface ManagedCronExport {
  /** The `psilink.yaml` half: the exchange-file document, with `role` injected
   * and any max-age policy held, and no secret. */
  config: ManagedCronExportFile;
  /** The `.psilink.key` half: the shared secret and any `expires`. A plaintext
   * credential -- this is the file the handover's custody rules are about. */
  key: ManagedCronExportFile;
  /** The command to run in the folder holding the two files above. */
  command: string;
}

/**
 * The locator both composition probes below are driven with: a webrtc locator
 * holding every optional field, so what each probe measures is the widest shape
 * the app can compose rather than the narrowest.
 */
const WIDEST_PROBE_LOCATOR: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "locator.invalid",
  port: 443,
  path: "/",
};

/**
 * The field names a credential-free webrtc locator expands to, at the
 * connection and its nested `server`. Read off {@link connectionFromLocator}'s
 * own webrtc arm rather than restated, so the allowlist cannot drift from the
 * composition rule (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection
 * block: credential-free by composition").
 */
function credentialFreeLocatorFields(): {
  connection: ReadonlySet<string>;
  server: ReadonlySet<string>;
} {
  const composed = connectionFromLocator(WIDEST_PROBE_LOCATOR);
  if (composed.channel !== "webrtc")
    throw new Error(
      "the credential-free locator expansion did not compose a webrtc " +
        "connection from a webrtc locator",
    );
  return {
    connection: new Set(Object.keys(composed)),
    server: new Set(Object.keys(composed.server)),
  };
}

const CREDENTIAL_FREE_LOCATOR_FIELDS = credentialFreeLocatorFields();

/**
 * The stored connection's fields that a credential-free locator does not expand
 * to, named in the operator's own snake_case spelling so a refusal points at the
 * lines to remove. Names only -- a field's VALUE is the credential (a TURN
 * secret, a bearer token, an `@path` naming another machine's file) and never
 * enters the message.
 */
function fieldsOutsideLocatorSubset(
  connection: WebRTCConnectionConfig,
): Array<string> {
  const outside = Object.keys(connection).filter(
    (field) => !CREDENTIAL_FREE_LOCATOR_FIELDS.connection.has(field),
  );
  // Typed as required, but this gate runs on a record shape that reached the
  // composer without the read path's validation, so the nested object is read
  // defensively: a missing `server` is the exchange schema's refusal to make,
  // not a TypeError here.
  const server: unknown = connection.server;
  const serverFields =
    typeof server === "object" && server !== null ? Object.keys(server) : [];
  return [
    ...outside.map((field) => snakeizeKey(field)),
    ...serverFields
      .filter((field) => !CREDENTIAL_FREE_LOCATOR_FIELDS.server.has(field))
      .map((field) => `server.${snakeizeKey(field)}`),
  ].sort();
}

/**
 * Narrow a record's stored connection to the credential-free webrtc locator
 * the app composes, refusing any other channel (mirroring the re-run dispatch
 * gate, `assertManagedRerunDispatchable`, ./managedRendezvous.ts) and any
 * field outside that locator's expansion -- the exchange-file schema alone
 * admits the credential-bearing webrtc fields. A hard refusal, not a warning:
 * this is remote content the operator cannot inspect.
 */
function webrtcLocatorConnectionOrRefuse(
  exchangeFile: ExchangeSpec,
): WebRTCConnectionConfig {
  const connection = exchangeFile.connection;
  if (connection.channel !== "webrtc")
    throw new Error(
      "a managed exchange is exported to the command line only as a webrtc " +
        "exchange, the one channel this app runs; stored connection channel " +
        "is " +
        connection.channel,
    );
  const outside = fieldsOutsideLocatorSubset(connection);
  if (outside.length > 0)
    throw new Error(
      "a managed exchange is exported to the command line only from the " +
        "credential-free webrtc locator this app composes (the signaling " +
        "server's host, port, and path); the stored connection carries " +
        "field(s) outside it, which the exported psilink.yaml would republish " +
        "for the CLI to resolve. Remove: " +
        outside.join(", "),
    );
  return connection;
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
 * The top-level document fields the app can put in a stored document, measured
 * by composing one. Typed `Required<ManagedExchangeFileComposition>`, so a
 * field added to the record composer's input fails this module's compile
 * until the probe holds it. Read off {@link composeManagedExchangeFile}'s
 * OUTPUT, not its input: the probe measures which KEYS survive composition,
 * never what they hold.
 */
function composableDocumentFields(): ReadonlySet<string> {
  const widestComposition: Required<ManagedExchangeFileComposition> = {
    connection: WIDEST_PROBE_LOCATOR,
    linkageTerms: getDefaultLinkageTerms("composition probe"),
    metadata: [],
    standardization: [],
    disclosedPayloadColumns: [],
    expectedPayloadColumns: [],
    expectedPartnerDeduplicate: false,
    outboundPayloadConsent: { status: "pending" },
    includeOwnColumns: "all",
  };
  return new Set(Object.keys(composeManagedExchangeFile(widestComposition)));
}

/**
 * The top-level fields the exported document may hold: what the app can compose
 * (above), plus the `authentication` block this module injects from the local
 * max-age policy, plus the `retentionDisposition` the record spec sanctions on a
 * stored document as operator-authored free text
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `exchangeFile` row). Nothing else the
 * shared exchange-file schema can represent belongs in an exported psilink.yaml.
 */
const EXPORTED_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
  ...composableDocumentFields(),
  "authentication",
  "retentionDisposition",
]);

/**
 * The composed document's top-level fields outside {@link EXPORTED_DOCUMENT_FIELDS},
 * named in the operator's own snake_case spelling so a refusal points at the lines
 * to remove. Names only -- a field's VALUE is what the CLI would act on (a path it
 * opens as this party's signing identity, a path it writes a receipt to, a
 * fingerprint it pins a partner certificate against) and never enters the message.
 */
function fieldsOutsideComposableDocument(
  document: ExchangeSpec,
): Array<string> {
  return Object.keys(document)
    .filter((field) => !EXPORTED_DOCUMENT_FIELDS.has(field))
    .map((field) => snakeizeKey(field))
    .sort();
}

/**
 * Refuse a document holding a top-level field the app could not have
 * composed: the exchange-file schema is broader than the record composer --
 * it admits a `signing` block -- and it is what an imported artifact's
 * embedded document validates against, so this gate keeps the document
 * spread from republishing a hand-crafted field into the emitted
 * psilink.yaml. A hard refusal, not a warning: this is remote content the
 * operator cannot inspect.
 */
function assertComposableDocumentFields(document: ExchangeSpec): void {
  const outside = fieldsOutsideComposableDocument(document);
  if (outside.length > 0)
    throw new Error(
      "a managed exchange is exported to the command line only from the " +
        "document this app composes (the agreed linkage terms, this party's " +
        "metadata, standardization, and payload commitments, and the " +
        "credential-free webrtc locator); the stored document carries " +
        "field(s) outside it, which the exported psilink.yaml would republish " +
        "for the CLI to open, write, or pin. Remove: " +
        outside.join(", "),
    );
}

/**
 * Compose the exchange-file document the export holds: the stored document
 * with `role` set from the record's `side` and, when the record holds a
 * max-age policy, an `authentication` block holding it. Returns the schema's
 * parse result rather than the assembled input, matching
 * `assembleExchangeSpec`'s discipline, so a value the exchange-file schema
 * would not accept fails here rather than at the operator's first scheduled
 * run.
 *
 * @throws {Error} if the stored connection is not a credential-free webrtc
 *   locator, the stored document holds an `authentication` block, or it
 *   holds a top-level field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
function composeCronExportDocument(
  record: ManagedExchangeRecord,
): ExchangeSpec {
  const connection = webrtcLocatorConnectionOrRefuse(record.exchangeFile);
  assertNoStoredAuthentication(record.exchangeFile);
  const document = ExchangeSpecSchema.parse({
    ...record.exchangeFile,
    connection: { ...connection, role: record.side },
    ...(record.tokenMaxAgeDays !== undefined
      ? { authentication: { tokenMaxAgeDays: record.tokenMaxAgeDays } }
      : {}),
  });
  assertComposableDocumentFields(document);
  return document;
}

/**
 * Serialize the key pair to the `.psilink.key` bytes the CLI reads: pretty-printed
 * JSON with a trailing newline, `camelCase` keys, matching the CLI's own key-file
 * write (`saveKeyFile`, `apps/cli/src/keyFile.ts`) so the exported file is
 * byte-shaped like one the CLI wrote itself.
 */
function serializeKeyFile(fields: ManagedExchangeArtifactKey): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

/**
 * Compose a managed record into the CLI's two files and the command that runs
 * them. Pure: the record is read, never written, and no marker, spend, or
 * download is involved.
 *
 * The emitted command is `psilink exchange`'s real invocation --
 * `[options] INPUT_FILE [OUTPUT_FILE]`, with the config and key read at their
 * defaults (`apps/cli/src/commands/exchange.ts`).
 *
 * @throws {Error} if the record's stored connection is not a credential-free
 *   webrtc locator, or its stored document holds an `authentication` block
 *   or a top-level field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExport(
  record: ManagedExchangeRecord,
): ManagedCronExport {
  return {
    config: {
      fileName: CRON_EXPORT_CONFIG_FILE_NAME,
      text: serializeExchangeDocument(composeCronExportDocument(record)),
      mimeType: CRON_EXPORT_CONFIG_MIME,
    },
    key: {
      fileName: CRON_EXPORT_KEY_FILE_NAME,
      text: serializeKeyFile(keyFileFieldsFromRecord(record)),
      mimeType: CRON_EXPORT_KEY_MIME,
    },
    command:
      `psilink exchange ${CRON_EXPORT_INPUT_FILE_NAME} ` +
      CRON_EXPORT_OUTPUT_FILE_NAME,
  };
}
