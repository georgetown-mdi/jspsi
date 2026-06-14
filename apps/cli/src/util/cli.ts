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

/**
 * Redirect every loglevel message to `logFilePath` (append mode) instead of the
 * terminal, returning the {@link fs.WriteStream} so the caller can close it after
 * the exchange. Omitting the flag leaves logging on the terminal untouched -- a
 * handler only calls this when `--log-file` was given.
 *
 * loglevel has no built-in file sink, so this installs one by overriding the
 * library's global `methodFactory` -- the factory every named logger inherits at
 * construction (loglevel's `getLogger` does `new Logger(name,
 * defaultLogger.methodFactory)`). The installed factory returns a function that
 * writes its formatted arguments to the stream rather than calling
 * `console[method]`. core's `setLogPrefixer` wraps this leaf factory per logger,
 * so each line keeps its `[ISO] [LEVEL] [CONTEXT]` prefix: the prefixer passes
 * that prefix as the first argument to the function returned here, and
 * `util.format` renders it ahead of the message exactly as `console.log` would.
 * Unlike `setLogPrefixer`, this factory does not chain to the previous factory:
 * the file sink replaces console output rather than decorating it, so there is
 * no prior return value to forward.
 *
 * Level filtering is unaffected: loglevel installs `noop` for methods below the
 * active level and calls `methodFactory` only for enabled ones, so
 * `--log-level silent` writes nothing to the file.
 *
 * A logger captures the global factory at CREATION, so this must run before the
 * loggers whose output should land in the file exist -- the handlers call it
 * before `setDefaultLevel` and `getLogger`. The two loggers created at import
 * time (`file-utils`, `cleaning`) predate any handler and are therefore not
 * redirected; this is the same limitation core's `withCapturedLogs` documents
 * for child loggers created before it installs its interceptor.
 *
 * The file is opened synchronously (`openSync` with `"a"`) so a missing parent
 * directory or other open failure surfaces here, as a {@link UsageError} before
 * any exchange work begins, rather than as an asynchronous stream `'error'`
 * mid-run.
 */
export function configureLogFile(logFilePath: string): fs.WriteStream {
  // Windows paths are accepted: fold backslashes to forward slashes on ingestion
  // (the CLAUDE.local.md Windows-path convention) before the path reaches the
  // filesystem call, so a backslash or UNC form opens the intended file.
  const normalized = logFilePath.replace(/\\/g, "/");

  let fd: number;
  try {
    // "a" creates-or-appends and throws synchronously (ENOENT) when the parent
    // directory is absent, so the failure is reported before the stream -- and
    // any exchange work -- begins, not as an async 'error' event later.
    fd = fs.openSync(normalized, "a");
  } catch (err) {
    throw new UsageError(
      `could not open log file ${normalized}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const stream = fs.createWriteStream(normalized, { fd, flags: "a" });
  // loglevel is redirected into this same stream, so a mid-run write failure
  // (e.g. the disk filling) cannot be reported through the logger; surface it on
  // the original stderr so an unhandled 'error' event does not crash the process.
  stream.on("error", (err) => {
    process.stderr.write(
      `log file ${normalized} write error: ${err.message}\n`,
    );
  });

  // The factory ignores its (methodName, level, loggerName) arguments: the level
  // is already encoded in the prefix setLogPrefixer prepends, and level filtering
  // is handled by loglevel before the factory is consulted.
  logLibrary.methodFactory = () => {
    return (...args: unknown[]) => {
      stream.write(util.format(...args) + "\n");
    };
  };

  return stream;
}

/**
 * Validate that `input` is a readable file path; throws on failure.
 * Thrown errors carry an `exitCode` property for the caller to forward to
 * `process.exit`. Stdin (`-`) throws with `exitCode: 1`; a missing file
 * throws with `exitCode: 69`.
 */
export function validateInputFile(input: string): void {
  if (input === "-")
    throw Object.assign(
      new Error("reading from stdin is not yet implemented"),
      { exitCode: 69 },
    );
  if (!fs.existsSync(input))
    throw Object.assign(new Error(`${input} does not exist`), { exitCode: 69 });
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
