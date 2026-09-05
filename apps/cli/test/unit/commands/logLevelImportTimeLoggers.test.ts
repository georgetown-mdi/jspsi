import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Arguments } from "yargs";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import { generateSigningIdentity, setDiagnosticSink } from "@psilink/core";

import { handler } from "../../../src/commands/fingerprint";
import { saveSigningIdentity } from "../../../src/signingIdentityFile";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";

// --log-level must govern loggers that already exist when a command parses its
// flags, not only ones it builds afterwards. `file-utils` (CLI) and `cleaning`
// (core) are constructed at import time and between them hold the
// file-handling and data-cleaning warnings an operator silences or turns up.
// These cases drive the real `fingerprint` command rather than a freshly built
// logger, since only the pre-existing one proves the level reaches it.

let dir: string;
let identityPath: string;

snapshotDiagnosticSinkAndLevel();

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-loglevel-"));
  identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(
    identityPath,
    await generateSigningIdentity("Party A, Agency"),
  );
  // The writer creates it owner-only; loosen it so the command's load emits the
  // over-permissive warning through the import-time logger.
  fs.chmodSync(identityPath, 0o644);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Windows resolves permissions through ACLs, which the POSIX chmod above does not
// touch, so the warning these cases drive is a POSIX one.
const posixTest = process.platform === "win32" ? test.skip : test;

/** The bare fingerprint value the command prints on stdout: base64url, no prefix. */
const FINGERPRINT_LINE = /^[A-Za-z0-9_-]+$/;

async function runFingerprint(
  extra: Record<string, unknown>,
): Promise<{ result: string; stderr: string }> {
  const argv = {
    _: [],
    $0: "psilink",
    "identity-file": identityPath,
    force: false,
    ...extra,
  } as unknown as Arguments;
  const { stderrWrites, restore } = captureStdio();
  // The command prints its one result line through console.log, which the test
  // runner intercepts before it reaches process.stdout, so it is collected here
  // rather than from the stdout capture.
  const printed: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    printed.push(line);
  });
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient psilink.yaml is consulted
    await handler(argv);
  } finally {
    process.chdir(cwd);
    logSpy.mockRestore();
    restore();
  }
  return { result: printed.join("\n"), stderr: stderrWrites.join("") };
}

/** Emit `emit` through core's diagnostic sink and return what the sink received. */
function captureThroughSink(emit: () => void): string {
  const lines: string[] = [];
  setDiagnosticSink((_methodName, prefix, args) =>
    lines.push([prefix, ...args].join(" ")),
  );
  try {
    emit();
  } finally {
    setDiagnosticSink(undefined);
  }
  return lines.join("\n");
}

// The import-time logger is in loglevel's registry before any command runs, at
// loglevel's own default level -- the state that made --log-level miss it. The
// cases below act on that pre-existing logger, not one built under the flag.
test("the file-utils logger exists before any command runs, at loglevel's default", () => {
  expect(Object.keys(logLibrary.getLoggers())).toContain("file-utils");
  expect(logLibrary.getLogger("file-utils").getLevel()).toBe(
    logLibrary.levels.WARN,
  );
});

posixTest(
  "a default run shows the import-time logger's warning on stderr",
  async () => {
    // The baseline: without --log-level, the warning reaches the operator, so
    // the silenced cases below have something to contrast against.
    const { result, stderr } = await runFingerprint({});
    expect(stderr).toContain("[WARN] [file-utils]");
    expect(stderr).toContain("restrict to 0600");
    expect(result.trim()).toMatch(FINGERPRINT_LINE);
  },
);

posixTest("--log-level silent suppresses it on the stderr sink", async () => {
  const { result, stderr } = await runFingerprint({ "log-level": "silent" });
  expect(stderr).toBe("");
  // The fingerprint value is the command's result, not log output, so silencing
  // the diagnostics leaves it on stdout.
  expect(result.trim()).toMatch(FINGERPRINT_LINE);
  // The level reached the logger itself, so a later line from it is dropped too,
  // not merely absent from this run's output.
  expect(
    captureThroughSink(() =>
      logLibrary.getLogger("file-utils").warn("after the silenced run"),
    ),
  ).toBe("");
});

posixTest("--log-level silent writes nothing to the --log-file", async () => {
  const logPath = path.join(dir, "run.log");
  await runFingerprint({ "log-level": "silent", "log-file": logPath });
  expect(fs.readFileSync(logPath, "utf8")).toBe("");
});

posixTest(
  "--log-file captures the warning at a level that keeps it",
  async () => {
    const logPath = path.join(dir, "run.log");
    await runFingerprint({ "log-level": "warn", "log-file": logPath });
    expect(fs.readFileSync(logPath, "utf8")).toContain("[WARN] [file-utils]");
  },
);

// The debug/trace half. Neither import-time module logs below warn today, so the
// detail is demonstrated on the logger the run left behind: the registry lookup
// returns the instance the module holds (materialized on its import), not a fresh
// one, and its debug method is live rather than the noop a warn-level logger
// installs.
for (const [level, expected] of [
  ["debug", logLibrary.levels.DEBUG],
  ["trace", logLibrary.levels.TRACE],
] as const) {
  posixTest(
    `--log-level ${level} enables the import-time logger's detail`,
    async () => {
      const { stderr } = await runFingerprint({ "log-level": level });
      expect(stderr).toContain("[WARN] [file-utils]");

      const importTimeLogger = logLibrary.getLogger("file-utils");
      expect(importTimeLogger.getLevel()).toBe(expected);
      expect(
        captureThroughSink(() => importTimeLogger.debug("detail line")),
      ).toContain("[DEBUG] [file-utils] detail line");
    },
  );
}
