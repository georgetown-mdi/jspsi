/**
 * The managed-exchange export intents, wired over the pure artifact encoder,
 * the blob download, and the local sibling-state writes. Backup and
 * migration share one artifact format (docs/MANAGED_EXCHANGE.md,
 * "Export/import is migration, not sync").
 *
 * - A BACKUP export reads the current record, serializes it, and stamps the
 *   backup marker in one atomic store step, then downloads exactly those
 *   bytes. The source is left live.
 * - A MIGRATION export ("take over on another device") downloads the
 *   artifact the same way, then spends the source only on the operator's
 *   attestation that the file is saved: `anchor.click()` gives no landing
 *   signal, so a cancelled or failed save must not spend the source. A
 *   dismissed dialog leaves the source live.
 * - A COMMAND-LINE export downloads the CLI's own two files
 *   ({@link composeManagedCronExport}) instead of the artifact, and spends
 *   the source on the same attestation the migration uses. It stamps no
 *   backup marker: what it downloads is not an artifact this app's import
 *   accepts.
 *
 * The two marking intents compose what they download INSIDE the
 * read-and-mark step: the marker can never attest bytes nothing produced.
 *
 * Both spending intents' confirm step re-reads the record by id, and spends
 * only while no run of it is in flight and the downloaded artifact still
 * has the record's current secret
 * ({@link ManagedHandoffRefusedError} otherwise). A run in flight is
 * excluded on the run's own lock rather than checked directly (see
 * {@link ./managedExchangeStore.ts}, `spendManagedExchangeIfCurrent`).
 *
 * The boundaries (read-and-mark, the non-marking read by id, the download, the
 * currency-checked spend) are injected so the intents are testable without
 * a real download or database.
 */

import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import { composeManagedCronExport } from "./managedCronExport";

import type {
  ManagedSpendOutcome,
  ManagedSpentHandoff,
} from "./managedLocalStateShape";
import type { ManagedCronExport } from "./managedCronExport";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The download filename `psilink-managed-backup-<date>.json`, the date the local
 * calendar day of `at`, mirroring the exchange-file filename discipline so repeated
 * exports have distinct dates. */
export function managedBackupFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-managed-backup-${year}-${month}-${day}.json`;
}

/** The platform boundaries a backup export drives, injected so the intent stays
 * pure and testable. */
export interface ManagedExportDeps {
  /** Read the current stored record for `id`, run `composeExport` on it, and stamp
   * its backup marker as of `backedUpAt` in one atomic step, returning the record
   * read. `composeExport` throwing aborts the whole step, writing no marker. */
  readAndMark: (
    id: string,
    backedUpAt: string,
    composeExport: (record: ManagedExchangeRecord) => void,
  ) => Promise<ManagedExchangeRecord>;
  /** Trigger a client-side download of the serialized artifact under `fileName`. */
  download: (fileName: string, content: string) => void;
  /** The moment of the export; injected so the marker and filename dates are the
   * caller's clock. */
  now: () => Date;
}

/** The platform boundaries a migration export drives: the backup boundaries, and
 * the currency-checked spend that transitions the source to its visible spent
 * state. */
export interface ManagedMigrationDeps extends ManagedExportDeps {
  /** Spend the record for `id` as of `spentAt` (the handoff date), but only while no
   * run of it is in flight and the stored record still has
   * `expectedSharedSecret` -- the exclusion, the check, and the write are one
   * store step, writing nothing and naming the refusal when either fails. Run at
   * confirm time, never at dispatch, against the record the store holds then. */
  spendIfCurrent: (
    id: string,
    expectedSharedSecret: string,
    spentAt: string,
  ) => Promise<ManagedSpendOutcome>;
}

/** Why a hand-off confirmation was refused. The operator's remedy differs per
 * value: `"run-in-flight"` is over when the run is, `"superseded"` leaves a
 * live record to download again, and `"record-gone"` leaves nothing here at
 * all. */
export type ManagedHandoffRefusal =
  "run-in-flight" | "superseded" | "record-gone";

/** The refusal each non-spending outcome of the store's checked spend is reported
 * as. Exhaustive over the outcomes that write nothing, so an outcome added to the
 * store without a refusal to phrase it fails to compile rather than reaching a
 * surface as the superseded one. */
const HANDOFF_REFUSAL_FOR_OUTCOME: Record<
  Exclude<ManagedSpendOutcome, "spent">,
  ManagedHandoffRefusal
> = {
  "run-in-flight": "run-in-flight",
  superseded: "superseded",
  gone: "record-gone",
};

/**
 * Raised when a hand-off confirmation is refused, stating which refusal it
 * was: `"run-in-flight"` excludes the spend on the run+rotate lock rather
 * than checking it and clears once the run ends; `"superseded"` means the
 * stored secret no longer matches the downloaded artifact; `"record-gone"`
 * means the record is gone from the store.
 */
export class ManagedHandoffRefusedError extends Error {
  /** Which refusal this is, for the surface to phrase. */
  readonly refusal: ManagedHandoffRefusal;
  constructor(id: string, refusal: ManagedHandoffRefusal) {
    super(handoffRefusalMessage(id, refusal));
    this.name = "ManagedHandoffRefusedError";
    this.refusal = refusal;
  }
}

/** The refusal's own message, exhaustive over the refusals so a new one cannot
 * inherit another's sentence. */
function handoffRefusalMessage(
  id: string,
  refusal: ManagedHandoffRefusal,
): string {
  switch (refusal) {
    case "run-in-flight":
      return `a run of managed exchange ${id} is in flight, so its copy was not handed off`;
    case "record-gone":
      return `managed exchange ${id} is no longer stored, so there is no copy left to hand off`;
    case "superseded":
      return `the downloaded hand-off artifact for managed exchange ${id} no longer carries its current secret`;
  }
}

/**
 * Spend the source on the operator's attestation, through the one store step
 * that spends only while no run of the record is in flight and `exported`
 * is still what the store holds, raising the refusal it reports otherwise.
 * The secret is what decides currency: an edit that leaves it alone (a
 * label, a max-age policy) leaves the artifact usable.
 *
 * @throws {ManagedHandoffRefusedError} if a run holds the run+rotate lock,
 *   the stored secret has moved on, or the record is gone. Nothing is
 *   written in any case.
 */
async function spendIfArtifactIsCurrent(
  id: string,
  exported: ManagedExchangeRecord,
  spentAt: Date,
  spend: (
    expectedSharedSecret: string,
    spentAt: string,
  ) => Promise<ManagedSpendOutcome>,
): Promise<void> {
  const outcome = await spend(exported.sharedSecret, spentAt.toISOString());
  if (outcome === "spent") return;
  throw new ManagedHandoffRefusedError(
    id,
    HANDOFF_REFUSAL_FOR_OUTCOME[outcome],
  );
}

/** The atomic export step's result: the fresh read-and-mark instant (threaded so the
 * host renders and any follow-on write use the one clock read) and the record read,
 * so the caller need not re-read to know what was exported. */
interface ManagedBackupResult {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The record the export serialized (the fresh store read). */
  record: ManagedExchangeRecord;
}

/**
 * The atomic step under the two marking intents: one clock read, then the
 * store's read-serialize-and-mark by id, then the download of exactly those
 * bytes. Reading by id (not a caller-held record) keeps a stale tab or
 * pre-rotation snapshot from being what an export serializes. A step that
 * resolves without serializing fails the export rather than downloading, so
 * the marker never attests bytes it did not read.
 *
 * Returns the mark instant and the record read, so the caller sees what it
 * exported without a second clock read.
 */
async function readMarkAndDownload(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  const backedUpAt = deps.now();
  let serialized: string | undefined;
  const record = await deps.readAndMark(
    id,
    backedUpAt.toISOString(),
    (read) => {
      serialized = serializeManagedExchangeArtifact(
        encodeManagedExchangeArtifact(read),
      );
    },
  );
  if (serialized === undefined)
    throw new Error(
      "the read-and-mark step resolved without serializing the export, so its " +
        "backup marker would attest bytes nothing produced",
    );
  deps.download(managedBackupFileName(backedUpAt), serialized);
  return { backedUpAt, record };
}

/**
 * Export a record as a BACKUP: read the current record, stamp the backup marker, and
 * download exactly those bytes, leaving the source live. Returns the mark instant and
 * the record exported so the host renders the same instant it persisted.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or its sibling entry is invalid.
 */
export async function exportManagedBackup(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  return readMarkAndDownload(id, deps);
}

/** A dispatched migration awaiting the operator's "the file is saved" confirmation.
 * The artifact is already downloaded and the source marked backed-up; the source is
 * spent only when {@link confirm} is called, so a dismissed save dialog leaves it
 * live. */
export interface ManagedMigrationDispatch {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The record the export serialized (the fresh store read). */
  record: ManagedExchangeRecord;
  /** Spend the source as of `spentAt` (the operator's confirmation instant),
   * transitioning this device's copy to its visible spent state. Called only after
   * the operator confirms the file is saved; not called on a cancelled save. Rejects
   * with {@link ManagedHandoffRefusedError}, spending nothing, when a run of the
   * record is in flight, when its secret has moved past the artifact this dispatch
   * downloaded, or when the record is no longer stored. */
  confirm: (spentAt: Date) => Promise<void>;
}

/**
 * Dispatch a MIGRATION export ("take over on another device"): read the
 * current record, stamp the backup marker, download exactly those bytes,
 * and return a dispatch whose {@link ManagedMigrationDispatch.confirm}
 * spends the source. The spend is not written here: `anchor.click()` gives
 * no landing signal, so the source stays live and recoverable until the
 * operator attests the file is saved. Pinned in managedExchangeExport.test.ts.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or its sibling entry is invalid.
 */
export async function dispatchManagedMigration(
  id: string,
  deps: ManagedMigrationDeps,
): Promise<ManagedMigrationDispatch> {
  const { backedUpAt, record } = await readMarkAndDownload(id, deps);
  return {
    backedUpAt,
    record,
    confirm: (spentAt) =>
      spendIfArtifactIsCurrent(id, record, spentAt, (secret, at) =>
        deps.spendIfCurrent(id, secret, at),
      ),
  };
}

/** The platform boundaries the command-line export drives: a NON-STAMPING read of
 * the record by id (this export marks no backup marker -- see the module header),
 * a download that takes each composed file's own media type -- the two files land
 * as the YAML and JSON documents the CLI opens, not as one artifact blob -- and a
 * spend that records which hand-off spent the copy, so the durable spent state
 * does not read as a migration's. */
export interface ManagedCronExportDeps {
  /** Read the current stored record for `id`, or `undefined` when none is stored.
   * Read at dispatch and never from a caller-held record, so a stale tab composes the
   * files the store's record has or none at all. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Trigger a client-side download of one composed file. */
  download: (fileName: string, content: string, mimeType: string) => void;
  /** The migration's currency-checked spend, recording the hand-off that spent the
   * copy. */
  spendIfCurrent: (
    id: string,
    expectedSharedSecret: string,
    spentAt: string,
    handoff: ManagedSpentHandoff,
  ) => Promise<ManagedSpendOutcome>;
}

/** A dispatched command-line export awaiting the operator's "the files are saved"
 * confirmation. Both files are already downloaded; the source is spent only when
 * {@link confirm} is called, so a dismissed or failed save leaves it live -- and its
 * backup marker untouched either way. */
export interface ManagedCronExportDispatch {
  /** The record the export composed from (the fresh store read). */
  record: ManagedExchangeRecord;
  /** What the two downloads held, and the invocation that runs them. */
  composed: ManagedCronExport;
  /** Spend the source as of `spentAt` (the operator's confirmation instant), under
   * the command-line hand-off. Called only after the operator confirms both files
   * are saved. Rejects with {@link ManagedHandoffRefusedError}, spending nothing,
   * when a run of the record is in flight, when its secret has moved past the files
   * this dispatch downloaded, or when the record is no longer stored. */
  confirm: (spentAt: Date) => Promise<void>;
}

/** The hand-off a confirmed command-line export records on the spent state, so the
 * durable spent surfaces name the CLI files the exchange runs from rather than a
 * migration artifact this export never wrote. */
const CRON_EXPORT_HANDOFF: ManagedSpentHandoff = "command-line";

/**
 * Dispatch a COMMAND-LINE export: read the current record by id, compose
 * the CLI's two files from exactly that read, download each under its own
 * name, and return a dispatch whose
 * {@link ManagedCronExportDispatch.confirm} spends the source.
 *
 * No backup marker is stamped: the two files are not an artifact this app's
 * import accepts, so the exchange's backup state is left exactly as the
 * last artifact export set it, whatever happens to this dispatch.
 *
 * The composition is partial ({@link composeManagedCronExport} refuses a
 * record this app could not have composed); a refusal throws before any
 * download and leaves the store untouched.
 *
 * The spend is not written here, for the reason
 * {@link dispatchManagedMigration} defers it (single-device ownership;
 * docs/MANAGED_EXCHANGE.md, "Single-device ownership"), and records the
 * command-line hand-off ({@link ManagedSpentHandoff}) rather than a bare
 * instant, so the durable spent state does not read as a migration's.
 *
 * @throws {Error} if no record with `id` exists, or if the record is one
 *   the command-line export refuses ({@link composeManagedCronExport}).
 * @throws {ZodError} if the stored record is invalid.
 */
export async function dispatchManagedCronExport(
  id: string,
  deps: ManagedCronExportDeps,
): Promise<ManagedCronExportDispatch> {
  const record = await deps.readRecord(id);
  if (record === undefined)
    throw new Error(`no managed exchange with id ${id}`);
  const composed = composeManagedCronExport(record);
  for (const file of [composed.config, composed.key])
    deps.download(file.fileName, file.text, file.mimeType);
  return {
    record,
    composed,
    confirm: (spentAt) =>
      spendIfArtifactIsCurrent(id, record, spentAt, (secret, at) =>
        deps.spendIfCurrent(id, secret, at, CRON_EXPORT_HANDOFF),
      ),
  };
}
