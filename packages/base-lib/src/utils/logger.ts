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

  return result;
}
