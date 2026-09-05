import fs from "node:fs";
import util from "node:util";
import readline from "node:readline/promises";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";

import {
  ConnectionError,
  getDiagnosticSink,
  getLogger,
  InternalConsistencyError,
  MAX_TIMEOUT_SECONDS,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  setLogLevel,
  UsageError,
} from "@psilink/core";

import { createOwnerOnlyWriteStream, stripExtendedAcls } from "../fileUtils";
import { parseDurationFlag, parseFineDurationFlag } from "./duration";

/**
 * Read a single-value CLI option from parsed yargs `Arguments`, rejecting a flag
 * given more than once. yargs collects a repeated option into an array (e.g.
 * `--accept-timeout 60 --accept-timeout 120` -> `[60, 120]`), which would reach
 * arithmetic, a comparison, or a string method as if it were a scalar; this
 * throws a {@link UsageError} naming the flag instead.
 *
 * Returns the value unchanged for the caller to cast to the option's declared
 * type (`undefined` when the flag was absent). `type: "count"` and
 * `type: "boolean"` options are not read through here, since a repeat is valid
 * for them.
 */
export function singleValue(argv: Arguments, name: string): unknown {
  const value = argv[name];
  if (Array.isArray(value))
    throw new UsageError(`--${name} may be given only once`);
  return value;
}

/**
 * Reject any `--`-prefixed token captured among a command's positionals as an
 * unrecognized option, with a {@link UsageError} (exit 64) naming it, in the
 * same "Unknown argument(s): ..." wording yargs' own `strictOptions` uses.
 * `invite`, `accept`, and `init` set `unknown-options-as-args` so a `-`-leading
 * invitation string survives as a positional -- which also lets a mistyped
 * `--flag` reach the positional array -- so those commands reject a typo
 * through this scan instead of `strictOptions`.
 *
 * A legitimate positional is single-`-`-leading at most (an invitation,
 * `@path` reference, input/output file, or server URL), so a double-dash token
 * is always a mistype; a single-`-` token is left untouched, since it cannot be
 * told from a `-`-leading invitation without decoding it. yargs consumes a lone
 * `--` separator before positionals are captured, so it never reaches this scan.
 */
export function assertNoUnknownOptions(positionals: Array<unknown>): void {
  const unknown = positionals
    .map(String)
    .filter((token) => token.startsWith("--"));
  if (unknown.length === 0) return;
  throw new UsageError(
    `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
  );
}

/**
 * The sanity ceiling the duration-valued timeout flags (`--connection-timeout`,
 * `--peer-timeout`, `--accept-timeout`) are capped at, re-exported from core --
 * the console's zero-setup authoring surface holds its timeout fields to the same
 * value, and core is the only module both apps can import. Its rationale lives
 * with the option fields it qualifies, in
 * `packages/core/src/config/connection.ts`.
 */
export { MAX_TIMEOUT_SECONDS };

/**
 * Read a duration-valued CLI option from parsed `Arguments` and return it as a
 * whole number of seconds (or `undefined` when the flag is absent). Rejects a
 * repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseDurationFlag}), naming the flag in either error. When `maxSeconds`
 * is given, a value above it is rejected with a flag-named usage error stating
 * the maximum, checked after parsing so it layers on top of the malformed,
 * zero, and overflow rejections rather than replacing them.
 *
 * {@link parseDurationFlag} yields a positive millisecond offset whose smallest
 * unit is seconds, so the divide-by-1000 to seconds is always exact.
 */
export function durationFlagSeconds(
  argv: Arguments,
  name: string,
  maxSeconds?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // Coerce the unknown from singleValue to a string so a type:"string" contract
  // violation is reported as parseDurationFlag's flag-named UsageError rather
  // than a raw TypeError from .trim() on a non-string.
  const seconds = parseDurationFlag(`--${name}`, String(raw)) / 1000;
  // The sanity cap is the last check: parseDurationFlag has already rejected a
  // zero, malformed, bare-integer, or overflowing value, so only a well-formed
  // value past the product ceiling remains to reject here. The ceiling is
  // stated in whole days; callers pass a whole-day cap (MAX_TIMEOUT_SECONDS).
  if (maxSeconds !== undefined && seconds > maxSeconds)
    throw new UsageError(
      `--${name} must not exceed ${maxSeconds / 86_400}d; got ${String(raw)}`,
    );
  return seconds;
}

/**
 * Read a duration-valued CLI option and return it as a whole number of
 * MILLISECONDS (or `undefined` when the flag is absent), preserving sub-second
 * precision. The millisecond counterpart of {@link durationFlagSeconds}: it reads
 * through {@link parseFineDurationFlag} rather than the coarse
 * {@link parseDurationFlag}, so the flag also accepts a `100ms`-style value, and
 * returns the parser's millisecond offset directly instead of dividing to
 * seconds, which would floor a sub-second value to zero.
 *
 * The sole caller, `--polling-frequency`, takes no product ceiling: a large
 * poll interval is merely slow, unlike a timeout flag's coordination window.
 * {@link parseFineDurationFlag} still rejects a value large enough to overflow
 * a safe integer.
 *
 * A repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseFineDurationFlag}) are rejected with a flag-named {@link UsageError}
 * (exit 64).
 */
export function durationFlagMs(
  argv: Arguments,
  name: string,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // Coerce to a string defensively, as durationFlagSeconds does.
  return parseFineDurationFlag(`--${name}`, String(raw));
}

/**
 * Read a count-valued CLI option (a nonnegative whole number) from parsed
 * `Arguments` and return it as a number (or `undefined` when the flag is
 * absent). Rejects a repeat (via {@link singleValue}) and any value that is not
 * a nonnegative safe integer -- a negative, a fraction, a non-numeric token, or
 * a magnitude past `Number.MAX_SAFE_INTEGER` -- with a flag-named
 * {@link UsageError} (exit 64). `Number.isSafeInteger` mirrors the schema's
 * `z.int().nonnegative()` on the same field, so the CLI boundary and the
 * merged-options re-validation agree.
 *
 * `maxValue`, when given, is an inclusive upper sanity ceiling checked after
 * the type/sign/range rejection, rejected with the same flag-named
 * {@link UsageError}; the message states a bare count with no time unit. Omit
 * `maxValue` for a flag with no product ceiling.
 *
 * Route only non-secret count flags through this helper: a rejected value is
 * echoed verbatim in the usage error, and {@link sanitizeErrorForDisplay}
 * redacts PEM key blocks, not a bare token, so a secret-valued flag would leak
 * into stderr and any log.
 */
export function nonNegativeIntFlag(
  argv: Arguments,
  name: string,
  maxValue?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new UsageError(
      `--${name} must be a non-negative whole number; got ${String(raw)}`,
    );
  // The sanity ceiling is the last check, layered on top of the type/sign/range
  // rejection above (a value reaching here is a non-negative safe integer), the
  // same way durationFlagSeconds applies MAX_TIMEOUT_SECONDS after parseDurationFlag.
  if (maxValue !== undefined && raw > maxValue)
    throw new UsageError(
      `--${name} must not exceed ${maxValue}; got ${String(raw)}`,
    );
  return raw;
}

/**
 * Run a pre-logger parse step, mapping a {@link UsageError} it throws to a
 * clean stderr message and exit 64. A bootstrap-style command resolves its log
 * level and reads every option before the logger exists, so a usage error
 * there cannot be routed through the logger; this is the one place that
 * boundary lives. Any other error propagates unchanged to the top-level
 * handler. `process.exit` is typed `never`, so this returns the parsed value
 * on the success path.
 */
export function parseOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(sanitizeErrorForDisplay(err));
    process.exit(64);
  }
}

/**
 * The process exit code for a failure in this implementation rather than in
 * anything the operator, the partner, or the transport supplied: `EX_SOFTWARE`
 * (70), the sysexits code for an internal software error. Held by core's
 * {@link InternalConsistencyError}, whose only raise site is the single-pass
 * send-time reply-cap safety check, and set nowhere else.
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
 * EX_UNAVAILABLE (69). The single classification every error->exit boundary of
 * an exchange-running command reads.
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
 * local usage faults passes 64 outright, while an exchange-running command
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

// Mapping from log-level name to loglevel numeric constant. Module-private so
// logLevelFlag stays the only route from a --log-level value to a level.
// A Map rather than an object literal: the lookup key is an operator-supplied
// string, and an object literal answers `constructor`, `toString`, and every
// other Object.prototype member with an inherited function where a level
// number is expected, which the `=== undefined` rejection below cannot see.
const LOG_LEVELS = new Map<string, logLibrary.LogLevelNumbers>([
  ["silent", logLibrary.levels.SILENT],
  ["error", logLibrary.levels.ERROR],
  ["warn", logLibrary.levels.WARN],
  ["info", logLibrary.levels.INFO],
  ["debug", logLibrary.levels.DEBUG],
  ["trace", logLibrary.levels.TRACE],
]);

/**
 * Read the `--log-level` option from parsed `Arguments` and return the loglevel
 * numeric constant naming it -- `silent`, `error`, `warn`, `info`, `debug`, or
 * `trace` -- defaulting to `info` when the flag is absent or empty and matching
 * case-insensitively. A repeat is rejected by {@link singleValue}; any other name
 * raises a {@link UsageError} echoing the value the operator supplied, so a typo
 * is reported rather than silently taken as the default.
 *
 * This is the single resolve every `--log-level`-bearing command reads through,
 * but it stops at the {@link UsageError}: mapping that to an exit is the
 * caller's, since the callers do not share one boundary. A command whose
 * logger does not exist yet wraps the call in {@link parseOrExit};
 * `parseCommonBootstrapArgs` lets it propagate, since a parse function that
 * exits the process cannot be composed or tested; and a command already
 * inside {@link runOrExit} lets it reach that handler.
 */
export function logLevelFlag(argv: Arguments): logLibrary.LogLevelNumbers {
  const name = (
    (singleValue(argv, "log-level") as string | undefined) || "info"
  ).toLowerCase();
  const level = LOG_LEVELS.get(name);
  if (level === undefined)
    throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);
  return level;
}

/**
 * A redirect of diagnostic output, returned by {@link configureLogFile} (to a
 * file) and {@link configureStderrLogging} (to stderr). A CLI handler installs
 * exactly one and closes it when the command ends.
 */
export interface LogSink {
  /**
   * Restore the diagnostic sink in place before the redirect and, for the file
   * sink, close the underlying descriptor; best-effort and idempotent.
   */
  close(): void;
  /**
   * Write one line to wherever this sink sends diagnostics -- stderr, or the
   * `--log-file` descriptor -- with no `[ISO] [LEVEL] [CONTEXT]` prefix. It is
   * for text a command renders for a person to read rather than as a
   * diagnostic record: the prefix is about 50 columns wide, so a rendering an
   * operator reads in an 80-column console wraps on every line. Routing it
   * through the sink rather than straight to `process.stderr` is what keeps
   * `--log-file` capturing it, the difference from {@link writePromptLine}.
   *
   * The trailing newline is appended here; the write is guarded like a
   * prefixed line's -- a failure is reported (file sink) or dropped (stderr),
   * never thrown back at the caller.
   */
  writePlain(line: string): void;
}

/**
 * Install `writeLine` as core's process-wide {@link DiagnosticSink}, returning a
 * {@link LogSink} that restores the prior sink (and runs `onClose`, if given) on
 * close. This is what both CLI sinks build on -- the {@link configureLogFile}
 * file redirect and the default {@link configureStderrLogging} stderr routing.
 *
 * core resolves the diagnostic sink at each log CALL, not when a logger is
 * built, so this reroutes every logger -- including the ones core and the CLI
 * construct at import time (`cleaning`, `file-utils`) -- the moment it is
 * installed, with no creation-order constraint. core's `setLogPrefixer` hands
 * the sink the assembled `[ISO] [LEVEL] [CONTEXT]` prefix and the message
 * arguments, already stripped of private-key blocks; `util.format` renders
 * them into one line and `writeLine` appends the newline and delivers it.
 *
 * {@link LogSink.writePlain} feeds the same `writeLine` with no prefix, so an
 * operator-facing line lands on the sink's destination alongside the prefixed
 * ones. It does NOT pass through core's prefixer, so the private-key strip
 * above does not run on it: a caller composing a fragment someone else chose
 * redacts it at the composition site or not at all.
 */
function installLogSink(
  writeLine: (line: string) => void,
  onClose?: () => void,
): LogSink {
  const previousSink = getDiagnosticSink();
  setDiagnosticSink((_methodName, prefix, args) =>
    writeLine(util.format(prefix, ...args) + "\n"),
  );
  return {
    writePlain(line: string): void {
      writeLine(line + "\n");
    },
    close(): void {
      // Restore the prior sink first, then run onClose (the file sink closes its
      // descriptor there). Because core resolves the sink per log call, restoring
      // it detaches this sink from every logger at once -- a log emitted after
      // close() goes to the restored sink (or the default console routing), never
      // to a descriptor onClose has already closed.
      setDiagnosticSink(previousSink);
      onClose?.();
    },
  };
}

/**
 * Redirect every diagnostic log line to `logFilePath` (append mode) instead of
 * the terminal, returning a {@link LogSink} the caller closes after the
 * exchange. Omitting the flag leaves logging on the terminal untouched -- a
 * handler only calls this when `--log-file` was given.
 *
 * The redirect is core's process-wide {@link DiagnosticSink} (installed via
 * {@link installLogSink}), resolved at each log CALL, so it captures every
 * logger regardless of when it was built -- including the two constructed at
 * import time (`file-utils`, `cleaning`). Level filtering stays with loglevel,
 * so `--log-level silent` writes nothing to the file.
 *
 * Writes are synchronous (`fs.writeSync`), not buffered through a
 * `WriteStream`: a handler reports its final error with `log.error(...)`
 * immediately before `process.exit`, which would abandon a stream's unflushed
 * buffer, losing exactly the diagnostic an unattended operator opened the file
 * to capture. A synchronous write is durable before the call returns, so
 * `process.exit` cannot truncate it.
 *
 * {@link LogSink.close} restores the prior sink before closing the descriptor,
 * so a log emitted after `close()` routes to the restored sink, never to the
 * closed descriptor. The write path guards a failed `fs.writeSync` (a full
 * disk) and reports it on stderr rather than throwing back into the log call.
 *
 * The file is opened synchronously (`openSync` with `"a"`) so a missing parent
 * directory or other open failure shows up here, as a {@link UsageError}
 * before any exchange work begins, and created owner-only (`0o600`). The path
 * is operator-supplied, not attacker-derived, so the open skips the
 * `O_NOFOLLOW`/`O_EXCL` hardening psilink's credential writers use for paths
 * it derives itself.
 *
 * Between that open and the first write, on macOS the file's extended (NFSv4)
 * ACL is cleared, so no line is written while an inherited ACE could still
 * grant another principal the access the `0600` mode denies; the strip
 * follows a symlink at the path, matching the open. A failed strip is
 * fail-closed: the descriptor is released and the run refused as a
 * {@link UsageError} holding the refusal as its cause, with an existing
 * file's content untouched and a created one left empty.
 */
export function configureLogFile(logFilePath: string): LogSink {
  // Windows paths are accepted: fold backslashes to forward slashes on ingestion
  // (the Windows-path convention in CONTRIBUTING.md -- normalize backslashes
  // wherever a user can supply a local path) so a backslash or UNC form opens the
  // intended file.
  const normalized = logFilePath.replace(/\\/g, "/");

  let fd: number;
  try {
    // "a" creates-or-appends and throws synchronously (ENOENT) when the parent
    // directory is absent, so the failure is reported before any exchange work
    // begins, and opens with O_APPEND so each writeSync lands at the current
    // end of file. The 0o600 mode creates the file owner-only, since a
    // debug/trace log can hold partner identity, linkage keys, and data
    // categories (see writeFileOwnerOnly, docs/SECURITY_DESIGN.md "Required
    // permissions"). The mode applies only when the file is created, so an
    // existing --log-file path keeps its own permissions.
    fd = fs.openSync(normalized, "a", 0o600);
  } catch (err) {
    throw new UsageError(
      `could not open log file ${normalized}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  try {
    // Between the open and the first line, the same place the owner-only writers
    // put it: on macOS the 0600 mode leaves an inherited ACE in force, and this
    // descriptor is where the run's diagnostics land. The strip follows a
    // symlink at the path because the open does -- acting on the link node
    // would clear an ACL governing nothing while the lines went to its target.
    stripExtendedAcls(normalized, { symlinks: "follow" });
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort close of the descriptor the open above took; the refusal
      // below is what the caller has to see.
    }
    // Reported through this function's own usage boundary, as its open failure
    // is, so a refused log file exits 64 before any exchange work begins rather
    // than escaping to the last-resort printer. The strip's refusal -- which
    // names the file and holds the underlying failure -- rides as the cause.
    throw new UsageError(`could not secure log file ${normalized}`, {
      cause: err,
    });
  }

  return installLogSink(
    (line) => {
      try {
        writeAll(fd, line);
      } catch (err) {
        // loglevel is redirected into this descriptor, so a mid-run write failure
        // (e.g. the disk filling) cannot be reported through the logger, and must
        // not throw out of a log call into the exchange; report it on the
        // original stderr and continue. The stderr write is itself guarded: if it
        // too fails (a wedged stderr), give up silently rather than let that throw
        // back into the log call this catch exists to protect.
        try {
          process.stderr.write(
            `log file ${normalized} write error: ` +
              sanitizeErrorForDisplay(err) +
              "\n",
          );
        } catch {
          // Nothing left to report to; drop it.
        }
      }
    },
    () => {
      // installLogSink has already restored the prior sink; release the fd last.
      // A double close throws EBADF, which is swallowed.
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort: the descriptor may already be closed.
      }
    },
  );
}

/**
 * Route ALL loglevel diagnostic output to stderr, returning a {@link LogSink}
 * the caller closes when the command ends. This is the CLI's default logging
 * sink, installed whenever `--log-file` is NOT given, and it reserves stdout
 * exclusively for a command's result data -- the exchange result CSV, the
 * invitation token, the `fingerprint` summary -- so a piped or redirected
 * result is never corrupted by an interleaved diagnostic line.
 *
 * Without it, loglevel's default routing sends `info`/`debug` to stdout and
 * only `warn`/`error` to stderr, so a redirected run would splice diagnostic
 * lines into the result file. This sink sends every level to
 * `process.stderr` instead, so `psilink <cmd> 2>/dev/null` yields clean
 * result data on stdout. The interactive confirmation prompt
 * ({@link promptConfirm}) already writes to stderr for the same reason.
 *
 * `--log-file` supersedes this: a handler installs {@link configureLogFile}
 * instead, capturing every level to the file, including the loggers built at
 * import time (`file-utils`, `cleaning`).
 */
export function configureStderrLogging(): LogSink {
  return installLogSink((line) => {
    try {
      process.stderr.write(line);
    } catch {
      // process.stderr is the only sink here, so a wedged stderr leaves nowhere
      // to report the failure; drop the line rather than let a write error throw
      // back out of a log call into the exchange.
    }
  });
}

/**
 * The logger-and-cleanup pair returned by {@link configureLogging}: the command's
 * logger, built after the sink and level are installed, and a `close` that
 * restores the prior diagnostic sink and releases any file descriptor.
 */
export interface ConfiguredLogging {
  /** The command's logger, created after the sink is installed and the level applied. */
  log: ReturnType<typeof getLogger>;
  /**
   * Write one line to the same destination `log` writes to -- stderr, or the
   * `--log-file` -- with no `[ISO] [LEVEL] [CONTEXT]` prefix, for a rendering a
   * command produces for a person to read (see {@link LogSink.writePlain}).
   * Level filtering is loglevel's, so it does not apply here: a caller that wants
   * its rendering silenced with the logger reads `log.getLevel()` and decides.
   */
  writePlainLine(line: string): void;
  /**
   * Restore the diagnostic sink in place before the redirect and, for the file
   * sink, close the underlying descriptor; best-effort and idempotent. A handler
   * calls this in its `finally`; the error path's `process.exit` bypasses it, but
   * the sink's writes are synchronous and already durable, so nothing is lost.
   */
  close(): void;
}

/**
 * The one logging bootstrap every command handler shares: pick the diagnostic
 * sink ({@link configureLogFile} when `logFile` is given, else the default
 * {@link configureStderrLogging}), apply the resolved `logLevel` across every
 * logger (core's `setLogLevel`), and build the logger named `name`. Returns
 * the logger, a prefix-free writer onto the same destination
 * ({@link ConfiguredLogging.writePlainLine}), and a single `close` that
 * restores the prior sink and releases any file descriptor.
 *
 * Neither the sink nor the level depends on this running before a logger is
 * built: core resolves the sink per log call, and `setLogLevel` sweeps the
 * loggers that already exist as well as setting the default for later ones.
 * That is what applies `--log-level` to the two loggers constructed at
 * import time (`file-utils`, `cleaning`).
 *
 * `logLevel` and `logFile` are resolved by the caller -- through
 * {@link logLevelFlag}, or `parseCommonBootstrapArgs` -- so this helper does
 * no argv parsing. {@link configureLogFile} still throws a {@link UsageError}
 * on an unopenable `--log-file` path, so a caller keeps that mapped to exit 64
 * by invoking this inside its existing usage boundary ({@link parseOrExit}, or
 * a command's `runOrExit`).
 */
export function configureLogging(params: {
  logLevel: logLibrary.LogLevelNumbers;
  logFile: string | undefined;
  name: string;
}): ConfiguredLogging {
  const { logLevel, logFile, name } = params;
  const sink =
    logFile !== undefined
      ? configureLogFile(logFile)
      : configureStderrLogging();
  setLogLevel(logLevel);
  const log = getLogger(name);
  return {
    log,
    writePlainLine: (line: string) => sink.writePlain(line),
    close: () => sink.close(),
  };
}

// Write the whole buffer to `fd`, looping over a partial write. fs.writeSync on a
// regular file normally writes everything in one call, but POSIX permits a short
// write, which would silently truncate a long line (a serialized object) -- so
// drain the remainder rather than trust a single call.
function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length)
    offset += fs.writeSync(fd, buf, offset, buf.length - offset);
}

/**
 * Resolve a CSV input positional to the readable stream core's `loadCSVFile`
 * consumes: `process.stdin` when `input` is `-`, otherwise the file at
 * `input`, opened with `fs.createReadStream` after confirming it exists.
 *
 * Thrown errors hold an `exitCode` for the caller to forward to
 * `process.exit`: a missing file throws with `exitCode: 69`.
 *
 * `allowStdin` gates the `-` case. Every input command supports stdin;
 * `accept` supports it only with `--consent-to-terms`, since otherwise it
 * reads its interactive y/N confirmation from `process.stdin`
 * (`promptConfirm`), and stdin is single-use -- a stdin CSV would starve that
 * prompt into a silent decline. The rejection message is command-agnostic,
 * since the default is `false`.
 *
 * When `-` is allowed but `process.stdin` is an interactive terminal with
 * nothing piped in, reading it would block forever, so that case is rejected
 * up front as a {@link UsageError} naming both alternatives. The check is
 * strict `=== true`: `isTTY` is `undefined` (not `false`) for a pipe, a `<`
 * redirect, or `/dev/null`, so a strict test can never reject a legitimate
 * non-interactive run.
 *
 * The guard covers only an interactive terminal; a non-TTY stream that
 * delivers data but never reaches EOF (an unclosed FIFO, a stalled producer)
 * still blocks -- a visible, interruptible hang, not data loss.
 */
export function openInputSource(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): NodeJS.ReadableStream {
  if (input === "-") {
    if (!allowStdin)
      throw new UsageError(
        "this command cannot read its input CSV from stdin; pass a file path " +
          "instead of `-`",
      );
    if (process.stdin.isTTY === true)
      throw new UsageError(
        "nothing is piped to stdin, so `-` would wait for input forever; pipe " +
          "a CSV (e.g. `cat data.csv | psilink exchange - results.csv`) or pass " +
          "a file path instead of `-`",
      );
    return process.stdin;
  }
  if (!fs.existsSync(input))
    throw Object.assign(new Error(`${input} does not exist`), { exitCode: 69 });
  return fs.createReadStream(input);
}

/**
 * True when stdout (fd 1) is a redirected regular file -- a `> file` shell
 * redirect -- as opposed to a TTY, a pipe, or a character device like
 * `/dev/null`. `fs.fstatSync(1).isFile()` is the distinguishing test:
 * `process.stdout.isTTY` cannot tell a `> file` redirect from a pipe (both
 * report `undefined`). Best-effort: any stat failure yields `false`, since a
 * detection fault must never abort the result write it only annotates.
 */
function stdoutIsRedirectedFile(): boolean {
  try {
    return fs.fstatSync(1).isFile();
  } catch {
    return false;
  }
}

/**
 * Write formatted exchange results to a file or stdout as CSV, resolving once
 * the write is complete. When given an output path, the result CSV -- the
 * most sensitive artifact the tool produces -- is created owner-only (see
 * {@link createOwnerOnlyWriteStream}).
 *
 * `headers` and `rows` arrive as RFC 4180 FIELDS, not as raw values: core's
 * `buildOutputTable` quotes any cell containing a comma, a double quote, CR
 * or LF and doubles that cell's embedded quotes. Both branches join the
 * fields with commas and escape nothing themselves -- a second pass here
 * would double-escape and break the verify path's re-supply. Pinned by the
 * write-then-read round trip in `test/unit/resultCsvEscaping.test.ts`.
 *
 * The file path is owned end to end: the returned promise resolves on the
 * stream's `'close'` (all rows flushed AND the descriptor closed) and rejects
 * on any `'error'`, so a mid-write or close failure (a full disk, a revoked
 * mount) is recoverable rather than crashing with no diagnostic, and the
 * caller can order a later write (the secondary exchange record) after the
 * result file is durable. Resolving on `'close'` rather than `'finish'`
 * matters: a networked or userspace filesystem (NFS/CIFS/FUSE) and a full
 * disk both defer their error to the `close(2)` that follows the last
 * flushed write, arriving after `'finish'` -- which would report a truncated
 * result CSV as written.
 *
 * The stdout branch (no path given) writes to `process.stdout` and resolves
 * immediately. Before it writes, it checks whether stdout is a redirected
 * regular file ({@link stdoutIsRedirectedFile}) and, if so, notifies the
 * operator on `log` at ERROR level (not warn, since a routine
 * `--log-level error` must not hide an operator-actionable data exposure): a
 * `> file` redirect is created by the shell under its umask, not the
 * owner-only permissions an OUTPUT_FILE path gets, so on a shared host the
 * matched records can silently land group/world-readable. Detection is
 * fd-1-local -- a redirect applied outside this process (e.g. across a
 * container boundary) is undetectable, so the absence of the notice is not a
 * guarantee the output is owner-only.
 */
export function writeOutput(
  output: string | undefined,
  headers: string[],
  rows: Array<Array<string>>,
  log: { error: (message: string) => void },
): Promise<void> {
  if (output === undefined) {
    if (stdoutIsRedirectedFile())
      log.error(
        "result written to redirected stdout: the shell created that file " +
          "under its umask, not the owner-only permissions an OUTPUT_FILE path " +
          "gets, so on a shared host the matched records may be " +
          "group/world-readable. Pass an OUTPUT_FILE path argument instead of " +
          "redirecting stdout with `>` to have psilink create the result " +
          "owner-only.",
      );
    process.stdout.write(headers.join(",") + "\n");
    for (const row of rows) process.stdout.write(row.join(",") + "\n");
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    // createOwnerOnlyWriteStream is inside the executor so a synchronous failure
    // (a missing parent dir, the fchmod/icacls refusal) rejects the promise too,
    // rather than throwing past it -- the caller sees one failure channel.
    const out = createOwnerOnlyWriteStream(output);
    out.on("error", reject);
    out.on("close", () => resolve());
    out.write(headers.join(",") + "\n");
    for (const row of rows) out.write(row.join(",") + "\n");
    out.end();
  });
}

// --- Confirmation prompt -----------------------------------------------------

/**
 * The stream a confirmation prompt asks on -- stderr, so stdout stays reserved
 * for a command's result data. {@link promptConfirm} and {@link writePromptLine}
 * both write through this one binding rather than naming `process.stderr`
 * separately, so text a caller must show WITH a prompt cannot land on a different
 * descriptor than the question does.
 */
const promptStream = process.stderr;

/**
 * Write one line where {@link promptConfirm} asks, for text the operator must
 * see whatever the diagnostic sink and level are -- the accept consent
 * surface, which the prompt's own question is answered against. Plain: no
 * log prefix, since this is prompt-adjacent text rather than a diagnostic
 * record (a `--log-file` copy of the same line still holds the prefix).
 *
 * Best-effort: a wedged stream drops the line rather than throwing back into
 * the caller. The drop is not reported, so a run whose prompt stream fails
 * partway through the surface can reach the question having shown only part
 * of it. That is a stated limit, recorded for the operator under acceptance
 * in docs/CLI.md.
 */
export function writePromptLine(line: string): void {
  try {
    promptStream.write(`${line}\n`);
  } catch {
    // Dropped; see the limit above.
  }
}

/**
 * Ask `question` on the prompt stream and resolve to the line the user typed,
 * raw -- neither trimmed nor interpreted, since what a blank or padded answer
 * means belongs to the caller that asked. EOF and a non-interactive stdin
 * both resolve to the empty string, the same "nothing was answered" every
 * caller of {@link promptConfirm} treats as a decline.
 *
 * The one place a question is asked: {@link promptConfirm} is this with a
 * y/N suffix and its answer interpreted, so `process.stdin` is read through
 * one readline interface at a time and every question goes to
 * {@link promptStream} (stderr). stdin is single-use, so a command whose
 * input CSV is `-` must not reach either of them.
 */
export async function promptFreeText(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: promptStream,
  });
  try {
    // `rl.question()` never settles when stdin reaches EOF (a closed or
    // piped-empty stdin) -- a long-standing readline/promises behavior
    // (nodejs/node#53497). Race it against the interface's "close" event
    // (which does fire on EOF) so a closed stdin resolves to the empty
    // answer instead of leaving the promise pending forever.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      void rl.question(`${question} `).then(resolve, () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt the user to confirm on the terminal, returning true only on an
 * explicit yes. Anything else (including EOF or a non-interactive stdin)
 * defaults to no. Prompts on stderr so stdout stays reserved for exchange
 * results.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  const normalized = (await promptFreeText(`${question} [y/N]`))
    .trim()
    .toLowerCase();
  return normalized === "y" || normalized === "yes";
}
