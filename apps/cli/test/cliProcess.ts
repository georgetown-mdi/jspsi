import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stopChild } from "./stopChild";

/**
 * Runs `psilink` as a CHILD PROCESS -- the command line an operator types, from
 * its own argv to its own exit code -- so a leg can drive a whole invocation
 * rather than the seam behind it.
 *
 * Why a process and not the exported handler: a handler-level run has to stand
 * in for the parts of an invocation that belong to the process. `accept` reads
 * its confirmation from stdin, so driving it in-process means stubbing the one
 * human checkpoint a leg about the acceptance exists to exercise; the exit code
 * the CLI sets through `process.exit` cannot be observed at all; and a child
 * takes environment at startup, which is how a party trusts a throwaway loopback
 * certificate (`NODE_EXTRA_CA_CERTS`) without weakening TLS verification in the
 * test process.
 *
 * Why `tsx` and not plain `node`: this suite runs from `src/`, and Node's
 * strip-only TypeScript support refuses syntax the CLI's dependencies use, so
 * the entry needs a transforming loader -- the same reason, resolved the same
 * way, as `test/signaling/brokerProcess.ts`. Both resolve `tsx` through the
 * module resolver rather than a guessed `node_modules/.bin` path, so a hoisting
 * change cannot silently break the spawn.
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
 * Spawn one `psilink` invocation.
 *
 * `timeoutMs` is a hard deadline: a run that outlives it is killed and reported
 * with `timedOut`, so a party that stalls fails its leg with a stated cause
 * instead of running until the test framework kills the worker under it.
 *
 * `stdin`, when given, is written to the child and the pipe is LEFT OPEN. A
 * confirmation prompt resolves to "no" on end-of-input (`promptConfirm` races
 * the readline close), so closing the pipe behind the answer would make an
 * answered prompt a race between the line and the EOF.
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
 * How a finished run ended, for the message an assertion about it carries: the
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
 * How much of a failed run's stderr an assertion message carries. The CLI
 * reports a failure on its last lines, so a short tail carries the cause; the
 * whole stream is on the run for a caller that wants more.
 */
const STDERR_TAIL_LINES = 15;
