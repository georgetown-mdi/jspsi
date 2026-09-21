/**
 * Reading a command-line `psilink.yaml` back into this browser as a
 * CONFIGURATION-ONLY managed exchange: the settings to edit and export again,
 * with no secret and no run here (docs/MANAGED_EXCHANGE.md, "Bringing a
 * command-line configuration back"; docs/spec/MANAGED_EXCHANGE_RECORD.md, "The
 * configuration-only record").
 *
 * The file is untrusted structured input and is read exactly as the artifact's
 * embedded document is: the shared sensitive-YAML chokepoint (bounded parse,
 * path-only errors), then the shared `@psilink/core` exchange-file schema. What
 * reaches storage is the schema's own parse result with two fields taken out of
 * it, so no key the schema does not name can ride into the record.
 *
 * Two fields of the document are LOCAL fields of the record rather than document
 * fields, and each is read out of the document and dropped from it -- exactly
 * the two the export injects on the way out ({@link ./managedCronExport.ts}), so
 * an unedited import and re-export yield the same document:
 *
 * - `connection.role` becomes the record's `side`. The document a stored record
 *   holds has none (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side`
 *   field, not the document"), and a file without one is refused: the CLI itself
 *   refuses to run a webrtc connection that names no role.
 * - `authentication.token_max_age_days` becomes the record's `tokenMaxAgeDays`.
 *   A stored document holds no `authentication` block at all, so the block is
 *   read for that one policy and dropped.
 *
 * Everything else is refused rather than trimmed. The channel must be webrtc --
 * the one channel this app runs -- and the connection and the document may hold
 * only what the app itself composes ({@link ./managedCommandLineDocument.ts}),
 * which is what keeps a partner's TURN credential, ICE provisioning block,
 * signing identity path, or `@path` reference from being stored here and handed
 * back to the CLI by the next export. A shared secret in the file is refused on
 * the same terms: this import brings back configuration, and the key file stays
 * with the machine that runs the exchange.
 */

import { parseExchangeSpec, parseSensitiveYaml } from "@psilink/core";

import {
  fieldsOutsideComposableDocument,
  fieldsOutsideLocatorSubset,
} from "./managedCommandLineDocument";
import { buildManagedExchangeRecord } from "./managedExchangeRecord";

import type { ExchangeSpec, WebRTCConnectionConfig } from "@psilink/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
} from "./managedExchangeRecord";

/** Upper bound, in bytes, on a configuration file this import will read, applied
 * before the bounded parse. The same cap the backup artifact takes: both are
 * small operator-held documents, and one control reads either. */
export const MAX_CONFIGURATION_IMPORT_BYTES = 1_000_000;

/** The label a file-name-free import starts the record at. The operator names
 * the exchange in the settings editor; an empty label is what every surface
 * already renders as an unnamed exchange. */
const IMPORTED_CONFIGURATION_LABEL = "";

/**
 * Raised when a document parses as an exchange file this app cannot hold: a
 * channel it does not run, a field outside what it composes, or a secret it does
 * not import. Its message is shown to the operator, so it states what the file
 * holds and what to do about it, and it names FIELD NAMES only -- a field's value
 * is the credential.
 */
export class ManagedConfigurationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedConfigurationRefusedError";
  }
}

/**
 * Narrow the document's connection to the credential-free webrtc locator this
 * app composes, or refuse. A hard refusal on both counts: the browser runs
 * webrtc exchanges and no other, and a field outside the locator subset is a
 * credential or a path this app would store and hand back to the command line.
 */
function importedWebrtcConnection(
  document: ExchangeSpec,
): WebRTCConnectionConfig {
  const connection = document.connection;
  if (connection.channel !== "webrtc")
    throw new ManagedConfigurationRefusedError(
      `This configuration runs over ${connection.channel}. This app runs ` +
        "webrtc exchanges only, so it cannot hold this one. Run it with " +
        "psilink on the command line instead.",
    );
  const outside = fieldsOutsideLocatorSubset(withoutRole(connection));
  if (outside.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration's connection holds settings this app does not use " +
        "and would hand back to the command line unchanged -- a credential, " +
        "an address, or a file it would open. Remove these lines from the " +
        "connection and import it again: " +
        outside.join(", ") +
        ".",
    );
  return connection;
}

/** The connection without the `role` this import consumes, so the locator
 * allowlist measures only the fields that stay in the stored document. */
function withoutRole(
  connection: WebRTCConnectionConfig,
): WebRTCConnectionConfig {
  const { role: _role, ...rest } = connection;
  return rest;
}

/**
 * The side this party takes, read from `connection.role`. A file that names none
 * is refused rather than guessed: the role decides which rendezvous id each
 * party registers under, and the CLI refuses a roleless webrtc connection on the
 * same grounds (`apps/cli/src/protocol.ts`).
 */
function importedSide(connection: WebRTCConnectionConfig): ManagedExchangeSide {
  const { role } = connection;
  if (role === undefined)
    throw new ManagedConfigurationRefusedError(
      "This configuration does not say which side of the exchange you take. " +
        "Add role: inviter or role: acceptor to its connection -- whichever " +
        "you agreed with your partner -- and import it again.",
    );
  return role;
}

/**
 * The max-age policy the document holds, refusing a secret-bearing
 * `authentication` block. The CLI reads `shared_secret` and `expires` from
 * `.psilink.key` and strips them from a configuration that names them; this
 * import refuses instead, since a browser that stored them would hold a secret
 * the operator obtained outside it and this leg brings back configuration only.
 */
function importedTokenMaxAgeDays(document: ExchangeSpec): number | undefined {
  const authentication = document.authentication;
  if (authentication === undefined) return undefined;
  const named = [
    ...(authentication.sharedSecret !== undefined ? ["shared_secret"] : []),
    ...(authentication.expires !== undefined ? ["expires"] : []),
  ];
  if (named.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration's authentication block holds " +
        named.join(" and ") +
        ". This app imports the configuration only -- the key file stays on " +
        "the machine that runs the exchange -- so remove " +
        (named.length === 1 ? "that line" : "those lines") +
        " and import it again. psilink reads the secret from .psilink.key.",
    );
  return authentication.tokenMaxAgeDays;
}

/**
 * The document a configuration-only record stores: the parsed file with the two
 * local fields taken out of it -- no `role` on the connection, no
 * `authentication` block -- re-validated so what is stored is a schema parse
 * result rather than an edited object.
 *
 * @throws {ZodError} if the document without those fields is not a valid
 *   exchange file.
 */
function storedDocument(
  document: ExchangeSpec,
  connection: WebRTCConnectionConfig,
): ExchangeSpec {
  const { authentication: _authentication, ...rest } = document;
  return parseExchangeSpec({ ...rest, connection: withoutRole(connection) });
}

/**
 * Read a command-line `psilink.yaml` as a configuration-only managed exchange
 * record: parsed, refused where this app cannot hold it, and built through
 * {@link buildManagedExchangeRecord} -- a fresh `id`, no shared secret, and the
 * record schema's own validation, whose configuration-only rule keeps every
 * run-derived field off it. Pure: nothing is stored here, so a refusal leaves
 * the store untouched.
 *
 * @throws {UsageError} if the bytes are not parseable YAML.
 * @throws {ManagedConfigurationRefusedError} if the document is one this app
 *   cannot hold (another channel, a field outside what it composes, a secret,
 *   or no role).
 * @throws {ZodError} if the document is not a valid exchange file, or the
 *   record built from it is not a valid record.
 */
export function readManagedCommandLineConfiguration(
  source: string,
): ManagedExchangeRecord {
  const raw = parseSensitiveYaml(source, "command-line exchange configuration");
  const document = parseExchangeSpec(raw);
  const connection = importedWebrtcConnection(document);
  const side = importedSide(connection);
  const tokenMaxAgeDays = importedTokenMaxAgeDays(document);
  const exchangeFile = storedDocument(document, connection);
  const outside = fieldsOutsideComposableDocument(exchangeFile);
  if (outside.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration holds settings this app does not use and would " +
        "hand back to the command line unchanged -- a file it would open, a " +
        "file it would write, or a fingerprint it would pin. Remove these " +
        "top-level lines and import it again: " +
        outside.join(", ") +
        ".",
    );
  return buildManagedExchangeRecord({
    label: IMPORTED_CONFIGURATION_LABEL,
    exchangeFile,
    side,
    ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
  });
}
