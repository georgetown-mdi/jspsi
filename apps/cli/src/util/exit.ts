// Classifying a caught error into a process exit code, and the two boundaries
// that apply it: the classification a boundary reads when its errors vary,
// plus two of the sysexits rungs docs/CLI.md's exit-code table lists -- 70
// for an internal fault and 65 for a definite verify-receipt failure. The
// table's other rungs are declared where they are set.

import {
  ConnectionError,
  getLogger,
  InternalConsistencyError,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";

/**
 * The process exit code for a failure in this implementation rather than in
 * anything the operator, the partner, or the transport supplied: `EX_SOFTWARE`
 * (70), the sysexits code for an internal software error. Held by core's
 * {@link InternalConsistencyError}, which core raises where it finds one of
 * its own invariants broken.
 *
 * Distinct from both neighbours: 64 would name the operator's input as what to
 * fix when the run already found their declared sizes within budget, and 69
 * would present a deterministic internal fault as a transport blip worth
 * retrying, when a retry re-runs the whole exchange to the same refusal. The
 * documented response to a 70 is to report it (see docs/CLI.md, Exit codes).
 */
export const INTERNAL_FAULT_EXIT_CODE = 70;

/**
 * The process exit code `psilink verify-receipt` reports for a definite
 * verification failure: `EX_DATAERR` (65), the sysexits code for input data
 * that was incorrect in some way. Read by both of the command's report
 * renderers -- the unsigned record and the dual-signed record -- and rolled up
 * by the command handler with `Math.max` alongside the 0 the other outcomes
 * report, so a failure on either half still reports this code.
 *
 * Distinct from the top-level catch-all (`process.exit(1)` in `index.ts`),
 * which stays 1: an unattended supervisor that sees this code knows the run
 * itself completed and rendered a definite bad-data verdict, rather than
 * hitting an error no command handler caught. See docs/CLI.md, Exit codes.
 */
export const RECEIPT_VERIFICATION_FAILED_EXIT_CODE = 65;

/**
 * The process exit code a caught command error reports: EX_USAGE (64) for a
 * {@link UsageError} or a {@link ConnectionError} of kind `usage`,
 * {@link INTERNAL_FAULT_EXIT_CODE} (70) for an {@link InternalConsistencyError},
 * otherwise the error's own numeric `exitCode` when it has one, else
 * EX_UNAVAILABLE (69). The classification a boundary reads when its errors
 * vary; a boundary whose errors are all usage faults exits 64 outright.
 *
 * A {@link ConnectionError}'s taxonomy is a FIELD (`kind`) rather than a
 * subclass, so it is read here rather than left to the 69 default: a `usage`
 * kind names a caller, protocol, or terms correction that a re-run cannot
 * supply, while `transport`, `closed`, `security`, and `protocol` stay 69,
 * availability conditions a retry can clear.
 *
 * The own-`exitCode` rung matters in both directions: `openInputSource` and
 * `buildDataSpec` throw plain `Error`s holding `exitCode`, so a missing input
 * file keeps its own code rather than collapsing to 69, and a run whose
 * exchange completed while its result file did not reach disk has
 * `PERSISTENCE_LOSS_EXIT_CODE` (73). The rung is typed rather than
 * `??`-defaulted so a non-numeric `exitCode` on some other object cannot reach
 * `process.exit`.
 */
export function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return 64;
  if (err instanceof ConnectionError && err.kind === "usage") return 64;
  if (err instanceof InternalConsistencyError) return INTERNAL_FAULT_EXIT_CODE;
  const own = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  return typeof own === "number" ? own : 69;
}

/**
 * Log a caught error (sanitized) at error level and exit the process with
 * `code`. The single log-and-exit boundary the bootstrap-style command handlers
 * route a caught error through, so the error-level routing and the sanitized
 * formatting cannot drift between call sites. `code` is supplied by the caller
 * because the classification is site-specific: a command whose errors are all
 * local usage faults passes 64 outright, while a command whose errors vary
 * resolves the code through {@link exitCodeForError}. Typed `never` so a
 * caller's definite-assignment narrowing treats it like `process.exit`.
 */
export function exitWithError(
  log: { error: (message: string) => void },
  err: unknown,
  code: number,
): never {
  log.error(sanitizeErrorForDisplay(err));
  process.exit(code);
}

/**
 * Run a command body, mapping any thrown error to a process exit through
 * {@link exitCodeForError}. This is the single error->exit boundary for the
 * bootstrap-style commands: routing the whole handler body through it means a
 * thrown or rejected step exits cleanly rather than crashing with an
 * unhandled rejection.
 *
 * The error logger is created from `loggerName` lazily in the catch, so it
 * picks up whatever sink and level the body installed rather than binding to
 * the defaults before the command has parsed its flags. `process.exit` is
 * typed `never`, so values produced inside `body` keep their
 * definite-assignment narrowing.
 */
export async function runOrExit(
  loggerName: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    getLogger(loggerName).error(sanitizeErrorForDisplay(err));
    process.exit(exitCodeForError(err));
  }
}
