/**
 * The job intent: the shape a client submits to create a job, its Zod schemas,
 * and the label and note contracts every surface that admits one shares -- the
 * browser guards that check a field as it is typed and the server validators
 * that check it again at the boundary. No Node import, so a browser guard can
 * read a contract here without pulling the server's own composition modules
 * ({@link ./intentConfig}, {@link ./intentArgv}) into its bundle.
 */

import { z } from "zod";

import {
  FINGERPRINT_REGEX,
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_RECONNECT_ATTEMPTS,
  MAX_TEXT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MetadataSchema,
  SHARED_SECRET_REGEX,
  StandardizationSchema,
  safeParseFileSyncOptions,
} from "@psilink/core";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import { isAdmissibleInputName } from "./workInputName";

import type {
  FileSyncOptions,
  LinkageTerms,
  Metadata,
  SigningConfig,
  Standardization,
} from "@psilink/core";

/**
 * Upper bound on the `identity` label a zero-setup intent may hold (the CLI's
 * `--identity` value: the party's name/org/contact string). Generous for a real
 * label yet refuses an unbounded string; a non-secret operator value, never a path
 * or credential.
 */
export const MAX_IDENTITY_LENGTH = 1024;

/**
 * The control characters an `identity` label may not contain: C0 (NUL among
 * them), DEL, and the C1 range, with NO exception for tab, line feed, or
 * carriage return -- unlike the retention note's rule
 * ({@link NOTE_CONTROL_CHAR_PATTERN}), whose field is a multi-line textarea.
 * This label rides to the CLI as one `--identity=<value>` token and is bound
 * into a long-lived certificate the partner pins and DISPLAYS, so no control
 * byte in it is text the operator meant to write. Letters outside ASCII are
 * untouched -- the range stops below U+00A0, so a label written in the
 * operator's own script stays admissible.
 *
 * Core's terms-document rule (`TEXT_CONTROL_CHAR_PATTERN`,
 * packages/core/src/config/linkageTermsSchema.ts) draws the same ranges over
 * the four free-text fields of a linkage-terms document, the party `identity`
 * among them, which a label accepted here becomes; the two patterns are held
 * equal by test/unit/identityLabelParity.test.ts. This contract is stricter: it
 * also refuses a leading `-`.
 */
export const IDENTITY_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The reason every boundary reports for a label containing one, so the surfaces
 * enforcing the rule say the same thing about the same value. A field path and a
 * shape reason, never the submitted bytes: the label is the submitter's own text,
 * and echoing it back is what the job API's error discipline exists to prevent.
 */
export const IDENTITY_CONTROL_CHAR_MESSAGE =
  "identity must not contain control characters";

/**
 * Upper bound on a `peer_id`. It prefixes every filename this party writes into
 * the shared directory, alongside a suffix and (in retain mode) a timestamp and
 * counter, so a short label is the only legitimate shape; 64 leaves ample room
 * under every filesystem's component limit.
 */
export const MAX_PEER_ID_LENGTH = 64;

/**
 * The shape a `peer_id` may take when it is authored in the console: a single
 * label that starts and ends with an ASCII letter or digit and otherwise admits
 * only ASCII letters, digits, spaces, `-`, and `_`. Core permits any non-empty
 * string, but a value from the job API becomes a filename component in a
 * directory the SERVER owns, so separators, dot runs, and a leading dash that
 * could compose a path, a traversal, or a flag-shaped token are refused.
 */
export const PEER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/;

/** Whether `value` is an admissible `peer_id`: within
 * {@link MAX_PEER_ID_LENGTH} and matching {@link PEER_ID_PATTERN}. */
export function isAdmissiblePeerId(value: string): boolean {
  return value.length <= MAX_PEER_ID_LENGTH && PEER_ID_PATTERN.test(value);
}

/** The message both the console guard and the intent schema report for a
 * `peer_id` that fails {@link isAdmissiblePeerId}, so the two surfaces say the
 * same thing about the same value. It names the ASCII bound
 * {@link PEER_ID_PATTERN} enforces, so an operator who typed an accented or
 * non-Latin name reads why it was refused rather than a description of what
 * they typed. */
export const PEER_ID_SHAPE_MESSAGE =
  "The party name must be a single label of ASCII letters (A-Z, a-z), digits, " +
  "spaces, '-', or '_', beginning and ending with a letter or digit. Write an " +
  "accented or non-Latin name in ASCII instead.";

// The control characters a retention note may not contain: C0 and C1 plus DEL,
// minus the three whitespace controls a multi-line note may hold (tab, LF, CR).
// The field is authored in a textarea, so the ranges are narrower than the
// single-segment name rule's in ./workInputName, which admits no whitespace
// control at all. The note goes into the YAML verbatim and from there into this
// party's exchange record.
export const NOTE_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * The tuning settings a client may set on a job: the numeric, boolean,
 * closed-enum, and bounded-label subset of the CLI's file-sync options. None
 * can hold a path, host, credential, or command. The path and directory
 * fields of {@link FileSyncOptions} are not exposed -- the server owns every
 * directory.
 *
 * `peerId` is the one free-text field: it becomes a FILENAME PREFIX in the
 * shared rendezvous directory, so {@link isAdmissiblePeerId} confines it to a
 * single bounded label -- never a separator, a dot run, or a leading dash.
 * Its semantic rules (the `timestampInFilename` dependency and the reserved
 * `temp` value) are core's, applied through core's own schema.
 *
 * Not every arm admits every field. `connectionPerPoll` is admitted on the
 * sftp arms alone. The zero-setup arms admit only what their argv can pass
 * (see `zeroSetupOptionsArgv` in `./intentArgv`); a field with no route to
 * that run is
 * refused rather than accepted and dropped.
 */
export interface JobExchangeOptions {
  pollIntervalMs?: number;
  peerTimeoutMs?: number;
  serverConnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  timestampInFilename?: boolean;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  unexpectedFiles?: "error" | "warn" | "ignore";
  connectionPerPoll?: boolean;
}

/**
 * Run the resolved option block through core's own {@link FileSyncOptions}
 * schema and re-raise its issues on this boundary's parse. Core is the single
 * source for every cross-field rule -- `peer_id` requires
 * `timestamp_in_filename`, `peer_id` may not be the reserved `temp`, and
 * `retain_files` requires both `timestamp_in_filename` and
 * `lockless_rendezvous`.
 */
function checkAgainstCoreFileSyncOptions(
  options: JobExchangeOptions,
  ctx: z.RefinementCtx,
): void {
  const validation = safeParseFileSyncOptions(options);
  if (validation.success) return;
  for (const issue of validation.error.issues)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path,
    });
}

// The poll interval has no floor beyond core's own positive-integer rule,
// matching the CLI: a sub-second poll is warned about (the anti-flood
// advisory at LOW_POLLING_FREQUENCY_WARN_MS) and allowed rather than
// refused, since it is the operator's own choice about a server they
// authored the connection to.
const jobExchangeOptionsFields = {
  pollIntervalMs: z.number().int().positive().optional(),
  peerTimeoutMs: z.number().int().positive().optional(),
  serverConnectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECONNECT_ATTEMPTS)
    .optional(),
  timestampInFilename: z.boolean().optional(),
  locklessRendezvous: z.boolean().optional(),
  peerId: z
    .string()
    .refine(isAdmissiblePeerId, { message: PEER_ID_SHAPE_MESSAGE })
    .optional(),
  retainFiles: z.boolean().optional(),
};

const jobExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobExchangeOptionsFields,
    unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

// The sftp variant adds `connectionPerPoll`, and only it: the mode dials a
// real SFTP socket, which filedrop's connectionless client has none of. The
// strict parse refuses it on the filedrop arm.
const jobSftpExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobExchangeOptionsFields,
    unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
    connectionPerPoll: z.boolean().optional(),
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

/**
 * A millisecond duration a zero-setup run must be able to express as one of
 * the CLI's coarse duration flags (`--peer-timeout`, `--connection-timeout`),
 * whose grammar takes a second-or-coarser unit. A value that is not a whole
 * number of seconds is refused here rather than rounded.
 *
 * Both flags are also capped at core's {@link MAX_TIMEOUT_SECONDS} (seven
 * days), which the CLI enforces as a usage error; a value past it is refused
 * here too, rather than occupying the console's single run slot on a job
 * whose spawned child exits 64 on the very argv the job exists to run.
 */
function wholeSecondFlagMs(field: string) {
  return z
    .number()
    .int()
    .positive()
    .max(
      MAX_TIMEOUT_SECONDS * 1000,
      `${field} must not exceed ${MAX_TIMEOUT_SECONDS / 86_400} days on a ` +
        "zero-setup exchange: the duration flag it is carried on refuses a " +
        "longer value",
    )
    .refine((ms) => ms % 1000 === 0, {
      message:
        `${field} must be a whole number of seconds on a zero-setup ` +
        "exchange: it is carried to the run as a duration flag, whose value " +
        "takes a second-or-coarser unit",
    })
    .optional();
}

// The zero-setup arms admit only what `zeroSetupOptionsArgv` (./intentArgv) can pass
// to the child. `unexpectedFiles` is absent: it has no CLI flag, and a
// zero-setup run composes no configuration document, so the strict parse
// refuses it rather than accepting a choice the run would drop. The two
// coarse-duration fields are held to whole seconds, the only values their
// flags can state.
const jobZeroSetupOptionsFields = {
  ...jobExchangeOptionsFields,
  peerTimeoutMs: wholeSecondFlagMs("peerTimeoutMs"),
  serverConnectTimeoutMs: wholeSecondFlagMs("serverConnectTimeoutMs"),
};

const jobZeroSetupOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object(jobZeroSetupOptionsFields)
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

const jobZeroSetupSftpOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobZeroSetupOptionsFields,
    connectionPerPoll: z.boolean().optional(),
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

/**
 * A reference to a file in the operator-mounted work-input directory, the
 * alternative to inline `inputCsv`. It holds no content: the opaque `name`
 * selects a file in the mounted directory (validated by the listing's own
 * {@link isAdmissibleInputName} single-segment shape rule so it never
 * composes a traversal). The CLI reads the file in place, so no size/mtime
 * snapshot travels.
 */
export interface JobInputFileReference {
  name: string;
}

/**
 * The receipt-signing mode a job may ask for. Narrower than core's
 * {@link SigningMode} by design: it allowlists the two modes an exchange
 * honors, as core's own `assertSigningModeImplemented` does, so
 * `session-derived` -- and any mode later added to core's enum but not yet
 * implemented -- is refused here rather than accepted into a job whose
 * spawned child then exits 64. The console's own card offers the mode as a
 * disabled choice with core's reason, as it already does for `psi-c` and
 * `deduplicate`.
 */
type JobSigningMode = "none" | "certificate";

/**
 * The receipt-signing choices a client may set on an exchange job: the mode,
 * and the partner fingerprint to pin under `certificate`.
 *
 * The two PATH fields of core's {@link SigningConfig} -- `identity_file` and
 * `receipt_output` -- are not representable here: the server owns every path
 * a job's CLI child is pointed at. They are supplied at composition from
 * {@link JobSigningPaths}.
 *
 * `partnerFingerprint` is the one free-text field: core's
 * {@link FINGERPRINT_REGEX} admits exactly a canonical 43-character unpadded
 * base64url SHA-256 digest, so the value cannot hold a separator, a path, or
 * a flag-shaped token. It is a public digest of a public certificate, not a
 * credential, and is required under `certificate` (see
 * {@link jobSigningChoiceSchema}).
 */
export interface JobSigningChoice {
  mode: JobSigningMode;
  partnerFingerprint?: string;
}

const jobSigningChoiceSchema: z.ZodType<JobSigningChoice> = z
  .object({
    mode: z.enum(["none", "certificate"]),
    partnerFingerprint: z
      .string()
      .regex(
        FINGERPRINT_REGEX,
        "partnerFingerprint must be an unpadded base64url SHA-256 digest (43 " +
          "characters), as 'psilink fingerprint' prints it",
      )
      .optional(),
  })
  .strict()
  // A pin is meaningful only where a certificate is verified against it, so
  // a fingerprint beside `mode: none` is refused rather than composed into a
  // config whose pin nothing reads.
  .refine(
    (signing) =>
      signing.mode === "certificate" ||
      signing.partnerFingerprint === undefined,
    {
      message:
        "partnerFingerprint is only admissible with signing mode 'certificate'",
      path: ["partnerFingerprint"],
    },
  )
  // And the converse: certificate mode requires one, matching core's own
  // pre-exchange gate (`assertCertificateModePinsPartner`). Without a pin,
  // the spawned child's own refusal would come only after this party's
  // payload has crossed; refusing at create time closes that. Authoring is
  // untouched, since a draft is not a job.
  .refine(
    (signing) =>
      signing.mode !== "certificate" ||
      signing.partnerFingerprint !== undefined,
    {
      message:
        "partnerFingerprint is required with signing mode 'certificate': an " +
        "exchange that signs receipts cannot verify the partner's certificate " +
        "without a pinned fingerprint, and is refused before it runs",
      path: ["partnerFingerprint"],
    },
  );

/**
 * The paths a composed `signing` block names, supplied by the caller rather
 * than the client. Split from {@link JobSigningChoice}: the choice is the
 * operator's, while the paths belong to whichever machine the composed
 * document is for -- the console's own mount and workdir for a live run, or
 * the operator's host for the graduation template, whose caller passes
 * placeholders instead (see `handoff.ts`).
 */
export interface JobSigningPaths {
  /** Absolute path of the signing identity file the run loads its private key
   * and certificate from (`signing.identity_file`). */
  identityFile: string;
  /**
   * Absolute path the dual-signed receipt is written to
   * (`signing.receipt_output`), or undefined to omit the key -- the CLI then
   * writes a timestamped receipt into the run's working directory, so repeated
   * runs of one config accumulate an audit trail instead of overwriting one file.
   */
  receiptOutput?: string;
}

/**
 * The `signing` block a validated intent composes, or undefined when the
 * config holds none. Only `certificate` composes a block: `none`, and an
 * intent that states no choice at all, compose the absent block the CLI
 * already treats as "sign nothing".
 *
 * Both throws below guard an impossible state on a schema-validated intent
 * rather than a live branch: `jobSigningChoiceSchema`'s refine requires a
 * certificate intent to hold `partnerFingerprint`, so composing one without
 * it means a caller reached this function with a hand-built intent that
 * bypassed the schema. Throwing turns that into a loud failure at compose
 * time rather than a config the CLI child would refuse later with a bare
 * exit 64.
 */
export function composedSigning(
  intent: JobExchangeIntent,
  paths: JobSigningPaths | undefined,
): SigningConfig | undefined {
  if (intent.signing?.mode !== "certificate") return undefined;
  if (paths === undefined)
    throw new Error(
      "certificate-mode signing reached config composition with no identity " +
        "path resolved",
    );
  if (intent.signing.partnerFingerprint === undefined)
    throw new Error(
      "certificate-mode signing reached config composition with no partner " +
        "fingerprint pinned",
    );
  return {
    mode: "certificate",
    identityFile: paths.identityFile,
    partnerFingerprint: intent.signing.partnerFingerprint,
    ...(paths.receiptOutput !== undefined
      ? { receiptOutput: paths.receiptOutput }
      : {}),
  };
}

/**
 * Which side of the partnership the submitting party is running. A closed
 * two-value enum -- never a path, host, or credential -- holding no
 * connection or column material of its own; it selects a composition rule,
 * not a value.
 */
export type JobExchangeSide = "inviter" | "acceptor";

/**
 * The fields shared by every {@link JobExchangeIntent} arm. Field-level
 * contracts (see {@link jobExchangeIntentSchema} for the closure argument):
 *
 * - `linkageTerms` is validated by core's {@link LinkageTermsSchema}: bounded
 *   partner-authored text (field names, key elements, transforms) holding no
 *   filesystem path, host, or command field.
 * - `sharedSecret` is credential material matching the CLI key-file shape,
 *   written into a fixed-name key file, never a path or argv fragment.
 * - `inputCsv` is CONTENT the server writes to a fixed, server-chosen
 *   filename in the job workdir; the client never names a file. Exactly one
 *   of `inputCsv` or `inputFile` is set (enforced by
 *   {@link jobExchangeIntentSchema}).
 * - `inputFile` is a REFERENCE to a file in the operator-mounted work-input
 *   directory: an opaque single-segment name resolved server-side
 *   (`join(jobInputDir, name)`); the name never reaches argv. A name that
 *   resolves to no regular file is refused before the workdir exists.
 * - `options` is the numeric/boolean/enum subset of the CLI's tuning options.
 * - `metadata` and `standardization` are the operator's per-party data-prep
 *   edits (which columns are sent vs ignored, their roles/types, and the
 *   transform pipeline), validated by core's {@link MetadataSchema} and
 *   {@link StandardizationSchema} and written into the composed config as
 *   YAML values, never an argv fragment, path, host, or credential. Both are
 *   bounded web-side ({@link MAX_METADATA_COLUMNS},
 *   {@link MAX_METADATA_DESCRIPTION_LENGTH},
 *   {@link MAX_STANDARDIZATION_TRANSFORMATIONS},
 *   {@link MAX_STANDARDIZATION_STEPS}, {@link MAX_NAME_LENGTH} on
 *   `output`/`input`); a standardization step's `params` is uncapped by
 *   nature, bounded only by the boundary byte cap. A standardization
 *   raw-pattern step is not dialect-checked the way a `linkageTerms` pattern
 *   is, but still compiles and runs under core's linear-time RE2 engine
 *   (RE2JS), so an oversized or non-conformant one is a compile/size cost,
 *   not a ReDoS hole or an injection escape.
 * - `expectedPayloadColumns` is the acceptor's received-payload enforcement:
 *   a list of partner-namespace column names, no path/host/credential. See
 *   the field doc for the empty-vs-absent semantics.
 * - `expectedPartnerDeduplicate` is the acceptor's terms-side enforcement: a
 *   schema boolean, contributing one YAML `true`/`false` and no free text.
 * - `side` is a closed two-value enum selecting which composition rules apply
 *   to this party; it contributes no value to the composed config.
 * - `diagnosticRun` and `sweepExchangeFiles` are the per-run controls
 *   ({@link jobRunControlFields}): booleans that each select a fixed CLI
 *   flag and hold no value of their own.
 * - `signing` is the receipt-signing choice ({@link JobSigningChoice}): a
 *   closed two-value mode plus, under `certificate`, a required fingerprint
 *   held to core's canonical 43-character digest shape. Neither the identity
 *   file nor the receipt output is representable -- the server supplies both
 *   paths. Under `certificate`, this intent's own `linkageTerms.identity` is
 *   required too (see {@link jobExchangeIntentSchema}).
 * - `retentionDisposition` is this party's own free-text retention note,
 *   written into the composed config as a YAML value and from there into
 *   this party's exchange record. Bounded by core's `MAX_TEXT_LENGTH` and a
 *   control-character rule that refuses every C0 and C1 control and DEL
 *   apart from the tab, LF, and CR a multi-line note holds; never a path,
 *   host, credential, or argv fragment.
 */
interface JobExchangeIntentBase {
  /**
   * The mode discriminant, `"exchange"`. Optional on the wire: the merged
   * exchange client sends none, so the create route defaults a missing
   * `mode` to `"exchange"` (see {@link jobCreateIntentSchema}). A zero-setup
   * intent ({@link JobZeroSetupIntent}) names itself explicitly.
   */
  mode?: "exchange";
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  inputCsv?: string;
  inputFile?: JobInputFileReference;
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * The acceptor's RECEIVE-side enforcement: the partner-namespace columns
   * this party will enforce it receives (the invitation's disclosed set).
   * Mirrors the browser acceptor's `prepared.expectedPayloadColumns`, so an
   * inviter that sends extra columns aborts the exchange rather than having
   * them silently ingested. Column names only -- never a path, host, or
   * credential.
   *
   * The empty-vs-absent distinction is critical: an empty array is a strict
   * "receive nothing" (a non-empty partner payload then aborts), while an
   * omitted field reconciles lazily. It is forwarded (below) whenever
   * present, including an empty array, so the strict form is preserved.
   */
  expectedPayloadColumns?: Array<string>;
  /**
   * The acceptor's TERMS-side enforcement: the `deduplicate` the invitation
   * declared for the INVITING party's own side. Mirrors the browser
   * acceptor's `prepared.expectedPartnerDeduplicate`, so an inviter
   * presenting a different value at the terms exchange aborts the exchange
   * before any key or payload moves. A schema boolean -- never a path, host,
   * or credential, and never free text.
   *
   * Absent is a party with no declaration to bind (the inviter, or a config
   * authored rather than accepted); it is forwarded (below) whenever
   * present, including `false`, a real declaration.
   */
  expectedPartnerDeduplicate?: boolean;
  /**
   * Which side of the partnership this party runs. The composers read it for
   * one decision: only an acceptance derives an `outbound_payload_consent`
   * record into the composed config, because only an acceptance has an
   * outbound set nobody authored (the invitation authors the inviter's and
   * pins it; the mirror leaves the acceptor's absent, so it resolves from
   * this party's own columns). See `composeConfigDocument` in `./intentConfig`.
   *
   * Optional on the wire; an absent value composes no record. The
   * server-job driver's own config makes `side` required, so the console
   * cannot build an acceptance that omits it.
   */
  side?: JobExchangeSide;
  options?: JobExchangeOptions;
  eventStream?: boolean;
  diagnosticRun?: boolean;
  sweepExchangeFiles?: boolean;
  signing?: JobSigningChoice;
  retentionDisposition?: string;
}

/**
 * A filedrop exchange intent. A filedrop exchange has no host and no
 * credentials at all, so the connection block the server composes holds no
 * injectable field; the one path field is the server-chosen rendezvous
 * directory inside the job workdir.
 */
export interface JobFiledropExchangeIntent extends JobExchangeIntentBase {
  channel: "filedrop";
}

/**
 * An sftp exchange intent. It holds no connection field at all beyond the
 * shared shape: the console runs the one operator-authored SFTP connection,
 * so the client selects nothing. Every piece of connection material (host,
 * port, username, credential references, host-key fingerprint) comes only
 * from the server-side authored entry; the intent contributes only the
 * `sftp` discriminant.
 */
export interface JobSftpExchangeIntent extends JobExchangeIntentBase {
  channel: "sftp";
}

/**
 * The typed, schema-validated intent a client submits to create a job,
 * discriminated on `channel`. It is the ONLY channel from the client into a CLI
 * invocation, and it is injection-closed by construction: every field is either
 * bounded structured data validated by a core schema, a closed enum, a
 * numeric/boolean tuning setting, fixed-name file CONTENT (`inputCsv`), an opaque
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
 * The fields shared by every {@link JobZeroSetupIntent} arm. A zero-setup
 * exchange has NO shared secret and NO linkage terms: both parties run the
 * CLI's positional `$0` form against the same server, terms inferred from
 * each party's input file, with no application-layer encryption to key. It
 * therefore holds none of the exchange mode's `sharedSecret`,
 * `linkageTerms`, `metadata`, `standardization`, `expectedPayloadColumns`,
 * or `expectedPartnerDeduplicate` -- only an input source, the tuning
 * `options` subset, the `eventStream` toggle, the per-run controls
 * ({@link jobRunControlFields}), and two optional, bounded selectors:
 *
 * - `linkageStrategy` is a closed enum forwarded to the CLI's
 *   `--linkage-strategy`.
 * - `identity` is a bounded operator label forwarded to the CLI's
 *   `--identity` (the party name/org/contact string), bounded by
 *   {@link MAX_IDENTITY_LENGTH} and held to the shared label contract's two
 *   shape rules: no leading `-` and no control character.
 *
 * Neither is a path, host, or credential. Exactly one of `inputCsv` or
 * `inputFile` is set (enforced by {@link jobZeroSetupIntentSchema}),
 * identically to the exchange mode.
 */
interface JobZeroSetupIntentBase {
  mode: "zeroSetup";
  inputCsv?: string;
  inputFile?: JobInputFileReference;
  options?: JobExchangeOptions;
  eventStream?: boolean;
  diagnosticRun?: boolean;
  sweepExchangeFiles?: boolean;
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
 * An sftp zero-setup intent. It holds no connection field at all: the
 * console runs one authored SFTP connection, so host, port, path, credential
 * references, and the host-key fingerprint all come from the server-side
 * entry (turned into a `sftp://` URL and `--server-*` flags by
 * `zeroSetupSftpArgv` in `./intentArgv`), never from the intent.
 */
export interface JobZeroSetupSftpIntent extends JobZeroSetupIntentBase {
  channel: "sftp";
}

/**
 * The typed, schema-validated intent a client submits to create a zero-setup job,
 * discriminated on `channel`. Injection-closed by construction exactly as the
 * exchange intent is: every field is a bounded input source, a numeric/boolean/enum
 * tuning setting, a closed strategy enum, or a bounded identity label. No field becomes
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

// The size bounds below apply to both union arms through the shared common
// fields. Each `standardization` step's `params` (a Record<string, unknown>)
// is unbounded by nature and left uncapped here; the boundary byte cap
// (MAX_JOB_BODY_BYTES) is its safety check.
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

/**
 * The per-run diagnostic and recovery controls, admitted on every arm of both
 * modes. Each is a bare boolean that selects a fixed CLI flag rather than
 * contributing a value, so neither can become a path, host, credential, or
 * argv fragment.
 *
 * They are per-run rather than console state, matching the console's
 * author-and-run-once shape: nothing about one run's choice survives into
 * the next.
 *
 * `sweepExchangeFiles` reaches the CLI as `--sweep-exchange-files` and
 * nothing else -- the classification of what is a protocol file, and the
 * retain-mode guard over it, are the CLI's. The escalation past that guard
 * (`--force-retain-sweep`) is not representable here.
 */
const jobRunControlFields = {
  diagnosticRun: z.boolean().optional(),
  sweepExchangeFiles: z.boolean().optional(),
};

const jobExchangeIntentCommonFields = {
  ...jobRunControlFields,
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
  expectedPartnerDeduplicate: z.boolean().optional(),
  side: z.enum(["inviter", "acceptor"]).optional(),
  eventStream: z.boolean().optional(),
  signing: jobSigningChoiceSchema.optional(),
  retentionDisposition: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .refine((note) => !NOTE_CONTROL_CHAR_PATTERN.test(note), {
      message: "retentionDisposition must not contain control characters",
    })
    .optional(),
};

// Not annotated z.ZodType: z.discriminatedUnion requires concrete ZodObject
// members (the same reason core's connection schemas leave their
// intermediate objects unannotated); type safety is enforced on the unions
// below. Each arm holds the `mode: "exchange"` literal so it can be a member
// of the mode-discriminated union the create route parses; a body that
// omits `mode` still parses as exchange via the route schema's default (see
// below).
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
 * Whether the intent's own terms name this party, where the receipt-signing
 * choice needs a name. An intent that signs nothing passes whatever its
 * terms hold: identity is optional everywhere else on this surface. Takes
 * an exchange intent alone -- a zero-setup one holds neither field, and the
 * create union's refine selects the arm by its discriminant instead.
 *
 * A blank label is absence: core's terms schema refuses an empty identity
 * outright, so a whitespace-only value could never have reached the agreed
 * terms as a name.
 *
 * Applied at both union levels, as {@link hasExactlyOneInputSource} is: the
 * create route parses {@link jobCreateIntentSchema}'s own mode-discriminated
 * union rather than {@link jobExchangeIntentSchema}. It cannot live on the
 * arms themselves -- `z.discriminatedUnion` takes concrete `ZodObject`
 * members, and a refine wraps one -- nor beside the pin rule in
 * `jobSigningChoiceSchema`, which sees only the signing block.
 */
function certificateModeNamesThisParty(intent: {
  signing?: JobSigningChoice;
  linkageTerms: LinkageTerms;
}): boolean {
  if (intent.signing?.mode !== "certificate") return true;
  return (intent.linkageTerms.identity ?? "").trim() !== "";
}

/** The refusal message {@link certificateModeNamesThisParty} uses at both
 * union levels, stated once so the two cannot drift. */
const UNNAMED_CERTIFICATE_PARTY_ISSUE = {
  message:
    "linkageTerms.identity is required with signing mode 'certificate': a " +
    "certificate is trusted by the identity its holder used in the agreed " +
    "terms, so an exchange that names no party cannot sign a receipt, and is " +
    "refused before it runs",
  path: ["linkageTerms", "identity"],
};

/**
 * Zod schema for a single {@link JobExchangeIntent} (the exchange mode
 * alone). Both arms are `.strict()`, so a client cannot smuggle an unmodeled
 * field (a `path`, a `host`, a `server` block, an `@path` credential, or a
 * connection-selecting `remote`) past validation. The sftp arm holds no
 * connection field at all (the console runs one authored connection), and
 * its options variant differs from the filedrop arm's only in admitting
 * `connectionPerPoll`. A missing `mode` defaults to `"exchange"`.
 *
 * A union-level refine enforces exactly one input source -- inline
 * `inputCsv` or the mounted `inputFile` reference -- on both arms: the
 * arm's strict parse runs first, then the cross-field XOR rejects an
 * intent that names neither or both.
 */
export const jobExchangeIntentSchema: z.ZodType<JobExchangeIntent> = z
  .preprocess(withDefaultExchangeMode, jobExchangeChannelUnion)
  .refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  })
  // Certificate mode also requires a named party, matching core's own
  // pre-exchange gate (`assertCertificateModeNamesLocalParty`): a
  // certificate is trusted by the identity its holder used in the agreed
  // terms, so a job whose terms hold none is refused here rather than
  // inside the exchange, after this party's payload has crossed. It sits
  // here rather than in `jobSigningChoiceSchema` because it spans two
  // blocks: only the whole intent holds both `signing` and `linkageTerms`.
  .refine(certificateModeNamesThisParty, UNNAMED_CERTIFICATE_PARTY_ISSUE);

// The zero-setup common fields hold NONE of the exchange mode's credential
// or terms material -- no sharedSecret, linkageTerms, metadata,
// standardization, expectedPayloadColumns, or expectedPartnerDeduplicate --
// only an input source, the tuning options, the event toggle, and the two
// bounded selectors. `inputCsv` reuses the exchange mode's cap.
const jobZeroSetupIntentCommonFields = {
  ...jobRunControlFields,
  inputCsv: z.string().min(1).max(MAX_INPUT_CSV_LENGTH).optional(),
  inputFile: jobInputFileReferenceSchema.optional(),
  eventStream: z.boolean().optional(),
  linkageStrategy: z.enum(["cascade", "single-pass"]).optional(),
  // Free text, unlike the closed strategy enum, so it takes the shared label
  // contract's two shape rules (`@jobs/intentSchemas`): no leading `-` and no
  // control character. The driver emits it as a single `--identity=<value>`
  // token, which parses a `-`-leading value verbatim regardless.
  identity: z
    .string()
    .min(1)
    .max(MAX_IDENTITY_LENGTH)
    .regex(/^[^-]/, "identity must not begin with '-'")
    .refine((label) => !IDENTITY_CONTROL_CHAR_PATTERN.test(label), {
      message: IDENTITY_CONTROL_CHAR_MESSAGE,
    })
    .optional(),
};

// Mode-holding zero-setup arms, each `.strict()` and discriminated on channel.
// Not annotated z.ZodType for the same reason the exchange arms are not.
const jobZeroSetupFiledropIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("filedrop"),
    ...jobZeroSetupIntentCommonFields,
    options: jobZeroSetupOptionsSchema.optional(),
  })
  .strict();

const jobZeroSetupSftpIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("sftp"),
    ...jobZeroSetupIntentCommonFields,
    options: jobZeroSetupSftpOptionsSchema.optional(),
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
 * (`exchange` | `zeroSetup`), each in turn discriminated on `channel`. A
 * body that omits `mode` defaults to the exchange arm. Every leaf arm is
 * `.strict()`, so a `connection`/`server`/`remote` key -- or any other
 * unmodeled field -- fails the parse on either mode. The
 * exactly-one-input-source rule and the named-party rule certificate-mode
 * signing needs are both cross-field, so both are enforced once at the
 * union level rather than inherited from the per-mode schemas.
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
  })
  // Only an exchange job signs anything: the zero-setup arms hold no
  // `signing` block and no `linkageTerms` at all, so the discriminant
  // selects the arm the rule is about.
  .refine(
    (intent) =>
      intent.mode !== "exchange" || certificateModeNamesThisParty(intent),
    UNNAMED_CERTIFICATE_PARTY_ISSUE,
  );

/**
 * The fixed, server-chosen file names inside a job workdir. The client never
 * supplies a filename: content it submits is written to these names, and the CLI
 * is pointed at them. Keeping them constant is what makes "a client string never
 * becomes a file path" hold.
 */
export const JOB_FILE_NAMES = {
  /** The composed CLI config document. */
  config: "psilink.yaml",
  /** The CLI key file holding the shared secret. */
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
  /** The dual-signed receipt a `certificate`-mode run writes, pinned as the
   * config's `signing.receipt_output` so the console knows its path. The
   * CLI's own default is a timestamped name this server could not serve: it
   * suits a recurring command line but not a single job downloaded once. */
  receipt: "receipt.json",
  /** The CLI's own diagnostic log, written only when the run asked to be a
   * diagnostic one (`--log-file`). A debug-level log can hold partner
   * identity, linkage keys, and data categories, so it stays inside the
   * owner-only workdir and is served only through the job's own log
   * endpoint. */
  log: "run.log",
} as const;
