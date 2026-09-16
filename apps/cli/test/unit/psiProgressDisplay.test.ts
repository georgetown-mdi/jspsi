import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import type { PsiProgress } from "@psilink/core";

import {
  createPsiProgressDisplay,
  formatCount,
  formatDuration,
  psiMilestoneText,
  psiStatusText,
  terminalPsiStatusLine,
  type PsiStatusLine,
} from "../../src/psiProgressDisplay";

// The display an operator watches during the PSI phase: what the live line
// holds while one operation runs, when a completion line is worth logging, and
// that neither outlives the operation it reports on.

function started(elements: number): PsiProgress {
  return { operation: "processClientRequest", elements, state: "started" };
}

function finished(elements: number, durationMs: number): PsiProgress {
  return {
    operation: "processClientRequest",
    elements,
    state: "finished",
    durationMs,
  };
}

function recordingStatusLine(): {
  line: PsiStatusLine;
  draws: Array<string>;
  clears: { count: number };
} {
  const draws: Array<string> = [];
  const clears = { count: 0 };
  return {
    line: {
      draw: (text: string) => draws.push(text),
      clear: () => {
        clears.count += 1;
      },
    },
    draws,
    clears,
  };
}

test("groups a millions-scale count into threes", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(1000)).toBe("1,000");
  expect(formatCount(1_204_833)).toBe("1,204,833");
});

test.each([
  [0, "0s"],
  [999, "0s"],
  [42_000, "42s"],
  [72_000, "1m 12s"],
  [3_600_000, "1h 00m"],
  [7_500_000, "2h 05m"],
])("renders %i ms as %s", (durationMs, expected) => {
  expect(formatDuration(durationMs)).toBe(expected);
});

test("the live line names the operation, the count and the elapsed time", () => {
  expect(psiStatusText("processClientRequest", 1_204_833, 72_000)).toBe(
    "doubly-encrypting the partner's data: 1,204,833 values, 1m 12s elapsed",
  );
  expect(psiStatusText("createServerSetup", 12, 3000)).toBe(
    "encrypting my data: 12 values, 3s elapsed",
  );
});

test("a completion line states the measured rate", () => {
  expect(psiMilestoneText(finished(120_000, 60_000))).toBe(
    "doubly-encrypting the partner's data: 120,000 values in 1m 0s " +
      "(2,000 values/s)",
  );
});

test("a completion line drops a rate the figures do not support", () => {
  // An operation slower than one value a second: the rounded rate is nothing,
  // so the line states the count and the time and claims no throughput.
  expect(psiMilestoneText(finished(1, 4000))).toBe(
    "doubly-encrypting the partner's data: 1 value in 4s",
  );
});

test.each([
  ["a quick operation", finished(5, 40)],
  [
    "an operation that failed",
    {
      operation: "processClientRequest",
      elements: 100,
      state: "failed",
      durationMs: 90_000,
    } satisfies PsiProgress,
  ],
  [
    "a report with no duration",
    {
      operation: "processClientRequest",
      elements: 100,
      state: "finished",
    } satisfies PsiProgress,
  ],
])("reports nothing for %s", (_name, progress) => {
  expect(psiMilestoneText(progress)).toBeUndefined();
});

test("a display with no status line still logs the completion", () => {
  const milestones: Array<string> = [];
  const display = createPsiProgressDisplay({
    milestone: (line) => milestones.push(line),
    now: () => 0,
  });

  display.report(started(120_000));
  display.report(finished(120_000, 60_000));

  expect(milestones).toStrictEqual([
    "doubly-encrypting the partner's data: 120,000 values in 1m 0s " +
      "(2,000 values/s)",
  ]);
});

test("the live line updates on each tick and is dropped when the operation settles", () => {
  vi.useFakeTimers();
  try {
    const { line, draws, clears } = recordingStatusLine();
    let clock = 0;
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      now: () => clock,
      tickMs: 1000,
    });

    display.report(started(120_000));
    // Nothing is drawn before the first tick, so an operation that settles
    // quickly leaves the terminal untouched.
    expect(draws).toStrictEqual([]);

    clock = 1000;
    vi.advanceTimersByTime(1000);
    clock = 2000;
    vi.advanceTimersByTime(1000);
    expect(draws).toStrictEqual([
      "doubly-encrypting the partner's data: 120,000 values, 1s elapsed",
      "doubly-encrypting the partner's data: 120,000 values, 2s elapsed",
    ]);

    clock = 60_000;
    display.report(finished(120_000, 60_000));
    expect(clears.count).toBe(1);

    // The redraw stops with the operation: a later tick draws nothing.
    vi.advanceTimersByTime(5000);
    expect(draws).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a settled operation that drew nothing clears nothing", () => {
  vi.useFakeTimers();
  try {
    const { line, clears } = recordingStatusLine();
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      now: () => 0,
      tickMs: 1000,
    });

    display.report(started(5));
    display.report(finished(5, 40));

    expect(clears.count).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("close drops the line and stops the redraw of an operation still running", () => {
  vi.useFakeTimers();
  try {
    const { line, draws, clears } = recordingStatusLine();
    let clock = 0;
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      now: () => clock,
      tickMs: 1000,
    });

    display.report(started(120_000));
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(draws).toHaveLength(1);

    display.close();
    expect(clears.count).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(draws).toHaveLength(1);
    // Idempotent: a second close has nothing left to drop.
    display.close();
    expect(clears.count).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

// A failed operation clears the line and logs no figures; the run reports the
// failure itself.
test("a failed operation clears the line and logs nothing", () => {
  vi.useFakeTimers();
  try {
    const { line, clears } = recordingStatusLine();
    const milestones: Array<string> = [];
    let clock = 0;
    const display = createPsiProgressDisplay({
      milestone: (text) => milestones.push(text),
      statusLine: line,
      now: () => clock,
      tickMs: 1000,
    });

    display.report(started(120_000));
    clock = 1000;
    vi.advanceTimersByTime(1000);
    display.report({
      operation: "processClientRequest",
      elements: 120_000,
      state: "failed",
      durationMs: 1000,
    });

    expect(clears.count).toBe(1);
    expect(milestones).toStrictEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

// Which runs get a live line. A pipe, a file, a quiet run and a verbose one
// each take the completion lines alone -- a redraw either lands in a log or
// collides with the debug stream.
const originalIsTty = process.stderr.isTTY;
const originalLevel = logLibrary.getLevel();

afterEach(() => {
  process.stderr.isTTY = originalIsTty;
  logLibrary.setDefaultLevel(originalLevel);
});

test("a non-terminal stderr takes no live line", () => {
  process.stderr.isTTY = false;
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);

  expect(terminalPsiStatusLine(0)).toBeUndefined();
});

test("a verbose or quiet run takes no live line", () => {
  process.stderr.isTTY = true;
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  expect(terminalPsiStatusLine(1)).toBeUndefined();

  logLibrary.setDefaultLevel(logLibrary.levels.WARN);
  expect(terminalPsiStatusLine(0)).toBeUndefined();

  logLibrary.setDefaultLevel(logLibrary.levels.SILENT);
  expect(terminalPsiStatusLine(0)).toBeUndefined();
});

test("a terminal run redraws one line in place", () => {
  process.stderr.isTTY = true;
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const written: Array<string> = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  try {
    const line = terminalPsiStatusLine(0);
    line?.draw("encrypting my data: 12 values, 3s elapsed");
    line?.clear();
  } finally {
    write.mockRestore();
  }

  // Back to the start of the line, then erase what a longer previous draw left
  // past the new text.
  expect(written).toStrictEqual([
    "\rencrypting my data: 12 values, 3s elapsed\x1b[K",
    "\r\x1b[K",
  ]);
});

test("a wedged stderr drops the line rather than raising", () => {
  process.stderr.isTTY = true;
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((): never => {
      throw new Error("EPIPE");
    });
  try {
    const line = terminalPsiStatusLine(0);
    expect(() =>
      line?.draw("encrypting my data: 12 values, 3s elapsed"),
    ).not.toThrow();
  } finally {
    write.mockRestore();
  }
});
