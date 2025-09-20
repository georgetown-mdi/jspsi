import logLibrary from 'loglevel';

const { getLevel, getLogger, levels } = logLibrary;

export const getLoggerForVerbosity = (
  name: string | symbol,
  verbose: number
) => {
  const preferredLogLevel =
    verbose >= 2
    ? levels.DEBUG
    : (verbose === 1 ? levels.INFO : levels.WARN);
  
  const result = getLogger(name);
  result.setLevel(
    preferredLogLevel >= getLevel()
    ? preferredLogLevel
    : getLevel(),
    false
  );

  return result;
}
