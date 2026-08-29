/**
 * The managed-exchange export intents, wired over the pure artifact encoder, the
 * blob download, and the local sibling-state writes. Two of them share one
 * artifact format (see docs/MANAGED_EXCHANGE.md, "Export/import is migration, not
 * sync"):
 *
 * - A BACKUP export leaves the source live. It reads the current record, serializes
 *   the bytes it will download, and stamps the backup marker in one atomic store
 *   step ({@link readRecordAndMarkBackedUp}), then downloads exactly those bytes, so
 *   the marker attests the secret the file carries. Binding the fresh read and the
 *   marker together is what makes a stale-tab or stale-React-state export unable to
 *   mark green over a newer rotation: the marker can only ever attest the bytes just
 *   read, and a rotation clears the marker in its own transaction. Nothing about the
 *   source changes.
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
 * a scheduler on some machine -- so it takes the identical
 * read-compose-and-mark-then-attest shape, and differs only in what lands on disk.
 *
 * Every intent composes what it will download INSIDE the read-and-mark step rather
 * than after it. That is what keeps the marker bound to bytes that exist: the
 * command-line composition is partial -- it refuses a record this app could not have
 * composed -- and a refusal thrown inside the step aborts it, leaving no marker and
 * no other trace, so a refused export really does change nothing.
 *
 * Both spending intents defer their spend to an operator attestation that can arrive
 * arbitrarily later, so each re-reads the record by id at CONFIRM time and spends only
 * if the artifact it downloaded still carries the exchange's current secret
 * ({@link ManagedHandoffSupersededError} otherwise). A run rotates that secret at its
 * handshake, and a run in any context -- this surface, a second tab, the scheduled
 * runtime -- can start and finish between the download and the attestation, which
 * leaves the operator attesting to an artifact whose secret the partnership has moved
 * past. Spending on that attestation would hand the new owner a copy whose first run
 * meets a partner that has moved on. The check is the same read-fresh-by-id the export
 * step takes, for the same reason: what a caller holds in hand is never what decides.
 *
 * The seams (the fresh read-compose-and-mark, the download, the spend write) are
 * injected so the intents are testable without a real download or database.
 */

import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import { composeManagedCronExport } from "./managedCronExport";

import type { ManagedCronExport } from "./managedCronExport";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedSpentHandoff } from "./managedLocalStateShape";

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
  /** Read the current stored record for `id`, run `composeExport` on it, and stamp
   * its backup marker as of `backedUpAt` in one atomic step, returning the record
   * read: the export downloads exactly what `composeExport` produced, so the marker
   * attests the secret the file carries. `composeExport` throwing aborts the whole
   * step, writing no marker. */
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

/** The platform seams a migration export drives: the backup seams, the fresh read
 * the confirm-time currency check measures the attestation against, and the spend
 * write that transitions the source to its visible spent state. */
export interface ManagedMigrationDeps extends ManagedExportDeps {
  /** Read the stored record for `id` as the store holds it now, resolving
   * `undefined` when none exists. Read at confirm time, never at dispatch: the
   * attestation is measured against the current record rather than against the
   * dispatch's own snapshot of it. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Mark the record spent as of `spentAt` (the handoff date). */
  markSpent: (id: string, spentAt: string) => Promise<void>;
}

/**
 * Raised when a hand-off confirmation is refused: the exchange's stored secret is no
 * longer the one the downloaded artifact carries, so the copy the operator is
 * attesting to has been superseded -- by a run's rotation in any context, or by a
 * re-invite. Nothing is spent, and the remedy is to download the exchange again.
 *
 * Also raised when the record is gone from the store, where there is no live copy
 * left to spend.
 */
export class ManagedHandoffSupersededError extends Error {
  constructor(id: string) {
    super(
      `the downloaded hand-off artifact for managed exchange ${id} no longer carries its current secret`,
    );
    this.name = "ManagedHandoffSupersededError";
  }
}

/**
 * Spend the source on the operator's attestation, but only if `exported` -- the
 * record the dispatch actually serialized -- still matches what the store holds. The
 * secret is the identity that decides: it is what the artifact hands over and what a
 * rotation moves, and an edit that leaves it alone (a label, a max-age policy) leaves
 * the artifact usable.
 *
 * @throws {ManagedHandoffSupersededError} if the stored secret has moved on, or the
 *   record is gone. `markSpent` is not called.
 */
async function spendIfArtifactIsCurrent(
  id: string,
  exported: ManagedExchangeRecord,
  spentAt: Date,
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>,
  markSpent: (spentAt: string) => Promise<void>,
): Promise<void> {
  const current = await readRecord(id);
  if (current === undefined || current.sharedSecret !== exported.sharedSecret)
    throw new ManagedHandoffSupersededError(id);
  await markSpent(spentAt.toISOString());
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

/** The atomic step's result, with what the step composed from the record it read. */
interface ManagedComposedExportResult<TComposed> extends ManagedBackupResult {
  /** What `compose` produced from the record, inside the step that marked it. */
  composed: TComposed;
}

/**
 * The atomic step under every export intent: one clock read, then the store's
 * read-compose-and-mark by id. Reading by id rather than from a caller-held record
 * is what keeps a stale tab -- or a stale React snapshot holding a pre-rotation
 * secret -- from being what an export serializes, and binding the marker to that
 * same read is what keeps the marker unable to attest bytes it did not read.
 *
 * `compose` runs on the record inside the step, so an intent whose composition can
 * refuse the record leaves no marker when it does: the refusal aborts the step
 * rather than following a durable write.
 */
async function readComposeAndMark<TComposed>(
  id: string,
  compose: (record: ManagedExchangeRecord) => TComposed,
  deps: Pick<ManagedExportDeps, "readAndMark" | "now">,
): Promise<ManagedComposedExportResult<TComposed>> {
  const backedUpAt = deps.now();
  let composition: [TComposed] | undefined;
  const record = await deps.readAndMark(
    id,
    backedUpAt.toISOString(),
    (read) => {
      composition = [compose(read)];
    },
  );
  if (composition === undefined)
    throw new Error(
      "the read-and-mark step resolved without composing the export, so its " +
        "backup marker would attest bytes nothing produced",
    );
  return { backedUpAt, record, composed: composition[0] };
}

/**
 * Read the current record, serialize the artifact, and stamp the backup marker --
 * one atomic read-compose-and-mark -- then download exactly those bytes. Returns
 * the mark instant and the record read, so the marker and the locally-rendered
 * state carry the same clock read (no second `new Date()`) and the caller sees what
 * it exported.
 */
async function readMarkAndDownload(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  const { backedUpAt, record, composed } = await readComposeAndMark(
    id,
    (read) =>
      serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(read)),
    deps,
  );
  deps.download(managedBackupFileName(backedUpAt), composed);
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
   * with {@link ManagedHandoffSupersededError}, spending nothing, when the record's
   * secret has moved past the artifact this dispatch downloaded. */
  confirm: (spentAt: Date) => Promise<void>;
}

/**
 * Dispatch a MIGRATION export ("take over on another device"): read the current
 * record, stamp the backup marker, and download exactly those bytes -- the same
 * atomic read-compose-and-mark as a backup -- then return a dispatch whose {@link
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
    confirm: (spentAt) =>
      spendIfArtifactIsCurrent(id, record, spentAt, deps.readRecord, (at) =>
        deps.markSpent(id, at),
      ),
  };
}

/** The platform seams the command-line export drives. The migration's seams, with a
 * download that carries each composed file's own media type -- the two files land as
 * the YAML and JSON documents the CLI opens, not as one artifact blob -- and a spend
 * that records which hand-off spent the copy, so the durable spent state does not
 * read as a migration's. */
export interface ManagedCronExportDeps extends Omit<
  ManagedMigrationDeps,
  "download" | "markSpent"
> {
  /** Trigger a client-side download of one composed file. */
  download: (fileName: string, content: string, mimeType: string) => void;
  /** Mark the record spent as of `spentAt`, under the hand-off that spent it. */
  markSpent: (
    id: string,
    spentAt: string,
    handoff: ManagedSpentHandoff,
  ) => Promise<void>;
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
  /** Spend the source as of `spentAt` (the operator's confirmation instant), under
   * the command-line hand-off. Called only after the operator confirms both files
   * are saved. Rejects with {@link ManagedHandoffSupersededError}, spending nothing,
   * when the record's secret has moved past the files this dispatch downloaded. */
  confirm: (spentAt: Date) => Promise<void>;
}

/** The hand-off a confirmed command-line export records on the spent state, so the
 * durable spent surfaces name the CLI files the exchange runs from rather than a
 * migration artifact this export never wrote. */
const CRON_EXPORT_HANDOFF: ManagedSpentHandoff = "command-line";

/**
 * Dispatch a COMMAND-LINE export: read the current record, compose the CLI's two
 * files from exactly that read, and stamp the backup marker -- the same atomic step
 * every export takes -- then download each file under its own name and return a
 * dispatch whose {@link ManagedCronExportDispatch.confirm} spends the source.
 *
 * Composing inside the step is what makes a refusal cost nothing: this composition
 * is the partial one ({@link composeManagedCronExport} refuses a record this app
 * could not have composed), and a refusal aborts the step, so no backup marker is
 * left claiming an export that never produced a byte.
 *
 * The spend is deliberately NOT written here, for the reason
 * {@link dispatchManagedMigration} defers it: `anchor.click()` gives no landing
 * signal, and two clicks give two chances to fail, so the source stays live until
 * the operator attests both files are saved. Handing the secret to a scheduler
 * without spending the source would leave two live owners of one linear secret,
 * which is the fork single-device ownership forbids (docs/MANAGED_EXCHANGE.md,
 * "Single-device ownership").
 *
 * The spend records the command-line hand-off ({@link ManagedSpentHandoff}) rather
 * than a bare instant: this export produces the CLI's two files, which the import
 * flow does not accept, so the durable spent state must not read as a migration's
 * -- whose surfaces send the operator to an import that has no artifact here.
 *
 * @throws {Error} if no record with `id` exists, or if the record is one the
 *   command-line export refuses ({@link composeManagedCronExport}).
 * @throws {ZodError} if the stored record or its sibling entry is invalid.
 */
export async function dispatchManagedCronExport(
  id: string,
  deps: ManagedCronExportDeps,
): Promise<ManagedCronExportDispatch> {
  const { backedUpAt, record, composed } = await readComposeAndMark(
    id,
    composeManagedCronExport,
    deps,
  );
  for (const file of [composed.config, composed.key])
    deps.download(file.fileName, file.text, file.mimeType);
  return {
    backedUpAt,
    record,
    composed,
    confirm: (spentAt) =>
      spendIfArtifactIsCurrent(id, record, spentAt, deps.readRecord, (at) =>
        deps.markSpent(id, at, CRON_EXPORT_HANDOFF),
      ),
  };
}
