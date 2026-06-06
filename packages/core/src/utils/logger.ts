import logLibrary from "loglevel";

const { getLevel } = logLibrary;

const PREFIXED = Symbol("prefixed");

const logLevels = logLibrary.levels;

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
      const level = methodName.toUpperCase();
      const context = String(loggerName || "root");

      // This creates the [TIMESTAMP] [LEVEL] [CONTEXT] prefix
      rawMethod(`[${timestamp}] [${level}] [${context}]`, ...messageArgs);
    };
  };

  logger.setLevel(logger.getLevel());
};
