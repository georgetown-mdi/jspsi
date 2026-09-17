/**
 * The managed (recurring) exchange record: the browser-persisted state that lets
 * a two-party PPRL exchange run again without re-authoring or re-establishing a
 * shared secret. Pure and IndexedDB-free -- the record's shape, its Zod
 * validation, and the credential-free document composition; the IndexedDB CRUD
 * layer is {@link ./managedExchangeStore.ts}. Normative shape:
 * docs/spec/MANAGED_EXCHANGE_RECORD.md.
 *
 * Holds this party's exchange-file document verbatim (no `authentication`
 * block), the one at-rest secret, and a small set of local-only fields; never
 * input content or a row value. The document is fixed for the partnership --
 * only `label`, `schedule`, and `tokenMaxAgeDays` update in place.
 */

import {
  ExchangeSpecSchema,
  MAX_TOKEN_MAX_AGE_DAYS,
  SHARED_SECRET_REGEX,
  assembleExchangeSpec,
  connectionFromLocator,
  maxCodeUnits,
} from "@psilink/core";

import { z } from "zod";

import { deriveEditedExpiry } from "./managedTokenAgeEdit";

import type {
  ExchangeSpec,
  OutboundPayloadConsent,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { ZodType } from "zod";

/**
 * The single recognized `schemaVersion` literal for the v2 record. A reader
 * rejects any other value rather than migrating it (the reader-rejects-unknown
 * rule the exchange-record and verification-keys files follow), the v1 literal
 * among them: a record stored under it has no
 * {@link ManagedExchangeRecord.standingCondition}, which v2 requires, and its
 * recovery is re-invite rather than a migration. A later shape change is a new
 * literal under a new version, never an existing version holding speculative
 * fields.
 */
export const MANAGED_EXCHANGE_SCHEMA_VERSION = "psilink-managed-exchange/v2";

/**
 * The single recognized `artifactVersion` literal for the v1 export/import
 * artifact (see {@link ./managedExchangeArtifact.ts}). Distinct from
 * {@link MANAGED_EXCHANGE_SCHEMA_VERSION}: the artifact is a separate on-disk
 * format (the embedded document plus the key pair plus the local block), so it
 * versions independently of the stored record. A reader rejects any other value
 * rather than migrating it.
 */
export const MANAGED_EXCHANGE_ARTIFACT_VERSION =
  "psilink-managed-exchange-backup/v1";

/**
 * Upper bound on the operator's {@link ManagedExchangeRecord.label}, in
 * characters (UTF-16 code units), enforced at write. The cap is the field's only
 * structural protection; keeping sensitive counterparty detail out of the label
 * is operator cooperation the app cannot enforce (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `label` row).
 */
export const MAX_LABEL_LENGTH = 120;

/** This party's side of the partnership, dispatching a re-run to the matching
 * rendezvous flow. Local-only: not the document's schema-only
 * `connection.role`. */
export type ManagedExchangeSide = "inviter" | "acceptor";

/**
 * Upper bound on {@link ManagedExchangeSchedule.intervalDays}: an annual cadence,
 * the longest partnership recurrence the design serves. It also bounds how far
 * past any instant a window can fall, which is what lets every surface render an
 * admitted schedule without a fallback (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * the `intervalDays` row and "Every admitted schedule renders").
 */
export const MAX_SCHEDULE_INTERVAL_DAYS = 366;

/**
 * Upper bound on {@link ManagedExchangeSchedule.windowSeconds}, in seconds: half
 * a day. It is below the shortest period {@link MAX_SCHEDULE_INTERVAL_DAYS}'s
 * companion floor of one day admits, so no schedule this schema accepts can
 * place two windows over the same instant (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `windowSeconds` row).
 */
export const MAX_SCHEDULE_WINDOW_SECONDS = 43_200;

/** The recurrence period, run window, and miss bookkeeping the unattended path
 * executes. Every field is a timestamp, an integer duration, or a count -- no
 * free text, so the object cannot accumulate schedule narrative. */
export interface ManagedExchangeSchedule {
  /** ISO 8601 UTC instant of the first agreed window's open, the phase the
   * recurrence counts from. Both parties persist the same value. */
  anchor: string;
  /** Recurrence period in whole days (1 through
   * {@link MAX_SCHEDULE_INTERVAL_DAYS}): the run window opens every
   * `intervalDays` after `anchor`. */
  intervalDays: number;
  /** Run window width in seconds (1 through
   * {@link MAX_SCHEDULE_WINDOW_SECONDS}): window n is open from
   * `anchor + n * intervalDays` for this many seconds. */
  windowSeconds: number;
  /** ISO 8601 UTC open instant of the next window the runner plans to attempt,
   * persisted rather than recomputed so a reader sees the planned attempt. */
  nextWindow: string;
  /** Count of consecutive agreed windows that passed without a completed
   * handshake (at least 0), regardless of which side was absent. */
  consecutiveMisses: number;
}

/** The outcome of a run. Closed enum: a benign `"missed"` window (a no-show on
 * either side) is distinct from a handshake that ran and failed
 * (`"failed"`/`"desynced"`). */
export type ManagedExchangeRunOutcome =
  "succeeded" | "failed" | "desynced" | "missed";

/** For a non-succeeded outcome, the kind of failure. Closed enum: the five benign
 * pre-run problems -- an `"input"` problem (the file missing, unreadable, or gone
 * from under its handle), a `"terms-shortfall"` refusal (the file cannot satisfy
 * every linkage key the standing terms declare), a `"consent"` refusal (this
 * run's outbound disclosure is not the set this exchange recorded agreeing to
 * send), a `"handed-off"` refusal (an export gave this device's copy away, so
 * the run does not rotate a secret whose owner is elsewhere), and a
 * `"custody-unreadable"` refusal (the sibling entry recording whether the copy
 * was handed off did not read, so the run does not rotate on custody it could
 * not establish) -- are detected before any connection and never routed through
 * desync/attack framing. */
export type ManagedExchangeFailureKind =
  | "auth"
  | "transport"
  | "storage"
  | "custody-unreadable"
  | "input"
  | "terms-shortfall"
  | "consent"
  | "handed-off"
  | "cancelled";

/** Run bookkeeping the backup state and the desync UX read. Every field is a
 * timestamp or a closed enum -- no free-text field, so the record structurally
 * cannot hold a match result, a count, or a row value. */
export interface ManagedExchangeLastRun {
  /** ISO 8601 UTC instant of the run. */
  at: string;
  /** The run's outcome. */
  outcome: ManagedExchangeRunOutcome;
  /** For a non-succeeded outcome, the kind of failure; absent on success. */
  failureKind?: ManagedExchangeFailureKind;
}

/** The failure kinds that raise a standing condition: a rotation this device
 * could not save (`"storage"`, which may have left the two parties on different
 * secrets) and a handshake that failed closed (`"auth"`). A strict subset of
 * {@link ManagedExchangeFailureKind}: every other kind is answered by an act on
 * this device, so `lastRun` accounts for it whole. */
export type ManagedStandingConditionKind = "auth" | "storage";

/** Evidence that this device's secret may no longer be the partnership's, raised
 * by a run and unanswered since. It stands BESIDE `lastRun` rather than inside
 * it because `lastRun` holds one run: the next run's stamp replaces it, so a
 * no-show or a later success would otherwise carry the evidence off with the
 * entry that held it. No free text, like every other bookkeeping field -- an
 * instant and a closed enum. Its normative shape, and what clears it, are in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row. */
export interface ManagedStandingCondition {
  /** ISO 8601 UTC instant of the run whose failure raised it. */
  since: string;
  /** The failure kind that raised it. */
  kind: ManagedStandingConditionKind;
}

/** The `standingCondition` of a record holding none. The field is required, so a
 * record states that no condition stands rather than leaving the field out, and
 * a reader never has to tell that state from a record written by something that
 * did not know the field. */
export interface ManagedStandingConditionNone {
  /** The closed enum's unset member; a raised condition takes `"auth"` or
   * `"storage"`, with the instant that raised it. */
  kind: "none";
}

/** What the required `standingCondition` field holds: a raised condition, or the
 * explicit none form. */
export type ManagedStandingConditionField =
  ManagedStandingCondition | ManagedStandingConditionNone;

/** The `standingCondition` value of a record with none standing. */
export const NO_STANDING_CONDITION: ManagedStandingConditionNone = {
  kind: "none",
};

/**
 * A managed exchange record: the minimal state this party's browser retains so a
 * recurring exchange with the same partner over the same terms can run again. It
 * is not a saved copy of the exchange's inputs or outputs. See
 * docs/spec/MANAGED_EXCHANGE_RECORD.md for the field-by-field shape.
 */
export interface ManagedExchangeRecord {
  /** The single recognized v2 literal; a reader rejects an unrecognized value
   * rather than migrating (see {@link MANAGED_EXCHANGE_SCHEMA_VERSION}). */
  schemaVersion: typeof MANAGED_EXCHANGE_SCHEMA_VERSION;
  /** Locally-generated identifier for this managed exchange, distinct from any
   * rendezvous id. Used only to name the record in local UI; never sent. */
  id: string;
  /** Operator-supplied display name, at most {@link MAX_LABEL_LENGTH}
   * characters (enforced at write). Local only; never sent. */
  label: string;
  /**
   * This party's exchange-file document, verbatim: the validated
   * {@link ExchangeSpec} both applications share. Contains no `authentication`
   * block (the secret lives in {@link sharedSecret}) and its connection block is
   * composed from a credential-free locator, so no credential is representable
   * (see {@link composeManagedExchangeFile}).
   */
  exchangeFile: ExchangeSpec;
  /** This party's side of the partnership; dispatches a re-run to the matching
   * rendezvous flow. */
  side: ManagedExchangeSide;
  /**
   * A persisted pointer to the operator's input file, held where the File System
   * Access API exists. A reference, never a copy: no input content or row value
   * persists. Absent on browsers without the API and in any imported record (the
   * handle is a device- and profile-local platform object stored by structured
   * clone, with no file serialization).
   */
  inputFileHandle?: FileSystemFileHandle;
  /**
   * A persisted pointer to the folder the operator granted for a scheduled run's
   * results, held where the File System Access API exists. A run with nobody
   * present writes its results CSV there; an absent, unhonoured, or revoked grant
   * parks the results in the browser instead. Taken at schedule entry and by
   * re-pointing, never at run time (the picker needs a gesture). Absent on
   * browsers without the API and in any imported record, for the same reason
   * {@link inputFileHandle} is.
   */
  outputDirectoryHandle?: FileSystemDirectoryHandle;
  /** The current rotated shared secret (base64url, 43 chars / 32 bytes), matching
   * {@link SHARED_SECRET_REGEX}. The one at-rest secret in the record. */
  sharedSecret: string;
  /** ISO 8601 UTC instant after which {@link sharedSecret} must not be used;
   * absent means no bound is in force. Only {@link tokenMaxAgeDays} writes it. */
  expires?: string;
  /** The operator's max-token-age policy, off by default: absent means no bound.
   * When set, each successful run stamps {@link expires} this many days out. */
  tokenMaxAgeDays?: number;
  /** The partnership-agreed run schedule the unattended path executes; absent for
   * an exchange run attended-only. */
  schedule?: ManagedExchangeSchedule;
  /** Run bookkeeping; absent until the first run records an outcome. */
  lastRun?: ManagedExchangeLastRun;
  /** The unanswered standing condition an `auth` or `storage` failure raised, or
   * {@link NO_STANDING_CONDITION} while none stands. Cleared by the operator's
   * explicit clear-and-acknowledge, by a re-invite, or with the record itself --
   * never by a no-show and never by a successful run alone. */
  standingCondition: ManagedStandingConditionField;
}

/**
 * The canonical `schedule` validator, with the schema's own bounds
 * (`intervalDays` from 1 to {@link MAX_SCHEDULE_INTERVAL_DAYS}, `windowSeconds`
 * from 1 to {@link MAX_SCHEDULE_WINDOW_SECONDS}, `consecutiveMisses` at least 0).
 * Exported so the export/import artifact reuses it rather than re-declaring a
 * laxer copy -- a tampered artifact with `intervalDays: 0` must be rejected
 * exactly as a stored record would be.
 *
 * Within these bounds, the next window off any anchor the schema admits lands on
 * a calendar `Intl` can format, so no display has a fallback for a recurrence
 * whose instants no calendar has (see {@link ../recurring/scheduleSurfacingModel.ts}).
 */
export const scheduleSchema: ZodType<ManagedExchangeSchedule> = z.object({
  anchor: z.iso.datetime(),
  intervalDays: z.int().min(1).max(MAX_SCHEDULE_INTERVAL_DAYS),
  windowSeconds: z.int().min(1).max(MAX_SCHEDULE_WINDOW_SECONDS),
  nextWindow: z.iso.datetime(),
  consecutiveMisses: z.int().min(0),
});

/** The instant a stored ISO datetime denotes, or `NaN` for a string the
 * validators above would not admit as one: unparseable, or having no UTC
 * designator (they take `Z`, never a bare offset). Without the designator,
 * `Date.parse` reads the wall clock against the host zone -- five hours off
 * under America/New_York -- so the same record would name a different instant
 * on every machine that read it. Shared with the schedule arithmetic, which
 * reads these same fields and must land on the same moments (see
 * {@link ./managedSchedule.ts}). */
export function parseStoredInstant(value: string): number {
  return value.endsWith("Z") ? Date.parse(value) : Number.NaN;
}

/** The canonical `lastRun` validator. Exported so the export/import artifact
 * reuses it rather than re-declaring a laxer copy. Every earlier `failureKind`
 * remains a member of the enum, so a record written before a kind was added
 * still reads and tiers exactly as it did. An artifact holding a kind this
 * reader does not know is refused whole rather than read with the kind
 * dropped -- the reader-rejects-unknown rule. */
export const lastRunSchema: ZodType<ManagedExchangeLastRun> = z.object({
  at: z.iso.datetime(),
  outcome: z.enum(["succeeded", "failed", "desynced", "missed"]),
  failureKind: z
    .enum([
      "auth",
      "transport",
      "storage",
      "custody-unreadable",
      "input",
      "terms-shortfall",
      "consent",
      "handed-off",
      "cancelled",
    ])
    .optional(),
});

/** The canonical `standingCondition` validator. Exported so the export/import
 * artifact reuses it rather than re-declaring a laxer copy: the condition travels
 * with the record, since an export that dropped it would clear a state only the
 * operator, a re-invite, or a delete may clear. */
export const standingConditionSchema: ZodType<ManagedStandingCondition> =
  z.object({
    since: z.iso.datetime(),
    kind: z.enum(["auth", "storage"]),
  });

/** The canonical validator for the record's required `standingCondition` field:
 * a raised condition, or the none form. The artifact validates the raised shape
 * alone, its own field being optional and omitted where none stands. */
export const standingConditionFieldSchema: ZodType<ManagedStandingConditionField> =
  z.union([standingConditionSchema, z.object({ kind: z.literal("none") })]);

/** The canonical `tokenMaxAgeDays` validator (a positive integer bounded by
 * {@link MAX_TOKEN_MAX_AGE_DAYS}). Exported so the export/import artifact reuses it
 * rather than re-declaring a laxer copy. */
export const tokenMaxAgeDaysSchema = z
  .int()
  .positive()
  .max(MAX_TOKEN_MAX_AGE_DAYS);

/**
 * The persisted exchange-file document, validated when a record is read back: a
 * full {@link ExchangeSpec} that additionally must hold no `authentication`
 * block. The secret lives in {@link ManagedExchangeRecord.sharedSecret}, never in
 * the document, so a stored record cannot smuggle a secret through the document
 * half. Guards the read path against a hand-edited or corrupted store;
 * composition never produces the block (see {@link composeManagedExchangeFile}).
 */
const persistedExchangeFileSchema = ExchangeSpecSchema.refine(
  (spec) => spec.authentication === undefined,
  { message: "exchangeFile must not carry an authentication block" },
);

/**
 * The `.psilink.key` field pair: the current shared secret and, when a bound is in
 * force, the `expires` instant it lapses at. The export/import artifact's key half
 * and the command-line export's key file are both this shape, so a record's secret
 * half maps onto a valid `.psilink.key` and one read back maps onto a record.
 */
export interface ManagedExchangeKeyFields {
  /** The current rotated shared secret (base64url, 43 chars / 32 bytes). */
  sharedSecret: string;
  /** The instant after which the secret must not be used; absent means no bound. */
  expires?: string;
}

/**
 * The key pair's validator: a `sharedSecret` matching {@link SHARED_SECRET_REGEX}
 * and an optional ISO 8601 `expires`. Shared by every reader of the pair so none
 * validates against a looser copy, keeping the CLI-separability commitment a single
 * source of truth. Strict, so a reader rejects an unknown key on the pair rather
 * than silently accepting it.
 */
export const keyFileFieldsSchema: ZodType<ManagedExchangeKeyFields> = z
  .object({
    sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
    expires: z.iso.datetime().optional(),
  })
  .strict();

/**
 * The record validator. The interface is defined first and the schema derived as
 * a `z.ZodType<ManagedExchangeRecord>`, per the repo's validation convention. The
 * two handles are validated only for their presence, not their structure: a
 * `FileSystemFileHandle` and a `FileSystemDirectoryHandle` are opaque platform
 * objects IndexedDB stores by structured clone, so there is no serializable shape
 * to assert -- the schema treats each as an optional unknown, and the
 * no-input-content invariant is a property of the type (a handle is a pointer),
 * not a runtime check.
 */
const ManagedExchangeRecordSchema: ZodType<ManagedExchangeRecord> = z.object({
  schemaVersion: z.literal(MANAGED_EXCHANGE_SCHEMA_VERSION),
  id: z.string().min(1),
  label: z.string().check(maxCodeUnits(MAX_LABEL_LENGTH)),
  exchangeFile: persistedExchangeFileSchema,
  side: z.enum(["inviter", "acceptor"]),
  inputFileHandle: z.custom<FileSystemFileHandle>().optional(),
  outputDirectoryHandle: z.custom<FileSystemDirectoryHandle>().optional(),
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
  expires: z.iso.datetime().optional(),
  tokenMaxAgeDays: tokenMaxAgeDaysSchema.optional(),
  schedule: scheduleSchema.optional(),
  lastRun: lastRunSchema.optional(),
  standingCondition: standingConditionFieldSchema,
});

/**
 * Parse and validate a value read from the store as a {@link ManagedExchangeRecord}.
 * Throws on an unrecognized `schemaVersion`, an over-long label, a malformed
 * secret, or a document holding an `authentication` block, rather than migrating
 * or silently accepting -- the reader-rejects-unknown rule.
 *
 * @throws {ZodError} if the value is not a valid v2 record.
 */
export function parseManagedExchangeRecord(
  raw: unknown,
): ManagedExchangeRecord {
  return ManagedExchangeRecordSchema.parse(raw);
}

/** Non-throwing {@link parseManagedExchangeRecord}. */
export function safeParseManagedExchangeRecord(raw: unknown) {
  return ManagedExchangeRecordSchema.safeParse(raw);
}

/**
 * A per-entry read of the stored list: the entries that parsed as v2 records, and
 * the stored keys of the entries that did not. The unreadable half is the STORED
 * KEY rather than the entry's own `id`, which a failed parse leaves untrusted --
 * the same reason the diagnostic read's unreadable marker holds the key (see
 * {@link ManagedExchangeDiagnosticEssentials}).
 */
export interface ManagedExchangeReadableRecords {
  /** The entries that parsed, in the order the store yielded them. */
  records: Array<ManagedExchangeRecord>;
  /** The stored keys of the entries that did not parse. */
  unreadableIds: Array<string>;
}

/**
 * Partition a store's parallel key and value arrays into the records that parse
 * and the stored keys of those that do not -- the tolerant counterpart of mapping
 * {@link parseManagedExchangeRecord} over the values, which rejects the whole read
 * on the first entry that fails.
 *
 * Tolerance here is for the UNATTENDED read (see
 * {@link ./managedScheduleRunner.ts}); the attended list read stays strict, so an
 * operator still meets the read-failed recovery surface that identifies and
 * discards the offending entry.
 *
 * Never throws: every parse is per-entry, so an unreadable value becomes a
 * reported key rather than a rejection.
 */
export function partitionReadableManagedExchanges(
  keys: ReadonlyArray<IDBValidKey>,
  values: ReadonlyArray<unknown>,
): ManagedExchangeReadableRecords {
  const records: Array<ManagedExchangeRecord> = [];
  const unreadableIds: Array<string> = [];
  for (let index = 0; index < keys.length; index += 1) {
    try {
      records.push(parseManagedExchangeRecord(values[index]));
    } catch {
      unreadableIds.push(String(keys[index]));
    }
  }
  return { records, unreadableIds };
}

/**
 * The display essentials a diagnostic read reports for one stored entry that
 * parses: only the fields a recovery listing renders -- the label, this party's
 * side, and the last run's instant when recorded. Not the whole record: the
 * diagnostic path must never return the `sharedSecret` or any document field to a
 * component, so this type structurally cannot hold secret material (see
 * docs/MANAGED_EXCHANGE.md, "Deleting a managed exchange", and the read-failed
 * recovery listing). The `id` is the stored key a delete-by-key acts on.
 */
export interface ManagedExchangeDiagnosticEssentials {
  /** The stored key, the delete acts on it (matches the record's `id`). */
  id: string;
  /** The operator's display label; may be empty. */
  label: string;
  /** This party's side of the partnership. */
  side: ManagedExchangeSide;
  /** ISO 8601 UTC instant of the last recorded run, when one exists. */
  lastRunAt?: string;
}

/**
 * Extract only the display essentials from a stored value for the read-failed
 * recovery listing: the `id`, `label`, `side`, and last-run instant, and nothing
 * else. Structurally incapable of returning secret material: it reads named
 * scalar fields off the validated record into a
 * {@link ManagedExchangeDiagnosticEssentials}, so the `sharedSecret`, the
 * document, and the input handle never leave this function. Full record
 * validation runs first, so a value that would fail
 * {@link parseManagedExchangeRecord} throws here exactly as it would on the
 * strict read; the caller catches that to mark the entry unreadable.
 *
 * @throws {ZodError} if the value is not a valid v2 record.
 */
export function diagnoseManagedExchangeRecord(
  raw: unknown,
): ManagedExchangeDiagnosticEssentials {
  const record = parseManagedExchangeRecord(raw);
  return {
    id: record.id,
    label: record.label,
    side: record.side,
    ...(record.lastRun !== undefined ? { lastRunAt: record.lastRun.at } : {}),
  };
}

/** Everything a caller supplies to compose the persisted exchange-file document
 * from a credential-free webrtc locator. The linkage terms and connection locator
 * are the document's substance; the optional blocks mirror
 * {@link mintExchangeFile}'s input. */
export interface ManagedExchangeFileComposition {
  /** The credential-free webrtc rendezvous locator the connection block is
   * composed from. No credential is representable (see
   * {@link WebRTCExchangeLocator}). */
  connection: WebRTCExchangeLocator;
  /** The validated linkage terms both parties agreed. */
  linkageTerms: ExchangeSpec["linkageTerms"];
  /** This party's column metadata, when authored. */
  metadata?: ExchangeSpec["metadata"];
  /** This party's per-party standardization, when authored. */
  standardization?: ExchangeSpec["standardization"];
  /** This party's send-side disclosure commitment. */
  disclosedPayloadColumns?: Array<string>;
  /** This party's receive-side commitment. */
  expectedPayloadColumns?: Array<string>;
  /** The `deduplicate` an accepted invitation declared for the partner's own
   * side -- this party's terms-side commitment. Absent for a party that accepted
   * no invitation, which has no declaration to bind. */
  expectedPartnerDeduplicate?: boolean;
  /** This party's consent to its own outbound payload set. Absent for a party
   * that records none -- every side but the acceptor, whose record the console's
   * deposit builder derives at composition. */
  outboundPayloadConsent?: OutboundPayloadConsent;
  /** Which of this party's own input columns its result file holds beside the
   * partner's values, decided at the mint and held verbatim so a scheduled
   * re-run writes the same file the one-shot run did. Absent where the
   * operator chose nothing, or the terms leave it nothing to act on. */
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
}

/**
 * Compose the persisted exchange-file document from a credential-free webrtc
 * locator, through the same {@link assembleExchangeSpec} the mint path
 * serializes, so one code path holds the assembly rule for both artifacts. The
 * connection is expanded from the locator through {@link connectionFromLocator}
 * (validated through the strict `WebRTCEndpointSchema`, so a credential-bearing
 * field is rejected rather than stripped); the schema's parse result, never the
 * raw input, is what the record persists, so no credential is representable in a
 * stored document and no `authentication` block is ever assembled.
 *
 * @throws {ZodError} if the assembled spec fails validation (an out-of-range port,
 *   a malformed locator, a smuggled unknown key on the locator).
 */
export function composeManagedExchangeFile(
  composition: ManagedExchangeFileComposition,
): ExchangeSpec {
  return assembleExchangeSpec({
    ...composition,
    connection: connectionFromLocator(composition.connection),
  });
}

/** The fields a caller supplies to create a new managed exchange record. The
 * `id` and `schemaVersion` are assigned by {@link buildManagedExchangeRecord};
 * the local policy and bookkeeping fields default to absent (the opt-in
 * policy). */
export interface NewManagedExchange {
  /** The operator's display label (validated to {@link MAX_LABEL_LENGTH}). */
  label: string;
  /** The composed exchange-file document (see
   * {@link composeManagedExchangeFile}). */
  exchangeFile: ExchangeSpec;
  /** This party's side of the partnership. */
  side: ManagedExchangeSide;
  /** The current rotated shared secret. */
  sharedSecret: string;
  /** An input-file handle pointer, when the platform provides one. */
  inputFileHandle?: FileSystemFileHandle;
  /** An output-folder grant, when the operator has already taken one. */
  outputDirectoryHandle?: FileSystemDirectoryHandle;
  /** The max-token-age policy, when the operator opts in. */
  tokenMaxAgeDays?: number;
  /** The `expires` stamp, when a policy is already in force. */
  expires?: string;
  /** The agreed run schedule, when saved as recurring. */
  schedule?: ManagedExchangeSchedule;
  /** Prior run bookkeeping to retain. Set only by an import, which restores
   * the artifact's snapshot of `lastRun` so the first wake after an import reads the
   * same catch-up state the source had; a freshly-created record has no run yet. */
  lastRun?: ManagedExchangeLastRun;
  /** A standing condition to retain. Set only by an import, for the reason
   * `lastRun` is: an import that dropped one would be a way to clear a condition
   * only the operator, a re-invite, or a delete may clear. */
  standingCondition?: ManagedStandingCondition;
}

/**
 * Build a complete {@link ManagedExchangeRecord} from the caller's fields: assign
 * a fresh `id` and the v2 `schemaVersion`, then validate the whole record through
 * the schema so the label cap, the credential-free document, and the secret
 * format are enforced at write. The optional local fields are attached only when
 * present, so an absent policy is an omitted key rather than an explicit
 * `undefined`; `standingCondition` is required, so it is always written, holding
 * {@link NO_STANDING_CONDITION} unless an import supplies one to retain.
 *
 * @throws {ZodError} if the assembled record is invalid (an over-long label, a
 *   malformed secret, a document holding an `authentication` block).
 */
export function buildManagedExchangeRecord(
  fields: NewManagedExchange,
): ManagedExchangeRecord {
  const record = {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    label: fields.label,
    exchangeFile: fields.exchangeFile,
    side: fields.side,
    sharedSecret: fields.sharedSecret,
    ...(fields.inputFileHandle !== undefined
      ? { inputFileHandle: fields.inputFileHandle }
      : {}),
    ...(fields.outputDirectoryHandle !== undefined
      ? { outputDirectoryHandle: fields.outputDirectoryHandle }
      : {}),
    ...(fields.tokenMaxAgeDays !== undefined
      ? { tokenMaxAgeDays: fields.tokenMaxAgeDays }
      : {}),
    ...(fields.expires !== undefined ? { expires: fields.expires } : {}),
    ...(fields.schedule !== undefined ? { schedule: fields.schedule } : {}),
    ...(fields.lastRun !== undefined ? { lastRun: fields.lastRun } : {}),
    standingCondition: fields.standingCondition ?? NO_STANDING_CONDITION,
  };
  return parseManagedExchangeRecord(record);
}

/** The rotation fields a successful run advances on the stored record: the
 * rotated secret always, and the `expires` bound restamped from the max-age
 * policy (a string to set it, `null` to clear any standing bound). The only
 * fields {@link applyManagedExchangeRotation} touches, so a rotation write
 * cannot hold a stale secret or a stale document -- the persist-before-success
 * write is structurally incapable of it (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "Persist-before-success ordering"). */
export interface ManagedExchangeRotation {
  /** The rotated shared secret (base64url) to persist as the current secret. */
  sharedSecret: string;
  /** The restamped bound to set, or `null` to clear any standing bound. */
  expires: string | null;
}

/**
 * Apply a rotation to a record, producing a validated new record with only the
 * rotated secret and the `expires` bound changed -- the document, the label, the
 * schedule, the handle, and the bookkeeping remain untouched. A
 * string `expires` sets the bound; `null` clears it (a policy dropped between runs
 * must not leave a stale bound armed). The result is re-validated through the
 * schema, so a malformed rotated secret is rejected here. The input record is not
 * mutated.
 *
 * @throws {ZodError} if the rotated record is invalid (a malformed secret).
 */
export function applyManagedExchangeRotation(
  record: ManagedExchangeRecord,
  rotation: ManagedExchangeRotation,
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = {
    ...record,
    sharedSecret: rotation.sharedSecret,
  };
  if (rotation.expires === null) delete next.expires;
  else next.expires = rotation.expires;
  return parseManagedExchangeRecord(next);
}

/**
 * Apply a re-invite rotation to a record: advance the rotated secret and the
 * `expires` bound exactly as {@link applyManagedExchangeRotation}, AND drop any
 * `lastRun` bookkeeping. A re-invite is the recovery for the failure `lastRun`
 * recorded; leaving that entry in place would re-derive the consumed failure at
 * the next visit, and once the import marker is cleared in the same rotation, a
 * stale `auth` failure would re-derive as the attack tier. Clearing it in the
 * same field-scoped write makes the post-re-invite record treated as holding no
 * failure to tier (see {@link ./managedFailureTiers.ts}). The document, the
 * label, the schedule, and the handle remain untouched; the input
 * record is not mutated.
 *
 * @throws {ZodError} if the rotated record is invalid (a malformed secret).
 */
export function applyManagedExchangeReinviteRotation(
  record: ManagedExchangeRecord,
  rotation: ManagedExchangeRotation,
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = {
    ...record,
    sharedSecret: rotation.sharedSecret,
  };
  if (rotation.expires === null) delete next.expires;
  else next.expires = rotation.expires;
  delete next.lastRun;
  next.standingCondition = NO_STANDING_CONDITION;
  return parseManagedExchangeRecord(next);
}

/** Apply a `lastRun` bookkeeping entry to a record, producing a validated new
 * record with only `lastRun` changed. The document and the secret remain
 * untouched. Separate from a rotation write so the run outcome is recorded
 * without re-touching the rotated secret. The input record is not mutated.
 *
 * Two write rules drop an entry rather than store it, both comparing parsed
 * instants rather than strings, since the schema admits ISO datetimes of
 * varying fractional precision whose lexicographic order diverges from
 * chronological.
 *
 * Monotonic on `at`: an entry older than the stored one leaves the record
 * unchanged. The run+rotate lock serializes the runs it binds, but a failing
 * run's bookkeeping tail ({@link ./managedRun.ts}) is stamped and written after
 * its lock has released, so an entry stamped behind the stored one could
 * otherwise land after -- and mask -- a newer outcome; this guard makes the
 * stale write a no-op instead.
 *
 * A standing condition the entry raises ({@link standingConditionFrom}) is
 * raised whether or not the entry itself lands: the two rules below choose which
 * of two runs' STAMPS the record keeps, while the condition is not one run's
 * stamp but evidence nobody has answered yet, so the run that met it raises it
 * even where a newer entry keeps the `lastRun` slot.
 *
 * A failure never overwrites a success stamped after its own run began:
 * `runStartedAtMs` is the instant the run producing `lastRun` began, and a
 * non-`"succeeded"` outcome is dropped when the stored entry is a
 * `"succeeded"` one stamped at or after it. The `at` comparison alone does not
 * cover this: a failing run's tail is stamped after its lock has released, so
 * another context can run a whole exchange under the lock and record its
 * success in between, leaving the failure as the newer stamp that would land
 * over it. A success is the unrecoverable entry -- nothing re-derives it once
 * overwritten, and a scheduled window that then folds to a miss counts one that
 * was met -- so a stamp sharing the run's start instant is kept too. */
export function applyManagedExchangeLastRun(
  record: ManagedExchangeRecord,
  lastRun: ManagedExchangeLastRun,
  runStartedAtMs: number,
): ManagedExchangeRecord {
  const raised = withStandingCondition(record, standingConditionFrom(lastRun));
  const stored = record.lastRun;
  if (stored !== undefined && Date.parse(stored.at) > Date.parse(lastRun.at))
    return parseManagedExchangeRecord(raised);
  if (
    lastRun.outcome !== "succeeded" &&
    stored?.outcome === "succeeded" &&
    Date.parse(stored.at) >= runStartedAtMs
  )
    return parseManagedExchangeRecord(raised);
  return parseManagedExchangeRecord({ ...raised, lastRun });
}

/** The standing condition a `lastRun` entry raises, or `undefined` for an entry
 * that raises none. Read off the entry's own `failureKind`, so the stamp a run
 * writes and the condition it raises cannot disagree about what failed. */
export function standingConditionFrom(
  lastRun: ManagedExchangeLastRun,
): ManagedStandingCondition | undefined {
  const kind = lastRun.failureKind;
  if (kind !== "auth" && kind !== "storage") return undefined;
  return { since: lastRun.at, kind };
}

/** The raised condition a record holds, or `undefined` where its
 * `standingCondition` records that none stands. The one place the none form is
 * read, so every surface asks the field the same question. */
export function raisedStandingCondition(
  record: ManagedExchangeRecord,
): ManagedStandingCondition | undefined {
  const condition = record.standingCondition;
  return condition.kind === "none" ? undefined : condition;
}

/** Raise a standing condition on a record, unless one already stands or there is
 * none to raise. First raise wins: the standing condition is the one the operator
 * has yet to answer, and answering it is a single act over everything that stood
 * before it. The input record is not mutated. */
function withStandingCondition(
  record: ManagedExchangeRecord,
  condition: ManagedStandingCondition | undefined,
): ManagedExchangeRecord {
  if (condition === undefined || raisedStandingCondition(record) !== undefined)
    return record;
  return { ...record, standingCondition: condition };
}

/** Apply the operator's clear-and-acknowledge to a record, producing a validated
 * new record whose `standingCondition` is back to {@link NO_STANDING_CONDITION}
 * -- the run bookkeeping, the secret, and the document remain untouched. A record
 * holding none is returned unchanged. The input record is not mutated.
 *
 * @throws {ZodError} if the stored record is invalid. */
export function applyManagedExchangeStandingConditionCleared(
  record: ManagedExchangeRecord,
): ManagedExchangeRecord {
  return parseManagedExchangeRecord({
    ...record,
    standingCondition: NO_STANDING_CONDITION,
  });
}

/** Whether two stored instants denote the same moment, compared as parsed
 * instants for the precision reason {@link applyManagedExchangeLastRun} gives.
 * A string {@link parseStoredInstant} cannot read parses to `NaN`, which never
 * equals itself, so it matches nothing -- holding a conditioned write off a plan
 * it cannot read. */
function sameStoredInstant(left: string, right: string): boolean {
  return parseStoredInstant(left) === parseStoredInstant(right);
}

/** The schedule bookkeeping one closed window produces, written as a unit: the
 * advanced schedule and, when the window earned one, the run entry that goes with
 * it. `nextWindow`, `consecutiveMisses`, and `lastRun` describe a single window's
 * disposition, so a reader must never see a count advanced past a window whose
 * planned attempt has not moved, or the reverse. */
export interface ManagedExchangeScheduleAdvance {
  /** The schedule with `nextWindow` and `consecutiveMisses` advanced. Its
   * `anchor`, `intervalDays`, and `windowSeconds` are the cadence the advance was
   * computed against, and are matched against the stored record rather than
   * written (see {@link applyManagedExchangeScheduleAdvance}). */
  schedule: ManagedExchangeSchedule;
  /** The `nextWindow` the advance was computed FROM, matched against the stored
   * one exactly as the cadence is: the advance is the successor of that one
   * plan, so it lands only while the record still holds it. */
  fromNextWindow: string;
  /** The `consecutiveMisses` the advance was computed FROM, matched the same
   * way: the count is the escalation's own input, and an operator may clear it
   * on the plan the wake is running, so an advance that counted from the old
   * value must not restore it. */
  fromConsecutiveMisses: number;
  /** The window's run bookkeeping. Omitted when the window produced none -- one
   * the single-writer lock was held through, or one a run already recorded its
   * own outcome for. */
  lastRun?: ManagedExchangeLastRun;
  /** The standing condition the window's run raised, carried here so a window
   * whose run could not write its own stamp still leaves the evidence behind
   * (see {@link ./managedScheduleRunner.ts}). Omitted when the window raised
   * none. */
  standingCondition?: ManagedStandingCondition;
}

/** Apply a scheduled window's bookkeeping to a record, producing a validated new
 * record with `schedule` and `lastRun` advanced together and everything else --
 * the document, the secret, the handle -- stays untouched. The input
 * record is not mutated. This is the runner's write; the attended run path
 * records `lastRun` alone and never touches `schedule`.
 *
 * Conditioned on the whole stored plan, which the operator may edit and another
 * wake may advance at any time: the write lands only while the record still
 * holds the cadence the advance was computed against (`anchor`, `intervalDays`,
 * `windowSeconds`) AND still plans the `nextWindow` and holds the
 * `consecutiveMisses` it was computed from. Any other stored schedule leaves the
 * record entirely unchanged; a wake against the stored plan recomputes both.
 *
 * The stored instants are compared as parsed moments rather than strings, for
 * the varying-ISO-precision reason {@link applyManagedExchangeLastRun} states.
 *
 * `lastRun` alone stays monotonic on `at`, the first of the rules
 * {@link applyManagedExchangeLastRun} holds: the schedule advance still applies
 * -- the window did close, whatever landed afterwards -- while a bookkeeping
 * entry staler than the stored one is dropped rather than masking a newer
 * outcome. The entry an advance carries is the catch-up walk's, stamped at an
 * already-closed window rather than by a run in flight, so the monotonic rule
 * is what holds a newer success off it and there is no run start to state.
 * Both stamps are read through {@link parseStoredInstant} rather than
 * `Date.parse`, so a stamp having no UTC designator compares as no run at all,
 * letting the window's own bookkeeping land over it.
 *
 * A standing condition the advance carries is raised under the same plan
 * condition as the rest -- it is this write's second chance at evidence the
 * window's own run may not have persisted, not a guarantee. */
export function applyManagedExchangeScheduleAdvance(
  record: ManagedExchangeRecord,
  advance: ManagedExchangeScheduleAdvance,
): ManagedExchangeRecord {
  const stored = record.schedule;
  if (
    stored === undefined ||
    !sameStoredInstant(stored.anchor, advance.schedule.anchor) ||
    stored.intervalDays !== advance.schedule.intervalDays ||
    stored.windowSeconds !== advance.schedule.windowSeconds ||
    !sameStoredInstant(stored.nextWindow, advance.fromNextWindow) ||
    stored.consecutiveMisses !== advance.fromConsecutiveMisses
  )
    return parseManagedExchangeRecord(record);
  const next: ManagedExchangeRecord = {
    ...withStandingCondition(record, advance.standingCondition),
    schedule: advance.schedule,
  };
  if (
    advance.lastRun !== undefined &&
    !(
      record.lastRun !== undefined &&
      parseStoredInstant(record.lastRun.at) >
        parseStoredInstant(advance.lastRun.at)
    )
  )
    next.lastRun = advance.lastRun;
  return parseManagedExchangeRecord(next);
}

/**
 * Apply an input-file handle to a record, producing a validated new record with
 * only `inputFileHandle` changed -- the document, the secret, and the bookkeeping
 * remain untouched. A `FileSystemFileHandle` sets (or re-points) the
 * handle; `null` drops it. This is the field-scoped write the save flow uses to
 * persist a handle and the surfaces use to re-point one after a missing-file
 * failure; separate from a rotation or a local edit so persisting a handle cannot
 * hold a stale secret or a stale document back over a concurrent write. The input
 * record is not mutated.
 *
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangeInputHandle(
  record: ManagedExchangeRecord,
  handle: FileSystemFileHandle | null,
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  if (handle === null) delete next.inputFileHandle;
  else next.inputFileHandle = handle;
  return parseManagedExchangeRecord(next);
}

/**
 * Apply an output-folder grant to a record, producing a validated new record with
 * only `outputDirectoryHandle` changed. A `FileSystemDirectoryHandle` sets (or
 * re-points) the grant; `null` drops it, which returns this exchange's scheduled
 * runs to keeping their results in the browser. The field-scoped counterpart of
 * {@link applyManagedExchangeInputHandle}, and field-scoped for the same reason:
 * taking a folder grant must not hold a stale secret or a stale document back
 * over a concurrent write. The input record is not mutated.
 *
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangeOutputDirectory(
  record: ManagedExchangeRecord,
  handle: FileSystemDirectoryHandle | null,
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  if (handle === null) delete next.outputDirectoryHandle;
  else next.outputDirectoryHandle = handle;
  return parseManagedExchangeRecord(next);
}

/** The local fields an operator may edit in place without a re-invite: the
 * display label, the run schedule, and the max-token-age policy. The agreed
 * terms are fixed for the partnership -- a re-invite only refreshes the secret,
 * and a terms change is a new exchange, not a re-invite -- so the document and
 * the secret are not editable here. */
export interface ManagedExchangeLocalEdits {
  /** A new display label (validated to {@link MAX_LABEL_LENGTH}). */
  label?: string;
  /** A new run schedule, or `null` to drop it (revert to attended-only). */
  schedule?: ManagedExchangeSchedule | null;
  /** A new max-token-age policy, or `null` to drop it. */
  tokenMaxAgeDays?: number | null;
}

/**
 * Apply local edits to a record, producing a validated new record. Only the
 * label, schedule, and max-token-age policy update in place; a `null` drops the
 * corresponding optional field. The result is re-validated through the schema, so
 * an over-long label is rejected here exactly as at create. The input record is
 * not mutated.
 *
 * An edit to `tokenMaxAgeDays` re-derives `expires` conservatively through
 * {@link deriveEditedExpiry}: a shorter policy recomputes the bound from the
 * reconstructed advance anchor, a longer one keeps the current bound (it takes
 * effect only at the next rotation), an added policy stamps `now + days`, and a
 * cleared policy drops the bound. The rule never moves `expires` later, so an edit
 * cannot stretch a stored credential's life without a rotation (see
 * {@link ./managedTokenAgeEdit.ts}). `now` is the anchor for an added policy;
 * default `Date.now()` for callers that do not inject a clock. An edit that does
 * not touch `tokenMaxAgeDays` leaves `expires` untouched.
 *
 * @throws {ZodError} if the edited record is invalid.
 */
export function applyManagedExchangeLocalEdits(
  record: ManagedExchangeRecord,
  edits: ManagedExchangeLocalEdits,
  now: number = Date.now(),
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  if (edits.label !== undefined) next.label = edits.label;
  if (edits.schedule !== undefined) {
    if (edits.schedule === null) delete next.schedule;
    else next.schedule = edits.schedule;
  }
  if (edits.tokenMaxAgeDays !== undefined) {
    if (edits.tokenMaxAgeDays === null) delete next.tokenMaxAgeDays;
    else next.tokenMaxAgeDays = edits.tokenMaxAgeDays;
    const expires = deriveEditedExpiry(record, edits.tokenMaxAgeDays, now);
    if (expires === null) delete next.expires;
    else next.expires = expires;
  }
  return parseManagedExchangeRecord(next);
}
