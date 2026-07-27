// This adapter drives ssh2's raw SFTPWrapper internals past the public
// ssh2-sftp-client API, so ssh2 and ssh2-sftp-client are exact-pinned in
// package.json. On any upgrade of either, re-verify the internal premises per
// the "Upgrading the SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md
// before it merges -- a "compatible" bump can silently break a premise no
// normal-path test exercises.
import Ssh2SftpClient from "ssh2-sftp-client";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DirectoryListingBoundsError,
  FileInfo,
  FileTransportClient,
  FrameSizeExceededError,
  GetOptions,
  PutOptions,
  PutSource,
  TransportOperationStalledError,
  UsageError,
  getLoggerForVerbosity,
  retryPromise,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { createCappedSink } from "./frameSizeGuard";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
  directoryTooLargeError,
  filenameTooLongError,
  listingStalledByBatchCountError,
  listingStalledByTimeoutError,
} from "./listingGuard";
import {
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_STALL_DEADLINE_MS,
  createBoundedPutSource,
  transportOperationStalledError,
  withSftpOperationDeadline,
  withSlowOperationWarning,
} from "./sftpLivenessGuard";
import { SFTP_TCP_KEEPALIVE_DELAY_MS, SftpHeartbeat } from "./sftpHeartbeat";

// A single entry as ssh2's SFTPWrapper.readdir reports it. Only the fields the
// transport consumes are typed; ssh2 supplies more (longname, the rest of
// attrs).
interface Ssh2DirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

// ssh2 reports SFTP failures (including end-of-directory from readdir) as an
// Error carrying the numeric SFTP status code on `code`.
type Ssh2SftpError = Error & { code?: number };

// SSH_FX_FAILURE: the generic SFTPv3 status (4) a server returns when an
// operation did not take effect for a reason it does not further classify. The
// numeric value reaches us because ssh2-sftp-client passes ssh2's raw status
// through fmtError onto err.code (the same premise createExclusive's code-4
// handling relies on).
const SSH_FX_FAILURE = 4;

// Upper bound (ms) on how long a close of this adapter's SFTP connection waits
// for the partner server before ending the wait itself. Both closes are held to
// it: the connection-per-poll release's wait for the ssh2 Client's 'close' after
// driving its end() ({@link SSH2SFTPClientAdapter.releaseForIdle}), and the
// connection's terminal close's wait for ssh2-sftp-client's own end()
// ({@link SSH2SFTPClientAdapter.end}). A local socket close completes in
// milliseconds; this only bounds a pathological withheld close, so it cannot hang
// the poll loop's idle boundary or the process's exit. Deliberately not
// operator-configurable -- it is a liveness backstop, not a tunable, exactly like
// the other SFTP liveness bounds.
const CLIENT_CLOSE_TIMEOUT_MS = 5_000;

// Upper bound (ms) on how long either forced close (see
// {@link SSH2SFTPClientAdapter.forceCloseEndedTransport} and
// {@link SSH2SFTPClientAdapter.forceCloseTerminalTransport}) waits out the
// teardown after destroying the socket beneath the ssh2 Client. Destroying a
// local socket reaches that teardown in single-digit milliseconds -- there is no
// peer to wait for, which is the whole point of forcing it -- so this bounds only
// the case where the ssh2 stack stopped settling on a destroyed socket, keeping
// that out of the poll loop's idle boundary and out of teardown. It is the one
// bound armed on a REF'D timer (see awaitBoundedTeardown), because the destroyed
// socket it waits on leaves no ref'd handle of its own. Deliberately not
// operator-configurable, like every other SFTP liveness bound.
const FORCED_CLOSE_TIMEOUT_MS = 1_000;

// Upper bound (ms) on how long one session transition waits for the transition
// ahead of it before giving up its own turn (see
// {@link SSH2SFTPClientAdapter.runTransition}). ONE number for all five kinds,
// and it bounds the WAIT rather than the transition being waited on: a ceiling on
// the dial instead would put a teardown's wait at
// `(max_reconnect_attempts + 1) * server_connect_timeout_ms` plus the
// inter-attempt delays -- around two minutes at the defaults, and unbounded above
// as the operator raises the connect timeout, which is neither teardown-scale nor
// a number the wait owns.
//
// The value: above the 6 s a legitimate release can spend
// (CLIENT_CLOSE_TIMEOUT_MS then FORCED_CLOSE_TIMEOUT_MS), so a teardown queued
// behind a normal release does not give up on it prematurely. That is a
// relationship between three independent constants, so it is DRIVEN -- by the unit
// test whose release "spends its whole close budget" with a teardown queued behind
// it -- rather than left to the arithmetic here. And teardown-scale in the sense
// FileTransportClient.end's contract requires: this bound plus the forced close it
// ends in is an order of magnitude below the dial budget an unbounded wait would
// ride. It owes nothing to the budget end()'s CALLER holds, which can be smaller
// (core races end() against one a low peer_timeout_ms puts under this bound):
// abandoning that wait closes nothing, while the abandon here runs on its own
// timer and drives the destroy either way, so a caller that gave up waiting is
// still left an exited process rather than a half-open socket -- also driven, by
// the unit test whose caller gives up first. Deliberately not
// operator-configurable, like every other SFTP liveness bound.
const TRANSITION_ACQUIRE_TIMEOUT_MS = 10_000;

// The ssh2 Client's underlying net.Socket, which the adapter reaches directly for
// what ssh2 does not expose. Every member is optional so a relocated or
// non-net.Socket transport reads undefined at each site; what that site does with
// it differs -- setKeepAlive warns and continues, the members the
// connection-per-poll release drives are verified at connect time and fail the
// dial (see resolveTransportCloseSeams), and the one member the terminal close
// drives is resolved lazily and warns rather than failing a dial over a
// teardown-only mechanism (see resolveTerminalCloseSeam).
interface Ssh2ClientSocket {
  // ssh2 exposes setNoDelay but not setKeepAlive, so connect()'s kernel TCP
  // keepalive backstop reaches the socket for it.
  setKeepAlive?(enable: boolean, initialDelay: number): void;
  // Node's own half-close flags, read by the connection-per-poll release to tell
  // WHO ended the transport. `readableEnded` is true once the peer's FIN has been
  // consumed (the peer began the teardown, so what follows is a server-side drop
  // rather than this adapter's release); `writableEnded` is true once this side has
  // ended it (ssh2's Client.end() calls _sock.end()). See releaseForIdle().
  readableEnded?: boolean;
  writableEnded?: boolean;
  // net.Socket's own unconditional teardown, which -- unlike end() -- needs nothing
  // from the peer. The connection-per-poll release drives it on a transport its
  // end() already ended but whose close the partner withheld, so the ssh2 Client's
  // 'close' fires and the session clears; the connection's terminal close drives it
  // on the same partner so the pending client.end() settles and no half-open socket
  // outlives teardown. See forceCloseEndedTransport() and
  // forceCloseTerminalTransport().
  destroy?(): void;
  // Node's own post-destroy flag, read back by the terminal close to confirm the
  // socket it destroyed actually closed. Not part of the connect-time seam set:
  // an absent flag reads as "did not close" and warns, rather than failing a dial
  // over a teardown-only read.
  destroyed?: boolean;
}

// Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
// exposes as `this.sftp`. Defined at file scope so connect(), createExclusive(),
// and list() can share it without repeating the declaration.
interface Ssh2SftpClientInternals {
  // The underlying ssh2 Client instance. ssh2-sftp-client constructs it as
  // `this.client` and drives every connection through it; its public
  // setNoDelay(boolean) toggles TCP_NODELAY on the live socket, and `_sock` is the
  // socket beneath it ({@link Ssh2ClientSocket}). Both are optional so the guarded
  // calls in connect() can warn-and-continue (each is transport hygiene, not a
  // correctness requirement) if an upgrade relocates them.
  client?: {
    setNoDelay(noDelay: boolean): void;
    _sock?: Ssh2ClientSocket;
    // The ssh2 Client is an EventEmitter; the adapter registers a persistent
    // 'keyboard-interactive' listener on it to answer a server that authenticates
    // that method (see attachKeyboardInteractive). Typed narrowly to the one
    // event the adapter uses rather than the full ssh2 Client surface.
    on?(
      event: "keyboard-interactive",
      listener: (
        name: string,
        instructions: string,
        lang: string,
        prompts: { prompt: string; echo?: boolean }[],
        finish: (answers: string[]) => void,
      ) => void,
    ): void;
    // The connection-per-poll release drives the ssh2 Client's own end() (NOT
    // ssh2-sftp-client's end(), which latches endCalled and disables the
    // constructor's global 'close' listener that clears this.sftp on a later
    // server drop) and awaits its 'close' to know the session is torn down;
    // removeListener drops that wait when the close never lands, so the shared
    // Client does not accumulate one listener per released cycle. All three are on
    // the ssh2 Client's EventEmitter surface; typed optional so an upgrade that
    // relocates them fails the connect-time seam check rather than the type.
    // See resolveTransportCloseSeams().
    once?(event: "close", listener: () => void): void;
    removeListener?(event: "close", listener: () => void): void;
    end?(): void;
  };
  sftp: {
    open(
      path: string,
      flags: number,
      attrs: Record<string, unknown>,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    close(handle: Buffer, callback: (err: Error | null) => void): void;
    opendir(
      path: string,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    // Called with a directory handle, readdir returns ONE server batch per call
    // and reports end-of-directory as an error whose `code` is SSH_FX_EOF (not
    // as an empty list), the contract the batch loop in list() relies on. `list`
    // is supplied only on success: ssh2 omits it (passes undefined) whenever
    // `err` is set, including the EOF signal, hence the optional parameter.
    readdir(
      handle: Buffer,
      callback: (err: Ssh2SftpError | null, list?: Ssh2DirEntry[]) => void,
    ): void;
    // The raw ssh2 SFTPWrapper is an EventEmitter: ssh2 emits a fatal 'error' on
    // it (via doFatalSFTPError) when the server returns a malformed SFTP packet.
    // The adapter attaches its own guarded listener in connect() so that emit
    // cannot crash the process; see the connect() comment for why no one else
    // does. `unknown` rather than the full Node listener type keeps this minimal
    // -- the adapter only registers and never inspects the listener set.
    on(event: "error", listener: (err: Error) => void): unknown;
  } | null;
}

// The single ssh2 seam the connection's terminal close drives. Resolved on its
// own, apart from the wider set below, so a relocated member the terminal close
// never touches cannot disable its forced destroy -- which in the default
// held-session mode would leave a completed run holding a ref'd half-open socket,
// i.e. a process that never exits. See
// SSH2SFTPClientAdapter.resolveTerminalCloseSeam.
interface TerminalCloseSeam {
  destroy: () => void;
  socket: Ssh2ClientSocket;
}

// The ssh2 seams a forced close of an ALREADY-ENDED transport drives: the
// terminal close's socket destroy, plus the ssh2 Client's 'close' subscription,
// which is what fires ssh2-sftp-client's global listener to clear the session.
// Not `end()`: a transport that has ended needs no second end. Resolved and bound
// together so a caller cannot reach one without having checked all of them. See
// SSH2SFTPClientAdapter.resolveEndedTransportCloseSeams.
interface EndedTransportCloseSeams extends TerminalCloseSeam {
  once: (event: "close", listener: () => void) => void;
  removeListener: (event: "close", listener: () => void) => void;
}

// The above plus the ssh2 Client's own end(), which is what the
// connection-per-poll idle release drives to END the transport before the forced
// close that may follow it. See
// SSH2SFTPClientAdapter.resolveTransportCloseSeams.
interface TransportCloseSeams extends EndedTransportCloseSeams {
  end: () => void;
}

// The first seam the installed ssh2 / ssh2-sftp-client no longer exposes, named
// as the adapter reaches it (e.g. `client._sock.destroy()`).
interface UnavailableTransportCloseSeam {
  missing: string;
}

// How a bounded teardown wait ended (see
// SSH2SFTPClientAdapter.awaitBoundedTeardown). `settled` is the only one meaning
// the close completed: `failed` is a close that raised having closed nothing, and
// `expired` a close still outstanding at the bound.
type BoundedTeardownOutcome =
  | { status: "settled" }
  | { status: "failed"; error: unknown }
  | { status: "expired" };

// What one mid-exchange recovery re-dial leaves its caller to do with the
// operation it was recovering (see
// SSH2SFTPClientAdapter.redialForRecovery). `sessionLive` is the only one that
// counts as a survived drop. The other two both mean nothing was dialed, and are
// kept apart because the re-issue is right in one and wrong in the other: over a
// CLEARED session the re-issue rejects at once with the real loss, while over a
// session that still reads live on an ended transport it cannot complete and
// would ride the per-operation liveness deadline a second time before failing as
// it would have anyway.
type RecoveryRedialOutcome = "sessionLive" | "noSession" | "deadSessionHeld";

// Every point at which this adapter dials a session or closes one. All five run
// under the adapter's one transition lock (see
// SSH2SFTPClientAdapter.runTransition), so none can overlap another on the one
// shared Ssh2SftpClient.
type SessionTransitionKind =
  | "connect"
  | "ensureConnected"
  | "redialForRecovery"
  | "releaseForIdle"
  | "teardown";

// How the session's last completed boundary was reached. `deliberatelyReleased`
// is the connection-per-poll release having ended the session on purpose;
// everything else -- including a release that raised, one that walked into the
// PEER's teardown, and one that could not clear the session it destroyed -- is a
// loss the operator must see counted and warned.
type SessionBoundary = "deliberatelyReleased" | "notReleased";

// Records the boundary a transition reached, at the point inside the transition
// where it is decided. Handed to each transition by runTransition, which owns the
// only assignment to the field behind it.
type SessionBoundaryRecorder = (boundary: SessionBoundary) => void;

// The transition runTransition is currently running, as it hands it to that
// transition's body: the boundary recorder, and the identity every dial and every
// close inside the body presents at the chokepoint
// (SSH2SFTPClientAdapter.assertTransitionHeld). Identity rather than the kind, and
// rather than a boolean, because a teardown that gave up its wait drives its
// forced close while ANOTHER transition holds the client: against a boolean the
// chokepoint would report its property holding at exactly the moment it was being
// violated.
interface HeldSessionTransition {
  readonly kind: SessionTransitionKind;
  readonly recordBoundary: SessionBoundaryRecorder;
}

// A mechanism driven outside the transition that owns it
// (SSH2SFTPClientAdapter.assertTransitionHeld). Its own class so that a catch
// placed around one of those mechanisms, for a failure of the mechanism itself,
// cannot quietly absorb the chokepoint check reached through it: the check exists
// to make two overlapping transitions LOUD, and reporting one as an operational
// failure of the thing it guards is the one outcome that would defeat it.
class SessionTransitionViolationError extends Error {}

// What a transition does when its bounded wait for the transition ahead of it
// expires (TRANSITION_ACQUIRE_TIMEOUT_MS). runTransition acts on this reading
// rather than on the kind, and every value is behavior observable on the adapter
// itself -- what the caller gets back, and what the abandon drives on the shared
// client.
type AbandonedTransitionDisposition =
  // Give up this transition, drive NOTHING on the client, and hand the caller the
  // kind's own nothing-happened value (`abandoned` on the transition).
  | "declinesAndReturns"
  // The same, except the kind has no value that could mean "no session was
  // established", so it rejects with an error naming the bound.
  | "rejects"
  // Teardown alone, and only in this narrow form: it gives up ssh2-sftp-client's
  // end() -- which a live handshake beneath it resolves in a millisecond having
  // closed nothing (measured; see docs/spec/DEPENDENCY_PINS.md) -- and closes the
  // transport from this side instead. The destroy needs nothing from the peer and
  // settles the very dial being waited on.
  | "forcesTheTransportClosed";

// Exhaustive over the transition kinds, so a sixth kind cannot be added without
// stating what happens when its wait expires. Every value is this package's own
// behavior, which this package's tests drive -- nothing here asserts how
// packages/core forwards a call, which apps/cli cannot observe.
const ABANDONED_TRANSITION_DISPOSITION: Record<
  SessionTransitionKind,
  AbandonedTransitionDisposition
> = {
  connect: "rejects",
  ensureConnected: "declinesAndReturns",
  redialForRecovery: "declinesAndReturns",
  releaseForIdle: "declinesAndReturns",
  teardown: "forcesTheTransportClosed",
};

// One session transition, as runTransition takes it. The three arms are the three
// abandon dispositions above, so the value each kind reports is stated where the
// disposition record says it is needed and nowhere else. Teardown carries no
// `skipped` because it is the transition the teardown latch is set FOR: every
// other kind states what it returns when it reaches the front of the queue with
// that latch already set.
type SessionTransition<T> =
  | {
      kind: "teardown";
      run: (held: HeldSessionTransition) => Promise<T>;
      abandoned: () => T;
    }
  | {
      kind: "connect";
      run: (held: HeldSessionTransition) => Promise<T>;
      skipped: () => T;
    }
  | {
      kind: Exclude<SessionTransitionKind, "teardown" | "connect">;
      run: (held: HeldSessionTransition) => Promise<T>;
      skipped: () => T;
      // What this transition's caller reads when it gives up its wait for the one
      // ahead of it. Distinct from `skipped`, which answers a transition that
      // reached the front with teardown already latched: that connection is
      // closing on purpose, whereas this one is still open and the transition
      // simply did not get its turn.
      abandoned: () => T;
    };

// list() and createExclusive() both run only after connect() has already
// verified the 'sftp' session and every method it drives (see the guard
// there), so a falsy session at either site means the connection was closed
// or dropped after that successful connect, never an API change. Shared here
// so the two throw sites cannot drift apart.
const SFTP_SESSION_CLOSED_MESSAGE =
  "SFTP session is not open: the connection was closed or dropped after a " +
  "successful connect (typically a server idle or session-time-limit " +
  "policy, or a network drop), so this operation cannot run.";

/**
 * Warn cadence for transparently-recovered mid-exchange session drops. The
 * adapter warns the operator on the FIRST successful mid-exchange re-dial, then
 * again only once every `SFTP_REDIAL_WARN_INTERVAL`-th re-dial, so a partner
 * whose server chronically caps session lifetime stays visible without a warn
 * line on every poll cycle. This is an observability cadence only, independent of
 * the mid-exchange reconnection cap that bounds how many re-dials the default mode
 * performs before failing terminally (see
 * {@link SSH2SFTPClientAdapter.withSessionRecovery}).
 */
export const SFTP_REDIAL_WARN_INTERVAL = 10;

export class SSH2SFTPClientAdapter implements FileTransportClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;
  // The FULL, unmodified options the last connect() was called with -- including
  // the psilink-specific maxReconnectAttempts that connect() strips before
  // storing this.options, plus the enforcing hostVerifier and the stored
  // credentials. Retained so mid-exchange session recovery can re-dial through
  // connect() with the same host-key pin, credentials, and reconnect bound,
  // which this.options alone cannot reconstruct. Undefined until the first
  // connect(): a server-driven op reaching the recovery path before any connect
  // has nothing to re-dial with, and the recovery guard treats that as terminal.
  private originalConnectOptions: Record<string, unknown> | undefined;
  // Latched true by end() before it enqueues the teardown transition. It is read
  // ONCE per transition, inside runTransition's critical section, and that single
  // read is the whole of "no session transition begins after teardown has been
  // latched". Its other jobs are separate from that exclusion: it refuses a reopen
  // of a terminally closed connection (connect()'s skipped value), and it stops
  // session recovery from launching a re-dial into a teardown
  // (shouldRecoverFromSessionLoss) -- a re-dial's readyTimeout would slow a clean
  // close, and a freshly-dialed session would outlive the teardown.
  private closing = false;
  // Latched true when an abandoning teardown closed the transport itself (see
  // forceCloseAbandonedTeardown), which cuts short whatever dial the transition it
  // gave up on was running. That dial rejects with the same error a genuine peer
  // close produces (measured; see docs/spec/DEPENDENCY_PINS.md), so telling "this
  // adapter closed it" from "the partner dropped us" takes this reading rather than
  // a match on the error text. Read by session recovery, which then surfaces the
  // loss it was recovering from instead of an error of this adapter's own making.
  // Never cleared: it is only ever set on a connection already closing.
  private abandonedTeardownClosedTransport = false;
  // The connection's one terminal close, memoized by end() on its first call: a
  // repeat or concurrent close awaits this one instead of driving a second on the
  // same client. Driving a second is not merely wasteful -- this close does not
  // settle, either way, until the client's socket has been destroyed beneath it or
  // a degraded branch has warned, so the second drive spends the whole bound again
  // and tells the operator a second time about one close. Never cleared (terminal
  // is terminal), so a rejection is shared by every caller rather than
  // re-attempted: what it reports is ssh2-sftp-client's own end() raising, which
  // core logs at debug, and the connection that end() failed to close has already
  // been closed from this side by the time any caller can see it.
  private terminalClose: Promise<void> | undefined;
  // Latched true when the connection's close()/teardown begins, via
  // beginTeardown(). Distinct from `closing` (set later, by end()): `closing`
  // forbids a re-dial outright, whereas a teardown re-dial is still wanted -- the
  // authenticated abort-marker write and the terminal-frame drain must be able to
  // re-dial so the fast-fail marker still lands -- but is EXEMPT from the
  // mid-exchange reconnection cap and is neither counted nor warned (it is teardown
  // mechanics, not a survived mid-exchange drop). A capping-server failure is
  // exactly when the peer most needs the marker, so the exemption is deliberate.
  // A plain latch, never reset.
  private tearingDown = false;
  // The tail of the session-transition queue. Every acquire chains onto it and
  // replaces it SYNCHRONOUSLY at the call, so transitions run in the order their
  // methods were called in and an inserted microtask cannot reorder them.
  private transitionTail: Promise<void> = Promise.resolve();
  // Session transitions enqueued and not yet settled. Zero means the queue has
  // drained, so the next acquire enters its critical section synchronously rather
  // than a microtask later: an idle-boundary release must have driven the ssh2
  // Client's end() by the time releaseForIdle() returns to its caller, or an
  // operation issued in the same tick would be admitted onto the session that
  // release is about to tear down.
  private pendingTransitions = 0;
  // The session transition currently holding the queue, or undefined when none is.
  // Read by the connection-per-poll operation gate (an operation issued during a
  // release must re-establish rather than race the close) and by the chokepoint
  // check that every dial and every close runs inside the transition that owns it,
  // which is why this is the transition's identity rather than merely its kind.
  private transitionInProgress: HeldSessionTransition | undefined;
  // How the session's last completed boundary was reached, written ONLY by
  // runTransition -- through the recorder it hands each transition, by restoring
  // the previous reading when a transition rejects, and by taking a
  // deliberate-release reading back from a transition that leaves a session live.
  // Read by withSessionRecovery's gate (re-establish before the first attempt) and
  // by its classification: a re-dial following a deliberate lifecycle transition is
  // exempt from the reconnect counters and the operator warning, exactly as a
  // teardown re-dial is. Discharged by the dial that re-establishes the session --
  // the single path every re-establishment goes through -- so a failed dial leaves
  // it standing and a genuine drop after a completed re-establishment is counted
  // and warned as one. Outside the release's own close window, `deliberatelyReleased`
  // stands only where no session is live: over a live one it would exempt that
  // session's next real drop, the misreport it exists to prevent.
  private sessionBoundary: SessionBoundary = "notReleased";
  private log: ReturnType<typeof getLoggerForVerbosity>;
  // The raw SFTPWrapper this adapter has already attached its fatal-'error'
  // listener to, so connect() attaches exactly once per wrapper instance (see
  // attachFatalErrorListener). Stored as the wrapper object identity, not a
  // boolean, because ssh2-sftp-client hands back a fresh wrapper after an
  // end()/connect() cycle and the new one needs its own listener.
  private guardedSftp: object | undefined;
  // The fatal SFTP-protocol error captured by that listener, if one has fired.
  // Set once the session is dead; read by in-flight operations so they reject
  // promptly with the real cause instead of waiting out the 60 s liveness
  // deadline. Never cleared: a wrapper that emitted a fatal 'error' is
  // destroyed by ssh2 and cannot recover, and connect() resets it to undefined
  // alongside attaching a listener to a fresh wrapper.
  private fatalSftpError: Error | undefined;
  // True once the keyboard-interactive answer handler has been attached to the
  // underlying ssh2 Client. ssh2-sftp-client constructs that Client once and
  // reuses it across reconnects (connect() does not strip user listeners), so
  // the handler is attached exactly once -- re-attaching per reconnect would
  // stack duplicate listeners and eventually trip a MaxListenersExceeded
  // warning. See attachKeyboardInteractive.
  private keyboardInteractiveAttached = false;
  private reconnectAttempts = 0;
  // Successful mid-exchange recovery re-dials over this adapter's life, tracked
  // apart from reconnectAttempts (which also counts connect-retry re-dials) to
  // drive the operator warn cadence (SFTP_REDIAL_WARN_INTERVAL), the cumulative
  // mid-exchange reconnection cap (max_reconnect_attempts; see withSessionRecovery),
  // and the end-of-run summary's mid-exchange sub-count (midExchangeReconnectCount).
  // A plain operational counter, never a partner-controlled value.
  private midExchangeRedials = 0;
  // Idle-boundary releases this adapter forced closed itself, and the session
  // cleared, because the partner withheld its close past the release's bound (see
  // releaseForIdle). Drives that path's warn cadence (SFTP_REDIAL_WARN_INTERVAL):
  // a partner that never closes forces one every cycle, so an unpaced warning
  // would fill an hours-long exchange's log. A plain operational counter, never a
  // partner-controlled value.
  private forcedReleases = 0;
  // Idle-boundary releases that closed NOTHING because they gave up their wait for
  // the transition ahead of them (see warnIdleReleaseDeclined). Kept apart from
  // forcedReleases, which counts a boundary this adapter did close: rolling the two
  // together would report a closed boundary the adapter never reached, in the one
  // metric that tells the operator the mode is working. Paces this path's warning
  // and carries its own end-of-run total (declinedReleaseCount), the two being
  // separate statements about the mode: how often it closed a boundary itself, and
  // how often it could not close one at all.
  private declinedReleases = 0;
  // Cycle-start re-dials that dialed NOTHING because they gave up their wait for the
  // transition ahead of them (see warnCycleRedialDeclined). Paces that path's
  // warning and nothing else; kept apart from the release counter above because a
  // single stuck transition declines both signals of the same cycle, and one counter
  // would then pace each line on the other's occurrences.
  private declinedCycleRedials = 0;
  private transportRetries = 0;
  // The per-operation liveness bound (ms) every server-driven op is held to. See
  // the constructor's stallDeadlineMs doc for the test-seam and
  // not-operator-configurable rationale.
  private readonly stallDeadlineMs: number;
  // Keeps an idle session alive past a server's SFTP-command idle timeout by
  // issuing a periodic no-op realPath. Created here (never null) so the op-bracket
  // helper can call opStarted/opSettled unconditionally; armed by connect() on
  // success and torn down by end() and the fatal-'error' guard. See
  // {@link ./sftpHeartbeat}. Not armed in ephemeral-session mode: no session is
  // held long enough to idle out.
  private readonly heartbeat: SftpHeartbeat;
  // Connection-per-poll (ephemeral-session) mode. When true, the adapter releases
  // its SFTP session at each poll-loop idle boundary (releaseForIdle) and re-dials
  // at the start of the next cycle (ensureConnected), so no session is held across
  // an idle gap a server's max-session/idle cap would drop. Off by default (the
  // whole-exchange single-session model). Internal-only; the CLI/config surface
  // and the flag name are a separate item. See docs/notes/connection-per-poll-sftp.md.
  private readonly ephemeralSessions: boolean;

  /**
   * `options.verbosity` sets the adapter's log verbosity (default 1).
   *
   * `options.stallDeadlineMs` is an @internal test-only override for the
   * per-operation liveness deadline; production constructs the adapter with no
   * argument (an empty options object) and gets {@link SFTP_STALL_DEADLINE_MS}.
   * It is a named options field rather than a positional argument so the seam is
   * unmistakable and a future production constructor parameter can never be
   * passed as the deadline by accident. Deliberately not surfaced via config so
   * the bound cannot be widened by an operator.
   *
   * `options.ephemeralSessions` turns on connection-per-poll (ephemeral-session)
   * mode: the adapter releases its SFTP session at each poll-loop idle boundary
   * and re-dials at the start of the next cycle, so no session is held across an
   * idle gap a server's max-session/idle cap would drop. Off by default.
   * Internal-only -- the CLI/config surface and the flag name are a separate item.
   */
  constructor(
    options: {
      verbosity?: number;
      stallDeadlineMs?: number;
      ephemeralSessions?: boolean;
    } = {},
  ) {
    this.log = getLoggerForVerbosity("sftp-adapter", options.verbosity ?? 1);
    // ssh2-sftp-client's bare constructor installs default callbacks that
    // console.error/console.log the underlying ssh2 Client's error/end/close
    // events whenever they fire OUTSIDE a high-level operation it initiated --
    // its globalListener gate runs them only while the matching
    // endCalled/*Handled flag is still false. The host-key first-use probe and
    // the verify(false) rejection tear the raw transport down without going
    // through the client's end(), so their bare end/close land on those console
    // defaults as cosmetic "Global ... listener" lines that bypass the project
    // logger and leak past the integration suite's log-level controls. Route the
    // three to this adapter's logger instead. The callbacks are purely
    // observational: the handled-flag bookkeeping and this.sftp cleanup run
    // inside globalListener regardless of the callback, so this redirects only
    // where the diagnostic goes, never control flow. An unhandled client error
    // escaped the adapter's own fatal-error listener and connect retry, so it
    // stays at error (the console.error default's severity); its message is
    // server-controlled (an SSH_MSG_DISCONNECT description rides through on
    // err.message), so it is rendered through sanitizeErrorForDisplay before
    // logging -- the operator-facing seam that escapes the bytes (neutralizing
    // ANSI/bidi/newline log injection) and applies the PEM/key redaction
    // backstop -- now that it can reach a --log-file. end/close are benign
    // out-of-band lifecycle signals -- expected on the host-key probe and
    // verify(false) rejection teardown -- so they go to trace, below the DEBUG
    // the integration suite's noisiest file enables, surfacing only at -vvv.
    this.client = new Ssh2SftpClient("sftp", {
      error: (err: unknown) =>
        this.log.error(
          `ssh2 client error outside an operation: ` +
            sanitizeErrorForDisplay(err),
        ),
      end: () =>
        this.log.trace("ssh2 client connection ended outside an operation"),
      close: () =>
        this.log.trace("ssh2 client connection closed outside an operation"),
    });
    this.stallDeadlineMs = options.stallDeadlineMs ?? SFTP_STALL_DEADLINE_MS;
    this.ephemeralSessions = options.ephemeralSessions ?? false;
    this.heartbeat = new SftpHeartbeat({
      ping: () => this.sendKeepalive(),
      log: this.log,
    });
  }

  /**
   * Connection re-establishment attempts over this adapter's life: connect-retry
   * re-attempts past the first, plus each successful mid-exchange session-recovery
   * re-dial (a re-dial that survived a server-side drop is itself a reconnection,
   * and connect()'s own counter does not see one that succeeds on its first
   * attempt). A re-establishment that follows a DELIBERATE lifecycle transition --
   * the connection-per-poll idle release, or teardown -- is not counted: nothing
   * was lost, so counting it would report drops a healthy exchange never had. A
   * plain operational counter, never a partner-controlled value.
   */
  get reconnectCount(): number {
    return this.reconnectAttempts;
  }

  /**
   * The subset of {@link reconnectCount} that were mid-exchange session-recovery
   * re-dials -- a server dropping a live session mid-exchange, which the adapter
   * transparently re-dialed and re-issued the interrupted operation on. Surfaced
   * apart from the merged reconnect total so the end-of-run summary can
   * distinguish chronic mid-exchange drops from benign connect-time retries. It
   * carries the same deliberate-transition exemption as {@link reconnectCount}, so
   * in connection-per-poll mode it counts a within-cycle drop that an OPERATION
   * observed: a drop in the tail of a cycle is absorbed by the next cycle-start
   * re-establishment, which is a dial rather than a recovery re-dial and bumps
   * neither counter. A plain operational counter, never a partner-controlled value.
   */
  get midExchangeReconnectCount(): number {
    return this.midExchangeRedials;
  }

  /**
   * Transport data-operation retries over this adapter's life: the number of
   * put/rename re-issues past the first attempt, summed across every operation.
   * A plain operational counter, never a partner-controlled value.
   */
  get transportRetryCount(): number {
    return this.transportRetries;
  }

  /**
   * Idle boundaries at which the partner's SFTP server did not close the
   * connection within the release's bound, so the connection-per-poll release
   * ended the boundary itself (see {@link releaseForIdle}). NOT a reconnection
   * and not a lost session: the mode's own boundary, deliberate on both the
   * release and the dial that follows it, and therefore absent from
   * {@link reconnectCount}. 0 in every other mode and against a server that
   * closes on request. A plain operational counter, never a partner-controlled
   * value.
   */
  get forcedReleaseCount(): number {
    return this.forcedReleases;
  }

  /**
   * Idle boundaries at which the connection-per-poll release closed NOTHING,
   * having given up its bounded wait for the session transition ahead of it (see
   * {@link releaseForIdle}). The session may still be live and held across the
   * idle gap the mode exists to release, which is the opposite of what
   * {@link forcedReleaseCount} records -- a boundary this adapter did end -- so
   * the two are never summed. NOT a reconnection and not a lost session: nothing
   * was closed, so it is absent from {@link reconnectCount} too. 0 in every other
   * mode and whenever no transition ran long enough to be given up on. A plain
   * operational counter, never a partner-controlled value.
   */
  get declinedReleaseCount(): number {
    return this.declinedReleases;
  }

  // Acquire this adapter's one session-transition lock and run `transition` under
  // it. Every point at which the adapter dials a session or closes one goes
  // through here, so two can never overlap on the one shared Ssh2SftpClient
  // (ssh2-sftp-client shares connection-level listeners, so two handshakes -- or a
  // handshake and a teardown -- at once is unsafe).
  //
  // The queue slot is taken SYNCHRONOUSLY, before the returned promise exists, so
  // transitions run in the order their methods were called in and inserting a
  // microtask anywhere on a transition path cannot change which one wins. The lock
  // is NOT reentrant: a transition body drives the locked worker
  // ({@link connectLocked}), never the public method that acquires.
  //
  // The teardown latch is read here and nowhere else. A non-teardown transition
  // that reaches the front of the queue with `closing` set does not run its body
  // and returns its caller's `skipped` value, so end() -- which latches
  // synchronously before enqueuing -- skips everything queued behind it, while
  // whatever was already running is waited out by end()'s own FIFO position.
  // The queue is released in a `finally`, so a transition that rejects frees it
  // rather than pinning every later one.
  //
  // The acquire is bounded, once, by TRANSITION_ACQUIRE_TIMEOUT_MS, and a waiter
  // whose bound expires NEVER proceeds into its own session action: it abandons its
  // own transition through the disposition its kind states
  // (ABANDONED_TRANSITION_DISPOSITION). Proceeding would trade a bounded park for
  // two handshakes -- or a handshake alongside a close -- on the one shared client,
  // the state this lock exists to prevent. Above that bound, what stands over a
  // transition is whatever its caller in core carries: the first dial passes
  // through unwrapped (it carries its own per-attempt connect deadline), as do the
  // two cycle-boundary signals (neither is a peer round trip); end() is wrapped in
  // core's own short teardown budget; and a recovery re-dial rides the operation
  // that drove it -- the per-operation peer-inactivity budget, or at teardown the
  // smaller abort-marker write budget or the terminal-frame drain's remaining
  // window (docs/spec/CHANNEL_SECURITY.md enumerates the three). Those are core's
  // behavior, not this package's, and restating them here as data would be a copy
  // nothing executes: packages/core/test/fileSyncConnection.test.ts is where they
  // are pinned, by driving a never-settling end() against the teardown budget and
  // never-settling cycle-boundary signals past many peer budgets.
  private runTransition<T>(transition: SessionTransition<T>): Promise<T> {
    const predecessor = this.transitionTail;
    let leaveQueue!: () => void;
    this.transitionTail = new Promise<void>((resolve) => {
      leaveQueue = resolve;
    });
    const queued = this.pendingTransitions > 0;
    this.pendingTransitions += 1;
    const held: HeldSessionTransition = {
      kind: transition.kind,
      recordBoundary: (boundary) => {
        this.sessionBoundary = boundary;
      },
    };
    const enter = async (): Promise<T> => {
      if (transition.kind !== "teardown" && this.closing)
        return transition.skipped();
      const boundaryOnEntry = this.sessionBoundary;
      this.transitionInProgress = held;
      try {
        return await transition.run(held);
      } catch (error: unknown) {
        // A transition that raised vouches for no boundary: a release that failed
        // part-way through leaves the session the server's to drop, and a failed
        // dial leaves the release before it standing for the next operation to
        // re-establish on.
        this.sessionBoundary = boundaryOnEntry;
        throw error;
      } finally {
        // No transition leaves a deliberate-release boundary standing over a live
        // session: the reading exempts the next drop from the reconnect counters
        // and the operator warning, and over a session the server can still drop,
        // that exemption hides a partner-caused failure. Two routes reach that
        // state -- a release that ended nothing (its own raise takes the reading
        // back only as far as the one it entered with), and a dial that
        // established a session and then failed its post-connect verification,
        // never reaching its own discharge, whose failure the cycle-start
        // reconnect reports as a cycle to skip rather than a raise. The release's
        // own close window is no exception: it records the boundary while its
        // transition still holds, and by the time that transition leaves, the
        // session it deliberately ended is gone.
        if (
          this.sessionBoundary === "deliberatelyReleased" &&
          this.hasLiveSession()
        )
          this.sessionBoundary = "notReleased";
        this.transitionInProgress = undefined;
      }
    };
    const ranItsTurn = (result: Promise<T>): Promise<T> =>
      result.finally(() => {
        this.pendingTransitions -= 1;
        leaveQueue();
      });
    // An idle queue is entered in THIS tick, not a microtask later, and that is
    // load-bearing rather than an optimization (see the `pendingTransitions`
    // field): the bound is armed only where there is something to wait for.
    if (!queued) return ranItsTurn(enter());
    return this.waitForPrecedingTransition(predecessor).then((won) => {
      if (won) return ranItsTurn(enter());
      // The chain is left intact: this waiter's own queue slot is resolved when
      // the transition ACTUALLY holding the client settles, never when this
      // waiter gives up. Resolving it here would admit this waiter's successor
      // into its critical section alongside a holder that has not settled -- two
      // overlapping transitions on the one shared client, which is the corruption
      // the lock exists to prevent and which no bound may buy.
      this.pendingTransitions -= 1;
      void predecessor.then(leaveQueue);
      return this.abandonTransition(transition);
    });
  }

  // Wait out the transition ahead of this one under the single acquire bound,
  // reporting whether the wait was won. The bound's timer is left REF'D as the
  // safe default for one whose abandon closes a transport nothing else will, and a
  // unit case pins that so the ref cannot be dropped silently -- but unlike the
  // forced close's ref (see awaitBoundedTeardown, measured both ways) nothing
  // measures a process-exit difference behind it: in every state driven so far the
  // transition being waited on is itself parked on a ref'd socket handle, so the
  // process could not have exited ahead of the abandon either way. The timer is
  // cleared where the race settles, which a second unit case pins.
  private waitForPrecedingTransition(
    predecessor: Promise<void>,
  ): Promise<boolean> {
    let expire!: () => void;
    const bound = new Promise<boolean>((resolve) => {
      expire = () => resolve(false);
    });
    const timer = setTimeout(expire, TRANSITION_ACQUIRE_TIMEOUT_MS);
    return Promise.race([predecessor.then(() => true), bound]).finally(() => {
      clearTimeout(timer);
    });
  }

  // Give up a transition whose wait for the transition ahead of it expired, on the
  // terms its kind states. The teardown branch is the only one that drives
  // anything at all, and the only mechanism it drives is the forced transport
  // close.
  private abandonTransition<T>(transition: SessionTransition<T>): T {
    const disposition = ABANDONED_TRANSITION_DISPOSITION[transition.kind];
    switch (disposition) {
      case "rejects":
        throw this.transitionWaitExpiredError(transition.kind);
      case "forcesTheTransportClosed":
        this.forceCloseAbandonedTeardown();
        return this.abandonedTransitionValue(transition);
      case "declinesAndReturns":
        return this.abandonedTransitionValue(transition);
      default: {
        const unhandled: never = disposition;
        throw new Error(
          `unhandled abandoned-transition disposition ${String(unhandled)}`,
        );
      }
    }
  }

  // The nothing-happened value a kind whose disposition returns one carries. The
  // disposition record and the transition union have to agree about which kinds
  // carry it; disagreement is a mistake in this file rather than a runtime state,
  // so it is checked here instead of asserted in the record's comment.
  private abandonedTransitionValue<T>(transition: SessionTransition<T>): T {
    if (!("abandoned" in transition))
      throw new Error(
        `the ${transition.kind} session transition's stated abandon disposition ` +
          `returns its own value, but the transition carries none`,
      );
    return transition.abandoned();
  }

  // The abandon of a wait that has no benign value to report: a dial cannot report
  // a session it did not establish. Names the bound, and is deliberately distinct
  // from the teardown latch's "already been closed" refusal -- that connection was
  // closed on purpose, whereas this one was never opened.
  private transitionWaitExpiredError(kind: SessionTransitionKind): Error {
    return new Error(
      `this SFTP connection's ${kind} waited ` +
        `${TRANSITION_ACQUIRE_TIMEOUT_MS} ms for the session transition ahead ` +
        `of it and gave up: a dial cannot run alongside another transition on ` +
        `the one shared client, so nothing was dialed. Open a new connection ` +
        `to retry.`,
    );
  }

  // Whether ssh2-sftp-client is holding an SFTP session. It clears the property on
  // a clean close and on a server-side drop, so a truthy reading is a session an
  // operation can still be admitted onto -- and one the server can still drop.
  private hasLiveSession(): boolean {
    return Boolean((this.client as unknown as Ssh2SftpClientInternals).sftp);
  }

  // The chokepoint: every call this adapter makes into ssh2-sftp-client's
  // connect() or end(), and every teardown it drives on the ssh2 Client or the
  // socket beneath it, runs inside the session transition that OWNS it. Three call
  // sites, one per mechanism, so the property is confirmable by grepping for the
  // mechanisms themselves.
  //
  // It takes the transition it is called from and compares identity, not "some
  // transition is running": the one mechanism that runs while another transition
  // holds the client is the abandoned teardown's forced close, which carries its
  // own narrow exemption below, and against a mere presence check that mechanism
  // would pass here while violating the very property being checked.
  private assertTransitionHeld(
    mechanism: string,
    held: HeldSessionTransition,
  ): void {
    if (this.transitionInProgress === held) return;
    throw new SessionTransitionViolationError(
      `${mechanism} was driven outside the SFTP session transition that owns ` +
        `it; every dial and every close of this adapter's session runs inside ` +
        `the runTransition call that acquired for it, so that two can never ` +
        `overlap on the one shared client`,
    );
  }

  // The single exemption from the check above, in its narrowest form. A teardown
  // that gave up its wait drives the forced transport close while the transition it
  // was waiting for still holds the client -- deliberately, because that destroy
  // needs nothing from the peer and settles the very dial being waited on. What
  // makes it safe is the teardown latch, not the destroy's own harmlessness: end()
  // latches before it enqueues, so every transition BEHIND this teardown skips its
  // body and the holder ahead of it is the only one that can be running. That
  // premise is the check.
  private assertAbandonedTeardownMayForceClose(): void {
    if (this.closing) return;
    throw new Error(
      `an abandoned teardown's forced transport close was driven with no ` +
        `teardown latched; it is exempt from the held-transition check only ` +
        `because end() latches before it enqueues, which is what keeps every ` +
        `transition behind it from running a body alongside this close`,
    );
  }

  /**
   * Wrap {@link retryPromise} for a data operation so each re-attempt (every
   * invocation of `fn` past the first) bumps {@link transportRetries}. Surfaces
   * how often an operation was re-issued over the run for the metrics summary,
   * reusing the operation's own retry loop rather than adding parallel state.
   */
  private countedOperationRetry<T>(
    fn: () => Promise<T>,
    retries: number,
    delay: number,
    shouldRetry: (error: unknown) => boolean,
  ): Promise<T> {
    let attempted = false;
    return retryPromise(
      () => {
        if (attempted) this.transportRetries += 1;
        attempted = true;
        return fn();
      },
      retries,
      delay,
      shouldRetry,
    );
  }

  // The heartbeat's no-op keepalive: a single realPath(".") -- the cheapest real
  // SFTP round-trip, which (unlike an SSH/TCP keepalive) resets the server's
  // SFTP-command idle timer. Bounded by the same per-op deadline as the metadata
  // ops so a dead or hostile session cannot leave the keepalive hanging; the
  // heartbeat swallows the outcome, so this bound never surfaces to the exchange.
  // Not routed through tracked(): the heartbeat owns its own in-flight state
  // (`pinging`) and only ever pings when no tracked op is running.
  private sendKeepalive(): Promise<void> {
    // Don't issue a keepalive on a session already known dead, mirroring the entry
    // guard every other server-driven op carries. The fatal-'error' path also stops
    // the heartbeat, so a beat should never reach here after a fatal error; this
    // keeps the invariant uniform (and robust to any future change in that ordering)
    // rather than posting realPath onto a destroyed channel. The heartbeat swallows
    // the rejection, so it never surfaces to the exchange.
    const dead = this.deadSessionError("keepalive", ".");
    if (dead) return Promise.reject(dead);
    return withSftpOperationDeadline(
      this.client.realPath(".").then(() => {}),
      this.stallDeadlineMs,
      () =>
        transportOperationStalledError(
          "keepalive",
          ".",
          `did not complete within ${this.stallDeadlineMs} ms (the server ` +
            `withheld the realPath response)`,
        ),
    );
  }

  // Bracket a server-driven operation with the heartbeat's activity accounting:
  // opStarted before it runs, opSettled when it settles (either way). This both
  // resets the idle window on real traffic and marks the session busy, so the
  // heartbeat never issues a concurrent keepalive while an operation is on the
  // wire. finally() preserves the operation's value and rejection unchanged. The
  // epoch token opStarted returns is handed back to opSettled so an op whose session
  // was torn down mid-flight (a reconnect advanced the heartbeat's epoch) cannot
  // decrement the new session's in-flight count when it finally settles.
  private tracked<T>(op: Promise<T>): Promise<T> {
    const epoch = this.heartbeat.opStarted();
    return op.finally(() => this.heartbeat.opSettled(epoch));
  }

  // Layers the non-fatal slow-operation warning (observability) over an in-flight
  // operation. Strictly above the terminal bounds: the per-operation read
  // deadlines and the consumer-layer whole-exchange budget are what fail a stalled
  // op; this only surfaces "still working" to a watching operator, with cheap
  // observed progress where one exists. See withSlowOperationWarning.
  private warnIfSlow<T>(
    op: Promise<T>,
    operation: string,
    path: string,
    progress?: (elapsedMs: number) => string,
  ): Promise<T> {
    return withSlowOperationWarning(op, {
      operation,
      path,
      log: this.log,
      progress,
    });
  }

  // Bound a single-round-trip server-driven operation by the per-operation
  // wall-clock deadline, surfacing the typed terminal TransportOperationStalledError
  // when the server withholds its callback past the bound. `response` names what the
  // server failed to send (e.g. "rename", "delete", "stat"), filled into the
  // standard "withheld the <response> response" detail. The metadata write/stat/
  // delete ops (rename/delete/exists) and createExclusive all bound a single
  // round-trip this way; put() instead uses the progress-based idle window
  // (createBoundedPutSource), because a large legitimate upload can exceed a flat
  // deadline while still progressing.
  private boundByDeadline<T>(
    promise: Promise<T>,
    operation: string,
    path: string,
    response: string,
  ): Promise<T> {
    return withSftpOperationDeadline(promise, this.stallDeadlineMs, () =>
      transportOperationStalledError(
        operation,
        path,
        `did not complete within ${this.stallDeadlineMs} ms (the server ` +
          `withheld the ${response} response)`,
      ),
    );
  }

  // Attach a single guarded 'error' listener to the raw ssh2 SFTPWrapper.
  //
  // This and the other internal-ssh2 premises this adapter relies on are
  // enumerated, with the dependency source files to re-read and the
  // integration-test command to run, in the "Upgrading the SFTP Stack" checklist
  // in docs/spec/DEPENDENCY_PINS.md. Re-verify them on any ssh2 /
  // ssh2-sftp-client upgrade.
  //
  // ssh2's Client.sftp() attaches a setup-time 'error' listener to the wrapper
  // but strips it (removeListeners() inside onReady) before handing the wrapper
  // back, and ssh2-sftp-client attaches 'error' handlers only to the SSH Client
  // and to per-operation read/write streams -- never to the wrapper itself. So
  // after connect() the wrapper carries no 'error' listener. A hostile or dead
  // SFTP server (in scope under docs/spec/CHANNEL_SECURITY.md) that
  // returns a malformed SFTP reply packet drives ssh2's doFatalSFTPError ->
  // sftp.emit('error', err) on a listener-free EventEmitter, which Node turns
  // into an uncaught exception that crashes the CLI -- skipping lock/temp-file
  // cleanup and the typed exit-code mapping. The size guards bound memory and
  // the liveness guards bound time, but a crash is neither; this listener closes
  // that last hostile-server vector.
  //
  // Handling the 'error' leaves the session dead but the process alive. A fatal
  // packet that rides in on the in-flight request itself is not failed by ssh2's
  // cleanupRequests (that request's entry is already gone by then), so the
  // in-flight op hangs until this adapter's own 60 s wall-clock deadline fires --
  // the deadline, not cleanupRequests, is what bounds it, and it must not be
  // removed on the assumption that cleanupRequests covers in-flight ops. Capturing
  // the cause in fatalSftpError then bounds the NEXT op: it consults
  // deadSessionError at entry and rejects with the real reason instead of issuing
  // a request the dead wrapper can never answer.
  //
  // Guarding on the wrapper's object identity attaches exactly once per wrapper: a
  // repeated connect() on the same live wrapper is a no-op (no duplicate listener,
  // no MaxListenersExceeded warning), while the fresh wrapper a reconnect mints
  // gets its own listener.
  private attachFatalErrorListener(
    sftp: NonNullable<Ssh2SftpClientInternals["sftp"]>,
  ): void {
    if (this.guardedSftp === sftp) return;
    this.guardedSftp = sftp;
    this.fatalSftpError = undefined;
    sftp.on("error", (err: Error) => {
      this.fatalSftpError = err;
      // The session is dead: stop beating so the heartbeat does not keep issuing
      // realPath keepalives the destroyed channel can never answer. A later
      // connect() re-arms it via start(); a later end() calls stop() again (a
      // no-op once stopped).
      this.heartbeat.stop();
    });
  }

  // Answer the SSH server's keyboard-interactive authentication prompts with the
  // configured password. Enabled by connection.server.keyboard_interactive (core
  // sets `tryKeyboard` and keeps `password` in the connect options) for a server
  // that disables the direct `password` auth method but accepts the same secret
  // over keyboard-interactive.
  //
  // Attached to the underlying ssh2 Client (an EventEmitter) exactly once per
  // adapter; the Client is reused across reconnects, so the listener persists.
  // The password is read from the live connect options (this.options) at answer
  // time, NOT captured at attach time: connect() refreshes this.options on every
  // (re)connect, so the listener always answers with the CURRENT credential and a
  // future reconnect under a different credential can never be answered with a
  // stale secret (a check, not a comment, standing in for "the password never
  // changes across an adapter's reconnects"). A non-string password answers empty,
  // which fails auth cleanly rather than sending `undefined`; it is unreachable
  // from a product connect (the connect() gate attaches only when it saw a string
  // password, and reconnects reuse the same options). Every prompt is answered
  // with the same password: a non-interactive tool has a single stored secret, so
  // a genuine multi-prompt or one-time-code challenge is not satisfiable here and
  // simply fails auth (ssh2 auto-responds to a zero-prompt request itself, so this
  // listener only fires when the server actually asks). The password is passed
  // straight to ssh2's finish callback and never logged.
  //
  // Without this listener a server that requests keyboard-interactive would stall
  // the handshake until ssh2's readyTimeout (ssh2 emits the event and waits for a
  // response that never comes), so the connect-time guard fails loudly if the
  // ssh2 Client no longer exposes on() rather than letting that silent stall
  // return as an opaque timeout.
  private attachKeyboardInteractive(): void {
    if (this.keyboardInteractiveAttached) return;
    const client = (this.client as unknown as Ssh2SftpClientInternals).client;
    if (typeof client?.on !== "function")
      throw new Error(
        "keyboard-interactive authentication was requested " +
          "(connection.server.keyboard_interactive) but the underlying ssh2 " +
          "client does not expose on(); the installed ssh2 / ssh2-sftp-client " +
          "version may have changed - check for breaking changes in their " +
          "changelogs",
      );
    client.on(
      "keyboard-interactive",
      (_name, _instructions, _lang, prompts, finish) => {
        // Read the password fresh from the live connect options at answer time
        // (see the method comment): never a stale captured secret.
        const current = this.options?.password;
        const answer = typeof current === "string" ? current : "";
        // One answer per prompt: the SSH keyboard-interactive protocol requires
        // the response count to equal the prompt count (RFC 4256; the server
        // enforces it, not ssh2's authInfoRes). prompts is never empty here (ssh2
        // auto-responds to a zero-prompt request without emitting), so this always
        // answers at least once.
        finish(prompts.map(() => answer));
      },
    );
    this.keyboardInteractiveAttached = true;
  }

  // A terminal error built from a previously captured fatal SFTP-protocol error,
  // or undefined if the session has not been killed. Every server-driven operation
  // consults this at entry: a request buffered on a destroyed-but-socket-still-alive
  // channel never calls back, so without this guard the op would ride its full
  // per-operation bound before failing; consulting the captured error rejects at
  // once with the real cause instead. safeDelete shares the same fatalSftpError
  // check but RESOLVES (its never-reject contract); see it for why. A typed
  // TransportOperationStalledError (a UsageError) so the poll loop and the
  // rendezvous gate treat it as terminal, the same as every other liveness bound.
  private deadSessionError(
    operation: string,
    path: string,
  ): TransportOperationStalledError | undefined {
    if (this.fatalSftpError === undefined) return undefined;
    return transportOperationStalledError(
      operation,
      path,
      `the SFTP session was killed by a fatal server protocol error ` +
        `(${this.fatalSftpError.message})`,
    );
  }

  // The outermost layer around every server-driven op: it runs the op once and,
  // if that rejection is a CLEAN session loss, re-dials the connection ONCE and
  // re-issues the op ONCE before giving up. An SFTP server that enforces a
  // max-session or idle cap the operator cannot change drops the one long-lived
  // session mid-exchange (observed at ~10 min); recovery makes that drop
  // transparent by re-dialing (reusing the pinned host key and stored credentials,
  // no re-prompt) and re-running the operation.
  //
  // ONE round per op invocation, never a loop: if the re-issued op ALSO hits a
  // clean loss it rejects terminally. In the default held-session mode the
  // cumulative number of mid-exchange re-dials is bounded by max_reconnect_attempts
  // -- a budget SEPARATE from, and the same size as, the per-connect dialing-retry
  // loop inside connect(): once that many drops have been re-dialed this exchange,
  // the next drop fails terminally with an actionable message rather than
  // re-dialing (midExchangeReconnectBudgetExhaustedError). The count is strictly
  // cumulative and never resets on progress, because a session-capping server makes
  // progress every cycle and a reset-on-progress budget would never bound it. The
  // escape hatches are raising max_reconnect_attempts (a flaky link) and
  // connection-per-poll mode (a server that caps session lifetime), whose recovery
  // re-dials are left uncapped by this count in every phase -- the poll loop holds
  // no session across the idle gap, and the rendezvous that precedes it holds one
  // across its waits and needs the uncapped re-dial to survive a cap that cuts it.
  // Both are bounded instead by the peer-inactivity ceiling.
  // A teardown re-dial (abort marker / drain) is exempt so the fast-fail marker
  // still lands when the budget is spent. The op+re-dial is enclosed by
  // boundTransport's per-op peerTimeoutMs budget in core (a Promise.race), which is
  // the terminal ceiling against a pathological instant-drop server, so no bespoke
  // total-time timer is added here. Serial op issuance (single-party appliance)
  // guarantees no other tracked() op is in flight when the re-dial runs: the first
  // attempt's promise has already settled by the time this catch fires, so
  // connect()'s heartbeat re-arm never races a live op.
  //
  // `reissue` is applied ONLY on the re-issue, never the first attempt, so a
  // per-op idempotency relaxation (delete-absent, rename-dest-exists,
  // createExclusive-own-EEXIST) cannot leak into first-attempt semantics and
  // break genuine lock-conflict or absence detection. It defaults to re-running
  // the op verbatim.
  private withSessionRecovery<T>(
    op: () => Promise<T>,
    reissue: (op: () => Promise<T>) => Promise<T> = (run) => run(),
  ): Promise<T> {
    const gate = this.reestablishAfterIdleRelease();
    const first = gate === undefined ? op() : gate.then(op);
    return first.catch(async (error: unknown) => {
      if (!this.shouldRecoverFromSessionLoss(error)) throw error;
      // A teardown re-dial (the abort-marker write or the terminal-frame drain) is
      // exempt from the cap and neither counted nor warned; see the `tearingDown`
      // field and beginTeardown().
      const teardown = this.tearingDown;
      // Likewise a re-dial that follows this adapter's OWN idle-boundary release;
      // see the `sessionBoundary` field. Read BEFORE the re-dial, which discharges
      // the boundary: reading it afterwards would classify every deliberate release
      // as a drop -- the misreport this exists to stop. The release records the
      // boundary before it drives the close that tears this operation off the wire,
      // so an operation torn by it reads the boundary that tore it.
      const deliberateRelease = this.sessionBoundary === "deliberatelyReleased";
      // Cap the cumulative mid-exchange reconnections in the default held-session
      // mode: once max_reconnect_attempts drops have already been re-dialed this
      // exchange, refuse the next and fail terminally. Gated off in
      // connection-per-poll mode and for a teardown re-dial.
      if (
        !teardown &&
        !this.ephemeralSessions &&
        this.midExchangeRedials >= this.operativeMaxReconnectAttempts()
      )
        throw this.midExchangeReconnectBudgetExhaustedError();
      const redial = await this.redialForRecovery().catch(
        (redialError: unknown) => {
          // This re-dial can be the very dial an abandoning teardown destroyed the
          // transport beneath, and its rejection then reports a close of this
          // adapter's own as a partner-side one. Fall through to the closing branch
          // below, which surfaces the loss this recovery was for, rather than
          // replacing it with that error.
          if (this.abandonedTeardownClosedTransport)
            return "noSession" as RecoveryRedialOutcome;
          throw redialError;
        },
      );
      // end() may have latched `closing` while the re-dial held the transition
      // lock: join the teardown that will close the freshly-dialed session, so no
      // session outlives it, and surface the original loss rather than re-issuing
      // into a closing adapter.
      if (this.closing) {
        await this.end().catch(() => {});
        throw error;
      }
      // The re-dial could not clear a session held over an ended transport (it
      // warned, naming what broke), so there is nothing to re-issue onto: the
      // operation fails with the loss it already had.
      if (redial === "deadSessionHeld") throw error;
      // A re-dial that DECLINED -- it gave up its wait for the transition ahead of
      // it -- established nothing, so counting it would report a drop this adapter
      // recovered from when it recovered from nothing, and warn the operator about
      // a re-dial that never ran. The re-issue below still runs and rejects with
      // the real session-loss cause.
      if (redial === "sessionLive" && !teardown && !deliberateRelease) {
        // The re-dial re-established the dropped session: count it as a
        // reconnection so the operator's metrics show the exchange survived a
        // server-side drop. connect()'s own counter only bumps on an internal
        // retry past the first, so a re-dial that succeeds on its first attempt
        // registers zero without this. A teardown re-dial is counted in neither
        // metric -- it is teardown mechanics, not a survived mid-exchange drop.
        this.reconnectAttempts += 1;
        this.midExchangeRedials += 1;
        this.warnSessionRecovered();
      }
      return reissue(op);
    });
  }

  // The connection-per-poll session precondition, applied at withSessionRecovery --
  // the chokepoint the recovery-wrapped ops pass through. It is owned here, not by
  // the callers in core, because the release that creates the gap is owned here: a
  // precondition spread over call sites in another package is an invariant held by
  // discipline, and every site that forgets it (a send resuming from the protocol
  // continuation, a retain-mode ack write) reopens this hole.
  //
  // It runs at operation ENTRY, so it covers an operation ISSUED once a release
  // is RUNNING. Both readings below are written from inside the release's own
  // transition, so an operation issued while that release is still QUEUED behind
  // another transition reads neither and is issued against the still-live
  // session: it is in the on-the-wire class, not the covered one. Two operations
  // do not reach this gate at all -- safeDelete, whose never-reject contract puts
  // it outside recovery, and a put whose source cannot be re-issued (a one-shot
  // stream, or flags:"a") -- and no gate at entry can cover an operation already
  // on the wire when the release begins: that one is torn with the session, and
  // can fail terminally (see shouldRecoverFromSessionLoss).
  //
  // Returns undefined -- no gate, not even a microtask -- whenever the mode is off
  // or no release has intervened, so the default held-session mode runs exactly as
  // it did. Otherwise it re-establishes through ensureConnected before the first
  // attempt, which queues behind a release still in flight (an operation must not
  // race the close: ssh2-sftp-client clears its session property from the ssh2
  // Client's 'close', so in that window an operation is admitted by a session that
  // still reads live onto a transport end() has already ended -- it cannot
  // complete, and rides to the stall deadline, which is terminal). Re-establishing
  // here both keeps the deliberate release out of the recovery path's accounting
  // and spares one guaranteed-failed operation per idle gap.
  //
  // Best-effort by contract: a dial failure here resolves rather than rejecting,
  // because the gate is a precondition and not the operation -- the attempt that
  // follows is what decides the outcome, and its own recovery round surfaces a
  // transient failure with the real error rather than this one. Nothing is
  // swallowed for good -- a fatal dial condition (a host-key rejection) surfaces one
  // step later out of the recovery path's own dial, which is what keeps the
  // fail-closed host-key behavior.
  private reestablishAfterIdleRelease(): Promise<void> | undefined {
    // Both readings are the release's to set, and the release returns before
    // enqueuing when the mode is off, so the default held-session mode takes this
    // return every time without a mode check of its own. The first covers the
    // close window itself, including a release the PEER began (which records no
    // boundary); the second covers the gap after a release completed, sparing the
    // one attempt that would be guaranteed to fail on the session it closed.
    if (
      this.transitionInProgress?.kind !== "releaseForIdle" &&
      this.sessionBoundary !== "deliberatelyReleased"
    )
      return undefined;
    return this.ensureConnected().then(
      () => {},
      () => {},
    );
  }

  // The operative mid-exchange reconnection budget: the max_reconnect_attempts
  // value the last connect() ran with, defaulting to
  // DEFAULT_MAX_RECONNECT_ATTEMPTS. Read from the retained original connect options
  // so withSessionRecovery's cap and connect()'s dialing-retry loop draw the same
  // number from one place.
  private operativeMaxReconnectAttempts(): number {
    return (
      (this.originalConnectOptions?.["maxReconnectAttempts"] as
        number | undefined) ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    );
  }

  // The terminal error surfaced when the cumulative mid-exchange reconnection
  // budget (max_reconnect_attempts) is exhausted in the default held-session mode.
  // A UsageError so every op path treats it as terminal -- the poll loop stops on a
  // UsageError, and the consume-delete retry rethrows one rather than swallowing it
  // as a transient hiccup -- and so the CLI maps it to a non-zero exit. The message
  // names the partner-server drop, states the exhausted budget, and gives the two
  // remedies by their operator-reachable names (the flag and the config field); it
  // carries no partner-controlled text. A budget of zero gets its own opening
  // clause: it permits no reconnection at all, so "re-dialed the maximum 0 times"
  // would misdescribe an exchange whose very first drop is terminal.
  private midExchangeReconnectBudgetExhaustedError(): UsageError {
    const max = this.operativeMaxReconnectAttempts();
    const budgetClause =
      max === 0
        ? `max_reconnect_attempts=0 permits no mid-exchange reconnection, so ` +
          `this first drop is terminal and the exchange cannot continue`
        : `has already been transparently re-dialed the maximum ${max} times ` +
          `allowed by max_reconnect_attempts=${max}, so the mid-exchange ` +
          `reconnection budget is exhausted and the exchange cannot continue`;
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

  // Surface a transparently-recovered mid-exchange session drop to the operator at
  // default verbosity: silent recovery would hide a partner whose SFTP server
  // chronically caps session lifetime, exactly the case this feature exists for.
  // Warn on the FIRST re-dial and on every SFTP_REDIAL_WARN_INTERVAL-th after it,
  // so a chronic capper stays visible without a warn line every poll cycle; in the
  // default mode also warn on the LAST re-dial the budget permits, because with a
  // budget below that interval (the default 3 is) the escalation step never fires
  // and the operator would otherwise go from one early warning straight to the
  // terminal error. Each message then reads the re-dial in the mode the operator is
  // running -- the two differ in likely cause, remedy, and bound, so one blended
  // line would misdescribe both:
  //   Default: the drop is the classic partner-side session cap, the remedy is
  //   --connection-per-poll, and the remaining budget is stated so "the exchange
  //   continues" is not read as open-ended (exhausting it is terminal, see
  //   midExchangeReconnectBudgetExhaustedError).
  //   Connection-per-poll: the mode's own idle release never reaches this warning
  //   (withSessionRecovery exempts it), but the two remaining causes are not
  //   distinguishable from inside the adapter -- the per-cycle session lifetime is
  //   a property of the POLL LOOP, and the rendezvous that precedes it holds one
  //   session across its waits, so a cap can cut either. Both are named with the
  //   remedy for each, and the rendezvous case is called out as the mode working
  //   so an operator who chose it for a capping server is not sent after their
  //   link. It quotes no budget (the cap does not charge this mode) and names the
  //   per-operation peer-inactivity ceiling that does bound it.
  // Nothing beyond that is disclosed.
  private warnSessionRecovered(): void {
    const count = this.midExchangeRedials;
    if (this.ephemeralSessions) {
      if (count !== 1 && count % SFTP_REDIAL_WARN_INTERVAL !== 0) return;
      this.log.warn(
        `The SFTP session dropped mid-exchange and was transparently re-dialed ` +
          `(${count} so far this exchange); the exchange continues. ` +
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
          "making progress.",
      );
      return;
    }
    const budget = this.operativeMaxReconnectAttempts();
    const remaining = Math.max(budget - count, 0);
    if (
      count !== 1 &&
      remaining !== 0 &&
      count % SFTP_REDIAL_WARN_INTERVAL !== 0
    )
      return;
    const recovered =
      count === 1
        ? "The SFTP session dropped mid-exchange and was transparently " +
          "re-dialed; the exchange continues."
        : `The SFTP session has now dropped and been transparently re-dialed ` +
          `${count} times this exchange; each drop was recovered and the ` +
          `exchange continues.`;
    const budgetLeft =
      remaining === 0
        ? `That was the last re-dial allowed by ` +
          `max_reconnect_attempts=${budget}: the next mid-exchange drop ends ` +
          `the exchange.`
        : `${remaining} further mid-exchange re-dial` +
          `${remaining === 1 ? " is" : "s are"} allowed by ` +
          `max_reconnect_attempts=${budget} before the exchange fails.`;
    this.log.warn(
      `${recovered} This is typically the partner's SFTP server enforcing a ` +
        `session-duration or idle limit you cannot change. Because the default ` +
        `mode holds one SFTP session open for the whole exchange, it will keep ` +
        `recurring regardless of your settings; --connection-per-poll, which ` +
        `dials a fresh session each poll cycle instead of holding one, is the ` +
        `real fix for that case, and a longer poll interval ` +
        `(--polling-frequency) helps only if the server is instead reacting to ` +
        `how often this exchange queries it. ${budgetLeft}`,
    );
  }

  // Decide whether an op rejection is the session loss recovery re-dials on. Every
  // condition is post-state, not error-message matching: ssh2-sftp-client clears
  // its `sftp` session property on a clean close/end (its per-operation temp
  // listeners null it on either event, its global one only on 'close'), so a
  // cleared property is the reliable signal that the session dropped -- unifying
  // the adapter's own `!sftp` throw in list()/createExclusive() with
  // ssh2-sftp-client's ERR_NOT_CONNECTED ("No SFTP connection available")
  // rejection on the high-level get/put/delete/rename/exists. Terminal (never
  // re-dialed), in order:
  //   - a teardown is latched, or no connect has succeeded yet (nothing to re-dial
  //     with);
  //   - a fatal SFTP protocol error killed the session (the wrapper is destroyed
  //     and cannot recover -- fatalSftpError, deadSessionError());
  //   - a memory bound (FrameSizeExceededError / DirectoryListingBoundsError),
  //     whose re-issue would re-read the very oversized reply the bound refused;
  //   - a rejection against a session that is still live over a transport that is
  //     still live too: an app-level failure or a stall, not a loss. Re-dialing on
  //     a stall would hand a withholding server a free liveness reset, so a
  //     timeout over a live transport is never a reconnect trigger;
  //   - a liveness stall on a CLEARED session, for the same reason.
  // A live session over an ENDED transport is the one reading that is a loss
  // whatever the operation rejected with. The transport can carry nothing, so the
  // rejection is the deadline's whichever way it came, and the session property
  // says only that no 'close' reached ssh2-sftp-client's global listener to clear
  // it -- which a partner that drops the SFTP session and withholds its connection
  // close produces on the pinned versions (see docs/spec/DEPENDENCY_PINS.md).
  // Recovering it means clearing that session first, which is the re-dial's own
  // forced close (see redialForRecovery).
  //
  // An op ISSUED once a connection-per-poll release is RUNNING reaches none of
  // these readings: withSessionRecovery's gate waits the release out and
  // re-establishes before the first attempt. An op ALREADY ON THE WIRE when that
  // release begins is torn with the session -- no entry gate covers it, and
  // neither does one issued while the release is still queued, which is the same
  // class -- and at the pinned versions that tear reads as the loss it is, for a
  // narrower reason than the transport event alone: ssh2 fails outstanding channel
  // requests ONLY from the socket's 'close' handler (the socket's 'end' emits and
  // cleans the protocol up but leaves them outstanding), and it does so after its
  // own emit('close') has already run. Both ssh2-sftp-client listeners that emit
  // reaches -- the per-operation temp closeListener and the constructor's global
  // one -- clear `sftp`, so by the time the rejection is delivered the session
  // always reads cleared. Its global 'end' listener does NOT clear `sftp`, which
  // is a separate premise the release's peer-teardown check rests on (see
  // releaseForIdle).
  //
  // A host-key mismatch on the re-dial is terminal for free: it surfaces inside
  // redialForRecovery -> connectLocked, whose retry predicate already treats "Host
  // denied" as terminal, so the rejection propagates rather than being re-issued.
  private shouldRecoverFromSessionLoss(error: unknown): boolean {
    if (this.closing) return false;
    if (this.originalConnectOptions === undefined) return false;
    if (this.fatalSftpError !== undefined) return false;
    if (error instanceof FrameSizeExceededError) return false;
    if (error instanceof DirectoryListingBoundsError) return false;
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    if (internals.sftp) return this.sessionTransportEnded(internals);
    if (error instanceof TransportOperationStalledError) return false;
    return true;
  }

  // Whether the transport under the current session has ended, either half of it.
  // ssh2 ends its own socket when the server drops the SFTP session with an
  // SSH_MSG_DISCONNECT (`writableEnded`), and Node sets `readableEnded` once the
  // peer's FIN has been consumed; either way the transport can carry nothing more,
  // so an operation issued on it cannot complete. Both flags are plain net.Socket
  // properties, read through the one ssh2 internal beneath them (`client._sock`,
  // the same seam connect()'s keepalive backstop reaches and warns about when it
  // has moved): a socket that reports neither reads as not-ended, which leaves the
  // rejection terminal exactly as it is without this reading.
  private sessionTransportEnded(internals: Ssh2SftpClientInternals): boolean {
    const socket = internals.client?._sock;
    return socket?.writableEnded === true || socket?.readableEnded === true;
  }

  // A session ssh2-sftp-client still reports as live over a transport that has
  // ended -- the state a partner that drops the session while withholding its
  // close leaves behind, and the one an operation must not be re-issued onto.
  private holdsSessionOverEndedTransport(): boolean {
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    return Boolean(internals.sftp) && this.sessionTransportEnded(internals);
  }

  // Re-dial the dropped session with the full original options. It must go
  // through the same locked dial sequence connect() runs, never a bare
  // client.connect(): that sequence re-runs on the FRESH wrapper -- re-attaching
  // the guarded fatal-'error' listener (a listener-free wrapper would turn the
  // next malformed packet into a process crash), clearing fatalSftpError,
  // re-running the enforcing fail-closed host-key verifier that rides the options,
  // re-verifying the raw sftp methods, advancing the heartbeat epoch, and
  // re-applying setNoDelay/keepalive. The dead client is NOT end()'d first:
  // ssh2-sftp-client's end() would latch its endCalled flag, permanently disabling
  // the global 'close' listener that clears this.sftp -- which would stop a LATER
  // idle drop from being detected and defeat recovery of the repeated drops this
  // targets. The dial runs only over a CLEARED session, which is what keeps
  // ssh2-sftp-client's "already connected" guard from firing: a loss that left the
  // session property set is cleared by the forced close below before the dial, and
  // a forced close that did not clear it does not reach the dial at all.
  //
  // The whole precondition runs INSIDE the transition, not at the acquire: the
  // retained connect options are written by connectLocked, which is another
  // transition's body, so reading them from outside the lock reads state a
  // transition owns and can be stale by the time this one runs -- a concurrently
  // requested re-dial would then be refused before it ever took a queue slot. The
  // acquire itself stays synchronous (runTransition takes the slot with no
  // preceding await), so request order is unchanged.
  //
  // Reports what the caller is left to do with the operation it was recovering
  // (see RecoveryRedialOutcome), which is what keeps a re-dial that established
  // nothing out of the reconnect counters and the operator warning: both the
  // declined forms -- a teardown latched ahead of it, and a wait it gave up --
  // establish none.
  private redialForRecovery(): Promise<RecoveryRedialOutcome> {
    return this.runTransition<RecoveryRedialOutcome>({
      kind: "redialForRecovery",
      skipped: () => "noSession",
      // Silently, and that is the point: the operation this was recovering then
      // rejects with the real session-loss cause rather than with a timeout of
      // this transition's that would hide it. A session still held over an ended
      // transport is the one state that has no such cause to reject with -- the
      // re-issue would ride the liveness deadline again -- so it is reported for
      // what it is instead.
      abandoned: () =>
        this.holdsSessionOverEndedTransport() ? "deadSessionHeld" : "noSession",
      run: async (held) => {
        const internals = this.client as unknown as Ssh2SftpClientInternals;
        // A session can be live by the time this reaches the front of the queue --
        // a cycle-start or concurrent dial landed, or the release's close backstop
        // expired with the session still set -- and the dial rejects outright when
        // one is set, so leave the re-issue to run on it. Unless its transport has
        // ended, in which case the session is the loss the gate read it as and the
        // re-issue has nothing to run on.
        if (internals.sftp && !this.sessionTransportEnded(internals))
          return "sessionLive";
        const options = this.originalConnectOptions;
        if (options === undefined)
          throw new Error(
            "SFTP session recovery reached the re-dial with no retained connect " +
              "options; a server-driven operation ran before connect()",
          );
        // Stop the heartbeat left armed by the dropped session before dialing: a
        // clean drop (unlike a fatal error) does not stop it, so its old timer
        // could otherwise tick mid-handshake and post a realPath keepalive on the
        // client while the dial re-establishes it -- a concurrent op. It precedes
        // the forced close below for the same reason it precedes the dial: nothing
        // may keep pinging a transport this is about to destroy. Under the lock and
        // immediately ahead of both, rather than at the acquire: the heartbeat is
        // another transition's to arm, and stopping it from outside would leave a
        // queued re-dial silencing a session a transition ahead of it had just
        // re-established. That transition is a teardown or another re-dial (the
        // mode that arms a heartbeat at all runs no cycle-boundary transitions),
        // each of which stops the heartbeat in its own body. The dial re-arms a
        // fresh one via start() at the end of its sequence.
        this.heartbeat.stop();
        if (
          internals.sftp &&
          !(await this.clearSessionOverEndedTransport(held, internals))
        )
          return "deadSessionHeld";
        await this.connectLocked(options, held);
        return "sessionLive";
      },
    });
  }

  // The partner dropped the SFTP session and withheld its connection close, so the
  // transport is ended with ssh2-sftp-client's session property still set: it can
  // carry nothing, and the library clears that property only from the ssh2 Client's
  // 'close'. Force the socket closed so that 'close' fires and the session clears,
  // leaving the re-dial the cleared session it requires. The mechanism is the
  // connection-per-poll release's ({@link forceCloseEndedTransport}); the
  // accounting is not -- this boundary is a partner-side drop, counted and warned
  // as one by the recovery path, never as an idle release.
  //
  // Reports whether the session cleared. Every way the forced close itself can
  // fail warns, naming what broke and this project's upgrade checklist, and leaves
  // the operation to fail with the loss it was already failing with: recovery that
  // cannot clear the session degrades to the terminal outcome it had before, and
  // must not replace the operation's own error with one of its own.
  private async clearSessionOverEndedTransport(
    held: HeldSessionTransition,
    internals: Ssh2SftpClientInternals,
  ): Promise<boolean> {
    const seams = this.resolveEndedTransportCloseSeams(internals);
    if ("missing" in seams) {
      this.log.warn(
        `The partner's SFTP server dropped the session mid-exchange without ` +
          `closing the connection, and re-dialing it means closing that ` +
          `connection from this side, which drives ssh2's ${seams.missing} -- ` +
          `not available after connect(), so the dropped session cannot be ` +
          `cleared and the operation fails. The installed ssh2 / ` +
          `ssh2-sftp-client version may have renamed, relocated, or removed it ` +
          `- re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return false;
    }
    try {
      if (await this.forceCloseEndedTransport(held, internals, seams))
        return true;
    } catch (error: unknown) {
      // This catch is for net.Socket's destroy() raising synchronously into the
      // recovery. The chokepoint check reached through the same call is not that,
      // and degrading it to the warning below would hand the operator a report of
      // the PARTNER's server for a violation on this side.
      if (error instanceof SessionTransitionViolationError) throw error;
      this.log.warn(
        `Closing the SFTP connection from this side, to re-dial a session the ` +
          `partner's server dropped without closing the connection, failed: ` +
          `${sanitizeErrorForDisplay(error)}. The dropped session cannot be ` +
          `cleared, so the operation fails; the installed ssh2's transport may ` +
          `no longer accept the destroy that drives the client 'close' - ` +
          `re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return false;
    }
    this.log.warn(
      `The SFTP session did not clear within ${FORCED_CLOSE_TIMEOUT_MS} ms of ` +
        `this side closing the transport the partner's server left ended, so ` +
        `the mid-exchange re-dial cannot run and the operation fails; the ` +
        `installed ssh2 may no longer emit the client 'close' that clears it - ` +
        `re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
        `checklist in docs/spec/DEPENDENCY_PINS.md`,
    );
    return false;
  }

  // SSH_FX_NO_SUCH_FILE: the source-absent status ssh2-sftp-client surfaces as the
  // raw numeric SFTP code 2 (through fmtError, the same passthrough createExclusive
  // and rename read), or as the POSIX string "ENOENT" if a future version
  // normalizes it. The recovery resolvers for delete and rename read it to tell a
  // pre-drop attempt that already LANDED (the source is now gone) from a genuine
  // absence.
  private isNoSuchFileError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return code === 2 || code === "ENOENT";
  }

  connect(options: Record<string, unknown>): Promise<void> {
    return this.runTransition({
      kind: "connect",
      // Single-use once end() has run: the connection's terminal close is memoized
      // and never cleared (see the class `terminalClose` field), so a session
      // dialed after it would answer a later close() from that settled memo
      // without ever driving client.end() -- leaving a live session and a ref'd
      // socket behind. Refusing the dial is the alternative to clearing the memo,
      // which would cost the once-per-connection guarantees the close rests on.
      skipped: () => {
        throw new Error(
          "this SFTP connection has already been closed; a closed connection " +
            "cannot be reopened - open a new one instead",
        );
      },
      run: (held) => this.connectLocked(options, held),
    });
  }

  // The dial sequence, run by whichever session transition holds the lock: the
  // public connect() acquires for it, and the two re-dial transitions call it
  // while already holding (the lock is not reentrant, so neither may re-enter
  // through connect()).
  private async connectLocked(
    options: Record<string, unknown>,
    held: HeldSessionTransition,
  ): Promise<void> {
    this.assertTransitionHeld("ssh2-sftp-client's connect()", held);
    this.originalConnectOptions = options;
    const maxReconnects = this.operativeMaxReconnectAttempts();
    // Exclude the psilink-specific key before handing options to ssh2.
    // FileTransportClient uses Record<string,unknown> so the interface stays
    // transport-agnostic; cast here is intentional.
    const { maxReconnectAttempts: _, ...rest } = options;
    const connectOptions = rest as Ssh2SftpClient.ConnectOptions;
    this.options = connectOptions;
    // Install the keyboard-interactive answer handler BEFORE connecting, so it is
    // registered by the time ssh2 negotiates auth. core sets tryKeyboard only
    // alongside a password (schema-refined), so the password guard here is a
    // belt-and-suspenders backstop for a direct adapter caller: with no password
    // there is nothing to answer prompts with, so the handler is skipped and the
    // method falls through to whatever other auth (if any) the options carry,
    // rather than answering with an empty string.
    if (
      connectOptions.tryKeyboard === true &&
      typeof connectOptions.password === "string"
    )
      this.attachKeyboardInteractive();
    // Count each re-attempt (every re-dial past the first) as a reconnect, for
    // the metrics summary; the flag ties the count to the retry loop's own
    // re-issue decision without a separate counter.
    let connectAttempted = false;
    await retryPromise(
      () => {
        if (connectAttempted) this.reconnectAttempts += 1;
        connectAttempted = true;
        return this.client.connect(connectOptions);
      },
      maxReconnects,
      1_000,
      (err) => {
        // The teardown latch, read BETWEEN attempts for the same reason
        // runTransition reads it before a transition's body: once end() has
        // latched, nothing may establish a session the teardown will not close. It
        // is what stops the abandoning teardown's forced destroy from being undone
        // by this loop -- the destroy cuts the attempt short with an unexpected
        // close, and a re-attempt mints a FRESH socket, keeping a torn-down
        // connection and a process that exits by drain alive for the remainder of
        // the dial budget (measured: a re-dial 1 s after the destroy, on a socket
        // reading writable again).
        if (this.closing) return false;
        // Host-key verification failure is terminal: the server is actively
        // presenting a different or unknown key, so retrying the key exchange
        // against the same server changes nothing. ssh2's "Host denied
        // (verification failed)" is wrapped by ssh2-sftp-client as a new Error
        // with the same message (prefixed with the listener context); match on the
        // stable message fragment from kex.js rather than a code that is not set
        // on the error object.
        return !(err instanceof Error && err.message.includes("Host denied"));
      },
    );

    const internals = this.client as unknown as Ssh2SftpClientInternals;

    // Disable Nagle's algorithm on the established client socket. The rendezvous
    // protocol is a long run of small, latency-bound request/response round trips;
    // with Nagle on, each can collide with the peer's TCP delayed-ACK and stall up
    // to ~40 ms on Linux (it does not surface on macOS loopback), compounding
    // across the many round trips an exchange performs. ssh2 leaves the client
    // socket at the kernel default (Nagle on) and never calls setNoDelay itself,
    // so drive its public setNoDelay here. connect() reruns on each reconnect and
    // ssh2 mints a fresh socket per attempt, so the setting is re-applied to every
    // socket, not just the first. Guarded and non-fatal: TCP_NODELAY is a latency
    // optimization, not a correctness requirement, so a future upstream that drops
    // the method must degrade to slower-but-correct, not fail to connect.
    if (typeof internals.client?.setNoDelay === "function") {
      internals.client.setNoDelay(true);
    } else {
      this.log.warn(
        "ssh2's client.setNoDelay() is not available after connect(); the SFTP " +
          "client socket keeps Nagle enabled and may incur per-round-trip " +
          "latency. Check the ssh2 / ssh2-sftp-client changelog.",
      );
    }

    // Enable kernel TCP keepalive on the established socket as the transport-layer
    // backstop beneath the application heartbeat below: it keeps NAT/firewall flow
    // state warm and lets the kernel detect a silently dead peer, but does NOT
    // reset the server's SFTP-command idle timer (that is what the heartbeat's
    // realPath is for). ssh2 exposes setNoDelay but not setKeepAlive, so reach the
    // Client's underlying net.Socket (`_sock`) directly, the same access-past-the-
    // public-API premise the fatal-'error' guard and createExclusive rely on
    // (re-verify on any ssh2 upgrade per the DEPENDENCY_PINS.md checklist). connect()
    // reruns on each reconnect against a fresh socket, so this re-applies every
    // time. Guarded and non-fatal, exactly like setNoDelay: keepalive is transport
    // hygiene, not a correctness requirement, so an upstream that relocates the
    // socket must degrade to no-keepalive, not fail to connect.
    const rawSocket = internals.client?._sock;
    if (typeof rawSocket?.setKeepAlive === "function") {
      rawSocket.setKeepAlive(true, SFTP_TCP_KEEPALIVE_DELAY_MS);
    } else {
      this.log.warn(
        "ssh2's underlying client socket (_sock.setKeepAlive) is not available " +
          "after connect(); the SFTP connection runs without kernel TCP " +
          "keepalive (the application heartbeat still defeats the server idle " +
          "timeout). Check the ssh2 / ssh2-sftp-client changelog.",
      );
    }

    // Verify that the sftp session required by createExclusive is available.
    // Run this once after retryPromise resolves rather than inside its
    // callback so an API breakage (a permanent failure mode) does not consume
    // the retry budget with no chance of self-resolving.
    const { sftp } = internals;
    if (!sftp)
      throw new Error(
        "ssh2-sftp-client 'sftp' session property is not available " +
          "after connect(); the installed version may no longer expose " +
          "it - check for breaking changes in the ssh2-sftp-client " +
          "changelog",
      );
    // createExclusive() and list() reach past the public API to drive the
    // SFTPWrapper directly (exclusive create, and bounded streamed directory
    // reads, have no public-API equivalent). Verify every method those paths
    // call is present and callable now, so an upstream rename surfaces as one
    // actionable error here at connect time rather than as a TypeError at the
    // first send()/poll -- this is the connect-time guard those methods'
    // comments promise. A bare `!sftp` check would let a renamed method slip
    // through to first use.
    for (const method of ["open", "close", "opendir", "readdir"] as const) {
      if (typeof sftp[method] !== "function")
        throw new Error(
          `ssh2-sftp-client internal SFTP session no longer exposes a ` +
            `callable '${method}()' after connect(); the installed version ` +
            `may have renamed or removed it - check for breaking changes in ` +
            `the ssh2-sftp-client changelog`,
        );
    }
    // The connection-per-poll idle release reaches past the public API for seams
    // of its own; verify them here on the same terms and for the same reason,
    // while the mode that drives them is the mode being connected. The default
    // held-session mode reaches them only at teardown, where an unavailable seam
    // degrades to a warning, so it is not held to them at dial time.
    if (this.ephemeralSessions) {
      const seams = this.resolveTransportCloseSeams(internals);
      if ("missing" in seams) throw this.transportCloseSeamError(seams.missing);
    }
    // Attach the guarded fatal-'error' listener to the raw wrapper now, while it
    // is known present and callable, so a malformed server reply can never crash
    // the process. See attachFatalErrorListener for the full rationale and the
    // reconnect/idempotency analysis.
    this.attachFatalErrorListener(sftp);
    // The session is established: arm the keepalive heartbeat so a long idle
    // stretch (a PSI round on the computing side) does not let the server's idle
    // timeout drop it. start() resets the idle clock, so a reconnect re-arms
    // cleanly. It is torn down by end() and by the fatal-'error' guard. Skipped in
    // ephemeral-session mode: in the POLL LOOP each cycle's session lives only for
    // its op batch (seconds) and is released before the idle gap, so there is no
    // held session to keep warm. The rendezvous that precedes the loop does hold one
    // session across its waits, un-heartbeated, and that is accepted rather than
    // fixed -- a keepalive defeats only an idle timer and is powerless against the
    // maximum-session-lifetime caps this mode exists for, while the mode's uncapped
    // recovery re-dials carry the rendezvous across a cap-forced drop (the
    // uncapped-recovery unit case in test/unit/ssh2SftpAdapter.test.ts, driven end
    // to end in test/integration/ephemeralSessionExchange.test.ts).
    if (!this.ephemeralSessions) this.heartbeat.start();
    // Discharge the idle-boundary release (see the `sessionBoundary` field): LAST
    // and on success only, so a dial that threw above leaves the release standing
    // for the next op to re-establish on rather than reporting it as a drop.
    held.recordBoundary("notReleased");
  }

  /**
   * Marks the start of the connection's close()/teardown (see the class
   * `tearingDown` field). Core calls it at the top of close() so the
   * terminal-frame drain re-dial is teardown-classified, and the authenticated
   * abort-marker write calls it before issuing its put() -- which can race close()
   * -- so whichever teardown op re-dials first is still exempt from the
   * mid-exchange reconnection cap and neither counted nor warned. An idempotent
   * latch; the connectionless transports do not implement it (it is optional on
   * {@link FileTransportClient}).
   */
  beginTeardown(): void {
    this.tearingDown = true;
  }

  /**
   * Ends the connection for good (see {@link FileTransportClient.end}).
   *
   * Closing an SFTP connection is a two-party act: this side disconnects and the
   * server closes the connection. ssh2-sftp-client's `end()` settles only from
   * the ssh2 Client's `'close'`, which a partner that accepts the disconnect and
   * then goes quiet never produces -- so the wait is bounded here by
   * {@link CLIENT_CLOSE_TIMEOUT_MS} and, past it, the connection is closed from
   * this side (see {@link forceCloseTerminalTransport}). An `end()` that REJECTS
   * closed nothing either, so it reaches that same close and the rejection is
   * re-raised only behind it. Common to BOTH session modes: nothing on this path
   * is gated on connection-per-poll. A partner that does close is unchanged -- its
   * `end()` resolves inside the bound and returns with no added wait.
   *
   * Runs at most once per connection (see the class `terminalClose` field): a
   * repeat or concurrent call -- the re-entrant one {@link withSessionRecovery}
   * issues when a re-dial lands inside a teardown is the concurrent case -- awaits
   * that same close and returns when it is complete, never over a connection still
   * being closed.
   *
   * Teardown takes the session-transition queue like every other transition (see
   * {@link runTransition}), so it neither pre-empts a dial or an idle release that
   * is already running nor lets one begin behind it. That wait is bounded like
   * every other, and teardown is the one kind whose expiry still closes something:
   * it gives up ssh2-sftp-client's `end()` and closes the transport from this side
   * (see {@link forceCloseAbandonedTeardown}).
   */
  async end(): Promise<void> {
    // Latch teardown and memoize the close in one synchronous step, before the
    // teardown transition is enqueued: every transition queued behind this one
    // reads the latch and skips, an op racing this close cannot trigger a NEW
    // mid-exchange re-dial (see withSessionRecovery), and a caller that reaches
    // end() off a `closing` reading -- withSessionRecovery's re-entrant close --
    // finds the memo already set.
    this.closing = true;
    this.terminalClose ??= this.runTransition({
      kind: "teardown",
      run: (held) => this.closeTerminally(held),
      // A teardown that gave up its wait has closed the transport from this side
      // all the same, so it reports the same nothing a completed close does:
      // rejecting would tell a caller that a run which already succeeded failed.
      abandoned: () => undefined,
    });
    await this.terminalClose;
  }

  private async closeTerminally(held: HeldSessionTransition): Promise<void> {
    // Getting this wrong is expensive twice over: client.end() runs against a live
    // handshake, and ssh2-sftp-client's end() short-circuits on the session that
    // handshake has not restored yet, so this resolves without ending the ssh2
    // Client at all and close() returns over a ref'd socket. The transition queue
    // is what keeps a dial or an idle release from overlapping it.
    this.assertTransitionHeld("ssh2-sftp-client's end()", held);
    // Stop the keepalive before tearing the client down so no beat races the
    // teardown, and so the unref'd timer never lingers past the session.
    this.heartbeat.stop();
    // Captured once so the forced close below waits on the SAME end() rather than
    // issuing a second one on the abandoned client.
    const ending = this.client.end();
    const outcome = await this.awaitBoundedTeardown(
      held,
      ending,
      CLIENT_CLOSE_TIMEOUT_MS,
      undefined,
      false,
    );
    // Resolving is the ONLY outcome that means the partner closed the connection.
    // A rejection closed nothing: ssh2-sftp-client raises it from a temporary
    // 'error' listener whose end/close listeners are gated off by `endCalled`, so
    // it leaves the socket exactly as a withheld close does -- half-open, and a
    // ref'd handle that keeps the process alive. It is a reason to force the close,
    // not a reason to skip it.
    if (outcome.status === "settled") return;
    await this.forceCloseTerminalTransport(held, ending, outcome);
    // Forced FIRST, then surfaced: no caller can observe this rejection over a
    // socket still alive, including the ones sharing the memo, since the memoized
    // promise does not settle until the destroy above has run. What the rejection
    // reports is unchanged from an unbounded await -- core logs it at debug and the
    // exit code is untouched -- so it is not swallowed here.
    if (outcome.status === "failed") throw outcome.error;
  }

  // ssh2-sftp-client's end() did not close the connection: either the partner
  // accepted the disconnect and never closed it, leaving the ssh2 Client's 'close'
  // outstanding past the bound, or end() rejected without closing anything. Both
  // leave a transport this side has already ended. Close it from this side:
  // net.Socket's destroy() needs nothing from the peer, and beneath a pending
  // end() it SETTLES that end() rather than abandoning it, so teardown finishes
  // and the process is left holding no half-open socket (which, being a ref'd
  // handle, would otherwise keep a completed run alive indefinitely).
  //
  // Nothing here throws, and every degraded branch is a warning that names what
  // broke and where to re-verify it: core treats end() as best-effort and logs a
  // rejection at debug, so a throw would be invisible and would accomplish
  // nothing.
  private async forceCloseTerminalTransport(
    held: HeldSessionTransition,
    ending: Promise<unknown>,
    outcome: { status: "failed"; error: unknown } | { status: "expired" },
  ): Promise<void> {
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    // Resolved HERE rather than at connect: the default held-session mode does not
    // verify this seam at dial time (see connect()), and failing a dial over a
    // teardown-only mechanism would ground every default-mode exchange on an ssh2
    // bump that costs it nothing. An unavailable seam degrades to a warning and a
    // bounded return instead.
    const seam = this.resolveTerminalCloseSeam(internals);
    if ("missing" in seam) {
      this.log.warn(
        `The SFTP connection was not closed by the partner's SFTP server at ` +
          `teardown, and closing it from this side drives ssh2's ` +
          `${seam.missing}, which is not available after connect(): the ` +
          `connection is left to the operating system, may stay half-open, and ` +
          `a half-open connection can keep this process from exiting. The ` +
          `installed ssh2 / ssh2-sftp-client version may have renamed, ` +
          `relocated, or removed it - re-verify the internal premises per the ` +
          `"Upgrading the SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return;
    }
    try {
      await this.awaitBoundedTeardown(
        held,
        ending,
        FORCED_CLOSE_TIMEOUT_MS,
        seam.destroy,
        true,
      );
    } catch (error: unknown) {
      this.log.warn(
        `Closing the SFTP connection from this side failed at teardown: ` +
          `${sanitizeErrorForDisplay(error)}. The connection is left to the ` +
          `operating system, may stay half-open, and a half-open connection ` +
          `can keep this process from exiting.`,
      );
      return;
    }
    // That the destroyed socket actually closed is the one premise connect()
    // cannot check -- nothing at connect time destroys the socket -- so it is read
    // back where it is driven.
    if (seam.socket.destroyed !== true) {
      this.log.warn(
        `The SFTP connection's transport did not close after this side ` +
          `destroyed it at teardown, so the connection may stay half-open, and ` +
          `a half-open connection can keep this process from exiting; the ` +
          `installed ssh2 may no longer expose the socket beneath its client. ` +
          `Re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return;
    }
    // At default verbosity and informational: teardown's close runs last, so
    // nothing it reports changes what the run produced -- and this adapter has no
    // notion of that outcome (end() runs from core's close() on every teardown,
    // a failed run and a bare connect/close included), so the line claims nothing
    // about it. It is deliberately not rolled into the connection-per-poll
    // release's forced-release count, whose wording and end-of-run total are that
    // mode's per-cycle boundary. The two outcomes get their own sentence: nothing
    // ran out of time on the rejecting one, so the bound is not what to tell the
    // operator about it.
    //
    // It reports the close in the past tense, so it follows the close rather
    // than preceding it: on either degraded branch above, an operator told the
    // connection was closed would be reading a claim that branch's warning then
    // takes back. Waiting costs at most the forced close's own bound.
    this.log.info(
      (outcome.status === "expired"
        ? `The partner's SFTP server did not close the connection within the ` +
          `${CLIENT_CLOSE_TIMEOUT_MS} ms teardown bound -- a server that ` +
          `leaves connections half-open, or one merely slower to answer than ` +
          `the bound allows for -- so this side closed it. `
        : `Closing the SFTP connection did not complete: ` +
          `${sanitizeErrorForDisplay(outcome.error)}. The connection was left ` +
          `open, so this side closed it. `) +
        `This close is the last step of teardown, so it changes neither the ` +
        `run's results nor its exit code.`,
    );
  }

  // Teardown gave up its wait for the transition ahead of it
  // (TRANSITION_ACQUIRE_TIMEOUT_MS) and closes the transport from this side
  // instead. It cannot reuse the terminal close above, which waits out the
  // ssh2-sftp-client end() that close captured: this teardown never ran a body, so
  // it has no such end() -- and it must not create one, because driven beneath a
  // live handshake ssh2-sftp-client's end() short-circuits on the session that
  // handshake has not restored yet, resolving in a millisecond with the socket
  // untouched (measured; docs/spec/DEPENDENCY_PINS.md). What the destroy needs is
  // nothing from the peer, and it settles the very dial being waited on, so there
  // is nothing left to wait for after it: `destroyed` reads back in the same tick.
  //
  // Nothing here throws, and every degraded branch is a warning naming what broke,
  // on exactly the terms the terminal close's forced branch states: core treats
  // end() as best-effort and logs a rejection at debug.
  private forceCloseAbandonedTeardown(): void {
    this.assertAbandonedTeardownMayForceClose();
    // Nothing may keep pinging a transport this is about to destroy, and the
    // degraded branch below reports this teardown DONE over a transport it could
    // not close, so the stop precedes both -- as it does in closeTerminally. Local
    // timer state only, so unlike every other teardown action it drives nothing on
    // the client the transition ahead of this one still holds.
    this.heartbeat.stop();
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    const seam = this.resolveTerminalCloseSeam(internals);
    if ("missing" in seam) {
      this.log.warn(
        `An SFTP session transition did not complete within the ` +
          `${TRANSITION_ACQUIRE_TIMEOUT_MS} ms teardown wait, and closing the ` +
          `connection from this side drives ssh2's ${seam.missing}, which is ` +
          `not available after connect(): the connection is left to the ` +
          `operating system, may stay half-open, and a half-open connection can ` +
          `keep this process from exiting. The installed ssh2 / ` +
          `ssh2-sftp-client version may have renamed, relocated, or removed it ` +
          `- re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return;
    }
    try {
      seam.destroy();
      // Set where the destroy is driven rather than after the read-back below: it
      // is the destroy that settles the dial this teardown gave up on, whatever the
      // socket then reports about itself.
      this.abandonedTeardownClosedTransport = true;
    } catch (error: unknown) {
      this.log.warn(
        `Closing the SFTP connection from this side failed at teardown: ` +
          `${sanitizeErrorForDisplay(error)}. The connection is left to the ` +
          `operating system, may stay half-open, and a half-open connection ` +
          `can keep this process from exiting.`,
      );
      return;
    }
    if (seam.socket.destroyed !== true) {
      this.log.warn(
        `The SFTP connection's transport did not close after this side ` +
          `destroyed it at teardown, so the connection may stay half-open, and ` +
          `a half-open connection can keep this process from exiting; the ` +
          `installed ssh2 may no longer expose the socket beneath its client. ` +
          `Re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return;
    }
    // The cause is what distinguishes this line from the terminal close's: there
    // the partner's server was slow to answer, here a session transition of this
    // adapter's own was, and the operator can act on the two differently. Same
    // severity and same closing sentence, for the same reason -- teardown's close
    // runs last, so nothing it reports changes what the run produced.
    this.log.info(
      `A session transition on this SFTP connection did not complete within the ` +
        `${TRANSITION_ACQUIRE_TIMEOUT_MS} ms teardown wait -- typically a dial ` +
        `against an unresponsive server -- so this side closed the connection ` +
        `itself rather than closing it alongside that transition. This close is ` +
        `the last step of teardown, so it changes neither the run's results nor ` +
        `its exit code.`,
    );
  }

  /**
   * Connection-per-poll idle-boundary RELEASE (see the class `ephemeralSessions`
   * field and {@link FileTransportClient.releaseForIdle}). Closes the SFTP
   * session NON-TERMINALLY so the next cycle's {@link ensureConnected} re-dials,
   * without latching this adapter's `closing` (which would disable recovery) and
   * without going through ssh2-sftp-client's `end()`.
   *
   * It drives the underlying ssh2 Client's own `end()`, not ssh2-sftp-client's:
   * the latter latches `endCalled`, permanently disabling the constructor's
   * global 'close' listener that clears `this.sftp` on a later server-driven drop
   * -- the within-cycle recovery floor (retained in this mode) relies on that
   * listener. Closing the ssh2 Client instead fires the same global 'close'
   * listener with `endCalled` still false, clearing `this.sftp` and leaving the
   * adapter in the exact cleared-session state a server drop produces, ready to
   * re-dial. A no-op when the mode is off, during teardown, or when no session is
   * live. Awaits the 'close' so the release is complete before the loop idles.
   *
   * A partner that accepts the disconnect and never closes the connection leaves
   * that 'close' outstanding past the bound, on a transport `end()` has already
   * ended. The release does not hand that state to the next cycle -- it forces the
   * socket closed itself, so the session clears and the cycle re-dials (see
   * {@link forceCloseEndedTransport}).
   *
   * The poll loop AWAITS this call and core forwards it unwrapped (see
   * {@link runTransition}), so nothing above bounds it: its own duration is the
   * loop's liveness bound, and the whole of that duration is bounded here. The
   * close carries the {@link CLIENT_CLOSE_TIMEOUT_MS} ceiling, the forced close
   * that may follow it the {@link FORCED_CLOSE_TIMEOUT_MS} one, and the acquire
   * that precedes both the {@link TRANSITION_ACQUIRE_TIMEOUT_MS} one -- past which
   * the release declines, having closed nothing, under a paced warning, and the
   * loop cycles on rather than stalling to the peer-inactivity ceiling.
   *
   * The whole body, forced close included, holds the transition lock, so an
   * operation ISSUED while it runs re-establishes the session through
   * {@link withSessionRecovery}'s gate instead of racing the close or reporting the
   * deliberate absence as a server drop. An operation already ON THE WIRE when the
   * release begins is torn with the session instead, and at the pinned versions
   * that tear clears the session as it rejects the operation, so the operation
   * recovers (see {@link shouldRecoverFromSessionLoss} for the routes that still
   * reach the terminal reading). Closing that case outright means holding the
   * release while an operation is outstanding.
   */
  releaseForIdle(): Promise<void> {
    if (!this.ephemeralSessions) return Promise.resolve();
    return this.runTransition({
      kind: "releaseForIdle",
      skipped: () => undefined,
      abandoned: () => this.warnIdleReleaseDeclined(),
      run: (held) => this.releaseSessionForIdle(held),
    });
  }

  // The idle release gave up its wait for the transition ahead of it: it released
  // nothing, so a session that is live is held across this idle gap -- the one
  // thing the mode exists to prevent -- while the alternative, parking the poll
  // loop until the hour-scale peer-inactivity ceiling misreports it as peer
  // silence, is worse. Paced exactly like the forced release's warning
  // (SFTP_REDIAL_WARN_INTERVAL) and for the same reason: whatever holds a
  // transition long enough to do this once tends to do it every cycle, and an
  // unpaced line would fill an hours-long exchange's log.
  private warnIdleReleaseDeclined(): void {
    this.declinedReleases += 1;
    const count = this.declinedReleases;
    if (count !== 1 && count % SFTP_REDIAL_WARN_INTERVAL !== 0) return;
    this.log.warn(
      `The connection-per-poll idle release did not close the SFTP session: ` +
        `another session transition on this connection -- typically a dial ` +
        `against an unresponsive server -- did not complete within the ` +
        `release's ${TRANSITION_ACQUIRE_TIMEOUT_MS} ms wait, and closing the ` +
        `session alongside it would corrupt the one shared client. The session ` +
        `may still be live and held across this idle gap; the next poll cycle ` +
        `releases again and the exchange continues (${count} idle ` +
        `${count === 1 ? "boundary" : "boundaries"} released nothing this way ` +
        `so far this exchange).`,
    );
  }

  // The locked body of releaseForIdle. Taking the transition lock for the whole of
  // it -- the forced close included, which runs past the release's own close bound
  // with the session still reading live -- is what stops a handshake and this
  // teardown from running at once on the one shared Ssh2SftpClient, and what stops
  // a dial landing after the boundary from holding its session across the whole
  // idle gap: entered while a dial was in flight, this would read the
  // not-yet-established session as "nothing to release" and the mode would silently
  // keep the very session it exists to shed.
  private async releaseSessionForIdle(
    held: HeldSessionTransition,
  ): Promise<void> {
    // No held session to keep warm across the idle gap.
    this.heartbeat.stop();
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    if (!internals.sftp) return;
    const seams = this.resolveTransportCloseSeams(internals);
    if ("missing" in seams) throw this.transportCloseSeamError(seams.missing);
    const { end, once, removeListener, socket } = seams;
    // The PEER started this teardown: its FIN has already been consumed, so ssh2
    // has emitted 'end' and the 'close' is on its way, and the end() below closes
    // nothing. ssh2-sftp-client's global 'end' listener leaves `sftp` set, so the
    // release runs its course as usual -- but the boundary is not this adapter's,
    // because what cleared the session was a server-side drop and the operator has
    // to see it counted and warned as one.
    const peerEndedTransport = socket.readableEnded === true;
    // Recorded BEFORE the close is driven: an operation already on the wire is torn
    // by that close and reaches session recovery while this release is still
    // running, and the boundary is what tells that recovery the loss was
    // deliberate. A release that raises below has ended nothing and leaves the
    // session reading live, which runTransition takes the boundary back over on
    // the way out, so the next drop stays classifiable as the drop it is.
    if (!peerEndedTransport) held.recordBoundary("deliberatelyReleased");
    await this.awaitClientClose(
      held,
      once,
      removeListener,
      CLIENT_CLOSE_TIMEOUT_MS,
      end,
      false,
    );
    if (!internals.sftp) return;
    // ssh2-sftp-client's global 'close' listener has not run, so the backstop
    // settled that wait rather than the ssh2 Client's 'close'. Which state that is
    // turns on whether the transport was ended, so it is a branch on the socket
    // rather than a claim in a comment.
    if (socket.writableEnded === false) {
      // The transport this adapter's end() should have ended is still writable, so
      // this is the one branch where the session may genuinely be live and held
      // across the idle gap. Take the boundary back: it may only stand over a
      // session something deliberately ended, and exempting a live session's next
      // drop from the counters and the operator warning is the misreport it exists
      // to prevent.
      held.recordBoundary("notReleased");
      this.log.warn(
        "The connection-per-poll idle release did not close the SFTP session " +
          "and its transport is still writable, which the ssh2 client's end() " +
          "should have ended: the session may still be live and held across " +
          "this idle gap, which is the one thing this mode exists to prevent. " +
          "Check the ssh2 changelog.",
      );
      return;
    }
    if (!(await this.forceCloseEndedTransport(held, internals, seams)))
      // Raising takes the release's boundary back with it (the session still reads
      // live, so runTransition drops the reading on the way out): the boundary may
      // only stand where something deliberately ended a session, and this one did
      // not end.
      throw new Error(
        `the connection-per-poll idle release destroyed the SFTP session's ` +
          `transport and the session did not clear within ` +
          `${FORCED_CLOSE_TIMEOUT_MS} ms; the installed ssh2 may no ` +
          `longer emit the client 'close' that clears it - re-verify the ` +
          `internal premises per the "Upgrading the SFTP Stack" checklist in ` +
          `docs/spec/DEPENDENCY_PINS.md`,
      );
    this.countForcedRelease();
  }

  // Arm a wait for the ssh2 Client's 'close', drive a teardown action, and resolve
  // once that 'close' lands or `timeoutMs` expires -- the shape both the release's
  // end() and its forced close need.
  //
  // The listener is armed BEFORE the action runs, so a synchronous 'close' cannot
  // land in the gap, and removed however the wait settles: against a server that
  // withholds its close the wait expires every cycle, and an un-removed listener
  // per cycle piles up on the shared ssh2 Client (ssh2-sftp-client keeps one across
  // reconnects) until Node reports a listener leak. A throw out of `drive`
  // propagates with the wait already dismantled, so nothing is left pending.
  private async awaitClientClose(
    held: HeldSessionTransition,
    once: (event: "close", listener: () => void) => void,
    removeListener: (event: "close", listener: () => void) => void,
    timeoutMs: number,
    drive: () => void,
    holdProcessAlive: boolean,
  ): Promise<void> {
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const onClose = (): void => settle();
    once("close", onClose);
    try {
      await this.awaitBoundedTeardown(
        held,
        closed,
        timeoutMs,
        drive,
        holdProcessAlive,
      );
    } finally {
      removeListener("close", onClose);
    }
  }

  // Drive a teardown action (when one is supplied) and wait for `settled` under
  // `timeoutMs`, reporting which of the three outcomes the race reached. The one
  // bounded-wait mechanism both closes are built from: the connection-per-poll idle
  // release's end() and forced close reach it through {@link awaitClientClose},
  // waiting on the ssh2 Client's 'close'; the connection's terminal close and its
  // forced close call it directly, waiting on ssh2-sftp-client's pending end().
  //
  // A rejection of `settled` is REPORTED, not folded into settling: on the terminal
  // close it means the close failed having closed nothing, which the caller must
  // tell apart from the partner having closed the connection. It is absorbed here
  // so a promise that loses the race and rejects later never surfaces as an
  // unhandled rejection, and handed back on `error` instead.
  //
  // `holdProcessAlive` decides whether the bound's own timer is ref'd. A wait on a
  // socket this adapter merely ENDED leaves it unref'd (the deliberately-unref'd
  // SFTP-liveness-timer contract): the half-ended socket is itself a ref'd handle,
  // so the wait is observable without the timer's help. A wait after the socket has
  // been DESTROYED is the deviation, and it is what makes that bound a bound at
  // all: nothing ref'd is left behind it, so an unref'd timer would let the process
  // exit -- silently, code 0 -- before the caller's read-back runs, in exactly the
  // case the bound exists for (measured both ways).
  private async awaitBoundedTeardown(
    held: HeldSessionTransition,
    settled: Promise<unknown>,
    timeoutMs: number,
    drive: (() => void) | undefined,
    holdProcessAlive: boolean,
  ): Promise<BoundedTeardownOutcome> {
    // The funnel for every teardown this adapter drives past the public API that
    // has something to wait for -- the ssh2 Client's end() and both forced socket
    // destroys reach the transport as this method's `drive` -- so holding the
    // transition here holds it for all of them. The abandoned teardown's forced
    // close is the one destroy that does not come through here: it has nothing to
    // wait for, and it runs under its own exemption from that check
    // ({@link forceCloseAbandonedTeardown}).
    this.assertTransitionHeld("an ssh2 transport teardown", held);
    let expire!: () => void;
    const bound = new Promise<BoundedTeardownOutcome>((resolve) => {
      expire = () => resolve({ status: "expired" });
    });
    const timer = setTimeout(expire, timeoutMs);
    // The bound is the safety net, not real work, and it is cleared the instant the
    // teardown settles; a second of it is no meaningful hold on a healthy process.
    if (!holdProcessAlive) timer.unref();
    try {
      drive?.();
    } catch (error: unknown) {
      clearTimeout(timer);
      throw error;
    }
    try {
      return await Promise.race([
        settled.then(
          (): BoundedTeardownOutcome => ({ status: "settled" }),
          (error: unknown): BoundedTeardownOutcome => ({
            status: "failed",
            error,
          }),
        ),
        bound,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The one seam the connection's terminal close drives past the public API:
  // net.Socket's destroy() on the socket beneath the ssh2 Client. Resolved alone,
  // and required alone, because that close drives nothing else -- it reads back
  // `destroyed` but treats an absent flag as "did not close" rather than as a
  // missing mechanism. Requiring the wider set below would let a relocated
  // once/removeListener/writableEnded, none of which this path calls, disable the
  // forced destroy and leave a completed run holding a half-open socket.
  private resolveTerminalCloseSeam(
    internals: Ssh2SftpClientInternals,
  ): TerminalCloseSeam | UnavailableTransportCloseSeam {
    const socket = internals.client?._sock;
    if (typeof socket?.destroy !== "function")
      return { missing: "client._sock.destroy()" };
    return { destroy: socket.destroy.bind(socket), socket };
  }

  // The seams a forced close of an already-ended transport drives past the public
  // API: the ssh2 Client's own once()/removeListener() for the 'close' that clears
  // the session, plus the terminal close's socket seam above and Node's
  // writableEnded flag on that same socket. Both forced closes resolve them where
  // they use them -- the connection-per-poll release through the wider set below,
  // which connect() verifies at dial time in that mode, and the mid-exchange
  // recovery on its own, which does not (its severity is a warning and the
  // operation's own terminal failure, not a failed dial). Re-verify on any ssh2 /
  // ssh2-sftp-client upgrade per docs/spec/DEPENDENCY_PINS.md.
  private resolveEndedTransportCloseSeams(
    internals: Ssh2SftpClientInternals,
  ): EndedTransportCloseSeams | UnavailableTransportCloseSeam {
    const client = internals.client;
    if (typeof client?.once !== "function") return { missing: "client.once()" };
    if (typeof client.removeListener !== "function")
      return { missing: "client.removeListener()" };
    const terminal = this.resolveTerminalCloseSeam(internals);
    if ("missing" in terminal) return terminal;
    if (typeof terminal.socket.writableEnded !== "boolean")
      return { missing: "client._sock.writableEnded" };
    return {
      once: client.once.bind(client),
      removeListener: client.removeListener.bind(client),
      ...terminal,
    };
  }

  // The seams the connection-per-poll idle release drives past the public API: the
  // ssh2 Client's own end(), which ENDS the transport, plus everything the forced
  // close that may follow it needs. In this mode connect() resolves them once so an
  // upgrade that relocates any of them fails the dial with one actionable error
  // rather than silently changing what an idle boundary does, and the release
  // resolves them again where it uses them. Going through this one site is what
  // keeps the check and the uses from drifting apart.
  private resolveTransportCloseSeams(
    internals: Ssh2SftpClientInternals,
  ): TransportCloseSeams | UnavailableTransportCloseSeam {
    const client = internals.client;
    if (typeof client?.end !== "function") return { missing: "client.end()" };
    const ended = this.resolveEndedTransportCloseSeams(internals);
    if ("missing" in ended) return ended;
    return { end: client.end.bind(client), ...ended };
  }

  // Reported as an unavailable seam rather than a thrown error so each caller
  // decides its own severity from the same reading: the connect-time check and the
  // idle release raise it (a boundary that silently stopped meaning anything is
  // worse than a failed dial), while the terminal close warns and returns.
  private transportCloseSeamError(seam: string): Error {
    return new Error(
      `closing an SFTP connection from this side drives ssh2's ${seam}, which ` +
        `is not available after connect(); the installed ssh2 / ` +
        `ssh2-sftp-client version may have renamed, relocated, or removed it - ` +
        `re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
        `checklist in docs/spec/DEPENDENCY_PINS.md`,
    );
  }

  // The partner accepted the disconnect and never closed the connection, so the
  // transport is ended with the session still set: it can carry nothing, while
  // every path that reads the session property reads it as live and skips the dial
  // it needs -- riding the next operation to the per-operation liveness deadline,
  // which is terminal. Force the socket closed instead: destroy() needs nothing
  // from the peer, and the ssh2 Client's 'close' that follows is what fires
  // ssh2-sftp-client's global listener to clear the session, leaving a dial to
  // make.
  //
  // That the destroyed transport takes the session with it is the one premise here
  // the dial cannot check -- nothing at connect time destroys the socket -- so it
  // is read back and REPORTED where it is driven. Reported rather than raised
  // because the two callers owe the operator different things: the idle release
  // raises (a boundary that silently stopped meaning anything is worse than a
  // failed cycle) and the mid-exchange recovery warns and lets the operation's own
  // loss stand.
  private async forceCloseEndedTransport(
    held: HeldSessionTransition,
    internals: Ssh2SftpClientInternals,
    seams: EndedTransportCloseSeams,
  ): Promise<boolean> {
    await this.awaitClientClose(
      held,
      seams.once,
      seams.removeListener,
      FORCED_CLOSE_TIMEOUT_MS,
      seams.destroy,
      true,
    );
    return !internals.sftp;
  }

  // Account for an idle boundary the connection-per-poll release closed itself. A
  // partner that never closes forces one every cycle, so the operator hears it on
  // the cadence a chronic mid-exchange re-dial gets: the first, then every
  // SFTP_REDIAL_WARN_INTERVAL-th. Nothing was lost and nothing leaks, so pacing it
  // costs the operator nothing.
  private countForcedRelease(): void {
    this.forcedReleases += 1;
    const count = this.forcedReleases;
    if (count === 1 || count % SFTP_REDIAL_WARN_INTERVAL === 0)
      this.log.warn(
        `The partner's SFTP server did not close the connection within the ` +
          `connection-per-poll idle release's bound -- a server that leaves ` +
          `connections half-open, or one merely slower to answer than the ` +
          `bound allows for. The release closed it from this side and the next ` +
          `poll cycle dials a fresh session; the exchange continues (${count} ` +
          `idle ${count === 1 ? "boundary" : "boundaries"} closed this way so ` +
          `far this exchange).`,
      );
  }

  /**
   * Connection-per-poll cycle-START reconnect (see
   * {@link FileTransportClient.ensureConnected}). Re-establishes the session
   * {@link releaseForIdle} released, reusing the retained full connect options
   * (pinned host key, stored credentials, reconnect bound) with NO re-prompt and
   * NO re-pinning: the dial re-runs the enforcing fail-closed host-key verifier
   * that rides those options, so a server presenting a different key on a re-dial
   * is still rejected. Resolves `true` once a session is live, `false` on a
   * transient dial failure (the caller skips this cycle and retries next tick),
   * and rejects only on a fatal condition (a host-key rejection) that terminates
   * the exchange. A no-op returning `true` when the mode is off, during teardown,
   * or when a session is already live. A dial that fails once teardown has been
   * latched reports the same `false` and reports nothing to the operator: this run
   * has no next tick, and the failure may be the teardown's own destroy settling
   * this very dial.
   *
   * Core forwards it unwrapped (see {@link runTransition}), so its acquire of the
   * transition lock -- which is what keeps two handshakes, or a handshake and a
   * close, off the one shared Ssh2SftpClient -- is bounded by that lock's own
   * {@link TRANSITION_ACQUIRE_TIMEOUT_MS} and nothing else. Past it the re-dial
   * reports the same `false` a transient dial failure reports, under a paced
   * warning, so the loop skips this cycle and retries on the next tick.
   */
  ensureConnected(): Promise<boolean> {
    if (!this.ephemeralSessions) return Promise.resolve(true);
    return this.runTransition({
      kind: "ensureConnected",
      skipped: () => true,
      abandoned: () => {
        this.warnCycleRedialDeclined();
        return false;
      },
      run: async (held) => {
        const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
        // A concurrent recovery re-dial or ensureConnected (e.g. the close()
        // abort-marker write) already reconnected; nothing to do.
        if (sftp) return true;
        const options = this.originalConnectOptions;
        if (options === undefined)
          throw new Error(
            "ephemeral SFTP re-dial reached with no retained connect options; " +
              "a poll cycle ran before connect()",
          );
        try {
          await this.connectLocked(options, held);
          return true;
        } catch (error: unknown) {
          if (this.isFatalDialError(error)) throw error;
          // This run is closing, so there is no next tick to retry on -- and the
          // dial may have failed BECAUSE of the teardown: an abandoning teardown
          // destroys the transport beneath a dial in flight, and that rejection
          // carries the same error a genuine peer close does. Warning about a
          // transient partner failure and promising a retry that cannot happen
          // would report this adapter's own close as the partner's. What closed the
          // connection is reported by the teardown that closed it. Read in the
          // catch and not before the dial: a dial during teardown but ahead of
          // end()'s latch -- the abort-marker write's re-establish -- still needs
          // this warning.
          if (this.closing) return false;
          // A transient dial failure (server briefly unreachable, connection
          // refused, auth exhaustion) is not fatal in this mode: report it and let
          // the poll loop skip this cycle and retry on the next tick. The
          // exchange's peer-inactivity ceiling terminates the run if dials keep
          // failing for the whole budget, so an indefinitely-unreachable server
          // still fails loudly.
          this.log.warn(
            "ephemeral SFTP re-dial failed; skipping this poll cycle and " +
              `retrying on the next tick: ${sanitizeErrorForDisplay(error)}`,
          );
          return false;
        }
      },
    });
  }

  // The cycle-start re-dial gave up its wait for the transition ahead of it: it
  // dialed nothing, so this cycle carries no session and the poll loop skips it.
  // Paced exactly like the idle release's decline (warnIdleReleaseDeclined) and for
  // the same reason: core drives both signals once per poll cycle, and whatever
  // holds a transition long enough to decline one tends to hold it every cycle, so
  // an unpaced line would fill an hours-long exchange's log.
  private warnCycleRedialDeclined(): void {
    this.declinedCycleRedials += 1;
    const count = this.declinedCycleRedials;
    if (count !== 1 && count % SFTP_REDIAL_WARN_INTERVAL !== 0) return;
    this.log.warn(
      `ephemeral SFTP re-dial declined: another session transition on this ` +
        `connection did not complete within the re-dial's ` +
        `${TRANSITION_ACQUIRE_TIMEOUT_MS} ms wait, and dialing alongside it ` +
        `would corrupt the one shared client; skipping this poll cycle and ` +
        `retrying on the next tick (${count} ` +
        `${count === 1 ? "cycle" : "cycles"} skipped this way so far this ` +
        `exchange)`,
    );
  }

  // A dial failure that must terminate the exchange rather than be retried on the
  // next tick. A host-key verification failure means the server is presenting a
  // different or unknown key -- a trust-boundary fault (possible MITM) that must
  // fail loudly and fast, never be papered over as a transient network blip and
  // ridden to a generic peer-silence timeout. ssh2 surfaces it as "Host denied
  // (verification failed)", the same stable fragment connect()'s retry predicate
  // treats as terminal (re-verify on any ssh2 upgrade per
  // docs/spec/DEPENDENCY_PINS.md). Bad credentials are caught at the initial
  // connect() before any cycle; a mid-exchange credential rotation is transient
  // here and bounded by the peer-inactivity ceiling.
  private isFatalDialError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("Host denied");
  }

  /**
   * Lists a remote directory under the directory-listing bounds (see
   * {@link ./listingGuard}), enforced at the transport read layer.
   *
   * It does NOT delegate to ssh2-sftp-client's `list()`: that passes the
   * directory PATH to `sftp.readdir`, which internally loops readdir until EOF
   * and accumulates the entire listing into one array before returning, so a
   * hostile directory's full (attacker-controlled) entry set is already resident
   * by the time any check could run. Instead this opens a directory handle and
   * reads one server batch at a time, applying the count and filename-length
   * checks as entries arrive, so an oversized or hostile directory is refused
   * before the full listing is materialized -- the SFTP path carries the
   * in-scope adversary (the server admin), so it must be bounded as firmly as
   * the local one. A single READDIR response is itself bounded by the SSH
   * transport's maximum packet size, so the bounded allocation is at most the
   * cap plus one batch.
   *
   * The session is reached via the same internal `sftp` property
   * createExclusive() uses; see its comment for the access-via-internals
   * rationale and the connect-time guard against an upstream API rename.
   *
   * The streamed read is bounded for liveness as well as for size. A hostile
   * server admin (in scope under docs/spec/CHANNEL_SECURITY.md) can
   * hang this read indefinitely -- by returning valid but empty (count = 0)
   * non-EOF readdir batches forever, which advance neither size bound and never
   * signal EOF, or by withholding a readdir/close callback entirely so the call
   * never settles. Both are bounded here: a total readdir round-trip cap
   * ({@link MAX_LISTING_READDIR_BATCHES}) fails the progress-free flood, and a
   * whole-operation wall-clock deadline ({@link SFTP_STALL_DEADLINE_MS}) fails the
   * withheld-callback case (the only one no batch count can catch). Each surfaces
   * a typed terminal {@link TransportOperationStalledError} (a `UsageError`, so
   * the poll loop treats it as terminal) and closes the open directory handle on
   * the way out rather than leaking it. The same liveness class on {@link get}
   * and {@link createExclusive} is bounded by {@link withSftpOperationDeadline}.
   */
  list(path: string): Promise<FileInfo[]> {
    return this.withSessionRecovery(() => this.listOnce(path));
  }

  // The single-attempt body of list(), a pure read re-issued verbatim on recovery.
  private listOnce(path: string): Promise<FileInfo[]> {
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp) return Promise.reject(new Error(SFTP_SESSION_CLOSED_MESSAGE));
    const dead = this.deadSessionError("directory listing", path);
    if (dead) return Promise.reject(dead);
    // SSH_FX_EOF: the SFTP status code ssh2 reports (as err.code) from readdir
    // once the directory is fully read. Used directly rather than via a named
    // import because ssh2 does not expose its status-code table on its public
    // surface (the same reason createExclusive() uses numeric SFTP flags).
    const SSH_FX_EOF = 1;
    // Hoisted out of the executor so the slow-operation warning can report
    // entries-read-so-far as the listing's cheap observed-progress signal.
    const results: FileInfo[] = [];
    return this.tracked(
      this.warnIfSlow(
        new Promise<FileInfo[]>((resolve, reject) => {
          let settled = false;
          // Undefined until opendir hands back a handle. settle() closes it only when
          // it is set, so a deadline that fires before (or instead of) a successful
          // opendir still settles -- with nothing to close.
          let handle: Buffer | undefined;
          // Round-trip counter for the liveness bound. A hostile server can return
          // valid but empty (count = 0) non-EOF readdir batches forever: each one
          // advances neither the entry-count nor the filename-length size bound and
          // never carries the EOF status, so the batch loop would recurse without
          // end. Capping the total readdir calls fails that progress-free flood with
          // a typed terminal error. (Production is safe from deep synchronous
          // recursion because ssh2 dispatches each readdir callback from a socket
          // event, a fresh tick; the cap is the DoS bound, not a stack guard.)
          let readdirCalls = 0;
          // Settle the listing exactly once, then close the handle best-effort. The
          // `settled` guard makes a late readdir callback or a late deadline fire a
          // no-op and prevents a double close. `deadline` is declared just below but
          // only read when settle() runs -- always after the timer is armed -- so the
          // forward reference resolves before it is used.
          const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            // Settle BEFORE closing, and never gate the settlement on the close
            // callback: a hostile server can withhold the close callback exactly as
            // it withholds a readdir, so awaiting close() here would let the deadline
            // fire, clear its own timer, then hang forever inside an un-returning
            // close -- restoring the unbounded wait this guard exists to defeat.
            // Close is best-effort cleanup that reclaims the handle on a well-behaved
            // server; a withheld close callback leaks the handle until session
            // teardown, with the listing already settled. A close() error on a
            // read-only directory handle has no data meaning, so it is swallowed.
            action();
            if (handle !== undefined) sftp.close(handle, () => {});
          };
          // Whole-operation wall-clock deadline. The round-trip cap cannot catch a
          // server that withholds an opendir/readdir/close callback entirely -- no
          // batch ever arrives to count -- so only elapsed time can fail that case.
          // Armed before opendir so it also bounds an opendir that never calls back;
          // settle() clears it on every terminal path so a completed listing leaves
          // no pending timer.
          const deadline = setTimeout(
            () =>
              settle(() =>
                reject(
                  listingStalledByTimeoutError(path, this.stallDeadlineMs),
                ),
              ),
            this.stallDeadlineMs,
          );
          // The deadline is the safety bound, not real work: cleared on every
          // terminal path, so unref'ing it only matters if the process is winding
          // down with a listing still in flight, where it must not block exit.
          deadline.unref();
          sftp.opendir(path, (openErr, openedHandle) => {
            // The deadline may have already fired (the server withheld the opendir
            // callback past the bound, then delivered it late); settle() already
            // rejected the listing, so do not open a read against it. settle() ran
            // before `handle` was assigned, though, so it could not close a handle
            // opendir is only now handing back -- close it here best-effort so this
            // late handle does not leak until session teardown.
            if (settled) {
              if (!openErr) sftp.close(openedHandle, () => {});
              return;
            }
            if (openErr) {
              settle(() => reject(openErr));
              return;
            }
            handle = openedHandle;
            const readNextBatch = (): void => {
              // Re-check settled at each recursion entry so a future re-entry after
              // the deadline fired cannot double-settle.
              if (settled) return;
              // Pre-increment: this issues at most MAX_LISTING_READDIR_BATCHES actual
              // readdir round-trips. The (cap + 1)th entry to readNextBatch trips the
              // guard and rejects BEFORE issuing another readdir, so the server sees
              // exactly MAX_LISTING_READDIR_BATCHES readdir calls (what the test
              // asserts), even though `readdirCalls` itself reaches cap + 1 here.
              if (++readdirCalls > MAX_LISTING_READDIR_BATCHES) {
                settle(() =>
                  reject(
                    listingStalledByBatchCountError(
                      path,
                      MAX_LISTING_READDIR_BATCHES,
                    ),
                  ),
                );
                return;
              }
              // openedHandle (not the outer `handle`) is the non-null Buffer here;
              // the outer `handle` exists only to let settle() close it on any path.
              sftp.readdir(openedHandle, (readErr, list) => {
                // A readdir callback delivered after the deadline already settled
                // must not process a batch against a rejected listing.
                if (settled) return;
                if (readErr) {
                  if (readErr.code === SSH_FX_EOF)
                    settle(() => resolve(results));
                  else settle(() => reject(readErr));
                  return;
                }
                // `list` is defined whenever readErr is null (the branch above has
                // already returned otherwise); `?? []` keeps the type honest and
                // treats a defensively-missing batch as empty. Apply the two bounds
                // in the SAME order as LocalFSClient.list(): the entry-count bound
                // first -- it governs every entry whatever its name -- then the
                // per-name length bound, so both adapters surface the same error
                // variant for a directory that breaches both at once. results.length
                // counts every entry seen (none are filtered out here), matching
                // LocalFSClient's `scanned`.
                for (const entry of list ?? []) {
                  if (results.length >= MAX_DIRECTORY_ENTRIES) {
                    settle(() =>
                      reject(
                        directoryTooLargeError(path, MAX_DIRECTORY_ENTRIES),
                      ),
                    );
                    return;
                  }
                  if (entry.filename.length > MAX_FILENAME_LENGTH) {
                    settle(() =>
                      reject(
                        filenameTooLongError(
                          path,
                          entry.filename,
                          MAX_FILENAME_LENGTH,
                        ),
                      ),
                    );
                    return;
                  }
                  results.push({
                    name: entry.filename,
                    // ssh2 reports mtime in seconds; FileInfo.modifyTime is ms -- the
                    // same conversion ssh2-sftp-client's list() applies.
                    modifyTime: entry.attrs.mtime * 1000,
                    size: entry.attrs.size,
                  });
                }
                readNextBatch();
              });
            };
            readNextBatch();
          });
        }),
        "directory listing",
        path,
        () =>
          `${results.length} ${results.length === 1 ? "entry" : "entries"} read ` +
          "so far",
      ),
    );
  }

  get(path: string, options?: GetOptions): Promise<Buffer<ArrayBufferLike>> {
    return this.withSessionRecovery(() => this.getOnce(path, options));
  }

  // The single-attempt body of get(). Re-issued verbatim on recovery: it rebuilds
  // its capped sink and result each call, so re-invoking the whole method (never
  // re-awaiting the dead-session promise) is what makes the re-issue clean.
  private getOnce(
    path: string,
    options?: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    const dead = this.deadSessionError("file read", path);
    if (dead) return Promise.reject(dead);
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) {
      // Uncapped reads carry no counting sink, so they have no per-chunk
      // progress signal to drive the idle bound the capped path below uses. The
      // transport always passes maxBytes, so this branch is effectively unused;
      // bound it with a coarse whole-operation deadline anyway so a withheld or
      // never-ending transfer fails rather than hanging. (A whole-operation
      // deadline would be too tight for a legitimately large capped transfer,
      // which is why the live path bounds the idle gap instead.)
      // Elapsed-only warning: an uncapped read has no counting sink, so there is
      // no cheap bytes-so-far signal to report.
      return this.tracked(
        this.warnIfSlow(
          withSftpOperationDeadline(
            this.client.get(path, undefined, {
              readStreamOptions: options,
            }) as Promise<Buffer<ArrayBufferLike>>,
            this.stallDeadlineMs,
            () =>
              transportOperationStalledError(
                "file read",
                path,
                `did not complete within ${this.stallDeadlineMs} ms (the server ` +
                  `withheld the transfer)`,
              ),
          ),
          "file read",
          path,
        ),
      );
    }

    // Capped read. Stream into the shared counting sink rather than letting
    // ssh2-sftp-client buffer the whole transfer. The sink retains only the
    // under-cap prefix and, the instant the running total crosses the cap,
    // settles its own `result` with the typed terminal error AND fails the
    // write callback so the library aborts and destroys the read stream at the
    // server. So a server that under-reports the file's size in its directory
    // listing (and thus slips past the poll loop's pre-get() check) still
    // cannot drive an unbounded allocation here -- allocation stays bounded to
    // roughly maxBytes however the transfer ends.
    //
    // The over-cap outcome is owned by the sink, decided at the point of
    // detection; this get()'s own settle only feeds the non-over-cap cases via
    // complete()/fail(). That removes the resolve-vs-reject race in
    // ssh2-sftp-client's stream-destination handling (it resolves via the read
    // stream's 'end' event but rejects via the sink's 'error' event) -- see
    // createCappedSink. No encoding is forwarded (raw Buffer chunks) so the byte
    // count is exact; the caller's own toString() decodes, matching the buffer
    // that the uncapped path and LocalFSClient return.
    const { sink, result, complete, fail, bytesReceived } = createCappedSink(
      path,
      maxBytes,
      this.stallDeadlineMs,
    );
    // The over-cap path settles `result` from inside the sink, so this handler
    // never rejects (complete/fail are no-ops once `result` has settled);
    // `result` is the returned promise.
    void this.client.get(path, sink).then(complete, fail);
    // Warn with bytes-so-far and an average rate from the sink's running count.
    return this.tracked(
      this.warnIfSlow(result, "file read", path, (elapsedMs) => {
        const bytes = bytesReceived();
        const rate = Math.round(bytes / (elapsedMs / 1000));
        return `${bytes} bytes received so far (~${rate} bytes/s)`;
      }),
    );
  }

  put(src: PutSource, dest: string, options?: PutOptions): Promise<unknown> {
    // A Buffer, a chunk list, or a string source is re-runnable (rebuilt from the
    // retained bytes, or a fresh fs.createReadStream, on each attempt), so a
    // recovery re-issue re-streams the identical payload -- and every FileSync
    // connection put in this app hands a Buffer or chunk list. A provided
    // ReadableStream is one-shot: a first attempt half-drains it, so re-issuing
    // would re-pipe an already-consumed stream and silently upload nothing. Do NOT
    // wrap that case in recovery; a dropped session fails it terminally rather
    // than half-re-issuing it. The peer never observes a partial because every
    // message/ack/sentinel/abort write targets a temp-*.tmp then atomic-renames,
    // and the direct hello put is tolerated by the reader's partial-sync gate.
    //
    // Only a truncate-overwrite put is re-issue-idempotent: append mode ("a")
    // would double-write the payload on a recovery re-issue, so it is never
    // recovery-wrapped even from a re-runnable source. Every caller passes "w"
    // today; this is a check standing in for that (per the project convention),
    // not a live guard against an existing append caller.
    const truncateOverwrite = options?.flags !== "a";
    const reRunnable =
      truncateOverwrite &&
      (Buffer.isBuffer(src) || Array.isArray(src) || typeof src === "string");
    if (!reRunnable) return this.putOnce(src, dest, options);
    return this.withSessionRecovery(() => this.putOnce(src, dest, options));
  }

  private putOnce(
    src: PutSource,
    dest: string,
    options?: PutOptions,
  ): Promise<unknown> {
    if (Buffer.isBuffer(src) || Array.isArray(src)) {
      // Buffer or a [header, payload] chunk list -- the two shapes this app
      // produces. Both are re-iterable, so the bounded source is rebuilt per retry
      // attempt, and both go through the progress-based idle window
      // (createBoundedPutSource): the payload is streamed in chunks so a withheld
      // write acknowledgement stalls the source and trips the window, while a
      // slow-but-progressing large upload keeps resetting it and is never
      // false-failed. A flat whole-operation deadline (as the metadata ops use)
      // would wrongly fail a legitimately large/slow ciphertext write. The chunk
      // list is streamed part-by-part without concatenation, so the hottest
      // (largest) binary frame keeps both the stall window and the retry.
      const payload = src;
      const payloadBytes = Buffer.isBuffer(src)
        ? src.length
        : src.reduce((total, part) => total + part.length, 0);
      return this.tracked(
        this.warnIfSlow(
          this.countedOperationRetry(
            () => {
              // Re-check the dead-session guard before EVERY attempt, not only at
              // method entry -- mirroring rename(). A fatal SFTP protocol error can
              // land between attempts (the guarded wrapper 'error' listener sets it)
              // and leave no in-flight request for cleanupRequests to fail; without
              // this re-check the next attempt would issue put() on the dead channel,
              // whose write stream never opens, so the source is never pulled and the
              // idle window would run its full bound before the typed terminal error
              // (which is not retryable) ended the retry. Re-checking turns that wait
              // into the prompt failure rename() already gives.
              const dead = this.deadSessionError("file write", dest);
              if (dead) return Promise.reject(dead);
              // Fresh source + idle window per attempt: the source is single-use, but
              // it is rebuilt from the retained Buffer/chunk list on each retry, so
              // the broad retry behavior is preserved. The over-window stall is owned
              // by the source, decided at the point of detection; this attempt's
              // settle only feeds the non-stall outcomes via complete()/fail().
              const { source, result, complete, fail } = createBoundedPutSource(
                dest,
                payload,
                SFTP_PUT_PROGRESS_CHUNK_BYTES,
                this.stallDeadlineMs,
              );
              void this.client
                .put(source, dest, { writeStreamOptions: options })
                .then(complete, fail);
              return result;
            },
            // `??` not `||` so an explicit retries: 0 disables the retry rather than
            // being coerced to the default of 5.
            this.options!.retries ?? 5,
            100,
            // Do not retry the idle-window stall: a TransportOperationStalledError is
            // terminal (a server withholding acks will keep withholding), so retrying
            // would stack the 60 s bound. Mirrors rename(), which likewise excludes
            // the typed stall from its retry predicate; the dead-session short-circuit
            // (also a TransportOperationStalledError) is excluded for the same reason.
            (error) => !(error instanceof TransportOperationStalledError),
          ),
          "file write",
          dest,
          () => `${payloadBytes} byte payload`,
        ),
      );
    }

    // string (a local file path) or a one-shot ReadableStream: permitted by the
    // transport-agnostic FileTransportClient.put signature but never produced by
    // this app (every FileSyncConnection put() call site hands a Buffer or a chunk
    // list). They carry no per-op idle window -- it needs a re-runnable source,
    // which a one-shot stream cannot give. Retry safety differs by type: a string
    // is re-runnable (ssh2-sftp-client opens a fresh fs.createReadStream per
    // attempt), but a provided ReadableStream is one-shot -- a failed attempt
    // half-drains it, so a retry would re-pipe an already-consumed stream and
    // silently upload nothing. So retry only a string; a stream gets a single
    // attempt. Both stay bounded only by the whole-exchange budget (no per-op idle
    // window). A stream/string src has no cheap size, so the slow-op warning falls
    // back to elapsed-only.
    const retries = typeof src === "string" ? (this.options!.retries ?? 5) : 0;
    return this.tracked(
      this.warnIfSlow(
        this.countedOperationRetry(
          () => {
            // Re-check the dead-session guard before every attempt, as the Buffer
            // branch does: a fatal SFTP error landing between string-src retries
            // would otherwise issue put() on the dead channel, whose buffered
            // request never calls back, and ride the whole-exchange budget. (For a
            // single-attempt stream this is just the method-entry check.)
            const dead = this.deadSessionError("file write", dest);
            if (dead) return Promise.reject(dead);
            return this.client.put(src, dest, { writeStreamOptions: options });
          },
          // `??` not `||` (in the string case) so an explicit retries: 0 disables
          // the retry rather than being coerced to the default of 5.
          retries,
          100,
          // Terminate on the dead-session typed error rather than retrying it --
          // the only TransportOperationStalledError this branch can see, since it
          // has no idle window; mirrors the Buffer branch's predicate.
          (error) => !(error instanceof TransportOperationStalledError),
        ),
        "file write",
        dest,
      ),
    );
  }

  delete(path: string): Promise<void> {
    return this.withSessionRecovery(
      () => this.deleteOnce(path),
      // On the re-issue only: a pre-drop delete that actually landed leaves the
      // source absent, so ssh2-sftp-client reports SSH_FX_NO_SUCH_FILE. Map that to
      // success -- propagating it would stop poll()'s consume-delete poller on a
      // delete that in fact succeeded. Never applied on the first attempt, where a
      // genuine absence must still surface.
      (run) =>
        run().catch((error: unknown) => {
          if (this.isNoSuchFileError(error)) return;
          throw error;
        }),
    );
  }

  private deleteOnce(path: string): Promise<void> {
    const dead = this.deadSessionError("file delete", path);
    if (dead) return Promise.reject(dead);
    // delete is a single metadata round-trip with no payload, so a flat
    // per-operation deadline carries negligible false-fail risk (same profile as
    // createExclusive); it fast-fails a withheld delete callback in 60 s rather
    // than letting it ride the whole-exchange budget.
    return this.tracked(
      this.warnIfSlow(
        this.boundByDeadline(
          this.client.delete(path).then(() => {}),
          "file delete",
          path,
          "delete",
        ),
        "file delete",
        path,
      ),
    );
  }

  safeDelete(path: string): Promise<void> {
    // safeDelete must never reject (callers use it inside catch blocks, see the
    // FileTransportClient contract), so a dead session is a best-effort no-op
    // that RESOLVES rather than rejecting like the other guarded methods. This
    // is the realistic teardown path: a fatal protocol error stops the poll loop,
    // then close() -> cleanup() -> safeDelete drives a delete against the still-
    // alive hostile server, whose destroyed channel would buffer the request and
    // never call back -- hanging the whole teardown. Short-circuiting here returns
    // at once. (delete() above rejects instead: its callers want the error
    // surfaced, whereas safeDelete's must never see one.)
    //
    // The OTHER stall -- a server that withholds the delete callback WITHOUT a
    // preceding fatal error, so the short-circuit above does not fire -- is bounded
    // by the same 60 s per-op deadline as delete()/rename()/exists(), so a hostile
    // server cannot stall teardown to the coarse whole-exchange budget while every
    // other write op fast-fails in 60 s. The never-reject contract is preserved by
    // swallowing BOTH the delete's own error (the inner .then(noop, noop)) AND the
    // deadline's TransportOperationStalledError (the trailing .then(noop, noop)):
    // safeDelete still always resolves, just within 60 s rather than the budget.
    // The whole-exchange budget (withTransportBudgetVoid in FileSyncConnection)
    // remains the backstop beneath. No retry: a best-effort cleanup delete does not
    // need one, exactly as delete() does not -- and the prior retryPromise here was
    // in any case a no-op, since the inner swallow resolved every attempt so it
    // never saw a rejection to re-issue.
    if (this.fatalSftpError !== undefined) return Promise.resolve();
    return this.tracked(
      this.boundByDeadline(
        this.client.delete(path, true).then(
          () => {},
          () => {},
        ),
        "file delete",
        path,
        "delete",
      ).then(
        () => {},
        () => {},
      ),
    );
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    return this.withSessionRecovery(
      () => this.renameOnce(fromPath, toPath),
      // On the re-issue only: if the pre-drop rename landed, the re-issue sees the
      // source gone (SSH_FX_NO_SUCH_FILE) or a code-4 dest-exists. Confirm via a
      // raw existence check on the destination -- every rename destination in this
      // app is self-prefixed (<id>-hello.json, the <id>-...json message temp->final,
      // <myId>-<orig>-ack.json, <id>-abort.json, the joiner <id>-joining.json ->
      // <id>-hello.json), so a present destination is unambiguously our own landed
      // attempt, never a peer file -- and resolve as success. Any other failure, or
      // an absent destination, propagates. The raw client.exists (not this.exists)
      // avoids arming a second recovery/warn wrapper for this internal probe.
      (run) =>
        run().catch(async (error: unknown) => {
          const code = (error as Ssh2SftpError | null | undefined)?.code;
          if (this.isNoSuchFileError(error) || code === SSH_FX_FAILURE) {
            // Confirm a landed pre-drop rename via a raw existence check, but if
            // the probe itself rejects the ambiguity cannot be resolved: fall back
            // to the ORIGINAL rename error rather than letting the probe's own
            // failure replace it (mirrors createExclusiveOnce's SFTPv3 fallback,
            // which keeps the original openErr when its exists() check rejects).
            const landed = await this.client.exists(toPath).catch(() => false);
            if (landed) return;
          }
          throw error;
        }),
    );
  }

  private renameOnce(fromPath: string, toPath: string): Promise<void> {
    // Retry a transient rename failure under put()'s bounded budget (one initial
    // attempt plus up to `retries` re-issues, 100 ms apart), but -- unlike put(),
    // which is idempotent -- only on the generic SSH_FX_FAILURE (status 4). That
    // is the "operation did not take effect" code that surfaced as the
    // intermittent `_rename: Failure` on the rendezvous joiner's
    // <id>-joining.json -> <id>-hello.json publish (and is equally reachable on
    // send()/writeAck()'s temp-file -> final-name publishes): the server reported
    // the rename did not happen, so `fromPath` still exists and a re-issue is
    // safe. Every other status is terminal and surfaces at once -- crucially
    // SSH_FX_NO_SUCH_FILE (2), which a second attempt would see if the first had
    // actually succeeded but its reply was lost; retrying that would turn a
    // succeeded rename into a spurious error. ssh2-sftp-client passes the raw
    // ssh2 numeric status through fmtError to err.code (the same premise
    // createExclusive relies on); a non-status library error (e.g. a dead-session
    // 'ERR_GENERIC_CLIENT') is not 4 and so is not retried.
    return this.tracked(
      this.warnIfSlow(
        this.countedOperationRetry(
          () => {
            // Re-check the dead-session guard before EVERY attempt, not only at
            // method entry. A fatal SFTP protocol error can land in the gap
            // between attempts (an unsolicited malformed packet, or a malformed
            // reply to a just-completed attempt): it sets fatalSftpError but
            // leaves no in-flight request for ssh2's cleanupRequests to fail. The
            // next attempt would then buffer its request on the
            // destroyed-but-socket-alive channel, whose callback never fires, and
            // hang until the consumer's whole-exchange budget -- defeating, for
            // the retried rename, the prompt-failure guarantee this guard gives
            // every other server-driven op. Re-checking turns it into a prompt
            // TransportOperationStalledError, which is not status 4 and so ends
            // the retry rather than being re-issued.
            const dead = this.deadSessionError("file rename", fromPath);
            if (dead) return Promise.reject(dead);
            // Bound each attempt's server round-trip: a withheld rename callback
            // fast-fails in 60 s with the typed terminal error (which, not being
            // SSH_FX_FAILURE, ends the retry below) rather than hanging this attempt
            // forever and stalling the whole exchange. rename is a single metadata
            // round-trip, so the flat deadline carries negligible false-fail risk.
            return this.boundByDeadline(
              this.client.rename(fromPath, toPath).then(() => {}),
              "file rename",
              fromPath,
              "rename",
            );
          },
          // `??` not `||` so an explicit retries: 0 disables the retry rather than
          // being coerced to the default of 5.
          this.options!.retries ?? 5,
          100,
          (error) =>
            (error as Ssh2SftpError | null | undefined)?.code ===
            SSH_FX_FAILURE,
        ),
        "file rename",
        `${fromPath} to ${toPath}`,
      ),
    );
  }

  createExclusive(path: string): Promise<void> {
    return this.withSessionRecovery(
      () => this.createExclusiveOnce(path),
      // On the re-issue only: if this party's pre-drop create actually landed, the
      // re-issue sees its OWN lock file and reports EEXIST -- reusing the existing
      // code-11 / code-4-via-exists() normalization in createExclusiveOnce, which
      // sets code "EEXIST" -- so resolve as success rather than a spurious lock
      // conflict.
      //
      // Edge case (verified plausibly benign, do NOT re-architect the rendezvous):
      // in the narrow race where this party's create dropped AT ENTRY and the peer
      // legitimately won the shared-named lock in the meantime, the re-issue EEXIST
      // is the PEER's, yielding a transient "two winners" state. It is benign
      // because roles are committed from hello-filename order BEFORE the lock is
      // taken, the lock only gates eager coordination-file cleanup, leftover hellos
      // are excluded from message polling, and leftover files are swept at close;
      // and it is confined to the brief rendezvous phase, not the ~10-min mid-
      // exchange drop this recovery targets. Resolving own-EEXIST-as-success is the
      // implementation; the security review verifies the race rigorously.
      (run) =>
        run().catch((error: unknown) => {
          if (
            (error as NodeJS.ErrnoException | null | undefined)?.code ===
            "EEXIST"
          )
            return;
          throw error;
        }),
    );
  }

  private createExclusiveOnce(path: string): Promise<void> {
    // ssh2-sftp-client does not expose exclusive file creation; access the
    // underlying SFTP session (via the file-scope Ssh2SftpClientInternals
    // interface) to open with SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL
    // (0x2A). SSH_FXF_EXCL is part of the core SFTPv3 protocol and requires no
    // server extension. Numeric flags are used directly instead of a string alias
    // ('wx') because SFTPWrapper's string-to-openmask translator is not part of
    // the public API contract, and an unrecognized string would silently degrade
    // to a non-exclusive open. The null check below guards against a closed or
    // prematurely-ended session; an API rename is caught at connect time by the
    // check in connect(). The open-failure status handling is at the point of use
    // below.
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp) return Promise.reject(new Error(SFTP_SESSION_CLOSED_MESSAGE));
    const dead = this.deadSessionError("exclusive create", path);
    if (dead) return Promise.reject(dead);
    // SSH_FXF_WRITE (0x02) | SSH_FXF_CREAT (0x08) | SSH_FXF_EXCL (0x20)
    const EXCL_WRITE_CREATE = 0x2a;
    const attempt = new Promise<void>((resolve, reject) => {
      sftp.open(path, EXCL_WRITE_CREATE, {}, (openErr, handle) => {
        if (openErr) {
          // Normalize SFTPv4+ FILE_ALREADY_EXISTS (11) directly to EEXIST.
          // SFTPv3 FAILURE (4) is ambiguous: resolve it via an exists() check
          // and normalize to EEXIST only when the file is actually present.
          // If a future ssh2 version already normalizes to the POSIX string
          // "EEXIST", pass the error through unchanged to avoid wrapping noise.
          // A new error is created for the numeric codes rather than mutating
          // openErr: ssh2 constructs a fresh error per callback, but treating
          // the caught object as immutable avoids surprising callers that
          // inspect the original.
          const errCode = (openErr as unknown as Record<string, unknown>).code;
          if (errCode === 11) {
            reject(
              Object.assign(new Error(openErr.message), {
                code: "EEXIST",
                cause: openErr,
              }),
            );
            return;
          }
          if (errCode === SSH_FX_FAILURE) {
            // If exists() itself rejects (e.g., a second network failure
            // immediately after the exclusive-open failure), the ambiguity
            // cannot be resolved; propagate openErr unchanged so the caller
            // sees the original I/O error rather than a confusing secondary
            // one.
            // Raw client existence check, not this.exists(): the public method
            // is warnIfSlow-wrapped, and the whole `attempt` (this fallback
            // included) is already wrapped once at the return site, so routing
            // through this.exists() here would arm a second, overlapping slow-op
            // warning for the same logical createExclusive. The outer wrap still
            // bounds and reports this check.
            this.client
              .exists(path)
              .then(Boolean)
              .then(
                (fileExists) => {
                  reject(
                    fileExists
                      ? Object.assign(new Error(openErr.message), {
                          code: "EEXIST",
                          cause: openErr,
                        })
                      : Object.assign(
                          new Error(
                            `SFTP exclusive-create failed (SSH_FX_FAILURE) ` +
                              `and the target file is not present, so the ` +
                              `cause is a server-side I/O error rather than a ` +
                              `lock-file race. Check the SFTP server logs for ` +
                              `the underlying cause (disk full, permissions, ` +
                              `quota) before retrying; SFTPv3 cannot ` +
                              `distinguish a transient race from a permanent ` +
                              `failure, so a single retry is reasonable only ` +
                              `if a race is plausible. Original error: ` +
                              `${openErr.message}`,
                          ),
                          { cause: openErr },
                        ),
                  );
                },
                () => reject(openErr),
              );
            return;
          }
          reject(openErr);
          return;
        }
        sftp.close(handle, (closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve();
        });
      });
    });
    // Bound the whole operation -- open, the SFTPv3 code-4 exists() fallback, and
    // close -- against a server that withholds any of those callbacks, so an
    // exclusive create cannot hang the rendezvous lock path forever. The wrapper
    // only races: a handle opened just before a withheld close is not reclaimed
    // (that close cannot itself complete), but the exchange fails terminally
    // rather than stalling, and the session teardown releases the session.
    return this.tracked(
      this.warnIfSlow(
        this.boundByDeadline(
          attempt,
          "exclusive create",
          path,
          "open, existence-check, or close",
        ),
        "exclusive create",
        path,
      ),
    );
  }

  exists(remotePath: string): Promise<boolean> {
    return this.withSessionRecovery(() => this.existsOnce(remotePath));
  }

  private existsOnce(remotePath: string): Promise<boolean> {
    // Reject rather than return a boolean on a dead session: a destroyed channel
    // cannot answer the stat, and a fabricated true/false would be a guess the
    // caller could act on. (createExclusive()'s code-4 ambiguity fallback does its
    // own existence check via the raw client, not this method, so this guard does
    // not affect it.)
    const dead = this.deadSessionError("existence check", remotePath);
    if (dead) return Promise.reject(dead);
    // exists is a single metadata stat round-trip, so a flat per-operation deadline
    // carries negligible false-fail risk and fast-fails a withheld stat callback in
    // 60 s rather than letting the lock-path race check ride the whole-exchange
    // budget.
    return this.tracked(
      this.warnIfSlow(
        this.boundByDeadline(
          this.client.exists(remotePath).then(Boolean),
          "existence check",
          remotePath,
          "stat",
        ),
        "existence check",
        remotePath,
      ),
    );
  }
}
