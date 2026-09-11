import fs from "node:fs";

import {
  ConnectionError,
  OperatorConfigError,
  UsageError,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type {
  EntityClusterSummary,
  ExchangeStageDefinition,
  ResolvedMatching,
} from "@psilink/core";

/**
 * The fixed file descriptor the opt-in machine-readable event stream is written
 * to. Not configurable: a supervisor spawns psilink with descriptor 3 wired to a
 * pipe it reads, so a constant is the contract. stdout (fd 1) and stderr (fd 2)
 * are untouched -- the event stream is a third channel, so a supervisor reads
 * structured events without parsing the human log or corrupting the CSV result.
 * The full contract lives in docs/spec/CLI_EVENTS.md.
 */
export const EVENT_STREAM_FD = 3;

/**
 * The schema version stamped on every emitted line (the `v` field). A small
 * integer so a supervisor can read the version from any single line without
 * tracking stream position. Bump it on any breaking change to an event's field
 * layout or the classification rules; an additive field need not bump it. See
 * docs/spec/CLI_EVENTS.md.
 */
export const EVENT_STREAM_VERSION = 1;

/**
 * The most shape entries the `result` event's `entityClusters` field holds.
 *
 * That list is the one variable-length field of this stream, and a run whose
 * clusters take thousands of distinct shapes would push the terminal event past
 * a consumer's per-line bound -- the console relay's is 1 MiB
 * (`apps/web/src/jobs/cliDriver.ts`) -- costing the run the outcome the event
 * exists to report. A wider distribution drops the field rather than truncating
 * the list, since a short list would misstate how many shapes the summary's own
 * sentence leaves unnamed. Sized well above any distribution an operator reads
 * and well below that bound.
 */
export const EVENT_RESULT_CLUSTER_SHAPES_MAX = 256;

/**
 * The closed vocabulary of event `type` values. This party owns every one of
 * these strings -- none is partner-derived -- so a consumer can switch on the
 * discriminant safely. `stages` is the one-shot stage-list event; `stage` marks
 * each stage transition; `stageEnd` reports a completed stage's wall-clock
 * duration; `warning` holds a non-fatal warning (a terms-exchange warning, the
 * cross-party host-key divergence notice, the resolved-cardinality and
 * pair-table notices of the post-terms, pre-round boundary, the
 * signing-without-a-record notice, a missing audit artifact, or any
 * post-exchange persistence failure);
 * `metrics` is the one-shot operational-counter summary emitted just before the
 * terminal event; `result` and `error` are the two terminal events (exactly one
 * fires per run).
 */
export type EventType =
  "stages" | "stage" | "stageEnd" | "warning" | "metrics" | "result" | "error";

/**
 * The four terminal-error categories, lifted verbatim from the web's
 * `ExchangeErrorCategory` (apps/web/src/psi/exchangeLifecycle.ts) so a consumer
 * classifies a CLI failure exactly as it would a web one:
 * - `config`: a PREPARE-phase {@link OperatorConfigError} -- a fault composed
 *   solely of this party's own configuration, actionable and safe to show.
 * - `security`: a trust-boundary failure -- a `security`-kind
 *   {@link ConnectionError} from the authenticated key exchange (wrong secret,
 *   tamper, replay), from SFTP host-key verification (a pinned-fingerprint
 *   mismatch, or an unpinned host refused fail-closed), or from the
 *   post-handshake AEAD layer. It must be identifiable from the terminal event
 *   alone, since the process exit code (64/69) cannot distinguish it from a
 *   plain usage or transport failure.
 * - `output`: the privacy-sensitive exchange already succeeded and only local
 *   result-file generation failed -- the operator must NOT re-run the exchange.
 * - `exchange`: every other failure (a retryable transport/usage fault).
 */
export type ExchangeErrorCategory =
  "exchange" | "output" | "security" | "config";

/**
 * The lifecycle phase a terminal error was raised in, mirroring the web's
 * `phase` argument to its classifier. `prepare` covers everything before the
 * exchange proper begins (dataset prep, connection open, handshake); `run`
 * covers the PSI exchange itself; `output` covers local result-file generation
 * after the exchange succeeded.
 */
export type ErrorPhase = "prepare" | "run" | "output";

/** A single stage in the emitted stage list, echoing the web's onStages shape. */
export interface EventStageDefinition {
  id: string;
  label: string;
}

interface EventBase {
  /** Schema version; see {@link EVENT_STREAM_VERSION}. */
  v: number;
  type: EventType;
}

/** The one-shot stage-list event, the CLI counterpart of the web's onStages. */
export interface StagesEvent extends EventBase {
  type: "stages";
  stages: EventStageDefinition[];
}

/** A stage-transition event, the counterpart of the web's onStage. */
export interface StageEvent extends EventBase {
  type: "stage";
  id: string;
  label: string;
}

/**
 * A stage-completion event, emitted when a protocol stage finishes, reporting
 * how long it ran. It pairs with the start-of-stage {@link StageEvent} so a
 * supervisor can attribute wall-clock to the stage named by `id`. Only a
 * completed stage is reported: a run that aborts mid-stage emits no `stageEnd`
 * for the in-flight stage, so a reported duration is always a whole stage's time.
 */
export interface StageEndEvent extends EventBase {
  type: "stageEnd";
  /** The completed stage's identifier, matching an `id` from the `stages` event. */
  id: string;
  /** Wall-clock the stage ran, in whole milliseconds; never negative. */
  durationMs: number;
}

/**
 * A non-fatal warning; see the `warning` case of {@link EventType} for the
 * warning sources `message` holds.
 */
export interface WarningEvent extends EventBase {
  type: "warning";
  message: string;
}

/**
 * The per-run operational-counter summary, emitted exactly once immediately
 * before the terminal {@link ResultEvent}/{@link ErrorEvent} (so the terminal
 * event stays last). It reports this party's dataset size and how often the
 * transport had to retry a data operation or re-establish the connection over
 * the run. Every field is this party's own non-negative integer -- none is
 * partner-derived -- so no sanitization applies. Not emitted on a signal exit,
 * which emits no terminal event either.
 */
export interface MetricsEvent extends EventBase {
  type: "metrics";
  /** This party's input record count fed into the exchange. */
  recordsProcessed: number;
  /** Transport data-operation retries over the run; 0 when none occurred. */
  transportRetries: number;
  /** Connection re-establishment attempts over the run; 0 when none occurred. */
  reconnects: number;
}

/** The success terminal event. Exactly one terminal event fires per run. */
export interface ResultEvent extends EventBase {
  type: "result";
  /**
   * Whether this party received a matched result table. False for a one-sided
   * exchange in which this party is the helper and its agreed terms give it no
   * output -- it contributed to the match but receives no result file -- and
   * false for a count-only exchange, which produces no matched pairing for
   * anyone, in which case {@link intersectionCount} holds the outcome.
   */
  resultWritten: boolean;
  /**
   * The size of the intersection a count-only (`psi-c`) exchange reported,
   * present exactly when this party's agreed terms gave it the count and absent
   * on every other run. It is what separates the two `resultWritten: false`
   * outcomes: with the field, this party received exactly what its terms
   * promised; without it, the terms withheld the result table.
   */
  intersectionCount?: number;
  /**
   * Whether {@link intersectionCount} arrived as the partner's report rather than
   * as a figure this party computed -- true for the PSI sender seat of a
   * both-entitled count-only run, false for the receiver that computed it. Emitted
   * exactly when {@link intersectionCount} is, so a consumer reads the pair or
   * neither; absent means there was no count to qualify.
   */
  countReportedByPartner?: boolean;
  /**
   * What the two parties' agreed `deduplicate` values resolved to for this
   * party ({@link ResolvedMatching}): the pair as presented and the cardinality
   * it gives this side. Present on every successful run.
   *
   * On the stream because the human log states it at info level, which a
   * supervisor discarding stderr -- or running at a quieter level -- never
   * reads, and a console seat watching the run reads nothing else. Both
   * booleans and the closed cardinality label are this party's own values,
   * derived from terms the run boundary already parsed, so no partner free
   * text rides the field.
   */
  matching: ResolvedMatching;
  /**
   * How the entity closure grouped this party's result: the cluster count, how
   * many records of each party stand in a cluster, and the distribution of the
   * shapes those clusters take ({@link EntityClusterSummary}).
   *
   * Present on a `many-to-many` run this party holds the table of, absent under
   * every other cardinality -- whose clusters follow from the table's own shape
   * -- and absent where the distribution holds more shapes than
   * {@link EVENT_RESULT_CLUSTER_SHAPES_MAX}.
   *
   * On the stream for the reason {@link matching} is: the human log states the
   * same summary as a sentence at info level, which a supervisor reading fd 3
   * alone -- or a console seat watching the run -- never reads. Every figure is
   * one of this party's own counts over its own table, so no partner free text
   * rides the field.
   */
  entityClusters?: EntityClusterSummary;
}

/** The failure terminal event. Exactly one terminal event fires per run. */
export interface ErrorEvent extends EventBase {
  type: "error";
  category: ExchangeErrorCategory;
  /** Display-safe error text ({@link sanitizeErrorForDisplay}). */
  message: string;
}

export type StreamEvent =
  | StagesEvent
  | StageEvent
  | StageEndEvent
  | WarningEvent
  | MetricsEvent
  | ResultEvent
  | ErrorEvent;

// --- Pure event construction (no file descriptor) ----------------------------

/**
 * Classify a terminal failure into one of the four {@link ExchangeErrorCategory}
 * values, the web front end's vocabulary (`apps/web/src/psi/exchangeLifecycle.ts`):
 *
 * - `output` phase -> `output`.
 * - an {@link OperatorConfigError} in any earlier phase -> `config`. That exact
 *   base type only, not any {@link UsageError}: a sibling UsageError can be
 *   partner-influenced.
 * - a `security`-kind {@link ConnectionError} (any phase) -> `security`.
 * - everything else -> `exchange`.
 *
 * Unlike the web's `classifyExchangeFailure`, `config` here is not scoped to
 * the `prepare` phase: it has to agree with the exit code instead, and every
 * `OperatorConfigError` exits 64 (non-retryable) regardless of phase. Full
 * rationale: docs/spec/CLI_EVENTS.md (Error categories).
 */
export function classifyTerminalError(
  error: unknown,
  phase: ErrorPhase,
): ExchangeErrorCategory {
  if (phase === "output") return "output";
  if (error instanceof OperatorConfigError) return "config";
  return error instanceof ConnectionError && error.kind === "security"
    ? "security"
    : "exchange";
}

/** Build the one-shot stage-list event from core's stage definitions. */
export function buildStagesEvent(
  stages: ExchangeStageDefinition[],
): StagesEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stages",
    // A stage label derives from linkage-key names the PARTNER may have authored,
    // so redact and escape it exactly as protocol.ts does before a label reaches
    // stderr; leaving fd 3 on the escape alone would make the persisted route the
    // weaker of the two. The id is this party's own constant vocabulary from
    // describeExchangeStages, but it is echoed on the wire in the same format, so
    // it takes the same pass uniformly.
    stages: stages.map(({ id, label }) => ({
      id: redactAndSanitizeForDisplay(id),
      label: redactAndSanitizeForDisplay(label),
    })),
  };
}

/** Build a stage-transition event from an id and its resolved display label. */
export function buildStageEvent(id: string, label: string): StageEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stage",
    id: redactAndSanitizeForDisplay(id),
    label: redactAndSanitizeForDisplay(label),
  };
}

/**
 * Coerce a counter or duration to a non-negative whole number, so a malformed
 * caller value (undefined, NaN, negative, fractional) can never produce an
 * out-of-contract numeric field. These metric values are this party's own
 * integers, so this is a robustness floor, not a sanitizer.
 */
function toCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Build a stage-completion event from a stage id and its measured duration. */
export function buildStageEndEvent(
  id: string,
  durationMs: number,
): StageEndEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stageEnd",
    // The id echoes a partner-authorable stage identifier, taking the same pass
    // as the stage event's id.
    id: redactAndSanitizeForDisplay(id),
    durationMs: toCount(durationMs),
  };
}

/** Build a warning event from a non-fatal warning message. */
export function buildWarningEvent(message: string): WarningEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "warning",
    // Terms-exchange warnings can embed partner-authored column names, so
    // redact and sanitize before the text reaches the stream, at the shared
    // warning-composition budget (WARNING_MESSAGE_MAX_DISPLAY_LENGTH) rather
    // than the per-value default. Full rationale: docs/spec/CLI_EVENTS.md
    // (the `warning` message field).
    message: redactAndSanitizeForDisplay(message, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  };
}

/** Build the per-run operational-counter summary event. */
export function buildMetricsEvent(
  recordsProcessed: number,
  transportRetries: number,
  reconnects: number,
): MetricsEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "metrics",
    recordsProcessed: toCount(recordsProcessed),
    transportRetries: toCount(transportRetries),
    reconnects: toCount(reconnects),
  };
}

/**
 * Build the success terminal event. `count` is passed only for a count-only run
 * this party's terms entitle it to read, and its fields are omitted entirely
 * otherwise: the presence of `intersectionCount` is what a consumer keys the
 * count-only outcome off, so a zero count and an absent one must stay
 * distinguishable. The tally and its provenance travel as one argument so the
 * stream cannot hold a count without saying whose reading it is.
 *
 * `matching` is required rather than optional so no caller can emit a success
 * terminal without it: it is the only channel a consumer that reads fd 3 alone
 * has for what the agreed `deduplicate` pair resolved to.
 *
 * `entityClusters` is passed only for a run core composed a cluster summary
 * for, and is omitted entirely otherwise and where the summary holds more
 * shapes than {@link EVENT_RESULT_CLUSTER_SHAPES_MAX}.
 */
export function buildResultEvent(
  resultWritten: boolean,
  matching: ResolvedMatching,
  count?: { intersectionCount: number; reportedByPartner: boolean },
  entityClusters?: EntityClusterSummary,
): ResultEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "result",
    resultWritten,
    // Copied field by field, so a caller's object holding anything beyond the
    // three cannot widen the emitted line past this stream's closed contract.
    matching: {
      localDeduplicate: matching.localDeduplicate,
      partnerDeduplicate: matching.partnerDeduplicate,
      cardinality: matching.cardinality,
    },
    // The one numeric field of this stream that a partner can influence (the
    // count-report leg sends the receiver's tally to the sender), so it takes
    // the same non-negative whole-number floor the metrics counters take. Core
    // bounds the reported figure to the smaller of the two exchanged record
    // counts before it gets here.
    ...(count !== undefined
      ? {
          intersectionCount: toCount(count.intersectionCount),
          countReportedByPartner: count.reportedByPartner,
        }
      : {}),
    ...(entityClusters !== undefined &&
    entityClusters.shapes.length <= EVENT_RESULT_CLUSTER_SHAPES_MAX
      ? { entityClusters: copyClusterSummary(entityClusters) }
      : {}),
  };
}

/**
 * Copy a cluster summary field by field, each figure through the same
 * non-negative whole-number floor the metrics counters take. The copy is what
 * keeps a caller's object from widening the emitted line past this stream's
 * closed contract; the floor is a robustness floor, not a sanitizer, since
 * every figure is one of this party's own counts.
 */
function copyClusterSummary(
  summary: EntityClusterSummary,
): EntityClusterSummary {
  return {
    clusterCount: toCount(summary.clusterCount),
    localRows: toCount(summary.localRows),
    partnerRows: toCount(summary.partnerRows),
    shapes: summary.shapes.map((shape) => ({
      localRows: toCount(shape.localRows),
      partnerRows: toCount(shape.partnerRows),
      distinctValues: toCount(shape.distinctValues),
      clusters: toCount(shape.clusters),
    })),
  };
}

/** Build the classified failure terminal event. */
export function buildErrorEvent(error: unknown, phase: ErrorPhase): ErrorEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "error",
    category: classifyTerminalError(error, phase),
    // Error text can hold partner- or server-controlled bytes in its message or
    // cause chain, so route it through the display-boundary sanitizer that
    // stderr uses; the category and version fields are this party's own vocabulary.
    message: sanitizeErrorForDisplay(error),
  };
}

// --- Fail-closed fd-3 preflight ----------------------------------------------

/**
 * Assert that {@link EVENT_STREAM_FD} is actually open, throwing a
 * {@link UsageError} (CLI exit 64) if it is not. Called at startup, before any
 * exchange work, when `--event-stream` is given: if the operator asked for the
 * stream but spawned the process without wiring fd 3, fail loud and early rather
 * than silently dropping every event or crashing mid-run on the first write. An
 * `fstat` on an unopened descriptor raises `EBADF`; any error is treated as
 * fail-closed.
 */
export function assertEventStreamFdOpen(): void {
  try {
    fs.fstatSync(EVENT_STREAM_FD);
  } catch {
    throw new UsageError(
      `--event-stream was given but file descriptor ${EVENT_STREAM_FD} is not ` +
        "open; spawn psilink with that descriptor wired to a pipe your " +
        "supervisor reads, or drop --event-stream. Format: " +
        "https://github.com/georgetown-mdi/jspsi/blob/main/docs/spec/" +
        "CLI_EVENTS.md",
    );
  }
}

// --- fd-3 writer -------------------------------------------------------------

/**
 * Serialize and flush events to {@link EVENT_STREAM_FD} as NDJSON: one JSON
 * object per line, each write a single synchronous `writeSync` so a supervisor
 * reading incrementally never observes a partial line, and no line interleaves
 * with another. A `writeSync` to a pipe can return a short count under back
 * pressure, so the whole buffer is drained in a loop rather than trusting one
 * call. A write failure is swallowed after the connection has been marked broken:
 * a supervisor that closed its read end must not crash the exchange, and the
 * absence of further events plus the exit code is a defined supervisor signal
 * (see docs/spec/CLI_EVENTS.md).
 */
class EventStreamWriter {
  private broken = false;

  /** Serialize `event` to one NDJSON line and flush it to fd 3. */
  emit(event: StreamEvent): void {
    if (this.broken) return;
    const line = JSON.stringify(event) + "\n";
    const buf = Buffer.from(line, "utf8");
    let offset = 0;
    try {
      while (offset < buf.length)
        offset += fs.writeSync(
          EVENT_STREAM_FD,
          buf,
          offset,
          buf.length - offset,
        );
    } catch {
      // The supervisor's read end is gone (EPIPE) or the descriptor is otherwise
      // wedged. Mark the stream broken so no later event retries the write, and
      // do not throw back into the exchange -- the human log on stderr and the
      // exit code remain the authoritative outcome.
      this.broken = true;
    }
  }
}

/**
 * The emitter runProtocol drives: a pure event-construction layer plus the
 * fd-3 writer. Constructed only when `--event-stream` is active (after the
 * fail-closed preflight), so when the flag is absent no writer exists and
 * nothing is ever written to fd 3.
 */
export interface EventStreamEmitter {
  stages(stages: ExchangeStageDefinition[]): void;
  stage(id: string, label: string): void;
  stageEnd(id: string, durationMs: number): void;
  warning(message: string): void;
  metrics(
    recordsProcessed: number,
    transportRetries: number,
    reconnects: number,
  ): void;
  result(
    resultWritten: boolean,
    matching: ResolvedMatching,
    count?: { intersectionCount: number; reportedByPartner: boolean },
    entityClusters?: EntityClusterSummary,
  ): void;
  error(error: unknown, phase: ErrorPhase): void;
}

/**
 * Build an {@link EventStreamEmitter} backed by an {@link EventStreamWriter}.
 * Each method constructs its event through the pure builder above and flushes
 * it, so the construction logic stays testable without a live descriptor.
 *
 * Module-private, with {@link openEventStream} its only caller: see the fusion
 * property recorded there.
 */
function createEventStreamEmitter(): EventStreamEmitter {
  const writer = new EventStreamWriter();
  return {
    stages: (stages) => writer.emit(buildStagesEvent(stages)),
    stage: (id, label) => writer.emit(buildStageEvent(id, label)),
    stageEnd: (id, durationMs) =>
      writer.emit(buildStageEndEvent(id, durationMs)),
    warning: (message) => writer.emit(buildWarningEvent(message)),
    metrics: (recordsProcessed, transportRetries, reconnects) =>
      writer.emit(
        buildMetricsEvent(recordsProcessed, transportRetries, reconnects),
      ),
    result: (resultWritten, matching, count, entityClusters) =>
      writer.emit(
        buildResultEvent(resultWritten, matching, count, entityClusters),
      ),
    error: (error, phase) => writer.emit(buildErrorEvent(error, phase)),
  };
}

/**
 * Open the run's machine-interface stream: run the fail-closed fd-3 preflight
 * and build the emitter when `--event-stream` is active, or return `undefined`
 * when it is not -- in which case no writer exists and nothing is ever written
 * to fd 3.
 *
 * Fused here because two callers open the stream: `runProtocol`, and the
 * online bootstrap, which reports persistence losses of its own (see
 * {@link reportPersistenceLoss}). The writer and the emitter factory are
 * module-private, so no route to a writer exists that can skip the preflight.
 */
export function openEventStream(
  enabled: boolean | undefined,
): EventStreamEmitter | undefined {
  if (enabled !== true) return undefined;
  assertEventStreamFdOpen();
  return createEventStreamEmitter();
}

// --- Persistence loss on a completed run -------------------------------------

/**
 * The exit code a run reports when the exchange itself completed and a local
 * write did not: the result file, an audit artifact, the configuration and
 * consent records an online `invite`/`accept` writes, or the configuration and
 * key a zero-setup `--save` writes. `EX_CANTCREAT` (73) in the BSD `sysexits`
 * convention, not `EX_UNAVAILABLE` (69): the two exit codes demand opposite
 * operator responses (retry vs. do not retry), and a bare supervisor sees only
 * the code. See docs/CLI.md (Exit 73) and docs/spec/CLI_EVENTS.md.
 */
export const PERSISTENCE_LOSS_EXIT_CODE = 73;

/**
 * Report a persistence failure the completed exchange survives, on both machine
 * channels at once: the fd-3 `warning` event (when the stream is open) and
 * {@link PERSISTENCE_LOSS_EXIT_CODE}. Every non-fatal loss goes through here, so
 * a new one cannot land on one channel and miss the other. The one loss that is
 * not survivable -- a result file that could not be written -- reports as the
 * terminal `error` event instead, at the same exit code: `runProtocol` stamps
 * it at that write, so a partner-shaped fault elsewhere in the same output
 * stage is not mistaken for a local write loss.
 *
 * `notice` is this party's own prose naming what was lost and what the operator
 * should do; the cause stays on the human log beside this call, escaped once
 * there rather than double-escaped here (see docs/spec/CLI_EVENTS.md,
 * Persistence loss).
 *
 * `process.exitCode` rather than `process.exit`, so the rest of the run's own
 * persistence still happens and still reports what it loses, and a signal
 * handler's `process.exit` is never raced.
 */
export function reportPersistenceLoss(
  notice: string,
  eventStream: EventStreamEmitter | undefined,
): void {
  eventStream?.warning(notice);
  process.exitCode = PERSISTENCE_LOSS_EXIT_CODE;
}
