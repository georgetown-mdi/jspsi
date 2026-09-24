import { expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import {
  getDiagnosticSink,
  getLogger,
  setDiagnosticSink,
  type DiagnosticSink,
} from "@alcove/core";

import { runBeforeEachLogLine } from "../../../src/util/logging";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

// What the PSI progress display installs so a log line never lands on the live
// row: a callback ahead of each diagnostic line, over whatever sink the command
// already put in place.

snapshotDiagnosticSinkAndLevel();

let uid = 0;

test("the callback runs immediately before each line the sink writes", () => {
  const events: Array<string> = [];
  const sink: DiagnosticSink = (_methodName, prefix, args) =>
    events.push(`line: ${prefix} ${String(args[0])}`);
  setDiagnosticSink(sink);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const remove = runBeforeEachLogLine(() => events.push("clear"));

  const log = getLogger(`log-line-hook-${uid++}`);
  log.warn("the partner's folder is not writable");
  remove();
  log.warn("and again, with the row released");

  expect(events).toStrictEqual([
    "clear",
    expect.stringContaining("the partner's folder is not writable"),
    expect.stringContaining("and again, with the row released"),
  ]);
});

test("a run with no sink installed keeps core's own routing", () => {
  setDiagnosticSink(undefined);
  const before = vi.fn();

  const remove = runBeforeEachLogLine(before);
  // Nothing installed, so a log line still reaches core's per-level console
  // routing rather than a wrapper that would swallow it.
  expect(getDiagnosticSink()).toBeUndefined();
  remove();

  expect(getDiagnosticSink()).toBeUndefined();
  expect(before).not.toHaveBeenCalled();
});
