import logLibrary from 'loglevel';

const { getLevel, getLogger } = logLibrary

const logLevels = logLibrary.levels;

export const getLoggerForVerbosity = (
  name: string | symbol,
  verbose: number
) => {
  const preferredLogLevel =
    verbose >= 2
    ? logLevels.DEBUG
    : (verbose === 1 ? logLevels.INFO : logLevels.WARN);
  
  const result = getLogger(name);
  const currentLevel = getLevel();

  result.setLevel(
    // lower number levels include more information
    preferredLogLevel >= currentLevel ? preferredLogLevel : currentLevel,
    false
  );

  setLogPrefixer(result)

  return result;
}

export const setLogPrefixer = (logger: logLibrary.Logger) => {
  const originalFactory = logger.methodFactory;
  logger.methodFactory = (
    methodName: logLibrary.LogLevelNames,
    level: logLibrary.LogLevelNumbers,
    loggerName: string | symbol
  ) => {
    const rawMethod = originalFactory(methodName, level, loggerName);

    return (...messageArgs) => {
      const timestamp = new Date().toISOString();
      const level = methodName.toUpperCase();
      const context = String(loggerName || 'root');

      // This creates the [TIMESTAMP] [LEVEL] [CONTEXT] prefix
      rawMethod(`[${timestamp}] [${level}] [${context}]`, ...messageArgs);
    };
  }

  logger.setLevel(logger.getLevel())
}
