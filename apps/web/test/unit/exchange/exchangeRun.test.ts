import { describe, expect, test } from "vitest";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  SINGLE_PASS_STAGE_IDS,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { minimalPreparedExchange } from "@psilink/core/testing";

import {
  BEFORE_START_STAGE_ID,
  DONE_STAGE_ID,
  WAITING_STAGE_ID,
  acceptorTimelineSteps,
  awaitingPartner,
  currentStageLabel,
  initialRun,
  progressPercent,
  psiProgressLabel,
  runWithCompletion,
  runWithFailure,
  runWithPsiProgress,
  runWithStage,
  runWithStages,
  stageIsKnown,
  stagesFor,
  timeOfDayLabel,
  timelineSteps,
} from "@exchange/exchangeRun";

import type {
  PreparedExchange,
  PsiOperation,
  PsiProgress,
} from "@psilink/core";
import type { ExchangeRun } from "@exchange/exchangeRun";

// stagesFor and describeExchangeStages beneath it read only the linkage terms
// off the prepared exchange, so a terms-only stand-in exercises the real
// stage-tree derivation without preparing a full exchange.
function preparedWith(
  linkageStrategy: "cascade" | "single-pass",
  keyCount: number,
): PreparedExchange {
  return minimalPreparedExchange({
    linkageTerms: {
      ...getDefaultLinkageTerms("Exchange-run fixture"),
      linkageStrategy,
      linkageKeys: Array.from({ length: keyCount }, (_, i) => ({
        name: `key ${i + 1}`,
        elements: [],
      })),
    },
  });
}

function states(run: ExchangeRun): Array<string> {
  return timelineSteps(run).map((step) => `${step.label}:${step.state}`);
}

describe("stage trees", () => {
  test("the full tree has pre-stages, protocol stages, and done", () => {
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
    expect(currentStageLabel(done)).toBe("Done");
  });

  test("the done stage id arriving as a stage event does not finish the run", () => {
    // core's single-pass path emits the terminal stage id as an ordinary stage
    // event, with the payload exchange and the result still to come, so the
    // label, the timeline, the progress bar and the finish instant all hang
    // on the result event.
    const running = runWithStage(
      runToWaiting(),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    const staged = runWithStage(running, DONE_STAGE_ID, at(44));
    expect(staged.finishedAt).toBeUndefined();
    expect(currentStageLabel(staged)).toBe("Confirming protocol");
    expect(states(staged)[4]).toBe("Done:pending");
    expect(progressPercent(staged)).toBe(40);
    const completed = runWithCompletion(staged, at(47));
    expect(completed.finishedAt).toEqual(at(47));
    expect(currentStageLabel(completed)).toBe("Done");
    expect(progressPercent(completed)).toBe(100);
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

  test("a single-pass run holds one done row, closed at completion", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("single-pass", 3)),
    );
    const confirming = runWithStage(
      runWithStage(seeded, WAITING_STAGE_ID, at(32)),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    // The stage event core's single-pass path emits at the end of linkage.
    expect(runWithStage(confirming, DONE_STAGE_ID, at(44))).toBe(confirming);
    const completed = runWithCompletion(confirming, at(47));
    expect(completed.visits).toEqual([
      { id: BEFORE_START_STAGE_ID, label: "Before start", completedAt: at(32) },
      {
        id: WAITING_STAGE_ID,
        label: "Waiting for your partner",
        completedAt: at(39),
      },
      {
        id: CONFIRMING_PROTOCOL_STAGE_ID,
        label: "Confirming protocol",
        completedAt: at(47),
      },
      { id: DONE_STAGE_ID, label: "Done", completedAt: at(47) },
    ]);
  });

  test("a cascade run holds one done row, closed at completion", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 2)),
    );
    const linking = runWithStage(
      runWithStage(
        runWithStage(seeded, WAITING_STAGE_ID, at(32)),
        CONFIRMING_PROTOCOL_STAGE_ID,
        at(39),
      ),
      "stage 2 / 2",
      at(43),
    );
    const completed = runWithCompletion(linking, at(47));
    expect(completed.visits.map((visit) => visit.id)).toEqual([
      BEFORE_START_STAGE_ID,
      WAITING_STAGE_ID,
      CONFIRMING_PROTOCOL_STAGE_ID,
      "stage 2 / 2",
      DONE_STAGE_ID,
    ]);
    expect(
      completed.visits.every((visit) => visit.completedAt !== undefined),
    ).toBe(true);
  });

  test("a stage id outside the tree is treated as mid-protocol with itself as label", () => {
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

describe("the acceptor timeline and labels", () => {
  const at = (minute: number) => new Date(2026, 6, 8, 14, minute);

  function acceptorStates(run: ExchangeRun): Array<string> {
    return acceptorTimelineSteps(run).map(
      (step) => `${step.label}:${step.state}`,
    );
  }

  function acceptorToWaiting(): ExchangeRun {
    const seeded = runWithStages(
      initialRun("acceptor"),
      stagesFor(preparedWith("cascade", 2), "acceptor"),
    );
    return runWithStage(seeded, WAITING_STAGE_ID, at(32));
  }

  test("the acceptor's waiting stage is labelled 'Connecting to your partner'", () => {
    const stages = stagesFor(preparedWith("cascade", 2), "acceptor");
    expect(stages[1].label).toBe("Connecting to your partner");
    // The initial-run tree (before prepare) has the same acceptor label.
    expect(currentStageLabel(acceptorToWaiting())).toBe(
      "Connecting to your partner",
    );
  });

  test("the acceptor rail is four steps: Connect, Confirm protocol, Link keys, Done", () => {
    expect(
      acceptorTimelineSteps(initialRun("acceptor")).map((step) => step.label),
    ).toEqual(["Connect", "Confirm protocol", "Link keys", "Done"]);
  });

  test("Connect stays current through before-start and the connecting wait", () => {
    expect(acceptorStates(initialRun("acceptor"))).toEqual([
      "Connect:current",
      "Confirm protocol:pending",
      "Link keys:pending",
      "Done:pending",
    ]);
    expect(acceptorStates(acceptorToWaiting())[0]).toBe("Connect:current");
  });

  test("a protocol stage flips Connect to done and Confirm protocol to current", () => {
    const confirming = runWithStage(
      acceptorToWaiting(),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    expect(acceptorStates(confirming)).toEqual([
      "Connect:done",
      "Confirm protocol:current",
      "Link keys:pending",
      "Done:pending",
    ]);
  });

  test("the per-key stages sit under Link keys", () => {
    const linking = runWithStage(
      runWithStage(acceptorToWaiting(), CONFIRMING_PROTOCOL_STAGE_ID, at(39)),
      "stage 2 / 2",
      at(43),
    );
    expect(acceptorStates(linking)[2]).toBe("Link keys:current");
    expect(currentStageLabel(linking)).toBe("Linking key 2 / 2");
  });

  test("completion finishes every acceptor step", () => {
    const done = runWithCompletion(
      runWithStage(acceptorToWaiting(), CONFIRMING_PROTOCOL_STAGE_ID, at(39)),
      at(47),
    );
    expect(acceptorStates(done)).toEqual([
      "Connect:done",
      "Confirm protocol:done",
      "Link keys:done",
      "Done:done",
    ]);
    expect(currentStageLabel(done)).toBe("Done");
  });

  test("the inviter's waiting label is unchanged by the acceptor parameterization", () => {
    expect(stagesFor(preparedWith("cascade", 2))[1].label).toBe(
      "Waiting for your partner",
    );
    expect(
      currentStageLabel(runWithStage(initialRun(), WAITING_STAGE_ID, at(32))),
    ).toBe("Waiting for your partner");
  });
});

describe("single-pass stage labels", () => {
  const at = (minute: number) => new Date(2026, 6, 8, 14, minute);

  function singlePassConfirming(): ExchangeRun {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("single-pass", 3)),
    );
    return runWithStage(
      runWithStage(seeded, WAITING_STAGE_ID, at(32)),
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
  }

  function labelOf(stageId: string): string {
    return currentStageLabel(
      runWithStage(singlePassConfirming(), stageId, at(41)),
    );
  }

  test("each encryption stage has its own display label", () => {
    expect(labelOf(SINGLE_PASS_STAGE_IDS.encryptingOwnData)).toBe(
      "Encrypting your data",
    );
    expect(labelOf(SINGLE_PASS_STAGE_IDS.encryptingPartnerData)).toBe(
      "Encrypting your partner's data",
    );
  });

  test("the matching stage has its own display label", () => {
    expect(labelOf(SINGLE_PASS_STAGE_IDS.identifyingSharedValues)).toBe(
      "Finding matches",
    );
  });

  test("the history rows hold the labels, not the raw ids", () => {
    const encrypting = runWithStage(
      singlePassConfirming(),
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      at(41),
    );
    const matching = runWithStage(
      encrypting,
      SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
      at(44),
    );
    expect(matching.visits.slice(3)).toEqual([
      {
        id: SINGLE_PASS_STAGE_IDS.encryptingOwnData,
        label: "Encrypting your data",
        completedAt: at(44),
      },
      {
        id: SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
        label: "Finding matches",
      },
    ]);
  });

  test("the cascade's per-key and confirmation labels are unchanged", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 2)),
    );
    const confirming = runWithStage(
      seeded,
      CONFIRMING_PROTOCOL_STAGE_ID,
      at(39),
    );
    expect(currentStageLabel(confirming)).toBe("Confirming protocol");
    expect(
      currentStageLabel(runWithStage(confirming, "stage 1 / 2", at(41))),
    ).toBe("Linking key 1 / 2");
  });

  test("an unlabelled stage id renders the id, and an empty one a readable label", () => {
    expect(labelOf("surprise stage")).toBe("surprise stage");
    expect(labelOf("   ")).toBe("Working");
  });

  test("only a stage neither the tree nor the labels name is unknown", () => {
    const run = singlePassConfirming();
    expect(stageIsKnown(run, CONFIRMING_PROTOCOL_STAGE_ID)).toBe(true);
    expect(stageIsKnown(run, SINGLE_PASS_STAGE_IDS.encryptingPartnerData)).toBe(
      true,
    );
    expect(stageIsKnown(run, "surprise stage")).toBe(false);
  });
});

describe("PSI progress", () => {
  const startedAt = new Date(2026, 6, 8, 14, 30, 0);
  const secondsLater = (seconds: number) =>
    new Date(startedAt.getTime() + seconds * 1000);

  function started(operation: PsiOperation, elements: number): PsiProgress {
    return { operation, elements, state: "started" };
  }

  function running(
    stageId: string,
    operation: PsiOperation,
    elements: number,
  ): ExchangeRun {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("single-pass", 3)),
    );
    return runWithPsiProgress(
      runWithStage(seeded, stageId, startedAt),
      started(operation, elements),
      startedAt,
    );
  }

  test("no line before the first report", () => {
    expect(psiProgressLabel(initialRun(), startedAt)).toBeUndefined();
  });

  test("a started report states the count and the elapsed time", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createServerSetup",
      1204,
    );
    expect(psiProgressLabel(run, secondsLater(4))).toBe(
      "1,204 values, 4s elapsed",
    );
  });

  test("the elapsed figure follows the clock, not a second report", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
      "computeAssociationTable",
      2,
    );
    expect(psiProgressLabel(run, secondsLater(72))).toBe(
      "2 values, 1m 12s elapsed",
    );
    expect(psiProgressLabel(run, secondsLater(7500))).toBe(
      "2 values, 2h 05m elapsed",
    );
  });

  test("one value is stated in the singular", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createClientRequest",
      1,
    );
    expect(psiProgressLabel(run, secondsLater(1))).toBe("1 value, 1s elapsed");
  });

  test("the operation is named where the stage label does not state it", () => {
    // The cascade's stage rows are numbered by linkage key, so which step of the
    // round is running is the progress line's to say.
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 3)),
    );
    const run = runWithPsiProgress(
      runWithStage(seeded, "stage 2 / 3", startedAt),
      started("processClientRequest", 40),
      startedAt,
    );
    expect(psiProgressLabel(run, secondsLater(9))).toBe(
      "Encrypting your partner's data: 40 values, 9s elapsed",
    );
  });

  test("a count-only round names the operation the stage rows never do", () => {
    const seeded = runWithStages(
      initialRun(),
      stagesFor(preparedWith("cascade", 1)),
    );
    const run = runWithPsiProgress(
      runWithStage(seeded, "stage 1 / 1", startedAt),
      started("computeIntersectionCardinality", 500),
      startedAt,
    );
    expect(psiProgressLabel(run, secondsLater(3))).toBe(
      "Counting shared values: 500 values, 3s elapsed",
    );
  });

  test("a settled report closes the line", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createServerSetup",
      1204,
    );
    for (const state of ["finished", "failed"] as const) {
      const settled = runWithPsiProgress(
        run,
        {
          operation: "createServerSetup",
          elements: 1204,
          state,
          durationMs: 4,
        },
        secondsLater(4),
      );
      expect(psiProgressLabel(settled, secondsLater(5))).toBeUndefined();
    }
  });

  test("a settle report with no line open leaves the run untouched", () => {
    const run = initialRun();
    expect(
      runWithPsiProgress(
        run,
        {
          operation: "createServerSetup",
          elements: 1204,
          state: "finished",
          durationMs: 4,
        },
        startedAt,
      ),
    ).toBe(run);
  });

  test("completion and failure both close the line", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createServerSetup",
      1204,
    );
    expect(
      psiProgressLabel(
        runWithCompletion(run, secondsLater(6)),
        secondsLater(7),
      ),
    ).toBeUndefined();
    expect(
      psiProgressLabel(runWithFailure(run), secondsLater(7)),
    ).toBeUndefined();
  });

  test("a mid-operation count states how far into the set the run is", () => {
    const run = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createServerSetup",
      10_000,
    );
    const advanced = runWithPsiProgress(
      run,
      {
        operation: "createServerSetup",
        elements: 10_000,
        state: "progress",
        processed: 4000,
      },
      secondsLater(9),
    );
    expect(psiProgressLabel(advanced, secondsLater(9))).toBe(
      "4,000 of 10,000 values (40%), 9s elapsed",
    );
    // The elapsed figure still runs from the operation's own start, so a count
    // arriving mid-operation does not restart it.
    expect(psiProgressLabel(advanced, secondsLater(72))).toBe(
      "4,000 of 10,000 values (40%), 1m 12s elapsed",
    );
  });

  test("the next operation opens on its own total, with no count from the one before", () => {
    const run = runWithPsiProgress(
      running(
        SINGLE_PASS_STAGE_IDS.encryptingOwnData,
        "createServerSetup",
        10_000,
      ),
      {
        operation: "createServerSetup",
        elements: 10_000,
        state: "progress",
        processed: 4000,
      },
      secondsLater(9),
    );
    const next = runWithPsiProgress(
      run,
      started("processClientRequest", 990),
      secondsLater(30),
    );
    expect(psiProgressLabel(next, secondsLater(32))).toBe(
      "Encrypting your partner's data: 990 values, 2s elapsed",
    );
  });

  test("a mid-operation count with no line open leaves the run untouched", () => {
    const run = initialRun();
    expect(
      runWithPsiProgress(
        run,
        {
          operation: "createServerSetup",
          elements: 1204,
          state: "progress",
          processed: 400,
        },
        startedAt,
      ),
    ).toBe(run);
  });

  test("a second operation restarts the elapsed figure", () => {
    const first = running(
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      "createServerSetup",
      1204,
    );
    const second = runWithPsiProgress(
      first,
      started("processClientRequest", 990),
      secondsLater(30),
    );
    expect(psiProgressLabel(second, secondsLater(32))).toBe(
      "Encrypting your partner's data: 990 values, 2s elapsed",
    );
  });
});
