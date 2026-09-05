import { describe, expect, test } from "vitest";

import { SftpAdapterLedger } from "../../../src/connection/sftpAdapterLedger";
import type { IdleBoundaryOutcome } from "../../../src/connection/sftpAdapterLedger";
import {
  IDLE_BOUNDARY_ENDS_THE_GENERATION,
  IDLE_BOUNDARY_SESSION_READING,
  SESSION_BOUNDARY_READINGS,
  idleBoundarySessionReading,
} from "../../../src/connection/sftpIdleBoundary";
import type { SessionBoundary } from "../../../src/connection/sftpIdleBoundary";

// The idle-boundary classification: three tables over one recorded outcome, and
// the lookup the adapter's record site reads the first of them through. Real
// server behavior per boundary variant is driven in
// test/integration/ephemeralSessionExchange.test.ts and
// heldSessionWithheldClose.test.ts. This file checks that each table stays
// total over its key type, matching the partition the ledger itself owns.

const ledger = (): SftpAdapterLedger =>
  new SftpAdapterLedger({ warn: () => {} });

const outcomes = Object.keys(
  IDLE_BOUNDARY_ENDS_THE_GENERATION,
) as IdleBoundaryOutcome[];

// The reading a boundary leaves standing, which for an outcome that moves none
// is the classification already recorded rather than a default.
const readingAfter = (
  outcome: IdleBoundaryOutcome,
  standing: SessionBoundary,
): SessionBoundary => {
  const reading = idleBoundarySessionReading(outcome);
  return reading === "unchanged" ? standing : reading;
};

describe("the boundary tables are total over their key types", () => {
  test("every idle-boundary outcome the ledger counts has a row in both", () => {
    const counted = Object.keys(ledger().accounting.boundaries).sort();
    expect(Object.keys(IDLE_BOUNDARY_SESSION_READING).sort()).toEqual(counted);
    expect(Object.keys(IDLE_BOUNDARY_ENDS_THE_GENERATION).sort()).toEqual(
      counted,
    );
  });

  // A fourth variant compiles only once the readings table answers both
  // questions for it, and reaches an operator's accounting only once this list
  // and the per-variant answers below say what those are.
  test("every boundary variant a projection names has both answers", () => {
    const variants = Object.keys(SESSION_BOUNDARY_READINGS);
    expect(variants.slice().sort()).toEqual([
      "deliberatelyReleased",
      "notReleased",
      "releasedOverEndedTransport",
    ]);
    for (const outcome of outcomes) {
      const reading = idleBoundarySessionReading(outcome);
      if (reading !== "unchanged") expect(variants).toContain(reading);
    }
  });

  test("the lookup is the projection table", () => {
    for (const outcome of outcomes)
      expect(idleBoundarySessionReading(outcome)).toBe(
        IDLE_BOUNDARY_SESSION_READING[outcome],
      );
  });
});

describe("a reading answers two separate questions", () => {
  test("a deliberate release took the session and its loss is this side's", () => {
    expect(SESSION_BOUNDARY_READINGS.deliberatelyReleased).toEqual({
      releaseTookTheSession: true,
      lossWasDeliberate: true,
    });
  });

  test("a release over an ended transport took the session, not the loss", () => {
    expect(SESSION_BOUNDARY_READINGS.releasedOverEndedTransport).toEqual({
      releaseTookTheSession: true,
      lossWasDeliberate: false,
    });
  });

  test("a boundary no release took answers neither", () => {
    expect(SESSION_BOUNDARY_READINGS.notReleased).toEqual({
      releaseTookTheSession: false,
      lossWasDeliberate: false,
    });
  });

  // Reading one question off the other is the misreport the middle variant
  // exists to stop: a release that closed over a partner's drop took the session
  // exactly as any other did, while the loss stays the partner's.
  test("exactly one variant answers the two questions differently", () => {
    const disagreeing = Object.entries(SESSION_BOUNDARY_READINGS)
      .filter(
        ([, readings]) =>
          readings.releaseTookTheSession !== readings.lossWasDeliberate,
      )
      .map(([variant]) => variant);
    expect(disagreeing).toEqual(["releasedOverEndedTransport"]);
  });

  // The forcing says how the boundary concluded, not who ended the transport
  // beneath it, so the loss it charges is the entry classification's answer.
  test("a forced boundary charges the reading already standing", () => {
    expect(readingAfter("forced", "releasedOverEndedTransport")).toBe(
      "releasedOverEndedTransport",
    );
    expect(readingAfter("forced", "deliberatelyReleased")).toBe(
      "deliberatelyReleased",
    );
  });
});

describe("ending a generation agrees with the ledger's accounting", () => {
  test.each(outcomes)(
    "a %s boundary charges the ledger what the table says it ended",
    (outcome) => {
      const sessions = ledger();
      const generation = sessions.dialSucceeded();
      sessions.countBoundary(outcome);
      if (!IDLE_BOUNDARY_ENDS_THE_GENERATION[outcome]) {
        expect(sessions.accounting.liveGeneration).toBe(generation);
        expect(sessions.accounting.generationsEnded).toBe(0);
        return;
      }
      const deliberate =
        SESSION_BOUNDARY_READINGS[readingAfter(outcome, "notReleased")]
          .lossWasDeliberate;
      expect(
        sessions.recordLoss(generation, deliberate ? "deliberate" : "partner"),
      ).toBe(true);
      expect(sessions.accounting.liveGeneration).toBeUndefined();
      expect(sessions.accounting.generationsEnded).toBe(1);
      // The ledger raises on a dial over a generation whose end nothing
      // recorded, so the next poll cycle is where a boundary wrongly marked as
      // ending nothing would show up.
      expect(() => sessions.dialSucceeded()).not.toThrow();
    },
  );

  test("a generation ends for the five outcomes that took a live session", () => {
    const ends = outcomes.filter(
      (outcome) => IDLE_BOUNDARY_ENDS_THE_GENERATION[outcome],
    );
    expect(ends.sort()).toEqual([
      "closedByPeer",
      "forced",
      "noSession",
      "released",
      "releasedOverEndedTransport",
    ]);
  });
});
