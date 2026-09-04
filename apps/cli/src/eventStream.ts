import fs from "node:fs";

import {
  ConnectionError,
  OperatorConfigError,
  UsageError,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type { ExchangeStageDefinition } from "@psilink/core";

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
 * The closed vocabulary of event `type` values. This party owns every one of
 * these strings -- none is partner-derived -- so a consumer can switch on the
 * discriminant safely. `stages` is the one-shot stage-list event; `stage` marks
 * each stage transition; `stageEnd` reports a completed stage's wall-clock
 * duration; `warning` carries a non-fatal warning (a terms-exchange warning, the
 * cross-party host-key divergence notice, the resolved-cardinality and
 * pair-table notices of the post-terms, pre-round seam, the
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
 *   solely of this party's own configuration, actionable and safe to surface.
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
 * A stage-completion event, emitted when a protocol stage finishes and carrying
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
 * A non-fatal warning: a terms-exchange warning, the cross-party host-key
 * divergence notice, the resolved-cardinality and pair-table notices raised at
 * the post-terms, pre-round seam, the pre-exchange notice that a signing
 * identity is configured while record writing is off, an audit artifact the
 * run was asked for and could not produce, or a persistence failure that
 * leaves an otherwise complete run short of what it was asked to write -- an
 * online invite/accept's configuration, one of the acceptance's consent
 * records on a reused configuration, the observed received-payload set a
 * later recurring exchange would have been held to, or a zero-setup `--save`
 * run's configuration and key file.
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
   * anyone, in which case {@link intersectionCount} carries the outcome.
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
 * values, over the vocabulary the web front end defines:
 *
 * - `output` phase -> `output` (the exchange already succeeded; only local
 *   result-file generation failed).
 * - an {@link OperatorConfigError} in any earlier phase -> `config`. Scoped to
 *   that exact base type, NOT any {@link UsageError}: a sibling UsageError can be
 *   partner-influenced, so it stays `exchange` rather than being presented as a
 *   purely local configuration fault.
 * - a `security`-kind {@link ConnectionError} (any phase) -> `security`.
 * - everything else -> `exchange`.
 *
 * Both discriminants are structural (the error's TYPE / kind and the PHASE), not
 * a claim about which check happened to fire.
 *
 * The TYPE alone carries the `config` rule, where the web's
 * `classifyExchangeFailure` additionally requires its `prepare` phase. What that
 * category has to agree with here is the exit code, which no front-end alert has:
 * every member of the class exits 64, the code that tells an operator to change
 * their own input, while `exchange` is documented as the retryable bucket -- so a
 * member raised mid-run would have the stream inviting the retry the exit code
 * refuses, on a fault every attempt reproduces identically. Widening costs the
 * category nothing it claims: the class contract is that a member's message is
 * composed solely of this party's own content, phase included, and this stream
 * emits that message under either category anyway.
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
    // sanitize before the text reaches the stream. Redaction first, mirroring
    // the log sink: this stream is a persisted machine sink too, and its error
    // event is already redacted (sanitizeErrorForDisplay), so the warning is
    // where the stream would otherwise carry key material in the clear. The
    // warning sources that carry partner- or server-controlled text redact per
    // fragment where they compose, so the fail-closed dangling rule has nothing
    // left to consume here; the audit-artifact notices carry only an
    // operator-configured path and compose raw, taking their whole escape from
    // this one pass, and the persistence-failure notice composes first-party
    // prose alone. The cap is the shared warning-composition budget, not the
    // per-value default, so a consumer that re-escapes this field at the same
    // budget delivers the whole composition rather than re-capping it.
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
 * stream cannot carry a count without saying whose reading it is.
 */
export function buildResultEvent(
  resultWritten: boolean,
  count?: { intersectionCount: number; reportedByPartner: boolean },
): ResultEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "result",
    resultWritten,
    // The one numeric field of this stream that a partner can influence (the
    // count-report leg carries the receiver's tally to the sender), so it takes
    // the same non-negative whole-number floor the metrics counters take. Core
    // bounds the reported figure to the smaller of the two exchanged record
    // counts before it gets here.
    ...(count !== undefined
      ? {
          intersectionCount: toCount(count.intersectionCount),
          countReportedByPartner: count.reportedByPartner,
        }
      : {}),
  };
}

/** Build the classified failure terminal event. */
export function buildErrorEvent(error: unknown, phase: ErrorPhase): ErrorEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "error",
    category: classifyTerminalError(error, phase),
    // Error text can carry partner- or server-controlled bytes in its message or
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
        "supervisor reads, or drop --event-stream",
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
    count?: { intersectionCount: number; reportedByPartner: boolean },
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
    result: (resultWritten, count) =>
      writer.emit(buildResultEvent(resultWritten, count)),
    error: (error, phase) => writer.emit(buildErrorEvent(error, phase)),
  };
}

/**
 * Open the run's machine-interface stream: run the fail-closed fd-3 preflight
 * and build the emitter when `--event-stream` is active, or return `undefined`
 * when it is not -- in which case no writer exists and nothing is ever written
 * to fd 3.
 *
 * Preflight and construction are fused here because two callers open the
 * stream: `runProtocol`, for an exchange that owns its whole run, and the
 * online bootstrap, which opens it itself because it reports persistence losses
 * of its own from the hooks runProtocol invokes and needs the emitter object to
 * do it (see {@link reportPersistenceLoss}). Fusing them means a second entry
 * point cannot acquire a writer that skipped the preflight -- the writer and the
 * emitter factory are module-private, so this is the compiler's rule rather than
 * a convention: there is no exported route to a writer at all.
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
 * convention -- an output the command was asked to create could not be created.
 *
 * Deliberately NOT `EX_UNAVAILABLE` (69), the transport-failure code. The two
 * demand opposite operator responses -- re-run the exchange, versus do not
 * re-run it and go recover what was lost -- and a bare supervisor (cron, a
 * scheduler, the console job driver) sees only the code: with both conditions
 * under 69 it either retries a completed exchange or never retries a failed
 * one. The terminal `result` event distinguishes them on fd 3, but a supervisor
 * that reads exit status has no fd 3 to read. See docs/CLI.md (Exit codes) and
 * docs/spec/CLI_EVENTS.md.
 */
export const PERSISTENCE_LOSS_EXIT_CODE = 73;

/**
 * Report a persistence failure the completed exchange survives, on both machine
 * channels at once: the fd-3 `warning` event (when the stream is open) and
 * {@link PERSISTENCE_LOSS_EXIT_CODE}. Every non-fatal loss goes through here, so
 * a new one cannot land on one channel and miss the other. The one loss that is
 * not survivable -- a result file that could not be written -- reports as the
 * terminal `error` event instead, carrying the same exit code on the error it
 * throws (`runProtocol` stamps it at that write, so a partner-shaped fault
 * elsewhere in the same output stage is not mistaken for a local write loss).
 *
 * `notice` is this party's own prose naming what was lost and what the operator
 * should do; the CAUSE stays on the human log the caller writes beside this
 * call, because the emitter escapes its message exactly once and pre-rendered
 * error text would reach the stream double-escaped.
 *
 * `process.exitCode` rather than `process.exit` so the rest of the run's own
 * persistence still happens and still reports what it loses -- and so a signal
 * handler's `process.exit` is never raced.
 */
export function reportPersistenceLoss(
  notice: string,
  eventStream: EventStreamEmitter | undefined,
): void {
  eventStream?.warning(notice);
  process.exitCode = PERSISTENCE_LOSS_EXIT_CODE;
}
