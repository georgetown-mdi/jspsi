/**
 * The managed-exchange export intents, wired over the pure artifact encoder, the
 * blob download, and the local sibling-state writes. Two of them share one
 * artifact format (see docs/MANAGED_EXCHANGE.md, "Export/import is migration, not
 * sync"):
 *
 * - A BACKUP export leaves the source live. It reads the current record and stamps
 *   the backup marker in one atomic store step ({@link readRecordAndMarkBackedUp}),
 *   then downloads exactly the bytes that read serialized, so the marker attests the
 *   secret the file carries. Binding the fresh read and the marker together is what
 *   makes a stale-tab or stale-React-state export unable to mark green over a newer
 *   rotation: the marker can only ever attest the bytes just read, and a rotation
 *   clears the marker in its own transaction. Nothing about the source changes.
 * - A MIGRATION export ("take over on another device") spends the source, but the
 *   spend is OPERATOR-ATTESTED. `anchor.click()` gives no landing signal, so a
 *   cancelled or failed save dialog must not spend the source. The dispatch downloads
 *   the artifact (again bound to a fresh read and marker) and returns a confirm
 *   handle; only when the operator confirms "the file is saved" does
 *   {@link confirmManagedMigration} write `spentAt`, transitioning this device's copy
 *   to its visible spent state. A dismissed dialog leaves the source live and
 *   recoverable.
 *
 * The third intent exports the exchange to the COMMAND LINE instead of to another
 * browser: it downloads the CLI's own two files ({@link composeManagedCronExport})
 * rather than the artifact, and spends the source on the same operator attestation
 * the migration uses. It is a migration by another route -- the secret is handed to
 * a scheduler on some machine -- so it takes the identical read-and-mark-then-attest
 * shape, and differs only in what lands on disk.
 *
 * The seams (the fresh read-and-mark, the download, the spend write) are injected so
 * the intents are testable without a real download or database.
 */

import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import { composeManagedCronExport } from "./managedCronExport";

import type { ManagedCronExport } from "./managedCronExport";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The download filename `psilink-managed-backup-<date>.json`, the date the local
 * calendar day of `at`, mirroring the exchange-file filename discipline so repeated
 * exports carry distinct dates. */
export function managedBackupFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-managed-backup-${year}-${month}-${day}.json`;
}

/** The platform seams a backup export drives, injected so the intent stays pure and
 * testable. */
export interface ManagedExportDeps {
  /** Read the current stored record for `id` and stamp its backup marker as of
   * `backedUpAt` in one atomic step, returning the record read: the export
   * serializes exactly the returned bytes, so the marker attests the secret the
   * file carries. */
  readAndMark: (
    id: string,
    backedUpAt: string,
  ) => Promise<ManagedExchangeRecord>;
  /** Trigger a client-side download of the serialized artifact under `fileName`. */
  download: (fileName: string, content: string) => void;
  /** The moment of the export; injected so the marker and filename dates are the
   * caller's clock. */
  now: () => Date;
}

/** The platform seams a migration export drives: the backup seams plus the spend
 * write that transitions the source to its visible spent state. */
export interface ManagedMigrationDeps extends ManagedExportDeps {
  /** Mark the record spent as of `spentAt` (the handoff date). */
  markSpent: (id: string, spentAt: string) => Promise<void>;
}

/** The atomic export step's result: the fresh read-and-mark instant (threaded so the
 * host renders and any follow-on write use the one clock read) and the record read,
 * so the caller need not re-read to know what was exported. */
export interface ManagedBackupResult {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The record the export serialized (the fresh store read). */
  record: ManagedExchangeRecord;
}

/**
 * The atomic step under every export intent: one clock read, then the store's
 * read-and-mark by id. Reading by id rather than from a caller-held record is what
 * keeps a stale tab -- or a stale React snapshot holding a pre-rotation secret --
 * from being what an export serializes, and binding the marker to that same read is
 * what keeps the marker unable to attest bytes it did not read.
 */
async function readAndMarkForExport(
  id: string,
  deps: Pick<ManagedExportDeps, "readAndMark" | "now">,
): Promise<ManagedBackupResult> {
  const backedUpAt = deps.now();
  const record = await deps.readAndMark(id, backedUpAt.toISOString());
  return { backedUpAt, record };
}

/**
 * Read the current record, stamp the backup marker, and download the artifact --
 * one atomic read-and-mark, then the download of exactly those bytes. Returns the
 * mark instant and the record read, so the marker and the locally-rendered state
 * carry the same clock read (no second `new Date()`) and the caller sees what it
 * exported.
 */
async function readMarkAndDownload(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  const { backedUpAt, record } = await readAndMarkForExport(id, deps);
  deps.download(
    managedBackupFileName(backedUpAt),
    serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(record)),
  );
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
   * the operator confirms the file is saved; not called on a cancelled save. */
  confirm: (spentAt: Date) => Promise<void>;
}

/**
 * Dispatch a MIGRATION export ("take over on another device"): read the current
 * record, stamp the backup marker, and download exactly those bytes -- the same
 * atomic read-and-mark as a backup -- then return a dispatch whose {@link
 * ManagedMigrationDispatch.confirm} spends the source. The spend is deliberately
 * NOT written here: `anchor.click()` gives no landing signal, so the source stays
 * live until the operator attests the file is saved (a cancelled or failed save
 * leaves it recoverable by exporting again). The source is marked backed-up on
 * dispatch: a spent source has a current artifact by construction (the artifact just
 * written), and it reads green until spent.
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
    confirm: (spentAt) => deps.markSpent(id, spentAt.toISOString()),
  };
}

/** The platform seams the command-line export drives. The migration's seams, with a
 * download that carries each composed file's own media type: the two files land as
 * the YAML and JSON documents the CLI opens, not as one artifact blob. */
export interface ManagedCronExportDeps extends Omit<
  ManagedMigrationDeps,
  "download"
> {
  /** Trigger a client-side download of one composed file. */
  download: (fileName: string, content: string, mimeType: string) => void;
}

/** A dispatched command-line export awaiting the operator's "the files are saved"
 * confirmation. Both files are already downloaded and the source marked backed-up;
 * the source is spent only when {@link confirm} is called, so a dismissed or failed
 * save leaves it live. */
export interface ManagedCronExportDispatch {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The record the export composed from (the fresh store read). */
  record: ManagedExchangeRecord;
  /** What the two downloads carried, and the invocation that runs them. */
  composed: ManagedCronExport;
  /** Spend the source as of `spentAt` (the operator's confirmation instant).
   * Called only after the operator confirms both files are saved. */
  confirm: (spentAt: Date) => Promise<void>;
}

/**
 * Dispatch a COMMAND-LINE export: read the current record and stamp the backup
 * marker in the same atomic step every export takes, compose the CLI's two files
 * from exactly that read, download each under its own name, and return a dispatch
 * whose {@link ManagedCronExportDispatch.confirm} spends the source.
 *
 * The spend is deliberately NOT written here, for the reason
 * {@link dispatchManagedMigration} defers it: `anchor.click()` gives no landing
 * signal, and two clicks give two chances to fail, so the source stays live until
 * the operator attests both files are saved. Handing the secret to a scheduler
 * without spending the source would leave two live owners of one linear secret,
 * which is the fork single-device ownership forbids (docs/MANAGED_EXCHANGE.md,
 * "Single-device ownership").
 *
 * @throws {Error} if no record with `id` exists, or if the record is one the
 *   command-line export refuses ({@link composeManagedCronExport}).
 * @throws {ZodError} if the stored record or its sibling entry is invalid.
 */
export async function dispatchManagedCronExport(
  id: string,
  deps: ManagedCronExportDeps,
): Promise<ManagedCronExportDispatch> {
  const { backedUpAt, record } = await readAndMarkForExport(id, deps);
  const composed = composeManagedCronExport(record);
  for (const file of [composed.config, composed.key])
    deps.download(file.fileName, file.text, file.mimeType);
  return {
    backedUpAt,
    record,
    composed,
    confirm: (spentAt) => deps.markSpent(id, spentAt.toISOString()),
  };
}
