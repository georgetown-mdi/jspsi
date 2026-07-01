import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import {
  getDiagnosticSink,
  setDiagnosticSink,
  type DiagnosticSink,
} from "@psilink/core";

import { handler as inviteHandler } from "../../src/commands/invite";
import { handler as initHandler } from "../../src/commands/init";

// Executable form of the contract issue 206965143 establishes: stdout carries
// only a command's result data, and every diagnostic goes to stderr. These tests
// run a command to completion and assert nothing diagnostic reached stdout -- the
// property a prose note could only claim, not enforce (CONTRIBUTING: encode a
// runtime claim as a check). The result reaches stdout by two mechanisms: a
// direct `process.stdout.write` (the CSV writers) or `console.log` (the invitation
// token, the fingerprint summary); diagnostics reach stderr through core's
// diagnostic sink, i.e. `process.stderr.write`. So a run's stdout is captured from
// both `console.log` and `process.stdout.write`, and stderr from
// `process.stderr.write`.
//
// Covered here are the two offline, no-network commands whose stdout shape is
// unambiguous: `invite` (a single opaque token) and `init` (no stdout result --
// its result is the written file). The online CSV-result commands route
// diagnostics through the same sink, pinned at the sink level in
// stderrLogging.test.ts; `fingerprint` joins this matrix once board item 207023432
// routes its banner off stdout (today it prints prose to stdout via console.log,
// outside this change's scope).

const DIAGNOSTIC_PREFIX = /\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/;

let originalSink: DiagnosticSink | undefined;
let originalLevel: number;

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

// Run `fn` with stdout and stderr captured. stdout aggregates both `console.log`
// (which formats and appends a newline, as Node's console does) and any direct
// `process.stdout.write`; stderr captures core's diagnostic-sink writes. process
// output is mocked so nothing leaks into the test runner's own streams, and
// process.exit is stubbed so a handler that exits on its success path does not end
// the worker.
async function runCapturing(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdout.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

test("offline invite: stdout is the invitation token only, diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-invite-"));
  try {
    const input = path.join(dir, "in.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nAda,Lovelace,1815-12-10\n",
    );
    const { stdout, stderr } = await runCapturing(() =>
      inviteHandler({
        _: [],
        $0: "psilink",
        args: [input],
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        "log-level": "info",
        record: false,
      } as unknown as Arguments),
    );

    // stdout is exactly one line -- the opaque token -- with no diagnostic prefix,
    // no whitespace (prose would carry spaces), and none of the guidance the
    // command also emits.
    const stdoutLines = stdout.split("\n").filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    expect(stdout).not.toMatch(DIAGNOSTIC_PREFIX);
    expect(stdout).not.toContain(" ");
    expect(stdout).not.toContain("Share this invitation");
    expect(stdout).not.toContain("wrote");

    // The guidance that surrounds the token is diagnostic, so it is on stderr.
    expect(stderr).toContain("Share this invitation");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init: stdout is empty (its result is the written file), diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-init-"));
  try {
    const configFile = path.join(dir, "psilink.yaml");
    const { stdout, stderr } = await runCapturing(() =>
      initHandler({
        _: [],
        $0: "psilink",
        "config-file": configFile,
      } as unknown as Arguments),
    );

    // init's result is the file it writes, so stdout carries nothing at all.
    expect(stdout).toBe("");
    // The "wrote a configuration template to ..." notice is a diagnostic on stderr.
    expect(fs.existsSync(configFile)).toBe(true);
    expect(stderr).toContain("wrote a configuration template");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
