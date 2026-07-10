import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import { getDiagnosticSink, UsageError } from "@psilink/core";

import { configureLogging } from "../../src/util/cli";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

// configureLogging is the one logging bootstrap all six command handlers share:
// it picks the file-or-stderr sink, applies the level, and builds the named
// logger, returning that logger plus a single closer. These tests exercise both
// sink branches and the closer's sink-restore directly, so a regression in the
// shared seam surfaces here rather than through six per-command handler tests.
// They snapshot and restore core's process-wide diagnostic sink -- and the level
// -- around each case, and name each logger uniquely so state never bleeds across
// tests.

let tmpDir: string;

snapshotDiagnosticSinkAndLevel();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-configlog-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- file-sink branch (logFile given) ----------------------------------------

test("configureLogging: with a logFile, routes the named logger's output to the file", () => {
  const logPath = path.join(tmpDir, "run.log");
  const { log, close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: logPath,
    name: "configlog-file",
  });
  try {
    log.info("hello from the file branch");
  } finally {
    close();
  }
  // The logger carries the requested name and the file captures its output with
  // the standard [LEVEL] [CONTEXT] prefix -- so the helper installed the file sink
  // and built the logger under it, in that order.
  const contents = fs.readFileSync(logPath, "utf8");
  expect(contents).toMatch(
    /\[INFO\] \[configlog-file\] hello from the file branch/,
  );
});

test("configureLogging: applies the resolved level before building the logger", () => {
  // Level filtering happens before the sink: SILENT installs noop for every
  // method, so nothing reaches the file even though it was opened. This pins that
  // the helper's setDefaultLevel takes effect for the logger it then builds.
  const logPath = path.join(tmpDir, "silent.log");
  const { log, close } = configureLogging({
    logLevel: logLibrary.levels.SILENT,
    logFile: logPath,
    name: "configlog-silent",
  });
  try {
    log.error("should not appear");
    log.info("nor this");
  } finally {
    close();
  }
  expect(fs.readFileSync(logPath, "utf8")).toBe("");
});

// --- stderr-sink branch (logFile undefined) ----------------------------------

test("configureLogging: without a logFile, routes diagnostics to stderr, never stdout", () => {
  // The default sink reserves stdout for result data, so info -- which loglevel
  // would otherwise send to stdout -- must land on stderr and stdout must stay
  // clean.
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const { log, close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: undefined,
    name: "configlog-stderr",
  });
  try {
    log.info("an info diagnostic line");
  } finally {
    close();
    restore();
  }
  expect(stderrWrites.join("")).toContain("an info diagnostic line");
  expect(stderrWrites.join("")).toContain("[INFO]");
  expect(stdoutWrites.join("")).toBe("");
  // No file is opened on the stderr branch.
  expect(fs.readdirSync(tmpDir)).toHaveLength(0);
});

// --- an unopenable --log-file surfaces as a UsageError -----------------------

test("configureLogging: an unopenable logFile throws UsageError and installs no sink", () => {
  // The helper is the single seam all six handlers route through, so its
  // --log-file failure contract is load-bearing: configureLogFile opens the file
  // synchronously and throws a UsageError on a missing parent directory, and
  // configureLogging must let that propagate (not swallow or reshape it) so each
  // handler's parseOrExit/runOrExit maps it to exit 64. The sink open runs before
  // setDefaultLevel/getLogger, so a failed open must also leave the diagnostic
  // sink untouched -- pin both, so a regression that catches the throw, or installs
  // the sink before opening, is caught here rather than silently breaking
  // --log-file for every command at once.
  const before = getDiagnosticSink();
  const logPath = path.join(tmpDir, "does-not-exist", "run.log");
  expect(() =>
    configureLogging({
      logLevel: logLibrary.levels.INFO,
      logFile: logPath,
      name: "configlog-unopenable",
    }),
  ).toThrow(UsageError);
  // The failed open installed nothing: the diagnostic sink is left as it was, and
  // the synchronous open created no directory.
  expect(getDiagnosticSink()).toBe(before);
  expect(fs.existsSync(path.join(tmpDir, "does-not-exist"))).toBe(false);
});

// --- the closer's factory-restore --------------------------------------------

test("configureLogging: close() restores the diagnostic sink in place before it (file sink)", () => {
  const before = getDiagnosticSink();
  const { close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: path.join(tmpDir, "restore.log"),
    name: "configlog-restore-file",
  });
  expect(getDiagnosticSink()).not.toBe(before);
  close();
  expect(getDiagnosticSink()).toBe(before);
});

test("configureLogging: close() restores the diagnostic sink in place before it (stderr sink)", () => {
  const before = getDiagnosticSink();
  const { close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: undefined,
    name: "configlog-restore-stderr",
  });
  expect(getDiagnosticSink()).not.toBe(before);
  close();
  expect(getDiagnosticSink()).toBe(before);
});
