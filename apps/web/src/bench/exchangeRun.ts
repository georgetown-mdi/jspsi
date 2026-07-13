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

/** The two run seats: the inviter (PSI responder that listens) and the acceptor
 * (PSI initiator that dials). The only thing the pure run model varies by role is
 * the waiting-stage label and the top-bar timeline the run drives. */
export type ExchangeSeat = "inviter" | "acceptor";

/** The waiting-stage label each seat shows: the inviter waits for the partner to
 * accept; the acceptor is the one dialing, so it is connecting to the partner. */
const WAITING_STAGE_LABEL: Record<ExchangeSeat, string> = {
  inviter: "Waiting for your partner",
  acceptor: "Connecting to your partner",
};

/** The pre-stages for a seat: the terminal-before-start stage every run opens
 * with, and the waiting stage whose label is the seat's. */
function preStagesFor(seat: ExchangeSeat): Array<StageDefinition> {
  return [
    {
      id: BEFORE_START_STAGE_ID,
      label: "Before start",
      state: ProcessState.BeforeStart,
    },
    {
      id: WAITING_STAGE_ID,
      label: WAITING_STAGE_LABEL[seat],
      state: ProcessState.Waiting,
    },
  ];
}

const preStages = preStagesFor("inviter");

const doneStage: StageDefinition = {
  id: DONE_STAGE_ID,
  label: "Done",
  state: ProcessState.Done,
};

/** The stage tree before the prepared exchange exists: the pre-stages, the
 * protocol-confirmation stage every exchange opens with, and the terminal done
 * stage. Replaced wholesale once `prepare` yields the real tree. The seat only
 * sets the waiting-stage label; it defaults to the inviter's. */
export function initialStages(
  seat: ExchangeSeat = "inviter",
): Array<StageDefinition> {
  return [
    ...preStagesFor(seat),
    {
      id: CONFIRMING_PROTOCOL_STAGE_ID,
      label: "Confirming protocol",
      state: ProcessState.Working,
    },
    doneStage,
  ];
}

/** The full per-exchange stage tree, built once after prepare: the pre-stages,
 * the protocol stages the prepared exchange declares, and the done stage. The
 * seat only sets the waiting-stage label; it defaults to the inviter's. */
export function stagesFor(
  prepared: PreparedExchange,
  seat: ExchangeSeat = "inviter",
): Array<StageDefinition> {
  return [
    ...preStagesFor(seat),
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

export function initialRun(seat: ExchangeSeat = "inviter"): ExchangeRun {
  return {
    stages: initialStages(seat),
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

/** Complete the run: the open visit closes, the terminal done stage is
 * entered as its own (already-closed) visit -- the lifecycle never emits a
 * "done" stage event, so the completion synthesizes it here and the status
 * label's live region announces the final "Done" -- and the finish instant is
 * recorded for the completion header. */
export function runWithCompletion(run: ExchangeRun, at: Date): ExchangeRun {
  return {
    ...run,
    stageId: DONE_STAGE_ID,
    visits: [
      ...closedVisits(run.visits, at),
      { id: DONE_STAGE_ID, label: "Done", completedAt: at },
    ],
    finishedAt: at,
  };
}

/** Mark the run failed: the timeline and history freeze where they stand and
 * the status panel stops presenting the open stage as in flight. */
export function runWithFailure(run: ExchangeRun): ExchangeRun {
  return { ...run, failed: true };
}

/** One step of the five-step protocol timeline the top bar shows after create. */
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
 * The top bar's protocol timeline, derived from the run's stage: Share while the
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

const ACCEPTOR_TIMELINE_LABELS = [
  "Connect",
  "Confirm protocol",
  "Link keys",
  "Done",
] as const;

/**
 * The acceptor's top-bar timeline. Unlike the inviter's, it opens at Connect and
 * has no Share or Partner-accepts step -- the acceptor dials, so its timeline never
 * shows a stage it cannot act on. Connect stays current through the pre-stages
 * (before-start and the "Connecting to your partner" wait); a protocol stage
 * flips it to Confirm protocol; the per-key rounds sit under Link keys; and
 * everything is done at completion.
 */
export function acceptorTimelineSteps(run: ExchangeRun): Array<TimelineStep> {
  const current =
    run.stageId === DONE_STAGE_ID
      ? ACCEPTOR_TIMELINE_LABELS.length
      : preStages.some((stage) => stage.id === run.stageId)
        ? 0
        : run.stageId === CONFIRMING_PROTOCOL_STAGE_ID
          ? 1
          : 2;
  return ACCEPTOR_TIMELINE_LABELS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "pending",
  }));
}

/** The status panel's progress, as the current stage's position through the
 * stage tree (0 before start, 100 at done). A stage id outside the tree
 * asserts nothing new: the bar holds at the last stage the tree knows rather
 * than regressing to zero. */
export function progressPercent(run: ExchangeRun): number {
  if (run.stageId === DONE_STAGE_ID) return 100;
  if (run.stages.length < 2) return 0;
  for (let visit = run.visits.length - 1; visit >= 0; visit--) {
    const index = run.stages.findIndex(
      (stage) => stage.id === run.visits[visit].id,
    );
    if (index > 0) return Math.round((index / (run.stages.length - 1)) * 100);
  }
  return 0;
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
