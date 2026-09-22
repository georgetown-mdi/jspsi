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
 * A document that schema refuses is refused in this app's own words, naming the
 * fields as the file spells them: the operator writes this file by hand, so what
 * stops it is a line they can fix.
 *
 * Two fields of the document are LOCAL fields of the record rather than document
 * fields, and each is read out of the document and dropped from it -- exactly
 * the two the export injects on the way out ({@link ./managedCronExport.ts}), so
 * an unedited import and re-export yield the same document:
 *
 * - A webrtc `connection.role` becomes the record's `side`. The document a
 *   stored record holds has none (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a
 *   local `side` field, not the document"), and a webrtc file without one is
 *   refused: the CLI itself refuses to run a webrtc connection that names no
 *   role. The sftp and filedrop connections have no `role` in the shared schema,
 *   so a configuration on either has no side.
 * - `authentication.token_max_age_days` becomes the record's `tokenMaxAgeDays`.
 *   A stored document holds no `authentication` block at all, so the block is
 *   read for that one policy and dropped.
 *
 * A configuration on any channel imports. This app runs webrtc exchanges only,
 * and that limit is met where a run would start rather than here: a record on
 * another channel is a configuration only, which the record's own shape keeps
 * from every run (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The configuration-only
 * record").
 *
 * Three levels are guarded against an extra key: the top-level document, the
 * connection, and connection.server (the bespoke allowlist below, since the
 * shared schema's own server blocks are not strict). Below those levels, an
 * unknown key is refused by the shared schema's unread-key comparison. The
 * document may hold only what the app itself composes, and the connection what
 * a configuration on its channel holds ({@link ./managedCommandLineDocument.ts}):
 * a credential-free locator on webrtc and filedrop, which keeps a TURN
 * credential, an ICE provisioning block, or a signing identity path from being
 * stored here, and the whole connection on sftp, whose record runs nowhere
 * here. An sftp credential is held as an `@path` reference and refused as a
 * literal value. A shared secret in the file is refused on the same terms: this
 * import brings back configuration, and the key file stays with the machine
 * that runs the exchange.
 */

import { ZodError } from "zod";

import { parseExchangeSpec, parseSensitiveYaml } from "@psilink/core";

import {
  documentValueAt,
  namedFieldList,
  refusedDocumentFields,
} from "../exchangeDocumentRefusal";

import {
  connectionFieldsNotHeld,
  fieldsOutsideComposableDocument,
  literalCredentialFields,
  serverFieldsNotHeld,
} from "./managedCommandLineDocument";
import { buildManagedExchangeRecord } from "./managedExchangeRecord";

import type { ConnectionConfig, ExchangeSpec } from "@psilink/core";
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
 * Raised when a file is not a configuration this app takes: a document off the
 * exchange-file schema, or one that parses and holds what this app cannot keep --
 * a field outside what it composes, or a secret it does not import. Its message is shown to the operator, so it states what the
 * file holds and what to do about it, and it names FIELD NAMES only -- a field's
 * value is the credential.
 */
export class ManagedConfigurationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedConfigurationRefusedError";
  }
}

/**
 * What a schema refusal tells the operator: which lines of their own file to
 * fix. Only field names are named ({@link refusedDocumentFields}) -- never an
 * issue message, which a built-in Zod code can compose out of the offending
 * value.
 */
function schemaRefusal(
  error: ZodError,
  document: unknown,
): ManagedConfigurationRefusedError {
  const fields = refusedDocumentFields(error, document);
  if (fields.length === 0)
    return new ManagedConfigurationRefusedError(
      "This file is not a psilink exchange configuration. Check that you " +
        "chose the psilink.yaml this exchange runs under, and import it again.",
    );
  return new ManagedConfigurationRefusedError(
    "This file is not a valid psilink configuration. " +
      (fields.length === 1 ? "Fix this setting" : "Fix these settings") +
      " in the file and import it again: " +
      namedFieldList(fields) +
      ".",
  );
}

/**
 * The document the shared exchange-file schema reads out of a command-line
 * file, refusing in this app's own words rather than raising the schema's
 * {@link ZodError}: the file is in front of the operator, who edits it by hand,
 * so a field it refuses is a line they can fix. The backup artifact's schema
 * failures keep the {@link ZodError} they raise -- that file is written by this
 * app, and a refusal there is a version difference rather than a typo.
 */
function importedDocument(raw: unknown): ExchangeSpec {
  try {
    return parseExchangeSpec(raw);
  } catch (error) {
    if (error instanceof ZodError) throw schemaRefusal(error, raw);
    throw error;
  }
}

/**
 * Narrow the document's connection to what a configuration on its channel
 * holds, or refuse. A hard refusal: a field outside it is a credential or a
 * path this app would store and hand back to the command line, and a literal
 * credential is a secret this app does not store.
 *
 * The `server` block is measured on the file's own object as well as on the
 * parsed connection: the shared schema's server blocks are not strict, so a key
 * outside one is stripped by the parse and would reach no allowlist at all.
 */
function importedConnection(
  document: ExchangeSpec,
  raw: unknown,
): ConnectionConfig {
  const connection = document.connection;
  const outside = [
    ...new Set([
      ...connectionFieldsNotHeld(withoutRole(connection)),
      ...serverFieldsNotHeld(
        connection.channel,
        documentValueAt(raw, ["connection", "server"]),
      ),
    ]),
  ].sort();
  if (outside.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration's connection holds settings this app does not " +
        "keep -- a credential, or an address or file the command line would " +
        "open. Remove these lines from the connection and import it again: " +
        outside.join(", ") +
        ". The configuration this app hands back leaves them out, so add " +
        "them back to that file before you run it.",
    );
  const literal = literalCredentialFields(connection);
  if (literal.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration writes a credential into the file itself: " +
        literal.join(", ") +
        ". This app does not store a credential. Put each in a file of its " +
        "own, write the setting as @ followed by that file's path, and " +
        "import it again.",
    );
  return connection;
}

/** The connection without the webrtc `role` this import consumes, so the
 * locator allowlist measures only the fields that stay in the stored document.
 * No other channel has a `role`. */
function withoutRole(connection: ConnectionConfig): ConnectionConfig {
  if (connection.channel !== "webrtc") return connection;
  const { role: _role, ...rest } = connection;
  return rest;
}

/**
 * The side this party takes, read from a webrtc `connection.role`, and none on
 * any other channel. A webrtc file that names none is refused rather than
 * guessed: the role decides which rendezvous id each party registers under,
 * and the CLI refuses a roleless webrtc connection on the same grounds
 * (`apps/cli/src/protocol.ts`).
 */
function importedSide(
  connection: ConnectionConfig,
): ManagedExchangeSide | undefined {
  if (connection.channel !== "webrtc") return undefined;
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
 * local fields taken out of it -- no webrtc `role` on the connection, no
 * `authentication` block -- re-validated so what is stored is a schema parse
 * result rather than an edited object.
 *
 * @throws {ManagedConfigurationRefusedError} if the document without those
 *   fields is not a valid exchange file.
 */
function storedDocument(
  document: ExchangeSpec,
  connection: ConnectionConfig,
): ExchangeSpec {
  const { authentication: _authentication, ...rest } = document;
  return importedDocument({ ...rest, connection: withoutRole(connection) });
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
 * @throws {ManagedConfigurationRefusedError} if the document is not a valid
 *   exchange file, or is one this app cannot hold (a field outside what it
 *   composes, a secret, or a webrtc connection naming no role).
 * @throws {ZodError} if the record built from the document is not a valid
 *   record.
 */
export function readManagedCommandLineConfiguration(
  source: string,
): ManagedExchangeRecord {
  const raw = parseSensitiveYaml(source, "command-line exchange configuration");
  const document = importedDocument(raw);
  const connection = importedConnection(document, raw);
  const side = importedSide(connection);
  const tokenMaxAgeDays = importedTokenMaxAgeDays(document);
  const exchangeFile = storedDocument(document, connection);
  const outside = fieldsOutsideComposableDocument(exchangeFile);
  if (outside.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration holds settings this app does not keep -- a file " +
        "the command line would open or write, or a fingerprint it would " +
        "pin. Remove these top-level lines and import it again: " +
        outside.join(", ") +
        ". The configuration this app hands back leaves them out, so add " +
        "them back to that file before you run it.",
    );
  return buildManagedExchangeRecord({
    label: IMPORTED_CONFIGURATION_LABEL,
    exchangeFile,
    ...(side !== undefined ? { side } : {}),
    ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
  });
}
