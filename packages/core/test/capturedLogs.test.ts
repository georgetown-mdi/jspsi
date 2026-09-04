import logLibrary from "loglevel";
import { afterEach, expect, test } from "vitest";

import { withCapturedLogs } from "../src/testing";
import { getLoggerForVerbosity } from "../src/utils/logger";

// The limitation withCapturedLogs documents, driven rather than asserted in
// prose: loglevel binds `noop` for a method below the logger's level, so the
// capture factory never sees the call at all. A getLoggerForVerbosity logger
// floors at the root level, so -v alone cannot reach `.debug()` -- the root has
// to be raised BEFORE the logger is constructed.

const originalLevel = logLibrary.getLevel();

afterEach(() => {
  logLibrary.setLevel(
    originalLevel as Parameters<typeof logLibrary.setLevel>[0],
  );
});

// A fresh name per case: loglevel's registry is process-wide, so a reused name
// would leak one case's level into the next.
let nextLoggerId = 0;
const uniqueName = (prefix: string) => `${prefix}-${nextLoggerId++}`;

const capturedDebugLines = (name: string, verbosity: number): string[] => {
  const [, logs] = withCapturedLogs(
    () => getLoggerForVerbosity(name, verbosity).debug("sentinel line"),
    (level) => level === "DEBUG",
  );
  return logs.map((entry) => entry.message);
};

test("a .debug() line at verbose 1 is uncapturable until the root is raised first", () => {
  logLibrary.setLevel("warn");
  expect(capturedDebugLines(uniqueName("floored"), 1)).toEqual([]);

  logLibrary.setLevel("trace");
  const raised = capturedDebugLines(uniqueName("raised"), 1);
  expect(raised).toHaveLength(1);
  // The captured line holds the prefixer's timestamp/level/name framing.
  expect(raised[0]).toContain("sentinel line");
});
