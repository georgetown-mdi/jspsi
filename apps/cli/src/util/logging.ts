// Where diagnostics go and at what level: resolving --log-level, installing the
// stderr or --log-file sink, and the one bootstrap a command handler calls to
// get a logger with both applied.

import fs from "node:fs";
import util from "node:util";

import logLibrary from "loglevel";
import type { Arguments } from "yargs";

import {
  getDiagnosticSink,
  getLogger,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  setLogLevel,
  UsageError,
} from "@psilink/core";

import { stripExtendedAcls } from "../fileUtils";
import { singleValue } from "./flags";

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
 * logger does not exist yet wraps the call in `parseOrExit` (./flags);
 * `parseCommonBootstrapArgs` lets it propagate, since a parse function that
 * exits the process cannot be composed or tested; and a command already
 * inside `runOrExit` (./exit) lets it reach that handler.
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
   * `--log-file` capturing it, the difference from `writePromptLine`
   * (./prompt).
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
 * (`promptConfirm` in ./prompt) already writes to stderr for the same
 * reason.
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
 * by invoking this inside its existing usage boundary (`parseOrExit` in
 * ./flags, or a command's `runOrExit`).
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
