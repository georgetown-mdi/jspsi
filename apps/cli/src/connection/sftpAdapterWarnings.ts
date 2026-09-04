// The TEXT of the SFTP adapter's operator-facing warnings and typed errors: what
// a killed session, an exhausted reconnection budget, a recovered drop, an idle
// boundary, a declined transition, or an unsettled publish is reported as.
// Every export is a pure builder over its stated inputs -- it holds no adapter
// state, takes no logger and no ledger, and issues no server round trip -- so
// the adapter keeps every latch, every paced-warn call site, and every log call.
//
// Escaping altitude (CONTRIBUTING.md, Code Conventions -- Operator-facing
// escaping): no builder here escapes anything. An error builder takes its
// caller-supplied fragments RAW, handed to a sink that escapes the whole
// rendered chain once. A warning builder takes only first-party text and
// counters, so a fragment reaching one later must already arrive escaped by
// the call site that is its sink.
import {
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UsageError,
} from "@psilink/core";

import { REPORT_LIBRARY_INCOMPATIBILITY } from "./libraryIncompatibility";
import { transportOperationStalledError } from "./sftpLivenessGuard";
import type { SessionTransitionKind } from "./ssh2SftpAdapter";

/**
 * `list()` and `createExclusive()` both run only after `connect()` has already
 * verified the 'sftp' session and every method it drives (see the guard there),
 * so a falsy session at either site means the connection was closed or dropped
 * after that successful connect, never an API change. Shared here so the two
 * throw sites cannot drift apart.
 */
export const SFTP_SESSION_CLOSED_MESSAGE =
  "SFTP session is not open: the connection was closed or dropped after a " +
  "successful connect (typically a server idle or session-time-limit " +
  "policy, or a network drop), so this operation cannot run.";

/**
 * The abandon of a wait that has no benign value to report: a dial cannot report
 * a session it did not establish. Names the bound, and is deliberately distinct
 * from the teardown latch's "already been closed" refusal -- that connection was
 * closed on purpose, whereas this one was never opened.
 *
 * @param kind - The session transition that gave up its wait, from the adapter's
 * own closed set of transition kinds; first-party text, never a server's.
 * @param acquireTimeoutMs - The wait the transition gave up after.
 */
export function transitionWaitExpiredError(
  kind: SessionTransitionKind,
  acquireTimeoutMs: number,
): Error {
  return new Error(
    `this SFTP connection's ${kind} waited ` +
      `${acquireTimeoutMs} ms for the session transition ahead ` +
      `of it and gave up: a dial cannot run alongside another transition on ` +
      `the one shared client, so nothing was dialed. Open a new connection ` +
      `to retry.`,
  );
}

/**
 * The refusal a server-driven operation gets once a fatal SFTP-protocol error
 * has killed the session. A typed {@link TransportOperationStalledError} (a
 * `UsageError`) so the poll loop and the rendezvous gate treat it as terminal,
 * the same as every other liveness bound.
 *
 * The captured error's message is the one fragment of this refusal the SERVER
 * chose, so it is handed over as the server-reported fragment rather than
 * composed into the first-party sentence naming it: on one link those bytes would
 * spend the sentence's budget and could compose framing of their own that read as
 * this side's.
 *
 * @param operation - The operation being refused, first-party.
 * @param path - The remote path it was for, composed RAW: this is an `Error`, so
 * the display sink escapes the whole rendered chain once.
 * @param serverReported - The killed session's captured error message, composed
 * RAW onto its own cause link for the same reason.
 */
export function deadSessionOperationError(
  operation: string,
  path: string,
  serverReported: string,
): TransportOperationStalledError {
  return transportOperationStalledError(
    operation,
    path,
    "the SFTP session was killed by a fatal server protocol error",
    serverReported,
  );
}

/**
 * The terminal error surfaced when the cumulative mid-exchange reconnection
 * budget (max_reconnect_attempts) is exhausted in the default held-session mode.
 * A UsageError so every op path treats it as terminal -- the poll loop stops on a
 * UsageError, and the consume-delete retry rethrows one rather than swallowing it
 * as a transient hiccup -- and so the CLI maps it to a non-zero exit. The message
 * names the partner-server drop, states the exhaustion in the unit the budget
 * spends -- sessions LOST, as the ledger's live tally rather than the configured
 * maximum, so this line and doCleanup's end-of-run summary read the same counter
 * and the terminal loss charged before the throw cannot put them off by one --
 * and gives the two remedies by their operator-reachable names (the flag and the
 * config field); it carries no partner-controlled text. A budget of zero gets its
 * own opening clause: there is no allowance to describe as spent, so it names the
 * first drop terminal instead.
 *
 * @param sessionsLost - The ledger's live tally of sessions lost mid-exchange.
 * @param maxReconnectAttempts - The operative budget those losses spend.
 */
export function midExchangeReconnectBudgetExhaustedError(
  sessionsLost: number,
  maxReconnectAttempts: number,
): UsageError {
  const max = maxReconnectAttempts;
  const lost = sessionsLost;
  const budgetClause =
    max === 0
      ? `max_reconnect_attempts=0 permits no mid-exchange reconnection, so ` +
        `this first drop is terminal and the exchange cannot continue`
      : `the mid-exchange reconnection budget is exhausted: ` +
        `${lost} ${lost === 1 ? "session" : "sessions"} lost over the whole ` +
        `exchange against a max_reconnect_attempts=${max} budget, and every ` +
        `session lost spent one whether its re-dial succeeded, failed, or ` +
        `was refused, so the exchange cannot continue`;
  return new UsageError(
    `The SFTP session dropped mid-exchange and ${budgetClause}. The partner's ` +
      `SFTP server is dropping the held session -- typically a server-enforced ` +
      `session-duration or idle limit you cannot change. Raise ` +
      `max_reconnect_attempts if the link is merely flaky, or switch this ` +
      `connection to connection-per-poll mode (--connection-per-poll, or ` +
      `connection_per_poll: true in the connection options) if the server caps ` +
      `session lifetime: it dials a fresh session each poll cycle instead of ` +
      `holding one for the whole exchange.`,
  );
}

/**
 * How many further mid-exchange re-dials the budget still permits once the
 * losses charged so far have spent it. Read by the held-session recovery line and
 * by the adapter's escalation of the LAST permitted re-dial past the shared warn
 * cadence, so the two cannot disagree about which re-dial was the last.
 */
export function remainingMidExchangeRedials(
  maxReconnectAttempts: number,
  sessionsLost: number,
): number {
  return Math.max(maxReconnectAttempts - sessionsLost, 0);
}

/**
 * The connection-per-poll reading of a transparently-recovered mid-exchange
 * session drop: this mode dials a fresh session per cycle, so the drop is either
 * one within a cycle -- what there is to investigate -- or the rendezvous wait's
 * one held session meeting the partner's cap, which the re-dial simply survives.
 * These re-dials spend no budget, so the line quotes none.
 *
 * @param sessionsLost - The ledger's live tally of sessions lost mid-exchange.
 */
export function sessionRecoveredEphemeralWarning(sessionsLost: number): string {
  const count = sessionsLost;
  return (
    `The SFTP session dropped mid-exchange and was transparently ` +
    `re-dialed (${count} ${count === 1 ? "session" : "sessions"} lost to ` +
    `the partner so far this exchange); the exchange continues. ` +
    "Connection-per-poll dials a fresh session per poll cycle, so this is " +
    "either a drop within a poll cycle -- the link or the partner's server " +
    "faulting mid-cycle, which is what to investigate -- or a rendezvous " +
    "wait, which runs before the poll loop starts cycling and holds one " +
    "session throughout, so the partner's session-lifetime, idle, or " +
    "operation cap cut it. The rendezvous case needs nothing from you: the " +
    "re-dial is this mode working and the exchange survives the cap. These " +
    "re-dials are not charged against max_reconnect_attempts; each " +
    "operation remains bounded by the peer-inactivity timeout " +
    "(peer_timeout_ms), which ends the exchange if they stop it from " +
    "making progress."
  );
}

/**
 * The held-session reading of the same drop. Because that mode holds one session
 * open for the whole exchange the condition keeps recurring regardless of the
 * operator's settings, so the line names the mode switch that is the real fix and
 * states what the budget has left.
 *
 * @param sessionsLost - The ledger's live tally of sessions lost mid-exchange.
 * @param maxReconnectAttempts - The operative budget those losses spend.
 */
export function sessionRecoveredHeldWarning(
  sessionsLost: number,
  maxReconnectAttempts: number,
): string {
  const count = sessionsLost;
  const budget = maxReconnectAttempts;
  const remaining = remainingMidExchangeRedials(budget, count);
  const recovered =
    count === 1
      ? "The SFTP session dropped mid-exchange and was transparently " +
        "re-dialed; the exchange continues."
      : `The SFTP session has now dropped mid-exchange ${count} times ` +
        `this exchange; this drop was transparently re-dialed and the ` +
        `exchange continues.`;
  const budgetLeft =
    remaining === 0
      ? `That was the last re-dial allowed by ` +
        `max_reconnect_attempts=${budget}: the next mid-exchange drop ends ` +
        `the exchange.`
      : `${remaining} further mid-exchange re-dial` +
        `${remaining === 1 ? " is" : "s are"} allowed by ` +
        `max_reconnect_attempts=${budget} before the exchange fails.`;
  return (
    `${recovered} This is typically the partner's SFTP server enforcing a ` +
    `session-duration or idle limit you cannot change. Because the default ` +
    `mode holds one SFTP session open for the whole exchange, it will keep ` +
    `recurring regardless of your settings; --connection-per-poll, which ` +
    `dials a fresh session each poll cycle instead of holding one, is the ` +
    `real fix for that case, and a longer poll interval ` +
    `(--polling-frequency) helps only if the server is instead reacting to ` +
    `how often this exchange queries it. ${budgetLeft}`
  );
}

/**
 * Reported when whether a connection still owes ssh2 its 'close' cannot be
 * read: that state is watched through ssh2's client.on(), not available after
 * connect(), so rather than dial into a window it cannot see, every mid-exchange
 * re-dial closes the connection from this side first and waits for that close.
 * Re-verify the premises per the "Upgrading the SFTP Stack" checklist in
 * docs/spec/DEPENDENCY_PINS.md.
 *
 * @param forcedCloseTimeoutMs - The wait each mid-exchange re-dial spends on the
 * close it drives instead of the reading it cannot take, which is what the
 * missing reading costs.
 */
export function unreadableTransportLifecycleWarning(
  forcedCloseTimeoutMs: number,
): string {
  return (
    `Every mid-exchange re-dial on this SFTP connection closes it from this ` +
    `side first and waits up to ${forcedCloseTimeoutMs} ms for that close, ` +
    `even on a connection that had already closed, so re-dialing is slower ` +
    `than it needs to be. The exchange still completes. This build of ` +
    `psilink does not fully support the installed SFTP library; ` +
    `${REPORT_LIBRARY_INCOMPATIBILITY}.`
  );
}

/**
 * The idle release that closed nothing because another session transition still
 * held the one shared client: closing the session alongside it would corrupt that
 * client, so the release declines and the next cycle releases again.
 *
 * @param boundaryCount - The run tally of boundaries that released nothing this
 * way, which the shared warn cadence paces on.
 * @param acquireTimeoutMs - The wait the release gave up after.
 */
export function idleReleaseDeclinedWarning(
  boundaryCount: number,
  acquireTimeoutMs: number,
): string {
  const count = boundaryCount;
  return (
    `The connection-per-poll idle release did not close the SFTP session: ` +
    `another session transition on this connection -- typically a dial ` +
    `against an unresponsive server -- did not complete within the ` +
    `release's ${acquireTimeoutMs} ms wait, and closing the ` +
    `session alongside it would corrupt the one shared client. The session ` +
    `may still be live and held across this idle gap; the next poll cycle ` +
    `releases again and the exchange continues (${count} idle ` +
    `${count === 1 ? "boundary" : "boundaries"} released nothing this way ` +
    `so far this exchange).`
  );
}

/**
 * The idle release whose ssh2 `end()` ended no transport, leaving the session
 * possibly live and held across the gap -- the one thing connection-per-poll
 * exists to prevent. The one degraded outcome with no run total, so it takes no
 * count and its call site leaves it unpaced.
 */
export function idleReleaseDidNotCloseWarning(): string {
  return (
    "The connection-per-poll idle release did not close the SFTP session " +
    "and its transport is still writable, which the ssh2 client's end() " +
    "should have ended: the session may still be live and held across " +
    "this idle gap, which is the one thing this mode exists to prevent. " +
    "Check the ssh2 changelog."
  );
}

/**
 * The partner's server ended a session at an idle boundary with nothing of this
 * side's on the wire, so no operation was torn and no recovery re-dial ran: the
 * next cycle simply dials again. Deliberately not the recovery line's wording --
 * nothing was transparently re-dialed here, and the remedy differs.
 *
 * @param boundaryCount - The run tally of boundaries that met an already-ended
 * session, which the shared warn cadence paces on.
 */
export function partnerDropAtIdleBoundaryWarning(
  boundaryCount: number,
): string {
  const count = boundaryCount;
  return (
    `The partner's SFTP server ended the SFTP session before this ` +
    `connection-per-poll idle boundary rather than in answer to it, with ` +
    `nothing of this side's on the wire, so no operation was interrupted ` +
    `and the next poll cycle dials a fresh session; the exchange continues ` +
    `(${count} idle ${count === 1 ? "boundary" : "boundaries"} met a ` +
    `session the partner had already ended so far this exchange). This is ` +
    `typically a server-enforced session-duration, idle or operation limit ` +
    `you cannot change, which connection-per-poll is the mode for: these ` +
    `sessions are not charged against max_reconnect_attempts.`
  );
}

/**
 * An idle boundary the connection-per-poll release closed itself, the partner's
 * server not having closed the connection within the release's bound.
 *
 * @param boundaryCount - The run tally of boundaries closed this way, which the
 * shared warn cadence paces on.
 */
export function forcedIdleReleaseWarning(boundaryCount: number): string {
  const count = boundaryCount;
  return (
    `The partner's SFTP server did not close the connection within the ` +
    `connection-per-poll idle release's bound -- a server that leaves ` +
    `connections half-open, or one merely slower to answer than the ` +
    `bound allows for. The release closed it from this side and the next ` +
    `poll cycle dials a fresh session; the exchange continues (${count} ` +
    `idle ${count === 1 ? "boundary" : "boundaries"} closed this way so ` +
    `far this exchange).`
  );
}

/**
 * The cycle-start re-dial gave up its wait for the transition ahead of it: it
 * dialed nothing, so this cycle carries no session and the poll loop skips it.
 *
 * @param cycleCount - The run tally of cycles skipped this way, counted apart
 * from the idle release's decline and paced on its own tally.
 * @param acquireTimeoutMs - The wait the re-dial gave up after.
 */
export function cycleRedialDeclinedWarning(
  cycleCount: number,
  acquireTimeoutMs: number,
): string {
  const count = cycleCount;
  return (
    `ephemeral SFTP re-dial declined: another session transition on this ` +
    `connection did not complete within the re-dial's ` +
    `${acquireTimeoutMs} ms wait, and dialing alongside it ` +
    `would corrupt the one shared client; skipping this poll cycle and ` +
    `retrying on the next tick (${count} ` +
    `${count === 1 ? "cycle" : "cycles"} skipped this way so far this ` +
    `exchange)`
  );
}

/**
 * The rejection for a publish whose fate the transport cannot settle: a
 * mid-operation drop tore the rename, and what the recovery could read of the
 * aftermath is the state a landed-then-consumed publish and an unlanded one
 * share. It stays a rejection -- nothing here reports an unpublished write as
 * sent.
 *
 * Names the publish rather than a message, and prescribes no next step:
 * rename() is shared machinery, and the four publishes reaching it -- the
 * message loop's send(), its ack, the rendezvous joining->hello rename, and the
 * abort marker -- share no remedy, so this carries no recovery-hint tag either.
 * The one caller whose remedy is established re-raises this as its own tagged
 * error holding this one as the `cause` (FileSyncMessageLoop's send()).
 *
 * Written to survive the display boundary, which caps each error in a rendered
 * cause chain at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH: the sentence the operator
 * must act on leads, and the destination -- named because what this party
 * published may now be in the peer's hands under it -- comes last, where the
 * cap costs least.
 *
 * @param error - The re-issue's own error, carried only as the `cause` so the
 * SFTP status it names is rendered on its own line under its own cap rather than
 * spending this message's.
 * @param toPath - The destination, partner-derived on the ack and rendezvous
 * rename paths and composed RAW like every other path this app puts in an error:
 * the display sink escapes the whole rendered chain once.
 */
export function indeterminatePublishError(
  error: unknown,
  toPath: string,
): TransportPublishIndeterminateError {
  return new TransportPublishIndeterminateError(
    `the publish may or may not have reached the partner: it was cut off ` +
      `mid-operation and could not be confirmed afterwards. ` +
      `Destination: ${toPath}`,
    { cause: error },
  );
}
