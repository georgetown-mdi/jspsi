import fs from "node:fs";

import { afterAll, inject } from "vitest";

import { ConsoleSentinel, flushPendingConsole } from "../consoleSentinel";
import {
  INTEGRATION_CONSOLE_ALLOWLIST,
  SENTINEL_GATED_LEVELS,
} from "./consoleAllowlist";

declare module "vitest" {
  interface ProvidedContext {
    // Path to the suite-wide sink this file's afterAll appends matched allowlist
    // ids to, so globalSetup's teardown can report ids that NO file matched
    // (dead entries). Provided by the integration globalSetup.
    consoleSentinelSink: string;
  }
}

// Bound on the settle loop below: how many drain rounds to wait for trailing
// async output before asserting. The common case (no late output) settles in one
// round; the cap keeps a teardown that keeps emitting from stalling afterAll.
const MAX_FLUSH_ROUNDS = 5;

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
  // Settle trailing async output in waves: drain, and if the drain surfaced new
  // lines, drain again, until the recorded count stops growing or the cap is
  // reached. A single fixed drain can miss the ssh2-sftp-client teardown cascade,
  // which lands after the last test on async events.
  let previousCount = -1;
  for (
    let round = 0;
    round < MAX_FLUSH_ROUNDS && sentinel.recordedCount() !== previousCount;
    round++
  ) {
    previousCount = sentinel.recordedCount();
    await flushPendingConsole();
  }
  // Record which allowlist matchers this file exercised to the suite-wide sink
  // first, so globalSetup's teardown can report matchers no file matched. This
  // is advisory and must never mask a real violation, so it runs before -- and
  // cannot throw into -- the assertion: appendFileSync can throw (a full disk, a
  // gone sink dir), and inject returns undefined when no sink was provided (a
  // single-file run outside globalSetup, handled by the `if (sink)` guard).
  try {
    const sink = inject("consoleSentinelSink");
    const matched = sentinel.matchedAllowlistIds();
    if (sink) {
      // One O_APPEND write per id: a short append to a regular file is a single
      // write(2), which Linux serializes under the inode lock (a kernel detail,
      // not a POSIX guarantee -- PIPE_BUF is the pipe/FIFO contract, not this), so
      // concurrent teardowns across fork workers do not interleave bytes within an
      // id. The reader splits on newlines and counts only known ids, so even a
      // torn line is harmless; the per-id writes just make that path unreachable.
      for (const id of matched) {
        fs.appendFileSync(sink, `${id}\n`);
      }
    }
  } catch {
    // The dead-entry report is best-effort; the assertion below is what gates CI.
  }
  try {
    sentinel.assertClean();
  } finally {
    sentinel.restore();
  }
});
