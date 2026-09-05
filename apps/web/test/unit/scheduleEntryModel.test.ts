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
} from "@recurring/scheduleEntryModel";
import {
  MAX_SCHEDULE_WINDOW_SECONDS,
  scheduleSchema,
} from "@psi/managedExchangeRecord";
import { catchUpManagedSchedule } from "@psi/managedSchedule";
import { withTimeZone } from "../utils/hostTimeZone";

import type { ScheduleEntryFields } from "@recurring/scheduleEntryModel";

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

describe("what an entry has to hold", () => {
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

  test("a stored anchor displays as the wall clock it was entered on", () => {
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
    // applies to a cadence with a different anchor or period.
    const schedule = buildScheduleFromEntry(entry({ intervalDays: 14 }), NOW);
    expect(schedule.consecutiveMisses).toBe(0);
  });
});

describe("a save that did not touch the cadence", () => {
  test("is treated as unchanged, so the stored schedule is kept rather than rebuilt", () => {
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

  test("any edited field is treated as changed", () => {
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

  test("a cadence that outruns the bound is reported, in the bound's own terms", () => {
    const problem = cadenceAgainstTokenBound(30, 7);
    expect(problem).toMatch(/must run or be renewed within 7 days/i);
    expect(problem).toMatch(/every 30 days/);
    // It names the recovery rather than leaving the operator with a warning they
    // cannot act on.
    expect(problem).toMatch(/re-inviting your partner/i);
    expect(problem).toMatch(/shorten the cadence/i);
  });

  test("a cadence exactly at the bound is reported too", () => {
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
  /** An imported or hand-edited record holding a 90-minute window and an anchor
   * with seconds on it: two values the entry fields hold at a coarser resolution
   * than the record does. */
  function finerThanTheFields() {
    return scheduleSchema.parse({
      anchor: "2026-07-14T09:00:30.500Z",
      intervalDays: 7,
      windowSeconds: 5400,
      nextWindow: "2026-08-04T09:00:30.500Z",
      consecutiveMisses: 2,
    });
  }

  /** An imported or hand-edited record holding a one-minute window: a width the
   * schema admits and entry's own floor does not. */
  function belowTheEntryFloor() {
    return scheduleSchema.parse({
      anchor: "2026-07-14T09:00:00.000Z",
      intervalDays: 7,
      windowSeconds: 60,
      nextWindow: "2026-07-14T09:00:00.000Z",
      consecutiveMisses: 0,
    });
  }

  test("a width below the entry floor displays as itself, not silently rewritten", () => {
    // An imported record can hold a width the schema admits and entry does not.
    // Showing it is what lets the operator see it; rewriting it would change what
    // their partner agreed without telling them.
    const stored = belowTheEntryFloor();
    const fields = scheduleEntryFieldsFrom(stored);
    expect(fields.windowHours).toBe(60 / 3600);
    expect(buildScheduleFromEntry(fields, NOW, stored).windowSeconds).toBe(60);
  });

  test("a stored width below the floor does not block an edit to another field", () => {
    // The bounds hold what the operator ENTERS. Refusing an inherited width would
    // withhold every other save the form makes -- a label, a max-age policy, a
    // re-planned cadence -- over a value they never typed and this form will not
    // rewrite for them.
    const stored = belowTheEntryFloor();
    const fields = scheduleEntryFieldsFrom(stored);
    expect(scheduleEntryErrors(fields, stored)).toEqual({});
    expect(scheduleEntryUsable(fields, stored)).toBe(true);
    expect(
      buildScheduleFromEntry({ ...fields, intervalDays: 14 }, NOW, stored)
        .windowSeconds,
    ).toBe(60);
  });

  test("a below-floor width the operator types is still refused at its field", () => {
    // The carve-out is the stored value exactly, not the range around it: a width
    // under the floor that the operator entered is theirs to fix, and the error
    // still names what the width buys.
    const stored = belowTheEntryFloor();
    const fields = scheduleEntryFieldsFrom(stored);
    for (const windowHours of [0.5, MIN_SCHEDULE_WINDOW_HOURS - 1]) {
      const errors = scheduleEntryErrors({ ...fields, windowHours }, stored);
      expect(errors.windowHours).toMatch(/clock difference/i);
      expect(scheduleEntryUsable({ ...fields, windowHours }, stored)).toBe(
        false,
      );
    }
  });

  test("a width the hour field cannot express displays exactly, never rounded", () => {
    // The rounded reading is the silent rewrite this guards: shown as 2, a save
    // of any other field writes 7200 seconds over the 5400 the partnership
    // agreed.
    const stored = finerThanTheFields();
    const fields = scheduleEntryFieldsFrom(stored);
    expect(fields.windowHours).toBe(1.5);
    expect(Number(fields.windowHours) * 3600).toBe(stored.windowSeconds);
    // It stands as it is rather than being flagged: it is inside entry's bounds,
    // and the operator has nothing to correct while the save passes it through.
    expect(scheduleEntryErrors(fields, stored)).toEqual({});
    expect(scheduleEntryUsable(fields, stored)).toBe(true);
  });

  test("editing one field passes every untouched value through verbatim", () => {
    withTimeZone("America/New_York", () => {
      const stored = finerThanTheFields();
      const edited = {
        ...scheduleEntryFieldsFrom(stored),
        intervalDays: 14,
      };
      const rebuilt = buildScheduleFromEntry(edited, NOW, stored);
      // Neither the seconds on the width nor the sub-minute part of the anchor
      // survives a round trip through the display fields, so both are kept
      // rather than re-derived.
      expect(rebuilt.windowSeconds).toBe(5400);
      expect(rebuilt.anchor).toBe(stored.anchor);
      // The edit itself lands, and the bookkeeping starts over on the new
      // lattice as it does for any edited cadence.
      expect(rebuilt.intervalDays).toBe(14);
      expect(rebuilt.consecutiveMisses).toBe(0);
      expect(scheduleSchema.safeParse(rebuilt).success).toBe(true);
    });
  });

  test("a width the operator does change takes the whole-hour rule", () => {
    const stored = finerThanTheFields();
    const fields = scheduleEntryFieldsFrom(stored);
    // Another value the field's unit cannot express is a value the operator
    // typed, not one they inherited, so it is refused at the field.
    expect(
      scheduleEntryErrors({ ...fields, windowHours: 2.5 }, stored).windowHours,
    ).toBeDefined();
    const widened = buildScheduleFromEntry(
      { ...fields, windowHours: 2 },
      NOW,
      stored,
    );
    expect(widened.windowSeconds).toBe(7200);
  });

  test("editing the date re-resolves the anchor rather than keeping the stored one", () => {
    // Retention is per field: none may hold an instant the operator moved.
    // Date and time resolve together, so touching either re-resolves.
    withTimeZone("America/New_York", () => {
      const stored = finerThanTheFields();
      const fields = scheduleEntryFieldsFrom(stored);
      const moved = buildScheduleFromEntry(
        { ...fields, firstWindowDate: "2026-07-21" },
        NOW,
        stored,
      );
      expect(moved.anchor).not.toBe(stored.anchor);
      expect(moved.anchor).toBe(
        new Date(2026, 6, 21, 5, 0, 0, 0).toISOString(),
      );
      // The width it did not touch is still kept.
      expect(moved.windowSeconds).toBe(5400);
    });
  });

  test("a width with no stored schedule to hold it is refused, not written fractional", () => {
    // The record stores whole seconds, so a width that resolves to a fraction of
    // one has nowhere to be written; refusing here is what keeps it from
    // showing up as a validation failure at the store write.
    expect(() =>
      buildScheduleFromEntry(entry({ windowHours: 1.5000001 }), NOW),
    ).toThrow(RangeError);
  });

  test("the widest stored window displays as the ceiling entry offers", () => {
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
