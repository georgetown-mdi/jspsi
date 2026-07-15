/**
 * The two managed-exchange export intents, wired over the pure artifact encoder,
 * the blob download, and the local sibling-state writes. One format, two intents
 * (see docs/MANAGED_EXCHANGE.md, "Export/import is migration, not sync"):
 *
 * - A BACKUP export leaves the source live. It downloads the artifact and records a
 *   backup marker as of the download instant, flipping the derived backup state to
 *   green. Nothing about the source changes.
 * - A MIGRATION export ("take over on another device") spends the source. It
 *   downloads the same artifact, then transitions this device's copy to a visible
 *   spent state (recorded with the handoff date) -- no Run affordance, no scheduled
 *   runs -- so the operator-cooperation invalidation is legible at the one moment it
 *   is violable. The source is marked backed-up too: a spent source has a current
 *   artifact by construction (it is the artifact just written).
 *
 * The download and the marker/spent writes are injected so the intents are testable
 * without a real download or database. The spend write follows the download, so a
 * failed download does not spend the source; the marker write is best-effort after a
 * successful download (a marker failure must not claim the download failed).
 */

import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "./managedExchangeArtifact";

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
  /** Trigger a client-side download of the serialized artifact under `fileName`. */
  download: (fileName: string, content: string) => void;
  /** Record a backup marker for the record as of `backedUpAt`. */
  markBackedUp: (id: string, backedUpAt: string) => Promise<void>;
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

/** Encode, serialize, and download the artifact for a record, returning the export
 * instant so the marker writes stamp the same moment. */
function downloadArtifact(
  record: ManagedExchangeRecord,
  deps: ManagedExportDeps,
): Date {
  const artifact = encodeManagedExchangeArtifact(record);
  const at = deps.now();
  deps.download(
    managedBackupFileName(at),
    serializeManagedExchangeArtifact(artifact),
  );
  return at;
}

/**
 * Export a record as a BACKUP: download the artifact and record the backup marker,
 * leaving the source live. Rejects if the marker write fails after the download; the
 * host surfaces that without claiming the source is unbacked (the file is already on
 * disk).
 */
export async function exportManagedBackup(
  record: ManagedExchangeRecord,
  deps: ManagedExportDeps,
): Promise<void> {
  const at = downloadArtifact(record, deps);
  await deps.markBackedUp(record.id, at.toISOString());
}

/**
 * Export a record for MIGRATION ("take over on another device"): download the
 * artifact, then spend the source (marked with the handoff date) and record the
 * backup marker. The spend follows the download so a failed download does not spend
 * the source; both marker writes run after a successful download.
 */
export async function exportManagedMigration(
  record: ManagedExchangeRecord,
  deps: ManagedMigrationDeps,
): Promise<void> {
  const at = downloadArtifact(record, deps);
  const iso = at.toISOString();
  await deps.markSpent(record.id, iso);
  await deps.markBackedUp(record.id, iso);
}
