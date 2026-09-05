import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stopChild } from "./stopChild";

/**
 * Runs `psilink` as a child process -- the command line an operator types, from
 * its own argv to its own exit code -- rather than calling the exported handler
 * directly: only a real process exposes `process.exit`'s exit code, the
 * `accept` confirmation prompt on stdin, and startup environment such as the
 * loopback TLS certificate (`NODE_EXTRA_CA_CERTS`).
 *
 * Runs through `tsx`, resolved via the module resolver rather than a guessed
 * `node_modules/.bin` path, because this suite runs from `src/` and Node's
 * strip-only TypeScript support rejects syntax the CLI's dependencies use.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../src/index.ts");

/** How a run ended, with everything it wrote. */
export interface FinishedCli {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The run outlived its deadline and was killed rather than exiting. */
  timedOut: boolean;
}

/** A running invocation. */
export interface RunningCli {
  /** Resolves once the process has exited, or been killed on its deadline. */
  finished: Promise<FinishedCli>;
  /**
   * Resolve with the first complete line the run writes to stdout. Rejects if
   * the run exits or the wait elapses first, either of which is reported with
   * what the run had written by then rather than as a bare timeout.
   */
  firstStdoutLine: (timeoutMs: number) => Promise<string>;
  /** Kill the process and wait for it. Idempotent, and safe after it exited. */
  stop: () => Promise<FinishedCli>;
}

/**
 * Spawn one `psilink` invocation. `timeoutMs` kills a run that outlives it and
 * reports `timedOut`, so a stalled party fails its leg with a stated cause.
 *
 * `stdin`, when given, is written to the child and the pipe is left open: a
 * confirmation prompt resolves to "no" on end-of-input (`promptConfirm` races
 * the readline close), so closing the pipe behind the answer would race the
 * line against the EOF.
 */
export function startCli(params: {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}): RunningCli {
  const { args, cwd, env, stdin, timeoutMs } = params;
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), cliEntry, ...args],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const stdoutWaiters: Array<() => void> = [];

  child.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
    for (const notify of stdoutWaiters.splice(0)) notify();
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  if (stdin !== undefined) {
    // A run that never reads its stdin, or one killed with the pipe still open,
    // can break the pipe under this write. That is the run's own outcome to
    // report, not an error event with nothing listening for it, so it is
    // absorbed here.
    child.stdin?.on("error", () => {});
    child.stdin?.write(stdin);
  }

  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const finished = new Promise<FinishedCli>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      clearTimeout(deadline);
      // Let the last chunk of either stream land: `exit` can arrive before the
      // pipes have drained, and a truncated stderr is the diagnosis of the
      // failure this run is being asked about.
      setImmediate(() => {
        for (const notify of stdoutWaiters.splice(0)) notify();
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      });
    });
    child.once("error", (err: Error) => {
      clearTimeout(deadline);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nthe process could not be spawned: ${err.message}`,
        timedOut,
      });
    });
  });

  let exited = false;
  void finished.then(() => {
    exited = true;
  });

  return {
    finished,
    firstStdoutLine: (waitMs: number) =>
      new Promise<string>((resolve, reject) => {
        const settle = (): boolean => {
          const newline = stdout.indexOf("\n");
          if (newline < 0) return false;
          clearTimeout(timer);
          resolve(stdout.slice(0, newline));
          return true;
        };
        const timer = setTimeout(() => {
          if (settle()) return;
          reject(
            new Error(
              `the run wrote no complete stdout line within ${waitMs}ms; ` +
                `it had written ${JSON.stringify(stdout)}`,
            ),
          );
        }, waitMs);
        const attempt = (): void => {
          if (settle()) return;
          if (exited) {
            clearTimeout(timer);
            reject(
              new Error(
                "the run exited before writing a complete stdout line; it " +
                  `had written ${JSON.stringify(stdout)}`,
              ),
            );
            return;
          }
          stdoutWaiters.push(attempt);
        };
        attempt();
      }),
    stop: () => {
      void stopChild(child);
      return finished;
    },
  };
}

/**
 * How a finished run ended, for the message an assertion about it holds: the
 * exit status plus the tail of what it wrote to stderr, which is where the CLI
 * puts every diagnostic.
 */
export function describeCliRun(label: string, run: FinishedCli): string {
  const diagnostics = run.stderr.trimEnd();
  const tail =
    diagnostics === "" ? [] : diagnostics.split("\n").slice(-STDERR_TAIL_LINES);
  return (
    `${label}: exit ${run.exitCode ?? "none"}` +
    (run.signal !== null ? ` (signal ${run.signal})` : "") +
    (run.timedOut ? " after outliving its deadline" : "") +
    (tail.length === 0 ? "" : `\n${tail.join("\n")}`)
  );
}

/**
 * How much of a failed run's stderr an assertion message holds. The CLI
 * reports a failure on its last lines, so a short tail states the cause; the
 * whole stream is on the run for a caller that wants more.
 */
const STDERR_TAIL_LINES = 15;
