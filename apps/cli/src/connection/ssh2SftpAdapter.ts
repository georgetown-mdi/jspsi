// This adapter drives ssh2's raw SFTPWrapper internals past the public
// ssh2-sftp-client API, so ssh2 and ssh2-sftp-client are exact-pinned in
// package.json. On any upgrade of either, re-verify the internal assumptions
// per the "Upgrading the SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md
// before it merges -- a "compatible" bump can silently break an assumption no
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
  getLogger,
  getLoggerForVerbosity,
  retryPromise,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { createCappedSink } from "./frameSizeGuard";
import { REPORT_LIBRARY_INCOMPATIBILITY } from "./libraryIncompatibility";
import { SftpAdapterLedger } from "./sftpAdapterLedger";
import { SftpSessionState } from "./sftpSessionState";
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
  SSH_WIRE_TRACE_LOGGER_NAME,
  sshWireTraceCallback,
} from "./sftpWireTrace";
import {
  SubsystemOpenTimeoutError,
  subsystemOpenTimeoutMs,
  watchSubsystemOpen,
} from "./sftpSubsystemOpen";
import {
  resolveEndedTransportCloseSeams,
  resolveForcedCloseSeams,
  resolveTerminalCloseSeam,
  resolveTransportCloseSeams,
  transportCloseSeamError,
} from "./sftpClientInternals";
import type {
  ForcedCloseSeams,
  Ssh2SftpClientInternals,
  Ssh2SftpError,
} from "./sftpClientInternals";
import {
  MAX_DEFERRED_CLEANUP_DELETES,
  DeferredCleanupDeletes,
} from "./sftpDeferredCleanup";
import {
  IDLE_BOUNDARY_ENDS_THE_GENERATION,
  SESSION_BOUNDARY_READINGS,
  idleBoundarySessionReading,
} from "./sftpIdleBoundary";
import type { SessionBoundary } from "./sftpIdleBoundary";
import {
  SFTP_SESSION_CLOSED_MESSAGE,
  cycleRedialDeclinedWarning,
  deadSessionOperationError,
  forcedIdleReleaseWarning,
  idleReleaseDeclinedWarning,
  idleReleaseDidNotCloseWarning,
  indeterminatePublishError,
  midExchangeReconnectBudgetExhaustedError,
  partnerDropAtIdleBoundaryWarning,
  remainingMidExchangeRedials,
  sessionRecoveredEphemeralWarning,
  sessionRecoveredHeldWarning,
  transitionWaitExpiredError,
  unboundedSubsystemOpenWarning,
  unreadableTransportLifecycleWarning,
} from "./sftpAdapterWarnings";

// The SSH stack's diagnostics reach the operator under a logger of their own,
// at the level `--log-level` applies: `getLoggerForVerbosity` floors a logger
// to the quieter of that level and the `-v` count, which would put this trace
// behind both flags.
const sshWireTraceLog = getLogger(SSH_WIRE_TRACE_LOGGER_NAME);

// SSH_FX_FAILURE: the generic SFTPv3 status (4) a server returns when an
// operation did not take effect for a reason it does not further classify. The
// numeric value reaches us because ssh2-sftp-client passes ssh2's raw status
// through fmtError onto err.code (the same assumption createExclusive's code-4
// handling relies on).
const SSH_FX_FAILURE = 4;

// Upper bound (ms) on how long a close of this adapter's SFTP connection waits
// for the partner server before ending the wait itself: the connection-per-poll
// release's wait for the ssh2 Client's 'close' after driving its end() ({@link
// SSH2SFTPClientAdapter.releaseForIdle}), and the terminal close's wait for
// ssh2-sftp-client's own end() ({@link SSH2SFTPClientAdapter.end}). Not
// operator-configurable: a liveness safety check, not a tunable.
const CLIENT_CLOSE_TIMEOUT_MS = 5_000;

// Upper bound (ms) on how long either forced close (see
// {@link SSH2SFTPClientAdapter.forceCloseEndedTransport} and
// {@link SSH2SFTPClientAdapter.forceCloseTerminalTransport}) waits out teardown
// after destroying the socket beneath the ssh2 Client. The one bound armed on a
// REF'D timer (see awaitBoundedTeardown), because the destroyed socket it waits
// on leaves no ref'd handle of its own. Not operator-configurable, like every
// other SFTP liveness bound.
const FORCED_CLOSE_TIMEOUT_MS = 1_000;

// Upper bound (ms) on a queued session transition's wait for the transition
// ahead of it. Derivation: docs/spec/CHANNEL_SECURITY.md, "The
// session-transition lock".
const TRANSITION_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * Deletes core's rendezvous entry sweep can put on the shared ssh2 `Client` in
 * one fan, counted into {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}. Twice
 * {@link MAX_DIRECTORY_ENTRIES}: the sweep merges the inbound and outbound
 * listings' leftovers into one fan, and the same term also covers the entry
 * scan's three narrower delete fans ahead of it, none of which stacks on
 * another or on the sweep's own.
 */
const MAX_SPLIT_SCOPE_ENTRY_SWEEP_DELETES = 2 * MAX_DIRECTORY_ENTRIES;

/**
 * Listeners the shared ssh2 `Client` can hold on one event name for work
 * running BESIDE the widest fan, counted into
 * {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}. MEASURED rather than summed;
 * the runs behind it are in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP
 * Stack".
 *
 * @internal exported for the adapter's own tests
 */
export const CONCURRENT_OPERATIONS_BESIDE_A_FAN = 3;

/**
 * Listeners the shared ssh2 `Client` holds on its busiest event name with
 * nothing in flight, counted into
 * {@link SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS}: ssh2-sftp-client's
 * constructor `globalListener` (one each on `'error'`, `'end'` and `'close'`)
 * plus this adapter's persistent transport-lifecycle watch (one each on
 * `'end'` and `'close'`; see
 * {@link SSH2SFTPClientAdapter.watchTransportLifecycle}).
 */
const PERSISTENT_SHARED_CLIENT_LISTENERS_PER_EVENT = 2;

/**
 * Listeners the shared ssh2 `Client` can hold at once on one event name, with
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

// How a bounded teardown wait ended (see
// SSH2SFTPClientAdapter.awaitBoundedTeardown). `settled` is the only one meaning
// the close completed: `failed` is a close that raised having closed nothing, and
// `expired` a close still outstanding at the bound.
type BoundedTeardownOutcome =
  | { status: "settled" }
  | { status: "failed"; error: unknown }
  | { status: "expired" };

// What one mid-exchange recovery re-dial leaves its caller to do with the
// operation it was recovering (see SSH2SFTPClientAdapter.redialForRecovery).
// `sessionLive` is the only state with a session to re-issue onto and the only
// one that counts as a survived drop. The rest dialed nothing: `noSession` is a
// session already cleared, `deadSessionHeld` one that still reads live on an
// ended transport, and `unretiredTransport` a cleared session whose transport
// still owes the ssh2 Client a lifecycle event -- the one window this adapter
// must never dial into (see SSH2SFTPClientAdapter.retireTransportForRedial).
type RecoveryRedialOutcome =
  "sessionLive" | "noSession" | "deadSessionHeld" | "unretiredTransport";

// Whether the transport the last dial established can be left behind for the
// recovery re-dial to dial over. `retired` is the only state a dial may follow;
// the other two are the two ways retiring it failed, each mapping onto the
// re-dial outcome of the same name.
type TransportRetirement = "retired" | "deadSessionHeld" | "unretiredTransport";

// Every point at which this adapter dials a session or closes one. All five run
// under the adapter's one transition lock (see
// SSH2SFTPClientAdapter.runTransition), so none can overlap another on the one
// shared Ssh2SftpClient.
export type SessionTransitionKind =
  | "connect"
  | "ensureConnected"
  | "redialForRecovery"
  | "releaseForIdle"
  | "teardown";

// What one data-plane operation's SECOND attempt is, where it has one (see
// SSH2SFTPClientAdapter.runOperation). `verbatim` re-runs the operation as it
// stands; `reissued` applies the per-operation idempotency relaxation on that
// attempt only, so a delete-absent, rename-destination-exists or own-EEXIST
// reading cannot leak into first-attempt semantics; `none` is an operation
// that never enters recovery at all.
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
// transition's body: the boundary recorder, and the identity every dial and
// every close inside the body presents at the chokepoint
// (SSH2SFTPClientAdapter.assertTransitionHeld). Identity rather than a
// boolean, because a teardown that gave up its wait can drive its forced close
// while another transition holds the client.
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
// dispositions above: the value each kind reports is stated where the
// disposition record says it is needed and nowhere else, except idle release,
// split out because it alone has a data-plane precondition and so a fourth
// thing it can report. Teardown has no `skipped`: it is the transition the
// teardown latch is set FOR, so every other kind states what it returns when it
// reaches the front of the queue with that latch already set.
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
      // operation is still outstanding on the session. Kept apart from `skipped`
      // (a connection closing on purpose) and `abandoned` (a transition that
      // never got its turn): this one is a session kept up for the operation on
      // it, released at the first boundary past that operation's settlement.
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
  // The connection-lifecycle state this adapter carries across its whole life:
  // how far the teardown has got, what the transport has reported about closing,
  // and the one-shot budgets. Its own module, on the ledger's terms:
  // {@link ./sftpSessionState}.
  private readonly session = new SftpSessionState();
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
  // Whether this adapter has already told the operator it cannot bound a dial's
  // post-authentication phase. The condition is the installed SFTP library's, so
  // one report per adapter says everything a second would.
  private warnedUnboundedSubsystemOpen = false;
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
  // runTransition. Read at two sites: withSessionRecovery's gate, which
  // re-establishes before the first attempt of an operation a release left no
  // session for, and the boundary's own outcome recording, which reads the
  // classification back to decide whether a loss counts against the partner or
  // this side. Discharged by the dial that re-establishes the session, so a
  // failed dial leaves it standing. Outside the release's own close window, no
  // release reading stands where a session is live.
  private sessionBoundary: SessionBoundary = "notReleased";
  private log: ReturnType<typeof getLoggerForVerbosity>;
  // Where the SSH stack's own diagnostics go, or undefined when the operator's
  // log level is not trace (see ./sftpWireTrace). Resolved in the constructor
  // rather than per dial: an application applies the operator's level before it
  // builds a connection, so the level a dial would read is the one already read
  // here.
  private readonly wireTrace: ((line: string) => void) | undefined;
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
  // This adapter's session generations, operator-facing counters and the cadence
  // its repeating warnings share (see ./sftpAdapterLedger). The warn sink is a closure rather
  // than the logger itself so the ledger stays free of the log's type and reads
  // the adapter's log at the moment a line is due.
  private readonly ledger = new SftpAdapterLedger({
    warn: (message: string) => this.log.warn(message),
  });
  // The per-operation liveness bound (ms) every server-driven op is held to. See
  // the constructor's stallDeadlineMs doc for the test-override and
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
  // The cleanup deletes this adapter could not perform, kept for re-issue at the
  // next point a session exists. Its own module: {@link ./sftpDeferredCleanup}.
  private readonly deferredCleanupDeletes: DeferredCleanupDeletes;

  /**
   * `options.verbosity` sets the adapter's log verbosity (default 1).
   *
   * `options.stallDeadlineMs` is an @internal test-only override for the
   * per-operation liveness deadline; production constructs the adapter with no
   * argument (an empty options object) and gets {@link SFTP_STALL_DEADLINE_MS}.
   * A named options field, not a positional argument, so a future production
   * constructor parameter can never be passed as the deadline by accident. Not
   * exposed via config, so the bound cannot be widened by an operator.
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
    this.wireTrace = sshWireTraceCallback(sshWireTraceLog);
    // ssh2-sftp-client's bare constructor installs default callbacks that
    // console.error/console.log the underlying ssh2 Client's error/end/close
    // events whenever they fire outside a high-level operation it initiated.
    // Route the three to this adapter's logger instead; this redirects only
    // where the diagnostic goes; the handled-flag bookkeeping and this.sftp
    // cleanup run inside globalListener regardless. The error message is
    // server-controlled, so it is rendered through sanitizeErrorForDisplay
    // before logging. end/close are benign out-of-band lifecycle signals, so
    // they go to trace.
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
    this.deferredCleanupDeletes = new DeferredCleanupDeletes({
      enabled: this.ephemeralSessions,
      log: { debug: (message: string) => this.log.debug(message) },
      issueDelete: (path) => this.reissueCleanupDelete(path),
      canDrain: () => this.canDrainDeferredCleanup(),
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
   * the partner rather than connect-time dialing retries, reported apart from
   * the merged total so the end-of-run summary can distinguish chronic
   * mid-exchange drops from benign startup retries. One per session LOST, not
   * per operation the loss tore or per re-dial that recovered it. In
   * connection-per-poll mode it also counts a drop the idle boundary absorbed
   * with the wire empty. A plain operational counter, never a partner-controlled
   * value.
   */
  get midExchangeReconnectCount(): number {
    return this.ledger.midExchangeReconnectCount;
  }

  /**
   * The other subset of {@link reconnectCount}: dialing re-attempts past a
   * connect's first, wherever that connect ran -- opening the exchange, or
   * recovering a session the partner took away. A dial that never established
   * anything is counted here, so a run that failed to connect at all reports
   * its retries as retries rather than as re-establishments it never made. A
   * plain operational counter, never a partner-controlled value.
   */
  get connectRetryCount(): number {
    return this.ledger.connectRetryCount;
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
   * {@link releasedBoundaryCount}, the same boundary reached two ways. Says
   * nothing about whether a session was ALSO lost at that boundary -- that loss
   * is counted in {@link reconnectCount} like any other. 0 in every other mode
   * and against a server that closes on request. A plain operational counter,
   * never a partner-controlled value.
   */
  get forcedReleaseCount(): number {
    return this.ledger.forcedReleaseCount;
  }

  /**
   * Idle boundaries at which the connection-per-poll release ended the session,
   * every way it ends one: the partner's server answered the close within the
   * bound, or it did not and this side forced the transport closed.
   * {@link forcedReleaseCount} is a subset of this. Not itself a reconnection:
   * whether a session was also LOST at one of these boundaries is what
   * {@link reconnectCount} answers. 0 in every other mode. A plain operational
   * counter, never a partner-controlled value.
   */
  get releasedBoundaryCount(): number {
    return this.ledger.releasedBoundaryCount;
  }

  /**
   * Idle boundaries at which the connection-per-poll release closed NOTHING,
   * having given up its bounded wait for the session transition ahead of it (see
   * {@link releaseForIdle}). The session may still be live and held across the
   * idle gap the mode exists to release. NOT a reconnection and not a lost
   * session: nothing was closed, so it is absent from {@link reconnectCount}
   * too. 0 in every other mode and whenever no transition ran long enough to be
   * given up on. A plain operational counter, never a partner-controlled value.
   */
  get declinedReleaseCount(): number {
    return this.ledger.declinedReleaseCount;
  }

  /**
   * Poll cycles the connection-per-poll cycle-START re-dial skipped, having
   * given up its bounded wait for the session transition ahead of it (see
   * {@link ensureConnected}). The cycle had no session and the poll loop
   * skipped it, so it is the dialing half of what {@link declinedReleaseCount}
   * reports for the releasing half. NOT a reconnection and not a lost session:
   * nothing was dialed and nothing was closed. 0 in every other mode. A plain
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
   * stretch opens at a held boundary with none open and closes when the
   * adapter's outstanding-operation count next empties. It measures unbroken
   * hold rather than operations -- overlapping operations that never let the
   * outstanding count empty read as ONE stretch. Never exceeds
   * {@link heldBoundaryCount}, and 0 wherever that is. A plain operational
   * counter, never a partner-controlled value.
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
      if (transition.kind !== "teardown" && this.session.isClosing)
        return transition.skipped();
      // The idle release is the one transition with a data-plane precondition: an
      // operation already on the wire when the boundary falls would be torn by
      // the close, so the release keeps the session up and the first boundary
      // past that operation's SETTLEMENT ends it. Read here, with the queue held
      // and nothing yet driven, so an operation issued while this release was
      // still QUEUED behind another transition is covered too. No other kind may
      // hold for an operation.
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
        // No transition leaves a "release took the session" reading standing over
        // a live session: that reading would exempt the next drop from the
        // reconnect counters and the operator warning even though the server can
        // still drop this session. Corrected here rather than at each route that
        // could leave it stale.
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
    // required rather than an optimization (see the `pendingTransitions`
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
  // reporting whether the wait was won. The bound's timer is left REF'D, since
  // its abandon can close a transport nothing else will; a unit case pins that
  // so the ref cannot be dropped silently, and a second pins that the timer is
  // cleared where the race settles.
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
        throw transitionWaitExpiredError(
          transition.kind,
          TRANSITION_ACQUIRE_TIMEOUT_MS,
        );
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

  // The nothing-happened value returned by a kind whose disposition returns one.
  // The disposition record and the transition union have to agree about which
  // kinds have it; disagreement is a mistake in this file rather than a runtime
  // state, so it is checked here instead of asserted in the record's comment.
  private abandonedTransitionValue<T>(transition: SessionTransition<T>): T {
    if (!("abandoned" in transition))
      throw new Error(
        `the ${transition.kind} session transition's stated abandon disposition ` +
          `returns its own value, but the transition has none`,
      );
    return transition.abandoned();
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
  // holds the client is the abandoned teardown's forced close, which has its
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
  // that gave up its wait drives the forced transport close while the transition
  // it was waiting for still holds the client, by design: that destroy needs
  // nothing from the peer and settles the very dial being waited on. What makes
  // it safe is the teardown latch, not the destroy's own harmlessness: end()
  // latches before it enqueues, so every transition BEHIND this teardown skips
  // its body. That assumption is the check.
  private assertAbandonedTeardownMayForceClose(): void {
    if (this.session.isClosing) return;
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
   * Reports how often an operation was re-issued over the run for the metrics
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
  // heartbeat swallows the outcome, so this bound never reaches the exchange.
  // Not routed through tracked(): the heartbeat owns its own in-flight state
  // (`pinging`) and only ever pings when no tracked op is running.
  private sendKeepalive(): Promise<void> {
    // Don't issue a keepalive on a session already known dead, mirroring the entry
    // guard every other server-driven op has. The fatal-'error' path also stops the
    // heartbeat, so a beat should never reach here after a fatal error; this keeps
    // the invariant uniform rather than posting realPath onto a destroyed channel.
    // The heartbeat swallows the rejection, so it never reaches the exchange.
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
  // attempt, the re-dial that may follow it, and the re-issue. The
  // idle-boundary release's precondition is that count (see
  // docs/spec/CHANNEL_SECURITY.md, "The outstanding-operation hold on an idle
  // boundary").
  //
  // `spec` is the operation's re-issue policy, applied ONLY on the second
  // attempt: `verbatim` re-runs the operation as it stands, `reissued` applies
  // the per-operation idempotency relaxation it has, and `none` is an operation
  // that never enters recovery at all -- the never-reject cleanup delete, and a
  // put whose source cannot be re-issued. All are counted outstanding from the
  // moment they are ISSUED.
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
  // op; this only reports "still working" to a watching operator, with cheap
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
  // wall-clock deadline, raising the typed terminal TransportOperationStalledError
  // when the server withholds its callback past the bound. `response` names what
  // the server failed to send (e.g. "rename", "delete", "stat"), filled into the
  // standard "withheld the <response> response" detail. The metadata write/stat/
  // delete ops and createExclusive all bound a single round-trip this way; put()
  // instead uses the progress-based idle window (createBoundedPutSource), because
  // a large upload can exceed a flat deadline while still progressing.
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
      // generation it held has ended here whatever the session property still
      // says: recovery refuses to re-dial past this point, and every later
      // operation rejects at its dead-session guard. Charged as its own cause
      // rather than as a loss: the exchange is over, and nothing recovered from
      // it.
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
  // never be answered with a stale secret. The non-string arm answers empty
  // rather than sending `undefined`; connect()'s gate attaches only over a string
  // password, and a re-dial answers from the same retained options, both driven
  // in ssh2SftpAdapter.test.ts ("does not attach a handler when tryKeyboard is
  // set but the password is not a string", "re-dial reuses the retained connect
  // options (no re-prompt / same key + credentials)").
  private attachKeyboardInteractive(): void {
    if (this.session.keyboardInteractiveAttached) return;
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
    this.session.recordKeyboardInteractiveAttached();
  }

  // Watch the ssh2 Client's transport lifecycle so the recovery re-dial can tell
  // a transport whose events have ALL been delivered from one that still owes
  // its 'close'. The measured ordering, and what an unwatchable Client costs,
  // are in docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack".
  private watchTransportLifecycle(): void {
    const client = (this.client as unknown as Ssh2SftpClientInternals).client;
    if (typeof client?.on !== "function") return;
    if (!this.session.beginWatchingTransport()) return;
    client.on("end", () => {
      this.session.recordTransportEnd();
    });
    client.on("close", () => {
      this.session.recordTransportClose();
    });
  }

  // Paced to once per adapter because the condition is the installed version's
  // rather than any one drop's, so a second copy tells nothing the first did
  // not.
  private warnUnreadableTransportLifecycle(): void {
    if (!this.session.spendUnreadableLifecycleWarning()) return;
    this.log.warn(unreadableTransportLifecycleWarning(FORCED_CLOSE_TIMEOUT_MS));
    this.log.debug(
      `whether a connection still owes ssh2 its 'close' is watched through ` +
        `ssh2's client.on(), which is not available after connect(), so this ` +
        `side closes the connection itself rather than reading that state`,
    );
  }

  // A terminal error built from a previously captured fatal SFTP-protocol error,
  // or undefined if the session has not been killed. Every server-driven operation
  // consults this at entry: a request buffered on a destroyed-but-socket-still-alive
  // channel never calls back, so without this guard the op would ride its full
  // per-operation bound before failing. safeDelete shares the same fatalSftpError
  // check but RESOLVES (its never-reject contract); see it, and see
  // canDrainDeferredCleanup for the cleanup-reissue rule.
  private deadSessionError(
    operation: string,
    path: string,
  ): TransportOperationStalledError | undefined {
    if (this.fatalSftpError === undefined) return undefined;
    return deadSessionOperationError(
      operation,
      path,
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
          // below, which reports the loss this recovery was for, rather than
          // replacing it with that error.
          if (this.session.abandonedTeardownClosedTransport)
            return "noSession" as RecoveryRedialOutcome;
          throw redialError;
        },
      );
      // end() may have latched `closing` while the re-dial held the transition
      // lock: join the teardown that will close the freshly-dialed session, so no
      // session outlives it, and report the original loss rather than re-issuing
      // into a closing adapter.
      if (this.session.isClosing) {
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
  // operation being issued now: the close window itself (including a release the
  // PEER began, the closedByPeer outcome), and the gap after a release completed.
  // Both are the release's to set; the default held-session mode reads false here
  // every time, with no mode check of its own. WHOSE loss a release closed over is
  // the recovery arm's question, not this one's.
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

  // Report a transparently-recovered mid-exchange session drop to the operator
  // at default verbosity; what is counted, charged and warned is in
  // docs/spec/CHANNEL_SECURITY.md, "What the accounting counts".
  //
  // Paced like every other repeating condition here (see the ledger's
  // pacedWarn), plus the LAST re-dial the budget permits:
  // ssh2SftpAdapter.test.ts, "warns on the last permitted re-dial, even below the
  // escalation interval", drives the default budget and reads exactly those two
  // lines. Each mode reads the re-dial its own way, since the two differ in
  // cause, remedy and bound.
  private warnSessionRecovered(): void {
    const count = this.ledger.midExchangeReconnectCount;
    if (this.ephemeralSessions) {
      this.ledger.pacedWarn(count, () =>
        sessionRecoveredEphemeralWarning(count),
      );
      return;
    }
    const budget = this.operativeMaxReconnectAttempts();
    const remaining = remainingMidExchangeRedials(budget, count);
    this.ledger.pacedWarn(
      count,
      () => sessionRecoveredHeldWarning(count, budget),
      remaining === 0,
    );
  }

  // Decide whether an op rejection is the session loss recovery re-dials on --
  // every condition post-state, never error-message matching. The trigger, the
  // readings that stay terminal, and the live-session-over-an-ended-transport
  // case are in docs/spec/CHANNEL_SECURITY.md, "What is re-dialed, and what
  // stays terminal".
  private shouldRecoverFromSessionLoss(error: unknown): boolean {
    if (this.session.isClosing) return false;
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
  // peer's FIN has been consumed; either way the transport can hold nothing more.
  // Both flags are plain net.Socket properties, read through the one ssh2
  // internal beneath them (`client._sock`, the same property connect()'s
  // keepalive safety check reaches). A socket reporting neither is treated as
  // not-ended.
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
        // a cycle-start or concurrent dial landed, or the release's close safety
        // check expired with the session still set -- and the dial rejects outright
        // when one is set, so leave the re-issue to run on it. Unless its transport
        // has ended, in which case the session is the loss the gate read it as and
        // the re-issue has nothing to run on.
        if (internals.sftp && !this.sessionTransportEnded(internals))
          return "sessionLive";
        // The session is gone or can hold nothing, so the generation that was
        // live has ended. Every end this side causes on purpose -- an idle
        // release, teardown's own close, a fatal protocol error -- charges itself
        // where it happens, so a generation still live here was ended by the
        // partner, save during a teardown whose re-dial (the abort-marker write or
        // the terminal-frame drain) is teardown mechanics rather than a survived
        // drop and is exempt from the counters, the cap and the warning.
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
    const cause: LossCause = this.session.isTearingDown
      ? "teardown"
      : "partner";
    const budgetSpent =
      cause === "partner" &&
      !this.ephemeralSessions &&
      this.ledger.midExchangeReconnectCount >=
        this.operativeMaxReconnectAttempts();
    const charged = this.ledger.recordLoss(this.ledger.liveGeneration, cause);
    if (budgetSpent)
      throw midExchangeReconnectBudgetExhaustedError(
        this.ledger.midExchangeReconnectCount,
        this.operativeMaxReconnectAttempts(),
      );
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
    // client while the dial re-establishes it -- a concurrent op. Under the lock
    // and immediately ahead of both the retirement and the dial, so nothing may
    // keep pinging a transport this is about to destroy. The dial re-arms a
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
      const closeState = this.session.transportClose;
      if (closeState === "delivered") return "retired";
      if (closeState === "unreadable") this.warnUnreadableTransportLifecycle();
    }
    // Which failure this reports turns on which state brought it here, because the
    // two leave the caller different work: a session still held over an ended
    // transport cannot take a re-issue at all, while a cleared one rejects it at
    // once with the real loss.
    const unretired = (): TransportRetirement =>
      sessionHeld ? "deadSessionHeld" : "unretiredTransport";
    const seams = resolveEndedTransportCloseSeams(internals);
    if ("missing" in seams) {
      this.log.warn(
        `The partner's SFTP server dropped the SFTP session mid-exchange and ` +
          `it could not be re-opened, so this operation failed. This build ` +
          `of psilink is not compatible with the installed SFTP library; ` +
          `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `re-dialing drives ssh2's ${seams.missing}, which is not available ` +
          `after connect(); the installed ssh2 / ssh2-sftp-client version ` +
          `may have renamed, relocated, or removed it`,
      );
      return unretired();
    }
    try {
      if (!(await this.forceCloseEndedTransport(held, internals, seams))) {
        this.log.warn(
          `The SFTP session the partner's server dropped did not close ` +
            `within ${FORCED_CLOSE_TIMEOUT_MS} ms, so it could not be ` +
            `re-opened and this operation failed. This build of psilink may ` +
            `not be compatible with the installed SFTP library; ` +
            `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
        );
        this.log.debug(
          `the installed ssh2 may no longer emit the client 'close' that ` +
            `clears the session`,
        );
        return "deadSessionHeld";
      }
    } catch (error: unknown) {
      this.log.warn(
        `Closing the SFTP connection from this side, to re-open a session the ` +
          `partner's server dropped mid-exchange, failed: ` +
          `${sanitizeErrorForDisplay(error)}. The dropped session could not ` +
          `be re-opened, so this operation failed. This build of psilink may ` +
          `not be compatible with the installed SFTP library; ` +
          `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `the installed ssh2's transport may no longer accept the destroy ` +
          `that drives the client 'close'`,
      );
      return unretired();
    }
    if (this.session.transportClose === "owed") {
      this.log.warn(
        `The SFTP connection the partner's server dropped mid-exchange did ` +
          `not close within ${FORCED_CLOSE_TIMEOUT_MS} ms of this side ` +
          `closing it, so the session was not re-opened and this operation ` +
          `failed with the drop it already had. This build of psilink may not ` +
          `be compatible with the installed SFTP library; ` +
          `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `a re-dial issued while ssh2 still owes that connection its 'close' ` +
          `fails and abandons the session it opens; the installed ssh2 may no ` +
          `longer emit the client 'close' that retires a destroyed transport`,
      );
      return "unretiredTransport";
    }
    return "retired";
  }

  // SSH_FX_NO_SUCH_FILE: the source-absent status ssh2-sftp-client reports as the
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
    // reconnect. Constraining here rather than in the public connect() covers the
    // last two, which enter with the retained options and never through
    // connect(). On a host that can perform everything ssh2 offers, this returns
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
    // Route the SSH stack's own diagnostics into psilink's logger for the
    // life of the connection this dial opens, at the trace level and nowhere
    // else (see ./sftpWireTrace). Seated on the per-dial options rather than the
    // retained ones, so no callback is stored on what a recovery re-dial reads
    // back, and every dial path -- the first connect, a recovery re-dial, a
    // connection-per-poll cycle start -- passes here.
    if (this.wireTrace !== undefined) connectOptions.debug = this.wireTrace;
    this.options = connectOptions;
    // Watch the transport lifecycle from the first dial on, so the reading a later
    // recovery re-dial takes covers every transport this adapter establishes.
    this.watchTransportLifecycle();
    // Install the keyboard-interactive answer handler BEFORE connecting, so it is
    // registered by the time ssh2 negotiates auth. core sets tryKeyboard only
    // alongside a password (schema-refined), so the password guard here is a
    // safety check for a direct adapter caller: with no password there is
    // nothing to answer prompts with, so the handler is skipped and the method
    // falls through to whatever other auth (if any) the options have.
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
          return this.dialOnce(connectOptions, held);
        },
        maxReconnects,
        1_000,
        (err) => {
          // The teardown latch, read BETWEEN attempts for the same reason
          // runTransition reads it before a transition's body: once end() has
          // latched, nothing may establish a session the teardown will not close.
          // It stops the abandoning teardown's forced destroy from being undone by
          // this loop -- the destroy cuts the attempt short with an unexpected
          // close, and a re-attempt mints a FRESH socket (measured: a re-dial 1 s
          // after the destroy, on a socket reading writable again).
          if (this.session.isClosing) return false;
          // A subsystem-open deadline is terminal: the server took the whole
          // per-attempt budget on a connection it had already authenticated, and
          // a re-attempt puts the same request to the same server for the rest
          // of the reconnect budget.
          if (err instanceof SubsystemOpenTimeoutError) return false;
          // A key-exchange negotiation with nothing in common is terminal on a
          // process missing a primitive: the offer this side can make is fixed
          // for the life of the process, so every re-attempt puts the same
          // withheld offer to the same server, a second apart, for the whole
          // reconnect budget. What classifies it is that verdict rather than the
          // message, which a server writes verbatim through its own
          // SSH_MSG_DISCONNECT description.
          if (isUnperformableKexNegotiationFailure(err, unavailablePrimitives))
            return false;
          // Host-key verification failure is terminal: the server is actively
          // presenting a different or unknown key, so retrying the key exchange
          // against the same server changes nothing. ssh2's "Host denied
          // (verification failed)" is wrapped by ssh2-sftp-client as a new Error
          // with the same message; match on the stable message fragment from
          // kex.js rather than a code that is not set on the error object.
          return !(err instanceof Error && err.message.includes("Host denied"));
        },
      );
    } catch (err) {
      // A key-exchange negotiation that found nothing in common is re-raised
      // naming the platform capability that withheld the algorithms, so the
      // operator is not left reading ssh2's bare "no matching key exchange
      // algorithm" as a server misconfiguration. Outside the retry loop rather
      // than inside it, which is required for the classification above: this
      // REPLACES the message and keeps ssh2's own as the cause. For every other
      // failure, the rejection passes through untouched.
      throw await this.diagnoseDialFailure(
        explainKexNegotiationFailure(err, unavailablePrimitives),
        connectOptions,
      );
    }

    // A dial reaching here with a generation still live ended that generation,
    // and the session reading taken before the dial is what says how. A session
    // that was LIVE was REPLACED by this dial -- this side's own doing; a
    // session already gone was taken by the partner and absorbed by this dial
    // without any operation or release observing it, which a cycle-start re-dial
    // does when a drop lands in the tail of a poll cycle. A dial during teardown
    // has the teardown's own exemption instead. Charged before the advance
    // below, so that advance can refuse a generation it would otherwise
    // overwrite silently.
    const cause: LossCause = replacedLiveSession
      ? "deliberate"
      : this.session.isTearingDown
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
    // and a drop can take, and one whose loss held the generation of the session
    // it replaced would go unreported.
    this.ledger.dialSucceeded();

    const internals = this.client as unknown as Ssh2SftpClientInternals;

    // Disable Nagle's algorithm on the established client socket. The rendezvous
    // protocol is a long run of small, latency-bound request/response round trips;
    // with Nagle on, each can collide with the peer's TCP delayed-ACK and stall up
    // to ~40 ms on Linux (it does not show up on macOS loopback). ssh2 leaves the
    // client socket at the kernel default (Nagle on) and never calls setNoDelay
    // itself, so drive its public setNoDelay here on every connect (a fresh socket
    // per attempt). Guarded and non-fatal: a future upstream that drops the method
    // must degrade to slower-but-correct, not fail to connect.
    if (typeof internals.client?.setNoDelay === "function") {
      internals.client.setNoDelay(true);
    } else {
      this.log.warn(
        "ssh2's client.setNoDelay() is not available after connect(); the SFTP " +
          "client socket keeps Nagle enabled and may incur per-round-trip " +
          "latency. Check the ssh2 / ssh2-sftp-client changelog.",
      );
    }

    // Enable kernel TCP keepalive on the established socket alongside the
    // application heartbeat below: it keeps NAT/firewall flow state warm and
    // lets the kernel detect a silently dead peer, but does NOT reset the
    // server's SFTP-command idle timer (that is what the heartbeat's realPath is
    // for). ssh2 exposes setNoDelay but not setKeepAlive, so reach the Client's
    // underlying net.Socket (`_sock`) directly, the same access-past-the-public-API
    // assumption the fatal-'error' guard and createExclusive rely on (re-verify on
    // any ssh2 upgrade per the DEPENDENCY_PINS.md checklist). Guarded and
    // non-fatal, exactly like setNoDelay.
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
    // call is present and callable now, so an upstream rename reports as one
    // actionable error here at connect time rather than as a TypeError at the
    // first send()/poll. A bare `!sftp` check would let a renamed method slip
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
    // The connection-per-poll idle release reaches past the public API for
    // internal properties of its own; verify them here on the same terms and for
    // the same reason, while the mode that drives them is the mode being
    // connected. The default held-session mode reaches them only at teardown,
    // where an unavailable property degrades to a warning, so it is not held to
    // them at dial time.
    if (this.ephemeralSessions) {
      const seams = resolveTransportCloseSeams(internals);
      if ("missing" in seams) {
        this.log.debug(
          `closing an SFTP connection from this side drives ssh2's ` +
            `${seams.missing}, which is not available after connect(); the ` +
            `installed ssh2 / ssh2-sftp-client version may have renamed, ` +
            `relocated, or removed it`,
        );
        throw transportCloseSeamError();
      }
    }
    // Attach the guarded fatal-'error' listener to the raw wrapper now, while it
    // is known present and callable, so a malformed server reply can never crash
    // the process. See attachFatalErrorListener for the full rationale and the
    // reconnect/idempotency analysis.
    this.attachFatalErrorListener(sftp);
    // The session is established: arm the keepalive heartbeat so a long idle
    // stretch (a PSI round on the computing side) does not let the server's
    // idle timeout drop it. start() resets the idle clock, so a reconnect re-
    // arms cleanly; it is torn down by end() and by the fatal-'error' guard.
    // Skipped in ephemeral-session mode, where NO session is heartbeated: the
    // two spans that DO cross an idle stretch there -- the rendezvous that
    // precedes the loop, and a boundary the release keeps for an outstanding
    // operation -- are accepted un-heartbeated and cross it instead through the
    // mode's uncapped recovery re-dial (the uncapped-recovery unit case in
    // test/unit/connection/ssh2SftpAdapter.test.ts, driven end to end in
    // test/integration/ephemeralSessionExchange.test.ts).
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

  // One dial attempt, bounded for its whole length. ssh2's readyTimeout covers
  // the attempt only up to authentication and is cleared there, so the SFTP
  // subsystem request that follows is bounded here instead (see
  // ./sftpSubsystemOpen for the bound and its derivation).
  private async dialOnce(
    connectOptions: Ssh2SftpClient.ConnectOptions,
    held: HeldSessionTransition,
  ): Promise<void> {
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    const watch = watchSubsystemOpen(
      internals.client,
      subsystemOpenTimeoutMs(connectOptions.readyTimeout),
    );
    if (watch === undefined) {
      this.warnUnboundedSubsystemOpen();
      await this.client.connect(connectOptions);
      return;
    }
    try {
      await Promise.race([this.client.connect(connectOptions), watch.expired]);
    } catch (error: unknown) {
      // The dial that lost that race is still parked on a socket that is still
      // WRITABLE, which every later dial on this shared client would defer
      // behind forever (docs/spec/DEPENDENCY_PINS.md). Closed, and that close
      // waited out, before the rejection is reported: no caller can observe the
      // failure over a transport that is still open, nor over one whose close
      // this side still owes.
      if (error instanceof SubsystemOpenTimeoutError)
        await this.closeUnansweredDial(held);
      throw error;
    } finally {
      watch.cancel();
    }
  }

  // Close the transport beneath a dial this side is abandoning and wait that
  // close out, as this adapter's other two forced closes do: a dial issued while
  // the ssh2 Client's 'close' is still owed is failed by ssh2-sftp-client's
  // connect-time listeners while the handshake it started runs on unowned at the
  // server (docs/spec/DEPENDENCY_PINS.md).
  //
  // net.Socket's destroy() needs nothing from the peer, and it settles the
  // abandoned dial as well (measured against the pinned stack in
  // test/integration/sftpStackPremises.test.ts). Nothing here throws: the caller
  // is already reporting the dial's own failure, and a transport this build
  // cannot reach, or a close that fails, is reported as a warning beside it.
  private async closeUnansweredDial(
    held: HeldSessionTransition,
  ): Promise<void> {
    const transport = resolveForcedCloseSeams(
      this.client as unknown as Ssh2SftpClientInternals,
    );
    if ("missing" in transport) {
      this.log.warn(
        `The SFTP server left this connection's SFTP subsystem request ` +
          `unanswered and this build could not close the connection from this ` +
          `side, so it is left to the operating system: until that closes it, ` +
          `a later dial on this connection waits behind it with no deadline. ` +
          `Interrupt the command if it stops making progress. This build of ` +
          `psilink is not compatible with the installed SFTP library; ` +
          `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `closing an abandoned dial from this side drives ssh2's ` +
          `${transport.missing}, which is not available after connect(); the ` +
          `installed ssh2 / ssh2-sftp-client version may have renamed, ` +
          `relocated, or removed it`,
      );
      return;
    }
    try {
      // This wait's outcome is not read: an expired wait -- the destroy
      // landed but no close arrived within the bound -- is reported exactly
      // like a clean close. Measured against the pinned stack the close
      // lands within a millisecond of the destroy, so the expiry branch is a
      // library-relocation shape rather than a reachable one.
      await this.awaitClientClose(
        held,
        transport.once,
        transport.removeListener,
        FORCED_CLOSE_TIMEOUT_MS,
        transport.destroy,
        true,
      );
    } catch (error: unknown) {
      // Reported here rather than raised, because raising would replace the
      // dial's own rejection -- the reading the retry loop classifies this
      // failure as terminal by -- with this one.
      this.log.warn(
        `Closing the connection beneath a dial the SFTP server left at the ` +
          `subsystem request failed: ${sanitizeErrorForDisplay(error)}. The ` +
          `connection is left to the operating system: until that closes it, ` +
          `a later dial on this connection waits behind it with no deadline. ` +
          `Interrupt the command if it stops making progress.`,
      );
    }
  }

  // Paced to once per adapter because the condition is the installed version's
  // rather than any one dial's, exactly as the transport-lifecycle warning is.
  private warnUnboundedSubsystemOpen(): void {
    if (this.warnedUnboundedSubsystemOpen) return;
    this.warnedUnboundedSubsystemOpen = true;
    this.log.warn(unboundedSubsystemOpenWarning());
    this.log.debug(
      `the phase after authentication is bounded by subscribing to ssh2's ` +
        `client.once('ready'), which is not available on the installed ssh2 / ` +
        `ssh2-sftp-client version`,
    );
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
    if (this.session.peerAnswerDiagnosisSpent) return error;
    if (this.session.isClosing || this.session.isTearingDown) return error;
    if (this.isFatalDialError(error)) return error;
    if (!isPreIdentificationDialFailure(error)) return error;
    const endpoint = peerProbeTargetFromConnectOptions(connectOptions);
    if (endpoint === undefined) return error;
    this.session.spendPeerAnswerDiagnosis();
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
   * Marks the start of the connection's close()/teardown (see
   * {@link SftpSessionState.isTearingDown}). Core calls it at the top of
   * close(), and the
   * authenticated abort-marker write calls it before issuing its put() -- which
   * can race close() -- so whichever teardown op re-dials first is exempt from
   * the mid-exchange reconnection cap. An idempotent latch; the connectionless
   * transports do not implement it (optional on {@link FileTransportClient}).
   */
  beginTeardown(): void {
    this.session.beginTeardown();
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
    this.session.beginClose();
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
    // Forced FIRST, then reported: no caller can observe this rejection over a
    // socket still alive, including the ones sharing the memo, since the memoized
    // promise does not settle until the destroy above has run. What the rejection
    // reports is unchanged from an unbounded await -- core logs it at debug and the
    // exit code is untouched -- so it is not swallowed here.
    if (outcome.status === "failed") throw outcome.error;
  }

  // ssh2-sftp-client's end() did not close the connection: either the partner
  // accepted the disconnect and never closed it, leaving the ssh2 Client's
  // 'close' outstanding past the bound, or end() rejected without closing
  // anything. Both leave a transport this side has already ended. Close it from
  // this side: net.Socket's destroy() needs nothing from the peer, and beneath a
  // pending end() it SETTLES that end() rather than abandoning it, so the
  // process is left holding no half-open socket.
  //
  // Nothing here throws, and every degraded branch is a warning that names what
  // broke, with the ssh2 reading behind it logged at debug: core treats end() as
  // best-effort and logs a rejection at debug, so a throw would be invisible and
  // would accomplish nothing.
  private async forceCloseTerminalTransport(
    held: HeldSessionTransition,
    ending: Promise<unknown>,
    outcome: { status: "failed"; error: unknown } | { status: "expired" },
  ): Promise<void> {
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    // Resolved HERE rather than at connect: the default held-session mode does not
    // verify this property at dial time (see connect()), and failing a dial over a
    // teardown-only mechanism would ground every default-mode exchange on an ssh2
    // bump that costs it nothing. An unavailable property degrades to a warning
    // and a bounded return instead.
    const seam = resolveTerminalCloseSeam(internals);
    if ("missing" in seam) {
      this.log.warn(
        `The SFTP connection was not closed by the partner's SFTP server at ` +
          `teardown, and this build could not close it from this side: the ` +
          `connection is left to the operating system, may stay half-open, ` +
          `and a half-open connection can keep this process from exiting. ` +
          `This build of psilink is not compatible with the installed SFTP ` +
          `library; ${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `closing from this side drives ssh2's ${seam.missing}, which is not ` +
          `available after connect(); the installed ssh2 / ssh2-sftp-client ` +
          `version may have renamed, relocated, or removed it`,
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
    // That the destroyed socket actually closed is the one assumption connect()
    // cannot check -- nothing at connect time destroys the socket -- so it is read
    // back where it is driven.
    if (seam.socket.destroyed !== true) {
      this.log.warn(
        `The SFTP connection's transport did not close after this side ` +
          `destroyed it at teardown, so the connection may stay half-open, ` +
          `and a half-open connection can keep this process from exiting. ` +
          `This build of psilink may not be compatible with the installed ` +
          `SFTP library; ${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `the installed ssh2 may no longer expose the socket beneath its client`,
      );
      return;
    }
    // At default verbosity and informational: teardown's close runs last, so
    // nothing it reports changes what the run produced, and this adapter has no
    // notion of that outcome. Not rolled into the connection-per-poll release's
    // forced-release count, whose wording and end-of-run total are that mode's
    // per-cycle boundary. The two outcomes get their own sentence: nothing ran
    // out of time on the rejecting one, so the bound is not what to tell the
    // operator.
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
          `${TRANSITION_ACQUIRE_TIMEOUT_MS} ms teardown wait, and this build ` +
          `could not close the connection from this side: the connection is ` +
          `left to the operating system, may stay half-open, and a half-open ` +
          `connection can keep this process from exiting. This build of ` +
          `psilink is not compatible with the installed SFTP library; ` +
          `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `closing from this side drives ssh2's ${seam.missing}, which is not ` +
          `available after connect(); the installed ssh2 / ssh2-sftp-client ` +
          `version may have renamed, relocated, or removed it`,
      );
      return;
    }
    try {
      seam.destroy();
      // Set where the destroy is driven rather than after the read-back below: it
      // is the destroy that settles the dial this teardown gave up on, whatever the
      // socket then reports about itself.
      this.session.recordAbandonedTeardownClose();
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
          `destroyed it at teardown, so the connection may stay half-open, ` +
          `and a half-open connection can keep this process from exiting. ` +
          `This build of psilink may not be compatible with the installed ` +
          `SFTP library; ${REPORT_LIBRARY_INCOMPATIBILITY}.`,
      );
      this.log.debug(
        `the installed ssh2 may no longer expose the socket beneath its client`,
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
  // The session reading is written twice over a boundary that ends one: the entry
  // classification -- WHO ended the transport -- must stand before the close is
  // driven, because an operation already on the wire is torn by that close and
  // reads the boundary while this release is still running. Both writes go
  // through the same projection, so the second is a no-op except where the
  // release ended nothing after all.
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
    // cause is: a release that was itself what ended the transport charges the
    // boundary as its own, while one that closed over a partner's drop -- a
    // consumed FIN, a half-ended transport, or a session already cleared --
    // charges the partner, the same answer the recovery chokepoint would have
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
      this.ledger.pacedWarn(count, () =>
        idleReleaseDeclinedWarning(count, TRANSITION_ACQUIRE_TIMEOUT_MS),
      );
    if (outcome === "didNotClose")
      // Unpaced by design: this is the one degraded outcome with no run
      // total, so every occurrence is its own record.
      this.log.warn(idleReleaseDidNotCloseWarning());
  }

  // Counted as the lost session it is, and reported on the shared cadence because
  // a server that caps session lifetime does this every cycle.
  private warnPartnerDropAtIdleBoundary(): void {
    const count = this.ledger.countPartnerDropAtBoundary();
    this.ledger.pacedWarn(count, () => partnerDropAtIdleBoundaryWarning(count));
  }

  // The locked body of releaseForIdle. Taking the transition lock for the whole of
  // it -- the forced close included -- stops a handshake and this teardown from
  // running at once on the one shared Ssh2SftpClient, and stops a dial landing
  // after the boundary from holding its session across the whole idle gap:
  // entered while a dial was in flight, this would read the not-yet-established
  // session as "nothing to release" and the mode would silently keep the session
  // it exists to shed.
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
    if ("missing" in seams) {
      this.log.debug(
        `closing an SFTP connection from this side drives ssh2's ` +
          `${seams.missing}, which is not available after connect(); the ` +
          `installed ssh2 / ssh2-sftp-client version may have renamed, ` +
          `relocated, or removed it`,
      );
      throw transportCloseSeamError();
    }
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
    // ssh2-sftp-client's global 'close' listener has not run, so the timeout
    // settled that wait rather than the ssh2 Client's 'close'. Which state that is
    // turns on whether the transport was ended, so it is a branch on the socket
    // rather than a claim in a comment.
    if (socket.writableEnded === false) {
      // The transport this adapter's end() should have ended is still writable, so
      // this is the one branch where the session may be live and held across the
      // idle gap. The outcome takes the release's reading back: no
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
      this.log.debug(
        `the installed ssh2 may no longer emit the client 'close' that ` +
          `clears the session`,
      );
      throw new Error(
        `the connection-per-poll idle release closed the SFTP session's ` +
          `transport and the session did not clear within ` +
          `${FORCED_CLOSE_TIMEOUT_MS} ms, so the exchange cannot continue. ` +
          `This build of psilink may not be compatible with the installed ` +
          `SFTP library; ${REPORT_LIBRARY_INCOMPATIBILITY}`,
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
  // so a promise that loses the race and rejects later never shows up as an
  // unhandled rejection, and handed back on `error` instead.
  //
  // `holdProcessAlive` decides whether the bound's own timer is ref'd. A wait on a
  // socket this adapter merely ENDED leaves it unref'd (the unref'd-by-design
  // SFTP-liveness-timer contract): the half-ended socket is itself a ref'd handle,
  // so the wait is observable without the timer's help. A wait after the socket
  // has been DESTROYED is the deviation: nothing ref'd is left behind it, so an
  // unref'd timer would let the process exit silently before the caller's
  // read-back runs (measured both ways).
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
  // transport is ended with the session still set: it can hold nothing, while
  // every path that reads the session property reads it as live and skips the
  // dial it needs. Force the socket closed instead: destroy() needs nothing from
  // the peer, and the ssh2 Client's 'close' that follows is what fires
  // ssh2-sftp-client's global listener to clear the session, leaving a dial to
  // make.
  //
  // That the destroyed transport takes the session with it is the one assumption
  // here the dial cannot check, so it is read back and REPORTED where it is
  // driven. Reported rather than raised: the idle release raises (a boundary that
  // silently stopped meaning anything is worse than a failed cycle) and the
  // mid-exchange recovery warns and lets the operation's own loss stand.
  private async forceCloseEndedTransport(
    held: HeldSessionTransition,
    internals: Ssh2SftpClientInternals,
    seams: ForcedCloseSeams,
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

  // A partner that never closes forces one of these every cycle, so the line takes
  // the shared warn cadence. Nothing leaks, and a loss suffered at one of these
  // boundaries is reported by its own line or by the path that recovered it rather
  // than by this one, so pacing it costs the operator nothing.
  private warnForcedRelease(): void {
    const count = this.ledger.forcedReleaseCount;
    this.ledger.pacedWarn(count, () => forcedIdleReleaseWarning(count));
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
        await this.deferredCleanupDeletes.drain().then(
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
          // destroys the transport beneath a dial in flight, and that rejection has
          // the same error a genuine peer close does, so a line here would report
          // this adapter's own close as the partner's. What closed the connection
          // is reported by the teardown that closed it; the silence is driven in
          // sftpKexFastFail.test.ts, "a dial the teardown settled reports nothing
          // and skips, on such a host too".
          if (this.session.isClosing) return false;
          // A transient dial failure (server briefly unreachable, connection
          // refused, auth exhaustion) is not fatal in this mode: report it and
          // skip the cycle rather than throwing. ssh2SftpAdapter.test.ts, "a
          // transient dial failure returns false (skip the cycle), not a throw",
          // holds this arm, and ephemeralSessionExchange.test.ts drives the
          // consequence end to end. Nothing here bounds a streak that never
          // resolves: that is the consumer's peer-inactivity ceiling
          // (docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack").
          this.log.warn(
            "ephemeral SFTP re-dial failed; skipping this poll cycle and " +
              `retrying on the next tick: ${sanitizeErrorForDisplay(error)}`,
          );
          return false;
        }
      },
    });
  }

  // Counted apart from the idle release's decline (warnIdleReleaseDeclined) though
  // core drives both signals once per poll cycle: one stuck transition declines
  // both, and a shared count would pace each line on the other's occurrences and
  // misstate both numbers.
  private warnCycleRedialDeclined(): void {
    const count = this.ledger.countDeclinedCycleRedial();
    this.ledger.pacedWarn(count, () =>
      cycleRedialDeclinedWarning(count, TRANSITION_ACQUIRE_TIMEOUT_MS),
    );
  }

  // A dial failure that must terminate the exchange rather than be retried on the
  // next tick. Two classes qualify, each permanent in its own way.
  //
  // A host-key verification failure means the server is presenting a different or
  // unknown key -- a trust-boundary fault (possible MITM) that must fail loudly
  // and fast, never hidden as a transient network blip and ridden to a generic
  // peer-silence timeout. ssh2 reports it as "Host denied (verification failed)",
  // the same stable fragment connect()'s retry predicate treats as terminal
  // (re-verify on any ssh2 upgrade per docs/spec/DEPENDENCY_PINS.md).
  //
  // A key exchange this process cannot perform is permanent for the life of the
  // run: every tick puts the same withheld offer to the same server until the
  // peer-inactivity ceiling ends the run. The classifier is the connect loop's
  // own, read over the same capability verdict, so the two dial paths cannot
  // disagree about one rejection -- never a message a server or an on-path
  // attacker can write (see sftpKexCapability).
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
          // never sets the EOF status, so the batch loop would recurse without end.
          // Capping the total readdir calls fails that progress-free flood with a
          // typed terminal error. (Production is safe from deep synchronous
          // recursion: ssh2 dispatches each readdir callback from a socket event, a
          // fresh tick; the cap is the DoS bound, not a stack guard.)
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
            // it withholds a readdir, so awaiting close() here would restore the
            // unbounded wait this guard exists to defeat. Close is best-effort
            // cleanup that reclaims the handle on a well-behaved server; a withheld
            // close callback leaks the handle until session teardown. A close()
            // error on a read-only directory handle has no data meaning, so it is
            // swallowed.
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
                // already returned otherwise); `?? []` keeps the type accurate and
                // treats a defensively-missing batch as empty. Apply the two bounds
                // in the SAME order as LocalFSClient.list(): the entry-count bound
                // first, then the per-name length bound, so both adapters raise the
                // same error variant for a directory that breaches both at once.
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
      // Uncapped reads have no counting sink, so they have no per-chunk progress
      // signal to drive the idle bound the capped path below uses. The transport
      // always passes maxBytes, so this branch is effectively unused; bound it
      // with a coarse whole-operation deadline anyway so a withheld or
      // never-ending transfer fails rather than hanging.
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
    // server. A server that under-reports the file's size in its directory
    // listing (and thus slips past the poll loop's pre-get() check) still
    // cannot drive an unbounded allocation here -- allocation stays bounded to
    // roughly maxBytes however the transfer ends.
    //
    // The over-cap outcome is owned by the sink, decided at the point of
    // detection; this get()'s own settle only feeds the non-over-cap cases via
    // complete()/fail(). That removes the resolve-vs-reject race in
    // ssh2-sftp-client's stream-destination handling (it resolves via the read
    // stream's 'end' event but rejects via the sink's 'error' event) -- see
    // createCappedSink. No encoding is forwarded (raw Buffer chunks), matching
    // the buffer that the uncapped path and LocalFSClient return.
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
    // recovery re-issue re-streams the identical payload. A provided
    // ReadableStream is one-shot: a first attempt half-drains it, so re-issuing
    // would re-pipe an already-consumed stream and silently upload nothing. Do NOT
    // wrap that case in recovery; a dropped session fails it terminally rather
    // than half-re-issuing it. The peer never observes a partial because every
    // write targets a temp-*.tmp then atomic-renames.
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
      // false-failed. The chunk list is streamed part-by-part without
      // concatenation.
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
              // land between attempts, leaving no in-flight request for
              // cleanupRequests to fail; without this re-check the next attempt
              // would run the idle window's full bound before the typed terminal
              // error ended the retry.
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
    // this app. They have no per-op idle window -- it needs a re-runnable source,
    // which a one-shot stream cannot give. A string is re-runnable
    // (ssh2-sftp-client opens a fresh fs.createReadStream per attempt) and gets
    // retried; a ReadableStream is one-shot -- a failed attempt half-drains it,
    // so it gets a single attempt instead. Both stay bounded only by the
    // whole-exchange budget, and both fall back to an elapsed-only slow-op
    // warning (no cheap size).
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
        // genuine absence must still be reported.
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
    // per-operation deadline has negligible false-fail risk (same profile as
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
    if (this.idleReleaseLeftNoSession())
      this.deferredCleanupDeletes.record(path);
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
            this.deferredCleanupDeletes.record(path);
          },
        ),
      ),
    );
  }

  // Whether the record's drain may be issued now: a fatal SFTP protocol error
  // leaves a wrapper on which a posted request never calls back -- the very thing
  // the cleanup delete's own short-circuit refuses to do -- a latched teardown
  // has end() already closing the client, and with no live session the record
  // keeps for the next re-establishment. Each is in
  // docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record".
  private canDrainDeferredCleanup(): boolean {
    if (this.fatalSftpError !== undefined) return false;
    if (this.session.isClosing) return false;
    return this.hasLiveSession();
  }

  // The round trip a re-issued cleanup delete makes, kept here rather than in the
  // record so it stays where the adapter's two source checks examine it. Why it
  // is issued OUTSIDE the tracked() bracket, and why a release may tear it, are
  // in docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record". The
  // allowance is registered, with that reason, in
  // scripts/sftp-tracked-round-trips.test.mjs.
  private reissueCleanupDelete(path: string): Promise<void> {
    return this.client.delete(path, true).then(() => {});
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
        // rename that never landed does. Nothing the adapter can read separates
        // them (see CHANNEL_SECURITY.md), so that state is reported as the
        // indeterminate outcome it is. Every OTHER failure keeps propagating
        // verbatim.
        reissue: (run) =>
          run().catch(async (error: unknown) => {
            const code = (error as Ssh2SftpError | null | undefined)?.code;
            const sourceGone = this.isNoSuchFileError(error);
            if (!sourceGone && code !== SSH_FX_FAILURE) throw error;
            // The probe is a server round trip like any other, so it goes
            // through the private once-layer: that call site has the
            // per-operation deadline and the dead-session guard, and it runs
            // inside this operation's own outstanding span, so an idle-boundary
            // release cannot tear it. The public exists() is the wrong call site
            // here: it would arm a second recovery round from inside this one's
            // catch. However the probe rejects -- dead session, expired
            // deadline, or a real I/O error -- it has confirmed nothing, which
            // is a different answer from a destination the server reported
            // absent.
            const destination = await this.existsOnce(toPath).then(
              (present) => (present ? "present" : "absent"),
              () => "unanswered",
            );
            if (destination === "present") return;
            // A code-4 failure is the server's own answer that the rename did
            // not take effect, so it stays determinate and is reported as itself;
            // only the source-gone code can be the landed-then-consumed state.
            if (!sourceGone) throw error;
            if (destination === "absent") {
              // The one reading that determines it the other way: a source still
              // on the server means nothing moved this party's file, so the
              // publish determinately did not land. Worth the second round trip
              // only where the first was answered -- a probe that could not
              // answer has already left the question open.
              const sourceHeld = await this.existsOnce(fromPath).catch(
                () => false,
              );
              if (sourceHeld) throw error;
            }
            throw indeterminatePublishError(error, toPath);
          }),
      },
      () => this.renameOnce(fromPath, toPath),
    );
  }

  private renameOnce(fromPath: string, toPath: string): Promise<void> {
    // Retry a transient rename failure under put()'s bounded budget (one initial
    // attempt plus up to `retries` re-issues, 100 ms apart), but -- unlike put(),
    // which is idempotent -- only on the generic SSH_FX_FAILURE (status 4): the
    // server reported the rename did not happen, so `fromPath` still exists and a
    // re-issue is safe. Every other status is terminal at once, including
    // SSH_FX_NO_SUCH_FILE (2), which a second attempt would see if the first had
    // actually succeeded but its reply was lost; retrying that would turn a
    // succeeded rename into a spurious error. ssh2-sftp-client passes the raw
    // ssh2 numeric status through fmtError to err.code (the same assumption
    // createExclusive relies on).
    return this.tracked(
      this.warnIfSlow(
        this.countedOperationRetry(
          () => {
            // Re-check the dead-session guard before EVERY attempt, not only at
            // method entry. A fatal SFTP protocol error can land in the gap
            // between attempts: it sets fatalSftpError but leaves no in-flight
            // request for ssh2's cleanupRequests to fail. Re-checking turns that
            // into a prompt TransportOperationStalledError, which is not status 4
            // and so ends the retry rather than being re-issued --
            // ssh2SftpAdapter.test.ts, "stops retrying when a fatal session error
            // lands between attempts".
            const dead = this.deadSessionError("file rename", fromPath);
            if (dead) return Promise.reject(dead);
            // Bound each attempt's server round-trip: a withheld rename callback
            // fast-fails in 60 s with the typed terminal error (which, not being
            // SSH_FX_FAILURE, ends the retry below) rather than hanging this attempt
            // forever and stalling the whole exchange. rename is a single metadata
            // round-trip, so the flat deadline has negligible false-fail risk.
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
        // winners" state that is benign given the rendezvous invariants (roles
        // committed from hello-filename order before the lock is taken; the lock
        // only gates eager cleanup; leftover files are excluded from polling and
        // swept at close). Resolving own-EEXIST-as-success is the implementation;
        // the security review verifies the race.
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
    // has negligible false-fail risk and fast-fails a withheld stat callback in
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
