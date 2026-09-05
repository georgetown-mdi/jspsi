import { afterEach, beforeEach, vi } from "vitest";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import {
  getDiagnosticSink,
  setDiagnosticSink,
  type DiagnosticSink,
} from "@psilink/core";

/**
 * Register beforeEach/afterEach hooks that snapshot core's diagnostic sink
 * and every logger's level, then restore them after each test. The snapshot
 * covers the whole loglevel registry, not just the root level, because
 * `configureLogging` sets each already-existing logger directly
 * (`setLogLevel`), so restoring only the root would leave a `silent` case's
 * level on named loggers for the rest of the file.
 * @internal test-only
 */
export function snapshotDiagnosticSinkAndLevel(): void {
  let originalSink: DiagnosticSink | undefined;
  let originalLevel: number;
  let originalLoggerLevels: Array<[string | symbol, number]>;

  beforeEach(() => {
    originalSink = getDiagnosticSink();
    originalLevel = logLibrary.getLevel();
    // Reflect.ownKeys, matching core's sweep: a symbol-named logger is invisible
    // to string enumeration, so its level would never be restored.
    const registry = logLibrary.getLoggers() as Record<
      string | symbol,
      logLibrary.Logger
    >;
    originalLoggerLevels = Reflect.ownKeys(registry).map((name) => [
      name,
      registry[name].getLevel(),
    ]);
  });

  afterEach(() => {
    setDiagnosticSink(originalSink);
    logLibrary.setLevel(
      originalLevel as Parameters<typeof logLibrary.setLevel>[0],
    );
    for (const [name, level] of originalLoggerLevels)
      logLibrary
        .getLogger(name)
        .setLevel(level as Parameters<typeof logLibrary.setLevel>[0], false);
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
