/**
 * The pure model behind the saved-exchanges affordance: turning a stored managed
 * record and its local sibling state into the small, honest summary the lobby's run
 * list shows -- the label, this party's side, a one-line last-run status, the
 * derived backup state, and the spent (handed-off) state. No React, no IndexedDB:
 * the store reads and the actions live in the components, so the display derivation
 * is unit-testable in Node.
 *
 * This is deliberately NOT the management list: it lists stored records with a run
 * action, the backup state, and (for a spent record) no run action. Add/remove and
 * per-exchange detail are separate items. The last-run status here is a plain
 * summary, so the operator can recognize a partnership and launch a re-run.
 */

import { deriveManagedBackupState } from "@psi/managedBackupState";
import { managedExchangeLapsed } from "@psi/managedExpiry";

import { dateLabel, dateTimeLabel } from "./inviterModel";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
} from "@psi/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managedLocalState";

/** This party's side, as the run list names it: the operator recognizes "you
 * invite" / "you accept" more readily than the wire roles. */
const SIDE_LABEL: Record<ManagedExchangeSide, string> = {
  inviter: "You invite",
  acceptor: "You accept",
};

/** The derived backup state a row surfaces, phrased for the list. `"backed-up"`
 * carries the date phrase for the quiet green line; `"backup-needed"` is the one
 * actionable state. */
export type SavedExchangeBackup =
  { kind: "backed-up"; asOf: string } | { kind: "backup-needed" };

/** One row in the saved-exchanges run list: everything the list renders for a
 * stored record, plus the record `id` the run action dispatches on. */
export interface SavedExchangeRow {
  /** The record's id, keying the row and the run action. */
  id: string;
  /** The operator's display label; may be empty (the field has no minimum). */
  label: string;
  /** This party's side, as the list names it (see {@link SIDE_LABEL}). */
  sideLabel: string;
  /** A one-line status summary of the last run and the expiry state. */
  status: string;
  /** Whether the stored secret has lapsed as of the row's `now`: the run action
   * is still offered (the launch surfaces the benign expiry state and points at
   * re-invite), but the list names the lapse so it is not a surprise. */
  expired: boolean;
  /** The derived backup state for the row (see {@link SavedExchangeBackup}). */
  backup: SavedExchangeBackup;
  /** When set, this device's copy was handed off by a migration export as of this
   * date phrase: the row shows no Run affordance and names the handoff. Deleting or
   * importing the artifact back is the only path forward. */
  spentAsOf?: string;
}

/** The last-run status line for a record, before the expiry note. A record that
 * has never run reads as never-run; a succeeded run names its date; a
 * non-succeeded outcome names the outcome so the operator knows the last attempt
 * did not complete. Deliberately a plain summary -- the tiered desync/attack copy
 * is a later item, so a failed run reads as a neutral "last run did not complete"
 * here, never attack framing. */
function lastRunStatus(record: ManagedExchangeRecord): string {
  if (record.lastRun === undefined) return "Not run yet";
  const at = dateTimeLabel(new Date(record.lastRun.at));
  if (record.lastRun.outcome === "succeeded") return `Last run succeeded ${at}`;
  if (record.lastRun.outcome === "missed") return `Last window missed ${at}`;
  return `Last run did not complete (${at})`;
}

/** The backup state phrased for a row, from the record's local backup marker. A
 * `"backed-up"` state carries the marker's date; a `"backup-needed"` state is the
 * one actionable prompt. */
function backupFor(local: ManagedLocalState | undefined): SavedExchangeBackup {
  const state = deriveManagedBackupState(local?.backup);
  if (state.kind === "backed-up")
    return { kind: "backed-up", asOf: dateLabel(new Date(state.backedUpAt)) };
  return { kind: "backup-needed" };
}

/**
 * Derive the display row for a stored record as of `now`, given its local sibling
 * state (the backup marker and any spent state). The last-run status carries a
 * lapsed-`expires` note when the secret has lapsed; the backup state is derived from
 * the marker's presence; a spent record names its handoff date and the list
 * suppresses its run action. `now` is injected so the expiry note is pure and
 * testable.
 */
export function savedExchangeRow(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): SavedExchangeRow {
  const expired = managedExchangeLapsed(record, now);
  const status = expired
    ? `${lastRunStatus(record)} - stored secret lapsed; re-invite to run again`
    : lastRunStatus(record);
  return {
    id: record.id,
    label: record.label,
    sideLabel: SIDE_LABEL[record.side],
    status,
    expired,
    backup: backupFor(local),
    ...(local?.spent !== undefined
      ? { spentAsOf: dateLabel(new Date(local.spent.spentAt)) }
      : {}),
  };
}

/** Derive the display rows for the stored records as of `now`, in the store's
 * order, each joined to its local sibling state by record id. */
export function savedExchangeRows(
  records: ReadonlyArray<ManagedExchangeRecord>,
  localState: ReadonlyMap<string, ManagedLocalState>,
  now: number,
): Array<SavedExchangeRow> {
  return records.map((record) =>
    savedExchangeRow(record, localState.get(record.id), now),
  );
}
