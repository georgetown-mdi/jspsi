import logLibrary from "loglevel";

import { redactPrivateKeyMaterial } from "./sanitizeErrorForDisplay";

const { getLevel } = logLibrary;

const PREFIXED = Symbol("prefixed");

const logLevels = logLibrary.levels;

/**
 * A sink an application installs (via {@link setDiagnosticSink}) to take
 * over where prefixed loggers send their diagnostic output -- the CLI routes
 * it to stderr, or to a `--log-file`. It receives the loglevel method name
 * (so a sink may route by level), the assembled `[ISO] [LEVEL] [CONTEXT]`
 * prefix, and the message arguments -- unformatted, and with private-key
 * blocks stripped out of the string ones (see {@link setLogPrefixer});
 * the sink owns formatting (e.g. Node's `util.format`), which keeps core
 * free of any runtime-specific formatting or stream API and so safe to
 * import in the browser. Left unset -- the default -- diagnostic output
 * keeps loglevel's per-level `console` routing, the behavior the web app
 * relies on (the browser console's per-level styling has meaning) and the
 * reason this policy is injected by the consumer rather than hard-coded here.
 */
export type DiagnosticSink = (
  methodName: logLibrary.LogLevelNames,
  prefix: string,
  args: unknown[],
) => void;

// The process-wide sink, resolved by every prefixed logger at EMIT time
// (see setLogPrefixer). A module-level variable rather than a per-logger
// binding, because loglevel freezes a logger's method to the factory live
// at its creation, so a creation-time mechanism cannot reroute a logger
// that already exists. Resolving here, per call, reroutes every logger --
// including the ones built at import time before a command installs its
// sink -- the moment the sink changes.
let diagnosticSink: DiagnosticSink | undefined;

/**
 * Install (or, with `undefined`, clear) the process-wide {@link DiagnosticSink}
 * every prefixed logger consults at emit time. Because it is resolved per log
 * call, installing it takes effect for loggers that already exist as well as ones
 * created later -- the property the CLI's stderr / `--log-file` routing needs,
 * since some loggers are constructed at import time before a command runs. An app
 * that never calls this keeps the default `console` routing untouched (the web
 * app's case). Pair with {@link getDiagnosticSink} to snapshot and restore the
 * previous sink around a scoped redirect.
 */
export const setDiagnosticSink = (sink: DiagnosticSink | undefined): void => {
  diagnosticSink = sink;
};

/**
 * The currently installed {@link DiagnosticSink}, or `undefined` when diagnostic
 * output uses the default `console` routing. Lets a caller save the prior sink
 * before installing its own and restore it afterward.
 */
export const getDiagnosticSink = (): DiagnosticSink | undefined =>
  diagnosticSink;

/**
 * Apply `level` as the diagnostic log level for EVERY logger -- one that
 * already exists and one built later. The level counterpart of {@link
 * setDiagnosticSink}: an application's logging bootstrap (the CLI's
 * `configureLogging`) resolves the operator's requested level and installs
 * it here, so a `silent` run stays silent and a `debug` run stays detailed
 * no matter when a logger was constructed.
 *
 * The registry sweep is what reaches backward: `setDefaultLevel` alone
 * governs only the root logger and loggers built after it, so a
 * module-scope logger materialized at import time -- before any flag is
 * parsed -- would keep loglevel's `warn` default for the whole run. Setting
 * each existing logger's level explicitly closes that gap; `setDefaultLevel`
 * still applies the level to loggers created later. The registry is
 * enumerated with `Reflect.ownKeys`, not `Object.values`, because this
 * module's logger names are `string | symbol` (see
 * {@link getLoggerForVerbosity}) and a symbol-named logger is invisible to
 * string enumeration. Each sweep assignment passes `persist: false` so a
 * browser consumer's level is not written to web storage behind its back.
 *
 * A known limit: in a browser consumer where the operator has persisted a
 * root level, loglevel skips a persisted root, so it keeps that level and
 * the loggers {@link getLoggerForVerbosity} builds afterward floor against
 * it rather than against `level`. The registry sweep still reaches every
 * logger that already exists. A persisted per-logger key has the same
 * effect one level down: a logger built after the sweep whose name holds
 * a persisted level comes up at that level rather than the swept default.
 *
 * Call this at bootstrap, before any per-logger level is chosen: it overwrites
 * the level of every logger that exists, including one
 * {@link getLoggerForVerbosity} has already floored to a `-v` verbosity. Setting
 * a level also rebuilds that logger's methods from its own factory (loglevel
 * installs `noop` for the disabled ones), so a reference captured to a logger's
 * method beforehand -- a test spy, a destructured `log.warn` -- is stale
 * afterwards; call the method off the logger instead.
 */
export const setLogLevel = (level: logLibrary.LogLevelNumbers): void => {
  logLibrary.setDefaultLevel(level);
  const registry = logLibrary.getLoggers() as Record<
    string | symbol,
    logLibrary.Logger
  >;
  for (const name of Reflect.ownKeys(registry))
    registry[name].setLevel(level, false);
};

export const getLoggerForVerbosity = (
  name: string | symbol,
  verbosity: number,
) => {
  const preferredLogLevel =
    verbosity >= 2
      ? logLevels.TRACE
      : verbosity === 1
        ? logLevels.DEBUG
        : verbosity < 0
          ? logLevels.WARN
          : logLevels.INFO;

  const result = logLibrary.getLogger(name);
  const currentLevel = getLevel();

  result.setLevel(
    // lower number levels include more information
    preferredLogLevel >= currentLevel ? preferredLogLevel : currentLevel,
    false,
  );

  setLogPrefixer(result);

  return result;
};

export const getLogger = (name: string | symbol) => {
  const result = logLibrary.getLogger(name);

  setLogPrefixer(result);

  return result;
};

const setLogPrefixer = (logger: logLibrary.Logger) => {
  if ((logger as unknown as Record<symbol, boolean>)[PREFIXED]) return;
  (logger as unknown as Record<symbol, boolean>)[PREFIXED] = true;
  const originalFactory = logger.methodFactory;
  logger.methodFactory = (
    methodName: logLibrary.LogLevelNames,
    level: logLibrary.LogLevelNumbers,
    loggerName: string | symbol,
  ) => {
    const rawMethod = originalFactory(methodName, level, loggerName);

    return (...messageArgs) => {
      const timestamp = new Date().toISOString();
      const levelLabel = methodName.toUpperCase();
      const context = String(loggerName || "root");

      const prefix = `[${timestamp}] [${levelLabel}] [${context}]`;

      // Redact private-key material from every diagnostic line here rather
      // than in a consumer's sink, so it covers both routings below: the
      // CLI's stderr and --log-file, and the browser console the web app
      // keeps. A line logged before a consumer installs its sink takes the
      // rawMethod branch, which a sink-side pass would miss entirely.
      //
      // Per ARGUMENT, and only where the argument is a string: the sink
      // receives raw `unknown[]` and owns its own formatting, so an object
      // argument is passed through by reference and prints exactly as it would
      // without this. The per-argument boundary is also the reach limit --
      // key material split across two arguments of one call is not seen
      // here, just as the per-link pass does not see one split across two
      // cause-chain links. Joining the arguments first would close that gap,
      // at the cost of letting a dangling marker in one argument consume every
      // argument behind it -- the suppression this pass must not introduce.
      const redactedArgs = messageArgs.map((arg) =>
        typeof arg === "string" ? redactPrivateKeyMaterial(arg) : arg,
      );

      // Resolve the sink at CALL time, not at logger-creation time. rawMethod was
      // frozen to the console leaf when this logger was built; reading the sink
      // here instead lets a consumer installed later (the CLI, after some loggers
      // already exist) capture this logger's output too. With no sink installed
      // -- the web app, or the CLI before setup -- fall through to rawMethod, so
      // the default per-level console routing is exactly as before.
      const sink = diagnosticSink;
      if (sink !== undefined) {
        sink(methodName, prefix, redactedArgs);
      } else {
        rawMethod(prefix, ...redactedArgs);
      }
    };
  };

  // A level assignment that changes no level, made for its side effect: loglevel
  // rebuilds the logger's methods through the factory installed above. It passes
  // `persist: false` because loglevel's default would write the level to web
  // storage, so the first prefixed logger built after a sweep would leave the
  // swept level in a browser consumer's storage for its next session.
  logger.setLevel(logger.getLevel(), false);
};
