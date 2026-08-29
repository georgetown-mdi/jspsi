/**
 * The pure display derivation for a managed exchange's agreed run schedule: where
 * the recurrence stands at an instant, the cadence in words, and the coordination
 * state a run of missed windows earns. Shared by the saved-exchanges list
 * ({@link ./savedExchangesModel.ts}) and the per-exchange detail view
 * ({@link ./managedDetailModel.ts}) so both name the same window and escalate on
 * the same count, in one voice.
 *
 * Every window instant is read through the schedule arithmetic in
 * {@link ../psi/managedSchedule.ts} and phrased for display exactly once, here.
 * The recurrence is UTC-millisecond arithmetic off the record's stored anchor; the
 * host zone enters only at that display boundary, where `Intl` renders the fixed
 * instant on the operator's own clock. Nothing here re-derives a window instant,
 * and no local-calendar date add appears anywhere: across a daylight-saving
 * transition a calendar add moves the agreed instant by the offset change, which
 * is the drift the shared anchor exists to prevent -- so a window straddling a
 * transition renders an hour later on the wall clock and at the same agreed
 * instant.
 *
 * These surfaces DISPLAY the schedule; they never advance it. The bookkeeping
 * fields are read verbatim -- `consecutiveMisses` as the record carries it -- so
 * nothing shown here anticipates a write the runner has not made.
 *
 * `now` is injected rather than read, matching the clock discipline of the managed
 * modules, so every derivation is a pure function of its inputs.
 */

import {
  managedScheduleWindow,
  managedScheduleWindowStateAt,
  nextManagedScheduleWindowAfter,
} from "@psi/managedSchedule";

import { dateTimeLabel, lifetimeNoun } from "./inviterModel";

import type { ManagedExchangeSchedule } from "@psi/managedExchangeRecord";

/**
 * The consecutive-miss count at which a surface escalates from naming the last
 * run's outcome to the coordination prompt. Normative value and the reasoning it
 * carries: docs/spec/MANAGED_EXCHANGE_RECORD.md, the `consecutiveMisses` row, and
 * docs/MANAGED_EXCHANGE.md, "Retry and repeated misses".
 */
export const REPEATED_MISS_ESCALATION = 2;

/** The largest instant an ECMAScript `Date` represents. The record's schema puts
 * no ceiling on `intervalDays` or `windowSeconds`, so a hand-edited or imported
 * schedule can place its next window past every calendar there is; `Intl` refuses
 * such a value rather than rendering it, which would take the whole list down over
 * one row. {@link scheduleDueness} reads that as its own state instead. */
const MAX_TIME_VALUE = 8.64e15;

/** Where the recurrence stands at an instant: a window open right now, the next
 * one ahead, or a lattice whose windows fall on no renderable calendar. The first
 * two carry their instants phrased in the operator's local display format. */
export type ScheduleDueness =
  | {
      state: "open";
      /** The open window's own open instant. */
      opensAt: string;
      /** The instant the open window closes. */
      closesAt: string;
    }
  | {
      state: "upcoming";
      /** The instant the next window opens. */
      opensAt: string;
    }
  | { state: "unreadable" };

/** An instant phrased for display, or `undefined` for one no calendar carries
 * (see {@link MAX_TIME_VALUE}). */
function phraseInstant(ms: number): string | undefined {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_VALUE
    ? dateTimeLabel(new Date(ms))
    : undefined;
}

/**
 * Where `schedule` stands at `now`, read off the recurrence lattice rather than
 * off the record's planned `nextWindow`: the plan is bookkeeping the runner
 * advances, so a browser that has not been running the schedule carries a stale
 * one, while the lattice states where the agreed windows really fall.
 *
 * @throws {RangeError} if the schedule's lattice is unusable -- an anchor that is
 *   not a UTC instant, or a period or width outside the record schema's bounds
 *   (see {@link managedScheduleWindow}).
 */
export function scheduleDueness(
  schedule: ManagedExchangeSchedule,
  now: number,
): ScheduleDueness {
  const upcoming = nextManagedScheduleWindowAfter(schedule, now);
  // The next window opens strictly after `now`, so the one before it is the only
  // window `now` can sit inside -- and before window 0 there is none to sit in.
  const current =
    upcoming.index > 0
      ? managedScheduleWindow(schedule, upcoming.index - 1)
      : undefined;
  if (
    current !== undefined &&
    managedScheduleWindowStateAt(current, now) === "open"
  ) {
    const opensAt = phraseInstant(current.opensAtMs);
    const closesAt = phraseInstant(current.closesAtMs);
    return opensAt !== undefined && closesAt !== undefined
      ? { state: "open", opensAt, closesAt }
      : { state: "unreadable" };
  }
  const opensAt = phraseInstant(upcoming.opensAtMs);
  return opensAt !== undefined
    ? { state: "upcoming", opensAt }
    : { state: "unreadable" };
}

/** The one-line phrasing of {@link scheduleDueness} both surfaces carry. It
 * states where the window is and promises no run: whether anything runs is the
 * operator's own visit, and the notes beside this line say so. */
export function scheduleDueLine(dueness: ScheduleDueness): string {
  if (dueness.state === "unreadable")
    return "This exchange's agreed schedule names no window on any calendar this can show; check it against the cadence you agreed with your partner.";
  return dueness.state === "open"
    ? `Run window open now, until ${dueness.closesAt}`
    : `Next run window: ${dueness.opensAt}`;
}

/** The agreed cadence in words: how often a window opens and how long it stays
 * open, both read straight off the record's own integers. */
export function scheduleCadenceLine(schedule: ManagedExchangeSchedule): string {
  const every =
    schedule.intervalDays === 1
      ? "every day"
      : `every ${schedule.intervalDays} days`;
  return `A run window opens ${every} and stays open ${lifetimeNoun(schedule.windowSeconds)}.`;
}

/** The escalated coordination state, phrased for both surfaces: the list's quiet
 * line and the detail view's prompt. */
export interface RepeatedMissCoordination {
  /** The consecutive-miss count the record carries, at or above
   * {@link REPEATED_MISS_ESCALATION}. */
  misses: number;
  /** The list's one-line form: the state and both checks, deferring the rest to
   * the exchange's own surface. */
  line: string;
  /** The detail view's coordination prompt. */
  prompt: string;
}

/** The title over the detail view's coordination prompt. It names the state, not
 * a fault: which side was absent is exactly what the record cannot know. */
export const REPEATED_MISS_TITLE = "Runs are not happening on schedule";

/**
 * The coordination state a run of missed windows earns, or `undefined` below the
 * escalation threshold -- a single miss is a laptop closed for the evening and
 * demands nothing, so nothing is said beyond the last run's own outcome.
 *
 * Both phrasings name BOTH checks, the partner and this device's own clock: a
 * clock that has drifted far enough produces exactly this pattern, and an
 * operator pointed only at their partner would never look at their own machine.
 * Neither phrasing offers to pause anything -- the surfaces escalate and the
 * agreed cadence stands (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they
 * do not auto-pause").
 */
export function repeatedMissCoordination(
  schedule: ManagedExchangeSchedule,
): RepeatedMissCoordination | undefined {
  const misses = schedule.consecutiveMisses;
  if (misses < REPEATED_MISS_ESCALATION) return undefined;
  return {
    misses,
    line: `${misses} agreed run windows in a row passed with no run; check with your partner, and check this device's clock.`,
    prompt: `${misses} agreed run windows in a row have passed with no run, which is what a partnership that has stopped meeting looks like. Check with your partner that they are still running this exchange, and check this device's own clock: a clock that has drifted puts your window where theirs never is, which produces exactly this pattern. Settle it where you agreed the schedule. Nothing here is paused or changed -- the agreed cadence stands, and the count clears the next time a run succeeds.`,
  };
}

/**
 * What this browser does with an agreed schedule, said wherever one is surfaced.
 *
 * It states the limit and the operator's move, and promises no run: a window that
 * arrives while nothing is open here is simply a window that passes, and the copy
 * must not read as an assurance that something attended to it.
 */
export const SCHEDULE_ATTENDANCE_NOTE =
  "A window that opens while this browser is closed passes without a run. Come back during a window and run this exchange to keep the partnership meeting.";

/**
 * The standing consequence of holding no pointer to the operator's input file: a
 * run cannot read it without them, so no window can be met with nobody present.
 * It points at the attended path -- choosing the file at the run itself -- which
 * is the run surface's own affordance.
 */
export const SCHEDULE_INPUT_RESELECTION_NOTE =
  "This browser holds no pointer to your input file, so no run of this exchange can happen with nobody present: reading it needs you to choose the file. Choose it here when you run this exchange, while a window is open.";
