// What the operator sees while the PSI phase masks or matches a whole set: a
// live line on the terminal naming the operation in flight, how many values it
// covers and how long it has run, and one line per completed operation with its
// rate. Fed by core's onPsiProgress reports (RunExchangeOptions), wired in
// protocol.ts.
//
// An operation over a set large enough for core to split reports how many
// values it has finished part-way through, and the line states that against the
// operation's total; one over a smaller set reports the total alone, and the
// elapsed figure is all that moves. Either way the elapsed time is drawn from
// the reporting thread's own clock rather than from anything the crypto
// reports, and the rate is measured only once the operation returns.
//
// Every line is composed from fixed literals, an element count and a duration,
// so no partner-supplied text reaches the terminal through it and no display
// escape is needed on the way.

import logLibrary from "loglevel";

import {
  SINGLE_PASS_STAGE_IDS,
  type PsiOperation,
  type PsiProgress,
} from "@alcove/core";

// How the operator is told which operation is running: the exchange's own stage
// ids, except for the count-only round, whose stage lines are numbered rather
// than named.
const OPERATION_LABELS: Record<PsiOperation, string> = {
  createServerSetup: SINGLE_PASS_STAGE_IDS.encryptingOwnData,
  createClientRequest: SINGLE_PASS_STAGE_IDS.encryptingOwnData,
  processClientRequest: SINGLE_PASS_STAGE_IDS.encryptingPartnerData,
  computeAssociationTable: SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
  computeIntersectionCardinality: "counting shared values",
};

// How often the live line is redrawn, and the first moment it appears: an
// operation that settles faster than this draws nothing, so a small dataset's
// run is not a flicker of lines it cannot read.
const TICK_MS = 1000;

// An operation quicker than this reports no completion line. The exchange
// already logs the stage it belongs to, and a sub-second figure is noise in a
// log an unattended run leaves behind.
const MILESTONE_MIN_MS = 1000;

/**
 * The terminal's live line: `draw` replaces whatever it holds, `clear` empties
 * it. A display given none writes no live line at all -- the non-terminal case,
 * where only the completion lines are emitted.
 */
export interface PsiStatusLine {
  draw(text: string): void;
  clear(): void;
}

/** Takes core's PSI progress reports and renders them. */
export interface PsiProgressDisplay {
  report(progress: PsiProgress): void;
  /** Drop the live line and stop redrawing it. Call when the PSI phase ends. */
  close(): void;
}

/** What {@link createPsiProgressDisplay} renders through. */
export interface PsiProgressDisplayOptions {
  /** Takes one line per completed operation, for the run's diagnostics. */
  milestone: (line: string) => void;
  /** The terminal's live line, when this run has one. */
  statusLine?: PsiStatusLine;
  /**
   * Installs `clearLine` to run immediately before each diagnostic log line
   * reaches its sink and returns the removal, as `runBeforeEachLogLine`
   * (./util/logging) does. Passed with a status line, a log line drops the live
   * row before writing and the next tick redraws it, so the two do not share a
   * row. A display with no status line installs nothing.
   */
  clearBeforeLogLine?: (clearLine: () => void) => () => void;
  /**
   * The clock the elapsed figures are read from. Defaults to
   * `performance.now`, the monotonic clock core measures `durationMs` on, so a
   * clock adjustment mid-operation cannot move the elapsed figure.
   */
  now?: () => number;
  /** Redraw interval. Defaults to {@link TICK_MS}. */
  tickMs?: number;
}

/** Digits of `value` in groups of three, so a millions figure stays readable. */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `durationMs` as the largest two units that hold it -- `42s`, `1m 12s`,
 * `2h 05m` -- so a multi-minute operation's figure stays short enough for one
 * line.
 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** `count` with the unit the operator reads it in, singular where it is one. */
export function formatValues(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "value" : "values"}`;
}

// The measured throughput, or undefined where the figures do not support one:
// too short an operation to divide by, or a rate that rounds to nothing.
function formatRate(elements: number, durationMs: number): string | undefined {
  if (durationMs <= 0) return undefined;
  const perSecond = Math.round(elements / (durationMs / 1000));
  if (perSecond < 1) return undefined;
  return `${formatCount(perSecond)} values/s`;
}

/**
 * How far into its set an operation is: `4,000 of 10,000 values (40%)`, or the
 * total alone where nothing has been reported yet. The share is rounded down
 * and held at 100 so a count that overshoots its total by a rounding step
 * cannot put the line past that total.
 */
function formatProcessed(
  elements: number,
  processed: number | undefined,
): string {
  if (processed === undefined) return formatValues(elements);
  const share =
    elements <= 0
      ? 100
      : Math.min(100, Math.floor((processed / elements) * 100));
  return `${formatCount(processed)} of ${formatValues(elements)} (${share}%)`;
}

/**
 * The live line's text for an operation that has run `elapsedMs`, having
 * finished `processed` of its values where core has reported a count.
 */
export function psiStatusText(
  operation: PsiOperation,
  elements: number,
  elapsedMs: number,
  processed?: number,
): string {
  return (
    `${OPERATION_LABELS[operation]}: ${formatProcessed(elements, processed)}, ` +
    `${formatDuration(elapsedMs)} elapsed`
  );
}

/**
 * The completion line for `progress`, or `undefined` where there is nothing to
 * report: an operation that failed rather than finished, one whose report holds
 * no duration, and one quick enough that its figures are noise.
 */
export function psiMilestoneText(progress: PsiProgress): string | undefined {
  const { operation, elements, state, durationMs } = progress;
  if (state !== "finished") return undefined;
  if (durationMs === undefined || durationMs < MILESTONE_MIN_MS)
    return undefined;
  const rate = formatRate(elements, durationMs);
  return (
    `${OPERATION_LABELS[operation]}: ${formatValues(elements)} in ` +
    `${formatDuration(durationMs)}${rate === undefined ? "" : ` (${rate})`}`
  );
}

/**
 * The display the PSI phase reports through: it redraws the live line while an
 * operation runs and emits one completion line per operation that finishes.
 * A failed operation clears the line and reports no figures -- it produced no
 * result, and the failure itself is reported by the run.
 */
export function createPsiProgressDisplay(
  options: PsiProgressDisplayOptions,
): PsiProgressDisplay {
  const now = options.now ?? ((): number => performance.now());
  const tickMs = options.tickMs ?? TICK_MS;
  const statusLine = options.statusLine;
  let running:
    | {
        operation: PsiOperation;
        elements: number;
        startedAt: number;
        processed?: number;
      }
    | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let drawn = false;

  const stopTicker = (): void => {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  };

  const clearLine = (): void => {
    if (!drawn) return;
    drawn = false;
    statusLine?.clear();
  };

  let removeLogLineHook =
    statusLine === undefined
      ? undefined
      : options.clearBeforeLogLine?.(clearLine);

  const draw = (): void => {
    if (statusLine === undefined || running === undefined) return;
    drawn = true;
    statusLine.draw(
      psiStatusText(
        running.operation,
        running.elements,
        Math.max(0, now() - running.startedAt),
        running.processed,
      ),
    );
  };

  return {
    report(progress: PsiProgress): void {
      if (progress.state === "started") {
        running = {
          operation: progress.operation,
          elements: progress.elements,
          startedAt: now(),
        };
        stopTicker();
        if (statusLine === undefined) return;
        ticker = setInterval(draw, tickMs);
        // An operation holds the process open on its own (the PSI worker is
        // ref'd while it runs), so the redraw timer must not: a report that
        // never settles leaves it the only thing keeping the process alive.
        ticker.unref();
        return;
      }
      if (progress.state === "progress") {
        // Recorded for the next redraw rather than drawn here: an operation
        // that settles inside the first tick still draws nothing, which is
        // what keeps a short run from flickering a line it cannot read.
        if (running !== undefined) running.processed = progress.processed;
        return;
      }
      running = undefined;
      stopTicker();
      clearLine();
      const line = psiMilestoneText(progress);
      if (line !== undefined) options.milestone(line);
    },
    close(): void {
      running = undefined;
      stopTicker();
      clearLine();
      removeLogLineHook?.();
      removeLogLineHook = undefined;
    },
  };
}

// Best-effort write of the live line: a wedged or closed stderr drops it rather
// than throwing back into the exchange the line only annotates.
function writeStatus(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // Dropped; the completion lines still go through the logger.
  }
}

// The text a draw puts on the row, cut to one column short of the terminal's
// width: a line filling the last column wraps onto a second row, which the
// carriage return of the next draw no longer reaches, leaving a row per redraw
// behind. A terminal reporting no width takes the text as composed.
function fitToTerminalWidth(text: string): string {
  const columns: number | undefined = process.stderr.columns;
  if (columns === undefined) return text;
  return text.slice(0, Math.max(0, columns - 1));
}

/**
 * The live line for a run whose terminal takes one, or `undefined` when it does
 * not. Every condition has to hold: stderr is a terminal (a pipe or a file
 * takes the completion lines only, never a redraw), `--log-file` was not given
 * (the run's diagnostics go to the file, so a redraw on the terminal would be
 * the only thing there), `TERM` is not `dumb` (a terminal that takes no cursor
 * escapes, and the opt-out for an operator reading through one), and the run is
 * at the default verbosity and log level -- a quieter run asked for less than
 * this, and a `-v` or `--log-level debug` run gets the debug stream, whose
 * lines a redrawn line would land on top of.
 *
 * `\r` returns to the column the line starts in and the erase-to-end-of-line
 * escape drops what the previous, possibly longer, draw left there.
 */
export function terminalPsiStatusLine(params: {
  verbosity: number;
  logFile: string | undefined;
}): PsiStatusLine | undefined {
  if (process.stderr.isTTY !== true) return undefined;
  if (params.logFile !== undefined) return undefined;
  if (process.env.TERM === "dumb") return undefined;
  if (params.verbosity > 0) return undefined;
  if (logLibrary.getLevel() !== logLibrary.levels.INFO) return undefined;
  return {
    draw: (text: string) => writeStatus(`\r${fitToTerminalWidth(text)}\x1b[K`),
    clear: () => writeStatus("\r\x1b[K"),
  };
}
