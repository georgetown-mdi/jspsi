/**
 * What the installed app runtime tells the operator between visits, derived from
 * the run bookkeeping the next visit's surfaces read: the window's disposition,
 * the record's `lastRun` and `consecutiveMisses`, the local backup marker, and the
 * failure tier those resolve to. Five moments earn a notification and everything
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
 * disclosure, an unverified partner -- is the same string while that state stands,
 * so the second window that meets it says nothing further
 * ({@link ./managedScheduleRuntime.ts} holds the comparison).
 */

import { dateTimeLabel } from "../formatting";

import { deriveManagedBackupState } from "./managedBackupState";
import { parseStoredInstant } from "./managedExchangeRecord";
import { readManagedFailure } from "./managedFailureTiers";

import {
  REPEATED_MISS_TITLE,
  repeatedMissCoordination,
} from "./managedRepeatedMiss";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedFailureTier } from "./managedFailureTiers";
import type { ManagedLocalState } from "./managedLocalStateShape";
import type { ManagedScheduleWindowDisposition } from "./managedSchedule";

/** Which moment a notice reports. Each maps to a state the next visit shows. */
export type BetweenVisitNoticeKind =
  | "backup"
  | "missed"
  | "repeated-misses"
  | "input"
  | "terms-shortfall"
  | "consent"
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
  /** The window's disposition, absent where no window was occupied. */
  disposition?: ManagedScheduleWindowDisposition;
  /** The instant the notice is derived at, for the failure tiering's lapse check. */
  now: number;
}

/** The title over each moment. The four failure titles are the words the next
 * visit's own alert holds for that tier, which betweenVisitNotice.test.ts holds
 * them equal to; the completed-run and missed-window titles are this surface's
 * own, the next visit having no alert for either. */
const NOTICE_TITLES: Record<
  Exclude<BetweenVisitNoticeKind, "repeated-misses">,
  string
> = {
  backup: "A scheduled run finished; back up this exchange",
  missed: "A scheduled run did not happen",
  input: "Your input file could not be used",
  "terms-shortfall":
    "Your input file cannot match on everything this exchange agreed to",
  consent: "What this run would send is not what this exchange agreed to send",
  unexplained: "This run failed and needs you to check with your partner",
};

/** The failure tiers that earn a notice, each blocking every later window until
 * the operator acts. Every other tier is answered by the next visit alone. */
const NOTIFIED_FAILURE_TIERS: ReadonlySet<ManagedFailureTier> = new Set([
  "input",
  "terms-shortfall",
  "consent",
  "unexplained",
]);

/**
 * The notice one record's window earns, or `undefined` where it earns none.
 *
 * The order is the design's: a completed run's stale backup first, then the
 * failures that block every later window, then the misses -- so a window that
 * failed for a reason the operator must answer says that rather than counting
 * another quiet miss beside it.
 */
export function betweenVisitNotice(
  input: BetweenVisitNoticeInput,
): BetweenVisitNotice | undefined {
  const { record, local, disposition, caughtUpMisses, now } = input;
  const name = exchangeName(record.label);
  if (disposition === "succeeded") {
    if (deriveManagedBackupState(local?.backup).kind === "backed-up")
      return undefined;
    return {
      kind: "backup",
      title: NOTICE_TITLES.backup,
      body:
        `${name} just ran, and its secret changed, so the backup you hold no ` +
        `longer restores it. Open this app and back up this exchange.`,
      tag: noticeTag(record.id, `backup:${record.lastRun?.at ?? ""}`),
    };
  }
  if (disposition === "failed") {
    const notice = failureNotice(record, local, now, name);
    if (notice !== undefined) return notice;
  }
  if (disposition !== "missed" && caughtUpMisses === 0) return undefined;
  return missNotice(record, name);
}

/** The notice a failed window earns from the tier its bookkeeping resolves to.
 * The tier is read exactly as the next visit reads it, so a failure a benign
 * state explains -- a restore since the last success, a rotation this device
 * could not save -- stays as quiet here as it is there. */
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
  if (tier === "terms-shortfall")
    return {
      kind: "terms-shortfall",
      title: NOTICE_TITLES["terms-shortfall"],
      body:
        `${name} stopped before connecting because its input file cannot ` +
        `supply every linkage key this exchange agreed to match on, and ` +
        `nothing left this device. Open this app and run it with a file that ` +
        `covers every agreed key, or set the exchange up again with your ` +
        `partner.`,
      tag: noticeTag(record.id, "terms-shortfall"),
    };
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
