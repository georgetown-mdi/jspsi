import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  ProcessState,
  SINGLE_PASS_STAGE_IDS,
  describeExchangeStages,
} from "@alcove/core";

import type {
  PreparedExchange,
  PsiOperation,
  PsiProgress,
  ResolvedMatching,
  SinglePassStageId,
} from "@alcove/core";
import type { StageDefinition } from "@psi/exchangeLifecycle";

/**
 * The pure model behind the console's post-create flow: the run's stage tree and
 * visit history as the lifecycle reports them, and the view-model builders the
 * protocol timeline, the status panel, and the completion header render from.
 * No React, no I/O -- the tested boundary for "the timeline advances on stage
 * events". Stage ids and labels come from the same lifecycle boundary the current
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
function initialStages(seat: ExchangeSeat = "inviter"): Array<StageDefinition> {
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
interface StageVisit {
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
  /** What the two parties' agreed `deduplicate` values resolved to, set from the
   * in-browser driver's protocol-confirmation report, so the running screen
   * states the pair while the run is still going. Unset until that report; a
   * console-conducted run takes the pair off its terminal result instead, where
   * it reaches the completion panel through the run's outputs. */
  matching?: ResolvedMatching;
  /** The PSI crypto operation running right now, set from the in-browser
   * driver's progress reports. Unset whenever none is -- before the first
   * report, between two operations, and once the run ends -- which is what
   * leaves the status panel showing its stage label alone. A console-conducted
   * run reports none, so it shows that static state throughout. */
  psiOperation?: RunningPsiOperation;
}

/** The figures a live PSI progress line states: which operation is running, how
 * many encrypted values it covers, how many of them it has finished, and when
 * this browser saw it start. The elapsed figure is derived at render against
 * the clock rather than stored, so it ticks without a state write per second.
 * `processed` is unset until the operation reports one, which an operation over
 * a set too small for the engine to split never does. */
export interface RunningPsiOperation {
  operation: PsiOperation;
  elements: number;
  startedAt: Date;
  processed?: number;
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

/** The label for a stage event whose id holds no text of its own, so that its
 * history row states the run is under way rather than rendering empty. */
const UNNAMED_STAGE_LABEL = "Working";

/** The four phrases a stage row and a PSI progress line both name a step by, so
 * the two surfaces cannot drift into two names for one step. */
const ENCRYPTING_OWN_DATA_LABEL = "Encrypting your data";
const ENCRYPTING_PARTNER_DATA_LABEL = "Encrypting your partner's data";
const FINDING_MATCHES_LABEL = "Finding matches";
const COUNTING_SHARED_VALUES_LABEL = "Counting shared values";

/** Display labels for the stage events single-pass linkage emits mid-run. A
 * single-pass stage tree enumerates the protocol-confirmation step alone --
 * which encrypt and match stages a party emits follows the role the handshake
 * resolves -- so those rows take their label from here instead of the tree. */
const SINGLE_PASS_STAGE_LABELS = new Map<string, string>(
  Object.entries({
    [SINGLE_PASS_STAGE_IDS.encryptingOwnData]: ENCRYPTING_OWN_DATA_LABEL,
    [SINGLE_PASS_STAGE_IDS.encryptingPartnerData]:
      ENCRYPTING_PARTNER_DATA_LABEL,
    [SINGLE_PASS_STAGE_IDS.identifyingSharedValues]: FINDING_MATCHES_LABEL,
  } satisfies Record<SinglePassStageId, string>),
);

/** What each PSI crypto operation is called on the progress line. The two
 * operations that mask this party's own set are one step to the operator --
 * which of them runs follows the role the handshake resolved -- so they share a
 * phrase. */
const PSI_OPERATION_LABELS: Record<PsiOperation, string> = {
  createServerSetup: ENCRYPTING_OWN_DATA_LABEL,
  createClientRequest: ENCRYPTING_OWN_DATA_LABEL,
  processClientRequest: ENCRYPTING_PARTNER_DATA_LABEL,
  computeAssociationTable: FINDING_MATCHES_LABEL,
  computeIntersectionCardinality: COUNTING_SHARED_VALUES_LABEL,
};

/** The label a stage event shows in the status panel and the run history: the
 * stage tree's, then the single-pass label, then the id itself. */
function stageLabel(run: ExchangeRun, stageId: string): string {
  return (
    run.stages.find((stage) => stage.id === stageId)?.label ??
    SINGLE_PASS_STAGE_LABELS.get(stageId) ??
    (stageId.trim() === "" ? UNNAMED_STAGE_LABEL : stageId)
  );
}

/** Whether the stage tree or the single-pass labels name this stage id -- what
 * the status panel's development-only desync warning reports on. */
export function stageIsKnown(run: ExchangeRun, stageId: string): boolean {
  return (
    run.stages.some((stage) => stage.id === stageId) ||
    SINGLE_PASS_STAGE_LABELS.has(stageId)
  );
}

/** Advance to a stage: the open visit closes at `at` and the new stage's visit
 * opens. A repeat of the current stage is a no-op, so a re-emitted stage id
 * cannot duplicate a history row. The terminal done stage belongs to
 * {@link runWithCompletion} alone: single-pass linkage emits `done` as its last
 * stage event with the payload exchange and the result still to come, so the
 * run holds its open stage until the result lands. */
export function runWithStage(
  run: ExchangeRun,
  stageId: string,
  at: Date,
): ExchangeRun {
  if (stageId === run.stageId || stageId === DONE_STAGE_ID) return run;
  return {
    ...run,
    stageId,
    visits: [
      ...closedVisits(run.visits, at),
      { id: stageId, label: stageLabel(run, stageId) },
    ],
  };
}

/** Complete the run on the lifecycle's result: the open visit closes, the
 * terminal done stage is entered as its own already-closed visit so the status
 * label's live region announces the final "Done", and the finish instant is
 * recorded for the completion header. */
export function runWithCompletion(run: ExchangeRun, at: Date): ExchangeRun {
  return {
    ...withoutPsiOperation(run),
    stageId: DONE_STAGE_ID,
    visits: [
      ...closedVisits(run.visits, at),
      { id: DONE_STAGE_ID, label: "Done", completedAt: at },
    ],
    finishedAt: at,
  };
}

/** Record what the agreed `deduplicate` values resolved to, reported once at
 * protocol confirmation and read by the running screen. */
export function runWithMatching(
  run: ExchangeRun,
  matching: ResolvedMatching,
): ExchangeRun {
  return { ...run, matching };
}

/** Take one PSI progress report: a `started` report opens the live line on that
 * operation, a `progress` one advances its processed count, and a `finished` or
 * `failed` one closes it. Returns the run unchanged where nothing moves, so a
 * settle report with no line open, or a mid-operation count arriving after the
 * line closed, costs no re-render. */
export function runWithPsiProgress(
  run: ExchangeRun,
  progress: PsiProgress,
  at: Date,
): ExchangeRun {
  if (progress.state === "progress") {
    const running = run.psiOperation;
    if (running === undefined || progress.processed === undefined) return run;
    return {
      ...run,
      psiOperation: { ...running, processed: progress.processed },
    };
  }
  if (progress.state !== "started")
    return run.psiOperation === undefined ? run : withoutPsiOperation(run);
  return {
    ...run,
    psiOperation: {
      operation: progress.operation,
      elements: progress.elements,
      startedAt: at,
    },
  };
}

function withoutPsiOperation(run: ExchangeRun): ExchangeRun {
  const { psiOperation: _closed, ...rest } = run;
  return rest;
}

/** Mark the run failed: the timeline and history freeze where they stand, the
 * status panel stops presenting the open stage as in flight, and the live PSI
 * line closes -- a run that failed inside an operation, or was cut short of the
 * report settling it, has none running. */
export function runWithFailure(run: ExchangeRun): ExchangeRun {
  return { ...withoutPsiOperation(run), failed: true };
}

/** One step of the five-step protocol timeline the top bar shows after create. */
interface TimelineStep {
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

/** `count` with the unit the operator reads it in, grouped in threes so a
 * millions figure stays readable. */
function valueCountLabel(count: number): string {
  const grouped = new Intl.NumberFormat("en-US").format(Math.trunc(count));
  return `${grouped} ${count === 1 ? "value" : "values"}`;
}

/** `elapsedMs` as the largest two units that hold it -- `42s`, `1m 12s`,
 * `2h 05m` -- so a multi-hour operation's figure stays as short as a
 * multi-second one's. */
function elapsedLabel(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** How far into its set the running operation is -- `4,000 of 10,000 values
 * (40%)` -- or the total alone until it reports a count. The share is rounded
 * down and held at 100, so a count that overshoots its total by a rounding
 * step cannot put the line past that total. */
function processedLabel(running: RunningPsiOperation): string {
  const { elements, processed } = running;
  if (processed === undefined) return valueCountLabel(elements);
  const share =
    elements <= 0
      ? 100
      : Math.min(100, Math.floor((processed / elements) * 100));
  const grouped = new Intl.NumberFormat("en-US").format(Math.trunc(processed));
  return `${grouped} of ${valueCountLabel(elements)} (${share}%)`;
}

/** The status panel's live PSI line as of `now`: how far the running operation
 * has got through the values it covers and how long it has run, preceded by the
 * operation's own name where the stage label above does not already state it.
 * Undefined when no operation is running, which is what leaves the stage label
 * standing alone. */
export function psiProgressLabel(
  run: ExchangeRun,
  now: Date,
): string | undefined {
  const running = run.psiOperation;
  if (running === undefined) return undefined;
  const figures =
    `${processedLabel(running)}, ` +
    `${elapsedLabel(now.getTime() - running.startedAt.getTime())} elapsed`;
  const operationLabel = PSI_OPERATION_LABELS[running.operation];
  return operationLabel === currentStageLabel(run)
    ? figures
    : `${operationLabel}: ${figures}`;
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
