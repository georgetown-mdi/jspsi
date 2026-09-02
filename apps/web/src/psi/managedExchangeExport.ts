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
 * a scheduler on some machine -- so it takes the same read-then-attest shape, and
 * differs in what lands on disk and in marking NOTHING: what it downloads is not an
 * artifact this app's import accepts, so a backup marker stamped for it would present
 * the record as restorable from files nothing here restores from. It reads the record
 * by id like every other intent, and leaves the backup marker where it stands whether
 * the hand-off is confirmed or dismissed.
 *
 * The two marking intents compose what they will download INSIDE the read-and-mark
 * step rather than after it. That is what keeps the marker bound to bytes that exist:
 * a step that resolved without composing would leave a marker attesting bytes nothing
 * produced, so it fails the export instead.
 *
 * Both spending intents defer their spend to an operator attestation that can arrive
 * arbitrarily later, so each spends through one store step that re-reads the record
 * by id at CONFIRM time and writes the spent state only while no run of it is in
 * flight and the artifact it downloaded still carries the exchange's current secret
 * ({@link ManagedHandoffRefusedError} otherwise, carrying which refusal it was).
 * A run rotates that secret at its handshake, and a run in any context -- this
 * surface, a second tab, the scheduled runtime -- can start and finish between the
 * download and the attestation, which leaves the operator attesting to an artifact
 * whose secret the partnership has moved past. Spending on that attestation would
 * hand the new owner a copy whose first run meets a partner that has moved on. The
 * check is the same read-fresh-by-id the export step takes, for the same reason:
 * what a caller holds in hand is never what decides, and it is bound to the write
 * for the reason the export's mark is bound to its read -- a check the write can
 * outrun decides nothing. A run still in flight is the ordering that check cannot
 * see (it has rotated nothing yet), so the step excludes it on the run's own lock
 * instead of checking it: see {@link ./managedExchangeStore.ts},
 * `spendManagedExchangeIfCurrent`.
 *
 * The seams (the marking intents' fresh read-serialize-and-mark, the command-line
 * export's non-marking read by id, the download, the currency-checked spend) are
 * injected so the intents are testable without a real download or database.
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

/** The platform seams a migration export drives: the backup seams, and the
 * currency-checked spend that transitions the source to its visible spent state. */
export interface ManagedMigrationDeps extends ManagedExportDeps {
  /** Spend the record for `id` as of `spentAt` (the handoff date), but only while no
   * run of it is in flight and the stored record still carries
   * `expectedSharedSecret` -- the run exclusion, the check, and the write are one
   * store step, which writes nothing and names the refusal when either condition
   * fails. Run at confirm time, never at dispatch: the attestation is measured
   * against the record the store holds then, not against the dispatch's own snapshot
   * of it. */
  spendIfCurrent: (
    id: string,
    expectedSharedSecret: string,
    spentAt: string,
  ) => Promise<ManagedSpendOutcome>;
}

/** Why a hand-off confirmation was refused. The three are carried apart because the
 * operator's way out of them differs: `"run-in-flight"` is over when the run is,
 * `"superseded"` leaves a live record here to download again, while `"record-gone"`
 * leaves nothing here at all -- a surface that folded them would tell an operator to
 * wait out a run that never ends, or send them after a download nothing can
 * produce. */
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
 * Raised when a hand-off confirmation is refused, carrying which refusal it was so
 * the surfaces can name the way out that exists.
 *
 * `"run-in-flight"`: a run of this exchange holds the run+rotate lock, so the spend
 * was excluded rather than checked -- the secret it would hand over is one the run
 * may rotate before the operator's files are anyone's to use. Nothing is spent, and
 * the remedy is to confirm again once the run is over (which the currency check then
 * decides, the run having rotated the secret or not).
 *
 * `"superseded"`: the exchange's stored secret is no longer the one the downloaded
 * artifact carries, so the copy the operator is attesting to has been superseded --
 * by a run's rotation in any context, or by a re-invite. Nothing is spent, and the
 * remedy is to download the exchange again.
 *
 * `"record-gone"`: the record is gone from the store, where there is no live copy
 * left to spend and nothing left to download either.
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
 * Spend the source on the operator's attestation, through the one store step that
 * spends only while no run of the record is in flight and `exported` -- the record
 * the dispatch actually serialized -- is still what the store holds, and raise the
 * refusal it reports when it is not. The secret is the identity that decides the
 * currency half: it is what the artifact hands over and what a rotation moves, and
 * an edit that leaves it alone (a label, a max-age policy) leaves the artifact
 * usable.
 *
 * @throws {ManagedHandoffRefusedError} if a run holds the run+rotate lock, the
 *   stored secret has moved on, or the record is gone -- carrying which of the three
 *   it was. Nothing is written in any case.
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
export interface ManagedBackupResult {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The record the export serialized (the fresh store read). */
  record: ManagedExchangeRecord;
}

/**
 * The atomic step under the two marking intents: one clock read, then the store's
 * read-serialize-and-mark by id, then the download of exactly those bytes. Reading by
 * id rather than from a caller-held record is what keeps a stale tab -- or a stale
 * React snapshot holding a pre-rotation secret -- from being what an export
 * serializes, and serializing inside the step is what keeps the marker unable to
 * attest bytes it did not read. A step that resolves without serializing would leave
 * exactly that marker, so it fails the export rather than downloading.
 *
 * Returns the mark instant and the record read, so the marker and the
 * locally-rendered state carry the same clock read (no second `new Date()`) and the
 * caller sees what it exported.
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
 * Dispatch a MIGRATION export ("take over on another device"): read the current
 * record, stamp the backup marker, and download exactly those bytes -- the same
 * atomic read-serialize-and-mark as a backup -- then return a dispatch whose {@link
 * ManagedMigrationDispatch.confirm} spends the source. The spend is deliberately
 * NOT written here: `anchor.click()` gives no landing signal, so the source stays
 * live until the operator attests the file is saved (a cancelled or failed save
 * leaves it recoverable by exporting again). The source is marked backed-up on
 * dispatch: a spent source has a current artifact -- the one just written -- and it
 * reads green until spent. managedExchangeExport.test.ts drives that ordering: the
 * mark lands before a spend is possible, and `confirm` refuses an artifact a
 * rotation superseded.
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

/** The platform seams the command-line export drives: a NON-STAMPING read of the
 * record by id (this export marks no backup marker -- see the module header), a
 * download that carries each composed file's own media type -- the two files land as
 * the YAML and JSON documents the CLI opens, not as one artifact blob -- and a spend
 * that records which hand-off spent the copy, so the durable spent state does not
 * read as a migration's. */
export interface ManagedCronExportDeps {
  /** Read the current stored record for `id`, or `undefined` when none is stored.
   * Read at dispatch and never from a caller-held record, so a stale tab composes the
   * files the store's record carries or none at all. */
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
  /** What the two downloads carried, and the invocation that runs them. */
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
 * Dispatch a COMMAND-LINE export: read the current record by id, compose the CLI's
 * two files from exactly that read, download each under its own name, and return a
 * dispatch whose {@link ManagedCronExportDispatch.confirm} spends the source.
 *
 * Nothing durable is written here, and no backup marker is stamped at any point of
 * this export: the two files are the CLI's, not an artifact this app's import
 * accepts, so marking the record backed up would tell the operator they hold a
 * restorable backup they do not hold. The exchange's backup state is therefore
 * whatever the last artifact export left it -- unchanged by taking these files, by
 * confirming the hand-off, and by dismissing it.
 *
 * The composition is the partial one ({@link composeManagedCronExport} refuses a
 * record this app could not have composed); a refusal throws before any download and
 * leaves the store exactly as it was.
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
 * -- whose surfaces send the operator to an import that has no artifact here, and
 * whose spent copy an artifact revives.
 *
 * @throws {Error} if no record with `id` exists, or if the record is one the
 *   command-line export refuses ({@link composeManagedCronExport}).
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
