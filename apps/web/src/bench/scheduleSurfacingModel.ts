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
 * fields are read verbatim -- `consecutiveMisses` as the record holds it -- so
 * nothing shown here anticipates a write the runner has not made.
 *
 * `now` is injected rather than read, matching the clock discipline of the managed
 * modules, so every derivation is a pure function of its inputs.
 */

import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_SECONDS,
} from "@psi/managedExchangeRecord";
import {
  MAX_TIME_VALUE,
  managedScheduleWindow,
  managedScheduleWindowStateAt,
  nextManagedScheduleWindowAfter,
} from "@psi/managedSchedule";

import { dateTimeLabel, lifetimeNoun } from "./inviterModel";

import type { ManagedExchangeSchedule } from "@psi/managedExchangeRecord";

/**
 * The consecutive-miss count at which a surface escalates from naming the last
 * run's outcome to the coordination prompt. Normative value and the reasoning
 * behind it: docs/spec/MANAGED_EXCHANGE_RECORD.md, the `consecutiveMisses` row,
 * and docs/MANAGED_EXCHANGE.md, "Retry and repeated misses".
 */
export const REPEATED_MISS_ESCALATION = 2;

/** Where the recurrence stands at an instant: a window open right now, or the
 * next one ahead. Both hold their instants phrased in the operator's local
 * display format. */
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
    };

/**
 * The widest span a window instant can sit past `now`: one full period plus one
 * full width, both at the record schema's ceiling. Every instant
 * {@link scheduleDueness} phrases lies inside it, since the window it names is
 * either the one containing `now` or the first one after it, so a `now` this far
 * inside the representable range guarantees a renderable window.
 */
const MAX_WINDOW_REACH_MS =
  MAX_SCHEDULE_INTERVAL_DAYS * 86_400_000 + MAX_SCHEDULE_WINDOW_SECONDS * 1000;

/**
 * Where `schedule` stands at `now`, read off the recurrence lattice rather
 * than the record's planned `nextWindow` (bookkeeping the runner advances,
 * which a browser that has not run the schedule holds stale). Every instant
 * returned is renderable: the record schema's `intervalDays` and
 * `windowSeconds` bound how far a window can fall past `now`, and the guard
 * below bounds `now` itself; scheduleSurfacingModel.test.ts sweeps both at
 * the schema's own ceilings.
 *
 * @throws {RangeError} if the schedule's lattice is unusable (an anchor not a
 *   UTC instant, or a period/width outside the record schema's bounds; see
 *   {@link managedScheduleWindow}), or if `now` sits too near the end of the
 *   representable instant range for the window it names to fall inside it.
 */
export function scheduleDueness(
  schedule: ManagedExchangeSchedule,
  now: number,
): ScheduleDueness {
  if (
    !Number.isFinite(now) ||
    Math.abs(now) > MAX_TIME_VALUE - MAX_WINDOW_REACH_MS
  )
    throw new RangeError(
      "managed schedule cannot be read at an instant this near the end of the representable range",
    );
  const upcoming = nextManagedScheduleWindowAfter(schedule, now);
  // The next window opens strictly after `now`, so the one before it is the only
  // window `now` can sit inside -- and before window 0 there is none to sit in.
  const current =
    upcoming.index > 0
      ? managedScheduleWindow(schedule, upcoming.index - 1)
      : undefined;
  return current !== undefined &&
    managedScheduleWindowStateAt(current, now) === "open"
    ? {
        state: "open",
        opensAt: dateTimeLabel(new Date(current.opensAtMs)),
        closesAt: dateTimeLabel(new Date(current.closesAtMs)),
      }
    : {
        state: "upcoming",
        opensAt: dateTimeLabel(new Date(upcoming.opensAtMs)),
      };
}

/** The one-line phrasing of {@link scheduleDueness} both surfaces hold. It
 * states where the window is and promises no run: whether anything runs is the
 * operator's own visit or this runtime's own attendance, and the notes beside
 * this line say which. */
export function scheduleDueLine(dueness: ScheduleDueness): string {
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
  /** The consecutive-miss count the record holds, at or above
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
 * The coordination state a run of missed windows earns, or `undefined` below
 * the escalation threshold (a single miss demands nothing beyond the last
 * run's own outcome). Both phrasings name BOTH checks, the partner and this
 * device's own clock, since a drifted clock produces exactly this pattern;
 * neither offers to pause anything -- the agreed cadence stands
 * (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they do not
 * auto-pause").
 */
export function repeatedMissCoordination(
  schedule: ManagedExchangeSchedule,
): RepeatedMissCoordination | undefined {
  const misses = schedule.consecutiveMisses;
  if (misses < REPEATED_MISS_ESCALATION) return undefined;
  return {
    misses,
    line: `${misses} scheduled runs in a row have not happened; check with your partner, and check this device's clock.`,
    prompt: `${misses} scheduled runs in a row have not happened. Ask your partner whether they are still running this exchange, and check this device's clock -- if it is wrong, your run window and theirs never overlap. Nothing has been paused: the schedule stands, and the count resets after a successful run.`,
  };
}

/**
 * What an INSTALLED app runtime does with an agreed schedule. The unattended
 * runner starts only there, so this is the one reading on which "runs on its own"
 * is a true statement -- and it stays bounded by what the runtime can promise: an
 * app that is not running when a window opens meets nothing, and a partner who
 * does not arrive leaves the window a benign miss.
 */
export const SCHEDULE_ATTENDANCE_NOTE_INSTALLED =
  "This app is installed, so it runs this exchange itself at each agreed window while it is open, with nobody present. A window that opens while the app is closed passes without a run, so leave it running (or launch it at sign-in) if you want the schedule met unattended.";

/**
 * What an ORDINARY browser tab does with an agreed schedule: nothing on its
 * own. States the limit and the operator's move -- a window that arrives
 * while nothing is open here simply passes, and the copy must not read as an
 * assurance that something attended to it -- and names the installed app as
 * the way out: stating a limit, not withholding a capability.
 */
export const SCHEDULE_ATTENDANCE_NOTE_TAB =
  "This is an ordinary browser tab, which never runs this exchange on its own: a window that opens passes without a run unless you run it here. Come back during a window and run this exchange, or install this app and leave it running to have it meet the windows for you.";

/**
 * The attendance note for the runtime the operator is actually looking at. The
 * two readings are different facts rather than different wordings of one -- the
 * unattended runner starts in the installed app and in nothing else -- so the
 * surfaces branch on the runtime rather than holding one hedged line for both
 * (docs/MANAGED_EXCHANGE.md, "The automation goal and its platform envelope").
 */
export function scheduleAttendanceNote(installedRuntime: boolean): string {
  return installedRuntime
    ? SCHEDULE_ATTENDANCE_NOTE_INSTALLED
    : SCHEDULE_ATTENDANCE_NOTE_TAB;
}

/**
 * The standing consequence of holding no pointer to the operator's input file: a
 * run cannot read it without them, so no window can be met with nobody present.
 * It points at the attended path -- choosing the file at the run itself -- which
 * is the run surface's own affordance.
 */
export const SCHEDULE_INPUT_RESELECTION_NOTE =
  "This browser holds no pointer to your input file, so no run of this exchange can happen with nobody present: reading it needs you to choose the file. Choose it here when you run this exchange, while a window is open.";
