/**
 * The pure model behind the saved-exchanges affordance: turning a stored managed
 * record into the small, honest summary the lobby's run list shows -- the label,
 * this party's side, and a one-line status derived from `lastRun` and `expires`.
 * No React, no IndexedDB: the store read and the run action live in the
 * components, so the display derivation is unit-testable in Node.
 *
 * This is deliberately NOT the management list: it lists stored records with a run
 * action and nothing more. Add/remove, per-exchange detail, and the full derived
 * backup state are separate items. The status here is a plain summary of the last
 * run, so the operator can recognize a partnership and launch a re-run.
 */

import { managedExchangeLapsed } from "@psi/managedExpiry";

import { dateTimeLabel } from "./inviterModel";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
} from "@psi/managedExchangeRecord";

/** This party's side, as the run list names it: the operator recognizes "you
 * invite" / "you accept" more readily than the wire roles. */
const SIDE_LABEL: Record<ManagedExchangeSide, string> = {
  inviter: "You invite",
  acceptor: "You accept",
};

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

/**
 * Derive the display row for a stored record as of `now`. The status line is the
 * last-run summary, with a lapsed-`expires` note appended (the record's secret
 * has lapsed and re-invite is the recovery). `now` is injected so the expiry note
 * is pure and testable.
 */
export function savedExchangeRow(
  record: ManagedExchangeRecord,
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
  };
}

/** Derive the display rows for the stored records as of `now`, in the store's
 * order. */
export function savedExchangeRows(
  records: ReadonlyArray<ManagedExchangeRecord>,
  now: number,
): Array<SavedExchangeRow> {
  return records.map((record) => savedExchangeRow(record, now));
}
