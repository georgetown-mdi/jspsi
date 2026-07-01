import logLibrary from "loglevel";

const { getLevel } = logLibrary;

const PREFIXED = Symbol("prefixed");

const logLevels = logLibrary.levels;

/**
 * A sink an application installs (via {@link setDiagnosticSink}) to take over
 * where prefixed loggers send their diagnostic output -- the CLI routes it to
 * stderr, or to a `--log-file`. It receives the loglevel method name (so a sink
 * may route by level), the assembled `[ISO] [LEVEL] [CONTEXT]` prefix, and the
 * raw message arguments; the sink owns formatting (e.g. Node's `util.format`),
 * which keeps core free of any runtime-specific formatting or stream API and so
 * safe to import in the browser. Left unset -- the default -- diagnostic output
 * keeps loglevel's per-level `console` routing, the behavior the web app relies
 * on (the browser console's per-level styling carries meaning) and the reason
 * this policy is injected by the consumer rather than hard-coded here.
 */
export type DiagnosticSink = (
  methodName: logLibrary.LogLevelNames,
  prefix: string,
  args: unknown[],
) => void;

// The process-wide sink, resolved by every prefixed logger at EMIT time (see
// setLogPrefixer). A module-level variable rather than a per-logger binding is
// deliberate: loglevel freezes a logger's method to the factory live at its
// creation, so a creation-time mechanism cannot reroute a logger that already
// exists. Resolving here, per call, reroutes every logger -- including the ones
// built at import time before a command installs its sink -- the moment the sink
// changes.
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

export const setLogPrefixer = (logger: logLibrary.Logger) => {
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

      // The [TIMESTAMP] [LEVEL] [CONTEXT] prefix.
      const prefix = `[${timestamp}] [${levelLabel}] [${context}]`;

      // Resolve the sink at CALL time, not at logger-creation time. rawMethod was
      // frozen to the console leaf when this logger was built; reading the sink
      // here instead lets a consumer installed later (the CLI, after some loggers
      // already exist) capture this logger's output too. With no sink installed
      // -- the web app, or the CLI before setup -- fall through to rawMethod, so
      // the default per-level console routing is exactly as before.
      const sink = diagnosticSink;
      if (sink !== undefined) {
        sink(methodName, prefix, messageArgs);
      } else {
        rawMethod(prefix, ...messageArgs);
      }
    };
  };

  logger.setLevel(logger.getLevel());
};
