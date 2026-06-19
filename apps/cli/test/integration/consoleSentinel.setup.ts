import fs from "node:fs";

import { afterAll, inject } from "vitest";

import { ConsoleSentinel, flushPendingConsole } from "../consoleSentinel";
import {
  INTEGRATION_CONSOLE_ALLOWLIST,
  SENTINEL_GATED_LEVELS,
} from "./consoleAllowlist";

// A `setupFiles` entry, so this runs once in EACH integration file's worker
// (the integration project uses the `forks` pool: one process per file). The
// sentinel is installed at module load -- before any test or top-level import
// side effect -- so it observes the file's console from the first line.
const sentinel = new ConsoleSentinel(INTEGRATION_CONSOLE_ALLOWLIST, {
  gatedLevels: SENTINEL_GATED_LEVELS,
});
sentinel.install();

// File-level scope (not per-test): the ssh2-sftp-client "Global ... listener"
// teardown lines fire asynchronously and land in the NEXT test's window, so a
// per-test assertion would misattribute them. The `forks` pool already isolates
// files cross-process, so file scope is sufficient.
afterAll(async () => {
  await flushPendingConsole();
  // Record which allowlist matchers this file exercised to the suite-wide sink
  // first, so globalSetup's teardown can report matchers no file matched. This
  // is advisory and must never mask a real violation, so it runs before -- and
  // cannot throw into -- the assertion.
  try {
    const sink = inject("consoleSentinelSink");
    const matched = sentinel.matchedAllowlistIds();
    if (sink && matched.length > 0) {
      fs.appendFileSync(sink, matched.map((id) => `${id}\n`).join(""));
    }
  } catch {
    // No sink (e.g. running this file outside the integration globalSetup): the
    // dead-entry report is best-effort; the assertion below is what gates CI.
  }
  try {
    sentinel.assertClean();
  } finally {
    sentinel.restore();
  }
});
