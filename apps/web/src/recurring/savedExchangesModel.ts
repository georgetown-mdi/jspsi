/**
 * The pure model behind the saved-exchanges affordance: turning a stored managed
 * record and its local sibling state into the small, accurate summary the lobby's run
 * list shows -- the label, this party's side, a one-line last-run status, the
 * schedule's due-ness where one is agreed, the derived backup state, and the spent
 * (handed-off) state. No React, no IndexedDB: the store reads and the actions live
 * in the components, so the display derivation is unit-testable in Node.
 *
 * This is NOT the management list: it lists stored records with a run
 * action, the backup state, and (for a spent record) no run action. Add/remove and
 * per-exchange detail are separate items. The last-run status here is a plain
 * summary, so the operator can recognize a partnership and launch a re-run.
 */

import {
  channelThisAppDoesNotRun,
  raisedStandingCondition,
  runnableManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import {
  managedStandingConditionTier,
  readManagedFailure,
} from "@psi/managed/managedFailureTiers";
import { deriveManagedBackupState } from "@psi/managed/managedBackupState";
import { managedExchangeLapsed } from "@psi/managed/managedExpiry";

import { dateLabel, dateTimeLabel } from "@psi/formatting";

import {
  configurationOnlyStatus,
  sidelessRowLabel,
} from "./managedConfigurationModel";
import {
  repeatedMissCoordination,
  scheduleDueLine,
  scheduleDueness,
} from "./scheduleSurfacingModel";

import type {
  ManagedElsewhereChannel,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeSide,
  TooLargeSetOwner,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedFailureTier,
  ManagedStandingTier,
} from "@psi/managed/managedFailureTiers";
import type {
  ManagedLocalState,
  ManagedSpentHandoff,
} from "@psi/managed/managedLocalState";

/** This party's side, as the run list names it: the operator recognizes "you
 * invite" / "you accept" more readily than the wire roles. Shared with the
 * read-failed recovery listing so both surfaces name the side identically. */
export const SIDE_LABEL: Record<ManagedExchangeSide, string> = {
  inviter: "You invite",
  acceptor: "You accept",
};

/** What a row names in the side position: this party's side, or the channel
 * for a configuration on one that names no side. The saved-exchanges list and
 * the read-failed recovery listing both derive it here. */
export function rowSideLabel(
  side: ManagedExchangeSide | undefined,
  elsewhereChannel: ManagedElsewhereChannel | undefined,
): string {
  return side !== undefined
    ? SIDE_LABEL[side]
    : sidelessRowLabel(elsewhereChannel);
}

/** The derived backup state a row shows, phrased for the list. `"backed-up"`
 * holds the date phrase for the quiet green line; `"backup-needed"` is the one
 * actionable state. */
type SavedExchangeBackup =
  | { kind: "backed-up"; asOf: string }
  | { kind: "backup-needed" }
  | { kind: "not-applicable" };

/** The schedule lines a row holds for a record with an agreed schedule: where
 * the recurrence stands at the row's `now`, and the coordination line a run of
 * missed windows earns (see {@link ./scheduleSurfacingModel.ts}). */
interface SavedExchangeScheduleLines {
  /** Where the recurrence stands: a window open now, or the next one. */
  dueLine: string;
  /** The escalated coordination line, once the record's consecutive-miss count
   * reaches the threshold; absent below it. */
  missLine?: string;
}

/** One row in the saved-exchanges run list: everything the list renders for a
 * stored record, plus the record `id` the run action dispatches on. */
export interface SavedExchangeRow {
  /** The record's id, keying the row and the run action. */
  id: string;
  /** The operator's display label; may be empty (the field has no minimum). */
  label: string;
  /** This party's side, as the list names it (see {@link SIDE_LABEL}), or the
   * channel for a configuration on one that names no side. */
  sideLabel: string;
  /** A one-line status summary of the last run and the expiry state. */
  status: string;
  /** Whether the stored secret has lapsed as of the row's `now`: the run action
   * is still offered (the launch shows the benign expiry state and points at
   * re-invite), but the list names the lapse regardless. */
  expired: boolean;
  /** The derived backup state for the row (see {@link SavedExchangeBackup}). */
  backup: SavedExchangeBackup;
  /** Whether the record holds no shared secret: a configuration imported from
   * the command line, which edits and exports here and runs there -- every
   * record on a channel this app does not run among them. Derived from the
   * record's own shape, never from a stored flag, so the row withholds the Run
   * affordance for the same reason the exchange's own surface does. */
  configurationOnly: boolean;
  /** When set, this device's copy was handed off by an export as of this date
   * phrase: the row shows no Run affordance and names the handoff. Deleting is the
   * only path forward, beside the recovery {@link spentHandoff} names. */
  spentAsOf?: string;
  /** Which hand-off spent the copy, when it was not the device migration: the two
   * have different recoveries (a migration's artifact imports back; the
   * command-line files do not), so the row names the one that applies. Absent on a
   * row that is not spent, and on a migration spend. */
  spentHandoff?: ManagedSpentHandoff;
  /** The schedule lines, for a record that holds an agreed schedule and is not
   * spent (see {@link scheduleLines}). Absent otherwise, so a row for an exchange
   * nobody scheduled says nothing about scheduling. */
  schedule?: SavedExchangeScheduleLines;
}

/** The too-large line's remedy gist by whose set was over the bound: the row's
 * short form of the one remedy the next-visit alert states in full. */
const TOO_LARGE_ROW_REMEDY_BY_OWNER: Record<TooLargeSetOwner, string> = {
  local: "split your input",
  partner: "ask your partner to split theirs",
};

/** The one-line status a failure tier displays as in the list -- a specific but quiet
 * line naming the state and its recovery gist, deferring the full copy (and, for the
 * unexplained tier, the attack framing and the out-of-band confirmation) to the
 * per-exchange surface the row opens. A benign tier is never treated as attack framing
 * here; the unexplained tier displays as "needs you to check with your partner", the
 * plain lead without the checklist. `at` is the last run's phrased instant;
 * `tooLargeSetOwner` names whose set a too-large run's was, when recorded. */
function tierStatus(
  tier: ManagedFailureTier,
  at: string,
  tooLargeSetOwner: TooLargeSetOwner | undefined,
): string {
  switch (tier) {
    case "expired":
      return "Stored secret lapsed; re-invite to run again";
    case "input":
      return `Last run could not use your input file (${at})`;
    case "terms-shortfall":
      return `Last run stopped before connecting (${at}); settle the terms or use a covering file`;
    case "consent":
      return `Last run stopped before sending (${at}); settle what it sends`;
    case "too-large":
      if (tooLargeSetOwner === undefined)
        return `Last run stopped: a file is too large for a browser exchange (${at}); split the input`;
      return (
        `Last run stopped: ${tooLargeSetOwner === "local" ? "your" : "your partner's"} ` +
        `file is too large for a browser exchange (${at}); ` +
        TOO_LARGE_ROW_REMEDY_BY_OWNER[tooLargeSetOwner]
      );
    case "handed-off":
      // The row already names the hand-off and its date beside this line, so the
      // status says what the run did rather than repeating the state.
      return `Last run stopped: this exchange was handed off (${at})`;
    case "custody-unreadable":
      return `Last run stopped before connecting (${at}); part of its stored copy could not be read`;
    case "storage":
      return `Last run could not be saved (${at}); re-invite to reconnect`;
    case "partial-rotation":
      return `Probably out of sync with your partner (${at}); re-invite to reconnect`;
    case "imported":
      return (
        "Restored from a backup or key file, or taken back from the command " +
        "line; re-invite to reconnect"
      );
    case "unexplained":
      return `Last run failed (${at}); check with your partner`;
    case "transport":
      return `Last run did not complete (${at})`;
    case "missed":
      // Phrased without naming a window: the outcome is reached at an agreed window
      // and by an attended run whose own wait for the partner expired, and the same
      // line stands for both.
      return `Your partner did not arrive (${at})`;
    case "none":
      // A "none" tier is never-run or a succeeded last run, and lastRunStatus --
      // the only caller -- phrases both before reaching here, so this string reaches
      // no row (savedExchangesModel.test.ts drives both readings).
      return "";
  }
}

/** The one-line status a STANDING condition displays as: the same quiet register as
 * {@link tierStatus}, phrased for a condition the record carries rather than for the
 * last run -- which may since be a no-show or a success, and saying "last run" of
 * either would be false. `at` is the condition's own instant. */
function standingStatus(tier: ManagedStandingTier, at: string): string {
  switch (tier) {
    case "storage":
      return `A run could not save this exchange's secret (${at}); re-invite to reconnect`;
    case "imported":
      return (
        "Restored from a backup or key file, or taken back from the command " +
        "line; re-invite to reconnect"
      );
    case "unexplained":
      return `A run failed and is unexplained (${at}); check with your partner`;
  }
}

/** The last-run status line for a record. A record that has never run is treated as
 * never-run; a succeeded run names its date; a non-succeeded outcome is tiered from the
 * record's own bookkeeping ({@link readManagedFailure}) into its specific,
 * non-alarming state -- the list's quiet form of the tiers the run surface expands.
 *
 * A standing condition takes the line wherever the reading rests on it, so the state
 * keeps its place in the list across every later no-show and success. It does not
 * displace a lapsed bound: the reading checks the lapse first, exactly as the
 * pre-connection check does. */
function lastRunStatus(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): string {
  const reading = readManagedFailure(record, local, now);
  const condition = raisedStandingCondition(record);
  if (reading.standing && condition !== undefined)
    return standingStatus(
      managedStandingConditionTier(condition, local),
      dateTimeLabel(new Date(condition.since)),
    );
  const { tier } = reading;
  if (tier === "none") {
    const { lastRun } = record;
    if (lastRun === undefined) return "Not run yet";
    const when = dateTimeLabel(new Date(lastRun.at));
    // The two "none" readings with a recorded entry: a succeeded run, and a
    // window the schedule skipped whose answer has since been cleared -- while it
    // stands the standing line above takes the row.
    if (lastRun.outcome === "skipped")
      return `A scheduled run was skipped ${when}`;
    return `Last run succeeded ${when}`;
  }
  const at =
    record.lastRun !== undefined
      ? dateTimeLabel(new Date(record.lastRun.at))
      : "";
  return tierStatus(tier, at, record.lastRun?.tooLargeSetOwner);
}

/** The backup state phrased for a row, from the record's local backup marker. A
 * `"backed-up"` state holds the marker's date; a `"backup-needed"` state is the
 * one actionable prompt. */
function backupFor(local: ManagedLocalState | undefined): SavedExchangeBackup {
  const state = deriveManagedBackupState(local?.backup);
  if (state.kind === "backed-up")
    return { kind: "backed-up", asOf: dateLabel(new Date(state.backedUpAt)) };
  return { kind: "backup-needed" };
}

/** The schedule lines for a row: where the recurrence stands at `now`, and the
 * coordination line once the record's own consecutive-miss count has reached the
 * escalation threshold. */
function scheduleLines(
  schedule: ManagedExchangeSchedule,
  now: number,
): SavedExchangeScheduleLines {
  const coordination = repeatedMissCoordination(schedule);
  return {
    dueLine: scheduleDueLine(scheduleDueness(schedule, now)),
    ...(coordination !== undefined ? { missLine: coordination.line } : {}),
  };
}

/**
 * Derive the display row for a stored record as of `now`, given its local sibling
 * state (the backup marker and any spent state). A record holding no shared
 * secret is a configuration only: it has no run, no lapse, and no backup state,
 * so the row says what it is and the list offers no Run. The last-run status holds a
 * lapsed-`expires` note when the secret has lapsed; the backup state is derived from
 * the marker's presence; a spent record names its handoff date and which hand-off it
 * was, and the list suppresses its run action. `now` is injected so the expiry note
 * is pure and testable.
 *
 * A record with an agreed schedule also has its schedule lines, unless it is spent
 * -- a spent row shows no run action.
 */
export function savedExchangeRow(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): SavedExchangeRow {
  if (!runnableManagedExchange(record))
    return {
      id: record.id,
      label: record.label,
      sideLabel: rowSideLabel(
        record.side,
        channelThisAppDoesNotRun(record.exchangeFile),
      ),
      status: configurationOnlyStatus(record),
      expired: false,
      backup: { kind: "not-applicable" },
      configurationOnly: true,
    };
  return {
    id: record.id,
    label: record.label,
    sideLabel: SIDE_LABEL[record.side],
    status: lastRunStatus(record, local, now),
    expired: managedExchangeLapsed(record, now),
    backup: backupFor(local),
    configurationOnly: false,
    ...(local?.spent !== undefined
      ? {
          spentAsOf: dateLabel(new Date(local.spent.spentAt)),
          ...(local.spent.handoff !== undefined
            ? { spentHandoff: local.spent.handoff }
            : {}),
        }
      : record.schedule !== undefined
        ? { schedule: scheduleLines(record.schedule, now) }
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
