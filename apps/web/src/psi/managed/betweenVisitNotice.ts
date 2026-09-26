/**
 * What the installed app runtime tells the operator between visits, derived from
 * the run bookkeeping the next visit's surfaces read: the window's disposition,
 * the record's `lastRun` and `consecutiveMisses`, the local backup marker, and the
 * failure tier those resolve to. Seven moments earn a notification and everything
 * else stays quiet (docs/MANAGED_EXCHANGE.md, "The between-visit notification").
 *
 * Pure, and a reader only: it writes nothing, keeps no status of its own, and can
 * report no state the next visit cannot. A moment with nothing to say returns
 * `undefined`, which is the whole of the "everything else stays quiet" rule.
 *
 * Each notice carries the {@link BetweenVisitNotice.tag} that decides whether it
 * fires. A tag naming one occurrence -- a run that just finished, a window that
 * just passed -- differs at every occurrence, so each fires once; a tag naming a
 * STANDING state -- repeated misses, an input the runs cannot use, a refused
 * disclosure, a set too large to send, an unverified partner, an answer that
 * holds the schedule -- is the same string while that state stands, so the
 * second window that meets it says nothing further
 * ({@link ./managedScheduleRuntime.ts} holds the comparison).
 */

import { dateTimeLabel } from "../formatting";

import { deriveManagedBackupState } from "./managedBackupState";
import { parseStoredInstant } from "./managedExchangeRecord";
import { readManagedFailure } from "./managedFailureTiers";

import {
  CONSENT_FAILURE_TITLE,
  INPUT_FAILURE_TITLE,
  PARTIAL_ROTATION_FAILURE_TITLE,
  REPEATED_MISS_TITLE,
  SINGLE_COLUMN_DELIMITER_REMEDY,
  TERMS_SHORTFALL_FAILURE_TITLE,
  TOO_LARGE_FAILURE_TITLE,
  TOO_LARGE_FAILURE_TITLE_BY_OWNER,
  TOO_LARGE_REMEDY,
  TOO_LARGE_REMEDY_BY_OWNER,
  TOO_LARGE_SET_SOURCE_BY_OWNER,
  UNEXPLAINED_FAILURE_TITLE,
  WEBRTC_MESSAGE_BOUND_LABEL,
  repeatedMissCoordination,
} from "./managedFailureCopy";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedFailureTier } from "./managedFailureTiers";
import type { ManagedLocalState } from "./managedLocalStateShape";
import type { ManagedScheduleWindowDisposition } from "./managedSchedule";

/** Which moment a notice reports. Each maps to a state the next visit shows. */
export type BetweenVisitNoticeKind =
  | "backup"
  | "missed"
  | "skipped"
  | "repeated-misses"
  | "partial-rotation"
  | "input"
  | "terms-shortfall"
  | "consent"
  | "too-large"
  | "unexplained";

/** One OS notification: what happened, what to do about it, and the tag that
 * decides whether it fires at all. */
export interface BetweenVisitNotice {
  /** The moment this notice reports. */
  kind: BetweenVisitNoticeKind;
  /** The notification's title: the state, named without the exchange's label so
   * a glance reads the same for every exchange. */
  title: string;
  /** The notification's body: which exchange, what happened, and the operator's
   * move. */
  body: string;
  /** The fire-once key, unique per record (see this module's header). It is also
   * the platform notification's own tag, which keeps one exchange's notice from
   * replacing another's on the operator's screen. */
  tag: string;
}

/** What one record's window leaves behind, as the runner reported it and the
 * store holds it afterwards. */
export interface BetweenVisitNoticeInput {
  /** The record as stored after the window's bookkeeping landed. */
  record: ManagedExchangeRecord;
  /** The record's local sibling state, which holds the backup marker. */
  local: ManagedLocalState | undefined;
  /** Fully-elapsed windows this wake's catch-up walk counted before any attempt. */
  caughtUpMisses: number;
  /** The window's disposition, absent where the wake neither occupied nor
   * skipped a window. */
  disposition?: ManagedScheduleWindowDisposition;
  /** The instant the notice is derived at, for the failure tiering's lapse check. */
  now: number;
}

/** The title over each moment. The five failure titles are the same constants
 * the next visit's own alert holds its title to
 * ({@link ../../recurring/managedRunLaunchModel.ts}), which
 * betweenVisitNotice.test.ts holds this surface's titles equal to; the
 * completed-run, missed-window and skipped-window titles are this surface's own,
 * the next visit having no alert for any of them. */
const NOTICE_TITLES: Record<
  Exclude<BetweenVisitNoticeKind, "repeated-misses">,
  string
> = {
  backup: "A scheduled run finished; back up this exchange",
  missed: "A scheduled run did not happen",
  skipped: "Scheduled runs are on hold",
  "partial-rotation": PARTIAL_ROTATION_FAILURE_TITLE,
  input: INPUT_FAILURE_TITLE,
  "terms-shortfall": TERMS_SHORTFALL_FAILURE_TITLE,
  consent: CONSENT_FAILURE_TITLE,
  "too-large": TOO_LARGE_FAILURE_TITLE,
  unexplained: UNEXPLAINED_FAILURE_TITLE,
};

/** The failure tiers that earn a notice, each blocking every later window until
 * the operator acts. Every other tier is answered by the next visit alone. */
const NOTIFIED_FAILURE_TIERS: ReadonlySet<ManagedFailureTier> = new Set([
  "input",
  "terms-shortfall",
  "consent",
  "too-large",
  "unexplained",
]);

/**
 * The notice one record's window earns, or `undefined` where it earns none.
 *
 * The order is the design's: a completed run's stale backup first, then the
 * failures that block every later window, then the window the operator's own
 * answer held back, then the misses -- so a window that did not run for a reason
 * the operator must answer says that rather than counting another quiet miss
 * beside it.
 *
 * The switch is exhaustive over `disposition` (including `undefined`, for a
 * wake that occupied no window) with a `default` narrowed to `never`: a new
 * disposition fails to compile here rather than falling through this surface
 * silently. `"desynced"` routes through the same failure path as `"failed"` --
 * no runtime call site constructs it today (a rotation desync surfaces as an
 * auth-kind `"failed"` run), but the type admits it, so this surface must too.
 */
export function betweenVisitNotice(
  input: BetweenVisitNoticeInput,
): BetweenVisitNotice | undefined {
  const { record, local, disposition, caughtUpMisses, now } = input;
  const name = exchangeName(record.label);
  switch (disposition) {
    case "succeeded": {
      if (deriveManagedBackupState(local?.backup).kind === "backed-up")
        return undefined;
      return {
        kind: "backup",
        title: NOTICE_TITLES.backup,
        body:
          `${name} just ran, and its secret changed, so the backup you hold ` +
          `no longer restores it. Open this app and back up this exchange.`,
        tag: noticeTag(record.id, `backup:${record.lastRun?.at ?? ""}`),
      };
    }
    case "failed":
    case "desynced": {
      const notice = failureNotice(record, local, now, name);
      if (notice !== undefined) return notice;
      break;
    }
    case "skipped":
      return {
        kind: "skipped",
        title: NOTICE_TITLES.skipped,
        body:
          `${name} had a run window pass with no run: you answered that ` +
          `something did not add up about a failure on it, and its scheduled ` +
          `runs stop while that answer stands. Open this app and clear it once ` +
          `your partner confirms on a channel you trust, or delete the ` +
          `exchange.`,
        tag: noticeTag(record.id, "skipped"),
      };
    case "missed":
    case "unattempted":
    case undefined:
      break;
    default: {
      const unreachable: never = disposition;
      return unreachable;
    }
  }
  if (disposition !== "missed" && caughtUpMisses === 0) return undefined;
  if (readManagedFailure(record, local, now).tier === "partial-rotation")
    return partialRotationNotice(record, name);
  return missNotice(record, name);
}

/** The notice a passed window earns where it follows a key exchange that never
 * saved its rotation: the misses are what a secret the partner saved and this
 * device did not produces, so the notice names the re-invite rather than
 * another wait. Its tag names the standing state, so later misses say nothing
 * further while it stands. */
function partialRotationNotice(
  record: ManagedExchangeRecord,
  name: string,
): BetweenVisitNotice {
  return {
    kind: "partial-rotation",
    title: NOTICE_TITLES["partial-rotation"],
    body:
      `${name}: a run stopped during its key exchange before it saved the ` +
      `updated secret on this device, and a scheduled run since then did not ` +
      `meet your partner. Your partner probably saved a secret this device ` +
      `does not have. Open this app and re-invite your partner.`,
    tag: noticeTag(record.id, "partial-rotation"),
  };
}

/** The notice a failed window earns from the tier its bookkeeping resolves to.
 * The tier is read exactly as the next visit reads it, so a failure a benign
 * state explains -- a restore since the last success, a rotation this device
 * could not save -- stays as quiet here as it is there.
 *
 * The shortfall splits on the stamp's own `singleColumnInput`, the same split
 * the next visit's alert makes ({@link ../../recurring/managedRunLaunchModel.ts}).
 * The reading rides the tag as well as the body: the two readings are different
 * standing states with different remedies, so a shortfall that becomes a
 * one-column reading says so rather than being suppressed as the state already
 * reported. The too-large notice splits the same way on the stamp's own
 * `tooLargeSetOwner`, which names whose input to split. */
function failureNotice(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
  name: string,
): BetweenVisitNotice | undefined {
  const { tier } = readManagedFailure(record, local, now);
  if (!NOTIFIED_FAILURE_TIERS.has(tier)) return undefined;
  if (tier === "input")
    return {
      kind: "input",
      title: NOTICE_TITLES.input,
      body:
        `${name} could not run: its input file is missing, could not be read, ` +
        `or does not have the columns this exchange needs. Put the file back ` +
        `in place; every later window stops the same way until you do.`,
      tag: noticeTag(record.id, "input"),
    };
  if (tier === "terms-shortfall") {
    const singleColumn = record.lastRun?.singleColumnInput === true;
    return {
      kind: "terms-shortfall",
      title: NOTICE_TITLES["terms-shortfall"],
      body: singleColumn
        ? `${name} stopped before connecting because its input file read as ` +
          `a single column, which cannot supply every linkage key this ` +
          `exchange agreed to match on, and nothing left this device. ` +
          SINGLE_COLUMN_DELIMITER_REMEDY
        : `${name} stopped before connecting because its input file cannot ` +
          `supply every linkage key this exchange agreed to match on, and ` +
          `nothing left this device. Open this app and run it with a file ` +
          `that covers every agreed key, or set the exchange up again with ` +
          `your partner.`,
      tag: noticeTag(
        record.id,
        singleColumn ? "terms-shortfall:single-column" : "terms-shortfall",
      ),
    };
  }
  if (tier === "consent")
    return {
      kind: "consent",
      title: NOTICE_TITLES.consent,
      body:
        `${name} stopped before connecting because the columns its input file ` +
        `would send are not the ones this exchange agreed to send, and nothing ` +
        `left this device. Open this app and run it with the file whose ` +
        `columns match what was agreed, or set the exchange up again with your ` +
        `partner.`,
      tag: noticeTag(record.id, "consent"),
    };
  if (tier === "too-large") {
    const owner = record.lastRun?.tooLargeSetOwner;
    const overBound =
      `was over the ${WEBRTC_MESSAGE_BOUND_LABEL} one WebRTC message can ` +
      `hold, and every later window stops the same way.`;
    return {
      kind: "too-large",
      title:
        owner === undefined
          ? NOTICE_TITLES["too-large"]
          : TOO_LARGE_FAILURE_TITLE_BY_OWNER[owner],
      body:
        owner === undefined
          ? `${name} stopped because a set of values it had to send ` +
            `${overBound} ${TOO_LARGE_REMEDY}`
          : `${name} stopped because ${TOO_LARGE_SET_SOURCE_BY_OWNER[owner]} ` +
            `${overBound} ${TOO_LARGE_REMEDY_BY_OWNER[owner]}`,
      tag: noticeTag(
        record.id,
        owner === undefined ? "too-large" : `too-large:${owner}`,
      ),
    };
  }
  return {
    kind: "unexplained",
    title: NOTICE_TITLES.unexplained,
    body:
      `${name} connected but could not verify your partner, and nothing on ` +
      `this device explains why. Open this app for the message to send your ` +
      `partner on your usual trusted channel, and confirm with them before ` +
      `you re-invite.`,
    tag: noticeTag(record.id, "unexplained"),
  };
}

/**
 * The notice a passed window earns: the coordination prompt once the consecutive
 * misses reach the escalation threshold, and the quiet informational line below
 * it. The escalated tag names the standing state rather than the window, so the
 * misses after it say nothing further while that state stands.
 *
 * A wake that finds several windows elapsed reaches this once, with the count the
 * catch-up walk wrote, rather than once per window.
 */
function missNotice(
  record: ManagedExchangeRecord,
  name: string,
): BetweenVisitNotice | undefined {
  const schedule = record.schedule;
  if (schedule === undefined) return undefined;
  const coordination = repeatedMissCoordination(schedule);
  if (coordination !== undefined)
    return {
      kind: "repeated-misses",
      title: REPEATED_MISS_TITLE,
      body: `${name}: ${coordination.line}`,
      tag: noticeTag(record.id, "repeated-misses"),
    };
  const next = instantLabel(schedule.nextWindow);
  return {
    kind: "missed",
    title: NOTICE_TITLES.missed,
    body:
      `${name} had a run window pass with no run.` +
      (next === undefined ? "" : ` The next window opens ${next}.`) +
      ` Nothing to do: the next window is tried on its own.`,
    tag: noticeTag(record.id, `missed:${schedule.nextWindow}`),
  };
}

/** How an exchange is named in a notice: its label, or a fixed stand-in where the
 * operator left it empty (the saved list names an unlabelled exchange the same
 * way). */
function exchangeName(label: string): string {
  return label.trim() === "" ? "An unnamed exchange" : label;
}

/** A stored instant phrased for display, or `undefined` where the stored value is
 * not one -- the sentence naming it is then left out rather than showing a
 * placeholder. */
function instantLabel(stored: string): string | undefined {
  const parsed = parseStoredInstant(stored);
  return Number.isNaN(parsed) ? undefined : dateTimeLabel(new Date(parsed));
}

/** The fire-once key for one record's notice. The record's id keeps two
 * exchanges in the same state apart, on the platform's own notification tag as
 * well as in the runtime's comparison. */
function noticeTag(id: string, state: string): string {
  return `${id}|${state}`;
}
