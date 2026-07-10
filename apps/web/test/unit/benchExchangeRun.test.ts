import { describe, expect, test } from "vitest";

import { CONFIRMING_PROTOCOL_STAGE_ID } from "@psilink/core";

import {
  BEFORE_START_STAGE_ID,
  DONE_STAGE_ID,
  WAITING_STAGE_ID,
  awaitingPartner,
  currentStageLabel,
  initialRun,
  progressPercent,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
  stagesFor,
  timeOfDayLabel,
  timelineSteps,
} from "@bench/exchangeRun";

import type { ExchangeRun } from "@bench/exchangeRun";
import type { PreparedExchange } from "@psilink/core";

// stagesFor and describeExchangeStages beneath it read only the linkage terms
// off the prepared exchange, so a terms-only stand-in exercises the real
// stage-tree derivation without preparing a full exchange.
function preparedWith(
  linkageStrategy: "cascade" | "single-pass",
  keyCount: number,
): PreparedExchange {
  return {
    linkageTerms: {
      linkageStrategy,
      linkageKeys: Array.from({ length: keyCount }, (_, i) => ({
        name: `key ${i + 1}`,
      })),
    },
  } as unknown as PreparedExchange;
}

function states(run: ExchangeRun): Array<string> {
  return timelineSteps(run).map((step) => `${step.label}:${step.state}`);
}

describe("stage trees", () => {
  test("the full tree carries pre-stages, protocol stages, and done", () => {
    const stages = stagesFor(preparedWith("cascade", 2));
    expect(stages.map((stage) => stage.id)).toEqual([
      BEFORE_START_STAGE_ID,
      WAITING_STAGE_ID,
      CONFIRMING_PROTOCOL_STAGE_ID,
      "stage 1 / 2",
      "stage 2 / 2",
      DONE_STAGE_ID,
    ]);
    expect(stages[1].label).toBe("Waiting for your partner");
    expect(stages[3].label).toBe("Linking key 1 / 2");
  });

  test("a single-pass tree has no per-key stages", () => {
    const ids = stagesFor(preparedWith("single-pass", 3)).map(
      (stage) => stage.id,
    );
    expect(ids).toEqual([
      BEFORE_START_STAGE_ID,
      WAITING_STAGE_ID,
      CONFIRMING_PROTOCOL_STAGE_ID,
      DONE_STAGE_ID,
    ]);
  });
});

describe("the timeline advances on stage events", () => {
  const at = (minute: number) => new Date(2026, 6, 8, 14, minute);

  function runToWaiting(): ExchangeRun {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 2)),
    );
    return runWithStage(seeded, WAITING_STAGE_ID, at(32));
  }

  test("before and while waiting, Share is the current step", () => {
    expect(states(initialRun())).toEqual([
      "Share:current",
      "Partner accepts:pending",
      "Confirm protocol:pending",
      "Link keys:pending",
      "Done:pending",
    ]);
    const waiting = runToWaiting();
    expect(states(waiting)[0]).toBe("Share:current");
    expect(awaitingPartner(waiting)).toBe(true);
    expect(currentStageLabel(waiting)).toBe("Waiting for your partner");
  });

  test("a protocol stage flips Share and Partner accepts to done at once", () => {
    const confirming = runWithStage(
      runToWaiting(),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    expect(states(confirming)).toEqual([
      "Share:done",
      "Partner accepts:done",
      "Confirm protocol:current",
      "Link keys:pending",
      "Done:pending",
    ]);
    expect(awaitingPartner(confirming)).toBe(false);
  });

  test("the per-key stages sit under Link keys", () => {
    const linking = runWithStage(
      runWithStage(runToWaiting(), CONFIRMING_PROTOCOL_STAGE_ID, at(39)),
      "stage 2 / 2",
      at(43),
    );
    expect(states(linking)[3]).toBe("Link keys:current");
    expect(currentStageLabel(linking)).toBe("Linking key 2 / 2");
  });

  test("completion finishes every step and pins the finish instant", () => {
    const done = runWithCompletion(
      runWithStage(runToWaiting(), CONFIRMING_PROTOCOL_STAGE_ID, at(39)),
      at(47),
    );
    expect(states(done)).toEqual([
      "Share:done",
      "Partner accepts:done",
      "Confirm protocol:done",
      "Link keys:done",
      "Done:done",
    ]);
    expect(done.finishedAt).toEqual(at(47));
    expect(progressPercent(done)).toBe(100);
    // The lifecycle never emits a "done" stage event, so completion must
    // synthesize the final label the live region announces.
    expect(currentStageLabel(done)).toBe("Done");
  });

  test("under single-pass, Link keys completes without ever being current", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("single-pass", 3)),
    );
    const confirming = runWithStage(
      runWithStage(seeded, WAITING_STAGE_ID, at(32)),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    expect(states(confirming)[3]).toBe("Link keys:pending");
    expect(states(runWithCompletion(confirming, at(41)))[3]).toBe(
      "Link keys:done",
    );
  });

  test("progress tracks the stage's position through the tree", () => {
    const waiting = runToWaiting();
    expect(progressPercent(initialRun())).toBe(0);
    expect(progressPercent(waiting)).toBe(20);
    expect(progressPercent(runWithStage(waiting, "stage 2 / 2", at(43)))).toBe(
      80,
    );
  });
});

describe("the visit history", () => {
  const at = (minute: number) => new Date(2026, 6, 8, 14, minute);

  test("advancing closes the open visit with its completion time", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 2)),
    );
    const run = runWithStage(
      runWithStage(seeded, WAITING_STAGE_ID, at(32)),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    expect(run.visits).toEqual([
      { id: BEFORE_START_STAGE_ID, label: "Before start", completedAt: at(32) },
      {
        id: WAITING_STAGE_ID,
        label: "Waiting for your partner",
        completedAt: at(39),
      },
      { id: CONFIRMING_PROTOCOL_STAGE_ID, label: "Confirming protocol" },
    ]);
  });

  test("a re-emitted stage id does not duplicate a history row", () => {
    const waiting = runWithStage(initialRun(), WAITING_STAGE_ID, at(32));
    expect(runWithStage(waiting, WAITING_STAGE_ID, at(33))).toBe(waiting);
  });

  test("a stage id outside the tree reads mid-protocol with itself as label", () => {
    const run = runWithStage(initialRun(), "surprise stage", at(32));
    expect(currentStageLabel(run)).toBe("surprise stage");
    expect(states(run)[3]).toBe("Link keys:current");
  });

  test("a stage id outside the tree holds the bar at the last known stage", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 2)),
    );
    const waiting = runWithStage(seeded, WAITING_STAGE_ID, at(32));
    expect(progressPercent(waiting)).toBe(20);
    expect(
      progressPercent(runWithStage(waiting, "surprise stage", at(33))),
    ).toBe(20);
  });

  test("failure freezes the run where it stands", () => {
    const waiting = runWithStage(initialRun(), WAITING_STAGE_ID, at(32));
    const failed = runWithFailure(waiting);
    expect(failed.failed).toBe(true);
    expect(failed.stageId).toBe(WAITING_STAGE_ID);
    expect(states(failed)).toEqual(states(waiting));
  });

  test("completion times render as a time of day", () => {
    expect(timeOfDayLabel(at(43))).toBe("2:43 PM");
  });
});
