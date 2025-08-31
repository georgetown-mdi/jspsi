import logLibrary from 'loglevel';

export const getLoggerForVerbosity = (
  name: string | symbol,
  verbose: number
) => {
  const preferredLogLevel =
    verbose >= 2
    ? logLibrary.levels.DEBUG
    : (verbose === 1 ? logLibrary.levels.INFO : logLibrary.levels.WARN);
  
  const result = logLibrary.getLogger(name);
  result.setLevel(
    preferredLogLevel >= logLibrary.getLevel()
    ? preferredLogLevel
    : logLibrary.getLevel(),
    false
  );

  return result;
}
