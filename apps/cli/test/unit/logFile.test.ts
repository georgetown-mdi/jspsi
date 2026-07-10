import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import { getDiagnosticSink, getLogger, UsageError } from "@psilink/core";

import { configureLogFile } from "../../src/util/cli";
import { parseCommonBootstrapArgs } from "../../src/optionDefinitions";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

// configureLogFile installs core's process-wide diagnostic sink (the seam every
// prefixed logger consults at emit time). These tests snapshot and restore that
// sink -- and the level -- around each case, and give every test a uniquely named
// logger so state from one test never bleeds into another.

let tmpDir: string;

snapshotDiagnosticSinkAndLevel();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-logfile-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- (a) log lines appear in the file when --log-file is set -----------------

test("configureLogFile: redirects loglevel output to the file with the standard prefix", () => {
  // Writes are synchronous, so the lines are on disk by the time logging returns
  // -- no flush wait, and process.exit could not truncate them.
  const logPath = path.join(tmpDir, "run.log");
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const log = getLogger("logfile-test-a");

  log.info("hello from the file sink");
  log.warn("a warning too");
  sink.close();

  const contents = fs.readFileSync(logPath, "utf8");
  expect(contents).toContain("hello from the file sink");
  expect(contents).toContain("a warning too");
  // setLogPrefixer's [ISO] [LEVEL] [CONTEXT] prefix is preserved through the
  // file sink: the prefixer passes it as the first argument and util.format
  // renders it ahead of the message exactly as console.log would.
  expect(contents).toMatch(
    /\[INFO\] \[logfile-test-a\] hello from the file sink/,
  );
  expect(contents).toMatch(/\[WARN\] \[logfile-test-a\] a warning too/);
});

test("configureLogFile: opens in append mode, preserving existing content", () => {
  const logPath = path.join(tmpDir, "existing.log");
  fs.writeFileSync(logPath, "PRE-EXISTING LINE\n");

  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  getLogger("logfile-test-append").info("appended line");
  sink.close();

  const contents = fs.readFileSync(logPath, "utf8");
  expect(contents).toContain("PRE-EXISTING LINE");
  expect(contents).toContain("appended line");
  expect(contents.indexOf("PRE-EXISTING LINE")).toBeLessThan(
    contents.indexOf("appended line"),
  );
});

test("configureLogFile: a newly created log file is owner-only (no group/world access)", () => {
  // The log can hold partner identity, linkage keys, and data categories, so it
  // is created owner-only rather than inheriting a world-readable umask default.
  // Assert the disclosure-relevant invariant (no group/world bits) rather than an
  // exact mode, since a restrictive umask may tighten 0o600 further but never
  // widen it. POSIX permissions only.
  if (process.platform === "win32") return;
  const logPath = path.join(tmpDir, "perms.log");
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  getLogger("logfile-test-perms").info("line");
  sink.close();

  expect(fs.statSync(logPath).mode & 0o077).toBe(0);
});

test("configureLogFile: --log-level silent writes nothing to the file", () => {
  // Level filtering happens before the factory: loglevel installs noop for every
  // method under SILENT, so the sink is never called even though the file exists.
  const logPath = path.join(tmpDir, "silent.log");
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.SILENT);
  const log = getLogger("logfile-test-silent");

  log.error("should not appear");
  log.info("nor this");
  sink.close();

  expect(fs.readFileSync(logPath, "utf8")).toBe("");
});

test("configureLogFile: a long message is written whole, not truncated by a short write", () => {
  // writeAll loops over a partial fs.writeSync, so a large serialized argument
  // lands in full rather than being clipped to the first kernel write.
  const logPath = path.join(tmpDir, "long.log");
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const payload = "x".repeat(200_000);
  getLogger("logfile-test-long").info(payload);
  sink.close();

  expect(fs.readFileSync(logPath, "utf8")).toContain(payload);
});

test("configureLogFile: a Windows-style backslash path is normalized before opening", () => {
  // Backslashes are folded to forward slashes on ingestion (the Windows-path
  // convention), so a path written with backslashes opens its forward-slash form.
  const sub = path.join(tmpDir, "sub");
  fs.mkdirSync(sub);
  const target = path.join(sub, "win.log");
  const backslashed = target.replace(/\//g, "\\");

  const sink = configureLogFile(backslashed);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  getLogger("logfile-test-win").info("windows path line");
  sink.close();

  expect(fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toContain("windows path line");
});

test("configureLogFile: close() restores the diagnostic sink in place before it", () => {
  // The install/restore is bracketed, so core's diagnostic sink is left as it was
  // found and a log emitted after close() routes to the restored sink, not the fd.
  const before = getDiagnosticSink();
  const sink = configureLogFile(path.join(tmpDir, "restore.log"));
  expect(getDiagnosticSink()).not.toBe(before);
  sink.close();
  expect(getDiagnosticSink()).toBe(before);
});

test("configureLogFile: close() is idempotent", () => {
  // A redundant restore is a no-op and the second fs.closeSync throws EBADF,
  // which close() swallows, so a double close must not throw.
  const sink = configureLogFile(path.join(tmpDir, "idem.log"));
  sink.close();
  expect(() => sink.close()).not.toThrow();
});

test("configureLogFile: after close(), logging detaches from the file and does not throw", () => {
  // close() restores the prior sink and then closes the fd. Because core resolves
  // the diagnostic sink per log call, a log emitted after close() routes to the
  // restored sink (the default console routing here), never to the closed
  // descriptor -- so it neither throws nor appends to the file. This is the
  // guarantee that replaces the old creation-time hazard, where a logger bound to
  // the fd could write into it after close().
  const logPath = path.join(tmpDir, "closed.log");
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const log = getLogger("logfile-test-closed");
  log.info("before close");
  sink.close();

  const afterCloseContents = fs.readFileSync(logPath, "utf8");
  expect(afterCloseContents).toContain("before close");
  expect(() => log.info("after close")).not.toThrow();
  // The file did not grow: the post-close log went to the restored sink, not the fd.
  expect(fs.readFileSync(logPath, "utf8")).toBe(afterCloseContents);
});

test("configureLogFile: diagnostics go to the file, never stdout", () => {
  // The file sink is a distinct branch from the stderr sink, so pin its stdout
  // purity directly: a regression that wrote the file sink's line to stdout would
  // corrupt a piped result exactly as the original interleaving bug did, yet every
  // other test here only reads the file. Spy stdout, log every level to the file,
  // and assert stdout stays clean while the file captures the lines.
  const logPath = path.join(tmpDir, "purity.log");
  const { stdoutWrites, restore } = captureStdio();
  const sink = configureLogFile(logPath);
  logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
  try {
    const log = getLogger("logfile-test-purity");
    log.trace("trace to file");
    log.info("info to file");
    log.debug("debug to file");
    log.warn("warn to file");
    log.error("error to file");
  } finally {
    sink.close();
    restore();
  }
  const stdout = stdoutWrites.join("");
  expect(stdout).not.toMatch(/\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/);
  expect(stdout).not.toContain("to file");
  const contents = fs.readFileSync(logPath, "utf8");
  for (const level of ["TRACE", "INFO", "DEBUG", "WARN", "ERROR"])
    expect(contents).toContain(`[${level}]`);
});

test("configureLogFile: reroutes a logger created BEFORE the sink was installed", () => {
  // The call-time property the stderr sink's twin test pins, here for the file
  // sink: a logger built before configureLogFile runs -- as core's and the CLI's
  // import-time loggers (cleaning, file-utils) are -- still writes to the file once
  // the sink is installed, so --log-file captures them.
  const logPath = path.join(tmpDir, "precreated.log");
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const log = getLogger("logfile-test-precreated"); // created before the sink
  const sink = configureLogFile(logPath);
  try {
    log.info("late-routed to file");
  } finally {
    sink.close();
  }
  expect(fs.readFileSync(logPath, "utf8")).toContain("late-routed to file");
});

// --- (b) no file is created when the option is omitted -----------------------

test("parseCommonBootstrapArgs: logFile is undefined when --log-file is omitted", () => {
  expect(parseCommonBootstrapArgs(argv({})).logFile).toBeUndefined();
});

test("an omitted --log-file opens no sink and creates no file", () => {
  // Mirrors the handlers' guard: configureLogFile runs only when logFile is set.
  const { logFile } = parseCommonBootstrapArgs(argv({}));
  const sink = logFile !== undefined ? configureLogFile(logFile) : undefined;
  expect(sink).toBeUndefined();
  expect(fs.readdirSync(tmpDir)).toHaveLength(0);
});

// --- (c) a non-existent parent directory produces a clean error --------------

test("configureLogFile: a missing parent directory is a clean usage error", () => {
  const logPath = path.join(tmpDir, "does-not-exist", "run.log");
  expect(() => configureLogFile(logPath)).toThrow(UsageError);
  expect(() => configureLogFile(logPath)).toThrow(/could not open log file/);
  // The open failed synchronously, so nothing was created.
  expect(fs.existsSync(path.join(tmpDir, "does-not-exist"))).toBe(false);
});

// --- repeated flag rejection (the singleValue convention) --------------------

test("parseCommonBootstrapArgs: a repeated --log-file is a usage error naming the flag", () => {
  expect(() =>
    parseCommonBootstrapArgs(argv({ "log-file": ["a.log", "b.log"] })),
  ).toThrow("--log-file may be given only once");
});
