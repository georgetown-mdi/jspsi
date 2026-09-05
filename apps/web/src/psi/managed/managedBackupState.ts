/**
 * The one derived backup state a managed exchange shows (see
 * docs/MANAGED_EXCHANGE.md, "Moment-anchored backup surfaces"): a quiet green
 * "backed up as of <date>" when a current export exists, or one actionable "Back up
 * this exchange" when none does. This module is the pure derivation; the local
 * marker it reads is stored beside the record (see {@link ./managedLocalState.ts}),
 * never in the record and never in the export artifact -- the record schema is
 * reader-rejects-unknown and the export strips only the handle, so a marker field
 * would force a schema bump or leak into the export.
 *
 * Currency is "taken since the last rotation," held structurally rather than
 * derived: every export binds its serialized bytes to the marker write in one
 * atomic step, and the rotation-persist write clears the marker in its own
 * cross-store transaction (see {@link ./managedExchangeStore.ts}). Marker presence
 * therefore already means a current export exists; the derivation reads no secret
 * material, no rotation epoch, and no `lastRun` outcome.
 *
 * `navigator.storage.persisted()` is never an input: on WebKit a granted
 * persist() must not be treated as covered (it does not reliably exempt the ITP
 * cap). The derivation depends only on the local backup marker, so a persist
 * grant cannot suppress the actionable state.
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

/** The derived backup state the UI shows:
 *
 * - `"backed-up"` -- a current export exists (the marker is present, and it is
 *   cleared on rotation): the exchange shows a quiet green "backed up as of <date>"
 *   and nothing else. {@link backedUpAt} holds the marker's instant for the date.
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
