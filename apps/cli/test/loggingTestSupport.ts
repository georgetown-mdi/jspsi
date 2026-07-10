import { afterEach, beforeEach, vi } from "vitest";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import {
  getDiagnosticSink,
  setDiagnosticSink,
  type DiagnosticSink,
} from "@psilink/core";

/**
 * Register beforeEach/afterEach hooks that snapshot core's process-wide
 * diagnostic sink and loglevel's level before each test and restore both after,
 * so a test that installs a sink or changes the level never bleeds into the next.
 * @internal test-only
 */
export function snapshotDiagnosticSinkAndLevel(): void {
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
}

/**
 * Spy on `process.stdout.write` and `process.stderr.write`, collecting every
 * chunk written to each into an array so nothing leaks into the test runner's own
 * streams. `restore()` removes both spies. Mirrors what a real run writes to each
 * descriptor, letting a test assert stdout purity against stderr diagnostics.
 * @internal test-only
 */
export function captureStdio(): {
  stdoutWrites: string[];
  stderrWrites: string[];
  restore: () => void;
} {
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
  return {
    stdoutWrites,
    stderrWrites,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

/**
 * Build a minimal parsed-args object (yargs `Arguments`) with only the fields a
 * handler reads, spreading `extra` over the required `_`/`$0` scaffolding.
 * @internal test-only
 */
export function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}
