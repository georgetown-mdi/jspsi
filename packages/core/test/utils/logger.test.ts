import { afterEach, beforeEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  getLogger,
  getLoggerForVerbosity,
  setDiagnosticSink,
  setLogLevel,
} from "../../src/utils/logger";

// setLogLevel is the level counterpart of setDiagnosticSink: an app's logging
// bootstrap resolves the operator's requested level and installs it here, and it
// must reach the loggers that already exist as well as the ones built later.
// loglevel's own setDefaultLevel governs only the latter, which is why a
// module-scope logger -- materialized when its module was imported, long before
// any flag was parsed -- kept the library's `warn` default for a whole run.

let emitted: string[];
let originalLevel: number;
let originalLoggerLevels: Array<[string, number]>;

beforeEach(() => {
  emitted = [];
  originalLevel = logLibrary.getLevel();
  originalLoggerLevels = Object.entries(logLibrary.getLoggers()).map(
    ([name, logger]) => [name, logger.getLevel()],
  );
  setDiagnosticSink((_methodName, prefix, args) =>
    emitted.push([prefix, ...args].join(" ")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setDiagnosticSink(undefined);
  logLibrary.setLevel(
    originalLevel as Parameters<typeof logLibrary.setLevel>[0],
  );
  for (const [name, level] of originalLoggerLevels)
    logLibrary
      .getLogger(name)
      .setLevel(level as Parameters<typeof logLibrary.setLevel>[0], false);
});

// Each case names its logger uniquely so one case's level never leaks into the
// next through loglevel's process-wide registry.
let nextLoggerId = 0;
const uniqueName = (prefix: string) => `${prefix}-${nextLoggerId++}`;

test("silences a logger that already existed when the level was set", () => {
  const name = uniqueName("pre-existing");
  const log = getLogger(name);
  log.warn("before the level is applied");
  expect(emitted.join("\n")).toContain("before the level is applied");

  setLogLevel(logLibrary.levels.SILENT);

  emitted.length = 0;
  log.error("must not appear");
  log.warn("nor this");
  expect(emitted).toEqual([]);
});

test("raises a pre-existing logger's detail to debug and trace", () => {
  const name = uniqueName("pre-existing");
  const log = getLogger(name);
  log.debug("dropped at the default level");
  expect(emitted).toEqual([]);

  setLogLevel(logLibrary.levels.DEBUG);
  log.debug("visible at debug");
  expect(emitted.join("\n")).toContain(`[DEBUG] [${name}] visible at debug`);

  setLogLevel(logLibrary.levels.TRACE);
  log.trace("visible at trace");
  expect(emitted.join("\n")).toContain(`[TRACE] [${name}] visible at trace`);
});

test("still applies to a logger created after it", () => {
  setLogLevel(logLibrary.levels.SILENT);
  const log = getLogger(uniqueName("later"));
  log.error("must not appear");
  expect(emitted).toEqual([]);
});

test("keeps the prefixer -- and its private-key redaction -- on the path", () => {
  // The swept level rebuilds each logger's methods from its own factory, which
  // for a prefixed logger is core's prefixer: the assembled prefix and the
  // per-argument private-key strip must survive the sweep, since that pass is the
  // diagnostic log's only key-material redaction sink.
  const name = uniqueName("redacting");
  const log = getLogger(name);
  setLogLevel(logLibrary.levels.INFO);

  log.info(
    "key follows: -----BEGIN PRIVATE KEY-----\nMIGkAgEA\n-----END PRIVATE KEY-----",
  );
  const line = emitted.join("\n");
  expect(line).toContain(`[INFO] [${name}]`);
  expect(line).not.toContain("MIGkAgEA");
});

test("redacts key material on the console path after a sweep", () => {
  // With no sink installed -- the web app, and the CLI before its bootstrap --
  // the prefixer falls through to loglevel's console leaf, which the sweep
  // rebuilds. Redaction has to survive on that branch too: it is the only pass
  // that strips key material from a line bound for the browser console.
  setDiagnosticSink(undefined);
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const name = uniqueName("console-redacting");
  const log = getLogger(name);
  setLogLevel(logLibrary.levels.INFO);

  log.info(
    "key follows: -----BEGIN PRIVATE KEY-----\nMIGkAgEA\n-----END PRIVATE KEY-----",
  );

  const line = consoleInfo.mock.calls.map((args) => args.join(" ")).join("\n");
  expect(line).toContain(`[INFO] [${name}]`);
  expect(line).toContain("[redacted private key]");
  expect(line).not.toContain("MIGkAgEA");
});

test("leaves a browser consumer's stored level untouched", () => {
  // loglevel writes a level to web storage unless the assignment opts out, so
  // every one on this path -- the sweep's, and the one the prefixer makes to
  // rebuild a logger's methods -- must, or a run's level would outlive the page
  // as the operator's persisted preference.
  const storage: Record<string, string> = {};
  vi.stubGlobal("window", { localStorage: storage });

  const name = uniqueName("web");
  logLibrary.getLogger(name);
  setLogLevel(logLibrary.levels.SILENT);

  expect(getLogger(name).getLevel()).toBe(logLibrary.levels.SILENT);
  expect(storage).toEqual({});
});

test("getLoggerForVerbosity keeps its accumulate-and-floor semantics", () => {
  // -v/-vv choose a preferred level and the resolved log level floors it: the
  // quieter of the two wins. So a silenced run stays silent however verbose it
  // asked to be, and a run whose level makes room gets the verbosity it asked
  // for. setLogLevel leaves the root logger's level -- the floor
  // getLoggerForVerbosity reads -- exactly where setDefaultLevel put it, so this
  // is the same table either way.
  setLogLevel(logLibrary.levels.SILENT);
  expect(logLibrary.getLevel()).toBe(logLibrary.levels.SILENT);
  for (const verbosity of [-1, 0, 1, 2])
    expect(
      getLoggerForVerbosity(uniqueName("floored"), verbosity).getLevel(),
    ).toBe(logLibrary.levels.SILENT);

  setLogLevel(logLibrary.levels.TRACE);
  const { WARN, INFO, DEBUG, TRACE } = logLibrary.levels;
  for (const [verbosity, expected] of [
    [-1, WARN],
    [0, INFO],
    [1, DEBUG],
    [2, TRACE],
  ] as const)
    expect(
      getLoggerForVerbosity(uniqueName("verbose"), verbosity).getLevel(),
    ).toBe(expected);
});

// The registry sweep enumerates with Reflect.ownKeys: loglevel admits
// symbol-named loggers (getLoggerForVerbosity takes string | symbol), and a
// string enumeration would leave one at its prior level.
test("the sweep reaches a symbol-named logger", () => {
  const logger = logLibrary.getLogger(Symbol("swept-by-name"));
  logger.setLevel("warn");
  setLogLevel(logLibrary.levels.SILENT);
  expect(logger.getLevel()).toBe(logLibrary.levels.SILENT);
});
