import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import { getDiagnosticSink, UsageError } from "@psilink/core";

import { configureLogging } from "../../src/util/logging";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

// configureLogging is the shared logging setup for all six command handlers:
// it picks the file-or-stderr sink, applies the level, and builds the named
// logger, returning it with a single closer. These tests snapshot and restore
// core's process-wide diagnostic sink and level around each case, and give
// each logger a unique name so state does not bleed across tests.

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
  // The logger has the requested name and the file captures its output with
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

test("configureLogging: writePlainLine reaches the log file with no prefix", () => {
  // A command's operator-facing rendering goes to the destination the logger
  // writes to -- so --log-file captures it -- but as a line of its own rather
  // than a log record: no timestamp, level, or context ahead of it, and one
  // newline after it.
  const logPath = path.join(tmpDir, "plain.log");
  const { log, writePlainLine, close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: logPath,
    name: "configlog-plain-file",
  });
  try {
    writePlainLine("OK: the share opened.");
    log.info("a diagnostic beside it");
  } finally {
    close();
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n");
  expect(lines[0]).toBe("OK: the share opened.");
  // The prefixed line beside it is untouched, so the two are distinguishable in
  // one capture rather than the sink having dropped the prefix wholesale.
  expect(lines[1]).toMatch(/\[INFO\] \[configlog-plain-file\] a diagnostic/);
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

test("configureLogging: writePlainLine reaches stderr, never stdout, with no prefix", () => {
  // Without a log file the plain writer follows the diagnostics to stderr, so
  // stdout stays reserved for result data -- the --json verdict a doctor run
  // pipes -- and a rendering an operator reads is not spliced into it.
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const { writePlainLine, close } = configureLogging({
    logLevel: logLibrary.levels.INFO,
    logFile: undefined,
    name: "configlog-plain-stderr",
  });
  try {
    writePlainLine("ALL CHECKS PASSED");
  } finally {
    close();
    restore();
  }
  expect(stderrWrites.join("")).toBe("ALL CHECKS PASSED\n");
  expect(stdoutWrites.join("")).toBe("");
});

// --- an unopenable --log-file shows up as a UsageError -----------------------

test("configureLogging: an unopenable logFile throws UsageError and installs no sink", () => {
  // configureLogFile opens the file synchronously and throws UsageError on a
  // missing parent directory; configureLogging must propagate that (not
  // swallow or reshape it) so each handler's parseOrExit/runOrExit maps it to
  // exit 64. The sink open runs before setDefaultLevel/getLogger, so a failed
  // open must also leave the diagnostic sink untouched.
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
