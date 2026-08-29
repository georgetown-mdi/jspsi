import { describe, expect, test } from "vitest";

import {
  REPEATED_MISS_ESCALATION,
  SCHEDULE_ATTENDANCE_NOTE,
  repeatedMissCoordination,
  scheduleCadenceLine,
  scheduleDueLine,
  scheduleDueness,
} from "@bench/scheduleSurfacingModel";
import { nextConsecutiveMisses } from "@psi/managedSchedule";
import { scheduleSchema } from "@psi/managedExchangeRecord";
import { withTimeZone } from "../utils/hostTimeZone";

import type { ManagedExchangeSchedule } from "@psi/managedExchangeRecord";
import type { ScheduleDueness } from "@bench/scheduleSurfacingModel";

// The schedule's display derivation in Node, with the clock injected: where the
// recurrence stands at an instant, the cadence in words, and the coordination state
// a run of missed windows earns. Every window instant comes from the schedule
// arithmetic in @psi/managedSchedule, so the suite pins what a re-derivation here
// would break -- a reading taken off the lattice rather than off the record's
// planned `nextWindow`, and a window that keeps its agreed instant across a
// daylight-saving transition while its local rendering moves an hour.

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

/** The window instants a readable state carries, failing loudly on the unreadable
 * one rather than letting an assertion below read a field it does not have. */
function windowInstants(dueness: ScheduleDueness): {
  opensAt: string;
  closesAt?: string;
} {
  if (dueness.state === "unreadable")
    throw new Error("the schedule did not read as a window");
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

  test("inside a window reads open and names when it closes", () => {
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
    // run the schedule carries a stale one. The surfaces must still name the
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
    expect(coordination?.line).toMatch(/^2 agreed run windows/);
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
    // Surface-only, no auto-pause: the copy must not read as the app having
    // stopped attempting on the operator's behalf.
    const { prompt } = repeatedMissCoordination(withMisses(2)) ?? {};
    expect(prompt).toMatch(/the agreed cadence stands/i);
    expect(prompt).not.toMatch(/has been paused|stopped attempting|paused it/i);
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

  test("a daily cadence does not read as every 1 days", () => {
    expect(scheduleCadenceLine({ ...weekly, intervalDays: 1 })).toBe(
      "A run window opens every day and stays open 3 hours.",
    );
  });
});

describe("the standing attendance note", () => {
  test("it promises no run and names the operator's own move", () => {
    expect(SCHEDULE_ATTENDANCE_NOTE).toMatch(/passes without a run/i);
    expect(SCHEDULE_ATTENDANCE_NOTE).toMatch(/run this exchange/i);
    // No assurance that something ran, or will run, while nobody is here.
    expect(SCHEDULE_ATTENDANCE_NOTE).not.toMatch(
      /automatically|by itself|on its own|unattended/i,
    );
  });
});

describe("every schedule the record schema admits is readable", () => {
  // A schedule reaches these surfaces only through the record schema, which bounds
  // neither `intervalDays` nor `windowSeconds` above -- so an imported or
  // hand-edited record really can place its next window past every calendar. That
  // it lands on a state rather than a thrown render is checked rather than asserted
  // in prose: one row that threw would take the whole list down with it. The sweep
  // is over the schema's own extremes, at the instants a real clock reads.
  const anchors = [
    "0000-01-01T00:00:00.000Z",
    "1970-01-01T00:00:00.000Z",
    "2026-07-14T12:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ];
  const intervals = [1, 7, 1_000_000_000];
  const widths = [1, 10_800, 10_000_000_000_000];
  const instants = [
    "1970-01-01T00:00:00.000Z",
    "2026-07-14T12:00:00.000Z",
    "2100-01-01T00:00:00.000Z",
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

  test("no admitted schedule refuses to be read at a real clock's instant", () => {
    for (const anchor of anchors)
      for (const intervalDays of intervals)
        for (const windowSeconds of widths)
          for (const instant of instants) {
            const dueness = scheduleDueness(
              admittedSchedule(anchor, intervalDays, windowSeconds),
              at(instant),
            );
            expect(dueness.state).toMatch(/^(open|upcoming|unreadable)$/);
            expect(scheduleDueLine(dueness)).not.toBe("");
          }
  });

  test("a next window past every calendar reads as unreadable, not as a rendered date", () => {
    // Nothing above passes vacuously: this is a combination that reaches the
    // state, and it is a schedule the schema admits.
    const millennial = admittedSchedule(
      "1970-01-01T00:00:00.000Z",
      1_000_000_000,
      10_800,
    );
    const dueness = scheduleDueness(millennial, at("2026-07-14T12:00:00.000Z"));
    expect(dueness.state).toBe("unreadable");
    expect(scheduleDueLine(dueness)).toMatch(/no window on any calendar/i);
    expect(scheduleDueLine(dueness)).toMatch(/agreed with your partner/i);
  });

  test("an open window whose close is past every calendar reads the same way", () => {
    // The other half of the render: `now` sits inside window 0, and it is the
    // window's CLOSE that no calendar carries.
    const endless = admittedSchedule(
      "1970-01-01T00:00:00.000Z",
      1,
      10_000_000_000_000,
    );
    expect(scheduleDueness(endless, at("2026-07-14T12:00:00.000Z")).state).toBe(
      "unreadable",
    );
  });
});
