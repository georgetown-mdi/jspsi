import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  advanceManagedScheduleAfterWindow,
  catchUpManagedSchedule,
  managedScheduleWindow,
  managedScheduleWindowStateAt,
  nextConsecutiveMisses,
  nextManagedScheduleWindowAfter,
  resolveLocalCadenceAnchor,
} from "@psi/managedSchedule";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  reconstructRecordFromArtifact,
} from "@psi/managedExchangeArtifact";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managedExchangeRecord";

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

/** Run `body` with the process time zone pinned, restoring whatever was set
 * before. Node resolves the zone per Date operation, so the pin takes effect
 * inside the call and leaks nothing after it. */
function withTimeZone<T>(zone: string, body: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
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
    const compute = () => ({
      window: managedScheduleWindow(march, 2),
      next: nextManagedScheduleWindowAfter(march, now),
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
    // The most recent elapsed window carries the miss.
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

  test("the count carries the elapsed windows on top of the stored one", () => {
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

  test("does not mutate the schedule it reads", () => {
    const schedule = { ...weekly };
    catchUpManagedSchedule(schedule, undefined, at("2026-02-10T00:00:00.000Z"));
    expect(schedule).toEqual(weekly);
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
    // The artifact carries the snapshot's schedule and bookkeeping verbatim, so
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
