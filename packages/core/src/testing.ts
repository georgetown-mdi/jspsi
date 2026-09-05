import logLibrary from "loglevel";

import type { AssociationTable } from "./types";

export {
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
  consentRepresentationProbes,
} from "./consent/linkageTermConsentCoverage.js";

export {
  BEL,
  ESC,
  HOSTILE_IDENTITY,
  PRINTABLE_ASCII,
  RLO,
  hostileSource,
  hostileTerms,
  hostileVariants,
} from "./consent/displayEscapingFixtures.js";

// The key-schedule core, so the browser cross-implementation suite can run the
// checked-in known-answer vectors through the browser build the way the Node
// suite runs them through the Node build. It stays out of the main entry point:
// callers conduct a handshake with runKex, never by composing the schedule.
export { computeKexKeys } from "./kex.js";

// The cross-party host-key fingerprint comparison, so each app's test tree can
// hold the warning it composes to that app's own display budget. It stays out
// of the main entry point: runExchange calls it and hands the result to the
// caller, who never composes the notice.
export { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";

// The wire pieces the known-answer vector generators under test/vectors build
// their documents from. Those generators are plain Node scripts, so they read
// the built package rather than this source tree, and each of these encodes or
// decodes one layer of the protocol below what a caller ever composes: a caller
// runs an exchange, not a table encoding or a terms envelope.
export {
  decodeFixedWidthIndexTable,
  decodeInt32LE,
  decodeRaggedIndexTable,
  decodeSinglePassReply,
  encodeInt32LE,
  encodeSinglePassReply,
  getSortedDistinctValueIndices,
  linkViaPSI,
} from "./psi/link.js";
export { FAN_OUT_CANDIDATES_PER_ELEMENT } from "./fanOutFunctions.js";
export { StandardizedKeyIterable } from "./standardization.js";
export {
  PROTOCOL_VERSION,
  TERMS_ENVELOPE_FIELDS,
  exchangeTerms,
  sendAbort,
} from "./protocolSetup.js";

// The framing bytes of the file-sync message envelope, the AEAD envelope's
// version marker, and the terminal-frame drain budget, so a suite can build a
// frame byte for byte and drive a foreign version through the reader. They stay
// out of the main entry point: a caller sends a message and the connection
// frames it.
export {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_HEADER_BYTES,
  MESSAGE_TYPE_BINARY,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
} from "./connection/fileSyncConnection.js";
export { AEAD_ENVELOPE_VERSION } from "./connection/encryptedMessageConnection.js";

// The input bounds a suite drives at their edge: the invitation decode's host,
// path, and whole-token limits, the WebRTC frame pre-scan's per-kind weights,
// and the CSV line ceiling. They stay out of the main entry point: core's own
// parse enforces each, and a caller meets the refusal rather than the number.
export { WEBRTC_VALUE_WEIGHTS } from "./connection/binaryPackBounds.js";
export {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
  MAX_RAW_INVITATION_LENGTH,
} from "./config/invitation.js";
export { CSV_LINE_BYTE_CEILING } from "./file.js";

// The marker a control character is replaced by, and the one the error-chain
// walk appends where the depth bound cut. They stay out of the main entry
// point: sanitizeForDisplay and sanitizeErrorForDisplay write both, and a
// caller reads the rendered text.
export { CAUSE_DEPTH_ELISION_MARKER } from "./utils/sanitizeErrorForDisplay.js";
export { controlCharacterMarker } from "./utils/sanitizeForDisplay.js";

// The lever that stands a listed fan-out producer in for an unlisted one. Both
// published entry points build as one bundle with a shared chunk, so the listing
// this rewrites is the one the main entry's compiled steps read; a build that
// gave each entry its own copy would leave it rewriting a listing nothing reads.
export { withNoListedFanOutFunctions } from "./fanOutFunctions.js";

/** @internal */
export function sortAssociationTable(
  value: AssociationTable,
  reverse?: boolean,
): AssociationTable {
  return reverse
    ? value[1]
        .map((x, i) => ({ x: x, y: value[0][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[1].push(v.x);
            acc[0].push(v.y);
            return acc;
          },
          [[], []] as [Array<number>, Array<number>],
        )
    : value[0]
        .map((x, i) => ({ x: x, y: value[1][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[0].push(v.x);
            acc[1].push(v.y);
            return acc;
          },
          [[], []] as [Array<number>, Array<number>],
        );
}

/** @internal */
export type LogEntry = { level: string; message: string };

const captures: Array<{
  filter: (level: string) => boolean;
  logs: LogEntry[];
}> = [];
let interceptorInstalled = false;

/** Installs the loglevel `methodFactory` interceptor that backs
 * `withCapturedLogs`, idempotently. `withCapturedLogs` calls this on its
 * first use, so a standalone caller needs it only to close the
 * creation-order gap noted on `withCapturedLogs`: call it from test setup
 * before any named logger is constructed. loglevel binds a logger's
 * methods from the factory live at `getLogger` time, so installing here
 * first is what lets a later-created logger bind to capture regardless of
 * creation order. */
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

/** Intercepts log output during `fn` and returns it alongside the function
 * result. By default only `WARN` messages are captured; pass `levelFilter`
 * to change which levels are collected. A message is suppressed from
 * normal output only when every concurrent capture's filter claims it;
 * otherwise it passes through unchanged, so concurrent calls do not affect
 * each other's observable output. If `fn` rejects, captured logs are
 * discarded and the rejection propagates.
 *
 * Limitations: messages below loglevel's current threshold never reach
 * `methodFactory` (loglevel assigns `noop` directly) and are not captured.
 * A `getLoggerForVerbosity` logger never sets a level more verbose than
 * the current root, so a `.debug()` line at `verbose: 1` is captured only
 * once the root itself is raised (e.g. `logLibrary.setLevel("trace")`)
 * before the logger is constructed -- driven in capturedLogs.test.ts. A
 * named logger created before {@link installCapturedLogsInterceptor} runs
 * bypasses capture; call it from test setup, ahead of any logger, to
 * close that gap (the CLI integration suite does). A diagnostic sink
 * installed via `setDiagnosticSink` (the CLI's stderr / `--log-file`
 * routing) is consulted downstream of this interceptor, so while one is
 * active, output routes to it and is not captured here -- do not pair
 * `withCapturedLogs` with a command handler that installs a sink; call the
 * underlying function directly instead, as the integration suite does. */
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
