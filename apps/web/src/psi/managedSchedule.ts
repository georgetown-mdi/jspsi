/**
 * The managed exchange's schedule arithmetic: where a recurrence's run windows
 * fall, which window an instant sits in, and the catch-up and advance rules that
 * move `nextWindow` and `consecutiveMisses`. The normative rules -- the field
 * layout, the catch-up rule, and the `consecutiveMisses` outcome table -- are in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The schedule object" and "Catch-up on
 * wake"; this module implements them and the checks below carry only the
 * constraints the code shows.
 *
 * Every instant here is UTC milliseconds computed from the record's stored-UTC
 * `anchor` and its whole-day integer period, so window n opens at `anchor + n *
 * intervalDays` in fixed milliseconds and never by a local-calendar date add. A
 * calendar add shifts the instant by the offset change across a daylight-saving
 * transition, which would move an unattended window by an hour on one machine
 * and not the other -- two runners that no longer overlap, recorded as mutual
 * misses. Nothing below reads the host zone: the operator's local wall-clock
 * cadence is resolved to the UTC anchor exactly once, by
 * {@link resolveLocalCadenceAnchor} at save and again only when the operator
 * edits the schedule. Every other instant must carry the UTC designator to be
 * read at all -- {@link ./managedExchangeRecord.ts}'s `parseStoredInstant`
 * requires it rather than assuming it -- so the claim holds for a hand-edited or
 * tampered record too, not only for one the record schema validated.
 *
 * `now` is injected rather than read, matching the clock discipline of the rest
 * of the managed modules, so every rule here is a pure function of its inputs.
 */

import { parseStoredInstant } from "./managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRunOutcome,
  ManagedExchangeSchedule,
} from "./managedExchangeRecord";

/** Milliseconds in a day, matching {@link ./managedRunRotate.ts}'s `MS_PER_DAY`:
 * the recurrence period is a whole number of these, never a calendar day. */
const MS_PER_DAY = 86_400_000;

const MS_PER_SECOND = 1000;

/** The largest instant an ECMAScript `Date` represents; a value outside it is
 * not a clock reading at all. */
const MAX_TIME_VALUE = 8.64e15;

/** The instants a stored UTC instant carries: the record's validator admits a
 * four-digit year alone, so anything before year 0 or after year 9999 has only
 * the expanded-year ISO rendering (`+010000-01-01T00:00:00.000Z`) the schema
 * refuses (see {@link ./managedExchangeRecord.ts}'s `scheduleSchema`). An
 * instant this module computes is destined for `anchor` or `nextWindow`, so one
 * outside the pair is refused where it would be rendered rather than surfacing
 * as a validation failure at the write. */
const MIN_STORED_INSTANT_MS = -62_167_219_200_000;
const MAX_STORED_INSTANT_MS = 253_402_300_799_999;

/** The most windows one catch-up walks before refusing the record. The walk
 * crosses one window per elapsed period, so the daily cadence -- the shortest
 * the schema admits -- reaches this only after some 2,700 years dormant: no
 * cadence an operator entered arrives here, while an anchor a hand edit or a
 * tampered artifact placed at the far end of the representable range does. The
 * bound keeps a wake's cost tied to how long the runner really slept rather than
 * to the anchor the record carries. */
const MAX_CATCH_UP_WINDOWS = 1_000_000;

/** A single run window on the recurrence lattice, in UTC milliseconds. */
export interface ManagedScheduleWindow {
  /** Zero-based recurrence index counted from the anchor: window 0 opens at the
   * anchor itself. */
  index: number;
  /** The window's open instant, UTC milliseconds. */
  opensAtMs: number;
  /** The window's close instant, UTC milliseconds, EXCLUSIVE: the window is the
   * half-open interval `[opensAtMs, closesAtMs)`, so an instant exactly at the
   * close belongs to no window and the window counts as elapsed there. */
  closesAtMs: number;
}

/** Where an instant sits relative to a window: `"before"` it opens, `"open"`
 * inside it, `"elapsed"` at or after its close. */
export type ManagedScheduleWindowState = "before" | "open" | "elapsed";

/**
 * What a window's occupancy produced, as the advance rules read it. The run
 * outcomes are the record's own closed enum; `"unattempted"` is the extra case
 * the record deliberately cannot hold -- a window this runner never attempted,
 * because the single-writer lock was held elsewhere -- which advances the
 * schedule past the window while recording neither an attempt nor a miss.
 */
export type ManagedScheduleWindowDisposition =
  ManagedExchangeRunOutcome | "unattempted";

/** The schedule state a wake computes, ready for one atomic bookkeeping write. */
export interface ManagedScheduleCatchUp {
  /** The schedule with `nextWindow` advanced to the first window not yet closed
   * (past a window a recorded success already satisfied) and
   * `consecutiveMisses` carrying each window's verdict, applied in order. */
  schedule: ManagedExchangeSchedule;
  /** The `nextWindow` this walk read, echoed verbatim: the bookkeeping write
   * applies the result only while the record still plans that window, so a walk
   * whose write lands behind a newer one's is dropped rather than rewinding it
   * (see {@link ./managedExchangeRecord.ts}'s
   * `applyManagedExchangeScheduleAdvance`). */
  fromNextWindow: string;
  /** The `consecutiveMisses` this walk read, echoed verbatim and conditioned on
   * by the same write: an operator who cleared the count while the window ran
   * must not have it restored by a walk that counted from the old one. */
  fromConsecutiveMisses: number;
  /** How many fully-elapsed windows passed unattempted -- one miss each,
   * whichever side was absent. Zero when the wake found nothing elapsed. */
  missedWindows: number;
  /** The window to attempt immediately: the first window not yet closed, when
   * `now` falls inside it and no recorded success has already satisfied it.
   * Absent when that window has not opened yet. */
  dueWindow?: ManagedScheduleWindow;
  /** The `"missed"` bookkeeping the most recent elapsed window earns, stamped at
   * that window's close. Absent when no window elapsed, or when the most recent
   * elapsed one carries a recorded run whose own bookkeeping stands. A run
   * recorded in a LATER window that is still open leaves the stamp in place --
   * the elapsed window really was missed -- and the write path holds `lastRun`
   * monotonic on `at` rather than the wake second-guessing which entry is newer
   * (see `applyManagedExchangeScheduleAdvance`). */
  missedLastRun?: ManagedExchangeLastRun;
}

/**
 * An operator's cadence as they enter it: a calendar date and wall-clock time of
 * day in the host's own zone, which {@link resolveLocalCadenceAnchor} resolves to
 * the stored UTC anchor. A weekly "09:00 Tuesdays" is a Tuesday's date here plus
 * an `intervalDays` of 7 -- the recurrence carries no weekday of its own.
 */
export interface LocalWallClockCadence {
  /** Local calendar year of the first agreed window (1 through 9999). */
  year: number;
  /** Local calendar month of the first agreed window, 1 through 12. */
  month: number;
  /** Local calendar day of the first agreed window, 1 through the month's
   * length. */
  day: number;
  /** Local wall-clock hour the window opens, 0 through 23. */
  hour: number;
  /** Local wall-clock minute the window opens, 0 through 59. */
  minute: number;
}

/** The recurrence lattice a schedule defines, reduced to milliseconds once so
 * every rule below is integer arithmetic. */
interface ScheduleGeometry {
  anchorMs: number;
  periodMs: number;
  widthMs: number;
}

function parseScheduleInstant(value: string, field: string): number {
  const parsed = parseStoredInstant(value);
  if (Number.isNaN(parsed))
    throw new RangeError(
      `managed schedule ${field} is not a usable UTC instant`,
    );
  return parsed;
}

function toScheduleInstant(ms: number): string {
  if (
    !Number.isFinite(ms) ||
    ms < MIN_STORED_INSTANT_MS ||
    ms > MAX_STORED_INSTANT_MS
  )
    throw new RangeError(
      "managed schedule instant falls outside the range a stored UTC instant carries",
    );
  return new Date(ms).toISOString();
}

/**
 * Reduce a schedule to its lattice, rejecting a period or width the record's
 * schema would not admit. The schema is the first line of defense
 * (`intervalDays` and `windowSeconds` at least 1, both integers), so this
 * repeats it where the division happens: a zero period would divide to
 * `Infinity` and an unparseable anchor to `NaN`, either of which would silently
 * carry a nonsense instant into the bookkeeping write instead of aborting it.
 */
function readScheduleGeometry(
  schedule: ManagedExchangeSchedule,
): ScheduleGeometry {
  if (!Number.isInteger(schedule.intervalDays) || schedule.intervalDays < 1)
    throw new RangeError(
      "managed schedule intervalDays must be a whole number of days, at least 1",
    );
  if (!Number.isInteger(schedule.windowSeconds) || schedule.windowSeconds < 1)
    throw new RangeError(
      "managed schedule windowSeconds must be a whole number of seconds, at least 1",
    );
  return {
    anchorMs: parseScheduleInstant(schedule.anchor, "anchor"),
    periodMs: schedule.intervalDays * MS_PER_DAY,
    widthMs: schedule.windowSeconds * MS_PER_SECOND,
  };
}

function windowAt(
  geometry: ScheduleGeometry,
  index: number,
): ManagedScheduleWindow {
  const opensAtMs = geometry.anchorMs + index * geometry.periodMs;
  return { index, opensAtMs, closesAtMs: opensAtMs + geometry.widthMs };
}

/** The index of the window containing `atMs`, or `undefined` when the instant
 * falls before the first window or in the gap after one closed. */
function windowIndexContaining(
  geometry: ScheduleGeometry,
  atMs: number,
): number | undefined {
  if (Number.isNaN(atMs)) return undefined;
  const index = Math.floor((atMs - geometry.anchorMs) / geometry.periodMs);
  if (index < 0) return undefined;
  return atMs < windowAt(geometry, index).closesAtMs ? index : undefined;
}

/**
 * The run window at a zero-based recurrence index: window 0 opens at the anchor
 * and window n opens `n * intervalDays` later, in fixed milliseconds.
 *
 * @throws {RangeError} if the schedule's anchor is not a usable UTC instant or
 *   its period or width is not the whole positive number the schema requires.
 */
export function managedScheduleWindow(
  schedule: ManagedExchangeSchedule,
  index: number,
): ManagedScheduleWindow {
  return windowAt(readScheduleGeometry(schedule), index);
}

/** Where `atMs` sits relative to `window`, reading the window as the half-open
 * interval `[opensAtMs, closesAtMs)`. */
export function managedScheduleWindowStateAt(
  window: ManagedScheduleWindow,
  atMs: number,
): ManagedScheduleWindowState {
  if (atMs < window.opensAtMs) return "before";
  return atMs < window.closesAtMs ? "open" : "elapsed";
}

/**
 * The first window that opens strictly after `atMs`, never earlier than window 0.
 * An instant exactly at a window's open therefore yields the FOLLOWING window,
 * which is what an advance past a window just occupied wants.
 *
 * @throws {RangeError} if the schedule's lattice is unusable (see
 *   {@link managedScheduleWindow}).
 */
export function nextManagedScheduleWindowAfter(
  schedule: ManagedExchangeSchedule,
  atMs: number,
): ManagedScheduleWindow {
  const geometry = readScheduleGeometry(schedule);
  const index = Math.max(
    0,
    Math.floor((atMs - geometry.anchorMs) / geometry.periodMs) + 1,
  );
  return windowAt(geometry, index);
}

/**
 * The `consecutiveMisses` a window's disposition leaves behind, per the spec's
 * outcome table: a success resets the count, a miss increments it, and every
 * other disposition leaves it untouched -- a handshake that ran and failed means
 * the two runners DID meet, so it is a desync question rather than a
 * coordination-drift one, and a window this runner never attempted is neither.
 */
export function nextConsecutiveMisses(
  consecutiveMisses: number,
  disposition: ManagedScheduleWindowDisposition,
): number {
  if (disposition === "succeeded") return 0;
  if (disposition === "missed") return consecutiveMisses + 1;
  return consecutiveMisses;
}

/**
 * Advance the schedule past a window the runner has finished with: `nextWindow`
 * becomes the following window's open, and `consecutiveMisses` takes the
 * disposition's verdict (see {@link nextConsecutiveMisses}). The anchor, period,
 * and width are carried through untouched -- an advance is bookkeeping, never a
 * reschedule -- and the input schedule is not mutated.
 *
 * The occupied window positions the advance by its `index` alone, so the instant
 * written is re-derived on the schedule's own lattice rather than measured off
 * the window handed in.
 *
 * @throws {RangeError} if the schedule's lattice is unusable or the following
 *   window falls outside the range a stored UTC instant carries.
 */
export function advanceManagedScheduleAfterWindow(
  schedule: ManagedExchangeSchedule,
  window: ManagedScheduleWindow,
  disposition: ManagedScheduleWindowDisposition,
): ManagedExchangeSchedule {
  const geometry = readScheduleGeometry(schedule);
  return {
    ...schedule,
    nextWindow: toScheduleInstant(
      windowAt(geometry, window.index + 1).opensAtMs,
    ),
    consecutiveMisses: nextConsecutiveMisses(
      schedule.consecutiveMisses,
      disposition,
    ),
  };
}

/**
 * Apply the catch-up rule at a wake: walk forward from the window the stored
 * `nextWindow` plans, one window at a time, until the walk stands on a window
 * still live; advance `nextWindow` onto that window and report whether it is
 * open right now. This is the rule a runtime applies before attempting anything
 * -- on the ordinary wake and, with a restored backup's stale `nextWindow`, on
 * the first wake after an import.
 *
 * Every window is read the same way, and `consecutiveMisses` takes its verdict
 * through {@link nextConsecutiveMisses} once per window, in order: an elapsed
 * window with no run recorded inside it is one miss, an elapsed window that
 * carries one takes that run's own outcome, and a window still open whose run
 * SUCCEEDED is satisfied -- advanced past without an attempt, so an attended run
 * inside an agreed window is not re-run by the schedule -- while a window still
 * open that no success discharged is the one to attempt, leaving the rest of it
 * available. Applying the rule per window rather than to the whole span at once
 * is what keeps a success anywhere in the run resetting the count the windows
 * before it built, wherever that success sits.
 *
 * The walk is as long as the run of windows real time crossed since the last
 * wake, one cheap iteration each; a span longer than `MAX_CATCH_UP_WINDOWS` is
 * refused rather than walked.
 *
 * `lastRun` is read as evidence, never validated: an entry whose `at` is not a
 * UTC instant -- unparseable, or carrying no designator to read it against -- is
 * treated as no recorded run at all, the conservative direction (an extra miss
 * counted, never a miss suppressed). An entry stamped AHEAD of the wake instant
 * is read the same way and discharges nothing: a stamp in the future is a
 * forward-skewed clock or an edited record rather than a window met, so the
 * window it names stays planned, and stays due once open. That defers the
 * verdict to a later wake instead of counting a miss on the spot -- the walk
 * never suppresses a window's accounting on evidence it cannot stand behind.
 *
 * @param schedule The stored schedule, whose `nextWindow` is the first window
 *   not yet accounted for.
 * @param lastRun The record's run bookkeeping, if any.
 * @param nowMs The wake instant, UTC milliseconds.
 * @throws {RangeError} if the schedule's lattice is unusable, if the wake
 *   instant is not a representable one, if the resumed window falls outside the
 *   range a stored UTC instant carries, or if the span from `nextWindow` to the
 *   wake exceeds the walk's bound.
 */
export function catchUpManagedSchedule(
  schedule: ManagedExchangeSchedule,
  lastRun: ManagedExchangeLastRun | undefined,
  nowMs: number,
): ManagedScheduleCatchUp {
  // The walk reads the wake instant against one window at a time, so a wake
  // instant that is not a real one would make every window read as elapsed and
  // the walk run away rather than land anywhere.
  if (!Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_TIME_VALUE)
    throw new RangeError(
      "managed schedule wake instant falls outside the representable instant range",
    );
  const geometry = readScheduleGeometry(schedule);
  const plannedMs = parseScheduleInstant(schedule.nextWindow, "nextWindow");

  // The first window the bookkeeping has not accounted for. Rounding UP off a
  // `nextWindow` that does not sit on the lattice -- a hand-edited record, or a
  // backup restored beside a since-edited cadence -- keeps catch-up from
  // re-counting a window the stored instant already covers.
  const firstUnaccounted = Math.max(
    0,
    Math.ceil((plannedMs - geometry.anchorMs) / geometry.periodMs),
  );
  // The one window the recorded run speaks for. A run whose stamp does not
  // parse, that landed in the gap between two windows, or that is stamped ahead
  // of the wake speaks for none.
  const recordedMs =
    lastRun === undefined ? Number.NaN : parseStoredInstant(lastRun.at);
  const recordedIndex =
    recordedMs > nowMs
      ? undefined
      : windowIndexContaining(geometry, recordedMs);

  let consecutiveMisses = schedule.consecutiveMisses;
  let missedWindows = 0;
  // The close of the most recent elapsed window that passed unattempted, cleared
  // by a later elapsed window whose own recorded bookkeeping stands instead.
  let missedCloseMs: number | undefined;
  let dueWindow: ManagedScheduleWindow | undefined;
  let resume = windowAt(geometry, firstUnaccounted);

  for (;;) {
    const state = managedScheduleWindowStateAt(resume, nowMs);
    const recorded = resume.index === recordedIndex ? lastRun : undefined;
    if (state === "before") break;
    if (state === "open" && recorded?.outcome !== "succeeded") {
      dueWindow = resume;
      break;
    }
    if (state === "elapsed") {
      if (recorded === undefined) {
        missedWindows += 1;
        missedCloseMs = resume.closesAtMs;
      } else missedCloseMs = undefined;
    }
    consecutiveMisses = nextConsecutiveMisses(
      consecutiveMisses,
      recorded?.outcome ?? "missed",
    );
    if (resume.index - firstUnaccounted >= MAX_CATCH_UP_WINDOWS)
      throw new RangeError(
        "managed schedule catch-up spans more windows than a usable record holds",
      );
    resume = windowAt(geometry, resume.index + 1);
  }

  return {
    schedule: {
      ...schedule,
      nextWindow: toScheduleInstant(resume.opensAtMs),
      consecutiveMisses,
    },
    fromNextWindow: schedule.nextWindow,
    fromConsecutiveMisses: schedule.consecutiveMisses,
    missedWindows,
    ...(dueWindow !== undefined ? { dueWindow } : {}),
    ...(missedCloseMs !== undefined
      ? {
          missedLastRun: {
            at: toScheduleInstant(missedCloseMs),
            outcome: "missed" as const,
          },
        }
      : {}),
  };
}

/**
 * Resolve an operator's local wall-clock cadence to the UTC anchor the record
 * stores. This is the ONE place the host's zone is read: it runs at save and
 * again only when the operator edits the schedule, so a daylight-saving shift
 * between two windows moves neither of them -- the stored anchor fixes the
 * instant, and a cadence entered as "09:00" reads an hour differently on the
 * local clock after a transition rather than silently sliding the agreed window
 * away from the partner's.
 *
 * A wall-clock time the local zone skips (the hour a spring-forward transition
 * removes) has no instant to resolve to; the platform maps it forward into the
 * post-transition offset, which the entry surface shows back as the resolved
 * instant.
 *
 * @throws {RangeError} if a component is out of range, if it names a date the
 *   calendar does not have, or if the local resolution falls outside the range a
 *   stored UTC instant carries: a late-December year-9999 cadence in a zone
 *   behind UTC resolves into year 10000, which has only the expanded-year ISO
 *   form the record's validator refuses.
 */
export function resolveLocalCadenceAnchor(
  cadence: LocalWallClockCadence,
): string {
  requireComponentInRange(cadence.year, 1, 9999, "year");
  requireComponentInRange(cadence.month, 1, 12, "month");
  requireComponentInRange(cadence.day, 1, 31, "day");
  requireComponentInRange(cadence.hour, 0, 23, "hour");
  requireComponentInRange(cadence.minute, 0, 59, "minute");
  // Validate the calendar date in UTC, where no zone rule can shift the day the
  // check reads back, before the local resolution below interprets it. The
  // fields are SET rather than passed to `Date.UTC`, whose two-digit year
  // mapping would read year 26 as 1926 and reject 29 February 2026 on 1926's
  // calendar.
  const calendar = new Date(0);
  calendar.setUTCFullYear(cadence.year, cadence.month - 1, cadence.day);
  if (
    calendar.getUTCFullYear() !== cadence.year ||
    calendar.getUTCMonth() !== cadence.month - 1 ||
    calendar.getUTCDate() !== cadence.day
  )
    throw new RangeError(
      "managed schedule cadence names a date the calendar does not have",
    );

  const resolved = new Date(0);
  resolved.setFullYear(cadence.year, cadence.month - 1, cadence.day);
  resolved.setHours(cadence.hour, cadence.minute, 0, 0);
  return toScheduleInstant(resolved.getTime());
}

function requireComponentInRange(
  value: number,
  low: number,
  high: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new RangeError(
      `managed schedule cadence ${field} must be a whole number between ${low} and ${high}`,
    );
}
