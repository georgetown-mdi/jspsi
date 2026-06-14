import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import { getLogger, UsageError } from "@psilink/core";

import { configureLogFile } from "../../src/util/cli";
import { parseCommonBootstrapArgs } from "../../src/commands/bootstrap";

// configureLogFile mutates loglevel's global methodFactory (the seam every named
// logger captures at creation). These tests snapshot and restore that factory --
// and the level -- around each case, and give every test a uniquely named logger
// so a cached logger from one test never writes into another's closed descriptor.

let tmpDir: string;
let originalFactory: typeof logLibrary.methodFactory;
let originalLevel: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-logfile-"));
  originalFactory = logLibrary.methodFactory;
  originalLevel = logLibrary.getLevel();
});

afterEach(() => {
  logLibrary.methodFactory = originalFactory;
  logLibrary.setLevel(
    originalLevel as Parameters<typeof logLibrary.setLevel>[0],
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

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
