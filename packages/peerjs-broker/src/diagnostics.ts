import {
  displayText,
  redactAndSanitizeForDisplay,
  sanitizeForDisplay,
} from "@psilink/core/untrusted-text";

import type { Displayable } from "@psilink/core/untrusted-text";
import type { EventEmitter } from "node:events";

// Every source the sink recognizes. The type below is derived from it rather
// than written beside it, so a source added to one cannot fall through the other
// and read as `unattributed`, and the attribution below can match a raise
// against the same list the type admits.
const SIGNALING_DIAGNOSTIC_SOURCES = [
  "unanswered-upgrade",
  "released-socket",
  "client-socket",
  "client-frame",
  "frame-dispatch",
  "signaling-server",
  "unattributed",
] as const;

/**
 * What raised a diagnostic on the signaling server's `error` event. The server
 * releases a socket down several paths that look alike once the `Error` is all
 * that survives -- a peer that reset mid-release reads much like a `ws` frame
 * fault -- so each raise site names itself, and an operator reading the log can
 * tell an upgrade nobody answered from an error the release window's watch
 * caught on a socket a co-resident listener had already adopted.
 *
 * - `unanswered-upgrade`: an upgrade this server declined for a co-resident
 *   `upgrade` listener, which no listener answered before the release bound, so
 *   this server destroyed it. It means the premise that something else adopts a
 *   declined upgrade no longer holds in this wiring.
 * - `released-socket`: an error on a declined upgrade inside the release window
 *   -- the stretch in which the socket is nobody's, or has just been adopted --
 *   which the window's watch caught and released. An ordinary peer hang-up
 *   arrives here.
 * - `client-socket`: an error on a socket this server accepted and serves.
 * - `client-frame`: a frame from a registered client that did not parse, or that
 *   parsed to something the client id cannot be stamped onto. This is the
 *   peer-controlled one: the parser's message quotes the bytes it choked on, and
 *   a peer can loop it.
 * - `frame-dispatch`: a fault raised while dispatching a frame that DID parse to
 *   this server's own `message` listeners -- the relay and whatever an embedding
 *   host attached. It is a fault in this server's own handling, so it is kept
 *   apart from `client-frame`: read as a parse failure it would send an
 *   operator looking for a peer sending garbage. Its detail can still carry a
 *   bounded, sink-escaped fragment of a peer's payload: dispatch-side, Node's
 *   own errors echo an offending value into their message (a numeric payload
 *   verbatim, an object as "an instance of Object"), bounded by what JSON
 *   parses a scalar into; drain-side, reconstituting a held frame can instead
 *   raise a V8 SyntaxError quoting roughly 30 characters of the server's own
 *   serialization of that payload. Either shape is capped and escaped like
 *   every other diagnostic at the sink.
 * - `signaling-server`: an error the `ws` server itself raised.
 * - `unattributed`: a diagnostic raised on the `error` event naming none of the
 *   above. `emit` is untyped, so the source is whatever the raise passed --
 *   absent, another type entirely, or a string this sink does not know -- and
 *   every one of those renders here rather than being dropped.
 */
export type SignalingDiagnosticSource =
  (typeof SIGNALING_DIAGNOSTIC_SOURCES)[number];

/**
 * Window the diagnostics budget is measured over. Long enough that a peer
 * looping parse failures buys nothing by pacing itself, short enough that an
 * operator watching a broker that has started shedding sees it recover a minute
 * after the flood stops -- a minute of the wall clock, which is what the window
 * is measured against, so a clock stepped backwards holds the window open until
 * the clock has caught back up and the shedding lasts the step as well.
 */
export const DIAGNOSTIC_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Diagnostics written per {@link DIAGNOSTIC_RATE_LIMIT_WINDOW_MS}. Sized for the
 * operator's question -- is this broker refusing what is dialed at it, or is
 * nothing dialing? -- which a handful of attributed lines a minute answers. A
 * peer that can raise thousands a second gets the same handful, and the
 * shedding is itself reported so the log never reads as quiet.
 */
export const DIAGNOSTICS_PER_RATE_LIMIT_WINDOW = 10;

/**
 * Cap on the escaped detail one diagnostic carries. With the budget above it is
 * what bounds this sink's write volume: at most
 * {@link DIAGNOSTICS_PER_RATE_LIMIT_WINDOW} lines of roughly this size per
 * window, plus the two fixed-length rate-limit notices. It bounds the ESCAPED
 * output rather than the raw text, so a detail of nothing but escape-expanding
 * bytes is held to the same size.
 */
export const DIAGNOSTIC_DETAIL_MAX_LENGTH = 256;

/**
 * Where a signaling diagnostic goes once this module has attributed, escaped,
 * capped and rate limited it. Injected by whoever builds the server rather than
 * resolved here, so this package holds no logging policy of its own: the web
 * app's mount hands it a prefixed `@psilink/core` logger, and the standalone
 * runner a stderr writer, each unconditionally. Every report is a warning, so
 * the sink takes no level.
 *
 * The text it receives is already safe to write: peer-controlled bytes reach it
 * escaped and capped, and nothing further is expected of the sink but writing
 * what it is handed.
 */
export type SignalingDiagnosticSink = (message: Displayable) => void;

/** Read whatever was raised as text, without letting a hostile or malformed
 * error take the diagnostic down with it: a `message` getter or a `toString`
 * that throws is what this is defensive against, since the value reaching here
 * came off a socket rather than out of this server. */
function readErrorText(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string")
      return error.message;
    return String(error);
  } catch {
    return "[unreadable error]";
  }
}

/** The attribution a raise renders under. `emit` is untyped, so what arrives as
 * the source is whatever a raise site passed -- a source of another type, or a
 * string naming nothing this sink knows, is the unattributed arm rather than a
 * diagnostic dropped for being unrecognizable. Resolving it against the known
 * list here is also what keeps the source a first-party literal everywhere below,
 * the per-source counts included. */
function attributionOf(source: unknown): SignalingDiagnosticSource {
  return (
    SIGNALING_DIAGNOSTIC_SOURCES.find((known) => known === source) ??
    "unattributed"
  );
}

/** The shed counts as display text: `source: count` per source, in the order the
 * window first shed each. Composed from this module's own source tags and the
 * counts it kept, so nothing a peer chose is composed into a notice -- which is
 * why the counts are kept against the resolved attribution rather than the raw
 * source. */
function describeShedBySource(
  shedBySource: ReadonlyMap<SignalingDiagnosticSource, number>,
): Displayable {
  let composed = displayText``;
  for (const [source, count] of shedBySource) {
    const entry = displayText`${sanitizeForDisplay(source)}: ${count}`;
    composed = composed === "" ? entry : displayText`${composed}, ${entry}`;
  }
  return composed;
}

/**
 * A rate-limited writer for one signaling server's diagnostics. Per instance
 * rather than per module so two brokers in one process do not share a budget,
 * and so a test gets a fresh one.
 *
 * The budget is shared across the sources rather than split among them, so a
 * peer looping parse failures can spend the whole of it on `client-frame` and
 * leave an `unanswered-upgrade` in the same window shed. Which sources lost
 * reports is therefore named in both notices: an operator who cannot see the
 * alarm still sees which alarm it was.
 *
 * The window is lazy -- computed from the clock when a diagnostic arrives, not
 * held open by a timer -- so the sink adds no handle to a process whose whole
 * point is to sit idle between rendezvous. A clock that steps backwards leaves
 * the current window running longer, which sheds more rather than less.
 */
function createSignalingDiagnosticsReporter(
  write: SignalingDiagnosticSink,
): (source: unknown, error: unknown) => void {
  let windowStartedAt = Date.now();
  let writtenInWindow = 0;
  let shedInWindow = 0;
  let shedBySource = new Map<SignalingDiagnosticSource, number>();

  return (rawSource, error) => {
    const source = attributionOf(rawSource);
    const now = Date.now();

    if (now - windowStartedAt >= DIAGNOSTIC_RATE_LIMIT_WINDOW_MS) {
      const shed = shedInWindow;
      const shedDetail = describeShedBySource(shedBySource);
      windowStartedAt = now;
      writtenInWindow = 0;
      shedInWindow = 0;
      shedBySource = new Map();
      // The count lands on the window that follows the shedding rather than at
      // the moment the window turned over, which would need a timer. A flood
      // that stops and is never followed by another diagnostic leaves its final
      // count unwritten; the notice below has already told the operator that
      // shedding began, so the fact survives, but the total and the identity
      // of any class starved after that notice are both lost with it.
      if (shed > 0)
        write(
          displayText`peerjs signaling diagnostics resumed: ${shed} suppressed while rate limited (${shedDetail})`,
        );
    }

    if (writtenInWindow >= DIAGNOSTICS_PER_RATE_LIMIT_WINDOW) {
      shedInWindow += 1;
      shedBySource.set(source, (shedBySource.get(source) ?? 0) + 1);
      // One notice per window, written as the budget runs out, so the shedding
      // itself cannot become the flood. It names the source of the report the
      // budget ran out on; the rest of the window's breakdown rides the resumed
      // notice above.
      if (shedInWindow === 1)
        write(
          displayText`peerjs signaling diagnostics rate limited: ${DIAGNOSTICS_PER_RATE_LIMIT_WINDOW} written in the last ${DIAGNOSTIC_RATE_LIMIT_WINDOW_MS / 1000} seconds, suppressing the rest of this window; suppressed so far (${describeShedBySource(shedBySource)})`,
        );
      return;
    }

    writtenInWindow += 1;
    // Escaped here, at the sink, which is the one altitude that escapes
    // (CONTRIBUTING.md, Operator-facing escaping): a parse failure quotes the
    // peer's own bytes, so CR/LF that would forge a second log line, the ESC
    // that drives ANSI sequences, and bidi overrides all reach this call raw.
    const detail = redactAndSanitizeForDisplay(readErrorText(error), {
      maxLength: DIAGNOSTIC_DETAIL_MAX_LENGTH,
    });
    // The source is escaped alongside it -- it is resolved to a first-party tag
    // above, and escaping it costs nothing -- and the peer's detail is placed
    // last, so no byte of it can be read as one of the fields ahead of it.
    write(
      displayText`peerjs signaling diagnostic [${sanitizeForDisplay(source)}]: ${detail}`,
    );
  };
}

/**
 * Attach the diagnostics sink to a signaling server's `error` event, writing
 * every report through `write`.
 *
 * Attaching a listener is critical on its own: an `error` emitted with no
 * listener at all is thrown rather than dropped, which would end the process
 * over an ordinary peer hang-up. So the listener's first duty is to absorb the
 * event, and it holds that whatever `write` does -- one that throws is
 * swallowed here rather than allowed back out through `emit`.
 */
export function attachSignalingDiagnostics(
  server: EventEmitter,
  write: SignalingDiagnosticSink,
): void {
  const report = createSignalingDiagnosticsReporter(write);
  server.on("error", (error: unknown, source: unknown) => {
    try {
      report(source, error);
    } catch {
      // Absorbing the event is the listener's contract; a sink that fails must
      // not convert a released socket into a process exit.
    }
  });
}
