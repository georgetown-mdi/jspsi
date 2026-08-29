/**
 * The pure model behind schedule entry: what the operator types for an agreed run
 * cadence, what is wrong with it, what it resolves to, and the one cross-field
 * problem a stored max-token-age policy raises against it.
 *
 * Entry is where the host time zone is READ. The operator agrees a wall-clock
 * cadence with their partner ("09:00 Tuesdays") and types it on their own clock;
 * {@link resolveLocalCadenceAnchor} turns that into the stored UTC anchor once,
 * here, and {@link localCadenceFromAnchor} reads it back when the form re-opens on
 * a stored schedule. Nothing downstream reads the zone again -- every window
 * afterwards is fixed-millisecond arithmetic off the anchor -- which is what keeps
 * a daylight-saving shift from moving an agreed window out from under one of the
 * two runners (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The schedule object").
 *
 * The bounds here are the record schema's, restated as field errors so an
 * out-of-range value fails at the field the operator can fix rather than as a
 * store-write failure after the click. The window-width FLOOR is the one bound
 * entry adds beyond the schema: width is the design's only clock-skew mitigation,
 * so a minutes-wide window would guarantee perpetual self-inflicted misses even
 * though the schema's structural floor admits it.
 *
 * `now` is injected rather than read, matching the clock discipline of the managed
 * modules, so every derivation is a pure function of its inputs.
 */

import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_SECONDS,
} from "@psi/managedExchangeRecord";
import {
  firstUnclosedManagedScheduleWindow,
  localCadenceFromAnchor,
  resolveLocalCadenceAnchor,
} from "@psi/managedSchedule";

import { dateTimeLabel } from "./inviterModel";

import type { ManagedExchangeSchedule } from "@psi/managedExchangeRecord";

/** Seconds in an hour, the unit the width is entered in: a several-hour window is
 * the intended range, so hours are what an operator agrees with their partner. */
const SECONDS_PER_HOUR = 3600;

/** The narrowest window entry accepts, in hours. The schema's structural floor is
 * one second; this is the UX-level floor the design requires, since width is the
 * only mitigation for the clock skew between two machines that never exchange a
 * clock reading (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Clock skew and the window
 * width"). */
export const MIN_SCHEDULE_WINDOW_HOURS = 1;

/** The widest window entry accepts, in hours -- the record schema's own ceiling,
 * restated in the unit the field uses. */
export const MAX_SCHEDULE_WINDOW_HOURS =
  MAX_SCHEDULE_WINDOW_SECONDS / SECONDS_PER_HOUR;

/** Re-exported beside the width bounds above so an entry component reads every
 * bound it enforces from one module, rather than half from the record schema. */
export { MAX_SCHEDULE_INTERVAL_DAYS };

/** The cadence as the operator types it. The two instants are strings because a
 * date or time input reports a partial value while it is being edited, and an
 * invalid state has to be representable so it can block the save rather than be
 * coerced into a cadence nobody agreed. */
export interface ScheduleEntryFields {
  /** The first agreed window's local calendar date, `YYYY-MM-DD`. */
  firstWindowDate: string;
  /** The first agreed window's local wall-clock time, `HH:MM` on a 24-hour
   * clock. */
  firstWindowTime: string;
  /** How often a window opens, in whole days; the string a cleared or partial
   * number input reports is carried as typed. */
  intervalDays: number | string;
  /** How long each window stays open, in whole hours; likewise carried as
   * typed. */
  windowHours: number | string;
}

/** The field errors an entry carries, keyed by the field that shows each one.
 * Empty when every field is usable. */
export interface ScheduleEntryErrors {
  firstWindowDate?: string;
  firstWindowTime?: string;
  intervalDays?: string;
  windowHours?: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/** The local calendar date a `YYYY-MM-DD` field names, or `undefined` for a value
 * that is not one. The calendar itself is checked by
 * {@link resolveLocalCadenceAnchor}, which owns the leap-year rule. */
function readDateFields(
  value: string,
): { year: number; month: number; day: number } | undefined {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** The local wall-clock time an `HH:MM` field names, or `undefined` for a value
 * that is not one. */
function readTimeFields(
  value: string,
): { hour: number; minute: number } | undefined {
  const match = TIME_PATTERN.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/** Whether a number field holds a number inside `[low, high]`. */
function withinRange(
  value: number | string,
  low: number,
  high: number,
): boolean {
  return typeof value === "number" && value >= low && value <= high;
}

/** Whether a number field holds a whole number inside `[low, high]`. */
function withinWholeRange(
  value: number | string,
  low: number,
  high: number,
): boolean {
  return withinRange(value, low, high) && Number.isInteger(value);
}

/** The width a stored schedule shows in the width field: the hours it is,
 * exactly. A width that is not a whole number of hours -- which the schema admits
 * and entry does not -- therefore displays as the fraction it is rather than as a
 * round number the operator would read as their partner's agreed width. */
function storedWindowHours(schedule: ManagedExchangeSchedule): number {
  return schedule.windowSeconds / SECONDS_PER_HOUR;
}

/** The date and time fields a stored UTC anchor reads back as on the operator's
 * own clock.
 *
 * @throws {RangeError} if the anchor is not a usable UTC instant. */
function anchorEntryFields(anchor: string): {
  firstWindowDate: string;
  firstWindowTime: string;
} {
  const cadence = localCadenceFromAnchor(anchor);
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  return {
    firstWindowDate: `${pad(cadence.year, 4)}-${pad(cadence.month, 2)}-${pad(cadence.day, 2)}`,
    firstWindowTime: `${pad(cadence.hour, 2)}:${pad(cadence.minute, 2)}`,
  };
}

/**
 * The stored width where the width field still shows exactly it, so a save that
 * edited some OTHER field carries the stored seconds through rather than
 * re-deriving them from a display value in hours.
 *
 * Without this, a stored width finer than the field's unit -- 5400 seconds from
 * an import or a hand-edited record -- would be rewritten to the hours it
 * displays as by an edit to the period alone, silently changing the width the
 * partnership agreed.
 *
 * It is also the exception {@link scheduleEntryErrors} reads: the value it
 * returns is one the operator inherited rather than entered, so entry's bounds
 * have nothing to hold it to.
 */
function carriedWindowSeconds(
  fields: ScheduleEntryFields,
  stored: ManagedExchangeSchedule | undefined,
): number | undefined {
  if (stored === undefined) return undefined;
  return fields.windowHours === storedWindowHours(stored)
    ? stored.windowSeconds
    : undefined;
}

/**
 * The stored anchor where the date and time fields still show exactly the wall
 * clock it reads back as, carried through for the same reason as the width: the
 * fields resolve only to the minute, so an anchor carrying seconds would be
 * rewritten by an edit to the period alone. It also keeps such an edit from
 * re-resolving a wall clock the operator's zone skips or repeats, which does not
 * round-trip (see {@link scheduleEntryUnchanged}).
 *
 * @throws {RangeError} if the stored anchor is not a usable UTC instant.
 */
function carriedAnchor(
  fields: ScheduleEntryFields,
  stored: ManagedExchangeSchedule | undefined,
): string | undefined {
  if (stored === undefined) return undefined;
  const shown = anchorEntryFields(stored.anchor);
  return shown.firstWindowDate === fields.firstWindowDate &&
    shown.firstWindowTime === fields.firstWindowTime
    ? stored.anchor
    : undefined;
}

/**
 * What is wrong with an entered cadence, field by field. An empty result means
 * every field is usable and {@link buildScheduleFromEntry} will resolve it.
 *
 * The date and time are checked together against the calendar, through the same
 * resolver the save uses, so a 29 February that the year does not have fails here
 * rather than at the write.
 *
 * `stored` is the schedule the form opened on, where there is one. A width it
 * carries stands as it is while the operator leaves it alone -- the save carries
 * those seconds through untouched, so there is nothing at that field to correct
 * -- while a width the operator CHANGES takes entry's bounds and the whole-hour
 * rule like any other entry. The exception covers the floor as well as the unit:
 * a width below the floor arrives only from an import or a hand-edited record,
 * and refusing it would block every OTHER edit the form makes -- a label, a
 * max-age policy -- on a value the operator never entered and this form will not
 * rewrite for them.
 */
export function scheduleEntryErrors(
  fields: ScheduleEntryFields,
  stored?: ManagedExchangeSchedule,
): ScheduleEntryErrors {
  const errors: ScheduleEntryErrors = {};
  const date = readDateFields(fields.firstWindowDate);
  const time = readTimeFields(fields.firstWindowTime);
  if (date === undefined)
    errors.firstWindowDate = "Choose the date of the first agreed run window.";
  if (time === undefined)
    errors.firstWindowTime =
      "Enter the time of day the window opens, as HH:MM.";
  if (date !== undefined && time !== undefined)
    try {
      resolveLocalCadenceAnchor({ ...date, ...time });
    } catch {
      errors.firstWindowDate =
        "That is not a date on the calendar. Choose the date of the first agreed run window.";
    }
  if (!withinWholeRange(fields.intervalDays, 1, MAX_SCHEDULE_INTERVAL_DAYS))
    errors.intervalDays = `Enter a whole number of days, 1 through ${String(MAX_SCHEDULE_INTERVAL_DAYS)}.`;
  const widthUsable =
    carriedWindowSeconds(fields, stored) !== undefined ||
    (withinRange(
      fields.windowHours,
      MIN_SCHEDULE_WINDOW_HOURS,
      MAX_SCHEDULE_WINDOW_HOURS,
    ) &&
      Number.isInteger(fields.windowHours));
  if (!widthUsable)
    errors.windowHours = `Enter a whole number of hours, ${String(MIN_SCHEDULE_WINDOW_HOURS)} through ${String(MAX_SCHEDULE_WINDOW_HOURS)}. A window this wide is what absorbs the clock difference between your machine and your partner's.`;
  return errors;
}

/** Whether an entry is usable as it stands, against the schedule the form opened
 * on where there is one (see {@link scheduleEntryErrors}). */
export function scheduleEntryUsable(
  fields: ScheduleEntryFields,
  stored?: ManagedExchangeSchedule,
): boolean {
  return Object.keys(scheduleEntryErrors(fields, stored)).length === 0;
}

/**
 * Resolve an entered cadence into the schedule the record stores: the local wall
 * clock resolved to the UTC `anchor` once, the period and width as whole
 * integers, and fresh bookkeeping.
 *
 * `nextWindow` is the first window that has not closed at `now` rather than the
 * anchor's own window, so a cadence anchored to a date already past does not hand
 * the catch-up walk a run of windows that elapsed before the operator agreed it
 * -- each of which it would count as a miss the partnership never had. The miss
 * count starts at zero for the same reason: an edited cadence is a new lattice,
 * and a count of windows on the old one says nothing about this one.
 *
 * `stored` is the schedule the form opened on, where there is one. The anchor and
 * the width are carried from it VERBATIM while the fields that display them are
 * untouched (see {@link carriedAnchor} and {@link carriedWindowSeconds}), so
 * editing one field of a cadence never rewrites another that the display fields
 * hold at a coarser resolution than the record does.
 *
 * @throws {RangeError} if any field is unusable (see
 *   {@link scheduleEntryErrors}), if the width does not resolve to the whole
 *   number of seconds the record stores, or if the resolved anchor falls outside
 *   the range a stored UTC instant carries.
 */
export function buildScheduleFromEntry(
  fields: ScheduleEntryFields,
  now: number,
  stored?: ManagedExchangeSchedule,
): ManagedExchangeSchedule {
  const date = readDateFields(fields.firstWindowDate);
  const time = readTimeFields(fields.firstWindowTime);
  if (
    date === undefined ||
    time === undefined ||
    typeof fields.intervalDays !== "number" ||
    typeof fields.windowHours !== "number"
  )
    throw new RangeError("managed schedule entry is not a usable cadence");
  const anchor =
    carriedAnchor(fields, stored) ??
    resolveLocalCadenceAnchor({ ...date, ...time });
  const windowSeconds =
    carriedWindowSeconds(fields, stored) ??
    fields.windowHours * SECONDS_PER_HOUR;
  // A width in hours that is not a whole number of seconds has no record to be
  // written to: the schema stores integer seconds, so it would surface as a
  // validation failure at the store write rather than here.
  if (!Number.isInteger(windowSeconds))
    throw new RangeError(
      "managed schedule entry width is not a whole number of seconds",
    );
  const lattice: ManagedExchangeSchedule = {
    anchor,
    intervalDays: fields.intervalDays,
    windowSeconds,
    nextWindow: anchor,
    consecutiveMisses: 0,
  };
  return {
    ...lattice,
    nextWindow: new Date(
      firstUnclosedManagedScheduleWindow(lattice, now).opensAtMs,
    ).toISOString(),
  };
}

/**
 * The entry fields a stored schedule re-opens as: the UTC anchor read back on the
 * operator's own clock, and the period and width in the units the fields use.
 *
 * A width the schema admits but entry does not (a stored schedule from an import,
 * or one entered before the floor existed) reads back as the EXACT hours it is,
 * fractional where its seconds are not a whole hour, so the form shows what the
 * partnership agreed rather than a rounded value the operator would take for it.
 * It stands while the operator leaves it alone -- below entry's floor as much as
 * merely finer than the field's unit ({@link scheduleEntryErrors}) -- and the
 * save carries its seconds through untouched ({@link buildScheduleFromEntry}).
 *
 * The anchor is read back only to the minute, which is the resolution the fields
 * carry; a stored anchor finer than that is likewise carried through rather than
 * re-resolved from the reading.
 *
 * @throws {RangeError} if the stored anchor is not a usable UTC instant.
 */
export function scheduleEntryFieldsFrom(
  schedule: ManagedExchangeSchedule,
): ScheduleEntryFields {
  return {
    ...anchorEntryFields(schedule.anchor),
    intervalDays: schedule.intervalDays,
    windowHours: storedWindowHours(schedule),
  };
}

/**
 * Whether an entry still says exactly what a stored schedule does, so a save that
 * touched only the label or the max-age policy carries the stored schedule
 * VERBATIM instead of rebuilding it.
 *
 * What rests on this is the schedule's bookkeeping: the planned window and the
 * consecutive-miss count belong to the runner, and rebuilding a cadence nobody
 * edited would reset both. The agreed instant itself is held either way -- a
 * cadence field the operator did not touch is carried through verbatim even on a
 * save that edited another (see {@link buildScheduleFromEntry}), so a wall clock
 * the operator's zone repeats or skips, which does not round-trip through the
 * local reading, is never re-resolved off that reading
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `anchor` row).
 */
export function scheduleEntryUnchanged(
  fields: ScheduleEntryFields,
  schedule: ManagedExchangeSchedule,
): boolean {
  const stored = scheduleEntryFieldsFrom(schedule);
  return (
    fields.firstWindowDate === stored.firstWindowDate &&
    fields.firstWindowTime === stored.firstWindowTime &&
    fields.intervalDays === stored.intervalDays &&
    fields.windowHours === stored.windowHours
  );
}

/** The cadence an entry form opens on when no schedule is stored: a weekly window
 * three hours wide, starting at the top of the hour after `now` on the operator's
 * own clock. It is a starting point to edit against the cadence the partnership
 * agreed, never a default anything runs on -- entry is opt-in, and nothing is
 * written until the operator saves. */
export function defaultScheduleEntryFields(now: number): ScheduleEntryFields {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return {
    ...scheduleEntryFieldsFrom({
      anchor: start.toISOString(),
      intervalDays: 7,
      windowSeconds: 3 * SECONDS_PER_HOUR,
      nextWindow: start.toISOString(),
      consecutiveMisses: 0,
    }),
  };
}

/**
 * The UTC instant an entered cadence resolves to, phrased for display, or
 * `undefined` while the cadence is not usable.
 *
 * It is shown back because the resolution is not always the identity an operator
 * expects: a wall-clock time their zone skips or repeats across a daylight-saving
 * transition resolves to an instant naming a different wall clock, and the
 * partnership agreed an instant rather than a string (see
 * {@link resolveLocalCadenceAnchor}).
 */
export function resolvedFirstWindowLabel(
  fields: ScheduleEntryFields,
): string | undefined {
  const date = readDateFields(fields.firstWindowDate);
  const time = readTimeFields(fields.firstWindowTime);
  if (date === undefined || time === undefined) return undefined;
  try {
    return dateTimeLabel(
      new Date(resolveLocalCadenceAnchor({ ...date, ...time })),
    );
  } catch {
    return undefined;
  }
}

/**
 * The problem an entered cadence raises against an opted-in max-token-age policy,
 * or `undefined` when the two are compatible (which includes every exchange with
 * no policy set -- the default).
 *
 * A successful run restamps the bound to `tokenMaxAgeDays` past the run, and the
 * next chance to run is one `intervalDays` later, so a cadence at or past the
 * bound lapses the stored secret before the window that would have refreshed it:
 * the partnership stops on a lapsed secret rather than on anything either party
 * did, and recovery is a re-invite. Surfaced rather than refused -- an operator
 * who renews by hand is entitled to that cadence -- but never silently accepted.
 */
export function cadenceAgainstTokenBound(
  intervalDays: number | string,
  tokenMaxAgeDays: number | undefined,
): string | undefined {
  if (tokenMaxAgeDays === undefined || typeof intervalDays !== "number")
    return undefined;
  if (intervalDays < tokenMaxAgeDays) return undefined;
  const bound =
    tokenMaxAgeDays === 1 ? "1 day" : `${String(tokenMaxAgeDays)} days`;
  const cadence =
    intervalDays === 1 ? "every day" : `every ${String(intervalDays)} days`;
  return `This exchange must run or be renewed within ${bound}, but a run window opens only ${cadence}. The stored secret lapses before the next window arrives, and recovering it means re-inviting your partner. Shorten the cadence, or lengthen the maximum age above it.`;
}
