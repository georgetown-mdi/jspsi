import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  ProcessState,
  describeExchangeStages,
} from "@psilink/core";

import type { PreparedExchange } from "@psilink/core";
import type { StageDefinition } from "@psi/exchangeLifecycle";

/**
 * The pure model behind the bench's post-create flow: the run's stage tree and
 * visit history as the lifecycle reports them, and the view-model builders the
 * protocol timeline, the status panel, and the completion header render from.
 * No React, no I/O -- the tested boundary for "the timeline advances on stage
 * events". Stage ids and labels come from the same lifecycle seam the current
 * exchange screen renders ({@link describeExchangeStages} plus the owner's
 * pre/done stages), so the Console engine's driver contract later fronts this
 * model unchanged.
 */

export const BEFORE_START_STAGE_ID = "before start";
export const WAITING_STAGE_ID = "waiting for peer";
export const DONE_STAGE_ID = "done";

const preStages: Array<StageDefinition> = [
  {
    id: BEFORE_START_STAGE_ID,
    label: "Before start",
    state: ProcessState.BeforeStart,
  },
  {
    id: WAITING_STAGE_ID,
    label: "Waiting for your partner",
    state: ProcessState.Waiting,
  },
];

const doneStage: StageDefinition = {
  id: DONE_STAGE_ID,
  label: "Done",
  state: ProcessState.Done,
};

/** The stage tree before the prepared exchange exists: the pre-stages, the
 * protocol-confirmation stage every exchange opens with, and the terminal done
 * stage. Replaced wholesale once `prepare` yields the real tree. */
export function initialStages(): Array<StageDefinition> {
  return [
    ...preStages,
    {
      id: CONFIRMING_PROTOCOL_STAGE_ID,
      label: "Confirming protocol",
      state: ProcessState.Working,
    },
    doneStage,
  ];
}

/** The full per-exchange stage tree, built once after prepare: the pre-stages,
 * the protocol stages the prepared exchange declares, and the done stage. */
export function stagesFor(prepared: PreparedExchange): Array<StageDefinition> {
  return [
    ...preStages,
    ...describeExchangeStages(prepared).map((stage) => ({
      ...stage,
      state: ProcessState.Working as const,
    })),
    doneStage,
  ];
}

/** One stage the run has entered: the visit closes (gains `completedAt`) when
 * the run moves on -- the status panel's history rows. */
export interface StageVisit {
  id: string;
  label: string;
  completedAt?: Date;
}

/** The run's live state, advanced by the lifecycle's `onStages`/`onStage`/
 * result/error events through the `runWith*` builders below. */
export interface ExchangeRun {
  stages: Array<StageDefinition>;
  stageId: string;
  visits: Array<StageVisit>;
  finishedAt?: Date;
  failed: boolean;
}

export function initialRun(): ExchangeRun {
  return {
    stages: initialStages(),
    stageId: BEFORE_START_STAGE_ID,
    visits: [{ id: BEFORE_START_STAGE_ID, label: "Before start" }],
    failed: false,
  };
}

/** Adopt the full stage tree the lifecycle emits after prepare. */
export function runWithStages(
  run: ExchangeRun,
  stages: Array<StageDefinition>,
): ExchangeRun {
  return { ...run, stages };
}

function closedVisits(visits: Array<StageVisit>, at: Date): Array<StageVisit> {
  return visits.map((visit, index) =>
    index === visits.length - 1 && visit.completedAt === undefined
      ? { ...visit, completedAt: at }
      : visit,
  );
}

/** Advance to a stage: the open visit closes at `at` and the new stage's visit
 * opens. A repeat of the current stage is a no-op, so a re-emitted stage id
 * cannot duplicate a history row. */
export function runWithStage(
  run: ExchangeRun,
  stageId: string,
  at: Date,
): ExchangeRun {
  if (stageId === run.stageId) return run;
  const label =
    run.stages.find((stage) => stage.id === stageId)?.label ?? stageId;
  return {
    ...run,
    stageId,
    visits: [...closedVisits(run.visits, at), { id: stageId, label }],
  };
}

/** Complete the run: the open visit closes, the stage becomes the terminal
 * done stage, and the finish instant is recorded for the completion header. */
export function runWithCompletion(run: ExchangeRun, at: Date): ExchangeRun {
  return {
    ...run,
    stageId: DONE_STAGE_ID,
    visits: closedVisits(run.visits, at),
    finishedAt: at,
  };
}

/** Mark the run failed: the timeline and history freeze where they stand and
 * the status panel stops presenting the open stage as in flight. */
export function runWithFailure(run: ExchangeRun): ExchangeRun {
  return { ...run, failed: true };
}

/** One step of the five-step protocol timeline the rail shows after create. */
export interface TimelineStep {
  label: string;
  state: "done" | "current" | "pending";
}

const TIMELINE_LABELS = [
  "Share",
  "Partner accepts",
  "Confirm protocol",
  "Link keys",
  "Done",
] as const;

/**
 * The rail's protocol timeline, derived from the run's stage: Share while the
 * exchange waits for the partner, Confirm protocol during the protocol
 * handshake, Link keys through the per-key rounds, everything done at
 * completion. "Partner accepts" is a moment rather than a duration, so it is
 * never current -- it flips to done the instant a protocol stage begins.
 */
export function timelineSteps(run: ExchangeRun): Array<TimelineStep> {
  const current =
    run.stageId === DONE_STAGE_ID
      ? TIMELINE_LABELS.length
      : preStages.some((stage) => stage.id === run.stageId)
        ? 0
        : run.stageId === CONFIRMING_PROTOCOL_STAGE_ID
          ? 2
          : 3;
  return TIMELINE_LABELS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "pending",
  }));
}

/** The status panel's progress, as the current stage's position through the
 * stage tree (0 before start, 100 at done). */
export function progressPercent(run: ExchangeRun): number {
  if (run.stageId === DONE_STAGE_ID) return 100;
  const index = run.stages.findIndex((stage) => stage.id === run.stageId);
  if (index <= 0 || run.stages.length < 2) return 0;
  return Math.round((index / (run.stages.length - 1)) * 100);
}

/** The status panel's current stage label -- the open visit's, which tracked
 * the stage tree when the visit was recorded. */
export function currentStageLabel(run: ExchangeRun): string {
  return run.visits[run.visits.length - 1].label;
}

/** A history row's completion time, e.g. `2:43 PM`. */
export function timeOfDayLabel(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** Whether the run still waits for the partner -- the share phase, during
 * which the copy artifacts are the operator's task. Over the moment a
 * protocol stage begins. */
export function awaitingPartner(run: ExchangeRun): boolean {
  return (
    run.stageId === BEFORE_START_STAGE_ID || run.stageId === WAITING_STAGE_ID
  );
}
