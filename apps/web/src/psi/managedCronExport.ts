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
 * - It REFUSES a record whose document is not a webrtc connection, the way the
 *   re-run dispatch gate refuses one ({@link ./managedRendezvous.ts}). No UI path
 *   composes such a record -- a managed connection is a credential-free webrtc
 *   locator by composition -- so the shape is reachable only by importing a
 *   hand-crafted artifact, and a document arriving that way could carry another
 *   machine's credential `@path` that this export would otherwise republish.
 *
 * The key file is a plaintext credential handed over under the CLI key file's own
 * trust model: custody and storage permissions, never a passphrase (the spec's
 * "Plaintext, custody-protected"; docs/SECURITY_DESIGN.md, "Key file security").
 * The configuration half carries no secret at all -- the shared secret and any
 * `expires` ride the key file alone -- which is what lets the two files be handled
 * differently once they land.
 */

import { ExchangeSpecSchema } from "@psilink/core";

import {
  keyFileFieldsFromRecord,
  serializeExchangeDocument,
} from "./managedExchangeArtifact";

import type { ExchangeSpec, WebRTCConnectionConfig } from "@psilink/core";
import type { ManagedExchangeArtifactKey } from "./managedExchangeArtifact";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

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
 * Narrow a record's stored connection to the webrtc arm, refusing any other
 * channel. Mirrors the re-run dispatch gate (`assertManagedRerunDispatchable`,
 * ./managedRendezvous.ts): an allowlist on the `channel` discriminant, read
 * before anything is composed, so a record the app could not have created is
 * refused rather than exported. The refusal names the stored channel, a
 * schema-validated discriminant rather than free text.
 */
function webrtcConnectionOrRefuse(
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
  return connection;
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
 * @throws {Error} if the stored connection is not the webrtc channel.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
function composeCronExportDocument(
  record: ManagedExchangeRecord,
): ExchangeSpec {
  const connection = webrtcConnectionOrRefuse(record.exchangeFile);
  return ExchangeSpecSchema.parse({
    ...record.exchangeFile,
    connection: { ...connection, role: record.side },
    ...(record.tokenMaxAgeDays !== undefined
      ? { authentication: { tokenMaxAgeDays: record.tokenMaxAgeDays } }
      : {}),
  });
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
 * @throws {Error} if the record's stored connection is not the webrtc channel.
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
