import { pathToFileURL } from "node:url";

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

import { MAX_IDENTITY_LENGTH } from "@psi/identityLabel";

import { isAdmissibleInputName } from "./workInputName";

import type {
  ExchangeFileInput,
  ExchangeSpec,
  FileSyncOptions,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";
import type { JobSftpServerEntry } from "./sftpServer";

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
// directory listing against a REMOTE server the operator authored a connection
// to, so a client-chosen hot poll would flood a shared third-party host rather
// than the job's own local rendezvous directory (the filedrop case, which keeps
// the positive-int floor).
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
 * A reference to a file in the operator-mounted work-input directory, the
 * alternative to inline `inputCsv`. It carries no content: the opaque `name`
 * selects a file in the mounted directory (validated by the listing's own
 * {@link isAdmissibleInputName} single-segment shape rule so it never composes a
 * traversal). The CLI reads the file in place, so no size/mtime snapshot travels.
 */
export interface JobInputFileReference {
  name: string;
}

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
 *   the job workdir; the client never names a file. Exactly one of `inputCsv` or
 *   `inputFile` is set (enforced by {@link jobExchangeIntentSchema}).
 * - `inputFile` is a REFERENCE to a file in the operator-mounted work-input
 *   directory: an opaque single-segment name. The manager composes the mounted
 *   path (`join(jobInputDir, name)`) into the CLI config so the child reads the
 *   file in place; the name never reaches argv, only the server-owned YAML config.
 *   A name that resolves to no regular file is refused before the workdir exists.
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
  /**
   * The mode discriminant, `"exchange"`. Optional on the wire: the merged
   * exchange client predates the discriminant and sends none, so the create route
   * defaults a missing `mode` to `"exchange"` (see {@link jobCreateIntentSchema}).
   * A zero-setup intent ({@link JobZeroSetupIntent}) names itself explicitly.
   */
  mode?: "exchange";
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  inputCsv?: string;
  inputFile?: JobInputFileReference;
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
 * An sftp exchange intent. It carries no connection field at all beyond the
 * shared shape: the appliance runs the one operator-authored SFTP connection, so
 * the client selects nothing. Every piece of connection material (host, port,
 * username, credential references, host-key fingerprint) comes only from the
 * server-side authored entry; the intent contributes only the `sftp`
 * discriminant.
 */
export interface JobSftpExchangeIntent extends JobExchangeIntentBase {
  channel: "sftp";
}

/**
 * The typed, schema-validated intent a client submits to create a job,
 * discriminated on `channel`. It is the ONLY channel from the client into a CLI
 * invocation, and it is injection-closed by construction: every field is either
 * bounded structured data validated by a core schema, a closed enum, a
 * numeric/boolean tuning knob, fixed-name file CONTENT (`inputCsv`), an opaque
 * single-segment name selecting a file in the operator-mounted directory
 * (`inputFile.name`), or credential material written to a fixed key file. There
 * is no field that becomes a path, a host, a credential reference (`@path`), or
 * an argv string. Every directory the exchange uses is generated by the server
 * inside the job workdir; connection material for an sftp exchange comes
 * exclusively from the operator-authored SFTP connection.
 */
export type JobExchangeIntent =
  JobFiledropExchangeIntent | JobSftpExchangeIntent;

/**
 * The linkage-run strategy a zero-setup exchange may select, the CLI's
 * `--linkage-strategy` value: `cascade` (the default: one dependent PSI round per
 * key) or `single-pass` (batch every key into one exchange, disclosing the full
 * per-key value structure to the receiver). A closed two-value enum -- never a
 * path, host, or credential -- so it reaches the CLI as a bounded flag value.
 */
export type JobZeroSetupLinkageStrategy = "cascade" | "single-pass";

/**
 * The fields shared by every {@link JobZeroSetupIntent} arm. A zero-setup exchange
 * carries NO shared secret and NO linkage terms: both parties run the CLI's
 * positional `$0` form against the same server, terms inferred from each party's
 * input file, and there is no application-layer encryption to key. It therefore
 * carries none of the exchange mode's `sharedSecret`, `linkageTerms`, `metadata`,
 * `standardization`, or `expectedPayloadColumns` -- only an input source, the
 * tuning `options` subset, the `eventStream` toggle, and two optional, bounded
 * selectors:
 *
 * - `linkageStrategy` is a closed enum forwarded to the CLI's `--linkage-strategy`.
 * - `identity` is a bounded operator label forwarded to the CLI's `--identity`
 *   (the party name/org/contact string). Bounded by {@link MAX_IDENTITY_LENGTH}
 *   and, being free text rather than a closed enum, additionally forbidden a leading
 *   `-` so a flag-shaped value cannot masquerade as a CLI flag; the driver also
 *   emits it as a single `--identity=<value>` token, which parses a `-`-leading
 *   value verbatim regardless.
 *
 * Neither is a path, host, or credential, so neither can escape into a file path
 * or a connection field. Exactly one of `inputCsv` or `inputFile` is set (enforced
 * by {@link jobZeroSetupIntentSchema}), identically to the exchange mode.
 */
interface JobZeroSetupIntentBase {
  mode: "zeroSetup";
  inputCsv?: string;
  inputFile?: JobInputFileReference;
  options?: JobExchangeOptions;
  eventStream?: boolean;
  linkageStrategy?: JobZeroSetupLinkageStrategy;
  identity?: string;
}

/**
 * A filedrop zero-setup intent. Like the filedrop exchange arm it has no host and
 * no credentials: the connection is a `file://` locator the server builds from the
 * operator-configured rendezvous directory, so the intent contributes no injectable
 * connection field.
 */
export interface JobZeroSetupFiledropIntent extends JobZeroSetupIntentBase {
  channel: "filedrop";
}

/**
 * An sftp zero-setup intent. It carries no connection field at all: the appliance
 * runs one authored SFTP connection, so host, port, path, credential references,
 * and the host-key fingerprint all come from the server-side entry (turned into a
 * `sftp://` URL and `--server-*` flags by {@link zeroSetupSftpArgv}), never from
 * the intent.
 */
export interface JobZeroSetupSftpIntent extends JobZeroSetupIntentBase {
  channel: "sftp";
}

/**
 * The typed, schema-validated intent a client submits to create a zero-setup job,
 * discriminated on `channel`. Injection-closed by construction exactly as the
 * exchange intent is: every field is a bounded input source, a numeric/boolean/enum
 * tuning knob, a closed strategy enum, or a bounded identity label. No field becomes
 * a path, host, credential reference, or argv string; the connection is drawn only
 * from the server (the authored SFTP connection, or the configured rendezvous mount).
 */
export type JobZeroSetupIntent =
  JobZeroSetupFiledropIntent | JobZeroSetupSftpIntent;

/**
 * The union the create route accepts: an exchange intent or a zero-setup intent,
 * discriminated on `mode`, each in turn discriminated on `channel`.
 */
export type JobCreateIntent = JobExchangeIntent | JobZeroSetupIntent;

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

// The `name` is bounded and single-segment by the listing's own shape rule; the
// manager resolves it against the mounted directory at create time and refuses a
// name that names no regular file.
const jobInputFileReferenceSchema: z.ZodType<JobInputFileReference> = z
  .object({
    name: z.string().refine(isAdmissibleInputName, {
      message: "inputFile.name must be a single admissible path segment",
    }),
  })
  .strict();

const jobExchangeIntentCommonFields = {
  linkageTerms: LinkageTermsSchema,
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "sharedSecret must be a base64url-encoded 32-byte value (43 base64url characters)",
    ),
  inputCsv: z.string().min(1).max(MAX_INPUT_CSV_LENGTH).optional(),
  inputFile: jobInputFileReferenceSchema.optional(),
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
// intermediate objects unannotated); type safety is enforced on the unions below.
// Each arm carries the `mode: "exchange"` literal so it can be a member of the
// mode-discriminated union the create route parses; a body that omits `mode`
// still parses as exchange via the route schema's default (see below).
const jobFiledropExchangeIntentSchema = z
  .object({
    mode: z.literal("exchange"),
    channel: z.literal("filedrop"),
    ...jobExchangeIntentCommonFields,
    options: jobExchangeOptionsSchema.optional(),
  })
  .strict();

const jobSftpExchangeIntentSchema = z
  .object({
    mode: z.literal("exchange"),
    channel: z.literal("sftp"),
    ...jobExchangeIntentCommonFields,
    options: jobSftpExchangeOptionsSchema.optional(),
  })
  .strict();

const jobExchangeChannelUnion = z.discriminatedUnion("channel", [
  jobFiledropExchangeIntentSchema,
  jobSftpExchangeIntentSchema,
]);

/** Whether exactly one input source is present -- inline `inputCsv` XOR the mounted
 * `inputFile` reference. Neither (no input) and both (an ambiguous intent) fail.
 * Shared by every arm of every mode; the inputs are identical across them. */
function hasExactlyOneInputSource(intent: {
  inputCsv?: unknown;
  inputFile?: unknown;
}): boolean {
  return (intent.inputCsv !== undefined) !== (intent.inputFile !== undefined);
}

/**
 * The `mode` discriminant defaults to `"exchange"` when absent: the merged
 * exchange client (`serverJobExchangeDriver`) sends an intent with no `mode`, so
 * a body missing it is the exchange mode. A zero-setup body names itself. Applied
 * as a preprocess (only when `mode` is not already an own key, and only to a plain
 * object) so the mode-discriminated union below always sees a present discriminant;
 * it injects a single constant and mutates nothing else, so it opens no field.
 */
function withDefaultExchangeMode(raw: unknown): unknown {
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !("mode" in raw)
  )
    return { ...(raw as Record<string, unknown>), mode: "exchange" };
  return raw;
}

/**
 * Zod schema for a single {@link JobExchangeIntent} (the exchange mode alone).
 * Both arms are `.strict()`, so a client cannot smuggle an unmodeled field (a
 * `path`, a `host`, a `server` block, an `@path` credential, or a
 * connection-selecting `remote`) past validation, and each arm admits only its own
 * fields. The sftp arm carries no connection field at all (the appliance runs one
 * authored connection), and its options variant floors `pollIntervalMs` at 1000 ms
 * because its poll lists a remote authored server, not a job-local directory.
 * A missing `mode` defaults to `"exchange"`, so a merged exchange client parses
 * unchanged.
 *
 * A union-level refine enforces exactly one input source -- inline `inputCsv` or
 * the mounted `inputFile` reference -- on both arms: the arm's strict parse runs
 * first (so a smuggled extra field still fails, on the `inputFile` sub-object too),
 * then the cross-field XOR rejects an intent that names neither or both.
 */
export const jobExchangeIntentSchema: z.ZodType<JobExchangeIntent> = z
  .preprocess(withDefaultExchangeMode, jobExchangeChannelUnion)
  .refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  });

// The identity-label contract (the cap and the leading-dash rule) lives in the
// browser-safe @psi/identityLabel module so the confirm-screen guard shares one
// authority with this schema; re-exported here to preserve its public entry point.
export { MAX_IDENTITY_LENGTH };

// The zero-setup common fields carry NONE of the exchange mode's credential or
// terms material -- no sharedSecret, linkageTerms, metadata, standardization, or
// expectedPayloadColumns -- only an input source, the tuning options, the event
// toggle, and the two bounded selectors. `inputCsv` reuses the exchange mode's cap.
const jobZeroSetupIntentCommonFields = {
  inputCsv: z.string().min(1).max(MAX_INPUT_CSV_LENGTH).optional(),
  inputFile: jobInputFileReferenceSchema.optional(),
  eventStream: z.boolean().optional(),
  linkageStrategy: z.enum(["cascade", "single-pass"]).optional(),
  // Free text, unlike the closed strategy enum: forbid a leading `-` so a
  // flag-shaped label (e.g. "--save") cannot be mistaken for a CLI flag. Defense
  // in depth -- the driver already emits it as a single `--identity=<value>` token,
  // which parses a `-`-leading value verbatim regardless.
  identity: z
    .string()
    .min(1)
    .max(MAX_IDENTITY_LENGTH)
    .regex(/^[^-]/, "identity must not begin with '-'")
    .optional(),
};

// Mode-carrying zero-setup arms, each `.strict()` and discriminated on channel.
// Not annotated z.ZodType for the same reason the exchange arms are not.
const jobZeroSetupFiledropIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("filedrop"),
    ...jobZeroSetupIntentCommonFields,
    options: jobExchangeOptionsSchema.optional(),
  })
  .strict();

const jobZeroSetupSftpIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("sftp"),
    ...jobZeroSetupIntentCommonFields,
    options: jobSftpExchangeOptionsSchema.optional(),
  })
  .strict();

const jobZeroSetupChannelUnion = z.discriminatedUnion("channel", [
  jobZeroSetupFiledropIntentSchema,
  jobZeroSetupSftpIntentSchema,
]);

/**
 * Zod schema for a single {@link JobZeroSetupIntent}. `mode: "zeroSetup"` is
 * required and literal -- a zero-setup intent names itself, so a body that omits
 * `mode` is never admitted here (the create route routes a missing `mode` to the
 * exchange arm). Both channel arms are `.strict()`, so no `sharedSecret`,
 * `linkageTerms`, connection field, or any unmodeled key survives, and the
 * exactly-one-input-source rule holds exactly as in the exchange mode.
 */
export const jobZeroSetupIntentSchema: z.ZodType<JobZeroSetupIntent> =
  jobZeroSetupChannelUnion.refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  });

/**
 * The schema `POST /api/jobs` parses: a discriminated union on `mode`
 * (`exchange` | `zeroSetup`), each in turn discriminated on `channel`. A body that
 * omits `mode` defaults to the exchange arm (the merged client sends none). Every
 * leaf arm is `.strict()`, so a `connection`/`server`/`remote` key -- or any other
 * unmodeled field -- fails the parse on either mode, keeping the create surface
 * injection-closed. The exactly-one-input-source rule is enforced once at the
 * union level over the shared `inputCsv`/`inputFile` fields.
 */
export const jobCreateIntentSchema: z.ZodType<JobCreateIntent> = z
  .preprocess(
    withDefaultExchangeMode,
    z.discriminatedUnion("mode", [
      jobExchangeChannelUnion,
      jobZeroSetupChannelUnion,
    ]),
  )
  .refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  });

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
 * validated filedrop {@link JobExchangeIntent}, setting the connection directory to
 * the operator-configured rendezvous mount (`JOB_RENDEZVOUS_DIR`) both parties can
 * reach. The directory is server-side environment configuration, never a
 * browser-sent string.
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
  rendezvousPath: string,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { metadata, standardization, expectedPayloadColumns } = intent;
  const fileInput: ExchangeFileInput = {
    connection: {
      channel: "filedrop",
      path: rendezvousPath,
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
 * and the operator-authored server entry.
 *
 * The connection's `server` block is EXACTLY the authored entry: every
 * host, port, identity, and credential-reference field is server-side data
 * validated when authored, and the intent contributes nothing to it. The entry's
 * `@path` credential strings land in the YAML verbatim: they are references the
 * CLI child resolves
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
  serverEntry: JobSftpServerEntry,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { metadata, standardization, expectedPayloadColumns } = intent;
  const assembled: ExchangeSpec = {
    connection: {
      channel: "sftp",
      server: serverEntry,
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

// The placeholder host the URL is seeded with, distinguished from a real host so a
// setter no-op (which leaves this value in place) is detectable. `.invalid` is a
// reserved TLD (RFC 6761), so it is never a legitimately authored server.
const ZERO_SETUP_URL_SENTINEL_HOST = "host.invalid";

/**
 * Build the `sftp://` URL a zero-setup job's CLI drives, from the authored
 * server entry's host, port, and path. The host, port, and path go through the
 * WHATWG {@link URL} object (never string concatenation) so each component is
 * encoded correctly; a bare IPv6 literal is bracketed first, since the hostname
 * setter silently rejects an unbracketed one.
 *
 * The composed `url.hostname` -- the WHATWG-canonical form -- is then adopted as the
 * host, rather than requiring it to equal the input verbatim. Exact-equality
 * over-rejected a legitimately-authored non-canonical host the setter safely
 * canonicalizes (a non-canonical or uppercase-hex IPv6 literal like `2001:0db8::0001`
 * -> `[2001:db8::1]`, or an IDN host it percent-encodes), while the exchange mode
 * accepts the same host verbatim. The setter's other two behaviours are the real
 * hazard: it silently TRUNCATES at a URL-significant delimiter (`foo#bar` -> `foo`)
 * and NO-OPS on a host it cannot parse (leaving the sentinel) -- either could point
 * the exchange at the wrong server. Truncation is closed off upstream: the
 * `isBareSftpHost` predicate (`@psi/sftpHost`) rejects every truncating character
 * (`#`, `?`, `\`, `%`) plus userinfo, path, and whitespace, so a host that reaches
 * here can differ from the input ONLY by safe canonicalization. A total drop -- an
 * empty hostname or the untouched sentinel (the no-op) -- is the one alteration still
 * possible here, and it is a compose-time error. Credentials never ride the URL --
 * they are `--server-*` flags built by {@link zeroSetupSftpArgv} -- so no secret byte
 * is ever URL-encoded here.
 */
function buildZeroSetupSftpUrl(serverEntry: JobSftpServerEntry): string {
  const hostForUrl =
    serverEntry.host.includes(":") && !serverEntry.host.startsWith("[")
      ? `[${serverEntry.host}]`
      : serverEntry.host;
  const url = new URL(`sftp://${ZERO_SETUP_URL_SENTINEL_HOST}`);
  url.hostname = hostForUrl;
  if (url.hostname === "" || url.hostname === ZERO_SETUP_URL_SENTINEL_HOST)
    throw new Error(
      "could not encode the authored sftp host into a URL for a zero-setup " +
        "exchange",
    );
  if (serverEntry.port !== undefined) url.port = String(serverEntry.port);
  if (serverEntry.path !== undefined) url.pathname = serverEntry.path;
  return url.href;
}

/**
 * Map the operator-authored SFTP server entry to the connection portion of a
 * zero-setup CLI argv: the `sftp://` URL positional plus the `--server-*` flags.
 * The argv analog of {@link composeSftpConfigDocument} -- it draws every field from
 * the server entry, contributing nothing from the client.
 *
 * Credentials are emitted as single `--server-<field>=@path` tokens with the `@path`
 * string VERBATIM (the same `@path` the entry carries), never a resolved secret: the
 * CLI child resolves the reference at live-use, so no secret byte is ever on argv.
 * Every value-bearing flag uses the `=value` form (never a two-token pair) so a value
 * that begins with `-` cannot be misparsed by yargs as its own flag. The
 * primary credential (`password` or `private_key`) is picked exactly as
 * {@link composeSftpConfigDocument} lets core pick it -- whichever the entry carries,
 * at most one -- with the optional passphrase (`@path`) and keyboard-interactive
 * toggle alongside.
 *
 * The host-key fingerprint is MANDATORY and always emitted: a zero-setup run has no
 * TTY, so trust-on-first-use is impossible and the pin is the only host-key defense.
 * The CLI flag is single-valued, so a multi-fingerprint entry (an `Array`) is a
 * compose-time error rather than a silently dropped pin -- a repeatable/multi-pin
 * flag is out of scope for this slice.
 */
export function zeroSetupSftpArgv(
  serverEntry: JobSftpServerEntry,
): Array<string> {
  const argv: Array<string> = [buildZeroSetupSftpUrl(serverEntry)];
  if (serverEntry.username !== undefined)
    argv.push(`--server-username=${serverEntry.username}`);
  if (serverEntry.password !== undefined)
    argv.push(`--server-password=${serverEntry.password}`);
  else if (serverEntry.privateKey !== undefined)
    argv.push(`--server-private-key=${serverEntry.privateKey}`);
  if (serverEntry.privateKeyPassphrase !== undefined)
    argv.push(
      `--server-private-key-passphrase=${serverEntry.privateKeyPassphrase}`,
    );
  if (serverEntry.keyboardInteractive === true)
    argv.push("--server-keyboard-interactive");
  if (Array.isArray(serverEntry.hostKeyFingerprint))
    throw new Error(
      "a zero-setup exchange cannot pin more than one host-key fingerprint; " +
        "the CLI --server-host-key-fingerprint flag is single-valued",
    );
  argv.push(`--server-host-key-fingerprint=${serverEntry.hostKeyFingerprint}`);
  return argv;
}

/**
 * Map the operator-configured rendezvous directory to the connection portion of a
 * filedrop zero-setup CLI argv: a single `file://` URL positional. Built through
 * {@link pathToFileURL} from the server-side directory, so no client string is ever
 * a path and the URL is always well formed. The filedrop channel has no host or
 * credential, so this is the whole connection.
 */
export function zeroSetupFiledropArgv(rendezvousDir: string): Array<string> {
  return [pathToFileURL(rendezvousDir).href];
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
