import { describe, expect, test } from "vitest";

import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_HOURS,
  MIN_SCHEDULE_WINDOW_HOURS,
  buildScheduleFromEntry,
  cadenceAgainstTokenBound,
  defaultScheduleEntryFields,
  resolvedFirstWindowLabel,
  scheduleEntryErrors,
  scheduleEntryFieldsFrom,
  scheduleEntryUnchanged,
  scheduleEntryUsable,
} from "@bench/scheduleEntryModel";
import {
  MAX_SCHEDULE_WINDOW_SECONDS,
  scheduleSchema,
} from "@psi/managedExchangeRecord";
import { catchUpManagedSchedule } from "@psi/managedSchedule";
import { withTimeZone } from "../utils/hostTimeZone";

import type { ScheduleEntryFields } from "@bench/scheduleEntryModel";

// Schedule entry in Node, with the clock injected: what the operator types, what
// is wrong with it, what it resolves to, and the one problem an opted-in
// max-token-age policy raises against it. Entry is the ONE place the host zone is
// read, so the zone is pinned wherever a resolution is asserted -- a test that
// passed only under the machine's own zone would assert nothing.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

/** A weekly cadence opening at 09:00 local on 14 July 2026, three hours wide. */
function entry(
  overrides: Partial<ScheduleEntryFields> = {},
): ScheduleEntryFields {
  return {
    firstWindowDate: "2026-07-14",
    firstWindowTime: "09:00",
    intervalDays: 7,
    windowHours: 3,
    ...overrides,
  };
}

describe("what an entry has to carry", () => {
  test("a complete cadence has nothing wrong with it", () => {
    expect(scheduleEntryErrors(entry())).toEqual({});
    expect(scheduleEntryUsable(entry())).toBe(true);
  });

  test("a partial date or time blocks the save rather than resolving to something", () => {
    // A date or time input reports a partial value while it is being edited, and
    // resolving one would write a cadence nobody agreed.
    for (const fields of [
      entry({ firstWindowDate: "" }),
      entry({ firstWindowDate: "2026-07" }),
      entry({ firstWindowTime: "" }),
      entry({ firstWindowTime: "9" }),
      entry({ firstWindowTime: "24:00" }),
    ]) {
      expect(scheduleEntryUsable(fields)).toBe(false);
      expect(() => buildScheduleFromEntry(fields, NOW)).toThrow(RangeError);
    }
  });

  test("a date the calendar does not have fails at the field", () => {
    const fields = entry({ firstWindowDate: "2026-02-29" });
    expect(scheduleEntryErrors(fields).firstWindowDate).toMatch(
      /not a date on the calendar/i,
    );
    expect(() => buildScheduleFromEntry(fields, NOW)).toThrow(RangeError);
  });
});

describe("the bounds entry enforces", () => {
  test("a cadence past the recurrence ceiling fails at its own field", () => {
    const errors = scheduleEntryErrors(
      entry({ intervalDays: MAX_SCHEDULE_INTERVAL_DAYS + 1 }),
    );
    expect(errors.intervalDays).toMatch(
      new RegExp(String(MAX_SCHEDULE_INTERVAL_DAYS)),
    );
    // Only that field: the rest of the cadence is fine and must not be reported
    // as broken beside it.
    expect(errors.windowHours).toBeUndefined();
    expect(errors.firstWindowDate).toBeUndefined();
  });

  test("the ceiling itself is admitted, and so is a daily cadence", () => {
    for (const intervalDays of [1, MAX_SCHEDULE_INTERVAL_DAYS])
      expect(
        scheduleEntryErrors(entry({ intervalDays })).intervalDays,
      ).toBeUndefined();
  });

  test("a window narrower than the floor is refused, naming why width matters", () => {
    // Width is the design's only clock-skew mitigation, so the floor is a UX bound
    // beyond the schema's structural one and the copy says what it buys.
    const errors = scheduleEntryErrors(
      entry({ windowHours: MIN_SCHEDULE_WINDOW_HOURS - 1 }),
    );
    expect(errors.windowHours).toMatch(/clock difference/i);
  });

  test("a window past the ceiling is refused, and the ceiling itself is admitted", () => {
    expect(
      scheduleEntryErrors(entry({ windowHours: MAX_SCHEDULE_WINDOW_HOURS + 1 }))
        .windowHours,
    ).toBeDefined();
    expect(
      scheduleEntryErrors(entry({ windowHours: MAX_SCHEDULE_WINDOW_HOURS }))
        .windowHours,
    ).toBeUndefined();
  });

  test("a cleared or fractional number blocks the save", () => {
    for (const fields of [
      entry({ intervalDays: "" }),
      entry({ intervalDays: 1.5 }),
      entry({ windowHours: "" }),
      entry({ windowHours: 2.5 }),
    ])
      expect(scheduleEntryUsable(fields)).toBe(false);
  });

  test("every cadence entry admits is one the record schema admits", () => {
    // The field errors restate the schema's bounds so an out-of-range value fails
    // where the operator can fix it. That they really are the same bounds is
    // checked rather than trusted: a widened field would deposit a schedule the
    // store write refuses.
    for (const intervalDays of [1, 7, MAX_SCHEDULE_INTERVAL_DAYS])
      for (const windowHours of [
        MIN_SCHEDULE_WINDOW_HOURS,
        3,
        MAX_SCHEDULE_WINDOW_HOURS,
      ]) {
        const fields = entry({ intervalDays, windowHours });
        expect(scheduleEntryUsable(fields)).toBe(true);
        expect(() =>
          scheduleSchema.parse(buildScheduleFromEntry(fields, NOW)),
        ).not.toThrow();
      }
  });
});

describe("resolving a local cadence to its stored anchor", () => {
  test("the wall clock the operator typed becomes the instant it names, once", () => {
    withTimeZone("America/New_York", () => {
      const schedule = buildScheduleFromEntry(entry(), NOW);
      // 09:00 on 14 July 2026 in Eastern daylight time is 13:00Z.
      expect(schedule.anchor).toBe("2026-07-14T13:00:00.000Z");
    });
  });

  test("the same wall clock in another zone resolves to another instant", () => {
    const eastern = withTimeZone("America/New_York", () =>
      buildScheduleFromEntry(entry(), NOW),
    );
    const utc = withTimeZone("UTC", () => buildScheduleFromEntry(entry(), NOW));
    expect(utc.anchor).toBe("2026-07-14T09:00:00.000Z");
    expect(eastern.anchor).not.toBe(utc.anchor);
  });

  test("a stored anchor reads back as the wall clock it was entered on", () => {
    withTimeZone("America/New_York", () => {
      const schedule = buildScheduleFromEntry(entry(), NOW);
      expect(scheduleEntryFieldsFrom(schedule)).toEqual(entry());
    });
  });

  test("a re-save that changes nothing resolves to the same anchor", () => {
    // The round trip is what keeps re-opening the form from silently moving the
    // agreed instant, which would drift this party away from their partner's.
    withTimeZone("America/New_York", () => {
      const first = buildScheduleFromEntry(entry(), NOW);
      const second = buildScheduleFromEntry(
        scheduleEntryFieldsFrom(first),
        NOW,
      );
      expect(second.anchor).toBe(first.anchor);
      expect(second.intervalDays).toBe(first.intervalDays);
      expect(second.windowSeconds).toBe(first.windowSeconds);
    });
  });

  test("the resolved instant is shown back on the operator's own clock", () => {
    withTimeZone("America/New_York", () => {
      expect(resolvedFirstWindowLabel(entry())).toMatch(
        /July 14, 2026.*9:00 AM EDT/,
      );
    });
    expect(
      resolvedFirstWindowLabel(entry({ firstWindowTime: "" })),
    ).toBeUndefined();
  });

  test("a cadence entered across a daylight-saving boundary keeps its instant", () => {
    // 2026 US daylight saving starts on 8 March. The anchor resolves once, so the
    // window a week later sits at the same instant rather than at the same wall
    // clock -- which is what keeps two runners overlapping across the shift.
    withTimeZone("America/New_York", () => {
      const schedule = buildScheduleFromEntry(
        entry({ firstWindowDate: "2026-03-03", firstWindowTime: "09:00" }),
        Date.parse("2026-03-01T00:00:00.000Z"),
      );
      expect(schedule.anchor).toBe("2026-03-03T14:00:00.000Z");
      // A local-calendar add would have held 09:00 and moved the instant an hour.
      const weekLater =
        Date.parse(schedule.anchor) + schedule.intervalDays * 86_400_000;
      expect(new Date(weekLater).toISOString()).toBe(
        "2026-03-10T14:00:00.000Z",
      );
    });
  });

  test("the seeded cadence an empty form opens on is itself usable", () => {
    const fields = defaultScheduleEntryFields(NOW);
    expect(scheduleEntryUsable(fields)).toBe(true);
    expect(fields.intervalDays).toBe(7);
    expect(fields.windowHours).toBe(3);
  });
});

describe("the window an entered cadence plans first", () => {
  test("a cadence anchored in the past plans a live window, not the anchor's", () => {
    // Writing the anchor's own window would hand the catch-up walk every window
    // that elapsed before the operator agreed the cadence, and count each one a
    // miss the partnership never had.
    const schedule = withTimeZone("UTC", () =>
      buildScheduleFromEntry(
        entry({ firstWindowDate: "2026-01-06", firstWindowTime: "14:00" }),
        NOW,
      ),
    );
    expect(schedule.anchor).toBe("2026-01-06T14:00:00.000Z");
    expect(Date.parse(schedule.nextWindow)).toBeGreaterThan(NOW - 3 * 3600_000);
    expect(schedule.consecutiveMisses).toBe(0);

    // Driven through the real catch-up rule: a wake at the entry instant counts
    // nothing.
    const caughtUp = catchUpManagedSchedule(schedule, undefined, NOW);
    expect(caughtUp.missedWindows).toBe(0);
    expect(caughtUp.schedule.consecutiveMisses).toBe(0);
  });

  test("a cadence anchored ahead plans the anchor's own window", () => {
    const schedule = withTimeZone("UTC", () =>
      buildScheduleFromEntry(
        entry({ firstWindowDate: "2026-08-01", firstWindowTime: "09:00" }),
        NOW,
      ),
    );
    expect(schedule.nextWindow).toBe(schedule.anchor);
  });

  test("a cadence entered while a window is open plans that window, not the next", () => {
    // The operator can agree a cadence mid-window and have this run meet it.
    const schedule = withTimeZone("UTC", () =>
      buildScheduleFromEntry(
        entry({ firstWindowDate: "2026-07-14", firstWindowTime: "11:00" }),
        NOW,
      ),
    );
    expect(schedule.nextWindow).toBe("2026-07-14T11:00:00.000Z");
    expect(
      catchUpManagedSchedule(schedule, undefined, NOW).dueWindow,
    ).toBeDefined();
  });

  test("an edited cadence starts its miss count over", () => {
    // The stored count spoke for windows on the old lattice; nothing about it
    // carries to a cadence with a different anchor or period.
    const schedule = buildScheduleFromEntry(entry({ intervalDays: 14 }), NOW);
    expect(schedule.consecutiveMisses).toBe(0);
  });
});

describe("a save that did not touch the cadence", () => {
  test("reads as unchanged, so the stored schedule is carried rather than rebuilt", () => {
    // What rests on this: rebuilding would reset the planned window and the miss
    // count, which are the runner's bookkeeping, on a save of the label alone.
    withTimeZone("America/New_York", () => {
      const stored = scheduleSchema.parse({
        ...buildScheduleFromEntry(entry(), NOW),
        nextWindow: "2026-08-04T13:00:00.000Z",
        consecutiveMisses: 3,
      });
      expect(
        scheduleEntryUnchanged(scheduleEntryFieldsFrom(stored), stored),
      ).toBe(true);
    });
  });

  test("any edited field reads as changed", () => {
    withTimeZone("America/New_York", () => {
      const stored = buildScheduleFromEntry(entry(), NOW);
      const fields = scheduleEntryFieldsFrom(stored);
      for (const edited of [
        { firstWindowDate: "2026-07-15" },
        { firstWindowTime: "10:00" },
        { intervalDays: 14 },
        { windowHours: 4 },
      ])
        expect(scheduleEntryUnchanged({ ...fields, ...edited }, stored)).toBe(
          false,
        );
    });
  });
});

describe("a cadence weighed against the max-token-age bound", () => {
  test("no policy set raises nothing, which is the default", () => {
    expect(cadenceAgainstTokenBound(30, undefined)).toBeUndefined();
  });

  test("a cadence inside the bound raises nothing", () => {
    expect(cadenceAgainstTokenBound(7, 30)).toBeUndefined();
  });

  test("a cadence that outruns the bound is surfaced, in the bound's own terms", () => {
    const problem = cadenceAgainstTokenBound(30, 7);
    expect(problem).toMatch(/must run or be renewed within 7 days/i);
    expect(problem).toMatch(/every 30 days/);
    // It names the recovery rather than leaving the operator with a warning they
    // cannot act on.
    expect(problem).toMatch(/re-inviting your partner/i);
    expect(problem).toMatch(/shorten the cadence/i);
  });

  test("a cadence exactly at the bound is surfaced too", () => {
    // The window opens exactly when the secret lapses, which is not a margin.
    expect(cadenceAgainstTokenBound(30, 30)).toBeDefined();
  });

  test("a one-day bound is phrased in the singular", () => {
    expect(cadenceAgainstTokenBound(1, 1)).toMatch(/within 1 day,/);
  });

  test("an unusable cadence field raises nothing, leaving its own error to stand", () => {
    expect(cadenceAgainstTokenBound("", 7)).toBeUndefined();
  });
});

describe("a stored schedule the entry form did not write", () => {
  test("a width below the entry floor reads back as itself, not silently rewritten", () => {
    // An imported record can carry a width the schema admits and entry does not.
    // Showing it is what lets the operator see and correct it; rewriting it would
    // change what their partner agreed without telling them.
    const fields = scheduleEntryFieldsFrom(
      scheduleSchema.parse({
        anchor: "2026-07-14T09:00:00.000Z",
        intervalDays: 7,
        windowSeconds: 60,
        nextWindow: "2026-07-14T09:00:00.000Z",
        consecutiveMisses: 0,
      }),
    );
    expect(fields.windowHours).toBe(0);
    expect(scheduleEntryErrors(fields).windowHours).toBeDefined();
  });

  test("the widest stored window reads back as the ceiling entry offers", () => {
    const fields = scheduleEntryFieldsFrom(
      scheduleSchema.parse({
        anchor: "2026-07-14T09:00:00.000Z",
        intervalDays: 7,
        windowSeconds: MAX_SCHEDULE_WINDOW_SECONDS,
        nextWindow: "2026-07-14T09:00:00.000Z",
        consecutiveMisses: 0,
      }),
    );
    expect(fields.windowHours).toBe(MAX_SCHEDULE_WINDOW_HOURS);
    expect(scheduleEntryErrors(fields)).toEqual({});
  });
});
