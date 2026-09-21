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

function progressed(elements: number, processed: number): PsiProgress {
  return {
    operation: "processClientRequest",
    elements,
    state: "progress",
    processed,
  };
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
    "doubly-encrypting partner's data: 1,204,833 values, 1m 12s elapsed",
  );
  expect(psiStatusText("createServerSetup", 12, 3000)).toBe(
    "encrypting my data: 12 values, 3s elapsed",
  );
});

test("the live line states how far into its set an operation has got", () => {
  expect(
    psiStatusText("processClientRequest", 1_204_000, 72_000, 481_600),
  ).toBe(
    "doubly-encrypting partner's data: 481,600 of 1,204,000 values (40%), " +
      "1m 12s elapsed",
  );
  // The share is rounded down, so a line reads 99% until the whole set is
  // through rather than claiming a finish the operation has not reached.
  expect(psiStatusText("createServerSetup", 1000, 1000, 999)).toBe(
    "encrypting my data: 999 of 1,000 values (99%), 1s elapsed",
  );
});

test("a processed count past the operation's own total holds the line at 100%", () => {
  expect(psiStatusText("createServerSetup", 10, 1000, 12)).toBe(
    "encrypting my data: 12 of 10 values (100%), 1s elapsed",
  );
  expect(psiStatusText("createServerSetup", 0, 1000, 0)).toBe(
    "encrypting my data: 0 of 0 values (100%), 1s elapsed",
  );
});

test("a completion line states the measured rate", () => {
  expect(psiMilestoneText(finished(120_000, 60_000))).toBe(
    "doubly-encrypting partner's data: 120,000 values in 1m 0s " +
      "(2,000 values/s)",
  );
});

test("a completion line drops a rate the figures do not support", () => {
  // An operation slower than one value a second: the rounded rate is nothing,
  // so the line states the count and the time and claims no throughput.
  expect(psiMilestoneText(finished(1, 4000))).toBe(
    "doubly-encrypting partner's data: 1 value in 4s",
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
    "doubly-encrypting partner's data: 120,000 values in 1m 0s " +
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
      "doubly-encrypting partner's data: 120,000 values, 1s elapsed",
      "doubly-encrypting partner's data: 120,000 values, 2s elapsed",
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

test("a processed count reaches the next redraw, not the terminal directly", () => {
  vi.useFakeTimers();
  try {
    const { line, draws } = recordingStatusLine();
    let clock = 0;
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      now: () => clock,
      tickMs: 1000,
    });

    display.report(started(120_000));
    // A count arriving before the first tick draws nothing on its own, so an
    // operation that settles inside the first second still leaves the terminal
    // untouched.
    display.report(progressed(120_000, 24_000));
    expect(draws).toStrictEqual([]);

    clock = 1000;
    vi.advanceTimersByTime(1000);
    display.report(progressed(120_000, 48_000));
    clock = 2000;
    vi.advanceTimersByTime(1000);
    expect(draws).toStrictEqual([
      "doubly-encrypting partner's data: 24,000 of 120,000 values (20%), 1s elapsed",
      "doubly-encrypting partner's data: 48,000 of 120,000 values (40%), 2s elapsed",
    ]);

    // The count belongs to the operation that reported it: the next one opens
    // on its total alone.
    display.report(finished(120_000, 2000));
    display.report(started(500));
    clock = 3000;
    vi.advanceTimersByTime(1000);
    expect(draws.at(-1)).toBe(
      "doubly-encrypting partner's data: 500 values, 1s elapsed",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a processed count with no operation open leaves the display alone", () => {
  vi.useFakeTimers();
  try {
    const { line, draws, clears } = recordingStatusLine();
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      now: () => 0,
      tickMs: 1000,
    });

    display.report(progressed(120_000, 24_000));
    vi.advanceTimersByTime(5000);
    expect(draws).toStrictEqual([]);
    expect(clears.count).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("a mid-operation report logs no completion line", () => {
  expect(psiMilestoneText(progressed(120_000, 24_000))).toBeUndefined();
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

test("a log line during a live operation drops the row and the next tick redraws it", () => {
  vi.useFakeTimers();
  try {
    const { line, draws, clears } = recordingStatusLine();
    let clearBeforeEachLogLine: (() => void) | undefined;
    let removed = false;
    let clock = 0;
    const display = createPsiProgressDisplay({
      milestone: () => {},
      statusLine: line,
      clearBeforeLogLine: (clearLine) => {
        clearBeforeEachLogLine = clearLine;
        return () => {
          removed = true;
        };
      },
      now: () => clock,
      tickMs: 1000,
    });

    display.report(started(120_000));
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(draws).toHaveLength(1);

    // The log line is about to be written: the live row goes first, so the
    // warning lands on a row of its own.
    clearBeforeEachLogLine?.();
    expect(clears.count).toBe(1);

    clock = 2000;
    vi.advanceTimersByTime(1000);
    expect(draws).toStrictEqual([
      "doubly-encrypting partner's data: 120,000 values, 1s elapsed",
      "doubly-encrypting partner's data: 120,000 values, 2s elapsed",
    ]);

    display.close();
    expect(removed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a display with no live line leaves the log lines alone", () => {
  let installed = false;
  const display = createPsiProgressDisplay({
    milestone: () => {},
    clearBeforeLogLine: () => {
      installed = true;
      return () => {};
    },
    now: () => 0,
  });

  display.report(started(5));
  display.close();

  expect(installed).toBe(false);
});

// Which runs get a live line. A pipe, a --log-file, a terminal taking no cursor
// escapes, a quiet run and a verbose one each take the completion lines alone --
// a redraw either lands in a log, prints its escapes, or collides with the debug
// stream.
const originalIsTty = process.stderr.isTTY;
const originalColumns = process.stderr.columns;
const originalTerm = process.env.TERM;
const originalLevel = logLibrary.getLevel();

afterEach(() => {
  process.stderr.isTTY = originalIsTty;
  process.stderr.columns = originalColumns;
  process.env.TERM = originalTerm;
  logLibrary.setDefaultLevel(originalLevel);
});

// A terminal run at the default level with no redirect: the case every gate
// below turns off one at a time.
function defaultTerminalRun(): void {
  process.stderr.isTTY = true;
  process.env.TERM = "xterm-256color";
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
}

test("a non-terminal stderr takes no live line", () => {
  defaultTerminalRun();
  process.stderr.isTTY = false;

  expect(
    terminalPsiStatusLine({ verbosity: 0, logFile: undefined }),
  ).toBeUndefined();
});

test("a run whose diagnostics go to a log file takes no live line", () => {
  defaultTerminalRun();

  expect(
    terminalPsiStatusLine({ verbosity: 0, logFile: "/tmp/run.log" }),
  ).toBeUndefined();
});

test("a dumb terminal takes no live line", () => {
  defaultTerminalRun();
  process.env.TERM = "dumb";

  expect(
    terminalPsiStatusLine({ verbosity: 0, logFile: undefined }),
  ).toBeUndefined();
});

test("a verbose or quiet run takes no live line", () => {
  defaultTerminalRun();
  expect(
    terminalPsiStatusLine({ verbosity: 1, logFile: undefined }),
  ).toBeUndefined();

  logLibrary.setDefaultLevel(logLibrary.levels.WARN);
  expect(
    terminalPsiStatusLine({ verbosity: 0, logFile: undefined }),
  ).toBeUndefined();

  logLibrary.setDefaultLevel(logLibrary.levels.SILENT);
  expect(
    terminalPsiStatusLine({ verbosity: 0, logFile: undefined }),
  ).toBeUndefined();
});

// Capture what a status line writes to stderr, with the stream mocked so no
// escape reaches the test runner's own output.
function statusWrites(use: (line: PsiStatusLine | undefined) => void): {
  written: Array<string>;
} {
  const written: Array<string> = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  try {
    use(terminalPsiStatusLine({ verbosity: 0, logFile: undefined }));
  } finally {
    write.mockRestore();
  }
  return { written };
}

test("a terminal run redraws one line in place", () => {
  defaultTerminalRun();

  const { written } = statusWrites((line) => {
    line?.draw("encrypting my data: 12 values, 3s elapsed");
    line?.clear();
  });

  // Back to the start of the line, then erase what a longer previous draw left
  // past the new text.
  expect(written).toStrictEqual([
    "\rencrypting my data: 12 values, 3s elapsed\x1b[K",
    "\r\x1b[K",
  ]);
});

test("a line longer than the terminal is cut a column short of its width", () => {
  defaultTerminalRun();
  process.stderr.columns = 20;

  const { written } = statusWrites((line) => {
    line?.draw("encrypting my data: 12 values, 3s elapsed");
  });

  // 19 characters: the last column stays free, so the row does not wrap and the
  // next draw's carriage return still reaches the line it replaces.
  expect(written).toStrictEqual(["\rencrypting my data:\x1b[K"]);
});

test("a terminal reporting no width takes the line as composed", () => {
  defaultTerminalRun();
  // Typed through the optional shape rather than assigned `undefined`: a
  // non-terminal stderr holds no `columns` at all, which is the state under
  // test here.
  const stderrWidth: { columns?: number } = process.stderr;
  stderrWidth.columns = undefined;

  const { written } = statusWrites((line) => {
    line?.draw("encrypting my data: 12 values, 3s elapsed");
  });

  expect(written).toStrictEqual([
    "\rencrypting my data: 12 values, 3s elapsed\x1b[K",
  ]);
});

test("a wedged stderr drops the line rather than raising", () => {
  defaultTerminalRun();
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((): never => {
      throw new Error("EPIPE");
    });
  try {
    const line = terminalPsiStatusLine({ verbosity: 0, logFile: undefined });
    expect(() =>
      line?.draw("encrypting my data: 12 values, 3s elapsed"),
    ).not.toThrow();
  } finally {
    write.mockRestore();
  }
});
