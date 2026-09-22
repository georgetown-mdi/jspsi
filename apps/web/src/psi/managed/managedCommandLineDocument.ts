/**
 * What a managed exchange's command-line `psilink.yaml` may hold: the one rule
 * both legs of the hand-off apply -- the export that writes the file
 * ({@link ./managedCronExport.ts}) and the import that reads one back
 * ({@link ./managedCommandLineImport.ts}).
 *
 * The rule is an allowlist measured off the app's own composition rather than a
 * list restated here: the connection may hold what a credential-free locator on
 * its own channel expands to ({@link connectionFromLocator}), and the document
 * only the top-level fields the record composer produces
 * ({@link composeManagedExchangeFile}), plus the `authentication` block the
 * export injects from the local max-age policy and the `retentionDisposition`
 * the record spec sanctions as operator-authored free text
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md). The shared exchange-file schema is
 * wider than both: it can represent a TURN `credential`, a `provider_options`
 * map, an `ice_provision` auth block, a PeerJS `server.key`/`server.username`,
 * a shared secret, and a `signing` block (`identity_file`, `receipt_output`,
 * `partner_fingerprint`), and the CLI resolves an `@path` in the file it loads
 * (`apps/cli/src/util/atSignRefs.ts`).
 *
 * An sftp connection is held whole beyond its locator: a record on sftp runs
 * nowhere in this app, so every setting of its connection is only written back
 * to the file psilink runs. A credential in it is held as an `@path` reference
 * and refused as a literal value ({@link literalCredentialFields}): the browser
 * does not resolve a reference, and it does not store a secret.
 *
 * Each leg words its own refusal -- what an operator does about a stored field
 * they cannot see differs from what they do about a line in the file in front of
 * them -- and both name FIELD NAMES only. A field's VALUE is the credential, and
 * it never enters a message.
 */

import {
  connectionFromLocator,
  getDefaultLinkageTerms,
  snakeizeKey,
} from "@psilink/core";

import { composeManagedExchangeFile } from "./managedExchangeRecord";

import type {
  ConnectionConfig,
  ExchangeLocator,
  ExchangeSpec,
  HttpAuth,
  SFTPConnectionConfig,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { ManagedExchangeFileComposition } from "./managedExchangeRecord";

/** A channel a credential-free locator exists for: every channel the shared
 * exchange-file schema names. */
type LocatorChannel = ExchangeLocator["channel"];

/**
 * The webrtc locator the document-field probe below is driven with, holding
 * every optional field, so what the probe measures is the widest shape the app
 * can compose rather than the narrowest.
 */
const WIDEST_WEBRTC_PROBE_LOCATOR: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "locator.invalid",
  port: 443,
  path: "/",
};

/**
 * One credential-free locator per channel, each holding every optional field,
 * so each connection allowlist below is the widest a locator on that channel
 * expands to. Keyed by channel, so a channel added to the locator union fails
 * this module's compile until it has a probe. Only the KEYS an expansion
 * produces are read, never these values.
 */
const WIDEST_PROBE_LOCATORS: {
  [Channel in LocatorChannel]: Extract<ExchangeLocator, { channel: Channel }>;
} = {
  webrtc: WIDEST_WEBRTC_PROBE_LOCATOR,
  sftp: {
    channel: "sftp",
    host: "locator.invalid",
    port: 22,
    path: "/",
    inboundPath: "/inbound",
    outboundPath: "/outbound",
    options: {},
  },
  filedrop: {
    channel: "filedrop",
    path: "/",
    inboundPath: "/inbound",
    outboundPath: "/outbound",
    options: {},
  },
};

/** The field names a configuration holds on one channel: at the connection,
 * and at its nested `server` where the channel has one. */
interface HeldConnectionFields {
  connection: ReadonlySet<string>;
  server: ReadonlySet<string>;
}

/**
 * The field names one channel's credential-free locator expands to. Read off
 * {@link connectionFromLocator}'s own arm for that channel rather than
 * restated, so the allowlist cannot drift from the composition rule
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block: credential-free
 * by composition").
 */
function credentialFreeLocatorFields(
  channel: LocatorChannel,
): HeldConnectionFields {
  const composed = connectionFromLocator(WIDEST_PROBE_LOCATORS[channel]);
  if (composed.channel !== channel)
    throw new Error(
      `the credential-free locator expansion did not compose a ${channel} ` +
        `connection from a ${channel} locator`,
    );
  const server: unknown = "server" in composed ? composed.server : undefined;
  return {
    connection: new Set(Object.keys(composed)),
    server: new Set(
      typeof server === "object" && server !== null ? Object.keys(server) : [],
    ),
  };
}

/** The sftp connection fields held beyond the locator's expansion. */
const SFTP_HELD_CONNECTION_FIELDS = [
  "proxy",
  "providerOptions",
] as const satisfies ReadonlyArray<keyof SFTPConnectionConfig>;

/** The sftp `server` fields held beyond the locator's expansion. */
const SFTP_HELD_SERVER_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
  "keyboardInteractive",
  "hostKeyFingerprint",
  "provision",
] as const satisfies ReadonlyArray<keyof SFTPConnectionConfig["server"]>;

function withHeldFields(
  locator: HeldConnectionFields,
  connection: ReadonlyArray<string>,
  server: ReadonlyArray<string>,
): HeldConnectionFields {
  return {
    connection: new Set([...locator.connection, ...connection]),
    server: new Set([...locator.server, ...server]),
  };
}

const HELD_CONNECTION_FIELDS: Record<LocatorChannel, HeldConnectionFields> = {
  webrtc: credentialFreeLocatorFields("webrtc"),
  sftp: withHeldFields(
    credentialFreeLocatorFields("sftp"),
    SFTP_HELD_CONNECTION_FIELDS,
    SFTP_HELD_SERVER_FIELDS,
  ),
  filedrop: credentialFreeLocatorFields("filedrop"),
};

/**
 * A connection's fields a configuration on its channel does not hold, named in
 * the operator's own snake_case spelling so a refusal points at the lines to
 * remove, and sorted so two runs name them in one order. A webrtc `role` is
 * outside the held set: the export injects it and the import reads it into
 * the record's local `side`, so a caller that has consumed it passes a
 * connection without it.
 */
export function connectionFieldsNotHeld(
  connection: ConnectionConfig,
): Array<string> {
  const held = HELD_CONNECTION_FIELDS[connection.channel];
  const outside = Object.keys(connection).filter(
    (field) => !held.connection.has(field),
  );
  // Typed as required where the channel has one, but this gate runs on shapes
  // that reached it without the record read path's validation, so the nested
  // object is read defensively: a missing `server` is the exchange schema's
  // refusal to make, not a TypeError here.
  const server: unknown =
    "server" in connection ? connection.server : undefined;
  const serverFields =
    typeof server === "object" && server !== null ? Object.keys(server) : [];
  return [
    ...outside.map((field) => snakeizeKey(field)),
    ...serverFields
      .filter((field) => !held.server.has(field))
      .map((field) => `server.${snakeizeKey(field)}`),
  ].sort();
}

/**
 * The keys a FILE's own `connection.server` block holds outside what a
 * configuration on the connection's channel holds, named verbatim under the
 * block and sorted. The shared exchange-file schema's server blocks are not
 * strict, so a key outside one is stripped by the parse and never reaches
 * {@link connectionFieldsNotHeld}: reading the document the operator wrote is
 * what refuses such a line rather than trimming it away. The allowlist is
 * compared in both spellings, since these keys have not been through the
 * camelize pre-pass the parsed connection's have.
 */
export function serverFieldsNotHeld(
  channel: LocatorChannel,
  server: unknown,
): Array<string> {
  if (typeof server !== "object" || server === null) return [];
  const heldServerFields = HELD_CONNECTION_FIELDS[channel].server;
  const allowed = new Set([
    ...heldServerFields,
    ...[...heldServerFields].map((field) => snakeizeKey(field)),
  ]);
  return Object.keys(server)
    .filter((field) => !allowed.has(field))
    .map((field) => `server.${field}`)
    .sort();
}

/**
 * The settings a connection states beyond its channel's credential-free
 * locator, named as the file spells them under `connection` and sorted: on
 * sftp, each held field present; on any other channel, none, since nothing
 * beyond the locator is held there.
 */
export function connectionSettingsBeyondLocator(
  connection: ConnectionConfig,
): Array<string> {
  if (connection.channel !== "sftp") return [];
  const { server } = connection;
  return [
    ...SFTP_HELD_CONNECTION_FIELDS.filter(
      (field) => connection[field] !== undefined,
    ).map((field) => `connection.${snakeizeKey(field)}`),
    ...SFTP_HELD_SERVER_FIELDS.filter(
      (field) => server[field] !== undefined,
    ).map((field) => `connection.server.${snakeizeKey(field)}`),
  ].sort();
}

/** One value a connection states where psilink reads an `@path` as a file,
 * named as the file spells the setting. */
interface FileReadableValue {
  field: string;
  value: unknown;
  /** Whether a literal value here is a credential the browser must not store. */
  credential: boolean;
}

function httpAuthValues(
  field: string,
  auth: HttpAuth | undefined,
): Array<FileReadableValue> {
  if (auth === undefined) return [];
  return [
    { field: `${field}.bearer`, value: auth.bearer, credential: true },
    { field: `${field}.password`, value: auth.password, credential: true },
  ];
}

/** The `provider_options` keys that name a credential: the credential keys
 * the SFTP option passthrough documents as rejected (docs/EXCHANGE_REFERENCE.md,
 * `connection.provider_options`), in each spelling it lists. The map's keys are
 * passed as written, so each is matched exactly. */
const PROVIDER_OPTION_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passphrase",
  "privateKey",
  "private_key",
]);

/** Every string a `provider_options` value holds, at any depth. */
function stringLeaves(value: unknown): Array<string> {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(stringLeaves);
  return [];
}

/**
 * The values an sftp connection states where the CLI resolves an `@path`
 * (`resolveExchangeSpecRefs`, `apps/cli/src/util/atSignRefs.ts`). Every one is
 * a credential but the host-key pin. A `provider_options` string is a
 * credential only under a key in {@link PROVIDER_OPTION_CREDENTIAL_KEYS}; any
 * other option, a cipher name among them, is transport tuning. Its keys are
 * named verbatim because the case conversion leaves them alone.
 */
function sftpFileReadableValues(
  connection: SFTPConnectionConfig,
): Array<FileReadableValue> {
  const { server } = connection;
  const pins =
    server.hostKeyFingerprint === undefined
      ? []
      : [server.hostKeyFingerprint].flat();
  return [
    {
      field: "connection.server.password",
      value: server.password,
      credential: true,
    },
    {
      field: "connection.server.private_key",
      value: server.privateKey,
      credential: true,
    },
    {
      field: "connection.server.private_key_passphrase",
      value: server.privateKeyPassphrase,
      credential: true,
    },
    ...pins.map((pin) => ({
      field: "connection.server.host_key_fingerprint",
      value: pin,
      credential: false,
    })),
    ...httpAuthValues(
      "connection.server.provision.auth",
      server.provision?.auth,
    ),
    ...httpAuthValues("connection.proxy.auth", connection.proxy?.auth),
    ...Object.entries(connection.providerOptions ?? {}).flatMap(
      ([key, value]) =>
        stringLeaves(value).map((leaf) => ({
          field: `connection.provider_options.${key}`,
          value: leaf,
          credential: PROVIDER_OPTION_CREDENTIAL_KEYS.has(key),
        })),
    ),
  ];
}

function isFileReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("@");
}

function namedOnce(values: ReadonlyArray<FileReadableValue>): Array<string> {
  return [...new Set(values.map(({ field }) => field))].sort();
}

/**
 * The settings a connection states a credential in as a literal value rather
 * than an `@path` reference, named as the file spells them and sorted. This app
 * holds a credential only as a reference, so each of these is refused.
 */
export function literalCredentialFields(
  connection: ConnectionConfig,
): Array<string> {
  if (connection.channel !== "sftp") return [];
  return namedOnce(
    sftpFileReadableValues(connection).filter(
      ({ value, credential }) =>
        credential && value !== undefined && !isFileReference(value),
    ),
  );
}

/**
 * The settings a connection states as an `@path` reference, named as the file
 * spells them and sorted. This browser never reads the file one names; the
 * exported document keeps each reference as written, and psilink reads that
 * file on the machine that runs it.
 */
export function fileReferenceFields(
  connection: ConnectionConfig,
): Array<string> {
  if (connection.channel !== "sftp") return [];
  return namedOnce(
    sftpFileReadableValues(connection).filter(({ value }) =>
      isFileReference(value),
    ),
  );
}

/**
 * The top-level document fields the app can put in a stored document, measured
 * by composing one. Typed `Required<ManagedExchangeFileComposition>`, so a
 * field added to the record composer's input fails this module's compile
 * until the probe holds it. Read off {@link composeManagedExchangeFile}'s
 * OUTPUT, not its input: the probe measures which KEYS survive composition,
 * never what they hold. The connection is one key whatever its channel, so one
 * webrtc probe measures the document for every channel.
 */
function composableDocumentFields(): ReadonlySet<string> {
  const widestComposition: Required<ManagedExchangeFileComposition> = {
    connection: WIDEST_WEBRTC_PROBE_LOCATOR,
    linkageTerms: getDefaultLinkageTerms("composition probe"),
    metadata: [],
    standardization: [],
    disclosedPayloadColumns: [],
    expectedPayloadColumns: [],
    expectedPartnerDeduplicate: false,
    outboundPayloadConsent: { status: "pending" },
    includeOwnColumns: "all",
    csvDelimiter: "|",
  };
  return new Set(Object.keys(composeManagedExchangeFile(widestComposition)));
}

/**
 * The top-level fields a command-line document may hold: what the app can
 * compose (above), plus the `authentication` block holding the max-age policy,
 * plus the `retentionDisposition` the record spec sanctions on a stored document
 * as operator-authored free text (docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `exchangeFile` row). Nothing else the shared exchange-file schema can
 * represent belongs in a managed exchange's psilink.yaml.
 */
const COMMAND_LINE_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
  ...composableDocumentFields(),
  "authentication",
  "retentionDisposition",
]);

/**
 * A document's top-level fields outside {@link COMMAND_LINE_DOCUMENT_FIELDS},
 * named in the operator's own snake_case spelling and sorted. Names only -- a
 * field's VALUE is what the CLI would act on (a path it opens as this party's
 * signing identity, a path it writes a receipt to, a fingerprint it pins a
 * partner certificate against) and never enters a message.
 */
export function fieldsOutsideComposableDocument(
  document: ExchangeSpec,
): Array<string> {
  return Object.keys(document)
    .filter((field) => !COMMAND_LINE_DOCUMENT_FIELDS.has(field))
    .map((field) => snakeizeKey(field))
    .sort();
}
