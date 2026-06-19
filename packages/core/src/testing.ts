import logLibrary from "loglevel";

/** Suppresses log output below `minLevel` for the duration of `fn`; restores the previous level when done. */
export function withSuppressedLogs<T>(
  fn: () => Promise<T>,
  minLevel?: number,
): Promise<T>;
export function withSuppressedLogs<T>(fn: () => T, minLevel?: number): T;
export function withSuppressedLogs<T>(
  fn: () => T | Promise<T>,
  minLevel: number = logLibrary.levels.ERROR,
): unknown {
  const original = logLibrary.getLevel();
  logLibrary.setLevel(minLevel as Parameters<typeof logLibrary.setLevel>[0]);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => logLibrary.setLevel(original));
    }
    logLibrary.setLevel(original);
    return result;
  } catch (e) {
    logLibrary.setLevel(original);
    throw e;
  }
}

/** @internal */
export type LogEntry = { level: string; message: string };

const captures: Array<{
  filter: (level: string) => boolean;
  logs: LogEntry[];
}> = [];
let interceptorInstalled = false;

/** Installs the loglevel `methodFactory` interceptor that backs `withCapturedLogs`,
 * idempotently. `withCapturedLogs` calls this on its first use, so a standalone
 * caller never needs it; call it eagerly from test setup -- before any named logger
 * is constructed -- to close the creation-order gap noted on `withCapturedLogs`.
 * loglevel binds a logger's methods from the factory live at `getLogger` time, so a
 * named logger built before the interceptor exists never routes through capture;
 * installing here first makes every later-created logger bind to capture regardless
 * of creation order. */
export function installCapturedLogsInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;
  // Snapshot the current factory here, not at module load, so any third-party
  // wrappers installed before the interceptor is materialized are included.
  const rootFactory = logLibrary.methodFactory;
  logLibrary.methodFactory = (methodName, level, loggerName) => {
    const original = rootFactory(methodName, level, loggerName);
    return (...args: unknown[]) => {
      const levelName = methodName.toUpperCase();
      const message = args.join(" ");
      // Suppress from normal output only when every active capture claims this
      // message; if any capture's filter does not match, the message passes through
      // so that concurrent captures cannot affect each other's observable output.
      let allMatch = captures.length > 0;
      for (const entry of captures) {
        if (entry.filter(levelName)) {
          entry.logs.push({ level: levelName, message });
        } else {
          allMatch = false;
        }
      }
      if (!allMatch) original(...args);
    };
  };
  logLibrary.setLevel(logLibrary.getLevel());
}

/** Intercepts log output during `fn` and returns it alongside the function result.
 * By default only `WARN` messages are captured; pass `levelFilter` to change which
 * levels are collected. A message is suppressed from normal output only when every
 * concurrent capture's filter claims it; otherwise it passes through unchanged, so
 * concurrent calls do not affect each other's observable output.
 * If `fn` rejects, captured logs are discarded and the rejection propagates.
 * Limitations: messages below loglevel's current threshold are never delivered to
 * `methodFactory` (loglevel assigns `noop` directly) and will not be captured; a
 * named logger created before the interceptor is installed binds to the pre-install
 * factory and bypasses capture -- call `installCapturedLogsInterceptor` from test
 * setup, ahead of any logger, to close that creation-order gap (the CLI integration
 * suite does, so its loggers are captured regardless of creation order). */
export function withCapturedLogs<T>(
  fn: () => Promise<T>,
  levelFilter?: (level: string) => boolean,
): Promise<[T, LogEntry[]]>;
export function withCapturedLogs<T>(
  fn: () => T,
  levelFilter?: (level: string) => boolean,
): [T, LogEntry[]];
export function withCapturedLogs<T>(
  fn: () => T | Promise<T>,
  levelFilter?: (level: string) => boolean,
): [T, LogEntry[]] | Promise<[T, LogEntry[]]> {
  installCapturedLogsInterceptor();
  const logs: LogEntry[] = [];
  const entry = {
    filter: levelFilter ?? ((level: string) => level === "WARN"),
    logs,
  };
  captures.push(entry);

  const cleanup = () => {
    const idx = captures.indexOf(entry);
    if (idx !== -1) captures.splice(idx, 1);
  };

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then((r): [T, LogEntry[]] => [r, logs]).finally(cleanup);
    }
    cleanup();
    return [result, logs];
  } catch (e) {
    cleanup();
    throw e;
  }
}
