import {
  displayText,
  getLogger,
  redactAndSanitizeForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import type { EventEmitter } from "node:events";

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
 * - `client-frame`: a frame from a registered client that did not parse. This
 *   is the peer-controlled one: the parser's message quotes the bytes it choked
 *   on, and a peer can loop it.
 * - `signaling-server`: an error the `ws` server itself raised.
 * - `unattributed`: a diagnostic raised on the `error` event with no source
 *   named. `emit` is untyped, so this is what an unrecognized raise renders as
 *   rather than being dropped.
 */
export type SignalingDiagnosticSource =
  | "unanswered-upgrade"
  | "released-socket"
  | "client-socket"
  | "client-frame"
  | "signaling-server"
  | "unattributed";

/**
 * Window the diagnostics budget is measured over. Long enough that a peer
 * looping parse failures buys nothing by pacing itself, short enough that an
 * operator watching a broker that has started shedding sees it recover within a
 * minute of the flood stopping.
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

const log = getLogger("peerjs-broker");

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

/**
 * A rate-limited writer for one signaling server's diagnostics. Per instance
 * rather than per module so two brokers in one process do not share a budget,
 * and so a test gets a fresh one.
 *
 * The window is lazy -- computed from the clock when a diagnostic arrives, not
 * held open by a timer -- so the sink adds no handle to a process whose whole
 * point is to sit idle between rendezvous. A clock that steps backwards leaves
 * the current window running longer, which sheds more rather than less.
 */
function createSignalingDiagnosticsReporter(): (
  source: SignalingDiagnosticSource,
  error: unknown,
) => void {
  let windowStartedAt = Date.now();
  let writtenInWindow = 0;
  let shedInWindow = 0;

  return (source, error) => {
    const now = Date.now();

    if (now - windowStartedAt >= DIAGNOSTIC_RATE_LIMIT_WINDOW_MS) {
      const shed = shedInWindow;
      windowStartedAt = now;
      writtenInWindow = 0;
      shedInWindow = 0;
      // The count lands on the window that follows the shedding rather than at
      // the moment the window turned over, which would need a timer. A flood
      // that stops and is never followed by another diagnostic leaves its final
      // count unwritten; the notice below has already told the operator that
      // shedding began, so what is lost is the total, not the fact.
      if (shed > 0)
        log.warn(
          displayText`peerjs signaling diagnostics resumed: ${shed} suppressed while rate limited`,
        );
    }

    if (writtenInWindow >= DIAGNOSTICS_PER_RATE_LIMIT_WINDOW) {
      shedInWindow += 1;
      // One notice per window, written as the budget runs out, so the shedding
      // itself cannot become the flood.
      if (shedInWindow === 1)
        log.warn(
          displayText`peerjs signaling diagnostics rate limited: ${DIAGNOSTICS_PER_RATE_LIMIT_WINDOW} written in the last ${DIAGNOSTIC_RATE_LIMIT_WINDOW_MS / 1000} seconds, suppressing the rest of this window`,
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
    // The source is escaped alongside it -- `emit` is untyped, so what arrives
    // is whatever a raise site passed -- and the peer's detail is placed last,
    // so no byte of it can be read as one of the fields ahead of it.
    log.warn(
      displayText`peerjs signaling diagnostic [${sanitizeForDisplay(source)}]: ${detail}`,
    );
  };
}

/**
 * Attach the diagnostics sink to a signaling server's `error` event.
 *
 * Attaching a listener is load-bearing on its own: an `error` emitted with no
 * listener at all is thrown rather than dropped, which would end the process
 * over an ordinary peer hang-up. So the listener's first duty is to absorb the
 * event, and it holds that whatever the sink does -- a logger that throws is
 * swallowed here rather than allowed back out through `emit`.
 */
export function attachSignalingDiagnostics(server: EventEmitter): void {
  const report = createSignalingDiagnosticsReporter();
  server.on("error", (error: unknown, source?: SignalingDiagnosticSource) => {
    try {
      report(source ?? "unattributed", error);
    } catch {
      // Absorbing the event is the listener's contract; a sink that fails must
      // not convert a released socket into a process exit.
    }
  });
}
