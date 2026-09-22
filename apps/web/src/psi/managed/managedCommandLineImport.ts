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
 * - `connection.role` becomes the record's `side`. The document a stored record
 *   holds has none (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side`
 *   field, not the document"), and a file without one is refused: the CLI itself
 *   refuses to run a webrtc connection that names no role.
 * - `authentication.token_max_age_days` becomes the record's `tokenMaxAgeDays`.
 *   A stored document holds no `authentication` block at all, so the block is
 *   read for that one policy and dropped.
 *
 * Three levels are guarded against an extra key: the top-level document, the
 * connection, and connection.server (the bespoke allowlist below, since the
 * shared schema's own server block is not strict). Below those levels, an
 * unknown key is dropped by the shared schema's non-strict parse rather than
 * refused. The channel must be webrtc -- the one channel this app runs -- and
 * the connection and the document may hold only what the app itself composes
 * ({@link ./managedCommandLineDocument.ts}),
 * which is what keeps a partner's TURN credential, ICE provisioning block,
 * signing identity path, or `@path` reference from being stored here and handed
 * back to the CLI by the next export. A shared secret in the file is refused on
 * the same terms: this import brings back configuration, and the key file stays
 * with the machine that runs the exchange.
 */

import { ZodError } from "zod";

import {
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKey,
} from "@psilink/core";

import {
  fieldsOutsideComposableDocument,
  fieldsOutsideLocatorSubset,
  serverFieldsOutsideLocatorSubset,
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
 * Raised when a file is not a configuration this app takes: a document off the
 * exchange-file schema, or one that parses and holds what this app cannot keep --
 * a channel it does not run, a field outside what it composes, or a secret it
 * does not import. Its message is shown to the operator, so it states what the
 * file holds and what to do about it, and it names FIELD NAMES only -- a field's
 * value is the credential.
 */
export class ManagedConfigurationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedConfigurationRefusedError";
  }
}

/** How many offending fields a schema refusal names before it counts the rest.
 * A hand-edited file with one mistake names it; a file off the schema wholesale
 * would otherwise list every field of it in an alert. */
const MAX_REFUSED_FIELDS_NAMED = 5;

/** One field name joined onto the path of the block holding it. */
function joinFieldPath(parent: string, field: string): string {
  return parent === "" ? field : `${parent}.${field}`;
}

/**
 * One key of a document object as the FILE spells it, or undefined when the
 * object holds no such key. The schema reads a camelized copy of the document,
 * so a key the file wrote in snake_case reaches a Zod issue under its camelCase
 * name; the file's own object holds one spelling or the other.
 */
function keyAsWritten(container: unknown, key: string): string | undefined {
  if (typeof container !== "object" || container === null) return undefined;
  const written = container as Record<string, unknown>;
  if (Object.hasOwn(written, key)) return key;
  const snakeized = snakeizeKey(key);
  return Object.hasOwn(written, snakeized) ? snakeized : undefined;
}

/**
 * The document's own value at a Zod issue's path, walked segment by segment in
 * whichever spelling the file writes ({@link keyAsWritten}).
 */
function documentValueAt(
  document: unknown,
  path: ReadonlyArray<PropertyKey>,
): unknown {
  return path.reduce<unknown>((value, segment) => {
    if (typeof segment === "number")
      return Array.isArray(value) ? value[segment] : undefined;
    const key = keyAsWritten(value, String(segment));
    return key === undefined
      ? undefined
      : (value as Record<string, unknown>)[key];
  }, document);
}

/**
 * One Zod issue path as the FILE spells it: snake_case keys ({@link snakeizeKey},
 * since the schema parses the camelized shape), array indices in brackets, and
 * the path cut at a `params` segment -- the key inside that free-form record is
 * the author's own text, and the block locates the problem well enough.
 *
 * `writtenKey` is a key the schema does not name, joined onto that path as the
 * file spells it and NOT snakeized: it is read back out of the document rather
 * than derived from the camelized shape, and rewriting it would name a line the
 * file does not hold (`Mystery-Key` renders as `_mystery-_key`). A cut path
 * drops it, for the reason the cut has.
 */
function documentFieldPath(
  path: ReadonlyArray<PropertyKey>,
  writtenKey?: string,
): string {
  const paramsIndex = path.indexOf("params");
  const segments = paramsIndex >= 0 ? path.slice(0, paramsIndex + 1) : path;
  const rendered = segments.reduce<string>(
    (renderedPath, segment) =>
      typeof segment === "number"
        ? `${renderedPath}[${segment}]`
        : joinFieldPath(renderedPath, snakeizeKey(String(segment))),
    "",
  );
  return writtenKey === undefined || paramsIndex >= 0
    ? rendered
    : joinFieldPath(rendered, writtenKey);
}

/**
 * The fields one Zod issue names, as the FILE spells them. A key outside the
 * schema is reported at its PARENT object's path -- empty for a top-level key --
 * with the offending names on `keys`, so naming the key itself takes joining
 * each of them onto that path, spelled as the document under that path spells
 * it. Every other issue names the field its path points at, and an issue at the
 * document root names none.
 */
function refusedFields(
  issue: ZodError["issues"][number],
  document: unknown,
): Array<string> {
  if (issue.code === "unrecognized_keys") {
    const container = documentValueAt(document, issue.path);
    return issue.keys.map((key) =>
      documentFieldPath(issue.path, keyAsWritten(container, key) ?? key),
    );
  }
  const field = documentFieldPath(issue.path);
  return field === "" ? [] : [field];
}

/**
 * What a schema refusal tells the operator: which lines of their own file to
 * fix. Only field names are named -- never an issue message, which a built-in
 * Zod code can compose out of the offending value.
 */
function schemaRefusal(
  error: ZodError,
  document: unknown,
): ManagedConfigurationRefusedError {
  const fields = [
    ...new Set(error.issues.flatMap((issue) => refusedFields(issue, document))),
  ];
  if (fields.length === 0)
    return new ManagedConfigurationRefusedError(
      "This file is not a psilink exchange configuration. Check that you " +
        "chose the psilink.yaml this exchange runs under, and import it again.",
    );
  const named = fields.slice(0, MAX_REFUSED_FIELDS_NAMED);
  const beyond = fields.length - named.length;
  const list =
    beyond > 0 ? `${named.join(", ")}, and ${beyond} more` : named.join(", ");
  return new ManagedConfigurationRefusedError(
    "This file is not a valid psilink configuration. " +
      (fields.length === 1 ? "Fix this setting" : "Fix these settings") +
      " in the file and import it again: " +
      list +
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
 * Narrow the document's connection to the credential-free webrtc locator this
 * app composes, or refuse. A hard refusal on both counts: the browser runs
 * webrtc exchanges and no other, and a field outside the locator subset is a
 * credential or a path this app would store and hand back to the command line.
 *
 * The `server` block is measured on the file's own object as well as on the
 * parsed connection: the shared schema's server block is not strict, so a key
 * outside it is stripped by the parse and would reach no allowlist at all.
 */
function importedWebrtcConnection(
  document: ExchangeSpec,
  raw: unknown,
): WebRTCConnectionConfig {
  const connection = document.connection;
  if (connection.channel !== "webrtc")
    throw new ManagedConfigurationRefusedError(
      `This configuration runs over ${connection.channel}. This app runs ` +
        "webrtc exchanges only, so it cannot hold this one. Run it with " +
        "psilink on the command line instead.",
    );
  const outside = [
    ...new Set([
      ...fieldsOutsideLocatorSubset(withoutRole(connection)),
      ...serverFieldsOutsideLocatorSubset(
        documentValueAt(raw, ["connection", "server"]),
      ),
    ]),
  ].sort();
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
 * @throws {ManagedConfigurationRefusedError} if the document without those
 *   fields is not a valid exchange file.
 */
function storedDocument(
  document: ExchangeSpec,
  connection: WebRTCConnectionConfig,
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
 *   exchange file, or is one this app cannot hold (another channel, a field
 *   outside what it composes, a secret, or no role).
 * @throws {ZodError} if the record built from the document is not a valid
 *   record.
 */
export function readManagedCommandLineConfiguration(
  source: string,
): ManagedExchangeRecord {
  const raw = parseSensitiveYaml(source, "command-line exchange configuration");
  const document = importedDocument(raw);
  const connection = importedWebrtcConnection(document, raw);
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
