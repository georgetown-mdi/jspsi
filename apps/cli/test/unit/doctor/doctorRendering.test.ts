import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";

import { mountHandler } from "../../../src/commands/doctor";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";

// The human check lines are a rendering an operator reads, not log records: a
// Windows setup script re-prints them in an 80-column console, where the
// CLI's ~50-column `[ISO] [LEVEL] [CONTEXT]` prefix would wrap every line.
// These tests run the mount checks to completion and assert what reaches
// each destination, keeping `--log-file`, `--log-level`, the `--json`
// verdict, and the prefix on other diagnostics intact.

const LOG_PREFIX = /\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/;
const ISO_TIMESTAMP = /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/;

snapshotDiagnosticSinkAndLevel();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-doctor-render-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["SMB_MARKER"];
  delete process.env["SMB_TOKEN"];
});

// Run `doctor mount` against a directory of its own, with stdout and stderr
// captured and process.exit stubbed so a handler that exits on its error path
// does not end the worker. The verdict's exit code lands on process.exitCode, so
// it is saved and restored around the run.
async function runMount(
  options: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string }> {
  const directory = fs.mkdtempSync(path.join(tmpDir, "mount-"));
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const previousExitCode = process.exitCode;
  try {
    await mountHandler(
      argv({ directory, json: false, "log-level": "info", ...options }),
    );
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
    restore();
    exitSpy.mockRestore();
  }
  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

test("the check lines reach stderr with no timestamp, level, or context prefix", async () => {
  const { stdout, stderr } = await runMount();

  // The rendering is there whole -- a labelled check line and the closing
  // summary -- so this fails on a dropped rendering as well as a prefixed one.
  expect(stderr).toContain("OK: ");
  expect(stderr).toContain("ALL CHECKS PASSED");
  // Every line of it, not just the first: a per-line assertion catches a prefix
  // reintroduced on the continuation of a MEANING/ACTION block too.
  for (const line of nonEmptyLines(stderr)) {
    expect(line).not.toMatch(LOG_PREFIX);
    expect(line).not.toMatch(ISO_TIMESTAMP);
  }
  // Still stderr, not stdout: dropping the prefix must not move the rendering
  // onto the stream a --json capture owns.
  expect(stdout).toBe("");
});

test("--log-file captures the check lines, and captures them prefix-free too", async () => {
  const logPath = path.join(tmpDir, "doctor.log");
  const { stdout, stderr } = await runMount({ "log-file": logPath });

  const captured = fs.readFileSync(logPath, "utf8");
  expect(captured).toContain("OK: ");
  expect(captured).toContain("ALL CHECKS PASSED");
  for (const line of nonEmptyLines(captured)) {
    expect(line).not.toMatch(LOG_PREFIX);
    expect(line).not.toMatch(ISO_TIMESTAMP);
  }
  // The file supersedes the terminal for the rendering exactly as it does for a
  // log line: the redirect is the sink both are written through.
  expect(stderr).toBe("");
  expect(stdout).toBe("");
});

test("a level that does not admit info still silences the check lines", async () => {
  // Dropping the prefix must not exempt the rendering from --log-level. The
  // level is set directly on the logger, not just via the flag, because
  // loglevel caches a logger by name for the process's life and
  // setDefaultLevel does not reach one that already exists -- so in a
  // process where doctor has already run, the flag alone would not lower it.
  const doctorLogger = logLibrary.getLogger("doctor-mount");
  const previousLevel = doctorLogger.getLevel();
  doctorLogger.setLevel(logLibrary.levels.SILENT);
  try {
    const { stdout, stderr } = await runMount({ "log-level": "silent" });
    expect(stderr).toBe("");
    expect(stdout).toBe("");
  } finally {
    doctorLogger.setLevel(previousLevel);
  }
});

test("--json is untouched: one verdict line on stdout, no check lines anywhere", async () => {
  const { stdout, stderr } = await runMount({ json: true });

  const lines = nonEmptyLines(stdout);
  expect(lines).toHaveLength(1);
  const verdict = JSON.parse(lines[0]) as { mode: string; overall: string };
  expect(verdict.mode).toBe("mount");
  expect(verdict.overall).toBe("ok");
  // The verdict replaces the human rendering rather than accompanying it, so the
  // plain writer must not fire on this path.
  expect(stderr).toBe("");
});

test("a key marker in the operator's own mount path costs that line its predicate", async () => {
  // The rendering escapes and redacts per rendered LINE, and a summary composes
  // an operator-supplied value ahead of its own predicate, so the fail-closed
  // rule takes the predicate with the value. These bytes are the operator's own
  // and no partner reaches them, so the cost stands and is pinned here rather
  // than closed; CHANNEL_SECURITY.md records it as the second pass's price.
  const marked = path.join(tmpDir, "-----BEGIN RSA PRIVATE KEY-----");
  fs.mkdirSync(marked);
  const { stderr } = await runMount({ directory: marked });

  expect(stderr).toContain("[redacted private key]");
  expect(stderr).not.toContain("BEGIN RSA PRIVATE KEY");
  const redactedLine = nonEmptyLines(stderr).find((line) =>
    line.includes("[redacted private key]"),
  );
  expect(redactedLine).toBeDefined();
  expect(redactedLine).not.toContain("is readable");
});

test("a diagnostic that is not the check rendering keeps its prefix", async () => {
  // A marker that is not a plain identifier is a usage error, reported through
  // the logger before any check runs -- a log record, so it has the prefix
  // that identifies which run and which command wrote it.
  process.env["SMB_MARKER"] = "not a marker!";
  const { stderr } = await runMount();

  expect(stderr).toMatch(LOG_PREFIX);
  expect(stderr).toMatch(ISO_TIMESTAMP);
  expect(stderr).toContain("SMB_MARKER");
  expect(stderr).not.toContain("OK: ");
});
