import { describe, expect, test } from "vitest";

import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_SECONDS,
  scheduleSchema,
} from "@psi/managedExchangeRecord";
import { MAX_TIME_VALUE, nextConsecutiveMisses } from "@psi/managedSchedule";
import {
  REPEATED_MISS_ESCALATION,
  repeatedMissCoordination,
  scheduleAttendanceNote,
  scheduleCadenceLine,
  scheduleDueLine,
  scheduleDueness,
} from "@recurring/scheduleSurfacingModel";
import { withTimeZone } from "../utils/hostTimeZone";

import type { ManagedExchangeSchedule } from "@psi/managedExchangeRecord";
import type { ScheduleDueness } from "@recurring/scheduleSurfacingModel";

// The schedule's display derivation in Node, with the clock injected: where
// the recurrence stands at an instant, the cadence in words, and the
// coordination state a run of missed windows earns. Every window instant
// comes from the schedule arithmetic in @psi/managedSchedule, read off the
// lattice rather than the record's planned `nextWindow`, with the agreed
// instant held across a daylight-saving transition.

/** Anchor 2026-01-06T14:00Z, weekly, a three-hour window: window n opens
 * `2026-01-06 + 7n` at 14:00Z and closes at 17:00Z. */
const weekly: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-06T14:00:00.000Z",
  consecutiveMisses: 0,
};

function at(instant: string): number {
  return Date.parse(instant);
}

/** Read the schedule at `instant` with the host zone pinned to UTC, so an exact
 * rendered label is the same on every machine the suite runs on. The zone the
 * render really reads is driven under "daylight saving" below. */
function readAtUtc(
  schedule: ManagedExchangeSchedule,
  instant: string,
): ScheduleDueness {
  return withTimeZone("UTC", () => scheduleDueness(schedule, at(instant)));
}

/** The window instants a reading holds: both for an open window, the open alone
 * for one still ahead. */
function windowInstants(dueness: ScheduleDueness): {
  opensAt: string;
  closesAt?: string;
} {
  return dueness.state === "open"
    ? { opensAt: dueness.opensAt, closesAt: dueness.closesAt }
    : { opensAt: dueness.opensAt };
}

describe("where the recurrence stands", () => {
  test("before the first window, the anchor's own window is the one named", () => {
    const dueness = readAtUtc(weekly, "2026-01-01T00:00:00.000Z");
    expect(dueness.state).toBe("upcoming");
    expect(windowInstants(dueness).opensAt).toMatch(
      /January 6, 2026.*2:00 PM UTC/,
    );
    expect(scheduleDueLine(dueness)).toMatch(/^Next run window: January 6, /);
  });

  test("inside a window is treated as open and names when it closes", () => {
    const dueness = readAtUtc(weekly, "2026-01-06T15:30:00.000Z");
    expect(dueness.state).toBe("open");
    expect(windowInstants(dueness).closesAt).toMatch(
      /January 6, 2026.*5:00 PM UTC/,
    );
    expect(scheduleDueLine(dueness)).toMatch(
      /^Run window open now, until January 6, /,
    );
  });

  test("the open instant itself is inside the window", () => {
    // The window is the half-open interval [opens, closes), so its own open
    // instant is the first moment a run is due rather than the last before it.
    expect(readAtUtc(weekly, "2026-01-06T14:00:00.000Z").state).toBe("open");
  });

  test("the close instant is past the window, and the next one is named", () => {
    const dueness = readAtUtc(weekly, "2026-01-06T17:00:00.000Z");
    expect(dueness.state).toBe("upcoming");
    expect(windowInstants(dueness).opensAt).toMatch(
      /January 13, 2026.*2:00 PM UTC/,
    );
  });

  test("a window that elapsed unattended names the next window, never the one that passed", () => {
    // The state a browser that was closed through an agreed window comes back to:
    // the window is gone, and what the operator can still act on is the next one.
    const dueness = readAtUtc(weekly, "2026-01-09T09:00:00.000Z");
    expect(dueness.state).toBe("upcoming");
    expect(windowInstants(dueness).opensAt).toMatch(
      /January 13, 2026.*2:00 PM UTC/,
    );
  });

  test("the reading is the lattice's, not the record's planned window", () => {
    // `nextWindow` is bookkeeping a runner advances, so a browser that has never
    // run the schedule holds a stale one. The surfaces must still name the
    // window that is really open rather than the one the record last planned.
    const stale: ManagedExchangeSchedule = {
      ...weekly,
      nextWindow: "2026-01-06T14:00:00.000Z",
    };
    const dueness = readAtUtc(stale, "2026-02-03T15:00:00.000Z");
    expect(dueness.state).toBe("open");
    expect(scheduleDueLine(dueness)).not.toMatch(/January/);
  });
});

describe("daylight saving", () => {
  // 2026 US daylight saving starts on 8 March, so an anchor on 3 March and the
  // window a week later straddle the transition.
  const march: ManagedExchangeSchedule = {
    anchor: "2026-03-03T14:00:00.000Z",
    intervalDays: 7,
    windowSeconds: 10_800,
    nextWindow: "2026-03-03T14:00:00.000Z",
    consecutiveMisses: 0,
  };

  test("a window across a transition holds its instant and moves on the wall clock", () => {
    withTimeZone("America/New_York", () => {
      const before = scheduleDueness(march, at("2026-03-01T00:00:00.000Z"));
      const after = scheduleDueness(march, at("2026-03-09T00:00:00.000Z"));
      // The span really does cross a transition in the pinned zone, so nothing
      // below passes vacuously on a machine that never shifts.
      expect(
        new Date(at("2026-03-03T14:00:00.000Z")).getTimezoneOffset(),
      ).not.toBe(new Date(at("2026-03-10T14:00:00.000Z")).getTimezoneOffset());

      // A local-calendar date add would have held 9:00 AM and moved the agreed
      // instant an hour; the render holds the instant and moves the wall clock.
      expect(windowInstants(before).opensAt).toMatch(
        /March 3, 2026.*9:00 AM EST/,
      );
      expect(windowInstants(after).opensAt).toMatch(
        /March 10, 2026.*10:00 AM EDT/,
      );
    });
  });

  test("the same instant renders on the operator's own clock, whichever it is", () => {
    const utc = withTimeZone("UTC", () =>
      scheduleDueness(march, at("2026-03-09T00:00:00.000Z")),
    );
    const eastern = withTimeZone("America/New_York", () =>
      scheduleDueness(march, at("2026-03-09T00:00:00.000Z")),
    );
    expect(windowInstants(utc).opensAt).toMatch(/March 10, 2026.*2:00 PM UTC/);
    expect(windowInstants(eastern).opensAt).toMatch(
      /March 10, 2026.*10:00 AM EDT/,
    );
  });
});

describe("repeated-miss coordination", () => {
  function withMisses(consecutiveMisses: number): ManagedExchangeSchedule {
    return { ...weekly, consecutiveMisses };
  }

  test("no miss at all says nothing", () => {
    expect(repeatedMissCoordination(withMisses(0))).toBeUndefined();
  });

  test("one miss is below the threshold and says nothing", () => {
    // A laptop closed for the evening: unremarkable, and the last run's own
    // outcome is all the list says about it.
    expect(REPEATED_MISS_ESCALATION).toBe(2);
    expect(repeatedMissCoordination(withMisses(1))).toBeUndefined();
  });

  test("the second consecutive miss escalates, naming its count", () => {
    const coordination = repeatedMissCoordination(withMisses(2));
    expect(coordination?.misses).toBe(2);
    expect(coordination?.line).toMatch(/^2 scheduled runs in a row/);
  });

  test("both phrasings name both checks: the partner and this device's clock", () => {
    const coordination = repeatedMissCoordination(withMisses(3));
    for (const copy of [coordination?.line, coordination?.prompt]) {
      expect(copy).toMatch(/partner/i);
      expect(copy).toMatch(/clock/i);
      expect(copy).toMatch(/this device/i);
    }
  });

  test("the escalation is a coordination problem, never attack framing", () => {
    const coordination = repeatedMissCoordination(withMisses(4));
    expect(coordination?.prompt).not.toMatch(
      /attack|tamper|desync|impersonat/i,
    );
    expect(coordination?.line).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("the prompt offers no pause and says the cadence stands", () => {
    // Surface-only, no auto-pause: the copy must not be treated as the app
    // having stopped attempting on the operator's behalf.
    const { prompt } = repeatedMissCoordination(withMisses(2)) ?? {};
    expect(prompt).toMatch(/nothing has been paused/i);
    expect(prompt).toMatch(/the schedule stands/i);
    expect(prompt).not.toMatch(/stopped attempting|paused it|is paused/i);
  });

  test("the count a success leaves behind clears the escalation", () => {
    // The reset is the schedule arithmetic's, driven here rather than assumed, so
    // the surface's threshold reads the same field the runner writes.
    const afterSuccess = nextConsecutiveMisses(4, "succeeded");
    expect(afterSuccess).toBe(0);
    expect(repeatedMissCoordination(withMisses(afterSuccess))).toBeUndefined();
  });
});

describe("cadence in words", () => {
  test("a weekly cadence names its period and its window width", () => {
    expect(scheduleCadenceLine(weekly)).toBe(
      "A run window opens every 7 days and stays open 3 hours.",
    );
  });

  test("a daily cadence does not display as every 1 days", () => {
    expect(scheduleCadenceLine({ ...weekly, intervalDays: 1 })).toBe(
      "A run window opens every day and stays open 3 hours.",
    );
  });
});

describe("the attendance note branches on the runtime", () => {
  test("an installed runtime says the app runs this itself, and bounds the promise", () => {
    // The unattended runner starts only in an installed runtime, so this is the
    // one reading on which "runs on its own" is true rather than aspirational.
    const note = scheduleAttendanceNote(true);
    expect(note).toMatch(/installed/i);
    expect(note).toMatch(/nobody present/i);
    // Bounded by what the runtime can actually promise: an app that is closed
    // when a window opens meets nothing.
    expect(note).toMatch(/while the app is closed passes without a run/i);
  });

  test("an ordinary tab promises no run and names the operator's own move", () => {
    const note = scheduleAttendanceNote(false);
    expect(note).toMatch(/passes without a run/i);
    expect(note).toMatch(/run this exchange/i);
    // No assurance that something ran, or will run, while nobody is here -- the
    // installed app is named as the way to get that, not implied to be in force.
    expect(note).toMatch(/never runs this exchange on its own/i);
    expect(note).not.toMatch(/automatically|by itself|unattended/i);
  });

  test("the two readings are different facts, not two wordings of one", () => {
    expect(scheduleAttendanceNote(true)).not.toBe(
      scheduleAttendanceNote(false),
    );
  });
});

describe("every schedule the record schema admits renders", () => {
  // The surfaces render a window instant directly, with no fallback for one no
  // calendar holds. Within the schema's ceilings on `intervalDays` and
  // `windowSeconds`, the window containing an instant and the first one after
  // it both land on a renderable calendar -- checked here by sweeping the
  // schema's own extremes, at the extremes of the instant range and at a real
  // clock's reading.
  const anchors = [
    "0000-01-01T00:00:00.000Z",
    "1970-01-01T00:00:00.000Z",
    "2026-07-14T12:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ];
  const intervals = [1, 7, MAX_SCHEDULE_INTERVAL_DAYS];
  const widths = [1, 10_800, MAX_SCHEDULE_WINDOW_SECONDS];
  const readableSpan =
    MAX_TIME_VALUE -
    (MAX_SCHEDULE_INTERVAL_DAYS * 86_400_000 +
      MAX_SCHEDULE_WINDOW_SECONDS * 1000);
  const instants = [
    -readableSpan,
    at("2026-07-14T12:00:00.000Z"),
    readableSpan,
  ];

  function admittedSchedule(
    anchor: string,
    intervalDays: number,
    windowSeconds: number,
  ): ManagedExchangeSchedule {
    return scheduleSchema.parse({
      anchor,
      intervalDays,
      windowSeconds,
      nextWindow: anchor,
      consecutiveMisses: 0,
    });
  }

  test("no admitted schedule refuses to be read anywhere in the range it can be read at", () => {
    for (const anchor of anchors)
      for (const intervalDays of intervals)
        for (const windowSeconds of widths)
          for (const instant of instants) {
            const dueness = scheduleDueness(
              admittedSchedule(anchor, intervalDays, windowSeconds),
              instant,
            );
            expect(dueness.state).toMatch(/^(open|upcoming)$/);
            // A rendered calendar moment, not a placeholder for one no calendar
            // holds: `Intl` throws on an instant outside the range rather than
            // formatting it, and an unrepresentable instant reaches it as an
            // invalid `Date`.
            const { opensAt, closesAt } = windowInstants(dueness);
            for (const rendered of [opensAt, closesAt ?? opensAt]) {
              expect(rendered).not.toBe("");
              expect(rendered).not.toMatch(/invalid/i);
            }
            expect(scheduleDueLine(dueness)).not.toBe("");
          }
  });

  test("a period or width past the ceiling is refused before it reaches a surface", () => {
    // The other half of what makes the sweep above total: an imported or
    // hand-edited record holding either shape fails validation, so it is never a
    // record these surfaces read.
    expect(() =>
      admittedSchedule(
        "1970-01-01T00:00:00.000Z",
        MAX_SCHEDULE_INTERVAL_DAYS + 1,
        10_800,
      ),
    ).toThrow();
    expect(() =>
      admittedSchedule(
        "1970-01-01T00:00:00.000Z",
        1,
        MAX_SCHEDULE_WINDOW_SECONDS + 1,
      ),
    ).toThrow();
  });

  test("an instant too near the end of the range is refused rather than rendered", () => {
    // The other half of the pairing: the schema bounds how far past `now` a window
    // falls, and this bounds `now`. A host clock this far out is not a reading the
    // surfaces have to render, and refusing beats formatting an invalid date.
    expect(() =>
      scheduleDueness(
        admittedSchedule("2026-07-14T12:00:00.000Z", 7, 10_800),
        MAX_TIME_VALUE,
      ),
    ).toThrow(RangeError);
  });
});
