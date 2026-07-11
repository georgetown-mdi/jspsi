import fs from "node:fs";

import {
  ConnectionError,
  OperatorConfigError,
  UsageError,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
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
 * each stage transition; `warning` carries a non-fatal terms-exchange warning;
 * `result` and `error` are the two terminal events (exactly one fires per run).
 */
export type EventType = "stages" | "stage" | "warning" | "result" | "error";

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

/** A non-fatal warning from the terms exchange. */
export interface WarningEvent extends EventBase {
  type: "warning";
  message: string;
}

/** The success terminal event. Exactly one terminal event fires per run. */
export interface ResultEvent extends EventBase {
  type: "result";
  /**
   * Whether this party received a matched result table. False for a one-sided
   * exchange in which this party is the helper and its agreed terms give it no
   * output -- it contributed to the match but receives no result file.
   */
  resultWritten: boolean;
}

/** The failure terminal event. Exactly one terminal event fires per run. */
export interface ErrorEvent extends EventBase {
  type: "error";
  category: ExchangeErrorCategory;
  /** Display-safe error text ({@link sanitizeErrorForDisplay}). */
  message: string;
}

export type StreamEvent =
  StagesEvent | StageEvent | WarningEvent | ResultEvent | ErrorEvent;

// --- Pure event construction (no file descriptor) ----------------------------

/**
 * Classify a terminal failure into one of the four {@link ExchangeErrorCategory}
 * values, using the SAME rules the web's `classifyExchangeFailure` applies:
 *
 * - `output` phase -> `output` (the exchange already succeeded; only local
 *   result-file generation failed).
 * - `prepare` phase + an {@link OperatorConfigError} -> `config`. Scoped to that
 *   exact base type, NOT any prepare-phase {@link UsageError}: a sibling
 *   prepare-time UsageError can be partner-influenced, so it stays `exchange`
 *   rather than being presented as a purely local configuration fault.
 * - a `security`-kind {@link ConnectionError} (any phase) -> `security`.
 * - everything else -> `exchange`.
 *
 * Both discriminants are structural (the error's TYPE / kind and the PHASE), not
 * a claim about which check happened to fire.
 */
export function classifyTerminalError(
  error: unknown,
  phase: ErrorPhase,
): ExchangeErrorCategory {
  if (phase === "output") return "output";
  if (phase === "prepare" && error instanceof OperatorConfigError)
    return "config";
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
    // so sanitize it exactly as protocol.ts does before a label reaches stderr.
    // The id is this party's own constant vocabulary from describeExchangeStages,
    // but it is echoed on the wire in the same format, so sanitize it uniformly.
    stages: stages.map(({ id, label }) => ({
      id: sanitizeForDisplay(id),
      label: sanitizeForDisplay(label),
    })),
  };
}

/** Build a stage-transition event from an id and its resolved display label. */
export function buildStageEvent(id: string, label: string): StageEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stage",
    id: sanitizeForDisplay(id),
    label: sanitizeForDisplay(label),
  };
}

/** Build a warning event from a non-fatal terms-exchange warning. */
export function buildWarningEvent(message: string): WarningEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "warning",
    // Terms-exchange warnings can embed partner-authored column names, so
    // sanitize before the text reaches the stream.
    message: sanitizeForDisplay(message),
  };
}

/** Build the success terminal event. */
export function buildResultEvent(resultWritten: boolean): ResultEvent {
  return { v: EVENT_STREAM_VERSION, type: "result", resultWritten };
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
        "supervisor reads (see docs/spec/CLI_EVENTS.md), or drop --event-stream",
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
export class EventStreamWriter {
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
  warning(message: string): void;
  result(resultWritten: boolean): void;
  error(error: unknown, phase: ErrorPhase): void;
}

/**
 * Build an {@link EventStreamEmitter} backed by an {@link EventStreamWriter}.
 * Each method constructs its event through the pure builder above and flushes
 * it, so the construction logic stays testable without a live descriptor.
 */
export function createEventStreamEmitter(): EventStreamEmitter {
  const writer = new EventStreamWriter();
  return {
    stages: (stages) => writer.emit(buildStagesEvent(stages)),
    stage: (id, label) => writer.emit(buildStageEvent(id, label)),
    warning: (message) => writer.emit(buildWarningEvent(message)),
    result: (resultWritten) => writer.emit(buildResultEvent(resultWritten)),
    error: (error, phase) => writer.emit(buildErrorEvent(error, phase)),
  };
}
