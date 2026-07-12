import { z } from "zod";

import { stringify as stringifyYaml } from "yaml";

import {
  ExchangeSpecSchema,
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MetadataSchema,
  SHARED_SECRET_REGEX,
  StandardizationSchema,
  mintExchangeFile,
  snakeizeKeys,
} from "@psilink/core";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import { SFTP_REMOTE_NAME_REGEX } from "./sftpRemotes";

import type {
  ExchangeFileInput,
  ExchangeSpec,
  FileSyncOptions,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";
import type { JobSftpRemoteEntry } from "./sftpRemotes";

/**
 * The tuning knobs a client may set on a job. Deliberately the numeric/boolean
 * subset of the CLI's file-sync options: every field here is a number, a
 * boolean, or a closed enum, so none can carry a path, host, credential, or
 * command. Path and directory fields of {@link FileSyncOptions} are intentionally
 * NOT surfaced -- the server owns every directory. `peerId` (a free-text field)
 * is omitted for the same reason.
 */
export interface JobExchangeOptions {
  pollIntervalMs?: number;
  peerTimeoutMs?: number;
  serverConnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  timestampInFilename?: boolean;
  locklessRendezvous?: boolean;
  retainFiles?: boolean;
  unexpectedFiles?: "error" | "warn" | "ignore";
}

const jobExchangeOptionsFields = {
  peerTimeoutMs: z.number().int().positive().optional(),
  serverConnectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z.number().int().min(0).max(604800).optional(),
  timestampInFilename: z.boolean().optional(),
  locklessRendezvous: z.boolean().optional(),
  retainFiles: z.boolean().optional(),
  unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
};

const jobExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    pollIntervalMs: z.number().int().positive().optional(),
    ...jobExchangeOptionsFields,
  })
  .strict();

// The sftp variant floors the poll interval at one second: an sftp poll is a
// directory listing against a REMOTE server the operator provisioned, so a
// client-chosen hot poll would flood a shared third-party host rather than the
// job's own local rendezvous directory (the filedrop case, which keeps the
// positive-int floor).
const jobSftpExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    pollIntervalMs: z
      .number()
      .int()
      .min(1000, "pollIntervalMs must be at least 1000 on the sftp channel")
      .optional(),
    ...jobExchangeOptionsFields,
  })
  .strict();

/**
 * The fields shared by every {@link JobExchangeIntent} arm. Field-level
 * contracts (see {@link jobExchangeIntentSchema} for the closure argument):
 *
 * - `linkageTerms` is validated by core's {@link LinkageTermsSchema}, whose
 *   vocabulary is bounded partner-authored text (field names, key elements,
 *   transforms) -- it carries no filesystem path, host, or command field, so a
 *   hostile value cannot escape into argv or the filesystem.
 * - `sharedSecret` is credential material matching the CLI key-file shape; it is
 *   written into a fixed-name key file, never used as a path or argv fragment.
 * - `inputCsv` is CONTENT the server writes to a fixed, server-chosen filename in
 *   the job workdir; the client never names a file.
 * - `options` is the numeric/boolean/enum subset of the CLI's tuning options.
 * - `metadata` and `standardization` are the operator's per-party data-prep edits
 *   (which columns are sent vs ignored, their roles/types, and the transform
 *   pipeline). Both are validated structured data -- core's {@link MetadataSchema}
 *   and {@link StandardizationSchema} -- carrying only column names/roles/types and
 *   a step pipeline. They are written into the composed config as YAML VALUES, never
 *   as an argv fragment, a path, a host, or a credential. The connection block the
 *   server composes is unaffected by them, so neither can redirect a directory or
 *   introduce an authentication field. Both are wrapped web-side with generous
 *   size caps ({@link MAX_METADATA_COLUMNS}, {@link MAX_METADATA_DESCRIPTION_LENGTH},
 *   {@link MAX_STANDARDIZATION_TRANSFORMATIONS}, {@link MAX_STANDARDIZATION_STEPS},
 *   and {@link MAX_NAME_LENGTH} on `output`/`input`) so the arrays and free-text
 *   fields cannot be unbounded; each standardization step's `params` is a
 *   `Record<string, unknown>` left uncapped by nature, with the boundary byte cap
 *   as its backstop. The linkage-terms dialect gate (which caps and dialect-checks
 *   transform-pattern SOURCES) applies to `linkageTerms` patterns, not to the
 *   standardization pipeline's raw-pattern steps -- so a client can submit a large
 *   or (in the linkage-terms sense) non-conformant `standardization` pattern. That
 *   is a compile/size cost, NOT a ReDoS hole: every standardization raw-pattern step
 *   still compiles and runs under core's linear-time RE2 engine (RE2JS), so it
 *   cannot backtrack catastrophically. It stays a resource bound, not an injection
 *   escape: it cannot become argv/path/host/credential.
 * - `expectedPayloadColumns` is the acceptor's received-payload lock-in: a list of
 *   partner-namespace column names, no path/host/credential. See the field doc for
 *   the empty-vs-absent semantics.
 */
interface JobExchangeIntentBase {
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  inputCsv: string;
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * The acceptor's RECEIVE-side lock-in: the partner-namespace columns this party
   * will enforce it receives (the invitation's disclosed set). Mirrors the browser
   * acceptor, which sets `prepared.expectedPayloadColumns` from the same source so
   * an inviter that sends extra columns aborts the exchange rather than having them
   * silently ingested. Column names only -- never a path, host, or credential.
   *
   * The empty-vs-absent distinction is load-bearing: an empty array is a strict
   * "receive nothing" (a non-empty partner payload then aborts), while an omitted
   * field reconciles lazily. It is forwarded (below) whenever it is present,
   * INCLUDING an empty array, so the strict form is preserved.
   */
  expectedPayloadColumns?: Array<string>;
  options?: JobExchangeOptions;
  eventStream?: boolean;
}

/**
 * A filedrop exchange intent. A filedrop exchange has no host and no
 * credentials at all, so the connection block the server composes carries no
 * injectable field; the one path field is the server-chosen rendezvous
 * directory inside the job workdir.
 */
export interface JobFiledropExchangeIntent extends JobExchangeIntentBase {
  channel: "filedrop";
}

/**
 * An sftp exchange intent. It adds exactly one field beyond the shared shape:
 * `remote`, an OPAQUE NAME selecting an operator-provisioned remote. The name
 * is compared by exact string equality against the server-side remotes table
 * via `Map.get` and is never interpolated into any path, host, argv, YAML
 * document, or response body; every piece of connection material (host, port,
 * username, credential references, host-key fingerprint) comes only from the
 * server-side table entry the name selects.
 */
export interface JobSftpExchangeIntent extends JobExchangeIntentBase {
  channel: "sftp";
  remote: string;
}

/**
 * The typed, schema-validated intent a client submits to create a job,
 * discriminated on `channel`. It is the ONLY channel from the client into a CLI
 * invocation, and it is injection-closed by construction: every field is either
 * bounded structured data validated by a core schema, a closed enum, a
 * numeric/boolean tuning knob, fixed-name file CONTENT, or (on the sftp arm) an
 * opaque table-lookup name. There is no field that becomes a path, a host, a
 * credential reference (`@path`), or an argv string. Every directory the
 * exchange uses is generated by the server inside the job workdir; connection
 * material for an sftp exchange comes exclusively from the operator-provisioned
 * remotes table.
 */
export type JobExchangeIntent =
  JobFiledropExchangeIntent | JobSftpExchangeIntent;

/**
 * Upper bound on the `inputCsv` string length, anchored to the browser intake's
 * own file-size gate ({@link MAX_CSV_FILE_BYTES}, 100 MiB): a CSV that passed
 * that gate must never be rejected here. This is a chars-vs-bytes approximation
 * (a JavaScript string length counts UTF-16 code units, not the bytes the file
 * gate measures), generous by construction -- the boundary byte cap
 * ({@link MAX_JOB_BODY_BYTES}) is the true memory bound.
 */
export const MAX_INPUT_CSV_LENGTH = MAX_CSV_FILE_BYTES;

/**
 * Upper bound on the COUNT of `expectedPayloadColumns` entries. A real received
 * set is a handful to a few dozen partner-namespace column names; 4096 is far
 * above any legitimate one yet refuses an unbounded array.
 */
export const MAX_EXPECTED_PAYLOAD_COLUMNS = 4096;

/**
 * Upper bound on the COUNT of `metadata` columns. A real input has tens of
 * columns; 4096 is far above any legitimate schema yet refuses an unbounded array.
 */
export const MAX_METADATA_COLUMNS = 4096;

/**
 * Upper bound on the length of a `metadata` column `description` -- a free-text
 * data-dictionary entry, larger than a name yet still bounded.
 */
export const MAX_METADATA_DESCRIPTION_LENGTH = 4096;

/**
 * Upper bound on the COUNT of `standardization` transformations. One
 * transformation produces one linkage field; 4096 is far above any real pipeline
 * set yet refuses an unbounded array.
 */
export const MAX_STANDARDIZATION_TRANSFORMATIONS = 4096;

/**
 * Upper bound on the COUNT of `steps` in one `standardization` transformation. A
 * real pipeline chains a handful of steps; 256 is generous yet refuses an
 * unbounded array.
 */
export const MAX_STANDARDIZATION_STEPS = 256;

// The size bounds below apply to BOTH union arms through the shared common
// fields. Each `standardization` step's `params` (a Record<string, unknown>) is
// unbounded by nature and left uncapped here; the boundary byte cap
// (MAX_JOB_BODY_BYTES) is its backstop.
const boundedMetadataSchema = MetadataSchema.refine(
  (columns) => columns.length <= MAX_METADATA_COLUMNS,
  { message: "metadata must not exceed the column cap" },
).refine(
  (columns) =>
    columns.every(
      (column) =>
        (column.description?.length ?? 0) <= MAX_METADATA_DESCRIPTION_LENGTH,
    ),
  { message: "a metadata column description exceeds the length cap" },
);

const boundedStandardizationSchema = StandardizationSchema.refine(
  (transformations) =>
    transformations.length <= MAX_STANDARDIZATION_TRANSFORMATIONS,
  { message: "standardization must not exceed the transformation cap" },
)
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          (transformation.steps?.length ?? 0) <= MAX_STANDARDIZATION_STEPS,
      ),
    { message: "a standardization transformation exceeds the step cap" },
  )
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          transformation.output.length <= MAX_NAME_LENGTH &&
          transformation.input.length <= MAX_NAME_LENGTH,
      ),
    { message: "a standardization output or input exceeds the length cap" },
  );

const jobExchangeIntentCommonFields = {
  linkageTerms: LinkageTermsSchema,
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "sharedSecret must be a base64url-encoded 32-byte value (43 base64url characters)",
    ),
  inputCsv: z.string().min(1).max(MAX_INPUT_CSV_LENGTH),
  metadata: boundedMetadataSchema.optional(),
  standardization: boundedStandardizationSchema.optional(),
  expectedPayloadColumns: z
    .array(z.string().max(MAX_NAME_LENGTH))
    .max(MAX_EXPECTED_PAYLOAD_COLUMNS)
    .optional(),
  eventStream: z.boolean().optional(),
};

// Intentionally NOT annotated z.ZodType: z.discriminatedUnion requires concrete
// ZodObject members (the same reason core's connection schemas leave their
// intermediate objects unannotated); type safety is enforced on the union below.
const jobFiledropExchangeIntentSchema = z
  .object({
    channel: z.literal("filedrop"),
    ...jobExchangeIntentCommonFields,
    options: jobExchangeOptionsSchema.optional(),
  })
  .strict();

const jobSftpExchangeIntentSchema = z
  .object({
    channel: z.literal("sftp"),
    remote: z
      .string()
      .regex(
        SFTP_REMOTE_NAME_REGEX,
        "remote must be 1-64 characters of [A-Za-z0-9_-] starting with an alphanumeric",
      ),
    ...jobExchangeIntentCommonFields,
    options: jobSftpExchangeOptionsSchema.optional(),
  })
  .strict();

/**
 * Zod schema for {@link JobExchangeIntent}. Both arms are `.strict()`, so a
 * client cannot smuggle an unmodeled field (a `path`, a `host`, a `server`
 * block, an `@path` credential) past validation, and each arm admits only its
 * own fields: `remote` exists solely on the sftp arm (a filedrop intent
 * carrying one is rejected as an unknown key), and the sftp arm's options
 * variant floors `pollIntervalMs` at 1000 ms because its poll lists a remote
 * operator-provisioned server, not a job-local directory. The `channel`
 * discriminant is a closed two-value set; any other channel is rejected.
 */
export const jobExchangeIntentSchema: z.ZodType<JobExchangeIntent> =
  z.discriminatedUnion("channel", [
    jobFiledropExchangeIntentSchema,
    jobSftpExchangeIntentSchema,
  ]);

/**
 * The fixed, server-chosen file names inside a job workdir. The client never
 * supplies a filename: content it submits is written to these names, and the CLI
 * is pointed at them. Keeping them constant is what makes "a client string never
 * becomes a file path" hold.
 */
export const JOB_FILE_NAMES = {
  /** The composed CLI config document. */
  config: "psilink.yaml",
  /** The CLI key file carrying the shared secret. */
  key: ".psilink.key",
  /** The client's input CSV content. */
  input: "input.csv",
  /** The rendezvous directory the filedrop exchange reads and writes. */
  exchangeDirectory: "exchange",
  /** The CLI's matched-result output. */
  output: "output.csv",
  /** The self-attested exchange record, pinned so the server knows its path
   * (the CLI's `--record-file` target). */
  record: "record.json",
  /** The private verification keys paired with {@link JOB_FILE_NAMES.record}.
   * Must equal the CLI's `keysPathFor` derivation of the record name (`.json` ->
   * `.keys.json`); a unit test pins this cross-workspace pairing. */
  recordKeys: "record.keys.json",
} as const;

/**
 * Compose the CLI config document (snake_case YAML the CLI loads verbatim) from a
 * validated filedrop {@link JobExchangeIntent}, overriding the connection
 * directory to the server-chosen `exchangeDirectoryPath` inside the job workdir.
 *
 * The connection is built as a credential-free filedrop locator, so by core's
 * {@link ExchangeFileInput} typing no credential is representable; `mintExchangeFile`
 * validates the assembled spec through the CLI's own schema and never assembles
 * an `authentication` block (the shared secret rides the key file). The client's
 * `linkageTerms`, and its `metadata`/`standardization` when present, reach the file
 * only after core's schema validation, and the one path field (`path`) is set by
 * the server, not the client.
 *
 * Forwarding `metadata`/`standardization` is what makes the operator's data-prep
 * edits authoritative on the console path: the CLI's `prepareForExchange` uses the
 * composed metadata rather than falling back to `inferMetadata`, so a column the
 * operator marked ignored (or non-payload) is not silently disclosed.
 *
 * `expectedPayloadColumns`, when present, is forwarded as the config's
 * `expected_payload_columns` so the acceptor's received-payload lock-in is
 * enforced explicitly (the CLI prefers it over the `payload.receive` fallback);
 * an empty array is forwarded verbatim -- it means "receive nothing" and must lock
 * in strictly -- and only an omitted field reconciles lazily.
 */
export function composeConfigDocument(
  intent: JobFiledropExchangeIntent,
  exchangeDirectoryPath: string,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { metadata, standardization, expectedPayloadColumns } = intent;
  const fileInput: ExchangeFileInput = {
    connection: {
      channel: "filedrop",
      path: exchangeDirectoryPath,
      ...(options !== undefined ? { options } : {}),
    },
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
  };
  return mintExchangeFile(fileInput);
}

/**
 * Compose the CLI config document for an sftp job from a validated sftp intent
 * and the operator-provisioned remote entry its `remote` name selected.
 *
 * The connection's `server` block is EXACTLY the remotes-table entry: every
 * host, port, identity, and credential-reference field is server-side data
 * validated at boot, and the intent contributes nothing to it -- the remote
 * NAME itself appears nowhere in the document. The entry's `@path` credential
 * strings land in the YAML verbatim: they are references the CLI child resolves
 * at exchange time, so no secret byte transits this process. The client's
 * `linkageTerms`, `metadata`, `standardization`, and `expectedPayloadColumns`
 * reach the file exactly as they do on the filedrop path -- as schema-validated
 * YAML values -- and the tuning `options` are the same numeric/boolean/enum
 * subset (with the sftp poll floor already enforced by the intent schema).
 *
 * This path deliberately does NOT use `mintExchangeFile`: its
 * {@link ExchangeFileInput} typing makes credentials unrepresentable, an
 * invariant shared with the browser minting flow that must not be loosened to
 * admit the appliance's credential-reference entries. Instead the exchange spec
 * is assembled directly, validated through core's {@link ExchangeSpecSchema}
 * (so the CLI's cross-field refines hold before any file is written), and the
 * PARSE RESULT is serialized with the same snakeize + yaml discipline
 * `mintExchangeFile` uses -- only the schema's own fields reach the YAML. No
 * `authentication` block is ever assembled; the shared secret rides the key
 * file.
 */
export function composeSftpConfigDocument(
  intent: JobSftpExchangeIntent,
  remoteEntry: JobSftpRemoteEntry,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { metadata, standardization, expectedPayloadColumns } = intent;
  const assembled: ExchangeSpec = {
    connection: {
      channel: "sftp",
      server: remoteEntry,
      ...(options !== undefined ? { options } : {}),
    },
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
  };
  const validated = ExchangeSpecSchema.parse(assembled);
  return stringifyYaml(snakeizeKeys(validated));
}

/**
 * Serialize the CLI key file body. Only the shared secret is written; no
 * `expires` is stamped, so a server-driven job carries no invitation-token
 * lifetime of its own. Channel-independent: both arms carry `sharedSecret`.
 */
export function composeKeyFileDocument(intent: JobExchangeIntent): string {
  return JSON.stringify({ sharedSecret: intent.sharedSecret });
}

/**
 * Narrow the intent's tuning subset into a {@link FileSyncOptions}. Returns
 * undefined when no option was set, so the composed connection omits the block
 * entirely rather than carrying an empty object.
 */
function intentOptionsToFileSyncOptions(
  options: JobExchangeOptions | undefined,
): FileSyncOptions | undefined {
  if (options === undefined) return undefined;
  const entries = Object.entries(options).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}
