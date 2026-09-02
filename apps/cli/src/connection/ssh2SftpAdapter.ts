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
  TransportPublishIndeterminateError,
  UsageError,
  getLoggerForVerbosity,
  isProtocolTempName,
  retryPromise,
  sanitizeErrorForDisplay,
  redactAndSanitizeForDisplay,
} from "@psilink/core";

import { createCappedSink } from "./frameSizeGuard";
import { SftpAdapterLedger } from "./sftpAdapterLedger";
import type {
  IdleBoundaryOutcome,
  LossCause,
  SftpSessionAccounting,
} from "./sftpAdapterLedger";
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
import {
  constrainKexToPlatformCapabilities,
  explainKexNegotiationFailure,
  isUnperformableKexNegotiationFailure,
  unavailableKexPrimitives,
} from "./sftpKexCapability";
import {
  diagnosePeerAnswer,
  isPreIdentificationDialFailure,
  peerProbeTargetFromConnectOptions,
} from "./sftpPeerIdentification";
import {
  resolveEndedTransportCloseSeams,
  resolveTerminalCloseSeam,
  resolveTransportCloseSeams,
  transportCloseSeamError,
} from "./sftpClientInternals";
import type {
  EndedTransportCloseSeams,
  Ssh2SftpClientInternals,
  Ssh2SftpError,
} from "./sftpClientInternals";
import {
  IDLE_BOUNDARY_ENDS_THE_GENERATION,
  SESSION_BOUNDARY_READINGS,
  idleBoundarySessionReading,
} from "./sftpIdleBoundary";
import type { SessionBoundary } from "./sftpIdleBoundary";

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

// Upper bound (ms) on a queued session transition's wait for the transition
// ahead of it. Derivation: docs/spec/CHANNEL_SECURITY.md, "The
// session-transition lock".
const TRANSITION_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * Cap on the connection-per-poll record of unperformed cleanup deletes of the
 * protocol's own in-flight temp file; overflow refuses rather than evicts.
 * Derivation: docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete
 * record".
 */
export const MAX_DEFERRED_CLEANUP_DELETES = 64;

/**
 * Re-issue budget for ONE RECORDING of a cleanup delete, after which that
 * recording gives up and its file is left behind. Derivation:
 * docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record".
 *
 * @internal exported for the adapter's own tests
 */
export const MAX_DEFERRED_CLEANUP_REISSUES = 3;

/**
 * Deletes core's rendezvous entry sweep can put on the shared ssh2 `Client` in
 * one fan, counted into {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}.
 *
 * Twice {@link MAX_DIRECTORY_ENTRIES} because the sweep is scoped to a party's
 * DIRECTORIES rather than to one listing: it merges the inbound listing's peer
 * hellos and unexpected protocol files with the outbound listing's own leftovers
 * into a single array and fans one delete per element of it. Under a split
 * inbound/outbound scope those are two listings, each refused separately at
 * {@link MAX_DIRECTORY_ENTRIES}, so the fan is bounded by their union; under a
 * shared scope the two collapse to one listing and the term is slack.
 *
 * The same term covers the three narrower delete fans core's entry scan issues
 * ahead of that sweep -- the orphaned-temp sweep and the leftover-abort-marker
 * sweep over the inbound listing, and the split-mode outbound-orphan sweep over
 * the outbound one. Each fans one delete per element of a SUBSET of a single
 * listing, so each is at most {@link MAX_DIRECTORY_ENTRIES}, half this term; and
 * each is awaited to completion before the next is issued and before the sweep,
 * so none of them stacks on another or on it and the widest fan the entry scan
 * puts on this client at any instant is the sweep's own.
 */
const MAX_SPLIT_SCOPE_ENTRY_SWEEP_DELETES = 2 * MAX_DIRECTORY_ENTRIES;

/**
 * Listeners the shared ssh2 `Client` can carry on one event name for work
 * running BESIDE the widest fan, counted into
 * {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}. MEASURED rather than summed;
 * the runs behind it are in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP
 * Stack".
 *
 * @internal exported for the adapter's own tests
 */
export const CONCURRENT_OPERATIONS_BESIDE_A_FAN = 3;

/**
 * Listeners the shared ssh2 `Client` carries on its busiest event name with
 * nothing in flight, counted into
 * {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}: ssh2-sftp-client's
 * constructor `globalListener` (one each on `'error'`, `'end'` and `'close'`)
 * plus this adapter's own persistent transport-lifecycle watch (one each on
 * `'end'` and `'close'`; see
 * {@link SSH2SFTPClientAdapter.watchTransportLifecycle}). Neither is a
 * per-operation listener, so both stand under every fan.
 */
const PERSISTENT_SHARED_CLIENT_LISTENERS_PER_EVENT = 2;

/**
 * Listeners the shared ssh2 `Client` can carry at once on one event name, with
 * every fan that reaches it at its own bound simultaneously.
 *
 * The terms are SUMMED rather than maxed, so nothing here rests on two fans
 * being unable to overlap: core's rendezvous entry sweep
 * ({@link MAX_SPLIT_SCOPE_ENTRY_SWEEP_DELETES}) issues its deletes through the
 * same recovery chokepoint that can set the connection-per-poll cleanup drain
 * ({@link MAX_DEFERRED_CLEANUP_DELETES}) running, and both stack on what runs
 * beside them ({@link CONCURRENT_OPERATIONS_BESIDE_A_FAN}) above what the client
 * holds when idle ({@link PERSISTENT_SHARED_CLIENT_LISTENERS_PER_EVENT}).
 *
 * The one fan with no cap of its own -- the connection cleanup's sweep of this
 * party's own unconsumed writes -- is not a term here: it rests on the entry
 * sweep's, those writes being entries of a directory this party's own poll
 * listing enumerates and that listing's refusal governs. An assumption rather
 * than an enforced cap, and the only one, which is affordable because crossing
 * this number costs a stderr line and nothing else. What that assumption has
 * behind it is a run rather than an argument alone: the cleanup sweep is driven
 * at the width its listing bound admits and its fan measured at the server
 * (`concurrentDeleteFanWidth.test.ts`), evidence for the assumption rather than
 * a bound making it one.
 */
const PEAK_SHARED_CLIENT_LISTENERS_PER_EVENT =
  MAX_SPLIT_SCOPE_ENTRY_SWEEP_DELETES +
  MAX_DEFERRED_CLEANUP_DELETES +
  CONCURRENT_OPERATIONS_BESIDE_A_FAN +
  PERSISTENT_SHARED_CLIENT_LISTENERS_PER_EVENT;

/**
 * Ceiling this adapter raises on its shared ssh2 `Client`'s per-event listener
 * count, in place of Node's default of 10. The derivation, the measured
 * behavior behind it, and what an ssh2 / ssh2-sftp-client bump re-confirms are
 * in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack".
 *
 * @internal exported for the adapter's own tests
 */
export const SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS =
  PEAK_SHARED_CLIENT_LISTENERS_PER_EVENT;

/**
 * Per-operation deadline (ms) a drain re-issue is held to
 * ({@link SSH2SFTPClientAdapter.reissueCleanupDelete}) in place of the
 * {@link SFTP_STALL_DEADLINE_MS} every other round trip carries, and so the
 * bound on the whole drain. Derivation: docs/spec/CHANNEL_SECURITY.md, "The
 * deferred cleanup-delete record".
 */
const DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS = 5_000;

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
// leaves a session to re-issue onto, and so the only one that can count as a
// survived drop -- whether this arm dialed it or found it already established
// (which one it was does not decide the accounting; see
// SSH2SFTPClientAdapter.withSessionRecovery). The rest all mean nothing was
// dialed, and are kept apart because the re-issue is right in one and wrong in the
// others: over a CLEARED session the re-issue rejects at once with the real loss,
// while over a session that still reads live on an ended transport it cannot
// complete and would ride the per-operation liveness deadline a second time before
// failing as it would have anyway. `unretiredTransport` is the third state and a
// different one again: the session HAS cleared, but the transport under it still
// owes the ssh2 Client a lifecycle event, and a dial issued into that window is
// the one this adapter must never make (see
// SSH2SFTPClientAdapter.retireTransportForRedial).
type RecoveryRedialOutcome =
  "sessionLive" | "noSession" | "deadSessionHeld" | "unretiredTransport";

// Whether the transport the last dial established can be left behind for the
// recovery re-dial to dial over. `retired` is the only state a dial may follow;
// the other two are the two ways retiring it failed, each mapping onto the
// re-dial outcome of the same name.
type TransportRetirement = "retired" | "deadSessionHeld" | "unretiredTransport";

// What the recovery re-dial can tell about the transport beneath a session that
// has already been cleared: whether the ssh2 Client still owes that transport its
// 'close', whether the whole lifecycle sequence has been delivered, or nothing at
// all. `unreadable` is a THIRD state rather than a synonym for `delivered` --
// a Client with no on() to watch never sets the awaiting-close flag, so reading
// its absence as a delivered sequence would send the dial into an owed 'close',
// which is the failure the retirement exists to prevent (see
// SSH2SFTPClientAdapter.watchTransportLifecycle).
type TransportCloseReading = "owed" | "delivered" | "unreadable";

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

// What one data-plane operation's SECOND attempt is, where it has one (see
// SSH2SFTPClientAdapter.runOperation). `verbatim` re-runs the operation as it
// stands; `reissued` carries the per-operation idempotency relaxation, which is
// applied on that attempt and never on the first, so a delete-absent,
// rename-destination-exists or own-EEXIST reading cannot leak into first-attempt
// semantics and break genuine absence or lock-conflict detection; `none` is an
// operation that never enters recovery at all.
type OperationRecoverySpec<T> =
  | { readonly recovery: "verbatim" }
  | {
      readonly recovery: "reissued";
      readonly reissue: (run: () => Promise<T>) => Promise<T>;
    }
  | { readonly recovery: "none" };

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

// One session transition, as runTransition takes it. The arms follow the abandon
// dispositions above, so the value each kind reports is stated where the
// disposition record says it is needed and nowhere else -- except the idle
// release, split out because it alone carries a data-plane precondition and so
// alone has a fourth thing it can report. Teardown carries no `skipped` because it
// is the transition the teardown latch is set FOR: every other kind states what it
// returns when it reaches the front of the queue with that latch already set.
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
      kind: "releaseForIdle";
      run: (held: HeldSessionTransition) => Promise<T>;
      skipped: () => T;
      abandoned: () => T;
      // What the release reports at a boundary it declines to close because an
      // operation is still outstanding on the session. Kept apart from both
      // siblings because the causes differ and so do the remedies: `skipped`
      // answers a connection closing on purpose, `abandoned` a transition that
      // never got its turn, and this one a session deliberately kept up for the
      // operation on it, which the first boundary past that operation's settlement
      // releases.
      heldForOutstandingOperation: () => T;
    }
  | {
      kind: Exclude<
        SessionTransitionKind,
        "teardown" | "connect" | "releaseForIdle"
      >;
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

// The final segment of a remote path. SFTP paths are POSIX-separated on the wire
// whatever either end's platform is, so a backslash is an ordinary character in a
// remote filename here and must not be read as a separator. A path with no
// separator at all is its own basename.
const remoteBasename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

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
  // Latched true once a dial failure has been put to the non-SSH-answer
  // diagnosis, which is the whole of its budget on this connection: the
  // diagnosis opens a TCP connection of its own, and the connection-per-poll
  // mode dials at every cycle start, so an unlatched one would re-dial a peer
  // that is already answering wrongly once per tick for as long as the condition
  // stands. Latched where the read is spent rather than where it produces a
  // diagnostic, because the connection is the cost. Never cleared: what it says
  // is that this run has already told the operator what answered the port.
  private peerAnswerDiagnosisSpent = false;
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
  // the previous reading when a transition rejects, and by taking a release reading
  // back from a transition that leaves a session live. Read at two sites, which ask
  // different questions of it (SESSION_BOUNDARY_READINGS holds both answers per
  // variant): withSessionRecovery's gate re-establishes before the first attempt of
  // an operation a release left no session for, and the boundary's own outcome
  // recording reads the classification back to decide whether the loss it charges
  // is the partner's or this side's own. Discharged by the dial that re-establishes
  // the session -- the single path every re-establishment goes through -- so a
  // failed dial leaves it standing and a genuine drop after a completed
  // re-establishment is counted and warned as one. Outside the release's own close
  // window, no release reading stands where a session is live: the exempting one
  // would classify that session's next real drop as deliberate, the misreport it
  // exists to prevent, and the other would send that session's next operation
  // through a re-establishment it does not need.
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
  // True once the transport-lifecycle listeners have been attached to that same
  // Client, on the same once-per-adapter terms and for the same reason. Doubles as
  // whether the flag below carries a reading at all: while this is false nothing
  // writes it, so it is an absence of information rather than an observation. See
  // watchTransportLifecycle and readTransportCloseState.
  private transportLifecycleWatched = false;
  // Whether the ssh2 Client has emitted the transport's 'end' without yet having
  // emitted its 'close' -- the window in which a dial issued on this Client is
  // rejected by ssh2-sftp-client's connect-time listeners, which fail a dial on
  // ANY lifecycle event reaching them while a handshake is in progress. The
  // recovery re-dial is the one dial that can be raised in that window (a
  // high-level operation is torn by the 'end' and rejects on it, a full event
  // ahead of the 'close'), so it is the one that reads this. Written only by the
  // Client's own events, never cleared by a dial: the reading is about the
  // transport the events belong to, and the retirement that precedes the dial is
  // what ends it. Meaningful only alongside the flag above: on a Client with no
  // on() to watch it with, nothing ever sets it, so it is read through
  // readTransportCloseState rather than directly.
  private transportAwaitingClose = false;
  // True once the retirement has warned that it has no lifecycle reading to take.
  // Whether the Client exposes on() is a property of the installed version rather
  // than of any one drop, so a second copy of that warning on the next re-dial
  // tells the operator nothing the first did not. See
  // warnUnreadableTransportLifecycle.
  private transportLifecycleUnreadableWarned = false;
  // This adapter's session generations, operator-facing counters and the cadence
  // its repeating warnings share (see ./sftpAdapterLedger). The warn sink is a closure rather
  // than the logger itself so the ledger stays free of the log's type and reads
  // the adapter's log at the moment a line is due.
  private readonly ledger = new SftpAdapterLedger({
    warn: (message: string) => this.log.warn(message),
  });
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
  // at the start of the next cycle (ensureConnected), so a session a server's
  // max-session/idle cap would drop is not held across an idle gap -- save a
  // boundary kept for an operation still outstanding (see runTransition). Off by
  // default (the whole-exchange single-session model). See
  // docs/notes/connection-per-poll-sftp.md.
  private readonly ephemeralSessions: boolean;
  // Paths of the protocol's own in-flight temp writes whose cleanup delete was
  // not performed, kept for re-issue at the next point a session exists (see
  // deferCleanupDelete, which is where the shape is enforced, and
  // drainDeferredCleanupDeletes). Populated only in connection-per-poll mode,
  // where the never-reject cleanup delete -- outside the recovery chokepoint, and
  // so outside the session gate that chokepoint applies -- can be issued into an
  // idle gap and reach no session at all. Only the adapter can tell that no-op
  // from a real delete: safeDelete resolves either way, so its caller in core
  // cannot. Keyed by path because the same path recorded twice is one cleanup,
  // and because the drain removes by identity; the value is the re-issues that
  // path has left (see MAX_DEFERRED_CLEANUP_REISSUES), carried on the record
  // rather than in a counter of its own so an entry cannot outlive its budget.
  private readonly deferredCleanupDeletes = new Map<string, number>();
  // The drain currently running, so a second call joins it rather than issuing a
  // second delete for the same path. Cleared when it settles, which is what lets
  // a later re-establishment drain a record made after this one took its
  // snapshot.
  private deferredCleanupDrain: Promise<void> | undefined;

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
   * and re-dials at the start of the next cycle, so a session a server's
   * max-session/idle cap would drop is not held across an idle gap -- save a
   * boundary kept for an operation still outstanding (see {@link runTransition}).
   * Off by default.
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
    // ssh2-sftp-client constructs its ssh2 Client eagerly and keeps that one
    // instance for every dial, so the ceiling is seated here rather than per
    // connect; that the emitter each operation attaches to is this one, and
    // survives a re-dial, is pinned by the integration suite rather than
    // asserted here.
    const constructed = this.client as unknown as Ssh2SftpClientInternals;
    if (typeof constructed.client?.setMaxListeners === "function")
      constructed.client.setMaxListeners(
        SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS,
      );
    else
      this.log.warn(
        "ssh2's client is not reachable to raise its event-listener ceiling; " +
          "a wide concurrent sweep may print a spurious Node memory-leak " +
          "warning to stderr",
      );
    this.stallDeadlineMs = options.stallDeadlineMs ?? SFTP_STALL_DEADLINE_MS;
    this.ephemeralSessions = options.ephemeralSessions ?? false;
    this.heartbeat = new SftpHeartbeat({
      ping: () => this.sendKeepalive(),
      log: this.log,
    });
  }

  /**
   * Connection re-establishment attempts over this adapter's life: connect-retry
   * re-attempts past the first, plus every session this exchange LOST to the
   * partner. A session this adapter itself ended is not one of those -- teardown,
   * a fatal protocol error, or a connection-per-poll idle release that was itself
   * what ended the session -- so a healthy exchange reports the drops it had and
   * no others. A plain operational counter, never a partner-controlled value.
   */
  get reconnectCount(): number {
    return this.ledger.reconnectCount;
  }

  /**
   * The subset of {@link reconnectCount} that were sessions lost mid-exchange to
   * the partner rather than connect-time dialing retries, surfaced apart from the
   * merged total so the end-of-run summary can distinguish chronic mid-exchange
   * drops from benign startup retries. One per session LOST, not per operation
   * the loss tore and not per re-dial that recovered it: a drop that tears
   * several concurrent operations moves this by one, and so does one whose
   * recovery re-dial fails or is refused on the exhausted budget. In
   * connection-per-poll mode it counts a drop within a cycle as well as one the
   * idle boundary absorbed with the wire empty, both being sessions the partner
   * took. A plain operational counter, never a partner-controlled value.
   */
  get midExchangeReconnectCount(): number {
    return this.ledger.midExchangeReconnectCount;
  }

  /** @internal */
  get sessionAccounting(): SftpSessionAccounting {
    return this.ledger.accounting;
  }

  /**
   * Transport data-operation retries over this adapter's life: the number of
   * put/rename re-issues past the first attempt, summed across every operation.
   * A plain operational counter, never a partner-controlled value.
   */
  get transportRetryCount(): number {
    return this.ledger.transportRetryCount;
  }

  /**
   * Idle boundaries at which the partner's SFTP server did not close the
   * connection within the release's bound, so the connection-per-poll release
   * ended the boundary itself (see {@link releaseForIdle}). A subset of
   * {@link releasedBoundaryCount}, which is the denominator it is read against:
   * the two are the same boundary reached two ways. It says nothing about whether
   * a session was ALSO lost at that boundary -- a release closing over a
   * transport a partner's drop had already ended reaches this same forced close,
   * and that loss is counted in {@link reconnectCount} like any other. 0 in every
   * other mode and against a server that closes on request. A plain operational
   * counter, never a partner-controlled value.
   */
  get forcedReleaseCount(): number {
    return this.ledger.forcedReleaseCount;
  }

  /**
   * Idle boundaries at which the connection-per-poll release ended the session,
   * every way it ends one: the partner's server answered the close within the
   * bound, or it did not and this side forced the transport closed. It is
   * {@link forcedReleaseCount}'s denominator -- a forced total alone cannot tell
   * an exchange whose every cycle was forced from one where a handful were -- so
   * the forced count is a subset of this rather than a sibling of it. Not itself
   * a reconnection: whether a session was also LOST at one of these boundaries is
   * what {@link reconnectCount} answers, and a partner drop the release closed
   * over is counted there. 0 in every other mode. A plain operational counter,
   * never a partner-controlled value.
   */
  get releasedBoundaryCount(): number {
    return this.ledger.releasedBoundaryCount;
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
    return this.ledger.declinedReleaseCount;
  }

  /**
   * Poll cycles the connection-per-poll cycle-START re-dial skipped, having
   * given up its bounded wait for the session transition ahead of it (see
   * {@link ensureConnected}). The cycle carried no session and the poll loop
   * skipped it, so it is the dialing half of what {@link declinedReleaseCount}
   * reports for the releasing half: one stuck transition declines both signals
   * of the same cycle, and the two are counted apart so neither line's total is
   * the other's occurrences. NOT a reconnection and not a lost session: nothing
   * was dialed and nothing was closed. 0 in every other mode. A plain
   * operational counter, never a partner-controlled value.
   */
  get declinedCycleRedialCount(): number {
    return this.ledger.declinedCycleRedialCount;
  }

  /**
   * Idle boundaries at which the connection-per-poll release closed NOTHING
   * because an operation this adapter had ISSUED was still unsettled, so the
   * session stayed live across the idle gap rather than being cut off that
   * operation (see {@link releaseForIdle}). Its cause is neither
   * {@link forcedReleaseCount}'s -- a boundary this adapter did end -- nor
   * {@link declinedReleaseCount}'s -- a transition the release gave up waiting on
   * -- so none of the three is ever summed into another. NOT a reconnection and
   * not a lost session: nothing was closed, so it is absent from
   * {@link reconnectCount} too. 0 in every other mode and on any run whose
   * boundaries all fell with the wire empty. A plain operational counter, never a
   * partner-controlled value.
   */
  get heldBoundaryCount(): number {
    return this.ledger.heldBoundaryCount;
  }

  /**
   * Unbroken stretches the boundaries of {@link heldBoundaryCount} fall in: a
   * stretch opens at a held boundary with none open and closes when the adapter's
   * outstanding-operation count next empties. One operation held across twenty
   * boundaries is 20 boundaries in 1 stretch; twenty operations each settling
   * between boundaries are 20 in 20 -- the first says the mode has stopped
   * delivering per-cycle sessions, the second that it is working. It measures
   * unbroken hold rather than operations: operations overlapping so the
   * outstanding count never empties read as ONE stretch however many of them
   * there were. Never exceeds {@link heldBoundaryCount}, and 0 wherever that is.
   * A plain operational counter, never a partner-controlled value.
   */
  get heldBoundaryStretchCount(): number {
    return this.ledger.heldBoundaryStretchCount;
  }

  // Acquire this adapter's one session-transition lock and run `transition`
  // under it. The ordering, the teardown latch, the bounded acquire and each
  // kind's abandoned disposition are in docs/spec/CHANNEL_SECURITY.md, "The
  // session-transition lock".
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
      // The idle release is the one transition with a data-plane precondition: an
      // operation already on the wire when the boundary falls would be torn by the
      // close, so the release keeps the session up and the first boundary past that
      // operation's SETTLEMENT ends it. What bounds that hold is the operation's
      // own settlement -- its per-operation deadline where it carries one, and
      // nothing on this side where it does not (a put from a string or stream
      // source, and a progress-reset window a trickling server re-arms rather than
      // trips), in which case the session stays held for the rest of the exchange.
      // Read here, with the queue held and nothing yet driven, so an operation
      // issued while this release was still QUEUED behind another transition is
      // covered as well. The release gains no wait from this: it returns rather
      // than draining, and every bound over the transition queue stands unchanged.
      // No other kind may hold for an operation -- a teardown closes over whatever
      // is outstanding by design, a recovery re-dial would park behind the very
      // class of operation that drove it, and neither dial has a session to keep.
      if (
        transition.kind === "releaseForIdle" &&
        this.ledger.outstandingOperations > 0
      )
        return transition.heldForOutstandingOperation();
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
        // No transition leaves a reading that a release took the session standing
        // over a live session, and each of the two such readings is wrong there for
        // its own reason: the exempting one exempts the next drop from the reconnect
        // counters and the operator warning, and over a session the server can still
        // drop that hides a partner-caused failure, while the other sends that
        // session's next operation through a re-establishment of a session it
        // already has. Two routes reach that state -- a release that ended nothing
        // (its own raise takes the reading back only as far as the one it entered
        // with), and a dial that established a session and then failed its
        // post-connect verification, never reaching its own discharge, whose failure
        // the cycle-start reconnect reports as a cycle to skip rather than a raise.
        // The release's own close window is no exception: it records the boundary
        // while its transition still holds, and by the time that transition leaves,
        // the session it ended is gone.
        if (
          SESSION_BOUNDARY_READINGS[this.sessionBoundary]
            .releaseTookTheSession &&
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
    throw new Error(
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
   * invocation of `fn` past the first) bumps {@link transportRetryCount}.
   * Surfaces how often an operation was re-issued over the run for the metrics
   * summary, reusing the operation's own retry loop rather than adding parallel
   * state.
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
        if (attempted) this.ledger.countTransportRetry();
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

  // Every data-plane call this adapter issues to the server enters here, and the
  // operation's outstanding span is opened HERE rather than inside the recovery
  // round below it: one span from issue to final settlement, covering the first
  // attempt, the re-dial that may follow it and the re-issue, so no point in an
  // operation's life reads as a wire this adapter has nothing on. The
  // idle-boundary release's precondition is that count, so what the single span
  // buys is that no boundary can fall between a torn attempt and its recovery and
  // close the session the recovery is about to use.
  //
  // Issued-and-unsettled is not the set that is on the wire, and departs from it
  // in both directions: an adapter bound that expires settles the operation while
  // the library request it raced is still outstanding at the server, and an
  // operation the server never answers is never settled from this side at all,
  // core's whole-exchange budget being a race that abandons rather than a
  // cancellation.
  //
  // `spec` is the operation's re-issue policy, applied ONLY on the second
  // attempt: `verbatim` re-runs the operation as it stands, `reissued` applies
  // the per-operation idempotency relaxation it carries, and `none` is an
  // operation that never enters recovery at all -- the never-reject cleanup
  // delete, and a put whose source cannot be re-issued. The last of those is
  // counted outstanding exactly like the rest, from the moment it is ISSUED,
  // which is what keeps a release from closing over one.
  private runOperation<T>(
    spec: OperationRecoverySpec<T>,
    body: () => Promise<T>,
  ): Promise<T> {
    const settled = this.ledger.openOperation();
    const run =
      spec.recovery === "none"
        ? body()
        : this.withSessionRecovery(
            body,
            spec.recovery === "reissued" ? spec.reissue : undefined,
          );
    return run.finally(settled);
  }

  // Bracket one ATTEMPT of a server-driven operation with the heartbeat's
  // activity accounting. Why per-attempt, and the three round trips outside it,
  // are in docs/spec/CHANNEL_SECURITY.md, "The outstanding-operation hold on an
  // idle boundary".
  private tracked<T>(op: Promise<T>): Promise<T> {
    const epoch = this.heartbeat.opStarted();
    return op.finally(() => {
      this.heartbeat.opSettled(epoch);
    });
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

  // Attach a single guarded 'error' listener to the raw ssh2 SFTPWrapper, once
  // per wrapper instance. What it closes, and what bounds an in-flight operation
  // after it fires, are in docs/spec/CHANNEL_SECURITY.md, "SFTP fatal-packet
  // crash safety".
  private attachFatalErrorListener(
    sftp: NonNullable<Ssh2SftpClientInternals["sftp"]>,
  ): void {
    if (this.guardedSftp === sftp) return;
    this.guardedSftp = sftp;
    this.fatalSftpError = undefined;
    sftp.on("error", (err: Error) => {
      this.fatalSftpError = err;
      // The wrapper ssh2 destroys under a fatal packet cannot recover, so the
      // generation it carried has ended here whatever the session property still
      // says: recovery refuses to re-dial past this point, and every later
      // operation rejects at its dead-session guard. Charged as its own cause
      // rather than as a loss -- the exchange is over, and it is neither a drop
      // the operator can act on with a reconnect setting nor one anything
      // recovered from.
      this.ledger.recordLoss(this.ledger.liveGeneration, "fatal");
      // Stop beating so the heartbeat does not keep issuing realPath keepalives
      // the destroyed channel can never answer. A later connect() re-arms it via
      // start(); a later end() calls stop() again (a no-op once stopped).
      this.heartbeat.stop();
    });
  }

  // Answer the SSH server's keyboard-interactive authentication prompts with the
  // configured password. The ssh2 behaviors it rests on, and what a bump
  // re-verifies, are in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP
  // Stack".
  //
  // The password is read from the live connect options at answer time, NOT
  // captured at attach time, so a reconnect under a different credential can
  // never be answered with a stale secret. A non-string password answers empty,
  // which fails auth cleanly rather than sending `undefined`; it is unreachable
  // from a product connect (the connect() gate attaches only when it saw a string
  // password, and reconnects reuse the same options).
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

  // Watch the ssh2 Client's transport lifecycle so the recovery re-dial can tell
  // a transport whose events have ALL been delivered from one that still owes
  // its 'close'. The measured ordering, and what an unwatchable Client costs,
  // are in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack".
  private watchTransportLifecycle(): void {
    if (this.transportLifecycleWatched) return;
    const client = (this.client as unknown as Ssh2SftpClientInternals).client;
    if (typeof client?.on !== "function") return;
    this.transportLifecycleWatched = true;
    client.on("end", () => {
      this.transportAwaitingClose = true;
    });
    client.on("close", () => {
      this.transportAwaitingClose = false;
    });
  }

  // The lifecycle reading the retirement branches on, as the three states it can
  // actually be in rather than the two the flag alone can express.
  private readTransportCloseState(): TransportCloseReading {
    if (!this.transportLifecycleWatched) return "unreadable";
    return this.transportAwaitingClose ? "owed" : "delivered";
  }

  // Reported on the terms every other seam failure on this path is: what broke,
  // what it costs, and this project's upgrade checklist. Paced to once per adapter
  // because the condition is the installed version's rather than any one drop's,
  // so a second copy carries nothing the first did not.
  private warnUnreadableTransportLifecycle(): void {
    if (this.transportLifecycleUnreadableWarned) return;
    this.transportLifecycleUnreadableWarned = true;
    this.log.warn(
      `Re-dialing an SFTP session the partner's server dropped mid-exchange ` +
        `means telling a connection that still owes ssh2 its 'close' from one ` +
        `whose events have all been delivered, which is watched through ` +
        `ssh2's client.on() -- not available after connect(), so there is no ` +
        `reading to take. Rather than dial into a window it cannot see, every ` +
        `mid-exchange re-dial this exchange closes the connection from this ` +
        `side first and waits up to ${FORCED_CLOSE_TIMEOUT_MS} ms for that ` +
        `close, which costs that wait on a connection that had already ` +
        `closed. The installed ssh2 / ssh2-sftp-client version may have ` +
        `renamed, relocated, or removed it - re-verify the internal premises ` +
        `per the "Upgrading the SFTP Stack" checklist in ` +
        `docs/spec/DEPENDENCY_PINS.md`,
    );
  }

  // A terminal error built from a previously captured fatal SFTP-protocol error,
  // or undefined if the session has not been killed. Every server-driven operation
  // consults this at entry: a request buffered on a destroyed-but-socket-still-alive
  // channel never calls back, so without this guard the op would ride its full
  // per-operation bound before failing; consulting the captured error rejects at
  // once with the real cause instead. safeDelete shares the same fatalSftpError
  // check but RESOLVES (its never-reject contract); see it for why, and see
  // drainDeferredCleanupDeletes for why a cleanup recorded before that error is
  // not re-issued after it. A typed TransportOperationStalledError (a UsageError)
  // so the poll loop and the rendezvous gate treat it as terminal, the same as
  // every other liveness bound.
  //
  // The captured error's message is the one fragment of this refusal the SERVER
  // chose, so it is handed over as the builder's server-reported fragment rather
  // than composed into the first-party sentence naming it: on one link those bytes
  // would spend the sentence's budget and could compose framing of their own that
  // read as this side's.
  private deadSessionError(
    operation: string,
    path: string,
  ): TransportOperationStalledError | undefined {
    if (this.fatalSftpError === undefined) return undefined;
    return transportOperationStalledError(
      operation,
      path,
      "the SFTP session was killed by a fatal server protocol error",
      this.fatalSftpError.message,
    );
  }

  // The outermost layer around a recovery-wrapped op: run it once and, on a
  // clean session loss, re-dial ONCE and re-issue ONCE before giving up. What
  // triggers it, what stays terminal, and what each bound protects are in
  // docs/spec/CHANNEL_SECURITY.md, "SFTP mid-exchange session recovery".
  private withSessionRecovery<T>(
    op: () => Promise<T>,
    reissue: (op: () => Promise<T>) => Promise<T> = (run) => run(),
  ): Promise<T> {
    const gate = this.reestablishAfterIdleRelease();
    const first = gate === undefined ? op() : gate.then(op);
    return first.catch(async (error: unknown) => {
      if (!this.shouldRecoverFromSessionLoss(error)) throw error;
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
      // The re-dial could not retire the transport it had to dial past -- either a
      // session still held over an ended one, or one still owing its 'close' (it
      // warned, naming what broke). Nothing was dialed and there is nothing to
      // re-issue onto, so the operation fails with the loss it already had, which
      // names the drop and its remedies rather than a dial this adapter refused to
      // make.
      if (redial === "deadSessionHeld" || redial === "unretiredTransport")
        throw error;
      // A re-dial that DECLINED -- it gave up its wait for the transition ahead of
      // it -- established nothing; the re-issue below still runs and rejects with
      // the real session-loss cause.
      return reissue(op);
    });
  }

  // The connection-per-poll session precondition, applied at the recovery
  // chokepoint. Which operations it covers, why it is adapter-owned rather than
  // spread over core's call sites, and its best-effort contract are in
  // docs/spec/CHANNEL_SECURITY.md, "Operations concurrent with a re-dial or a
  // release".
  private reestablishAfterIdleRelease(): Promise<void> | undefined {
    if (!this.idleReleaseLeftNoSession()) return undefined;
    return this.ensureConnected().then(
      () => {},
      () => {},
    );
  }

  // The two readings that say an idle release has taken the session away from an
  // operation being issued now. Both are the release's to set, and the release
  // returns before enqueuing when the mode is off, so the default held-session
  // mode reads false here every time without a mode check of its own. The first
  // covers the close window itself, including a release the PEER began (recorded
  // as the closedByPeer outcome); the second covers the gap after a release completed, and
  // asks only whether a release took the session -- WHOSE loss it closed over is
  // the recovery arm's question, not this one's, and a release that closed over a
  // partner's drop left no session for this operation exactly as any other did.
  //
  // Read from two places, which is why it is one method rather than two copies of
  // the pair: the recovery chokepoint's gate, which re-establishes before the
  // operation's first attempt, and the cleanup delete, which reaches no gate and
  // records itself for the drain instead. The two must read the same window or the
  // operation the gate spares and the cleanup the record covers stop being the
  // same boundary.
  private idleReleaseLeftNoSession(): boolean {
    return (
      this.transitionInProgress?.kind === "releaseForIdle" ||
      SESSION_BOUNDARY_READINGS[this.sessionBoundary].releaseTookTheSession
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
  // names the partner-server drop, states the exhaustion in the unit the budget
  // spends -- sessions LOST, as the ledger's live tally rather than the configured
  // maximum, so this line and doCleanup's end-of-run summary read the same counter
  // and the terminal loss charged before the throw cannot put them off by one --
  // and gives the two remedies by their
  // operator-reachable names (the flag and the config field); it carries no
  // partner-controlled text. A budget of zero gets its own opening clause: there is
  // no allowance to describe as spent, so it names the first drop terminal instead.
  private midExchangeReconnectBudgetExhaustedError(): UsageError {
    const max = this.operativeMaxReconnectAttempts();
    const lost = this.ledger.midExchangeReconnectCount;
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

  // Surface a transparently-recovered mid-exchange session drop to the operator
  // at default verbosity; what is counted, charged and warned is in
  // docs/spec/CHANNEL_SECURITY.md, "What the accounting counts".
  //
  // Paced like every other repeating condition here (see the ledger's
  // pacedWarn), plus the LAST re-dial the budget permits: with a budget below
  // that cadence's interval (the default 3 is) the escalation step never fires,
  // and the operator would go from one early warning straight to the terminal
  // error. Each mode reads the re-dial its own way -- the two differ in likely
  // cause, remedy and bound, so one blended line would misdescribe both.
  private warnSessionRecovered(): void {
    const count = this.ledger.midExchangeReconnectCount;
    if (this.ephemeralSessions) {
      this.ledger.pacedWarn(
        count,
        () =>
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
          "making progress.",
      );
      return;
    }
    const budget = this.operativeMaxReconnectAttempts();
    const remaining = Math.max(budget - count, 0);
    this.ledger.pacedWarn(
      count,
      () => {
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
      },
      remaining === 0,
    );
  }

  // Decide whether an op rejection is the session loss recovery re-dials on --
  // every condition post-state, never error-message matching. The trigger, the
  // readings that stay terminal, and the live-session-over-an-ended-transport
  // case are in docs/spec/CHANNEL_SECURITY.md, "What is re-dialed, and what
  // stays terminal".
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

  // Re-dial the dropped session through the same locked dial sequence connect()
  // runs, never a bare client.connect(), and charge the lost generation here.
  // docs/spec/CHANNEL_SECURITY.md, "What is re-dialed, and what stays terminal"
  // and "What the accounting counts".
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
        // The session is gone or can carry nothing, so the generation that was
        // live has ended. Every DELIBERATE end -- an idle release, teardown's own
        // close, a fatal protocol error -- charges itself where it happens, so a
        // generation still live here was ended by the partner, save during a
        // teardown whose re-dial (the abort-marker write or the terminal-frame
        // drain) is teardown mechanics rather than a survived drop and is exempt
        // from the counters, the cap and the warning.
        const charged = this.chargeRecoveredSessionLoss();
        const dialed = await this.connectRecoveredSession(held, internals);
        // Reported to the operator only once the re-dial has actually landed, and
        // only by the arm that charged the loss: a fan of arms over one drop would
        // otherwise repeat one line per torn operation.
        if (dialed === "sessionLive" && charged) this.warnSessionRecovered();
        return dialed;
      },
    });
  }

  // Charge the generation this re-dial found ended, and spend the cumulative
  // mid-exchange budget for it. Both happen here, under the transition lock, so
  // the read and the charge cannot be separated by another arm's drop: the budget
  // bounds SESSIONS LOST, which is what the exhaustion message already tells the
  // operator, so a re-dial that then fails or is refused has still spent its unit.
  //
  // Reports whether THIS call recorded the loss. A sibling arm over the same drop,
  // or a release that already charged the boundary it took, gets `false` and so
  // neither warns nor re-reads the budget.
  private chargeRecoveredSessionLoss(): boolean {
    const cause: LossCause = this.tearingDown ? "teardown" : "partner";
    const budgetSpent =
      cause === "partner" &&
      !this.ephemeralSessions &&
      this.ledger.midExchangeReconnectCount >=
        this.operativeMaxReconnectAttempts();
    const charged = this.ledger.recordLoss(this.ledger.liveGeneration, cause);
    if (budgetSpent) throw this.midExchangeReconnectBudgetExhaustedError();
    return charged && cause === "partner";
  }

  // The dial half of the re-dial, once its loss has been charged: retire the
  // transport the dropped session ran on, then run the same locked dial sequence
  // connect() runs. A retirement that failed leaves nothing to dial over, which is
  // reported as itself rather than as a dial failure.
  private async connectRecoveredSession(
    held: HeldSessionTransition,
    internals: Ssh2SftpClientInternals,
  ): Promise<RecoveryRedialOutcome> {
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
    const retirement = await this.retireTransportForRedial(held, internals);
    if (retirement !== "retired") return retirement;
    await this.connectLocked(options, held);
    return "sessionLive";
  }

  // Retire the transport the dropped session ran on, so the re-dial meets
  // neither state ssh2-sftp-client's connect() cannot survive. Both states, the
  // shortcut's positive reading, and what each way it can fail warns are in
  // docs/spec/CHANNEL_SECURITY.md, "SFTP mid-exchange session recovery".
  private async retireTransportForRedial(
    held: HeldSessionTransition,
    internals: Ssh2SftpClientInternals,
  ): Promise<TransportRetirement> {
    const sessionHeld = Boolean(internals.sftp);
    // Only a cleared session consults the lifecycle reading: a session still set
    // is on its own enough to retire the transport, and the forced close reports
    // back whether the property cleared, which is the library clearing it from the
    // 'close' -- evidence the reading would otherwise have supplied.
    if (!sessionHeld) {
      const closeState = this.readTransportCloseState();
      if (closeState === "delivered") return "retired";
      if (closeState === "unreadable") this.warnUnreadableTransportLifecycle();
    }
    // Which failure this reports turns on which state brought it here, because the
    // two leave the caller different work: a session still held over an ended
    // transport cannot carry a re-issue at all, while a cleared one rejects it at
    // once with the real loss.
    const unretired = (): TransportRetirement =>
      sessionHeld ? "deadSessionHeld" : "unretiredTransport";
    const seams = resolveEndedTransportCloseSeams(internals);
    if ("missing" in seams) {
      this.log.warn(
        `The partner's SFTP server dropped the SFTP session mid-exchange, and ` +
          `re-dialing it means closing the connection beneath it from this ` +
          `side, which drives ssh2's ${seams.missing} -- not available after ` +
          `connect(), so the dropped session cannot be re-dialed and the ` +
          `operation fails. The installed ssh2 / ssh2-sftp-client version may ` +
          `have renamed, relocated, or removed it - re-verify the internal ` +
          `premises per the "Upgrading the SFTP Stack" checklist in ` +
          `docs/spec/DEPENDENCY_PINS.md`,
      );
      return unretired();
    }
    try {
      if (!(await this.forceCloseEndedTransport(held, internals, seams))) {
        this.log.warn(
          `The SFTP session did not clear within ${FORCED_CLOSE_TIMEOUT_MS} ms ` +
            `of this side closing the transport the partner's server left ` +
            `ended, so the mid-exchange re-dial cannot run and the operation ` +
            `fails; the installed ssh2 may no longer emit the client 'close' ` +
            `that clears it - re-verify the internal premises per the ` +
            `"Upgrading the SFTP Stack" checklist in ` +
            `docs/spec/DEPENDENCY_PINS.md`,
        );
        return "deadSessionHeld";
      }
    } catch (error: unknown) {
      this.log.warn(
        `Closing the SFTP connection from this side, to re-dial a session the ` +
          `partner's server dropped mid-exchange, failed: ` +
          `${sanitizeErrorForDisplay(error)}. The dropped session cannot be ` +
          `re-dialed, so the operation fails; the installed ssh2's transport ` +
          `may no longer accept the destroy that drives the client 'close' - ` +
          `re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
          `checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return unretired();
    }
    if (this.transportAwaitingClose) {
      this.log.warn(
        `The SFTP connection the partner's server dropped mid-exchange did ` +
          `not close within ${FORCED_CLOSE_TIMEOUT_MS} ms of this side ` +
          `closing it, so a re-dial would be issued while ssh2 still owes that ` +
          `connection its 'close' -- which fails the dial and leaves the ` +
          `session it opened abandoned. The re-dial is refused and the ` +
          `operation fails with the drop it already had; the installed ssh2 ` +
          `may no longer emit the client 'close' that retires a destroyed ` +
          `transport - re-verify the internal premises per the "Upgrading the ` +
          `SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md`,
      );
      return "unretiredTransport";
    }
    return "retired";
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
    requestedOptions: Record<string, unknown>,
    held: HeldSessionTransition,
  ): Promise<void> {
    this.assertTransitionHeld("ssh2-sftp-client's connect()", held);
    // Withhold the key-exchange algorithms this process cannot perform, at the
    // one point every dial passes through -- the first connect, core's host-key
    // probe, each recovery re-dial, and the connection-per-poll cycle-start
    // reconnect. Constraining here rather than in the public connect() is what
    // covers the last two, which enter with the retained options and never
    // through connect(); re-constraining options already constrained is a no-op
    // (see constrainKexToPlatformCapabilities). What holds the "every" is this
    // being the only path to ssh2's connect, rather than the list being
    // complete. On a host that can perform everything ssh2 offers, this returns
    // its argument unchanged and no dial is altered.
    const unavailablePrimitives = unavailableKexPrimitives();
    const options = constrainKexToPlatformCapabilities(
      requestedOptions,
      unavailablePrimitives,
      this.log,
    );
    // Read before the dial, because the dial is what makes it live: whether a
    // generation this dial ends was ended by the dial or was already gone when it
    // started is the difference between this side replacing a session and the
    // partner having taken one (see the charge below).
    const replacedLiveSession = this.hasLiveSession();
    this.originalConnectOptions = options;
    const maxReconnects = this.operativeMaxReconnectAttempts();
    // Exclude the psilink-specific key before handing options to ssh2.
    // FileTransportClient uses Record<string,unknown> so the interface stays
    // transport-agnostic; cast here is intentional.
    const { maxReconnectAttempts: _, ...rest } = options;
    const connectOptions = rest as Ssh2SftpClient.ConnectOptions;
    this.options = connectOptions;
    // Watch the transport lifecycle from the first dial on, so the reading a later
    // recovery re-dial takes covers every transport this adapter establishes.
    this.watchTransportLifecycle();
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
    try {
      await retryPromise(
        () => {
          if (connectAttempted) this.ledger.countConnectRetry();
          connectAttempted = true;
          return this.client.connect(connectOptions);
        },
        maxReconnects,
        1_000,
        (err) => {
          // The teardown latch, read BETWEEN attempts for the same reason
          // runTransition reads it before a transition's body: once end() has
          // latched, nothing may establish a session the teardown will not close.
          // It is what stops the abandoning teardown's forced destroy from being
          // undone by this loop -- the destroy cuts the attempt short with an
          // unexpected close, and a re-attempt mints a FRESH socket, keeping a
          // torn-down connection and a process that exits by drain alive for the
          // remainder of the dial budget (measured: a re-dial 1 s after the
          // destroy, on a socket reading writable again).
          if (this.closing) return false;
          // A key-exchange negotiation with nothing in common is terminal on a
          // process missing a primitive: the offer this side can make is fixed
          // for the life of the process -- the verdict is memoized because a
          // provider is not swapped under a running program -- so every
          // re-attempt puts the same withheld offer to the same server, a
          // second apart, for the whole reconnect budget. What classifies it is
          // that verdict rather than the message, which a server writes
          // verbatim through its own SSH_MSG_DISCONNECT description.
          if (isUnperformableKexNegotiationFailure(err, unavailablePrimitives))
            return false;
          // Host-key verification failure is terminal: the server is actively
          // presenting a different or unknown key, so retrying the key exchange
          // against the same server changes nothing. ssh2's "Host denied
          // (verification failed)" is wrapped by ssh2-sftp-client as a new Error
          // with the same message (prefixed with the listener context); match on
          // the stable message fragment from kex.js rather than a code that is not
          // set on the error object.
          return !(err instanceof Error && err.message.includes("Host denied"));
        },
      );
    } catch (err) {
      // A key-exchange negotiation that found nothing in common is re-raised
      // naming the platform capability that withheld the algorithms, so the
      // operator is not left reading ssh2's bare "no matching key exchange
      // algorithm" as a server misconfiguration. Outside the retry loop rather
      // than inside it, which is load-bearing for the classification above:
      // this REPLACES the message and keeps ssh2's own as the cause, so a
      // predicate running after it would read this diagnostic instead of the
      // fragment it matches. On a host that can perform everything ssh2 offers,
      // and for every other failure, the rejection passes through untouched.
      throw await this.diagnoseDialFailure(
        explainKexNegotiationFailure(err, unavailablePrimitives),
        connectOptions,
      );
    }

    // A dial reaching here with a generation still live ended that generation,
    // and the session reading taken before the dial is what says how. A session
    // that was LIVE was REPLACED by this dial -- a repeat connect() on an open
    // connection -- which is this side's own doing; a session already gone was
    // taken by the partner and absorbed by this dial without any operation or
    // release observing it, which a cycle-start re-dial does when a drop lands in
    // the tail of a poll cycle, and it is a lost session like any other. A dial
    // during teardown carries the teardown's own exemption instead. Charged before
    // the advance below, which is what lets that advance refuse a generation it
    // would otherwise overwrite silently; the recovery re-dial has already charged
    // its own loss in the same critical section, so nothing is recorded twice.
    const cause: LossCause = replacedLiveSession
      ? "deliberate"
      : this.tearingDown
        ? "teardown"
        : "partner";
    const absorbedAPartnerDrop =
      this.ledger.recordLoss(this.ledger.liveGeneration, cause) &&
      cause === "partner";
    // A different session is in place, whatever dialed it -- the first connect, a
    // cycle start, a recovery re-dial, a teardown's. Advanced where the session
    // becomes LIVE rather than at the end of the sequence below, unlike the
    // boundary discharge that runs last: a dial whose post-connect verification
    // then fails leaves a live session behind that operations are issued against
    // and a drop can take, and one whose loss carried the generation of the session
    // it replaced would go unreported.
    this.ledger.dialSucceeded();

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
      const seams = resolveTransportCloseSeams(internals);
      if ("missing" in seams) throw transportCloseSeamError(seams.missing);
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
    // ephemeral-session mode, where NO session is heartbeated. The poll loop's
    // ordinary cycle session lives only for its op batch (seconds) and is released
    // at the idle boundary, so there is none to keep warm; the two that DO span an
    // idle stretch are accepted un-heartbeated rather than fixed here -- the
    // rendezvous that precedes the loop, holding one across its waits, and a
    // boundary the release keeps because an operation is still outstanding (see
    // runTransition). A keepalive would buy either little: it defeats only an idle
    // timer and is powerless against the maximum-session-lifetime caps this mode
    // exists for, and it cannot be issued alongside the very operation a held
    // boundary is waiting on, ssh2-sftp-client permitting no second concurrent
    // operation (which is why the heartbeat suppresses a beat while one is in
    // flight). What carries either session across a cap-forced drop is the mode's
    // uncapped recovery re-dial (the uncapped-recovery unit case in
    // test/unit/ssh2SftpAdapter.test.ts, driven end to end in
    // test/integration/ephemeralSessionExchange.test.ts). It is not free: an
    // operation outstanding on the cut session fails and recovers through that
    // re-dial, which counts and warns the drop as the server-side loss it is.
    if (!this.ephemeralSessions) this.heartbeat.start();
    // Discharge the idle-boundary release (see the `sessionBoundary` field): LAST
    // and on success only, so a dial that threw above leaves the release standing
    // for the next op to re-establish on rather than reporting it as a drop.
    held.recordBoundary("notReleased");
    // A drop this dial absorbed with nothing else in the run having observed it --
    // the cycle-start re-dial meeting a session the partner took in the tail of
    // the previous cycle -- is reported here, where it was found. Reported after
    // the dial rather than at the charge, so the line describes a session this
    // side has in fact re-established.
    if (absorbedAPartnerDrop) this.warnSessionRecovered();
  }

  // What the dial sequence hands its caller when the dial failed: the rejection
  // it already had, or one re-raised with what a bounded, credential-free read
  // of the peer's first bytes says about it (see ./sftpPeerIdentification, which
  // owns the gate, the read and the copy). Why it is seated at this one layer,
  // and the constraints the read runs under, are in
  // docs/spec/CHANNEL_SECURITY.md, "SFTP host-key verification", under
  // "Diagnosing a peer that never identifies itself".
  private async diagnoseDialFailure(
    error: unknown,
    connectOptions: Ssh2SftpClient.ConnectOptions,
  ): Promise<unknown> {
    if (this.peerAnswerDiagnosisSpent) return error;
    if (this.closing || this.tearingDown) return error;
    if (this.isFatalDialError(error)) return error;
    if (!isPreIdentificationDialFailure(error)) return error;
    const endpoint = peerProbeTargetFromConnectOptions(connectOptions);
    if (endpoint === undefined) return error;
    this.peerAnswerDiagnosisSpent = true;
    // The per-attempt connect budget core sets from serverConnectTimeoutMs, which
    // the read is clamped to; a direct adapter caller that set none leaves the
    // read on its own default.
    const connectBudgetMs =
      typeof connectOptions.readyTimeout === "number"
        ? connectOptions.readyTimeout
        : undefined;
    return diagnosePeerAnswer(error, endpoint, connectBudgetMs);
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
   * Ends the connection for good (see {@link FileTransportClient.end}), at most
   * once per connection and under the session-transition queue like every other
   * transition. Its two bounds, the forced close behind them, and the degraded
   * branches are in docs/spec/CHANNEL_SECURITY.md, "The connection's terminal
   * close".
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
    // The connection's one terminal close: whatever it then manages to drive on
    // the transport, no session survives it, so the generation ends here. Charged
    // before the close rather than after, so a close that raises or has to be
    // forced does not leave the generation it ended unaccounted; charged as
    // teardown, which reaches neither the reconnect counters nor the cumulative
    // budget. A generation the partner had already taken has already been charged
    // as the loss it was, and this records nothing over it.
    this.ledger.recordLoss(this.ledger.liveGeneration, "teardown");
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
    const seam = resolveTerminalCloseSeam(internals);
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
    // This teardown never ran a body, so it is this destroy rather than
    // closeTerminally that ends whatever generation was live -- the same teardown
    // cause, charged where the close actually happens.
    this.ledger.recordLoss(this.ledger.liveGeneration, "teardown");
    // Nothing may keep pinging a transport this is about to destroy, and the
    // degraded branch below reports this teardown DONE over a transport it could
    // not close, so the stop precedes both -- as it does in closeTerminally. Local
    // timer state only, so unlike every other teardown action it drives nothing on
    // the client the transition ahead of this one still holds.
    this.heartbeat.stop();
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    const seam = resolveTerminalCloseSeam(internals);
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
   * session NON-TERMINALLY so the next cycle's {@link ensureConnected} re-dials.
   * Its bounds, the outstanding-operation hold that can defer it, and what each
   * outcome records are in docs/spec/CHANNEL_SECURITY.md, "The
   * outstanding-operation hold on an idle boundary".
   */
  releaseForIdle(): Promise<void> {
    if (!this.ephemeralSessions) return Promise.resolve();
    return this.runTransition({
      kind: "releaseForIdle",
      skipped: () => this.recordIdleBoundaryOutcome("skipped"),
      abandoned: () => this.recordIdleBoundaryOutcome("declined"),
      heldForOutstandingOperation: () => this.recordIdleBoundaryOutcome("held"),
      run: (held) => this.releaseSessionForIdle(held),
    });
  }

  // Record what one invocation of the idle release did, exactly once, at the point
  // its outcome is decided. It is the single recorder for the boundary: the session
  // reading the release leaves behind, the counter it moves, the loss it charges
  // and the line the operator gets are all read off this one value.
  //
  // The session reading is written twice over a boundary that ends one, and has to
  // be: the entry classification -- WHO ended the transport -- must stand before
  // the close is driven, because an operation already on the wire is torn by that
  // close and reads the boundary while this release is still running, whereas the
  // rest of the outcome is only known once the close has been waited out. Both
  // writes go through the same projection, and the pair agree wherever the entry
  // classification survives, so the second is a no-op except where the release
  // ended nothing after all.
  private recordIdleBoundaryOutcome(
    outcome: IdleBoundaryOutcome,
    held?: HeldSessionTransition,
  ): void {
    const generation = this.ledger.liveGeneration;
    this.recordIdleBoundarySessionReading(outcome, held);
    const count = this.ledger.countBoundary(outcome);
    if (!IDLE_BOUNDARY_ENDS_THE_GENERATION[outcome]) {
      this.warnIdleBoundaryClosedNothing(outcome, count);
      return;
    }
    // Read AFTER the reading above is in place, because the reading is what the
    // cause is: a release that was itself what ended the transport charges its own
    // deliberate boundary, while one that closed over a partner's drop -- a
    // consumed FIN, a half-ended transport, or a session already cleared -- charges
    // the partner, and it is the same answer the recovery chokepoint would have
    // reached for an operation that drop had torn.
    const deliberate =
      SESSION_BOUNDARY_READINGS[this.sessionBoundary].lossWasDeliberate;
    if (
      !this.ledger.recordLoss(generation, deliberate ? "deliberate" : "partner")
    )
      return;
    if (deliberate) return;
    // The partner ended this session and no operation was on the wire to be torn
    // by it, so nothing else in the run reports it: without this line an operator
    // whose server caps session lifetime sees a run of quiet cycles.
    this.warnPartnerDropAtIdleBoundary();
  }

  // The session reading an outcome leaves behind, where it leaves one. Outcomes
  // reported from outside the transition body leave the standing reading alone by
  // construction as well as by projection -- there is no held transition to record
  // through, and none of them closed anything.
  private recordIdleBoundarySessionReading(
    outcome: IdleBoundaryOutcome,
    held: HeldSessionTransition | undefined,
  ): void {
    const reading = idleBoundarySessionReading(outcome);
    if (reading === "unchanged" || held === undefined) return;
    held.recordBoundary(reading);
  }

  // The two boundary outcomes that closed nothing and are worth a line, each on
  // the shared warn cadence: whatever holds a transition long enough to decline a
  // release, or leaves an ssh2 end() that ends no transport, tends to do it every
  // cycle. The rest are silent -- a skipped boundary is teardown running, and a
  // held one is an operation straddling a boundary, which is ordinary rather than
  // anomalous and has only its run total to report.
  private warnIdleBoundaryClosedNothing(
    outcome: IdleBoundaryOutcome,
    count: number,
  ): void {
    if (outcome === "declined")
      this.ledger.pacedWarn(
        count,
        () =>
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
    if (outcome === "didNotClose")
      // Unpaced deliberately: this is the one degraded outcome with no run
      // total, so every occurrence is its own record.
      this.log.warn(
        "The connection-per-poll idle release did not close the SFTP session " +
          "and its transport is still writable, which the ssh2 client's end() " +
          "should have ended: the session may still be live and held across " +
          "this idle gap, which is the one thing this mode exists to prevent. " +
          "Check the ssh2 changelog.",
      );
  }

  // The partner's server ended a session at an idle boundary with nothing of this
  // side's on the wire, so no operation was torn and no recovery re-dial ran: the
  // next cycle simply dials again. Counted as the lost session it is, and reported
  // on the shared cadence because a server that caps session lifetime does this
  // every cycle. Deliberately not the recovery line's wording -- nothing was
  // transparently re-dialed here, and the remedy differs.
  private warnPartnerDropAtIdleBoundary(): void {
    const count = this.ledger.countPartnerDropAtBoundary();
    this.ledger.pacedWarn(
      count,
      () =>
        `The partner's SFTP server ended the SFTP session before this ` +
        `connection-per-poll idle boundary rather than in answer to it, with ` +
        `nothing of this side's on the wire, so no operation was interrupted ` +
        `and the next poll cycle dials a fresh session; the exchange continues ` +
        `(${count} idle ${count === 1 ? "boundary" : "boundaries"} met a ` +
        `session the partner had already ended so far this exchange). This is ` +
        `typically a server-enforced session-duration, idle or operation limit ` +
        `you cannot change, which connection-per-poll is the mode for: these ` +
        `sessions are not charged against max_reconnect_attempts.`,
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
    if (!internals.sftp) {
      // Nothing to release. Whether that is a boundary at all turns on the
      // generation: one still live is a partner-side drop this boundary is the
      // first thing to observe, while one already ended has had its loss charged
      // by whatever took it -- an earlier release, or the recovery arm of an
      // operation the same drop tore -- and this release has nothing to add.
      this.recordIdleBoundaryOutcome(
        this.ledger.liveGeneration === undefined ? "alreadyEnded" : "noSession",
        held,
      );
      return;
    }
    const seams = resolveTransportCloseSeams(internals);
    if ("missing" in seams) throw transportCloseSeamError(seams.missing);
    const { end, once, removeListener, socket } = seams;
    // WHO ended this transport is the entry classification, recorded BEFORE the
    // close is driven so an operation that close tears reads the boundary. How
    // the two half-close flags are read is in docs/spec/DEPENDENCY_PINS.md,
    // "Upgrading the SFTP Stack"; what each reading records, counts and warns
    // is in docs/spec/CHANNEL_SECURITY.md, "What the accounting counts".
    const entry: IdleBoundaryOutcome =
      socket.readableEnded === true
        ? "closedByPeer"
        : socket.writableEnded === true
          ? "releasedOverEndedTransport"
          : "released";
    this.recordIdleBoundarySessionReading(entry, held);
    await this.awaitClientClose(
      held,
      once,
      removeListener,
      CLIENT_CLOSE_TIMEOUT_MS,
      end,
      false,
    );
    // The session went with the close, so the entry classification is the whole
    // outcome: who ended the transport is what it records, and the socket's flags
    // past this close are the close's own and answer a different question.
    if (!internals.sftp) {
      this.recordIdleBoundaryOutcome(entry, held);
      return;
    }
    // ssh2-sftp-client's global 'close' listener has not run, so the backstop
    // settled that wait rather than the ssh2 Client's 'close'. Which state that is
    // turns on whether the transport was ended, so it is a branch on the socket
    // rather than a claim in a comment.
    if (socket.writableEnded === false) {
      // The transport this adapter's end() should have ended is still writable, so
      // this is the one branch where the session may genuinely be live and held
      // across the idle gap. The outcome takes the release's reading back: no
      // reading that a release took the session may stand over one that is still
      // live, and classifying a live session's next drop as this release's doing is
      // the misreport that rule exists to prevent.
      this.recordIdleBoundaryOutcome("didNotClose", held);
      return;
    }
    if (!(await this.forceCloseEndedTransport(held, internals, seams))) {
      // Raising takes the release's reading back with it (the session still reads
      // live, so runTransition drops the reading on the way out): a reading that a
      // release took the session may only stand where a session was in fact ended,
      // and this one did not end.
      this.recordIdleBoundaryOutcome("destroyDidNotClear", held);
      throw new Error(
        `the connection-per-poll idle release destroyed the SFTP session's ` +
          `transport and the session did not clear within ` +
          `${FORCED_CLOSE_TIMEOUT_MS} ms; the installed ssh2 may no ` +
          `longer emit the client 'close' that clears it - re-verify the ` +
          `internal premises per the "Upgrading the SFTP Stack" checklist in ` +
          `docs/spec/DEPENDENCY_PINS.md`,
      );
    }
    // The partner did not answer the close within the bound and this side
    // destroyed the transport. Its own outcome, and one that leaves the entry
    // classification's reading standing: the forcing says how the boundary
    // concluded, not who ended the transport beneath it.
    this.recordIdleBoundaryOutcome("forced", held);
    this.warnForcedRelease();
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

  // Report an idle boundary the connection-per-poll release closed itself. A
  // partner that never closes forces one every cycle, so the line takes the shared
  // warn cadence. Nothing leaks, and a loss suffered at one of these boundaries is
  // reported by its own line or by the path that recovered it rather than by this
  // one, so pacing it costs the operator nothing.
  private warnForcedRelease(): void {
    const count = this.ledger.forcedReleaseCount;
    this.ledger.pacedWarn(
      count,
      () =>
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
   * {@link releaseForIdle} released, reusing the retained connect options with
   * no re-prompt and no re-pinning, and drains the deferred cleanup deletes
   * behind it. What it resolves, rejects and warns is in
   * docs/spec/CHANNEL_SECURITY.md, "SFTP mid-exchange session recovery" and
   * "The deferred cleanup-delete record".
   */
  ensureConnected(): Promise<boolean> {
    if (!this.ephemeralSessions) return Promise.resolve(true);
    return this.reestablishSession().then(async (live) => {
      if (live)
        await this.drainDeferredCleanupDeletes().then(
          () => {},
          () => {},
        );
      return live;
    });
  }

  private reestablishSession(): Promise<boolean> {
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
  // Counted apart from the idle release's decline (warnIdleReleaseDeclined) though
  // core drives both signals once per poll cycle: one stuck transition declines
  // both, and a shared count would pace each line on the other's occurrences and
  // misstate both numbers.
  private warnCycleRedialDeclined(): void {
    const count = this.ledger.countDeclinedCycleRedial();
    this.ledger.pacedWarn(
      count,
      () =>
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
  // next tick. Two classes qualify, each permanent in its own way.
  //
  // A host-key verification failure means the server is presenting a different or
  // unknown key -- a trust-boundary fault (possible MITM) that must fail loudly
  // and fast, never be papered over as a transient network blip and ridden to a
  // generic peer-silence timeout. ssh2 surfaces it as "Host denied (verification
  // failed)", the same stable fragment connect()'s retry predicate treats as
  // terminal (re-verify on any ssh2 upgrade per docs/spec/DEPENDENCY_PINS.md).
  //
  // A key exchange this process cannot perform is permanent for the life of the
  // run: the capability verdict is memoized because a crypto provider is not
  // swapped under a running program, so every tick puts the same withheld offer
  // to the same server until the peer-inactivity ceiling ends the run with a
  // generic peer-silence error, in place of the diagnostic the first cycle
  // already had. The classifier is the connect loop's own, read over the same
  // verdict, so the two dial paths cannot disagree about one rejection -- and it
  // is that verdict, this process's reading of its own crypto provider taken
  // before the dial, that conditions this, never a message a server or an
  // on-path attacker can write (see sftpKexCapability).
  //
  // Bad credentials are caught at the initial connect() before any cycle; a
  // mid-exchange credential rotation is transient here and bounded by the
  // peer-inactivity ceiling.
  private isFatalDialError(error: unknown): boolean {
    if (error instanceof Error && error.message.includes("Host denied"))
      return true;
    return isUnperformableKexNegotiationFailure(
      error,
      unavailableKexPrimitives(),
    );
  }

  /**
   * Lists a remote directory under the directory-listing bounds (see
   * {@link ./listingGuard}), enforced at the transport read layer rather than by
   * delegating to ssh2-sftp-client's `list()`. The bounds, why the read is
   * batched, and the liveness caps over it are in
   * docs/spec/CHANNEL_SECURITY.md, "Directory-listing bound" and
   * "Per-operation liveness bounds".
   */
  list(path: string): Promise<FileInfo[]> {
    return this.runOperation({ recovery: "verbatim" }, () =>
      this.listOnce(path),
    );
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
    return this.runOperation({ recovery: "verbatim" }, () =>
      this.getOnce(path, options),
    );
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
    if (!reRunnable)
      return this.runOperation({ recovery: "none" }, () =>
        this.putOnce(src, dest, options),
      );
    return this.runOperation({ recovery: "verbatim" }, () =>
      this.putOnce(src, dest, options),
    );
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
    return this.runOperation(
      {
        recovery: "reissued",
        // A pre-drop delete that actually landed leaves the source absent, so
        // ssh2-sftp-client reports SSH_FX_NO_SUCH_FILE. Map that to success --
        // propagating it would stop poll()'s consume-delete poller on a delete
        // that in fact succeeded. Never applied on the first attempt, where a
        // genuine absence must still surface.
        reissue: (run) =>
          run().catch((error: unknown) => {
            if (this.isNoSuchFileError(error)) return;
            throw error;
          }),
      },
      () => this.deleteOnce(path),
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
    // that RESOLVES rather than rejecting like the other guarded methods. The
    // entry guard, the deadline that bounds a withheld callback beneath it, and
    // what the rejection arm offers to the record are in
    // docs/spec/CHANNEL_SECURITY.md, "SFTP fatal-packet crash safety" and "The
    // deferred cleanup-delete record".
    if (this.fatalSftpError !== undefined) return Promise.resolve();
    // Taken BEFORE the delete is issued, because what it reads is a boundary the
    // delete itself does not move: the release that took the session away is
    // already behind this call.
    if (this.idleReleaseLeftNoSession()) this.deferCleanupDelete(path);
    return this.runOperation({ recovery: "none" }, () =>
      this.tracked(
        this.boundByDeadline(
          this.client.delete(path, true).then(() => {}),
          "file delete",
          path,
          "delete",
        ).then(
          () => {},
          () => {
            this.deferCleanupDelete(path);
          },
        ),
      ),
    );
  }

  // Record a cleanup delete that was not performed, so the next point at which a
  // session exists re-issues it. Connection-per-poll only. What is admitted to
  // the record, why that narrowing makes deferral sound, and the cap and budget
  // over it are in docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete
  // record".
  private deferCleanupDelete(
    path: string,
    reissuesLeft = MAX_DEFERRED_CLEANUP_REISSUES,
  ): void {
    if (!this.ephemeralSessions) return;
    if (!isProtocolTempName(remoteBasename(path))) return;
    if (reissuesLeft <= 0) {
      this.log.debug(
        `a cleanup delete was re-issued ${MAX_DEFERRED_CLEANUP_REISSUES} ` +
          `times on this SFTP connection without succeeding, so it is not ` +
          `recorded again and its file is left behind: ` +
          redactAndSanitizeForDisplay(path),
      );
      return;
    }
    // An entry already standing keeps the budget it holds: a decrement arriving
    // from a re-issue whose path was re-recorded while it was in flight is
    // discarded rather than applied to that newer recording.
    if (this.deferredCleanupDeletes.has(path)) return;
    if (this.deferredCleanupDeletes.size >= MAX_DEFERRED_CLEANUP_DELETES) {
      this.log.debug(
        `${MAX_DEFERRED_CLEANUP_DELETES} cleanup deletes are already recorded ` +
          `for re-issue on this SFTP connection, so this one is not recorded ` +
          `and its file is left behind: ${redactAndSanitizeForDisplay(path)}`,
      );
      return;
    }
    this.deferredCleanupDeletes.set(path, reissuesLeft);
  }

  // Re-issue every recorded cleanup delete, at a point where a session exists.
  // Hooked at the tail of ensureConnected(), OUTSIDE the transition. The seams
  // it covers, the states that drain nothing, and the bound over the concurrent
  // re-issues are in docs/spec/CHANNEL_SECURITY.md, "The deferred
  // cleanup-delete record".
  private drainDeferredCleanupDeletes(): Promise<void> {
    if (this.deferredCleanupDeletes.size === 0) return Promise.resolve();
    if (this.fatalSftpError !== undefined) return Promise.resolve();
    if (this.closing) return Promise.resolve();
    if (!this.hasLiveSession()) return Promise.resolve();
    // A drain already running holds the snapshot it took; a record made after
    // that snapshot is left for the next re-establishment rather than issued
    // alongside it, so no path is deleted twice concurrently and this cannot
    // re-enter itself.
    this.deferredCleanupDrain ??= this.runDeferredCleanupDrain().finally(() => {
      this.deferredCleanupDrain = undefined;
    });
    return this.deferredCleanupDrain;
  }

  private runDeferredCleanupDrain(): Promise<void> {
    const recorded = [...this.deferredCleanupDeletes];
    this.deferredCleanupDeletes.clear();
    return Promise.all(
      recorded.map(([path, reissuesLeft]) =>
        this.reissueCleanupDelete(path, reissuesLeft),
      ),
    ).then(() => {});
  }

  // One re-issued cleanup delete, on the same never-reject terms as safeDelete's
  // own, and resolving whatever happens. Why it is issued OUTSIDE the tracked()
  // bracket, and why a release may tear it, are in
  // docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record". The
  // allowance is registered, with that reason, in
  // scripts/sftp-tracked-round-trips.test.mjs.
  private reissueCleanupDelete(
    path: string,
    reissuesLeft: number,
  ): Promise<void> {
    return withSftpOperationDeadline(
      this.client.delete(path, true).then(() => {}),
      DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS,
      () =>
        transportOperationStalledError(
          "file delete",
          path,
          `did not complete within ${DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS} ms ` +
            "(the server withheld the delete response)",
        ),
    ).then(
      () => {},
      () => {
        this.deferCleanupDelete(path, reissuesLeft - 1);
      },
    );
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    return this.runOperation(
      {
        recovery: "reissued",
        // If the pre-drop rename landed, the re-issue sees the source gone
        // (SSH_FX_NO_SUCH_FILE) or a code-4 dest-exists. Confirm via an
        // existence check on the destination -- every rename destination in this
        // app is self-prefixed (<id>-hello.json, the <id>-...json message
        // temp->final, <myId>-<orig>-ack.json, <id>-abort.json, the joiner
        // <id>-joining.json -> <id>-hello.json), so a present destination is
        // unambiguously our own landed attempt, never a peer file -- and resolve
        // as success.
        //
        // The CONVERSE does not hold, and the arm below is what that costs. An
        // absent destination is not evidence the rename failed: in delete mode
        // the peer's consume-delete removes exactly this party's own
        // self-prefixed publish, so a rename that landed durably and was then
        // consumed inside the recovery window reports the identical state a
        // rename that never landed does -- source gone, destination absent,
        // SSH_FX_NO_SUCH_FILE. Nothing the adapter can read separates them (see
        // CHANNEL_SECURITY.md), so that state is surfaced as the indeterminate
        // outcome it is rather than as a determined non-delivery. Every OTHER
        // failure keeps propagating verbatim.
        reissue: (run) =>
          run().catch(async (error: unknown) => {
            const code = (error as Ssh2SftpError | null | undefined)?.code;
            const sourceGone = this.isNoSuchFileError(error);
            if (!sourceGone && code !== SSH_FX_FAILURE) throw error;
            // The probe is a server round trip like any other, so it goes
            // through the private once-layer: that is the seam carrying the
            // per-operation deadline and the dead-session guard, and it runs
            // inside this operation's own outstanding span, so an idle-boundary
            // release cannot tear it (a torn probe reports a LANDED rename as
            // the failure that drove it). The public exists() is the wrong seam
            // here: it would arm a second recovery round from inside this one's
            // catch. However the probe rejects -- dead session, expired
            // deadline, or a real I/O error -- it has confirmed nothing, which
            // is a different answer from a destination the server reported
            // absent (mirrors createExclusiveOnce's SFTPv3 fallback, which keeps
            // the original openErr when its exists() check rejects).
            const destination = await this.existsOnce(toPath).then(
              (present) => (present ? "present" : "absent"),
              () => "unanswered",
            );
            if (destination === "present") return;
            // A code-4 failure is the server's own answer that the rename did
            // not take effect, so it stays determinate and surfaces as itself;
            // only the source-gone code can be the landed-then-consumed state.
            if (!sourceGone) throw error;
            if (destination === "absent") {
              // The one reading that settles it the other way: a source still on
              // the server means nothing moved this party's file, so the publish
              // determinately did not land. Worth the second round trip only
              // where the first was answered -- a probe that could not answer
              // has already left the question open, and a second on the same
              // session would spend another deadline to leave it open again.
              const sourceHeld = await this.existsOnce(fromPath).catch(
                () => false,
              );
              if (sourceHeld) throw error;
            }
            throw this.indeterminatePublishError(error, toPath);
          }),
      },
      () => this.renameOnce(fromPath, toPath),
    );
  }

  // The rejection for a publish whose fate the transport cannot settle: a
  // mid-operation drop tore the rename, and what the recovery could read of the
  // aftermath is the state a landed-then-consumed publish and an unlanded one
  // share. It stays a rejection -- nothing here reports an unpublished write as
  // sent.
  //
  // Names the publish rather than a message, and prescribes no next step:
  // rename() is shared machinery, and the four publishes reaching it -- the
  // message loop's send(), its ack, the rendezvous joining->hello rename, and the
  // abort marker -- share no remedy, so this carries no recovery-hint tag either.
  // The one caller whose remedy is established re-raises this as its own tagged
  // error holding this one as the `cause` (FileSyncMessageLoop's send()).
  //
  // Written to survive the display boundary, which caps each error in a rendered
  // cause chain at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH: the sentence the operator
  // must act on leads, and the destination -- named because what this party
  // published may now be in the peer's hands under it -- comes last, where the
  // cap costs least.
  // The re-issue's own error is carried only as the `cause`, so the SFTP status
  // it names is rendered on its own line under its own cap rather than spending
  // this message's. `toPath` is partner-derived on the ack and rendezvous rename
  // paths, so it is escaped like every other path this app puts in an error.
  private indeterminatePublishError(
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
    return this.runOperation(
      {
        recovery: "reissued",
        // If this party's pre-drop create actually landed, the re-issue sees its
        // OWN lock file and reports EEXIST -- reusing the existing code-11 /
        // code-4-via-exists() normalization in createExclusiveOnce, which sets
        // code "EEXIST" -- so resolve as success rather than a spurious lock
        // conflict.
        //
        // Edge case (verified plausibly benign, do NOT re-architect the
        // rendezvous): in the narrow race where this party's create dropped AT
        // ENTRY and the peer legitimately won the shared-named lock in the
        // meantime, the re-issue EEXIST is the PEER's, yielding a transient "two
        // winners" state. It is benign because roles are committed from
        // hello-filename order BEFORE the lock is taken, the lock only gates
        // eager coordination-file cleanup, leftover hellos are excluded from
        // message polling, and leftover files are swept at close; and it is
        // confined to the brief rendezvous phase, not the ~10-min mid-exchange
        // drop this recovery targets. Resolving own-EEXIST-as-success is the
        // implementation; the security review verifies the race rigorously.
        reissue: (run) =>
          run().catch((error: unknown) => {
            if (
              (error as NodeJS.ErrnoException | null | undefined)?.code ===
              "EEXIST"
            )
              return;
            throw error;
          }),
      },
      () => this.createExclusiveOnce(path),
    );
  }

  private createExclusiveOnce(path: string): Promise<void> {
    // ssh2-sftp-client does not expose exclusive file creation; access the
    // underlying SFTP session (via the Ssh2SftpClientInternals interface) to
    // open with SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL
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
    return this.runOperation({ recovery: "verbatim" }, () =>
      this.existsOnce(remotePath),
    );
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
