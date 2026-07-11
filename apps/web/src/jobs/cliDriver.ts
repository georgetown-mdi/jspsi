import path from "node:path";

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { sanitizeForDisplay } from "@psilink/core";

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * The CLI's fd-3 event vocabulary (schema v1), re-validated at the trust
 * boundary. Mirrors docs/spec/CLI_EVENTS.md and apps/cli/src/eventStream.ts. The
 * server does not import the CLI's own event types (the CLI is a separate
 * workspace it drives as a subprocess), so it validates each parsed line against
 * this shape independently -- a malformed or unknown line is fail-safe, never a
 * crash.
 */
export type RelayEventType =
  "stages" | "stage" | "warning" | "result" | "error";

/** A relayed CLI event after schema validation and field sanitization. */
export interface RelayEvent {
  v: number;
  type: RelayEventType;
  [key: string]: unknown;
}

/**
 * How a driven CLI run terminated, reconciled with the CLI's terminal-event
 * contract (docs/spec/CLI_EVENTS.md, Terminal-event guarantees):
 * - `succeeded`: exit 0.
 * - `failed`: an organic failure (exit 64/69/1), with the code recorded.
 * - `cancelled`: an interrupt (exit 130 for SIGINT, 143 for SIGTERM), the
 *   legitimate "no terminal event + signal exit" case.
 */
export type JobOutcome = "succeeded" | "failed" | "cancelled";

/** The reconciled terminal state of a CLI run. */
export interface JobTerminalState {
  outcome: JobOutcome;
  /** The process exit code, when the child exited rather than dying to a signal. */
  exitCode: number | null;
  /** The signal that killed the child, when it died to one. */
  signal: NodeJS.Signals | null;
}

/** Callbacks the job manager wires into a driven run. */
export interface CliDriverHandlers {
  /** A validated, sanitized fd-3 event. */
  onEvent: (event: RelayEvent) => void;
  /**
   * A degradation notice (a malformed/unknown fd-3 line, or an oversized stream)
   * surfaced as a synthesized warning rather than crashing the relay.
   */
  onDegraded: (message: string) => void;
  /** The run's reconciled terminal state, delivered exactly once. */
  onTerminal: (state: JobTerminalState) => void;
}

/** A handle on a running CLI child, exposing only signal delivery. */
export interface CliDriverHandle {
  /** Deliver a signal to the child. Returns false if the child already exited. */
  signal: (signal: NodeJS.Signals) => boolean;
  /** Whether the child is still running. */
  isRunning: () => boolean;
}

/** The environment variable that overrides the CLI binary path. */
export const JOB_CLI_BINARY_ENV = "JOB_CLI_BINARY";

/**
 * The workspace-relative default for the built CLI entry, resolved from this
 * module's location up to the repo root. Used when {@link JOB_CLI_BINARY_ENV} is
 * unset. This module lives at apps/web/src/jobs/, so four levels up is the
 * workspace root.
 */
function defaultCliBinaryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "cli",
    "dist",
    "index.js",
  );
}

/**
 * Resolve the CLI binary path: the {@link JOB_CLI_BINARY_ENV} override when set
 * (used both by production overrides and by tests pointing the driver at a stub),
 * otherwise the workspace-relative built entry.
 */
export function resolveCliBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[JOB_CLI_BINARY_ENV];
  if (override !== undefined && override.length > 0) return override;
  return defaultCliBinaryPath();
}

/**
 * The maximum length of child stderr retained as a diagnostic tail, in UTF-16
 * code units. Bounded so a chatty or hostile child cannot grow server memory
 * without limit; the tail is sanitized before it is surfaced and is never
 * streamed to the client raw.
 */
export const STDERR_TAIL_CAP = 8192;

/**
 * The maximum length buffered on the fd-3 line reader, in UTF-16 code units,
 * before the partial line is discarded as oversized.
 */
const FD3_LINE_CAP = 1_048_576;

/**
 * Spawn the CLI to run a filedrop `exchange`, wiring fd 3 for the event stream.
 * argv is assembled ONLY from fixed templates plus the server-generated paths in
 * `paths`; no client-supplied string reaches argv, and `shell` is never used.
 *
 * `spawn` (not `execFile`) is used deliberately: the caller passes an argv ARRAY
 * with `shell: false`, which gives identical allowlisted-argv, no-shell safety,
 * and unlike `execFile` it exposes the fd-3 pipe the event stream requires
 * (execFile caps stdio at three pipes and cannot carry fd 3).
 */
export function spawnExchangeJob(args: {
  binaryPath: string;
  configPath: string;
  keyPath: string;
  inputPath: string;
  outputPath: string;
  workdir: string;
  eventStream: boolean;
  handlers: CliDriverHandlers;
  /**
   * Extra environment variables merged into the child's minimal environment.
   * The production driver passes none; the driver tests use it to configure the
   * stub CLI. Not a channel for client input: it is set only by the server-side
   * caller, never derived from a request.
   */
  extraEnv?: NodeJS.ProcessEnv;
}): CliDriverHandle {
  const { binaryPath, configPath, keyPath, inputPath, outputPath, workdir } =
    args;
  const { handlers, eventStream, extraEnv } = args;

  // Fixed argv template. Every element is a server constant or a server-generated
  // absolute path; nothing here derives from client text.
  const argv: Array<string> = [
    binaryPath,
    "exchange",
    "--config-file",
    configPath,
    "--key-file",
    keyPath,
    ...(eventStream ? ["--event-stream"] : []),
    inputPath,
    outputPath,
  ];

  const child = spawn(process.execPath, argv, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    shell: false,
    env: { ...sanitizedChildEnv(), ...extraEnv },
  });

  attachFd3Reader(child, handlers);
  const stderrTail = attachStderrTail(child);
  attachTerminalReconciliation(child, handlers, stderrTail);

  return {
    signal: (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return child.kill(signal);
    },
    isRunning: () => child.exitCode === null && child.signalCode === null,
  };
}

/**
 * A minimal child environment: PATH and locale only, so the driven CLI inherits
 * no ambient secrets from the server process and behaves deterministically. The
 * job's own inputs reach the child through files in its workdir, not the
 * environment.
 */
function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TZ"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Line-buffer fd 3 as NDJSON. Each complete line is parsed, schema-validated
 * against the v1 vocabulary, and every string field sanitized before it reaches
 * the handler. A malformed or unknown line does not crash the relay: it is
 * surfaced as a degradation notice and dropped. The buffer is capped so an
 * unterminated flood cannot grow without bound.
 */
function attachFd3Reader(
  child: ChildProcess,
  handlers: CliDriverHandlers,
): void {
  const fd3Raw = child.stdio[3];
  if (
    fd3Raw === null ||
    fd3Raw === undefined ||
    typeof fd3Raw === "number" ||
    typeof (fd3Raw as Readable).setEncoding !== "function"
  ) {
    handlers.onDegraded("CLI event stream (fd 3) was not available");
    return;
  }
  const fd3 = fd3Raw as Readable;
  let buffer = "";
  fd3.setEncoding("utf8");
  fd3.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > FD3_LINE_CAP) {
      handlers.onDegraded("CLI event stream line exceeded the size cap");
      buffer = "";
      return;
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleFd3Line(line, handlers);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  fd3.on("end", () => {
    const trailing = buffer.trim();
    if (trailing.length > 0) handleFd3Line(trailing, handlers);
    buffer = "";
  });
  fd3.on("error", () => {
    handlers.onDegraded("CLI event stream (fd 3) reported a read error");
  });
}

/**
 * Parse and validate one fd-3 line. Uses a bounded JSON parse followed by a
 * structural check against the v1 vocabulary; anything that does not validate is
 * a degradation, not a crash.
 */
function handleFd3Line(line: string, handlers: CliDriverHandlers): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    handlers.onDegraded("CLI emitted a non-JSON event line");
    return;
  }
  const event = validateAndSanitizeEvent(parsed);
  if (event === null) {
    handlers.onDegraded("CLI emitted an event outside the known schema");
    return;
  }
  handlers.onEvent(event);
}

const RELAY_EVENT_TYPES = new Set<RelayEventType>([
  "stages",
  "stage",
  "warning",
  "result",
  "error",
]);

/**
 * Validate a parsed fd-3 value against the v1 event vocabulary and sanitize every
 * string field (recursively, through arrays and nested objects) before it is
 * buffered or relayed. The CLI already sanitizes at construction; re-sanitizing
 * here is deliberate defense in depth at the trust-boundary crossing, so a
 * hostile string that somehow reached the stream cannot inject a control
 * sequence into a downstream consumer. Returns null for anything that does not
 * match the schema.
 */
export function validateAndSanitizeEvent(value: unknown): RelayEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const type = record.type;
  if (
    typeof type !== "string" ||
    !RELAY_EVENT_TYPES.has(type as RelayEventType)
  )
    return null;
  const sanitized = sanitizeValue(record) as Record<string, unknown>;
  return { ...sanitized, v: 1, type: type as RelayEventType };
}

/**
 * Recursively sanitize a JSON value through the display escaper: every string,
 * whether a value or an object key, so no partner-influenced text crosses the
 * trust boundary unescaped. A known event's keys are fixed, but a subverted
 * source could emit arbitrary keys, so keys are escaped for the same reason
 * values are.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeForDisplay(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>))
      out[sanitizeForDisplay(key)] = sanitizeValue(inner);
    return out;
  }
  return value;
}

/** Retain a bounded, sanitized tail of the child's stderr for diagnostics. */
function attachStderrTail(child: ChildProcess): { get: () => string } {
  let tail = "";
  const stderr = child.stderr;
  if (stderr !== null) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_CAP);
    });
  }
  return { get: () => sanitizeForDisplay(tail) };
}

/**
 * Reconcile the child's exit into a {@link JobTerminalState}, delivered exactly
 * once. The exit-code contract (docs/spec/CLI_EVENTS.md):
 * - 0 -> succeeded.
 * - 130 (SIGINT) / 143 (SIGTERM) -> cancelled; a signal exit legitimately has no
 *   terminal fd-3 event, so this is not treated as a broken stream.
 * - any other exit / a death to a signal -> failed, with the code recorded.
 *
 * Whether the CLI emitted its own terminal fd-3 event is the manager's concern
 * (it synthesizes one when a non-interrupt exit produced none); this layer only
 * classifies the exit.
 */
function attachTerminalReconciliation(
  child: ChildProcess,
  handlers: CliDriverHandlers,
  stderrTail: { get: () => string },
): void {
  let delivered = false;
  const deliver = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (delivered) return;
    delivered = true;
    handlers.onTerminal(classifyExit(exitCode, signal));
  };
  // "close", not "exit": close fires only after every stdio stream has drained,
  // so the CLI's own terminal fd-3 event is always parsed before the exit is
  // classified. On "exit" the terminal line can still sit in the pipe buffer,
  // and the manager would synthesize a misclassified terminal in its place.
  child.on("close", (code, signal) => deliver(code, signal));
  child.on("error", (error: Error) => {
    // The child could not be spawned or died abnormally; surface a diagnostic and
    // classify as a failure so the manager always reaches a terminal state.
    handlers.onDegraded(
      `CLI process error: ${sanitizeForDisplay(error.message)}${
        stderrTail.get().length > 0 ? ` (stderr: ${stderrTail.get()})` : ""
      }`,
    );
    deliver(1, null);
  });
}

/** Map a raw exit code / signal to a reconciled terminal state. */
export function classifyExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): JobTerminalState {
  if (exitCode === 0)
    return { outcome: "succeeded", exitCode: 0, signal: null };
  if (exitCode === 130 || exitCode === 143)
    return { outcome: "cancelled", exitCode, signal: null };
  if (signal === "SIGINT")
    return { outcome: "cancelled", exitCode: null, signal };
  if (signal === "SIGTERM")
    return { outcome: "cancelled", exitCode: null, signal };
  return { outcome: "failed", exitCode, signal };
}
