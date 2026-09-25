import { spawn } from "node:child_process";

import { MAX_DIRECTORY_ENTRIES } from "../connection/listingGuard";

// The one process boundary `alcove doctor probe` crosses, through
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
  /** True when the output reached {@link MAX_CAPTURED_OUTPUT} and was cut. */
  truncated?: boolean;
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
 * Room allowed per line of an smbclient listing. Its longest entry line -- a
 * 255-character name, the attributes, a 20-digit size, and the date -- is
 * about 310 characters.
 */
const LISTING_LINE_ALLOWANCE = 512;

/**
 * Cap on captured child output, in UTF-16 code units. smbclient can answer with
 * a whole share listing, and the server on the other end is not this
 * operator's, so the buffer a hostile or merely enormous answer can grow is
 * bounded here rather than left to available memory. It holds a listing past
 * the transport's directory-listing bound, so the probe counts such a folder in
 * full rather than a prefix of it.
 * @internal exported for testing
 */
export const MAX_CAPTURED_OUTPUT =
  (MAX_DIRECTORY_ENTRIES + 64) * LISTING_LINE_ALLOWANCE;

/**
 * Child output accumulated up to {@link MAX_CAPTURED_OUTPUT}, recording whether
 * anything was cut.
 * @internal exported so a test runner applies the same cap
 */
export class OutputCapture {
  text = "";
  truncated = false;

  append(chunk: string): void {
    const room = MAX_CAPTURED_OUTPUT - this.text.length;
    if (chunk.length > room) this.truncated = true;
    if (room > 0) this.text += chunk.slice(0, room);
  }
}

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

      const output = new OutputCapture();
      let timedOut = false;
      const capture = (chunk: Buffer): void =>
        output.append(chunk.toString("utf8"));
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
          output: output.text,
          timedOut,
          truncated: output.truncated,
          spawnErrorCode: err.code ?? "ESPAWN",
        });
      });
      child.on("close", (code) => {
        settle({
          code,
          output: output.text,
          timedOut,
          truncated: output.truncated,
        });
      });
    });
  },
};
