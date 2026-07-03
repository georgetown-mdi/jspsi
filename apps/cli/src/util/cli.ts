import fs from "node:fs";
import util from "node:util";
import readline from "node:readline/promises";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";

import {
  getDiagnosticSink,
  getLogger,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  UsageError,
} from "@psilink/core";

import { createOwnerOnlyWriteStream } from "../fileUtils";
import { parseDurationFlag, parseFineDurationFlag } from "./duration";

/**
 * Read a single-value CLI option from parsed yargs `Arguments`, rejecting a flag
 * that was given more than once. yargs collects a repeated option into an array
 * (e.g. `--accept-timeout 60 --accept-timeout 120` -> `[60, 120]`); for a
 * single-value (string or number) option that is a usage error, so throw a
 * {@link UsageError} -- which the command error boundaries map to exit 64 --
 * naming the flag, before the array can reach arithmetic, a comparison, or a
 * string method (`.toLowerCase()`, `.trim()`) as if it were a scalar. Guarding at
 * the read means a newly added single-value option inherits the rejection by
 * using this accessor rather than each bare `argv[name]` cast re-implementing it.
 *
 * Returns the value unchanged for the caller to cast to the option's declared
 * type (`undefined` when the flag was absent). `type: "count"` and
 * `type: "boolean"` options are not read through here: a repeat is valid for them
 * (yargs accumulates a count and takes last-one-wins / negation for a boolean),
 * so they keep their plain `argv[name]` cast.
 */
export function singleValue(argv: Arguments, name: string): unknown {
  const value = argv[name];
  if (Array.isArray(value))
    throw new UsageError(`--${name} may be given only once`);
  return value;
}

/**
 * Sanity ceiling, in seconds, for the duration-valued CLI timeout flags
 * (`--connection-timeout`, `--peer-timeout`, `--accept-timeout`): seven days. A
 * timeout is a coordination window, and even a generous async setup waits hours,
 * not days, for a connection, a peer, or a partner to accept -- so a value past a
 * week is a typo or a misunderstanding, not an intent. The human-readable
 * `<int><unit>` duration syntax makes a value like `30d` trivially typeable, so
 * each capped flag rejects an over-ceiling value with a flag-named usage error
 * before any side effect, mirroring the `--expires-in` ceiling
 * (`MAX_INVITATION_LIFETIME_SECONDS`, 365d) that bounds the invitation lifetime.
 * This is a deliberately lower, product-level sanity bound layered on top of
 * parseDuration's safe-integer overflow guard, not a replacement for it, and a
 * usability cap rather than a security control: the accept window is
 * independently bounded by the invitation token's lifetime, and an over-long
 * connect/peer wait only makes the user's own exchange hang longer.
 */
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

/**
 * Read a duration-valued CLI option from parsed `Arguments` and return it as a
 * whole number of seconds (or `undefined` when the flag is absent). Rejects a
 * repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseDurationFlag}), naming the flag in either error. When `maxSeconds`
 * is given, a value above it is rejected with a flag-named usage error stating
 * the maximum -- the shared parsing seam for the timeout-flag sanity cap (see
 * {@link MAX_TIMEOUT_SECONDS}). The cap is checked after parsing, so it layers on
 * top of the malformed/zero/overflow rejections rather than replacing them.
 *
 * {@link parseDurationFlag} yields a positive millisecond offset whose smallest
 * unit is seconds, so the divide-by-1000 to seconds is always exact. Seconds is
 * the unit the migrated timeout flags' downstream consumers take:
 * `applyConnectionOverrides` scales `connection-timeout`/`peer-timeout` to ms,
 * and `--accept-timeout` compares against a seconds-valued invitation lifetime.
 */
export function durationFlagSeconds(
  argv: Arguments,
  name: string,
  maxSeconds?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // singleValue returns unknown; the flags routed here are declared type:"string"
  // so yargs always yields a string, but coerce defensively so a contract
  // violation surfaces as parseDurationFlag's flag-named UsageError rather than a
  // raw TypeError from .trim() on a non-string.
  const seconds = parseDurationFlag(`--${name}`, String(raw)) / 1000;
  // The sanity cap is the last check: parseDurationFlag has already rejected a
  // zero, malformed, bare-integer, or overflowing value, so a value reaching here
  // is a positive in-range duration and the only thing left to reject is one that
  // is well-formed but past the product ceiling. The ceiling is stated in whole
  // days, the coarsest unit these magnitudes warrant; callers pass a whole-day
  // cap (MAX_TIMEOUT_SECONDS).
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
 * it returns the parser's millisecond offset directly instead of dividing to
 * seconds (which would floor a sub-second value to zero).
 *
 * The sole caller is `--polling-frequency`, whose downstream consumer -- the
 * connection's `pollIntervalMs` / the runtime `pollingFrequency` -- is itself in
 * milliseconds, so no scaling is applied. It takes no product ceiling: unlike the
 * timeout flags (a coordination window that a week-plus value is a mistake for),
 * a large poll interval is merely slow, and the schema field (`pollIntervalMs`)
 * imposes no maximum either; {@link parseFineDurationFlag} still rejects a value
 * large enough to overflow a safe integer.
 *
 * A repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseFineDurationFlag}) are rejected with a flag-named {@link UsageError}
 * (exit 64), exactly as {@link durationFlagSeconds} rejects them.
 */
export function durationFlagMs(
  argv: Arguments,
  name: string,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // singleValue returns unknown; the flag routed here is declared type:"string"
  // so yargs always yields a string, but coerce defensively so a contract
  // violation surfaces as parseFineDurationFlag's flag-named UsageError rather
  // than a raw TypeError from .trim() on a non-string (mirroring durationFlagSeconds).
  return parseFineDurationFlag(`--${name}`, String(raw));
}

/**
 * Read a count-valued CLI option (a nonnegative whole number) from parsed
 * `Arguments` and return it as a number (or `undefined` when the flag is
 * absent). Rejects a repeat (via {@link singleValue}) and any value that is not
 * a nonnegative safe integer -- a negative, a fraction, a non-numeric token, or
 * a magnitude past `Number.MAX_SAFE_INTEGER` -- with a flag-named
 * {@link UsageError} (exit 64), before the value reaches the connection options.
 *
 * This is the count-flag analogue of {@link durationFlagSeconds}: yargs
 * `type: "number"` coerces a non-numeric value to `NaN` and applies no integer,
 * sign, or range constraint, so a bare `argv[name] as number` would let
 * `--max-reconnect-attempts -1`, `2.5`, or `abc` through to be caught only later
 * and as a runtime fault rather than a usage error. `Number.isSafeInteger`
 * mirrors the schema's `z.int().nonnegative()` on the same field
 * (`maxReconnectAttempts`) -- `z.int()` likewise rejects a non-integer, `NaN`,
 * and a value outside the safe-integer range -- so the CLI boundary and the
 * merged-options re-validation agree, and the operator gets a flag-named message
 * instead of a raw schema-error dump. `NaN` (the non-numeric case) is a `number`,
 * so it falls to the `isSafeInteger` check; the `typeof` guard is purely
 * defensive, for a future caller (or a test) that passes a non-number.
 *
 * `maxValue`, when given, is an inclusive upper sanity ceiling layered on top of
 * the type/sign/range rejection -- the count-flag counterpart of
 * {@link durationFlagSeconds}'s `maxSeconds`. The caller passes the schema's own
 * ceiling (`MAX_RECONNECT_ATTEMPTS`) so the parse guard and the schema `.max()`
 * agree at the boundary, not just below it; an over-ceiling value is rejected
 * with the same flag-named {@link UsageError} (exit 64). The message states a bare
 * count with no time unit: the value is a count of attempts, not a duration, even
 * though `MAX_RECONNECT_ATTEMPTS` is itself derived from a wall-clock quantity
 * (see its definition in `@psilink/core`). Omit `maxValue` for a flag with no
 * product ceiling, where the safe-integer range is the only bound.
 *
 * Route only non-secret count flags through this helper: a rejected value is
 * echoed verbatim in the usage error (`got <value>`), and
 * {@link sanitizeErrorForDisplay} redacts PEM key blocks, not a bare token, so a
 * secret-valued flag would leak into stderr and any log. The sole caller today
 * (`--max-reconnect-attempts`) is a non-secret tuning count.
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
 * Run a pre-logger parse step, mapping a {@link UsageError} it throws to a clean
 * stderr message and exit 64. A bootstrap-style command resolves its log level
 * and reads every option before the logger exists, so a usage error there (a
 * repeated single-value flag, an unrecognized `--log-level`) cannot be routed
 * through the logger; this is the one place that boundary lives, so the
 * stderr-and-exit-64 behavior cannot drift between commands. Any other error
 * propagates unchanged, with its stack intact, to the top-level handler rather
 * than being flattened to a bare exit. `process.exit` is typed `never`, so this
 * returns the parsed value on the success path.
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
 * Log a caught error (sanitized) at error level and exit the process with
 * `code`. The single log-and-exit boundary the bootstrap-style command handlers
 * route a caught error through, so the error-level routing and the sanitized
 * formatting cannot drift between call sites. `code` is supplied by the caller
 * because the classification is site-specific: a {@link UsageError} is 64, a
 * transport failure 69, a missing input file its own `exitCode`. Typed `never`
 * so a caller's definite-assignment narrowing treats it like `process.exit`.
 */
export function exitWithError(
  log: { error: (message: string) => void },
  err: unknown,
  code: number,
): never {
  log.error(sanitizeErrorForDisplay(err));
  process.exit(code);
}

/** Mapping from log-level name to loglevel numeric constant. */
export const LOG_LEVELS: Record<string, logLibrary.LogLevelNumbers> = {
  silent: logLibrary.levels.SILENT,
  error: logLibrary.levels.ERROR,
  warn: logLibrary.levels.WARN,
  info: logLibrary.levels.INFO,
  debug: logLibrary.levels.DEBUG,
  trace: logLibrary.levels.TRACE,
};

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
}

/**
 * Install `writeLine` as core's process-wide {@link DiagnosticSink}, returning a
 * {@link LogSink} that restores the prior sink (and runs `onClose`, if given) on
 * close. This is the shared seam behind both CLI sinks -- the
 * {@link configureLogFile} file redirect and the default
 * {@link configureStderrLogging} stderr routing.
 *
 * core resolves the diagnostic sink at each log CALL (not when a logger is
 * built), so unlike a loglevel `methodFactory` swap this reroutes every logger --
 * including the ones core and the CLI construct at import time (`cleaning`,
 * `file-utils`) before a command runs -- the moment it is installed, with no
 * creation-order constraint. core's `setLogPrefixer` hands the sink the assembled
 * `[ISO] [LEVEL] [CONTEXT]` prefix and the raw message arguments; `util.format`
 * renders them into one line exactly as `console.log` would, and `writeLine`
 * appends the newline and delivers it. The `methodName` is unused here -- both CLI
 * sinks route every level uniformly -- and level filtering happens upstream in
 * loglevel (it installs `noop` for methods below the active level), so
 * `--log-level silent` never reaches `writeLine`.
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
 * the terminal, returning a {@link LogSink} the caller closes after the exchange.
 * Omitting the flag leaves logging on the terminal untouched -- a handler only
 * calls this when `--log-file` was given.
 *
 * The redirect is core's process-wide {@link DiagnosticSink} (installed via
 * {@link installLogSink}), which core resolves at each log CALL: the file sink
 * writes the assembled `[ISO] [LEVEL] [CONTEXT]` line to the descriptor rather
 * than the console. Because the sink is call-resolved, it captures EVERY logger
 * regardless of when the logger was built -- including the two constructed at
 * import time (`file-utils`, `cleaning`), which a creation-time `methodFactory`
 * swap could not reach, so `--log-file` now captures their warnings too.
 *
 * Writes are synchronous (`fs.writeSync` to the open descriptor), not buffered
 * through a `WriteStream`. This is deliberate: a handler reports its final error
 * with `log.error(...)` immediately before `process.exit`, which would abandon a
 * stream's unflushed buffer -- losing exactly the diagnostic an unattended
 * operator opened the file to capture. A synchronous write is durable before the
 * call returns, so `process.exit` cannot truncate it. It also matches how Node's
 * `console` writes to a file descriptor, the `> file` redirection this replaces.
 *
 * Level filtering is unaffected: loglevel installs `noop` for methods below the
 * active level and calls the sink only for enabled ones, so `--log-level silent`
 * writes nothing to the file.
 *
 * {@link LogSink.close} restores the prior sink and then closes the descriptor.
 * Restoring the sink first detaches the file sink from every logger at once, so a
 * log emitted after `close()` (a later handler invocation in a shared-process
 * test) routes to the restored sink or the default console -- never to the closed
 * descriptor. The write path still guards a failed `fs.writeSync` (a full disk)
 * and surfaces it on stderr rather than throwing back into the log call.
 *
 * The file is opened synchronously (`openSync` with `"a"`) so a missing parent
 * directory or other open failure surfaces here, as a {@link UsageError} before
 * any exchange work begins, and created owner-only (`0o600`). The path is an
 * operator-supplied flag value, not attacker-derived, so the open deliberately
 * does not apply the `O_NOFOLLOW`/`O_EXCL` hardening psilink's credential writers
 * use for paths it derives itself.
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
    // begins, and opens the descriptor with O_APPEND so each writeSync lands at
    // the current end of file. The 0o600 mode creates the file owner-only, since
    // a debug/trace log can hold partner identity, linkage keys, and data
    // categories -- the owner-only convention psilink applies to its other
    // sensitive artifacts (see writeFileOwnerOnly, docs/SECURITY_DESIGN.md
    // "Required permissions"), rather than inheriting a world-readable umask
    // default. The mode applies only when the file is created, so an operator who
    // points --log-file at an existing file keeps that file's permissions; a
    // restrictive umask can only tighten the new file further, never widen it.
    fd = fs.openSync(normalized, "a", 0o600);
  } catch (err) {
    throw new UsageError(
      `could not open log file ${normalized}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // The install/restore is bracketed by installLogSink; it does not
  // retro-redirect loggers that already exist (see the limitation above).
  return installLogSink(
    (line) => {
      try {
        writeAll(fd, line);
      } catch (err) {
        // loglevel is redirected into this descriptor, so a mid-run write failure
        // (e.g. the disk filling) cannot be reported through the logger, and must
        // not throw out of a log call into the exchange; surface it on the
        // original stderr and continue. The stderr write is itself guarded: if it
        // too fails (a wedged stderr), give up silently rather than let that throw
        // back into the log call this catch exists to protect.
        try {
          process.stderr.write(
            `log file ${normalized} write error: ` +
              (err instanceof Error ? err.message : String(err)) +
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
 * Route ALL loglevel diagnostic output to stderr, returning a {@link LogSink} the
 * caller closes when the command ends. This is the CLI's default logging sink,
 * installed whenever `--log-file` is NOT given, and it reserves stdout
 * exclusively for a command's result data -- the exchange result CSV
 * ({@link writeOutput}'s stdout branch), the invitation token, the `fingerprint`
 * summary -- so a piped or redirected result is never corrupted by an interleaved
 * diagnostic line.
 *
 * Without it, loglevel's default routing sends `info`/`debug` to `console.info` /
 * `console.log` (stdout) and only `warn`/`error` to stderr, so
 * `psilink accept ... > out.csv` would splice the invitation-terms display, the
 * "wrote key file" line, the runtime banner, and the `--consent-to-terms` note
 * into out.csv. This sink sends every level -- `trace`/`debug`/`info` as well as
 * `warn`/`error` -- to `process.stderr`, so `psilink <cmd> 2>/dev/null` yields
 * clean result data on stdout while the same run without the redirect still shows
 * the diagnostics on stderr. The interactive confirmation prompt
 * ({@link promptConfirm}) already writes to stderr for the same reason.
 *
 * `--log-file` supersedes this: a handler installs {@link configureLogFile}
 * instead, so when a log file is requested every level is captured to the file.
 * Because core resolves the diagnostic sink per log call, this routing covers even
 * the loggers built at import time (`file-utils`, `cleaning`) -- a
 * creation-time mechanism would have left their output on the default console --
 * so no diagnostic reaches stdout regardless of when its logger was created.
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
 * {@link configureStderrLogging}), apply the resolved `logLevel`, and build the
 * logger named `name` -- in that order, because core's sink must be installed and
 * the level set before {@link getLogger} constructs the logger that inherits
 * them. Returns the logger plus a single `close` that restores the prior sink and
 * releases any file descriptor, so a handler installs and tears down its logging
 * through one call rather than repeating the sink/level/getLogger/close sequence.
 *
 * `logLevel` and `logFile` are resolved by the caller -- through
 * {@link LOG_LEVELS} inline, or `parseCommonBootstrapArgs` -- so this helper does
 * no argv parsing and neither reads nor validates flags. It composes the two sink
 * builders without changing them: {@link configureLogFile} still throws a
 * {@link UsageError} on an unopenable `--log-file` path, so a caller keeps that
 * mapped to exit 64 by invoking this inside its existing usage boundary
 * ({@link parseOrExit}, or a command's `runOrExit`).
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
  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger(name);
  return { log, close: () => sink.close() };
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
 * consumes: `process.stdin` when `input` is `-`, otherwise the file at `input`,
 * opened with `fs.createReadStream` after confirming it exists. The pipeline is
 * already stream-based, so the loaders feed the returned stream to `loadCSVFile`
 * unchanged whether it is a file or stdin -- papaparse consumes either.
 *
 * Thrown errors carry an `exitCode` for the caller to forward to `process.exit`:
 * a missing file throws with `exitCode: 69`, exactly as before.
 *
 * `allowStdin` gates the `-` case. Every input command supports stdin; `accept`
 * supports it only with `--consent-to-terms`, because otherwise it reads its
 * interactive y/N confirmation from `process.stdin` (`promptConfirm`) and stdin is
 * single-use, so a stdin CSV would starve that prompt into a silent decline. So
 * `accept` passes `allowStdin: false` on the prompting path -- turning `-` into an
 * actionable {@link UsageError} (exit 64) that names the file-path alternative
 * rather than returning a stream, a usage violation distinct from the missing-file
 * case below (exit 69, the input named cannot be opened) -- and `allowStdin: true`
 * once `--consent-to-terms` has skipped the prompt that owns stdin. The rejection
 * message is command-agnostic because the default is `false`, so a future caller
 * inherits a rejection that does not misattribute itself to `accept`.
 *
 * When `-` is allowed but `process.stdin` is an interactive terminal with nothing
 * piped in, reading it would block on an EOF that never arrives -- the parser
 * resolves only at end-of-stream and the read precedes every connection/exchange
 * timeout, so the command would hang indefinitely with no feedback. That case is
 * always a mistake (no one hand-types a PII CSV at a prompt), so it is rejected up
 * front as a {@link UsageError} naming both escape hatches. The check is strict
 * `=== true`: `isTTY` is `undefined` (not `false`) for a pipe, a `<` redirect, or
 * `/dev/null`, so a strict test can never reject a legitimate non-interactive run;
 * a false negative (an effectively-interactive stream that reports falsy) merely
 * falls through to the read, no worse than blocking-until-Ctrl-D.
 *
 * The guard covers only an interactive terminal. A non-TTY stream that delivers
 * data but never reaches EOF -- an unclosed FIFO, a stalled producer -- is not
 * detectable by an `isTTY` check and still blocks (papaparse resolves only at
 * end-of-stream); only an idle watchdog could bound that, which the normal
 * `cat file |` / `< file` usage does not warrant. It is a visible, interruptible
 * hang on an exotic invocation, not data loss.
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
 * `process.stdout.isTTY` alone cannot tell a `> file` redirect from a pipe (it
 * is `undefined` for both), and only the redirect leaves an operator-owned
 * regular file behind, so the pipe must not be flagged. Best-effort: any stat
 * failure (a closed or exotic fd 1) yields `false` so a detection fault can never
 * abort the result write it only annotates.
 */
function stdoutIsRedirectedFile(): boolean {
  try {
    return fs.fstatSync(1).isFile();
  } catch {
    return false;
  }
}

/**
 * Write formatted exchange results to a file or stdout as CSV, resolving once the
 * write is complete. When given an output path, the result CSV -- the most
 * sensitive artifact the tool produces -- is created owner-only (see
 * {@link createOwnerOnlyWriteStream}) so it does not inherit a world/group-readable
 * umask default.
 *
 * The file path is owned end to end: the returned promise resolves on the
 * stream's `'finish'` (all rows flushed) and rejects on any `'error'`. Awaiting it
 * is what makes a mid-write or close failure (a full disk, a revoked mount)
 * recoverable -- without an `'error'` listener that failure would be emitted on a
 * listener-free stream and crash the process with no diagnostic; rejecting instead
 * lets the caller's error boundary map it to a non-zero exit with a sanitized
 * message, and the `'finish'` resolution lets the caller order a later write (the
 * secondary exchange record) after the result file is durable.
 *
 * The stdout branch (no path given) writes to `process.stdout` -- a long-lived
 * stream the CLI neither owns nor closes, whose write errors stay with Node's
 * default stdout handling -- and resolves immediately. Before it writes, it checks
 * whether stdout is a redirected regular file ({@link stdoutIsRedirectedFile}) and,
 * if so, notifies the operator on `log`: a `> file` redirect is created by the
 * shell under its umask, NOT the owner-only permissions an OUTPUT_FILE path gets
 * via {@link createOwnerOnlyWriteStream} (`0600` on Unix, an owner-only ACL on
 * Windows), so on a shared host the matched records -- the most sensitive artifact
 * -- can silently land group/world-readable. It is emitted at ERROR level, not
 * warn: this is an operator-actionable exposure of sensitive data, so a routine
 * `--log-level error` (which suppresses `warn`) must not hide it -- the same
 * error-level-for-a-must-stay-visible-advisory choice the exchange recovery hint
 * in `protocol.ts` makes. It still goes through `log`, so it lands on stderr under
 * the default sink and is captured by `--log-file`, but never on stdout, so it
 * cannot corrupt the result CSV. A pipe, a TTY, or `/dev/null` does not fire --
 * only a redirect that leaves an under-permissioned file behind. Detection is
 * fd-1-local: a redirect applied outside this process -- e.g. on the host across a
 * container boundary, where this process's fd 1 is a pipe to the runtime -- is
 * undetectable and does not fire, so the absence of the notice is not a guarantee
 * the output is owner-only.
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
    out.on("finish", () => resolve());
    out.write(headers.join(",") + "\n");
    for (const row of rows) out.write(row.join(",") + "\n");
    out.end();
  });
}

// --- Confirmation prompt -----------------------------------------------------

/**
 * Prompt the user to confirm on the terminal, returning true only on an
 * explicit yes. Anything else (including EOF or a non-interactive stdin)
 * defaults to no. Prompts on stderr so stdout stays reserved for exchange
 * results.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    // `rl.question()` never settles when stdin reaches EOF (a closed or
    // piped-empty stdin) -- a long-standing readline/promises behavior
    // (nodejs/node#53497). Race it against the interface's "close" event (which
    // does fire on EOF) so a closed stdin deterministically resolves to "no"
    // instead of leaving the promise pending -- which today exits silently via
    // event-loop drain and would deadlock outright if any handle were open here.
    const answer = await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      void rl.question(`${question} [y/N] `).then(resolve, () => resolve(""));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
