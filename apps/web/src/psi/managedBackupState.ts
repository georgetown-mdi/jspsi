/**
 * The one derived backup state a managed exchange surfaces (see
 * docs/MANAGED_EXCHANGE.md, "Moment-anchored backup surfaces"): a quiet green
 * "backed up as of <date>" when a current export exists, or one actionable "Back up
 * this exchange" when none does. This module is the pure derivation; the local
 * marker it reads is stored beside the record (see {@link ./managedLocalState.ts}),
 * never in the record and never in the export artifact.
 *
 * Why the marker is a local sibling, not a record field. The record schema is
 * reader-rejects-unknown and the export-artifact contents are the persisted fields
 * minus the handle, so a marker on the record would either force a new
 * `schemaVersion` or leak into the artifact -- and the artifact must not carry a
 * source-local "when I last backed up" note (an imported copy is a fresh owner).
 * Keeping the marker a sibling makes its non-inclusion structural: the exporter
 * reads only the record.
 *
 * Why "current" is derived from the last successful run, not a secret comparison.
 * The spec pins currency to "taken since the last rotation" but forbids any
 * secret-derived value at rest (no digest or fingerprint of the secret) and any
 * rotation epoch. A rotation happens exactly at a successful run, and the record
 * already carries that instant honestly (`lastRun.at` with `outcome: "succeeded"`),
 * so a backup is current when it was taken at or after the last successful run --
 * no secret material and no epoch are read or stored. A record that has never run
 * successfully has rotated no secret since it was established, so any backup of it
 * is current.
 *
 * `navigator.storage.persisted()` is never an input here: the operator cannot act
 * on the storage grant except by exporting, which this state already covers, and on
 * WebKit a granted persist() must not read as covered (it does not reliably exempt
 * the ITP cap). The derivation depends only on the record's run bookkeeping and the
 * local backup marker, so a persist grant structurally cannot suppress the
 * actionable state.
 */

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The local backup marker for a record: when a backup was last taken. A plain
 * timestamp, not a secret-derived value -- it records the moment of the export, and
 * currency is derived by comparing it to the record's last successful run. Stored
 * beside the record (see {@link ./managedLocalState.ts}), never in the record or the
 * export artifact. */
export interface ManagedBackupMarker {
  /** ISO 8601 UTC instant a backup was last taken for this record. */
  backedUpAt: string;
}

/** The derived backup state the UI surfaces:
 *
 * - `"backed-up"` -- a current export exists (taken at or after the last successful
 *   run): the exchange shows a quiet green "backed up as of <date>" and nothing
 *   else. {@link backedUpAt} carries the marker's instant for the date.
 * - `"backup-needed"` -- no current export exists (none was ever taken, or the
 *   secret has rotated since the last one): one actionable "Back up this exchange".
 */
export type ManagedBackupState =
  { kind: "backed-up"; backedUpAt: string } | { kind: "backup-needed" };

/** The last instant the record's secret rotated, or `undefined` if it has not
 * rotated since the record was established. A rotation happens exactly at a
 * successful run, so the last rotation is the last successful run's instant; a
 * non-succeeded `lastRun` (a miss, a failure, a benign input problem) did not
 * rotate. Read from the record's own bookkeeping -- no secret material. */
function lastRotationAt(
  record: Pick<ManagedExchangeRecord, "lastRun">,
): string | undefined {
  if (record.lastRun === undefined) return undefined;
  if (record.lastRun.outcome !== "succeeded") return undefined;
  return record.lastRun.at;
}

/**
 * Derive the backup state for a record given its local backup marker (or its
 * absence). A backup is current when it was taken at or after the last successful
 * run (the last rotation); with no successful run yet, any backup is current. No
 * marker at all is always `"backup-needed"`. Compared as parsed instants, not
 * strings, so ISO stamps of differing fractional precision order chronologically.
 */
export function deriveManagedBackupState(
  record: Pick<ManagedExchangeRecord, "lastRun">,
  marker: ManagedBackupMarker | undefined,
): ManagedBackupState {
  if (marker === undefined) return { kind: "backup-needed" };
  const rotation = lastRotationAt(record);
  if (rotation === undefined)
    return { kind: "backed-up", backedUpAt: marker.backedUpAt };
  if (Date.parse(marker.backedUpAt) >= Date.parse(rotation))
    return { kind: "backed-up", backedUpAt: marker.backedUpAt };
  return { kind: "backup-needed" };
}
