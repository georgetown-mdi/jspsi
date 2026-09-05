import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  advanceManagedScheduleAfterWindow,
  catchUpManagedSchedule,
  firstUnclosedManagedScheduleWindow,
  localCadenceFromAnchor,
  managedScheduleWindow,
  managedScheduleWindowStateAt,
  nextConsecutiveMisses,
  nextManagedScheduleWindowAfter,
  resolveLocalCadenceAnchor,
} from "@psi/managed/managedSchedule";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  scheduleSchema,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  reconstructRecordFromArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { withTimeZone } from "../utils/hostTimeZone";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";

// The schedule arithmetic in Node, with every clock injected. The recurrence is
// UTC-millisecond arithmetic against the record's stored-UTC anchor, so the suite
// pins two things a local-calendar implementation would fail: window opens that
// hold their spacing across a daylight-saving transition, and results that are
// byte-identical under any host time zone.

const MS_PER_DAY = 86_400_000;

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

function requireSchedule(
  record: ManagedExchangeRecord,
): ManagedExchangeSchedule {
  const { schedule } = record;
  if (schedule === undefined) throw new Error("record carries no schedule");
  return schedule;
}

describe("window geometry", () => {
  test("window 0 opens at the anchor and window n a whole period later", () => {
    expect(managedScheduleWindow(weekly, 0)).toEqual({
      index: 0,
      opensAtMs: at("2026-01-06T14:00:00.000Z"),
      closesAtMs: at("2026-01-06T17:00:00.000Z"),
    });
    expect(managedScheduleWindow(weekly, 3).opensAtMs).toBe(
      at("2026-01-27T14:00:00.000Z"),
    );
    expect(managedScheduleWindow(weekly, 3).opensAtMs - at(weekly.anchor)).toBe(
      3 * 7 * MS_PER_DAY,
    );
  });

  test("the window is half-open: its close instant is already elapsed", () => {
    const window = managedScheduleWindow(weekly, 1);
    expect(managedScheduleWindowStateAt(window, window.opensAtMs - 1)).toBe(
      "before",
    );
    expect(managedScheduleWindowStateAt(window, window.opensAtMs)).toBe("open");
    expect(managedScheduleWindowStateAt(window, window.closesAtMs - 1)).toBe(
      "open",
    );
    expect(managedScheduleWindowStateAt(window, window.closesAtMs)).toBe(
      "elapsed",
    );
  });

  test("the next window after an instant is the one that opens strictly later", () => {
    expect(
      nextManagedScheduleWindowAfter(weekly, at("2026-01-06T13:59:59.999Z"))
        .index,
    ).toBe(0);
    // An instant exactly at an open yields the FOLLOWING window, which is what an
    // advance past a window just occupied wants.
    expect(
      nextManagedScheduleWindowAfter(weekly, at("2026-01-13T14:00:00.000Z"))
        .index,
    ).toBe(2);
    expect(
      nextManagedScheduleWindowAfter(weekly, at("2026-01-13T14:00:00.001Z"))
        .opensAtMs,
    ).toBe(at("2026-01-20T14:00:00.000Z"));
    // Never earlier than the first agreed window, however far before the anchor.
    expect(
      nextManagedScheduleWindowAfter(weekly, at("2020-01-01T00:00:00.000Z"))
        .index,
    ).toBe(0);
  });

  test("the first unclosed window is the one an instant sits in, or the next", () => {
    // What a schedule ENTERED at that instant plans first. Window 0 opens
    // 2026-01-06T14:00Z and closes at 17:00Z.
    expect(
      firstUnclosedManagedScheduleWindow(weekly, at("2026-01-06T14:00:00.000Z"))
        .index,
    ).toBe(0);
    expect(
      firstUnclosedManagedScheduleWindow(weekly, at("2026-01-06T16:59:59.999Z"))
        .index,
    ).toBe(0);
    // The close instant is already elapsed, so the window it belongs to is the
    // next one -- the same half-open reading the state rule takes.
    expect(
      firstUnclosedManagedScheduleWindow(
        weekly,
        at("2026-01-06T17:00:00.000Z"),
      ),
    ).toEqual({
      index: 1,
      opensAtMs: at("2026-01-13T14:00:00.000Z"),
      closesAtMs: at("2026-01-13T17:00:00.000Z"),
    });
    // In the gap between two windows: the next one, not the one just closed.
    expect(
      firstUnclosedManagedScheduleWindow(weekly, at("2026-01-08T09:00:00.000Z"))
        .index,
    ).toBe(1);
    // Never earlier than the first agreed window, however far before the anchor.
    expect(
      firstUnclosedManagedScheduleWindow(weekly, at("2020-01-01T00:00:00.000Z"))
        .index,
    ).toBe(0);
  });

  test("an instant exactly at a window's open plans THAT window, not the next", () => {
    // Where this parts company with `nextManagedScheduleWindowAfter`, which is
    // for advancing past a window just occupied: a cadence entered while one of
    // its windows is open plans the open one, so the run in progress can meet it.
    const open = at("2026-01-13T14:00:00.000Z");
    expect(firstUnclosedManagedScheduleWindow(weekly, open).index).toBe(1);
    expect(nextManagedScheduleWindowAfter(weekly, open).index).toBe(2);
  });

  test("a lattice the schema would not admit is refused rather than divided by", () => {
    expect(() =>
      managedScheduleWindow({ ...weekly, intervalDays: 0 }, 1),
    ).toThrow(RangeError);
    expect(() =>
      managedScheduleWindow({ ...weekly, intervalDays: 1.5 }, 1),
    ).toThrow(RangeError);
    expect(() =>
      managedScheduleWindow({ ...weekly, windowSeconds: 0 }, 1),
    ).toThrow(RangeError);
    expect(() =>
      managedScheduleWindow({ ...weekly, anchor: "the sixth of January" }, 1),
    ).toThrow(RangeError);
    expect(() =>
      firstUnclosedManagedScheduleWindow(
        { ...weekly, intervalDays: 0 },
        at("2026-01-06T14:00:00.000Z"),
      ),
    ).toThrow(RangeError);
    expect(() =>
      catchUpManagedSchedule(
        { ...weekly, nextWindow: "soon" },
        undefined,
        at("2026-01-06T14:00:00.000Z"),
      ),
    ).toThrow(RangeError);
  });

  test("a window past the representable instant range is refused, not rendered", () => {
    expect(() =>
      advanceManagedScheduleAfterWindow(
        weekly,
        managedScheduleWindow(weekly, 1e12),
        "succeeded",
      ),
    ).toThrow(RangeError);
  });

  test("a window the stored instant form cannot hold is refused, not expanded", () => {
    const lateInYear9999: ManagedExchangeSchedule = {
      ...weekly,
      anchor: "9999-12-28T14:00:00.000Z",
      nextWindow: "9999-12-28T14:00:00.000Z",
    };
    // Well inside the range a `Date` represents, and past the four-digit year
    // the record's validator admits: written out it is an expanded-year string
    // the schema would refuse, so it is refused where it would be rendered.
    expect(
      new Date(
        managedScheduleWindow(lateInYear9999, 1).opensAtMs,
      ).toISOString(),
    ).toBe("+010000-01-04T14:00:00.000Z");
    expect(() =>
      advanceManagedScheduleAfterWindow(
        lateInYear9999,
        managedScheduleWindow(lateInYear9999, 0),
        "missed",
      ),
    ).toThrow(RangeError);
    expect(() =>
      catchUpManagedSchedule(
        lateInYear9999,
        undefined,
        at("9999-12-28T18:00:00.000Z"),
      ),
    ).toThrow(RangeError);
  });
});

describe("daylight saving", () => {
  // 2026 US daylight saving starts on 8 March, so an anchor on 3 March and the
  // windows a week and a fortnight later straddle the transition.
  const march: ManagedExchangeSchedule = {
    anchor: "2026-03-03T14:00:00.000Z",
    intervalDays: 7,
    windowSeconds: 10_800,
    nextWindow: "2026-03-03T14:00:00.000Z",
    consecutiveMisses: 0,
  };

  test("window opens hold their spacing across a transition", () => {
    withTimeZone("America/New_York", () => {
      const opens = [0, 1, 2].map(
        (index) => managedScheduleWindow(march, index).opensAtMs,
      );
      // The span really does cross a transition in the pinned zone, so nothing
      // below passes vacuously on a machine that never shifts.
      expect(new Date(opens[0]).getTimezoneOffset()).not.toBe(
        new Date(opens[1]).getTimezoneOffset(),
      );

      expect(opens[1] - opens[0]).toBe(7 * MS_PER_DAY);
      expect(opens[2] - opens[1]).toBe(7 * MS_PER_DAY);
      expect(new Date(opens[1]).toISOString()).toBe("2026-03-10T14:00:00.000Z");

      // The implementation this is asserted against: a local-calendar date add
      // lands an hour off the agreed instant on the week the zone shifts.
      const calendarAdd = new Date(opens[0]);
      calendarAdd.setDate(calendarAdd.getDate() + 7);
      expect(calendarAdd.getTime()).not.toBe(opens[1]);
    });
  });

  test("catch-up across a transition lands on the agreed instant", () => {
    withTimeZone("America/New_York", () => {
      const caught = catchUpManagedSchedule(
        march,
        undefined,
        at("2026-03-17T15:00:00.000Z"),
      );
      expect(caught.schedule.nextWindow).toBe("2026-03-17T14:00:00.000Z");
      expect(caught.missedWindows).toBe(2);
      expect(caught.missedLastRun?.at).toBe("2026-03-10T17:00:00.000Z");
      expect(caught.dueWindow?.index).toBe(2);
    });
  });

  test("every rule is independent of the host time zone", () => {
    const lastRun = {
      at: "2026-03-10T15:00:00.000Z",
      outcome: "failed" as const,
    };
    const now = at("2026-03-17T15:00:00.000Z");
    // Every rule the module exports bar `resolveLocalCadenceAnchor` and
    // `localCadenceFromAnchor`, the two that read the zone by design and are
    // driven on their own below.
    const compute = () => ({
      window: managedScheduleWindow(march, 2),
      state: managedScheduleWindowStateAt(managedScheduleWindow(march, 2), now),
      next: nextManagedScheduleWindowAfter(march, now),
      firstUnclosed: firstUnclosedManagedScheduleWindow(march, now),
      misses: nextConsecutiveMisses(1, "missed"),
      caught: catchUpManagedSchedule(march, lastRun, now),
      advanced: advanceManagedScheduleAfterWindow(
        march,
        managedScheduleWindow(march, 2),
        "missed",
      ),
    });

    const eastern = withTimeZone("America/New_York", compute);
    expect(withTimeZone("UTC", compute)).toEqual(eastern);
    expect(withTimeZone("Asia/Kolkata", compute)).toEqual(eastern);
    // A zone whose saving shift is half an hour, not a whole one.
    expect(withTimeZone("Australia/Lord_Howe", compute)).toEqual(eastern);
  });

  // One offsetless string, driven under both zones below in every position a
  // record holds an instant. Nothing here passes vacuously: the two tests
  // after the measurement drive the SAME string it measured as divergent.
  const offsetless = "2026-03-10T15:00:00";
  const divergingZones = ["UTC", "America/New_York"];

  test("an offsetless instant names a different moment in each zone driven", () => {
    const moments = divergingZones.map((zone) =>
      withTimeZone(zone, () => Date.parse(offsetless)),
    );
    expect(moments[0]).not.toBe(moments[1]);
    // Read host-local the same stamp lands inside window 1 on one machine and in
    // the gap after it on the other -- the same stored record, two different
    // verdicts -- which is what refusing the string rather than reading it
    // against the host zone prevents.
    const window = managedScheduleWindow(march, 1);
    expect(managedScheduleWindowStateAt(window, moments[0])).toBe("open");
    expect(managedScheduleWindowStateAt(window, moments[1])).toBe("elapsed");
  });

  test("an anchor or planned window with no UTC designator is refused in either zone", () => {
    for (const zone of divergingZones)
      withTimeZone(zone, () => {
        expect(() =>
          managedScheduleWindow({ ...march, anchor: offsetless }, 1),
        ).toThrow(RangeError);
        expect(() =>
          nextManagedScheduleWindowAfter(
            { ...march, anchor: offsetless },
            at("2026-03-17T15:00:00.000Z"),
          ),
        ).toThrow(RangeError);
        expect(() =>
          advanceManagedScheduleAfterWindow(
            { ...march, anchor: offsetless },
            managedScheduleWindow(march, 1),
            "missed",
          ),
        ).toThrow(RangeError);
        expect(() =>
          catchUpManagedSchedule(
            { ...march, nextWindow: offsetless },
            undefined,
            at("2026-03-17T15:00:00.000Z"),
          ),
        ).toThrow(RangeError);
      });
  });

  test("run bookkeeping with no UTC designator is read as no run at all in either zone", () => {
    for (const zone of divergingZones) {
      const walked = withTimeZone(zone, () =>
        catchUpManagedSchedule(
          march,
          { at: offsetless, outcome: "succeeded" },
          at("2026-03-10T18:00:00.000Z"),
        ),
      );
      // Window 1 is the one the UTC read would have discharged; refused as
      // evidence, both elapsed windows count as missed on either machine.
      expect(walked.missedWindows).toBe(2);
      expect(walked.schedule.consecutiveMisses).toBe(2);
    }
  });
});

describe("nextConsecutiveMisses", () => {
  test("a success resets, a miss increments, anything else holds", () => {
    expect(nextConsecutiveMisses(4, "succeeded")).toBe(0);
    expect(nextConsecutiveMisses(4, "missed")).toBe(5);
    // A handshake that ran and failed means the two runners DID meet.
    expect(nextConsecutiveMisses(4, "failed")).toBe(4);
    expect(nextConsecutiveMisses(4, "desynced")).toBe(4);
    // A window the single-writer lock was held through is neither an attempt nor
    // a miss.
    expect(nextConsecutiveMisses(4, "unattempted")).toBe(4);
  });
});

describe("advanceManagedScheduleAfterWindow", () => {
  test("moves the planned window on and takes the disposition's verdict", () => {
    const advanced = advanceManagedScheduleAfterWindow(
      {
        ...weekly,
        nextWindow: "2026-01-13T14:00:00.000Z",
        consecutiveMisses: 2,
      },
      managedScheduleWindow(weekly, 1),
      "missed",
    );
    expect(advanced.nextWindow).toBe("2026-01-20T14:00:00.000Z");
    expect(advanced.consecutiveMisses).toBe(3);
    // An advance is bookkeeping, never a reschedule.
    expect(advanced.anchor).toBe(weekly.anchor);
    expect(advanced.intervalDays).toBe(weekly.intervalDays);
    expect(advanced.windowSeconds).toBe(weekly.windowSeconds);
  });

  test("a window held by the lock elsewhere advances without recording a miss", () => {
    const advanced = advanceManagedScheduleAfterWindow(
      {
        ...weekly,
        nextWindow: "2026-01-13T14:00:00.000Z",
        consecutiveMisses: 2,
      },
      managedScheduleWindow(weekly, 1),
      "unattempted",
    );
    expect(advanced.nextWindow).toBe("2026-01-20T14:00:00.000Z");
    expect(advanced.consecutiveMisses).toBe(2);
  });

  test("does not mutate the schedule it advances", () => {
    const schedule = { ...weekly };
    advanceManagedScheduleAfterWindow(
      schedule,
      managedScheduleWindow(weekly, 0),
      "succeeded",
    );
    expect(schedule).toEqual(weekly);
  });
});

describe("catch-up on wake", () => {
  test("a wake before the planned window changes nothing", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      undefined,
      at("2026-01-06T12:00:00.000Z"),
    );
    expect(caught.schedule).toEqual(weekly);
    expect(caught.missedWindows).toBe(0);
    expect(caught.dueWindow).toBeUndefined();
    expect(caught.missedLastRun).toBeUndefined();
  });

  test("a wake inside the planned window reports it due without advancing", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      undefined,
      at("2026-01-06T15:00:00.000Z"),
    );
    expect(caught.schedule).toEqual(weekly);
    expect(caught.dueWindow).toEqual(managedScheduleWindow(weekly, 0));
    expect(caught.missedWindows).toBe(0);
  });

  test("a window is elapsed at its close instant, not a millisecond later", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      undefined,
      at("2026-01-06T17:00:00.000Z"),
    );
    expect(caught.missedWindows).toBe(1);
    expect(caught.schedule.consecutiveMisses).toBe(1);
    expect(caught.schedule.nextWindow).toBe("2026-01-13T14:00:00.000Z");
    expect(caught.missedLastRun).toEqual({
      at: "2026-01-06T17:00:00.000Z",
      outcome: "missed",
    });
  });

  test("multiple elapsed windows count one miss each and land on a live one", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      undefined,
      at("2026-01-27T15:00:00.000Z"),
    );
    expect(caught.missedWindows).toBe(3);
    expect(caught.schedule.consecutiveMisses).toBe(3);
    // The wake landed inside window 3, so it is attempted immediately rather
    // than replayed from a stale past one.
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
    expect(caught.dueWindow?.index).toBe(3);
    // The most recent elapsed window holds the miss.
    expect(caught.missedLastRun).toEqual({
      at: "2026-01-20T17:00:00.000Z",
      outcome: "missed",
    });
  });

  test("a wake between windows advances to the first window still to open", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      undefined,
      at("2026-01-28T00:00:00.000Z"),
    );
    expect(caught.missedWindows).toBe(4);
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    expect(caught.dueWindow).toBeUndefined();
    expect(caught.missedLastRun?.at).toBe("2026-01-27T17:00:00.000Z");
  });

  test("the count includes the elapsed windows on top of the stored one", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, consecutiveMisses: 2 },
      undefined,
      at("2026-01-20T18:00:00.000Z"),
    );
    expect(caught.missedWindows).toBe(3);
    expect(caught.schedule.consecutiveMisses).toBe(5);
  });

  test("a success inside an elapsed window resets the count the later misses build on", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      { at: "2026-01-13T15:00:00.000Z", outcome: "succeeded" },
      at("2026-01-28T00:00:00.000Z"),
    );
    // Windows 0, 2 and 3 passed unattempted; window 1's success wiped the count
    // that window 0 had built, so only the two after it remain.
    expect(caught.missedWindows).toBe(3);
    expect(caught.schedule.consecutiveMisses).toBe(2);
    expect(caught.missedLastRun?.at).toBe("2026-01-27T17:00:00.000Z");
  });

  test("a run in the most recent elapsed window keeps its own bookkeeping", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      { at: "2026-01-27T15:00:00.000Z", outcome: "succeeded" },
      at("2026-01-28T00:00:00.000Z"),
    );
    expect(caught.schedule.consecutiveMisses).toBe(0);
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    // Three windows were missed, but the newest bookkeeping is the run's own
    // success, so the wake writes no miss over it.
    expect(caught.missedWindows).toBe(3);
    expect(caught.missedLastRun).toBeUndefined();
  });

  test("a handshake that ran and failed in an elapsed window is not a miss", () => {
    const caught = catchUpManagedSchedule(
      {
        ...weekly,
        nextWindow: "2026-01-27T14:00:00.000Z",
        consecutiveMisses: 2,
      },
      { at: "2026-01-27T15:00:00.000Z", outcome: "failed" },
      at("2026-01-28T00:00:00.000Z"),
    );
    expect(caught.missedWindows).toBe(0);
    expect(caught.schedule.consecutiveMisses).toBe(2);
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    expect(caught.missedLastRun).toBeUndefined();
  });

  test("a recorded miss in an elapsed window counts once, not twice", () => {
    const caught = catchUpManagedSchedule(
      {
        ...weekly,
        nextWindow: "2026-01-27T14:00:00.000Z",
        consecutiveMisses: 1,
      },
      { at: "2026-01-27T15:00:00.000Z", outcome: "missed" },
      at("2026-01-28T00:00:00.000Z"),
    );
    expect(caught.schedule.consecutiveMisses).toBe(2);
    expect(caught.missedWindows).toBe(0);
  });

  test("a success inside the open window satisfies it and is advanced past", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-27T14:00:00.000Z" },
      { at: "2026-01-27T15:00:00.000Z", outcome: "succeeded" },
      at("2026-01-27T15:30:00.000Z"),
    );
    expect(caught.dueWindow).toBeUndefined();
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    expect(caught.missedWindows).toBe(0);
    expect(caught.schedule.consecutiveMisses).toBe(0);
  });

  test("a success inside the open window resets the count the elapsed misses raised", () => {
    const caught = catchUpManagedSchedule(
      {
        ...weekly,
        nextWindow: "2026-01-20T14:00:00.000Z",
        consecutiveMisses: 3,
      },
      { at: "2026-01-27T15:00:00.000Z", outcome: "succeeded" },
      at("2026-01-27T15:30:00.000Z"),
    );
    // Window 2 passed unattempted and raised the stored count to four; window 3
    // is still open and its recorded success discharges it, so the same reset a
    // success in an elapsed window earns applies here too.
    expect(caught.schedule.consecutiveMisses).toBe(0);
    expect(caught.missedWindows).toBe(1);
    expect(caught.dueWindow).toBeUndefined();
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    // Window 2's miss is real bookkeeping the record never recorded; the write
    // path is what holds `lastRun` monotonic against the newer success.
    expect(caught.missedLastRun).toEqual({
      at: "2026-01-20T17:00:00.000Z",
      outcome: "missed",
    });
  });

  test("a run recorded in a window that has not opened does not discharge it", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-27T14:00:00.000Z" },
      { at: "2026-01-27T15:00:00.000Z", outcome: "succeeded" },
      at("2026-01-26T00:00:00.000Z"),
    );
    // A stamp ahead of the wake instant means a clock moved, not a window met.
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
    expect(caught.dueWindow).toBeUndefined();
    expect(caught.missedWindows).toBe(0);
  });

  test("a success stamped ahead of the wake does not discharge the open window", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-27T14:00:00.000Z" },
      { at: "2026-01-27T16:30:00.000Z", outcome: "succeeded" },
      at("2026-01-27T14:00:00.000Z"),
    );
    // Two and a half hours ahead of the wake, inside the window that has just
    // opened: a forward-skewed clock or an edited record, not a window met, so
    // the window is attempted rather than silently advanced past.
    expect(caught.dueWindow?.index).toBe(3);
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
    expect(caught.missedWindows).toBe(0);
    expect(caught.schedule.consecutiveMisses).toBe(0);

    // The boundary: a stamp at the wake instant itself is a run that just
    // happened, and discharges the window as any earlier one does.
    const atWake = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-27T14:00:00.000Z" },
      { at: "2026-01-27T14:30:00.000Z", outcome: "succeeded" },
      at("2026-01-27T14:30:00.000Z"),
    );
    expect(atWake.dueWindow).toBeUndefined();
    expect(atWake.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
  });

  test("a failure inside the open window leaves the rest of it attemptable", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-27T14:00:00.000Z" },
      { at: "2026-01-27T15:00:00.000Z", outcome: "failed" },
      at("2026-01-27T15:30:00.000Z"),
    );
    expect(caught.dueWindow?.index).toBe(3);
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
  });

  test("run bookkeeping with an unusable stamp is read as no run at all", () => {
    const caught = catchUpManagedSchedule(
      weekly,
      { at: "last Tuesday", outcome: "succeeded" },
      at("2026-01-06T17:00:00.000Z"),
    );
    // The conservative direction: an extra miss counted, never one suppressed.
    expect(caught.missedWindows).toBe(1);
    expect(caught.schedule.consecutiveMisses).toBe(1);
  });

  test("a planned window off the lattice is not recounted", () => {
    const caught = catchUpManagedSchedule(
      { ...weekly, nextWindow: "2026-01-13T14:00:00.001Z" },
      undefined,
      at("2026-01-20T18:00:00.000Z"),
    );
    // Window 1 is covered by the stored instant, so only window 2 is elapsed and
    // unaccounted for.
    expect(caught.missedWindows).toBe(1);
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
  });

  test("the walk reports the plan it read, verbatim", () => {
    // What the bookkeeping write is conditioned on: the stored instant and count
    // this walk computed against, not the ones it computed.
    const stored = {
      ...weekly,
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 2,
    };
    const caught = catchUpManagedSchedule(
      stored,
      undefined,
      at("2026-01-20T18:00:00.000Z"),
    );
    expect(caught.fromNextWindow).toBe(stored.nextWindow);
    expect(caught.fromConsecutiveMisses).toBe(stored.consecutiveMisses);
    expect(caught.schedule.nextWindow).toBe("2026-01-27T14:00:00.000Z");
    expect(caught.schedule.consecutiveMisses).toBe(4);
  });

  test("does not mutate the schedule it reads", () => {
    const schedule = { ...weekly };
    catchUpManagedSchedule(schedule, undefined, at("2026-02-10T00:00:00.000Z"));
    expect(schedule).toEqual(weekly);
  });

  test("years of dormancy count one miss per window all the way to a live one", () => {
    const daily: ManagedExchangeSchedule = {
      anchor: "2020-01-06T14:00:00.000Z",
      intervalDays: 1,
      windowSeconds: 10_800,
      nextWindow: "2020-01-06T14:00:00.000Z",
      consecutiveMisses: 0,
    };
    const caught = catchUpManagedSchedule(
      daily,
      undefined,
      at("2026-01-06T15:00:00.000Z"),
    );
    // Six years of daily windows, two of them leap years: 2192 windows opened
    // and closed before the one the wake landed inside.
    expect(caught.missedWindows).toBe(2192);
    expect(caught.schedule.consecutiveMisses).toBe(2192);
    expect(caught.dueWindow?.index).toBe(2192);
    expect(caught.schedule.nextWindow).toBe("2026-01-06T14:00:00.000Z");
    expect(caught.missedLastRun?.at).toBe("2026-01-05T17:00:00.000Z");
  });

  test("a span no stored cadence produces is refused rather than walked", () => {
    // An anchor at the far end of the representable range: past the schema, but
    // the arithmetic answers for a hand-edited record too, and a wake must not
    // spend the run of windows such an anchor implies.
    expect(() =>
      catchUpManagedSchedule(
        {
          ...weekly,
          anchor: "-271821-04-20T00:00:00.000Z",
          intervalDays: 1,
          nextWindow: "-271821-04-20T00:00:00.000Z",
        },
        undefined,
        at("2026-01-06T14:00:00.000Z"),
      ),
    ).toThrow(RangeError);
  });

  test("a wake instant that is not a usable one is refused", () => {
    for (const nowMs of [Number.NaN, Infinity, -Infinity, 9e15])
      expect(() => catchUpManagedSchedule(weekly, undefined, nowMs)).toThrow(
        RangeError,
      );
  });

  describe("a run recorded in the window the plan already advanced past", () => {
    /** The plan a window ago: window 0 accounted for, window 1 planned, one miss
     * standing. This is where the schedule sits after a window whose single-writer
     * lock was held by another context -- advanced past it while that context's
     * run was still in flight. */
    const advancedPastWindowZero: ManagedExchangeSchedule = {
      ...weekly,
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 1,
    };

    test("ends the miss run when that run succeeded", () => {
      const caught = catchUpManagedSchedule(
        advancedPastWindowZero,
        { at: "2026-01-06T14:40:00.000Z", outcome: "succeeded" },
        at("2026-01-06T18:00:00.000Z"),
      );
      // The count is a run of consecutive windows the two runners did not meet
      // in, and window 0 is one they did -- whether or not the plan had already
      // moved on when the evidence landed.
      expect(caught.schedule.consecutiveMisses).toBe(0);
      expect(caught.schedule.nextWindow).toBe("2026-01-13T14:00:00.000Z");
      expect(caught.missedWindows).toBe(0);
    });

    test("leaves the count alone when that run did not succeed", () => {
      for (const outcome of ["missed", "failed"] as const)
        expect(
          catchUpManagedSchedule(
            advancedPastWindowZero,
            { at: "2026-01-06T14:40:00.000Z", outcome },
            at("2026-01-06T18:00:00.000Z"),
          ).schedule.consecutiveMisses,
        ).toBe(1);
    });

    test("reaches back exactly one window, never over a run of counted misses", () => {
      // A success two windows back cannot discharge the window between it and
      // the plan: that window was walked and counted on its own evidence, and
      // the count the walk built stands.
      const caught = catchUpManagedSchedule(
        { ...advancedPastWindowZero, nextWindow: "2026-01-20T14:00:00.000Z" },
        { at: "2026-01-06T14:40:00.000Z", outcome: "succeeded" },
        at("2026-01-20T15:00:00.000Z"),
      );
      expect(caught.schedule.consecutiveMisses).toBe(1);
      expect(caught.dueWindow?.index).toBe(2);
    });
  });
});

describe("catch-up on the import path", () => {
  const linkageTerms = getDefaultLinkageTerms("County Health Dept");

  function recordWith(
    schedule: ManagedExchangeSchedule,
  ): ManagedExchangeRecord {
    return buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
      schedule,
      lastRun: { at: "2026-01-13T15:00:00.000Z", outcome: "succeeded" },
    });
  }

  test("a restored backup's stale plan catches up exactly as an ordinary wake", () => {
    const stale: ManagedExchangeSchedule = {
      ...weekly,
      nextWindow: "2026-01-06T14:00:00.000Z",
      consecutiveMisses: 1,
    };
    const source = recordWith(stale);
    const restored = reconstructRecordFromArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // The artifact holds the snapshot's schedule and bookkeeping verbatim, so
    // the first wake after an import has the same inputs the source had.
    expect(requireSchedule(restored)).toEqual(stale);
    expect(restored.lastRun).toEqual(source.lastRun);

    const now = at("2026-01-28T00:00:00.000Z");
    const caught = catchUpManagedSchedule(
      requireSchedule(restored),
      restored.lastRun,
      now,
    );
    expect(caught).toEqual(catchUpManagedSchedule(stale, source.lastRun, now));
    // The restored record lands on a live window rather than replaying the
    // months the artifact sat outside the browser.
    expect(caught.schedule.nextWindow).toBe("2026-02-03T14:00:00.000Z");
    expect(caught.missedWindows).toBe(3);
    expect(caught.schedule.consecutiveMisses).toBe(2);
  });
});

describe("resolveLocalCadenceAnchor", () => {
  test("resolves a local wall-clock cadence through the host zone's offset", () => {
    withTimeZone("America/New_York", () => {
      // 3 March 2026 is before the transition, 17 March after it: the SAME
      // wall-clock cadence resolves to two different UTC times of day, which is
      // why the anchor is resolved once at save and never per window.
      expect(
        resolveLocalCadenceAnchor({
          year: 2026,
          month: 3,
          day: 3,
          hour: 9,
          minute: 0,
        }),
      ).toBe("2026-03-03T14:00:00.000Z");
      expect(
        resolveLocalCadenceAnchor({
          year: 2026,
          month: 3,
          day: 17,
          hour: 9,
          minute: 0,
        }),
      ).toBe("2026-03-17T13:00:00.000Z");
    });
  });

  test("a UTC host resolves the wall clock unchanged", () => {
    withTimeZone("UTC", () => {
      expect(
        resolveLocalCadenceAnchor({
          year: 2026,
          month: 3,
          day: 3,
          hour: 9,
          minute: 30,
        }),
      ).toBe("2026-03-03T09:30:00.000Z");
    });
  });

  test("a two-digit year is that year, not the 1900s", () => {
    withTimeZone("UTC", () => {
      expect(
        resolveLocalCadenceAnchor({
          year: 26,
          month: 1,
          day: 6,
          hour: 0,
          minute: 0,
        }),
      ).toBe("0026-01-06T00:00:00.000Z");
    });
  });

  test("a leap day is read against its own year", () => {
    withTimeZone("UTC", () => {
      expect(
        resolveLocalCadenceAnchor({
          year: 2028,
          month: 2,
          day: 29,
          hour: 9,
          minute: 0,
        }),
      ).toBe("2028-02-29T09:00:00.000Z");
    });
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 2,
        day: 29,
        hour: 9,
        minute: 0,
      }),
    ).toThrow(RangeError);
  });

  test("a resolution the stored instant form cannot hold is refused", () => {
    const lateInYear9999 = {
      year: 9999,
      month: 12,
      day: 31,
      hour: 21,
      minute: 0,
    };
    withTimeZone("America/New_York", () => {
      // The resolution really does leave the form, so nothing here passes
      // vacuously: a zone behind UTC puts that wall clock into year 10000,
      // which renders only as the expanded-year ISO string.
      const expanded = new Date(9999, 11, 31, 21, 0, 0, 0).toISOString();
      expect(expanded).toBe("+010000-01-01T02:00:00.000Z");
      // Why returning it would be wrong rather than merely unusual: the record's
      // own validator refuses it, so the anchor would show up as a validation
      // failure at the write instead of a RangeError at the entry surface.
      expect(
        scheduleSchema.safeParse({ ...weekly, anchor: expanded }).success,
      ).toBe(false);
      expect(() => resolveLocalCadenceAnchor(lateInYear9999)).toThrow(
        RangeError,
      );
    });
    // The same cadence in a zone ahead of UTC stays inside the form, so it is
    // the resolved instant that is refused rather than the year entered.
    withTimeZone("Asia/Kolkata", () => {
      expect(resolveLocalCadenceAnchor(lateInYear9999)).toBe(
        "9999-12-31T15:30:00.000Z",
      );
    });
  });

  test("a date the calendar does not have is refused, not rolled over", () => {
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 2,
        day: 30,
        hour: 9,
        minute: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 13,
        day: 1,
        hour: 9,
        minute: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 3,
        day: 3,
        hour: 24,
        minute: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 3,
        day: 3,
        hour: 9,
        minute: 60,
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveLocalCadenceAnchor({
        year: 2026,
        month: 3,
        day: 3.5,
        hour: 9,
        minute: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("localCadenceFromAnchor", () => {
  test("reads a stored anchor back on the host zone's own clock", () => {
    withTimeZone("America/New_York", () => {
      expect(localCadenceFromAnchor("2026-03-03T14:00:00.000Z")).toEqual({
        year: 2026,
        month: 3,
        day: 3,
        hour: 9,
        minute: 0,
      });
    });
    withTimeZone("UTC", () => {
      expect(localCadenceFromAnchor("2026-03-03T14:00:00.000Z")).toEqual({
        year: 2026,
        month: 3,
        day: 3,
        hour: 14,
        minute: 0,
      });
    });
    // A zone whose offset is not a whole hour, so a reading that dropped the
    // minutes of the offset would show here.
    withTimeZone("Asia/Kolkata", () => {
      expect(localCadenceFromAnchor("2026-03-03T14:00:00.000Z")).toEqual({
        year: 2026,
        month: 3,
        day: 3,
        hour: 19,
        minute: 30,
      });
    });
  });

  test("the reading and the resolution invert each other", () => {
    // What re-opening the entry form on a stored schedule rests on: the cadence
    // shown is the one that was entered, and a save that changes nothing lands on
    // the same anchor.
    withTimeZone("America/New_York", () => {
      for (const anchor of [
        "2026-03-03T14:00:00.000Z",
        "2026-03-17T13:00:00.000Z",
        "2026-12-25T00:30:00.000Z",
      ])
        expect(resolveLocalCadenceAnchor(localCadenceFromAnchor(anchor))).toBe(
          anchor,
        );
    });
  });

  test("reads to the minute, so an anchor finer than that does not round-trip", () => {
    // The cadence holds no seconds, which is why an entry surface holding a
    // stored anchor at this resolution passes it through rather than resolving
    // the reading back (see ../../src/recurring/scheduleEntryModel.ts).
    withTimeZone("UTC", () => {
      const cadence = localCadenceFromAnchor("2026-03-03T14:00:30.500Z");
      expect(cadence).toEqual({
        year: 2026,
        month: 3,
        day: 3,
        hour: 14,
        minute: 0,
      });
      expect(resolveLocalCadenceAnchor(cadence)).toBe(
        "2026-03-03T14:00:00.000Z",
      );
    });
  });

  test("an hour the zone repeats does not round-trip either, which is the zone's doing", () => {
    // 2026 US daylight saving ends on 1 November: 01:30 local names two instants,
    // 05:30Z before the shift and 06:30Z after it. Both read back as the same
    // wall clock, so resolving that reading picks one of them -- the documented
    // exception to the inversion above, and the second reason an unrelated save
    // must not re-resolve an anchor nobody edited.
    withTimeZone("America/New_York", () => {
      const beforeShift = "2026-11-01T05:30:00.000Z";
      const afterShift = "2026-11-01T06:30:00.000Z";
      expect(localCadenceFromAnchor(afterShift)).toEqual(
        localCadenceFromAnchor(beforeShift),
      );
      expect(
        resolveLocalCadenceAnchor(localCadenceFromAnchor(afterShift)),
      ).toBe(beforeShift);
    });
  });

  test("an anchor that is not a usable stored instant is refused, not read", () => {
    for (const anchor of [
      "the third of March",
      "",
      // No UTC designator: read against the host zone it would name a different
      // moment on every machine, so it is refused rather than assumed.
      "2026-03-03T14:00:00",
    ])
      expect(() => localCadenceFromAnchor(anchor)).toThrow(RangeError);
  });
});
