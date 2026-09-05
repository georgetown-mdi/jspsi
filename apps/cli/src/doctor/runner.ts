import { spawn } from "node:child_process";

// The one process boundary `psilink doctor probe` crosses, through
// `CommandRunner`, so the checks stay unit-testable against a recorded
// transcript. Two rules make it safe: an argv ARRAY, never a shell string --
// the server, share, path, username, and domain in it are operator input --
// and a bounded wait, since a server that accepts the connection and answers
// nothing must not hang an unattended run.

/** The outcome of one child process. */
export interface CommandResult {
  /** Exit status, or `null` when the process was killed by a signal. */
  code: number | null;
  /** stdout and stderr interleaved, as the setup script's `2>&1` collects them. */
  output: string;
  /** True when the wait ran out and the child was killed. */
  timedOut: boolean;
  /**
   * `errno` code when the child could not be spawned at all -- `ENOENT` when the
   * binary is not installed. Distinct from a nonzero exit: nothing ran.
   */
  spawnErrorCode?: string;
}

/** The injectable process runner the doctor checks invoke smbclient through. */
export interface CommandRunner {
  run(
    file: string,
    args: string[],
    options: { cwd?: string; timeoutMs: number },
  ): Promise<CommandResult>;
}

/**
 * Cap on captured child output. smbclient can answer with a whole share listing,
 * and the server on the other end is not this operator's, so the buffer a
 * hostile or merely enormous answer can grow is bounded here rather than left to
 * available memory.
 */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Grace period between the timeout's SIGTERM and the SIGKILL behind it. */
const KILL_GRACE_MS = 2000;

/**
 * Environment variables removed from every child's environment. The password
 * reaches smbclient through an owner-only credentials file, never argv and never
 * the environment, so a child that inherited `SMB_PASS` would be publishing it
 * in `/proc/<pid>/environ` for no purpose. `PASSWD` is smbclient's own
 * password variable, cleared so an unrelated value in the caller's environment
 * cannot silently stand in for the credentials file.
 */
const STRIPPED_CHILD_ENV = ["SMB_PASS", "PASSWD", "PASSWD_FILE"];

/** The real runner: `spawn` with an argv array, no shell, and a bounded wait. */
export const nodeCommandRunner: CommandRunner = {
  run(file, args, options) {
    return new Promise<CommandResult>((resolve) => {
      const env = { ...process.env };
      for (const name of STRIPPED_CHILD_ENV) delete env[name];

      let child;
      try {
        child = spawn(file, args, {
          cwd: options.cwd,
          env,
          // stdin is /dev/null so smbclient, which falls back to prompting when
          // it cannot read the credentials it was given, reads EOF and gives up
          // instead of waiting forever on a terminal that is not there.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          code: null,
          output: "",
          timedOut: false,
          spawnErrorCode: (err as NodeJS.ErrnoException).code ?? "ESPAWN",
        });
        return;
      }

      let output = "";
      let timedOut = false;
      const capture = (chunk: Buffer): void => {
        if (output.length >= MAX_OUTPUT_BYTES) return;
        output += chunk
          .toString("utf8")
          .slice(0, MAX_OUTPUT_BYTES - output.length);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      }, options.timeoutMs);
      timer.unref();

      const settle = (result: CommandResult): void => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(result);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        settle({
          code: null,
          output,
          timedOut,
          spawnErrorCode: err.code ?? "ESPAWN",
        });
      });
      child.on("close", (code) => {
        settle({ code, output, timedOut });
      });
    });
  },
};
