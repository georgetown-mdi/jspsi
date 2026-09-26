// Classifying a caught error into a process exit code, and the two boundaries
// that apply it: the classification a boundary reads when its errors vary,
// plus four of the sysexits rungs docs/CLI.md's exit-code table lists -- 70
// for an internal fault, 77 for an authentication failure, and
// verify-receipt's 65 and 66 verdict codes. The table's other rungs are
// declared where they are set.

import {
  AuthenticationError,
  ConnectionError,
  getLogger,
  InternalConsistencyError,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  UsageError,
} from "@alcove/core";

/**
 * The process exit code for a failure in this implementation rather than in
 * anything the operator, the partner, or the transport supplied: `EX_SOFTWARE`
 * (70), the sysexits code for an internal software error. Held by core's
 * {@link InternalConsistencyError}, which core and the CLI raise where a
 * check on their own state fails.
 *
 * Distinct from both neighbours: 64 would name the operator's input as what to
 * fix when the run already found their declared sizes within budget, and 69
 * would present a deterministic internal fault as a transport blip worth
 * retrying, when a retry re-runs the whole exchange to the same refusal. The
 * documented response to a 70 is to report it (see docs/CLI.md, Exit codes).
 */
export const INTERNAL_FAULT_EXIT_CODE = 70;

/**
 * The process exit code for an authentication failure: `EX_NOPERM` (77). Held
 * by core's {@link AuthenticationError} -- the key exchange rejecting the
 * shared secret or the peer, or an SFTP host key other than the pinned one --
 * and set on the refusal for a rotated shared secret this party could not
 * save, after which every later key exchange fails the same way.
 *
 * Not 69: a retry against the same secret or the same server reaches the same
 * refusal, and on a schedule so does every later run. The documented response
 * is to re-invite, or to verify the server's key (see docs/CLI.md, Exit
 * codes).
 */
export const AUTHENTICATION_FAILED_EXIT_CODE = 77;

/**
 * The process exit code `alcove verify-receipt` reports for a definite
 * verification failure: `EX_DATAERR` (65), the sysexits code for input data
 * that was incorrect in some way. Read by both of the command's report
 * renderers -- the unsigned record and the dual-signed record -- and combined
 * across them by {@link worseReceiptVerdictExitCode}, so a failure on either
 * half reports this code.
 *
 * Distinct from the top-level catch-all (`process.exit(1)` in `index.ts`),
 * which stays 1: an unattended supervisor that sees this code knows the run
 * itself completed and rendered a definite bad-data verdict, rather than
 * hitting an error no command handler caught. See docs/CLI.md, Exit codes.
 */
export const RECEIPT_VERIFICATION_FAILED_EXIT_CODE = 65;

/**
 * The process exit code `alcove verify-receipt` reports for an incomplete
 * verdict: `EX_NOINPUT` (66). Nothing contradicted the record, but a check
 * could not run because an input it needs -- data, terms, a pinned
 * fingerprint, a signing identity, the exchange record -- was not supplied or
 * could not be read. Nonzero so a script gating on exit 0 accepts only a
 * receipt that was fully checked, and distinct from
 * {@link RECEIPT_VERIFICATION_FAILED_EXIT_CODE} because the remedy is to
 * supply the missing inputs, not to distrust the record.
 */
export const RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE = 66;

/**
 * The exit code for two verify-receipt verdicts one run reports: a failure
 * outranks an incomplete verdict, which outranks a verified one. Not a
 * numeric maximum, since the incomplete code is the larger number.
 */
export function worseReceiptVerdictExitCode(a: number, b: number): number {
  const rank = (code: number): number =>
    code === RECEIPT_VERIFICATION_FAILED_EXIT_CODE
      ? 2
      : code === RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE
        ? 1
        : 0;
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The process exit code a caught command error reports: EX_USAGE (64) for a
 * {@link UsageError} or a {@link ConnectionError} of kind `usage`, bare or
 * behind `transport`-kind wraps ({@link firstLinkBehindTransportWraps}),
 * {@link INTERNAL_FAULT_EXIT_CODE} (70) for an {@link InternalConsistencyError}
 * and {@link AUTHENTICATION_FAILED_EXIT_CODE} (77) for an
 * {@link AuthenticationError}, each bare or behind the same wraps, otherwise the
 * error's own numeric `exitCode`
 * when it has one, else EX_UNAVAILABLE (69). The classification a boundary
 * reads when its errors vary; a boundary whose errors are all usage faults
 * exits 64 outright.
 *
 * A {@link ConnectionError}'s taxonomy is a FIELD (`kind`) rather than a
 * subclass, so it is read here rather than left to the 69 default: a `usage`
 * kind names a caller, protocol, or terms correction that a re-run cannot
 * supply. The one subclass read here is {@link AuthenticationError}; every
 * other `security`-kind failure, and `transport`, `closed`, and `protocol`,
 * stay 69.
 *
 * The own-`exitCode` rung matters in both directions: `openInputSource`
 * throws a plain `Error` holding `exitCode`, so a missing input file keeps
 * its own code rather than collapsing to 69, and a run whose exchange
 * completed while its result file did not reach disk has
 * `PERSISTENCE_LOSS_EXIT_CODE` (73). The rung is typed rather than
 * `??`-defaulted so a non-numeric `exitCode` on some other object cannot reach
 * `process.exit`.
 */
export function exitCodeForError(err: unknown): number {
  const unwrapped = firstLinkBehindTransportWraps(err);
  if (isUsageFault(unwrapped)) return 64;
  if (unwrapped instanceof InternalConsistencyError)
    return INTERNAL_FAULT_EXIT_CODE;
  if (unwrapped instanceof AuthenticationError)
    return AUTHENTICATION_FAILED_EXIT_CODE;
  const own = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  return typeof own === "number" ? own : 69;
}

function isUsageFault(err: unknown): boolean {
  return (
    err instanceof UsageError ||
    (err instanceof ConnectionError && err.kind === "usage")
  );
}

/**
 * The first link of `err`'s cause chain that is not a `transport`-kind
 * {@link ConnectionError}, walking at most {@link MAX_ERROR_CAUSE_DEPTH}
 * links; `err` itself when it is not one. The message bridge
 * (`fromEventConnection`) wraps every send and poll failure that way, so a
 * {@link UsageError} the file-sync transport raised, an
 * {@link InternalConsistencyError}, or an {@link AuthenticationError}, reaches
 * a command boundary behind it. Any other
 * kind ends the walk, so a `security` failure keeps its own code whatever it
 * wraps.
 */
function firstLinkBehindTransportWraps(err: unknown): unknown {
  let link: unknown = err;
  for (
    let depth = 0;
    depth < MAX_ERROR_CAUSE_DEPTH &&
    link instanceof ConnectionError &&
    link.kind === "transport";
    depth++
  )
    link = link.cause;
  return link;
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
