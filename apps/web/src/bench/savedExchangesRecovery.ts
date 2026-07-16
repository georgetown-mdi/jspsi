/**
 * The pure model behind the read-failed surface's recovery listing: turning the
 * store's diagnostic entries into the small display rows that surface lists, each
 * with the delete-by-key the surface dispatches. No React, no IndexedDB: the store
 * reads and the delete action live in the component, so the display derivation is
 * unit-testable in Node.
 *
 * A readable entry surfaces its label, side, and last-run date; an unreadable entry
 * surfaces a fixed "Unreadable record" label and no other detail, since nothing
 * about it could be parsed. Every row carries the stored key the one-step
 * delete-by-key acts on, so an unreadable record is discardable without a
 * successful parse. Secret material never reaches this model: the diagnostic
 * entries carry display essentials only.
 */

import { SIDE_LABEL } from "./savedExchangesModel";
import { dateLabel } from "./inviterModel";

import type { ManagedExchangeDiagnosticEntry } from "@psi/managedExchangeStore";

/** The label a row shows for an unreadable entry: nothing about it could be
 * parsed, so it reads as an unreadable record rather than an empty or guessed
 * name. */
export const UNREADABLE_RECORD_LABEL = "Unreadable record";

/** One row in the read-failed recovery listing: the stored key the delete acts on,
 * a display label (the operator's label, "(unnamed exchange)" when empty, or
 * {@link UNREADABLE_RECORD_LABEL} when the entry could not be parsed), the raw label
 * the delete confirm names (empty when unlabeled, so the button's own empty-label
 * branch fires rather than reading a doubly-transformed "(unnamed exchange)"), the
 * side and last-run date when parseable, whether the entry was unreadable, and
 * whether an exported backup remains under the operator's custody. */
export interface RecoveryRow {
  /** The stored key the one-step delete-by-key dispatches on. */
  id: string;
  /** The display label for the row text (see the interface doc). */
  label: string;
  /** The raw operator label the delete confirm names -- empty when unlabeled, so the
   * confirm reads "Delete this exchange?" exactly as the normal list's does, not the
   * transformed row text. Always empty on an unreadable row. */
  deleteLabel: string;
  /** This party's side, as the listing names it; absent on an unreadable row. */
  sideLabel?: string;
  /** The last run's calendar-day phrase, when the entry parsed and had a run. */
  lastRunAt?: string;
  /** Whether the entry could not be parsed. */
  unreadable: boolean;
  /** Whether an exported backup remains under the operator's custody, so the delete
   * confirm carries the custody note. Survives record unreadability. */
  backedUp: boolean;
}

/** Derive one recovery row from a diagnostic entry. A readable entry surfaces its
 * essentials (an empty label reads as "(unnamed exchange)" for the row text, matching
 * the run list, while the delete confirm names the raw label); an unreadable entry
 * surfaces only its key and the fixed unreadable label. Both carry the entry's backup
 * custody state through to the delete confirm. */
export function recoveryRow(
  entry: ManagedExchangeDiagnosticEntry,
): RecoveryRow {
  if (entry.kind === "unreadable")
    return {
      id: entry.id,
      label: UNREADABLE_RECORD_LABEL,
      deleteLabel: "",
      unreadable: true,
      backedUp: entry.backedUp,
    };
  const { essentials } = entry;
  return {
    id: essentials.id,
    label: essentials.label === "" ? "(unnamed exchange)" : essentials.label,
    deleteLabel: essentials.label,
    sideLabel: SIDE_LABEL[essentials.side],
    ...(essentials.lastRunAt !== undefined
      ? { lastRunAt: dateLabel(new Date(essentials.lastRunAt)) }
      : {}),
    unreadable: false,
    backedUp: entry.backedUp,
  };
}

/** Derive the recovery rows from the store's diagnostic entries, in store order. */
export function recoveryRows(
  entries: ReadonlyArray<ManagedExchangeDiagnosticEntry>,
): Array<RecoveryRow> {
  return entries.map((entry) => recoveryRow(entry));
}
