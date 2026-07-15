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
 * Why "current" is marker-present, not a run comparison. The spec pins currency to
 * "taken since the last rotation" but forbids any secret-derived value at rest (no
 * digest or fingerprint of the secret) and any rotation epoch. The invariant is
 * carried structurally instead of derived: every export binds its serialized bytes
 * to the marker write in one atomic step, and the rotation-persist write clears the
 * marker in its own cross-store transaction, so "marker present" already means "an
 * export containing the current secret was taken since the last rotation" (see
 * {@link ./managedExchangeStore.ts}). The derivation therefore reads only marker
 * presence -- no secret material, no epoch, and no `lastRun` outcome to interpret.
 *
 * `navigator.storage.persisted()` is never an input here: the operator cannot act
 * on the storage grant except by exporting, which this state already covers, and on
 * WebKit a granted persist() must not read as covered (it does not reliably exempt
 * the ITP cap). The derivation depends only on the local backup marker, so a
 * persist grant structurally cannot suppress the actionable state.
 */

/** The local backup marker for a record: when a backup was last taken. A plain
 * timestamp, not a secret-derived value -- it records the moment of the export,
 * cleared atomically when the secret rotates (see {@link ./managedExchangeStore.ts}).
 * Stored beside the record (see {@link ./managedLocalState.ts}), never in the record
 * or the export artifact. */
export interface ManagedBackupMarker {
  /** ISO 8601 UTC instant a backup was last taken for this record. */
  backedUpAt: string;
}

/** The derived backup state the UI surfaces:
 *
 * - `"backed-up"` -- a current export exists (the marker is present, and it is
 *   cleared on rotation): the exchange shows a quiet green "backed up as of <date>"
 *   and nothing else. {@link backedUpAt} carries the marker's instant for the date.
 * - `"backup-needed"` -- no marker (none was ever taken, or the secret rotated since
 *   the last one and cleared it): one actionable "Back up this exchange".
 */
export type ManagedBackupState =
  { kind: "backed-up"; backedUpAt: string } | { kind: "backup-needed" };

/**
 * Derive the backup state for a record given its local backup marker (or its
 * absence). A present marker is `"backed-up"`; no marker is `"backup-needed"`. The
 * marker's currency is a structural property of how it is written and cleared (an
 * export binds the serialized bytes to the marker; a rotation clears it in the same
 * transaction), not something this pure derivation re-checks against the record.
 */
export function deriveManagedBackupState(
  marker: ManagedBackupMarker | undefined,
): ManagedBackupState {
  if (marker === undefined) return { kind: "backup-needed" };
  return { kind: "backed-up", backedUpAt: marker.backedUpAt };
}
