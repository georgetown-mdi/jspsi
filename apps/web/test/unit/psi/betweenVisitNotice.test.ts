import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  REPEATED_MISS_TITLE,
  SINGLE_COLUMN_DELIMITER_REMEDY,
} from "@psi/managed/managedFailureCopy";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";

import { managedRunTierFailure } from "@recurring/managedRunLaunchModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managed/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managed/managedLocalStateShape";

// What the installed runtime says between visits, read off the same bookkeeping the
// next visit reads: one notice per moment the design names, silence everywhere else,
// and a tag that fires an occurrence once and holds a standing state to one notice.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";
const NEXT_WINDOW = "2026-07-15T09:00:00.000Z";

function schedule(
  overrides: Partial<ManagedExchangeSchedule> = {},
): ManagedExchangeSchedule {
  return {
    anchor: "2026-07-01T09:00:00.000Z",
    intervalDays: 1,
    windowSeconds: 3600,
    nextWindow: NEXT_WINDOW,
    consecutiveMisses: 0,
    ...overrides,
  };
}

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "riverbend",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    schedule: schedule(),
    ...overrides,
  };
}

function failed(
  failureKind: ManagedExchangeLastRun["failureKind"],
): ManagedExchangeLastRun {
  return { at: RUN_AT, outcome: "failed", failureKind };
}

/** The in-app alert's title for a tier, which the notification's title holds to. */
function alertTitle(tier: ManagedFailureTier): string {
  const failure = managedRunTierFailure(tier, record());
  if (!("title" in failure))
    throw new Error(`the ${tier} tier has no alert title`);
  return failure.title;
}

describe("betweenVisitNotice: the completed run", () => {
  test("a run that staled the backup prompts the re-export", () => {
    const notice = betweenVisitNotice({
      record: record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "succeeded",
      now: NOW,
    });

    expect(notice?.kind).toBe("backup");
    expect(notice?.body).toContain("Riverbend quarterly");
    expect(notice?.body).toContain("back up this exchange");
  });

  test("a run whose backup is current says nothing", () => {
    const local: ManagedLocalState = { backup: { backedUpAt: RUN_AT } };

    expect(
      betweenVisitNotice({
        record: record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }),
        local,
        caughtUpMisses: 0,
        disposition: "succeeded",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("each run is its own occurrence, so two runs produce two tags", () => {
    const first = betweenVisitNotice({
      record: record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "succeeded",
      now: NOW,
    });
    const second = betweenVisitNotice({
      record: record({
        lastRun: { at: "2026-07-15T09:00:00.000Z", outcome: "succeeded" },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "succeeded",
      now: NOW,
    });

    expect(first?.tag).not.toBe(second?.tag);
  });
});

describe("betweenVisitNotice: the missed window", () => {
  test("one miss is informational and names the next window", () => {
    const notice = betweenVisitNotice({
      record: record({
        schedule: schedule({ consecutiveMisses: 1 }),
        lastRun: { at: RUN_AT, outcome: "missed" },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "missed",
      now: NOW,
    });

    expect(notice?.kind).toBe("missed");
    expect(notice?.body).toContain("Nothing to do");
    expect(notice?.body).toContain("next window opens");
  });

  test("the escalation threshold turns the copy into the coordination prompt", () => {
    const notice = betweenVisitNotice({
      record: record({
        schedule: schedule({ consecutiveMisses: 2 }),
        lastRun: { at: RUN_AT, outcome: "missed" },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "missed",
      now: NOW,
    });

    expect(notice?.kind).toBe("repeated-misses");
    expect(notice?.title).toBe(REPEATED_MISS_TITLE);
    expect(notice?.body).toContain("check with your partner");
    expect(notice?.body).toContain("check this device's clock");
  });

  test("the escalated tag names the standing state, not the window", () => {
    const escalated = (consecutiveMisses: number, nextWindow: string) =>
      betweenVisitNotice({
        record: record({
          schedule: schedule({ consecutiveMisses, nextWindow }),
        }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "missed",
        now: NOW,
      })?.tag;

    expect(escalated(2, NEXT_WINDOW)).toBe(
      escalated(3, "2026-07-16T09:00:00.000Z"),
    );
  });

  test("windows elapsed while the runtime was away earn one notice", () => {
    const notice = betweenVisitNotice({
      record: record({ schedule: schedule({ consecutiveMisses: 4 }) }),
      local: undefined,
      caughtUpMisses: 4,
      now: NOW,
    });

    expect(notice?.kind).toBe("repeated-misses");
    expect(notice?.body).toContain("4 scheduled runs in a row");
  });
});

describe("betweenVisitNotice: the window an answer held back", () => {
  /** The record a skipped window leaves: the answered condition, and the window's
   * own outcome where a run's would have been. */
  function skipped(): ManagedExchangeRecord {
    return record({
      lastRun: { at: RUN_AT, outcome: "skipped" },
      standingCondition: {
        since: "2026-07-13T09:00:00.000Z",
        kind: "auth",
        response: { kind: "compromise", at: "2026-07-13T10:00:00.000Z" },
      },
    });
  }

  test("names the exchange, what stopped the run, and the way back", () => {
    const notice = betweenVisitNotice({
      record: skipped(),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "skipped",
      now: NOW,
    });

    expect(notice?.kind).toBe("skipped");
    expect(notice?.body).toContain("Riverbend quarterly");
    expect(notice?.body).toContain("something did not add up");
    expect(notice?.body).toContain("clear it");
  });

  test("is not the miss notice, whatever the misses beside it", () => {
    const notice = betweenVisitNotice({
      record: skipped(),
      local: undefined,
      // A wake that found windows elapsed before this one still reports the
      // answer holding the schedule, not another quiet miss.
      caughtUpMisses: 3,
      disposition: "skipped",
      now: NOW,
    });

    expect(notice?.kind).toBe("skipped");
  });

  test("holds every window it skips to one notice: the tag is the standing state", () => {
    const first = betweenVisitNotice({
      record: skipped(),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "skipped",
      now: NOW,
    });
    const second = betweenVisitNotice({
      record: record({
        lastRun: { at: "2026-07-15T09:00:00.000Z", outcome: "skipped" },
        standingCondition: {
          since: "2026-07-13T09:00:00.000Z",
          kind: "auth",
          response: { kind: "compromise", at: "2026-07-13T10:00:00.000Z" },
        },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "skipped",
      now: NOW,
    });

    expect(first?.tag).toBe(second?.tag);
  });
});

describe("betweenVisitNotice: the failures that need the operator", () => {
  const cases: Array<{
    tier: ManagedFailureTier;
    lastRun: ManagedExchangeLastRun;
    local?: ManagedLocalState;
  }> = [
    { tier: "input", lastRun: failed("input") },
    { tier: "terms-shortfall", lastRun: failed("terms-shortfall") },
    { tier: "consent", lastRun: failed("consent") },
    { tier: "too-large", lastRun: failed("too-large") },
    { tier: "unexplained", lastRun: failed("auth") },
  ];

  for (const { tier, lastRun } of cases)
    test(`the ${tier} tier reports in the next visit's own words`, () => {
      const notice = betweenVisitNotice({
        record: record({ lastRun }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      });

      expect(notice?.kind).toBe(tier);
      expect(notice?.title).toBe(alertTitle(tier));
      expect(notice?.tag).toContain(tier);
    });

  test("a standing state's tag repeats, so the next window says nothing more", () => {
    const tagFor = (at: string) =>
      betweenVisitNotice({
        record: record({ lastRun: { ...failed("input"), at } }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      })?.tag;

    expect(tagFor(RUN_AT)).toBe(tagFor("2026-07-15T09:00:00.000Z"));
  });

  test("a stamped one-column shortfall states the delimiter remedy", () => {
    // The generic shortfall copy sends the operator to renegotiate terms with
    // their partner, which is the wrong move for a file separated by something
    // other than the delimiter this record reads it by.
    const notice = betweenVisitNotice({
      record: record({
        lastRun: { ...failed("terms-shortfall"), singleColumnInput: true },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });

    expect(notice?.kind).toBe("terms-shortfall");
    expect(notice?.title).toBe(alertTitle("terms-shortfall"));
    expect(notice?.body).toContain("read as a single column");
    expect(notice?.body).toContain(SINGLE_COLUMN_DELIMITER_REMEDY);
    expect(notice?.body).not.toContain("covers every agreed key");
  });

  test("a shortfall with no stamped reading keeps the agreed-keys copy", () => {
    const notice = betweenVisitNotice({
      record: record({ lastRun: failed("terms-shortfall") }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });

    expect(notice?.body).toContain("covers every agreed key");
    expect(notice?.body).not.toContain(SINGLE_COLUMN_DELIMITER_REMEDY);
  });

  test("the one-column reading fires its own notice over a plain shortfall", () => {
    // The two readings are different standing states with different remedies, so
    // the tag tells them apart: a shortfall that becomes a one-column reading
    // says so rather than being held to the notice already sent.
    const tagFor = (lastRun: ManagedExchangeLastRun) =>
      betweenVisitNotice({
        record: record({ lastRun }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      })?.tag;

    expect(
      tagFor({ ...failed("terms-shortfall"), singleColumnInput: true }),
    ).not.toBe(tagFor(failed("terms-shortfall")));
  });

  test("a failure a restore explains stays as quiet as it is in the app", () => {
    expect(
      betweenVisitNotice({
        record: record({ lastRun: failed("auth") }),
        local: { imported: { importedAt: RUN_AT } },
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("a transport drop is left to the next visit", () => {
    expect(
      betweenVisitNotice({
        record: record({ lastRun: failed("transport") }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("a desynced window reports the same notice as a failed one", () => {
    const forDisposition = (disposition: "failed" | "desynced") =>
      betweenVisitNotice({
        record: record({ lastRun: failed("auth") }),
        local: undefined,
        caughtUpMisses: 0,
        disposition,
        now: NOW,
      });

    expect(forDisposition("desynced")).toEqual(forDisposition("failed"));
  });
});

describe("betweenVisitNotice: everything else stays quiet", () => {
  test("a window another context held says nothing", () => {
    expect(
      betweenVisitNotice({
        record: record(),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "unattempted",
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("a wake with no window and no accrued miss says nothing", () => {
    expect(
      betweenVisitNotice({
        record: record(),
        local: undefined,
        caughtUpMisses: 0,
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("an unlabelled exchange is named without inventing one", () => {
    const notice = betweenVisitNotice({
      record: record({
        label: "",
        lastRun: { at: RUN_AT, outcome: "succeeded" },
      }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "succeeded",
      now: NOW,
    });

    expect(notice?.body).toContain("An unnamed exchange");
  });

  test("two exchanges in the same state hold tags of their own", () => {
    const tagFor = (id: string) =>
      betweenVisitNotice({
        record: record({ id, lastRun: failed("input") }),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      })?.tag;

    expect(tagFor("riverbend")).not.toBe(tagFor("lakeside"));
  });
});
