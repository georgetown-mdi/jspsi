import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * What the stdout result drain does with a real reader on a real pipe: it
 * waits out one that keeps taking the result however long that takes, and
 * gives up on one that stops.
 *
 * The ceiling it applies is an IDLE one, and that distinction only exists
 * against a reader whose pace the process does not control -- a stub that
 * reports the writes taken decides the answer it is asked for. So the result
 * here goes down a pipe this test holds, to a reader pulling it at a fixed
 * rate (`test/stdoutDrainProbe.ts`), and the drain's own ceiling is cut to a
 * second so a case measures rather than waits.
 *
 * The slow-reader case encodes the claim the whole bound rests on: that a
 * result written under backpressure reports progress as the reader takes it,
 * often enough that a reader still consuming never reaches the ceiling. Node
 * reports none of it for a result written in one pass -- one write request,
 * every callback at the end -- which would leave the idle deadline no better
 * than a budget for the whole drain, and this case is what would say so.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const probeEntry = path.join(here, "../../stdoutDrainProbe.ts");

/**
 * The injected ceiling: a second and a half rather than the shipped minute,
 * which is long enough that a scheduling stall on a loaded machine does not
 * decide the slow-reader case and short enough that the expiry is measured
 * rather than waited out.
 */
const IDLE_CEILING_MS = 1_500;

/**
 * Rows enough for a result of several megabytes, far past the pipe buffer any
 * platform here gives it, so the reader's pace is what the drain waits on.
 */
const RESULT_ROWS = 90_000;

/**
 * The reader's pace: this many bytes every {@link READ_GAP_MS}, pulled rather
 * than taken as they arrive, so the rate is the case's and not the adaptive
 * one a flowing stream settles into. Around 1.5 MB/s, so the result above
 * takes several seconds and every gap between drains stays far inside the
 * ceiling.
 */
const READ_BYTES = 32 * 1024;
const READ_GAP_MS = 20;

/** A probe that neither delivers nor expires is killed rather than hung on. */
const PROBE_DEADLINE_MS = 120_000;

const CASE_TIMEOUT_MS = 180_000;

interface ProbeRun {
  exitCode: number | null;
  stderr: string;
  /** Complete lines of the result this side received. */
  lines: number;
  bytes: number;
  /** The last line received, whole or partial, for the completeness check. */
  lastLine: string;
}

/**
 * Run the probe and read its result at `readGapMs` between reads, or -- where
 * `stopAfterFirstRead` is set -- take the first read and then stop, leaving the
 * pipe open and unread as a reader that died mid-result does.
 *
 * Reading resumes on the child's exit either way, so the stream reaches its end
 * and the run's own close arrives rather than the case waiting out its deadline
 * on an abandoned pipe.
 */
function runProbe(params: {
  readGapMs: number;
  stopAfterFirstRead: boolean;
}): Promise<ProbeRun> {
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      probeEntry,
      "--idle-ceiling-ms",
      String(IDLE_CEILING_MS),
      "--rows",
      String(RESULT_ROWS),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let lines = 0;
  let bytes = 0;
  let lastLine = "";
  const out = child.stdout;
  const err = child.stderr;
  if (out === null || err === null) throw new Error("the probe has no pipes");
  err.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const take = (chunk: Buffer): void => {
    bytes += chunk.length;
    const parts = (lastLine + chunk.toString()).split("\n");
    lastLine = parts.pop() ?? "";
    lines += parts.length;
  };
  let reads = 0;
  const pulling = setInterval(() => {
    if (params.stopAfterFirstRead && reads > 0) return;
    const chunk: Buffer | null = out.read(READ_BYTES) as Buffer | null;
    if (chunk === null) return;
    reads += 1;
    take(chunk);
  }, params.readGapMs);
  const deadline = setTimeout(() => child.kill("SIGKILL"), PROBE_DEADLINE_MS);
  return new Promise<ProbeRun>((resolve) => {
    // Reading resumes on the probe's exit, so what it left in the pipe reaches
    // this side and the stream ends rather than the case waiting out its
    // deadline on a pipe nobody is reading.
    child.once("exit", () => {
      clearInterval(pulling);
      out.on("data", take);
      out.resume();
    });
    child.once("close", (exitCode) => {
      clearTimeout(deadline);
      resolve({ exitCode, stderr, lines, bytes, lastLine });
    });
  });
}

/** The delivered milliseconds the probe reports, by marker. */
function probeMs(run: ProbeRun, marker: string): number {
  const found = new RegExp(`${marker} (\\d+)`).exec(run.stderr);
  if (found === null)
    throw new Error(
      `the probe reported no ${marker}; it wrote ${JSON.stringify(run.stderr)}`,
    );
  return Number(found[1]);
}

test(
  "a reader taking the result slowly receives every row",
  async () => {
    // The reader consumes continuously and never comes close to the ceiling
    // between reads, so the drain runs many times the ceiling's length and is
    // not a reader that stopped. A total budget would cut it off at the
    // ceiling, costing a completed exchange its result.
    const run = await runProbe({
      readGapMs: READ_GAP_MS,
      stopAfterFirstRead: false,
    });

    expect(run.stderr).toContain("PROBE-DELIVERED");
    expect(run.exitCode).toBe(0);
    expect(run.lines).toBe(RESULT_ROWS + 1);
    expect(run.lastLine).toBe("");
    expect(probeMs(run, "PROBE-DELIVERED")).toBeGreaterThan(IDLE_CEILING_MS);
  },
  CASE_TIMEOUT_MS,
);

test(
  "a reader that stops mid-result costs it at the idle ceiling",
  async () => {
    // The same result and the same ceiling, with a reader that takes its first
    // read and then stops: the pipe fills, nothing more leaves the process, and
    // the drain gives up an idle ceiling after the last line that did.
    const run = await runProbe({
      readGapMs: READ_GAP_MS,
      stopAfterFirstRead: true,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("nothing more of the result left the process");
    expect(run.lines).toBeLessThan(RESULT_ROWS + 1);
    // It gave up on the stall rather than on the clock the whole result would
    // have taken, which the case above measures at many times the ceiling.
    expect(probeMs(run, "PROBE-UNDELIVERED")).toBeLessThan(IDLE_CEILING_MS * 3);
  },
  CASE_TIMEOUT_MS,
);
