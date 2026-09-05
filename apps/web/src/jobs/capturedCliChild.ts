import { spawn } from "node:child_process";

import { sanitizedChildEnv } from "./cliDriver";

import type { ChildProcess } from "node:child_process";

/**
 * The one spawn boundary the console's short-lived CLI drivers cross: the
 * host-key probe ({@link ./sftpProbe}) and the signing-identity fingerprint
 * ({@link ./signingIdentity}). Each is a request-scoped child that prints a
 * single line and exits, so both need the same three controls -- a no-shell argv
 * array, a capped stdout read, and a watchdog that bounds the child's lifetime
 * -- and both are reached from an unauthenticated loopback endpoint. Holding them
 * once is what keeps the two from drifting apart: a caller contributes only its
 * argv, its own timeouts, and its own mapping from an outcome to a typed result.
 * The watchdog bounds the child, not the endpoint's latency: settling waits for
 * the stdio pipes to close, so a child that handed its stdout to a longer-lived
 * process it spawned defers settling past the kill. That shape is a stated limit
 * of this boundary, not one it enforces.
 *
 * `spawn` with an argv ARRAY and `shell: false` is the same allowlisted-argv
 * discipline `runCliChild` uses, so no value a caller composes is ever an
 * interpretable token. stderr is drained and DISCARDED: it can name filesystem
 * paths inside the container and can contain bytes an untrusted server chose, so
 * nothing this boundary returns is derived from it, while draining keeps a chatty
 * child's pipe from filling and blocking it.
 */

/**
 * The cap on retained child stdout, in UTF-16 code units. Every caller's child
 * emits ONE short line (a fingerprint digest, or a small JSON object) and sends
 * every diagnostic to stderr, so anything past a few KiB is a malformed or
 * hostile child: the read is bounded rather than left to grow, and the overflow
 * is reported as a missing read the caller classifies as an error.
 */
export const CAPTURED_STDOUT_CAP = 4096;

/**
 * How a captured child ended:
 * - `spawnFailed`: the child could not be spawned, or died before running.
 * - `timedOut`: the watchdog killed it (it outlived the caller's budget).
 * - `exited`: it ended on its own. `code` is its exit code, or null when a signal
 *   ended it; `stdout` is the captured text, or undefined when the read
 *   overflowed {@link CAPTURED_STDOUT_CAP}.
 */
export type CapturedChildOutcome =
  | { kind: "spawnFailed" }
  | { kind: "timedOut" }
  | { kind: "exited"; code: number | null; stdout: string | undefined };

/**
 * Spawn `node argv` for a one-shot CLI child, capture its stdout under
 * {@link CAPTURED_STDOUT_CAP}, and settle once its stdio has closed or the
 * watchdog kills it.
 *
 * The watchdog SIGTERMs at `sigtermMs`, escalating to SIGKILL after
 * `sigkillGraceMs` -- mirroring `jobManager.ts`'s cancel-escalation chain. Every
 * timer is unref'd and cleared on settle, so a pending watchdog never holds the
 * process open or fires after the result is out. Both budgets are the caller's;
 * what the child itself spends is its own subcommand's business.
 *
 * `cwd` is omitted to inherit the server's working directory; a caller resolving
 * paths relative to it pins its own and creates it first.
 */
export function runCapturedCliChild(args: {
  argv: Array<string>;
  cwd?: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs: number;
  sigkillGraceMs: number;
}): Promise<CapturedChildOutcome> {
  return new Promise<CapturedChildOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args.argv, {
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...sanitizedChildEnv(), ...args.childEnv },
      });
    } catch {
      resolve({ kind: "spawnFailed" });
      return;
    }

    let stdout = "";
    let stdoutOverflow = false;
    const out = child.stdout;
    if (out !== null) {
      out.setEncoding("utf8");
      out.on("data", (chunk: string) => {
        if (stdoutOverflow) return;
        stdout += chunk;
        if (stdout.length > CAPTURED_STDOUT_CAP) {
          stdoutOverflow = true;
          stdout = "";
        }
      });
    }
    child.stderr?.resume();

    let timedOut = false;
    let settled = false;
    const timers: Array<NodeJS.Timeout> = [];
    const settle = (outcome: CapturedChildOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(outcome);
    };

    const toSigterm = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, args.sigkillGraceMs);
      toSigkill.unref();
      timers.push(toSigkill);
    }, args.sigtermMs);
    toSigterm.unref();
    timers.push(toSigterm);

    child.on("error", () => settle({ kind: "spawnFailed" }));
    child.on("close", (code) => {
      settle(
        timedOut
          ? { kind: "timedOut" }
          : {
              kind: "exited",
              code,
              stdout: stdoutOverflow ? undefined : stdout,
            },
      );
    });
  });
}
