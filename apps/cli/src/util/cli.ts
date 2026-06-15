import fs from "node:fs";
import util from "node:util";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";

import { sanitizeErrorForDisplay, UsageError } from "@psilink/core";

import { parseDurationFlag } from "./duration";

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
 * Read a duration-valued CLI option from parsed `Arguments` and return it as a
 * whole number of seconds (or `undefined` when the flag is absent). Rejects a
 * repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseDurationFlag}), naming the flag in either error.
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
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // singleValue returns unknown; the flags routed here are declared type:"string"
  // so yargs always yields a string, but coerce defensively so a contract
  // violation surfaces as parseDurationFlag's flag-named UsageError rather than a
  // raw TypeError from .trim() on a non-string.
  return parseDurationFlag(`--${name}`, String(raw)) / 1000;
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

/** A redirect of loglevel output to a file, returned by {@link configureLogFile}. */
export interface LogFileSink {
  /**
   * Restore the loglevel factory in place before the redirect and close the
   * underlying file descriptor; best-effort and idempotent.
   */
  close(): void;
}

/**
 * Redirect every loglevel message to `logFilePath` (append mode) instead of the
 * terminal, returning a {@link LogFileSink} the caller closes after the exchange.
 * Omitting the flag leaves logging on the terminal untouched -- a handler only
 * calls this when `--log-file` was given.
 *
 * loglevel has no built-in file sink, so this installs one by overriding the
 * library's global `methodFactory` -- the factory every named logger inherits at
 * construction (loglevel's `getLogger` does `new Logger(name,
 * defaultLogger.methodFactory)`). The installed factory returns a function that
 * writes its formatted arguments to the file rather than calling
 * `console[method]`. core's `setLogPrefixer` wraps this leaf factory per logger,
 * so each line keeps its `[ISO] [LEVEL] [CONTEXT]` prefix: the prefixer passes
 * that prefix as the first argument to the function returned here, and
 * `util.format` renders it ahead of the message exactly as `console.log` would.
 * Unlike `setLogPrefixer`, this factory does not chain to the previous factory:
 * the file sink replaces console output rather than decorating it, so there is
 * no prior return value to forward.
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
 * active level and calls `methodFactory` only for enabled ones, so
 * `--log-level silent` writes nothing to the file.
 *
 * A logger binds its method to a factory at CREATION (and only rebuilds on its
 * own `setLevel`), so this must run before the loggers whose output should land
 * in the file exist -- the handlers call it before `setDefaultLevel` and
 * `getLogger`. A logger that already exists is NOT redirected, and `rebuild()`
 * cannot help: it re-runs each logger's own captured factory rather than
 * reassigning it. In a fresh CLI process this affects only the two loggers
 * created at import time (`file-utils`, `cleaning`) -- the same limitation core's
 * `withCapturedLogs` documents -- so their occasional warnings reach the
 * terminal. The other case is a logger cached from a PRIOR handler invocation in
 * the same process, which only arises in shared-process tests, never in the
 * one-command-per-process CLI; {@link LogFileSink.close} restoring the prior
 * factory keeps that case from leaving the global seam pointed at a closed
 * descriptor for whatever runs next. The converse also holds: a logger created
 * WHILE the redirect is active holds the file descriptor in its captured method
 * and must not be used after `close()` -- a write would hit the closed fd (caught
 * and surfaced on stderr, never thrown). The one-command-per-process CLI exits
 * right after `close()`, so this is a constraint only for shared-process tests.
 *
 * The file is opened synchronously (`openSync` with `"a"`) so a missing parent
 * directory or other open failure surfaces here, as a {@link UsageError} before
 * any exchange work begins, and created owner-only (`0o600`). The path is an
 * operator-supplied flag value, not attacker-derived, so the open deliberately
 * does not apply the `O_NOFOLLOW`/`O_EXCL` hardening psilink's credential writers
 * use for paths it derives itself.
 */
export function configureLogFile(logFilePath: string): LogFileSink {
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

  // Capture the factory we are replacing so close() can restore it, leaving the
  // global seam as it was found. The install/restore is bracketed; it does not
  // retro-redirect loggers that already exist (see the limitation above).
  const previousFactory = logLibrary.methodFactory;

  // The factory ignores its (methodName, level, loggerName) arguments: the level
  // is already encoded in the prefix setLogPrefixer prepends, and level filtering
  // is handled by loglevel before the factory is consulted.
  logLibrary.methodFactory = () => {
    return (...args: unknown[]) => {
      try {
        writeAll(fd, util.format(...args) + "\n");
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
    };
  };

  return {
    close(): void {
      // Restore the prior factory first, so a logger created after close() (e.g.
      // a later handler invocation in a shared-process test) binds to the
      // original sink rather than this closed descriptor; then release the fd.
      // Both steps are idempotent: a redundant restore is a no-op and a double
      // close throws EBADF, which is swallowed.
      logLibrary.methodFactory = previousFactory;
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort: the descriptor may already be closed.
      }
    },
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
 * consumes: `process.stdin` when `input` is `-`, otherwise the file at `input`,
 * opened with `fs.createReadStream` after confirming it exists. The pipeline is
 * already stream-based, so the loaders feed the returned stream to `loadCSVFile`
 * unchanged whether it is a file or stdin -- papaparse consumes either.
 *
 * Thrown errors carry an `exitCode` for the caller to forward to `process.exit`:
 * a missing file throws with `exitCode: 69`, exactly as before.
 *
 * `allowStdin` gates the `-` case. Every input command supports stdin except
 * `accept`, which reads its interactive y/N confirmation from `process.stdin`
 * (`promptConfirm`); stdin is single-use, so a stdin CSV would starve that prompt
 * into a silent decline. `accept` passes `allowStdin: false`, turning `-` into an
 * actionable {@link UsageError} (exit 64) that names the file-path alternative
 * rather than returning a stream -- a usage violation, distinct from the
 * missing-file case below (exit 69, the input named cannot be opened). The
 * message is command-agnostic because the default is `false`, so a future caller
 * inherits a rejection that does not misattribute itself to `accept`. (Re-enable
 * for `accept` once it gains a non-interactive confirmation bypass -- board item
 * 200218548.)
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

/** Write formatted exchange results to a file or stdout as CSV. */
export function writeOutput(
  output: string | undefined,
  headers: string[],
  rows: Array<Array<string>>,
): void {
  const out = output
    ? fs.createWriteStream(output, { encoding: "utf8" })
    : process.stdout;
  out.write(headers.join(",") + "\n");
  for (const row of rows) out.write(row.join(",") + "\n");
  if (output) (out as fs.WriteStream).close();
}
