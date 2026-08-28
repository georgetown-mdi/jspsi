/**
 * The command-line export of a managed (recurring) exchange: the record composed
 * into the two files `psilink exchange` actually opens -- a `psilink.yaml` and a
 * `.psilink.key` -- plus the command line that runs them, so an operator with a
 * host scheduler can move a managed exchange onto the CLI (see
 * docs/MANAGED_EXCHANGE.md, "Who this is for": the installed-app automation is
 * first-class for the no-IT persona, and the CLI plus host cron is the graduation
 * path for an organization that can vet and operate installed software).
 *
 * This module is the pure half -- no download, no store write, no spend -- so the
 * composition rules below are unit-testable without a database or a save dialog:
 *
 * - It SPLITS the export artifact rather than serializing a second format. The
 *   config text and the key fields come from the artifact module's own two
 *   derivations ({@link serializeExchangeDocument},
 *   {@link keyFileFieldsFromRecord}), whose halves are already committed to the
 *   CLI's file shapes (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"),
 *   so the browser holds one exchange-document encoder and one key-pair
 *   derivation rather than two that could drift. What this adds is the two files'
 *   framing and the two fields the artifact deliberately does not carry.
 * - It INJECTS `connection.role` from the record's local `side`, at export time
 *   only. The stored document deliberately carries none and no browser path reads
 *   one (the spec's "Role: a local `side` field, not the document"), while the CLI
 *   derives its rendezvous peer id from `role` and refuses a webrtc run that
 *   carries none (`apps/cli/src/protocol.ts`). The composed document is a derived
 *   value: nothing here writes back, so an export leaves the record untouched.
 * - It CARRIES the max-age policy into the document as
 *   `authentication.token_max_age_days`. The policy is a browser-local record
 *   field the CLI cannot see, and the CLI stamps a rotated token's `expires` only
 *   from that config key, so an export without it hands over a bound that lapses
 *   silently at the first CLI rotation. This is the one asymmetry to hold in mind:
 *   the EXPORTED document may carry an `authentication` block while the STORED
 *   document must not (the read-path refine in {@link ./managedExchangeRecord.ts}).
 *   The spelling is the block's operator-authored, secret-free one -- the CLI's
 *   loader warn-and-strips the key-file-injected `shared_secret`/`expires`, and
 *   the block is a strict object, so a typo fails closed rather than silently
 *   disabling max-age enforcement.
 * - It REFUSES any stored document the app could not have composed: a connection
 *   on another channel (the way the re-run dispatch gate refuses one,
 *   {@link ./managedRendezvous.ts}), a webrtc connection carrying a field outside
 *   the credential-free locator subset, an `authentication` block on the stored
 *   document, and any top-level document field outside the record composer's own
 *   input. None of the four is composable through the app -- a managed connection
 *   is a credential-free webrtc locator by composition, the record read path
 *   refines an `authentication` block away, and the composition input carries no
 *   other field -- so each is reachable only by importing a hand-crafted artifact,
 *   whose embedded document is validated against the full exchange schema. That
 *   schema CAN represent a TURN `credential`, an opaque `provider_options` map, an
 *   `ice_provision` auth block, a PeerJS `server.key`/`server.username`, a shared
 *   secret, and a `signing` block, and the CLI resolves an `@path` in the file it
 *   loads (`apps/cli/src/util/atSignRefs.ts`), so republishing one would aim the
 *   operator's own scheduled run at another party's credential file. The `signing`
 *   block is live on that run in three ways: `identity_file` is opened as this
 *   party's private signing identity (`resolveSigningPersist`,
 *   `apps/cli/src/commands/exchange.ts`), `receipt_output` is written verbatim
 *   (`resolveReceiptOutput`, `apps/cli/src/receiptFile.ts`), and
 *   `partner_fingerprint` is the pin a presented partner certificate is trusted
 *   against.
 *
 * The key file is a plaintext credential handed over under the CLI key file's own
 * trust model: custody and storage permissions, never a passphrase (the spec's
 * "Plaintext, custody-protected"; docs/SECURITY_DESIGN.md, "Key file security").
 * The configuration half carries no secret at all -- the shared secret and any
 * `expires` ride the key file alone -- which is what lets the two files be handled
 * differently once they land.
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

/** One exported file: the name it must be saved under for the emitted command to
 * find it, and its exact contents. */
export interface ManagedCronExportFile {
  /** The file name the CLI opens this content at. */
  fileName: string;
  /** The file's contents, ready to write verbatim. */
  text: string;
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
   * and any max-age policy carried, and no secret. */
  config: ManagedCronExportFile;
  /** The `.psilink.key` half: the shared secret and any `expires`. A plaintext
   * credential -- this is the file the handover's custody rules are about. */
  key: ManagedCronExportFile;
  /** The command to run in the folder holding the two files above. */
  command: string;
}

/**
 * The locator both composition probes below are driven with: a webrtc locator
 * carrying every optional field, so what each probe measures is the widest shape
 * the app can compose rather than the narrowest.
 */
const WIDEST_PROBE_LOCATOR: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "locator.invalid",
  port: 443,
  path: "/",
};

/**
 * The field names a credential-free webrtc locator expands to, at the connection
 * and at its nested `server`. Read off {@link connectionFromLocator}'s own webrtc
 * arm rather than restated, so the allowlist IS the composition rule the stored
 * document's credential-freedom rests on (docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "The connection block: credential-free by composition") and cannot drift from
 * it: a locator field that expansion starts writing is admitted here with no
 * second list to update, and every other field the shared webrtc connection
 * schema can represent is outside the subset by construction.
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
 * Narrow a record's stored connection to the credential-free webrtc locator the
 * app composes, refusing any other channel and any field outside that locator's
 * expansion. The channel arm mirrors the re-run dispatch gate
 * (`assertManagedRerunDispatchable`, ./managedRendezvous.ts): an allowlist on the
 * `channel` discriminant, read before anything is composed. The field arm holds
 * an imported document to the composition rule the exchange-file schema alone
 * does not enforce -- that schema admits the credential-bearing webrtc fields, so
 * an artifact carrying them imports cleanly and would otherwise be republished
 * verbatim into the emitted `psilink.yaml`.
 *
 * A hard refusal rather than a warning: this is remote content the operator
 * cannot inspect (the partner's or a third party's hand-crafted artifact), not
 * the operator's own choice about their own machine.
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
 * Refuse a stored document carrying an `authentication` block. The composed
 * document's block is injected from the record's local max-age policy alone, so
 * a stored one would ride the document spread into the configuration half --
 * `shared_secret` and all -- beside or instead of the policy. The record read
 * path refines such a document away ({@link ./managedExchangeRecord.ts}), so this
 * is that invariant as a check on the shape the composer is actually handed
 * rather than a comment asserting the read path already ran.
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
 * The top-level document fields the app can put in a stored document, measured by
 * composing one. The probe composition is typed
 * `Required<ManagedExchangeFileComposition>`, so a field added to the record
 * composer's input fails this module's compile until the probe carries it, and the
 * set is read off {@link composeManagedExchangeFile}'s OUTPUT rather than its
 * input, so the allowlist IS what the app can compose rather than a second list
 * beside it. Every optional block is present, and each is a minimal valid value:
 * the probe measures which KEYS survive composition, never what they hold.
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
  };
  return new Set(Object.keys(composeManagedExchangeFile(widestComposition)));
}

/**
 * The top-level fields the exported document may carry: what the app can compose
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
 * Refuse a document carrying a top-level field the app could not have composed.
 * The exchange-file schema is broader than the record composer -- it admits a
 * `signing` block, and it is what an imported artifact's embedded document is
 * validated against -- so this gate is what keeps the document spread from
 * republishing a hand-crafted field into the emitted psilink.yaml, where the CLI
 * would act on it at the operator's next scheduled run.
 *
 * A hard refusal rather than a warning, for the reason the connection gate is one:
 * this is remote content the operator cannot inspect, not a choice they made about
 * their own machine.
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
 * Compose the exchange-file document the export carries: the stored document with
 * `role` set from the record's `side` and, when the record carries a max-age
 * policy, an `authentication` block carrying it. Returns the schema's parse result
 * rather than the assembled input -- the same "use what the schema returns"
 * discipline `assembleExchangeSpec` follows -- so an injected value that the
 * exchange-file schema would not accept fails here, on the composing side, rather
 * than at the operator's first scheduled run.
 *
 * @throws {Error} if the stored connection is not a credential-free webrtc
 *   locator, the stored document carries an `authentication` block, or it carries
 *   a top-level field the app does not compose.
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
 * download is involved -- an export's effect on the source record is the caller's
 * to dispatch.
 *
 * The emitted command is `psilink exchange`'s real invocation -- `[options]
 * INPUT_FILE [OUTPUT_FILE]`, with the config and key read at their defaults
 * (`apps/cli/src/commands/exchange.ts`) -- so it carries no flag the CLI does not
 * have and no path from any machine.
 *
 * @throws {Error} if the record's stored connection is not a credential-free
 *   webrtc locator, or its stored document carries an `authentication` block or a
 *   top-level field the app does not compose.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExport(
  record: ManagedExchangeRecord,
): ManagedCronExport {
  return {
    config: {
      fileName: CRON_EXPORT_CONFIG_FILE_NAME,
      text: serializeExchangeDocument(composeCronExportDocument(record)),
    },
    key: {
      fileName: CRON_EXPORT_KEY_FILE_NAME,
      text: serializeKeyFile(keyFileFieldsFromRecord(record)),
    },
    command:
      `psilink exchange ${CRON_EXPORT_INPUT_FILE_NAME} ` +
      CRON_EXPORT_OUTPUT_FILE_NAME,
  };
}
