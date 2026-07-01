import { afterEach, beforeEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import {
  getDiagnosticSink,
  getLogger,
  setDiagnosticSink,
  type DiagnosticSink,
} from "@psilink/core";

import { configureStderrLogging } from "../../src/util/cli";

// configureStderrLogging installs core's process-wide diagnostic sink, which core
// resolves at each log call (not when a logger is built). These tests snapshot and
// restore that sink -- and the level -- around each case, and give every test a
// uniquely named logger so state from one test never bleeds into another.

let originalSink: DiagnosticSink | undefined;
let originalLevel: number;
let uid = 0;

beforeEach(() => {
  originalSink = getDiagnosticSink();
  originalLevel = logLibrary.getLevel();
});

afterEach(() => {
  setDiagnosticSink(originalSink);
  logLibrary.setLevel(
    originalLevel as Parameters<typeof logLibrary.setLevel>[0],
  );
});

// Install the stderr sink, then log `message` at `level` through a fresh logger.
// Returns what landed on each stream: mocked so the assertions read the captured
// writes and no line leaks into the test runner's own output.
function logAt(
  level: "trace" | "debug" | "info" | "warn" | "error",
  message: string,
): { stdout: string; stderr: string } {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const sink = configureStderrLogging();
  // TRACE enables every method, so the level under test always reaches the sink
  // rather than loglevel's pre-factory noop.
  logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
  try {
    const log = getLogger(`stderr-routing-${level}-${uid++}`);
    log[level](message);
  } finally {
    sink.close();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

// --- info/debug (formerly stdout) now land on stderr, not stdout -------------

test("configureStderrLogging: info diagnostics go to stderr, never stdout", () => {
  // info is the level the interleaving bug hinged on: loglevel's default routes
  // it to console.info (stdout), where it would corrupt a piped result CSV.
  const { stdout, stderr } = logAt("info", "an info diagnostic line");
  expect(stderr).toContain("an info diagnostic line");
  expect(stderr).toContain("[INFO]");
  expect(stdout).toBe("");
});

test("configureStderrLogging: debug diagnostics go to stderr, never stdout", () => {
  // debug likewise defaults to console.log (stdout); route it to stderr too.
  const { stdout, stderr } = logAt("debug", "a debug diagnostic line");
  expect(stderr).toContain("a debug diagnostic line");
  expect(stderr).toContain("[DEBUG]");
  expect(stdout).toBe("");
});

test("configureStderrLogging: trace diagnostics go to stderr, never stdout", () => {
  const { stdout, stderr } = logAt("trace", "a trace diagnostic line");
  expect(stderr).toContain("a trace diagnostic line");
  expect(stderr).toContain("[TRACE]");
  expect(stdout).toBe("");
});

// --- warn/error stay on stderr (no regression to their current routing) ------

test("configureStderrLogging: warn output stays on stderr", () => {
  const { stdout, stderr } = logAt("warn", "a warning line");
  expect(stderr).toContain("a warning line");
  expect(stderr).toContain("[WARN]");
  expect(stdout).toBe("");
});

test("configureStderrLogging: error output stays on stderr", () => {
  const { stdout, stderr } = logAt("error", "an error line");
  expect(stderr).toContain("an error line");
  expect(stderr).toContain("[ERROR]");
  expect(stdout).toBe("");
});

// --- lifecycle: the standard prefix is preserved, close() restores the seam --

test("configureStderrLogging: keeps the [ISO] [LEVEL] [CONTEXT] prefix", () => {
  // setLogPrefixer wraps the sink leaf, so each line keeps its timestamped
  // prefix on stderr exactly as it would on the console.
  const { stderr } = logAt("info", "prefixed message");
  expect(stderr).toMatch(
    /\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[INFO\] \[stderr-routing-info-\d+\] prefixed message/,
  );
});

test("configureStderrLogging: close() restores the diagnostic sink in place before it", () => {
  const before = getDiagnosticSink();
  const sink = configureStderrLogging();
  expect(getDiagnosticSink()).not.toBe(before);
  sink.close();
  expect(getDiagnosticSink()).toBe(before);
});

test("configureStderrLogging: reroutes a logger created BEFORE the sink was installed", () => {
  // The payoff of resolving the sink per log call: a logger built before the sink
  // exists -- as core's and the CLI's import-time loggers (cleaning, file-utils)
  // are -- still routes to stderr once the sink is installed. A creation-time
  // methodFactory swap could not reach a logger that already existed.
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  // Create the logger FIRST, with no diagnostic sink installed yet.
  const log = getLogger(`stderr-routing-precreated-${uid++}`);
  const sink = configureStderrLogging();
  try {
    log.info("late-routed diagnostic line");
  } finally {
    sink.close();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  expect(stderrWrites.join("")).toContain("late-routed diagnostic line");
  expect(stdoutWrites.join("")).toBe("");
});
