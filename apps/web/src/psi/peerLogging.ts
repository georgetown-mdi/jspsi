/**
 * PeerJS console-logging policy for the web app: how high the PeerJS `debug`
 * level is raised when diagnosing, and a redacting `logFunction` that keeps the
 * secret-derived rendezvous peer ids out of the console even at raised verbosity.
 *
 * Background: PeerJS interpolates the remote peer id into its warning-level logs
 * (e.g. `You received a malformed message from <peerId>`), and in this app those
 * ids are rendezvous addresses derived from the invitation secret -- the app
 * deliberately keeps them out of its default logs (see `psi/rendezvous.ts` and
 * `core/rendezvous.ts`). So raising PeerJS verbosity for diagnosis must not
 * reintroduce them. The split here is: {@link resolvePeerDebugLevel} decides
 * *when* verbosity is raised; {@link createRedactingLogFunction} decides *whether*
 * raised verbosity is allowed to print an id -- it is not.
 */

/**
 * PeerJS debug levels, mirroring peerjs's internal `LogLevel` enum: 0 disabled,
 * 1 errors only, 2 errors + warnings, 3 everything. PeerJS gates each message
 * against the configured level *before* handing it to the `logFunction`, so the
 * level is what actually opens the warning/log paths to the redactor below.
 */
export const PEERJS_ERRORS_ONLY = 1;
const PEERJS_ALL = 3;

/**
 * Resolve the PeerJS `debug` level for a session. Off (no diagnostic toggle),
 * the configured base is used unchanged -- the errors-only default that keeps
 * PeerJS warnings, and thus the interpolated peer ids, suppressed. On, the level
 * is raised to PeerJS's most verbose so the protocol-anomaly paths that today
 * only log at warning level become visible; this is safe because every line then
 * routes through {@link createRedactingLogFunction}, which strips the ids.
 *
 * Never lowers below the configured base, so an operator who raised the base via
 * config does not lose verbosity when the toggle is off.
 */
export function resolvePeerDebugLevel(
  baseLevel: number,
  diagnostic: boolean,
): number {
  return diagnostic ? Math.max(baseLevel, PEERJS_ALL) : baseLevel;
}

/** Console-shaped sink the redacting log function writes to; injectable so a
 * unit test can capture what would reach the real console. */
export type LogSink = Pick<Console, "log" | "warn" | "error">;

const REDACTED = "[redacted-peer-id]";

/** Replace every occurrence of each sensitive id in `text`. Plain substring
 * replacement, not a regex, so an id containing no regex metacharacters (hex
 * does not, but this stays correct regardless) is matched literally. */
function redactString(text: string, ids: ReadonlyArray<string>): string {
  let out = text;
  for (const id of ids) {
    if (id) out = out.split(id).join(REDACTED);
  }
  return out;
}

/**
 * Redact sensitive ids out of one log argument, recursing into arrays and plain
 * objects so an id buried in a structured PeerJS message (e.g. the `message`
 * object some warnings log) is stripped too, not just top-level strings. Numbers,
 * booleans, null, and undefined cannot carry an id and pass through untouched.
 * `seen` guards against a cyclic object spinning the recursion forever; the
 * caller passes a fresh set per top-level argument (see createRedactingLogFunction).
 */
function redactValue(
  value: unknown,
  ids: ReadonlyArray<string>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactString(value, ids);
  // Collapse an Error to "(Name) message" the way PeerJS's own default printer
  // does, but redact the message first: the message can interpolate a peer id,
  // and a raw Error object would otherwise slip that id past redaction.
  if (value instanceof Error)
    return `(${value.name}) ${redactString(value.message, ids)}`;
  if (typeof value !== "object" || value === null) return value;
  // A cyclic back-reference: return a placeholder, never the original object --
  // returning the original would leak its unredacted ids straight to the sink.
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, ids, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = redactValue(item, ids, seen);
  return out;
}

/**
 * Build a PeerJS `logFunction` that redacts the given rendezvous peer `ids` from
 * every message before printing it, then routes to the console method matching
 * PeerJS's own level mapping (3 -> log, 2 -> warn, 1 -> error). Installing this
 * on the `Peer` is what makes raised verbosity safe: the level gate may open the
 * warning paths, but no derived id survives to the sink.
 *
 * @param ids   The session's derived rendezvous ids (local and remote); any of
 *              these appearing in a message is replaced before printing.
 * @param sink  Where redacted output goes; defaults to the real `console`.
 */
export function createRedactingLogFunction(
  ids: ReadonlyArray<string>,
  sink: LogSink = console,
): (logLevel: number, ...rest: Array<unknown>) => void {
  return (logLevel, ...rest) => {
    // A fresh cycle-guard per argument: one shared across sibling arguments would
    // return the same object unredacted the second time it appeared (already in
    // the set), so an id in a repeated argument would escape.
    const redacted = rest.map((arg) =>
      redactValue(arg, ids, new WeakSet<object>()),
    );
    // Mirrors PeerJS's own level mapping. A logLevel of 0 (Disabled) is
    // intentionally a no-op: PeerJS gates messages against the level before
    // calling a logFunction, so it never dispatches at 0, and dropping a
    // disabled-level message is the correct response if it ever did.
    if (logLevel >= 3) sink.log("PeerJS:", ...redacted);
    else if (logLevel >= 2) sink.warn("PeerJS WARNING:", ...redacted);
    else if (logLevel >= 1) sink.error("PeerJS ERROR:", ...redacted);
  };
}
