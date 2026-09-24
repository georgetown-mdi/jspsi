/**
 * Reading a command-line `psilink.yaml` back into this browser: on its own as a
 * CONFIGURATION-ONLY managed exchange, the settings to edit and export again
 * with no secret and no run here, or with the `.psilink.key` beside it as a
 * runnable one (docs/MANAGED_EXCHANGE.md, "Bringing a command-line
 * configuration back"; docs/spec/MANAGED_EXCHANGE_RECORD.md, "The
 * configuration-only record" and "Importing the key file beside a
 * configuration").
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
 * A configuration on any channel imports, and so does one stating a part this
 * app cannot run -- a `signing` block, held unchanged for the file psilink
 * runs, every `@` in it as the text the file wrote. This app runs webrtc
 * exchanges without receipt signing, and that limit is met where a run would
 * start rather than here: such a record is a configuration only, which the
 * record's own shape keeps from every run (docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "The configuration-only record").
 *
 * Three levels are guarded against an extra key: the top-level document, the
 * connection, and connection.server (the bespoke allowlist below, since the
 * shared schema's own server blocks are not strict). Below those levels, an
 * unknown key is refused by the shared schema's unread-key comparison. The
 * document may hold only what the app itself composes, and the connection what
 * a configuration on its channel holds ({@link ./managedCommandLineDocument.ts}):
 * a credential-free locator on webrtc and filedrop, which keeps a TURN
 * credential or an ICE provisioning block from being stored here, and the
 * whole connection on sftp, whose record runs nowhere here. An sftp credential
 * is held as an `@path` reference and refused as a literal value. A shared
 * secret in the file is refused on the same terms: a secret comes in only from
 * the key file, which the configuration's schema parse never sees.
 */

import { ZodError } from "zod";

import {
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
} from "@psilink/core";

import {
  documentValueAt,
  namedFieldList,
  refusedDocumentFields,
} from "../exchangeDocumentRefusal";

import {
  buildManagedExchangeRecord,
  channelThisAppDoesNotRun,
  documentPartsThisAppDoesNotRun,
  keyFileFieldsSchema,
  runnableManagedExchangeOrRefuse,
} from "./managedExchangeRecord";
import {
  connectionFieldsNotHeld,
  fieldsOutsideComposableDocument,
  literalCredentialFields,
  serverFieldsNotHeld,
} from "./managedCommandLineDocument";
import { MAX_KEY_FILE_IMPORT_BYTES } from "./managedRetake";

import type { ConnectionConfig, ExchangeSpec } from "@psilink/core";
import type {
  ManagedExchangeKeyFields,
  ManagedExchangeRecord,
  ManagedExchangeSide,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
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
 * a field outside what it composes, or a secret it does not import. Its message
 * is shown to the operator, so it states what the file holds and what to do
 * about it, and it names FIELD NAMES only -- a field's value is the credential.
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
 * import refuses instead, so the one route a secret takes into this browser
 * from the command line is the key file, read on its own terms
 * ({@link readManagedCommandLineKeyFile}).
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
        ". psilink reads the secret from .psilink.key, never from " +
        "psilink.yaml, so remove " +
        (named.length === 1 ? "that line" : "those lines") +
        " and import it again. To run the exchange in this browser, choose " +
        "the .psilink.key beside it as well.",
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
 * The record fields a command-line `psilink.yaml` supplies: parsed, and refused
 * where this app cannot hold it. Holds no secret; one is added only from a key
 * file read on its own terms ({@link readManagedCommandLineKeyFile}).
 */
function commandLineExchangeFields(source: string): NewManagedExchange {
  const raw = parseSensitiveYaml(source, "command-line exchange configuration");
  const document = importedDocument(raw);
  const connection = importedConnection(document, raw);
  const side = importedSide(connection);
  const tokenMaxAgeDays = importedTokenMaxAgeDays(document);
  const exchangeFile = storedDocument(document, connection);
  const outside = fieldsOutsideComposableDocument(exchangeFile);
  if (outside.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration holds settings this app does not keep. Remove " +
        "these top-level lines and import it again: " +
        outside.join(", ") +
        ". The configuration this app hands back leaves them out, so add " +
        "them back to that file before you run it.",
    );
  return {
    label: IMPORTED_CONFIGURATION_LABEL,
    exchangeFile,
    ...(side !== undefined ? { side } : {}),
    ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
  };
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
  return buildManagedExchangeRecord(commandLineExchangeFields(source));
}

/**
 * Raised when a file chosen as a configuration's `.psilink.key` is not one: it
 * is over the size cap, does not parse, or holds something other than the pair
 * psilink writes there. Its message states what is wrong in fixed words and
 * never a byte of the file, whose contents are the secret.
 */
export class ManagedKeyFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedKeyFileRefusedError";
  }
}

/** The label a failed parse of the key file names, and nothing else: the file's
 * bytes are the secret (see `parseSensitiveJson`). */
const KEY_FILE_PARSE_LABEL = "command-line key file";

/** What is wrong with a key file, each stated without any value it holds. */
const KEY_FILE_PROBLEMS = {
  oversize: "it is larger than a key file can be",
  notJson: "it is not a JSON file",
  notObject:
    "it does not hold the sharedSecret and expires fields a key file holds",
  missingSecret: "it has no sharedSecret",
  malformedSecret:
    "its sharedSecret is not a psilink shared secret (43 base64url " +
    "characters, as psilink writes it)",
  malformedExpires:
    "its expires is not a date and time in the form psilink writes, such " +
    "as 2026-12-31T00:00:00.000Z",
  unknownField:
    "it holds a field other than sharedSecret and expires, the two a " +
    ".psilink.key holds",
} as const;

/** A problem {@link KEY_FILE_PROBLEMS} names. */
type KeyFileProblem = keyof typeof KEY_FILE_PROBLEMS;

/** The order the problems of one file are named in. */
const KEY_FILE_PROBLEM_ORDER: ReadonlyArray<KeyFileProblem> = [
  "missingSecret",
  "malformedSecret",
  "malformedExpires",
  "unknownField",
];

/** Which problems a failed key-pair parse shows, read off each issue's code and
 * top-level field name only -- never an issue message, which may be composed
 * from the value. An issue matching none of them names the whole shape. */
function keyPairProblems(
  error: ZodError,
  parsed: object,
): Array<KeyFileProblem> {
  const found = new Set<KeyFileProblem>();
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") found.add("unknownField");
    else if (issue.path[0] === "sharedSecret")
      found.add("sharedSecret" in parsed ? "malformedSecret" : "missingSecret");
    else if (issue.path[0] === "expires") found.add("malformedExpires");
    else found.add("notObject");
  }
  if (found.has("notObject")) return ["notObject"];
  return KEY_FILE_PROBLEM_ORDER.filter((problem) => found.has(problem));
}

/** The refusal for a key file, naming each problem found. */
function keyFileRefusal(
  problems: Array<KeyFileProblem>,
): ManagedKeyFileRefusedError {
  return new ManagedKeyFileRefusedError(
    "The key file is not a .psilink.key this app can use: " +
      problems.map((problem) => KEY_FILE_PROBLEMS[problem]).join("; ") +
      ". Choose the .psilink.key psilink wrote beside this psilink.yaml and " +
      "import the two again. Nothing was imported.",
  );
}

/**
 * Read a command-line `.psilink.key` into the key pair a record holds: the
 * shared secret and any `expires`, the JSON object psilink writes there
 * (`apps/cli/src/keyFile.ts`). The configuration's schema parse never sees
 * this file, so it is validated here on its own: capped, parsed through the
 * sensitive-JSON chokepoint, and read against the strict key-pair schema every
 * reader of the pair shares ({@link keyFileFieldsSchema}), so a file holding
 * anything else is refused before the store is reached. Pure.
 *
 * @throws {ManagedKeyFileRefusedError} if the file is over the cap, is not
 *   JSON, or is not the key pair; the message names which, never a value.
 */
export function readManagedCommandLineKeyFile(
  source: string,
): ManagedExchangeKeyFields {
  if (new TextEncoder().encode(source).byteLength > MAX_KEY_FILE_IMPORT_BYTES)
    throw keyFileRefusal(["oversize"]);
  let parsed: unknown;
  try {
    parsed = parseSensitiveJson(source, KEY_FILE_PARSE_LABEL);
  } catch {
    throw keyFileRefusal(["notJson"]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw keyFileRefusal(["notObject"]);
  const result = keyFileFieldsSchema.safeParse(parsed);
  if (result.success) return result.data;
  throw keyFileRefusal(keyPairProblems(result.error, parsed));
}

/**
 * Read a command-line `psilink.yaml` and the `.psilink.key` beside it as a
 * RUNNABLE managed exchange record: the configuration read exactly as
 * {@link readManagedCommandLineConfiguration} reads it, the key file read by
 * {@link readManagedCommandLineKeyFile}, and the pair set on the record as its
 * `sharedSecret` and `expires` -- the one record field the store keeps a secret
 * in. Pure: nothing is stored here.
 *
 * A configuration this app does not run -- another channel, or a part it
 * cannot run -- is refused with its key file rather than installed without it:
 * the record schema holds a secret only where this app runs the exchange, and
 * the operator chose the key file to run it here.
 *
 * @throws {UsageError} if the configuration is not parseable YAML.
 * @throws {ManagedConfigurationRefusedError} if the configuration is refused,
 *   or is one this app does not run.
 * @throws {ManagedKeyFileRefusedError} if the key file is refused.
 * @throws {ZodError} if the record built from the pair is not a valid record.
 */
export function readManagedCommandLinePair(
  configurationSource: string,
  keySource: string,
): RunnableManagedExchangeRecord {
  const fields = commandLineExchangeFields(configurationSource);
  const channel = channelThisAppDoesNotRun(fields.exchangeFile);
  if (channel !== undefined)
    throw new ManagedConfigurationRefusedError(
      `This configuration runs over ${channel}, and this app runs webrtc ` +
        "exchanges only, so its key file cannot be used here. Import the " +
        "psilink.yaml on its own to edit its settings here, and run the " +
        "exchange with psilink.",
    );
  const parts = documentPartsThisAppDoesNotRun(fields.exchangeFile);
  if (parts.length > 0)
    throw new ManagedConfigurationRefusedError(
      "This configuration holds " +
        parts.join(", ") +
        ", which this app does not run, so its key file cannot be used here. " +
        "Import the psilink.yaml on its own to edit its settings here, and " +
        "run the exchange with psilink.",
    );
  const key = readManagedCommandLineKeyFile(keySource);
  return runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord({
      ...fields,
      sharedSecret: key.sharedSecret,
      ...(key.expires !== undefined ? { expires: key.expires } : {}),
    }),
  );
}
