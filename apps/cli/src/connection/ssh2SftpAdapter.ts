// This adapter drives ssh2's raw SFTPWrapper internals past the public
// ssh2-sftp-client API, so ssh2 and ssh2-sftp-client are exact-pinned in
// package.json. On any upgrade of either, re-verify the internal premises per
// the "Upgrading the SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md
// before it merges -- a "compatible" bump can silently break a premise no
// normal-path test exercises.
import Ssh2SftpClient from "ssh2-sftp-client";
import {
  DirectoryListingBoundsError,
  FileInfo,
  FileTransportClient,
  FrameSizeExceededError,
  GetOptions,
  PutOptions,
  PutSource,
  TransportOperationStalledError,
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

// Upper bound (ms) on how long the connection-per-poll release
// ({@link SSH2SFTPClientAdapter.releaseForIdle}) waits for the ssh2 Client's
// 'close' after driving its end(). A local socket close completes in
// milliseconds; this only bounds a pathological withheld close so it cannot hang
// the poll loop's idle boundary. Deliberately not operator-configurable -- it is
// a liveness backstop, not a tunable, exactly like the other SFTP liveness bounds.
const EPHEMERAL_RELEASE_CLOSE_TIMEOUT_MS = 5_000;

// Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
// exposes as `this.sftp`. Defined at file scope so connect(), createExclusive(),
// and list() can share it without repeating the declaration.
interface Ssh2SftpClientInternals {
  // The underlying ssh2 Client instance. ssh2-sftp-client constructs it as
  // `this.client` and drives every connection through it; its public
  // setNoDelay(boolean) toggles TCP_NODELAY on the live socket. `_sock` is the
  // ssh2 Client's underlying net.Socket, whose setKeepAlive(enable, initialDelay)
  // enables kernel TCP keepalive -- ssh2 exposes setNoDelay but not setKeepAlive,
  // so the keepalive backstop reaches the socket directly. Both are optional so
  // the guarded calls in connect() can warn-and-continue (each is transport
  // hygiene, not a correctness requirement) if an upgrade relocates them.
  client?: {
    setNoDelay(noDelay: boolean): void;
    _sock?: { setKeepAlive?(enable: boolean, initialDelay: number): void };
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
    // server drop) and awaits its 'close' to know the session is torn down. Both
    // are on the ssh2 Client's EventEmitter surface; typed optional so the guarded
    // release can warn-and-hold if an upgrade relocates them. See
    // releaseForIdle().
    once?(event: "close", listener: () => void): void;
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
 * line on every poll cycle. This is an observability cadence only, not a bound on
 * recovery: recovery itself is uncapped -- each operation invocation earns a
 * fresh round (see {@link SSH2SFTPClientAdapter.withSessionRecovery}).
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
  // Latched true by end() so session recovery does not launch a re-dial once
  // teardown has begun (a re-dial's readyTimeout would slow a clean close, and a
  // freshly-dialed session would outlive the teardown).
  private closing = false;
  // The in-flight recovery re-dial's connect() (settled either way), or undefined
  // when none is running. end() awaits it before tearing down the shared
  // Ssh2SftpClient so a re-dial's connect() -- a fresh handshake -- and end()'s
  // client.end() never run concurrently on the one client (ssh2-sftp-client shares
  // connection-level listeners, so two ops in flight on one client is unsafe). The
  // op that owns the re-dial can be abandoned before it completes: core's per-op
  // peerTimeoutMs budget (a Promise.race) rejects a stalled op to the caller while
  // the adapter op keeps running, so the caller can reach close() -> end() while
  // the abandoned op is still mid-re-dial. Bounded: connect() is finite (its own
  // retry budget and readyTimeout), so the await cannot hang teardown.
  private redialInFlight: Promise<void> | undefined;
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
  // drive the operator warn cadence (SFTP_REDIAL_WARN_INTERVAL) and the
  // end-of-run summary's mid-exchange sub-count (midExchangeReconnectCount). A
  // plain operational counter, never a partner-controlled value.
  private midExchangeRedials = 0;
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
   * attempt). A plain operational counter, never a partner-controlled value.
   */
  get reconnectCount(): number {
    return this.reconnectAttempts;
  }

  /**
   * The subset of {@link reconnectCount} that were mid-exchange session-recovery
   * re-dials -- a server dropping the one long-lived session mid-exchange, which
   * the adapter transparently re-dialed and re-issued the interrupted operation
   * on. Surfaced apart from the merged reconnect total so the end-of-run summary
   * can distinguish chronic mid-exchange drops from benign connect-time retries.
   * A plain operational counter, never a partner-controlled value.
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
  // re-issues the op ONCE before giving up. This is the interim robustness floor
  // under the persistent-session model: an SFTP server that enforces a
  // max-session or idle cap the operator cannot change drops the one long-lived
  // session mid-exchange (observed at ~10 min), after which the next op fails
  // terminally and the exchange aborts. Recovery makes that drop transparent by
  // re-dialing (reusing the pinned host key and stored credentials, no re-prompt)
  // and re-running the operation.
  //
  // ONE round per op invocation, never a loop: if the re-issued op ALSO hits a
  // clean loss it rejects terminally. There is deliberately no cumulative/lifetime
  // reconnect cap -- each op invocation earns a fresh round -- because a partner
  // that drops the session every ~10 min over a multi-hour exchange would exhaust
  // any lifetime cap and defeat the whole feature. The op+re-dial is enclosed by
  // boundTransport's per-op peerTimeoutMs budget in core (a Promise.race), which
  // is the terminal ceiling against a pathological instant-drop server, so no
  // bespoke total-time timer is added here. Serial op issuance (single-party
  // appliance) guarantees no other tracked() op is in flight when the re-dial
  // runs: the first attempt's promise has already settled by the time this catch
  // fires, so connect()'s heartbeat re-arm never races a live op.
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
    return op().catch(async (error: unknown) => {
      if (!this.shouldRecoverFromSessionLoss(error)) throw error;
      await this.redialForRecovery();
      // end() may have latched `closing` while the re-dial was in flight: close
      // the freshly-dialed session so it does not outlive the teardown, and
      // surface the original loss rather than re-issuing into a closing adapter.
      if (this.closing) {
        await this.end().catch(() => {});
        throw error;
      }
      // The re-dial re-established the dropped session: count it as a reconnection
      // so the operator's metrics show the exchange survived a server-side drop.
      // connect()'s own counter only bumps on an internal retry past the first, so
      // a re-dial that succeeds on its first attempt registers zero without this.
      this.reconnectAttempts += 1;
      this.midExchangeRedials += 1;
      this.warnSessionRecovered();
      return reissue(op);
    });
  }

  // Surface a transparently-recovered mid-exchange session drop to the operator at
  // default verbosity: silent recovery would hide a partner whose SFTP server
  // chronically caps session lifetime, exactly the case this feature exists for.
  // Warn on the FIRST re-dial, then only every SFTP_REDIAL_WARN_INTERVAL-th, so a
  // chronic capper stays visible without a warn line every poll cycle. Each message
  // reassures that the drop was recovered and the exchange continues, names the
  // likely cause (a partner-side session-duration or idle limit the operator
  // cannot change), and gives guidance honest about the current model: because one
  // SFTP session is held open for the WHOLE exchange, a hard session-duration cap
  // recurs regardless of settings and only the planned connection-per-poll mode
  // fixes it, while a longer poll interval helps solely when the server is reacting
  // to how often this exchange queries it. Nothing beyond that is disclosed.
  private warnSessionRecovered(): void {
    const count = this.midExchangeRedials;
    if (count !== 1 && count % SFTP_REDIAL_WARN_INTERVAL !== 0) return;
    if (count === 1) {
      this.log.warn(
        "The SFTP session dropped mid-exchange and was transparently " +
          "re-dialed; the exchange continues. This is typically the partner's " +
          "SFTP server enforcing a session-duration or idle limit you cannot " +
          "change. psilink holds one SFTP session open for the whole exchange, " +
          "so a hard session-duration cap will keep recurring regardless of your " +
          "settings; the planned connection-per-poll mode, which avoids holding " +
          "one session across the whole exchange, is the real fix for that case. " +
          "A longer poll interval (--polling-frequency) helps only if the server " +
          "is instead reacting to how often this exchange queries it.",
      );
      return;
    }
    this.log.warn(
      `The SFTP session has now dropped and been transparently re-dialed ` +
        `${count} times this exchange; each drop was recovered and the exchange ` +
        `continues. The partner's server appears to be enforcing an aggressive ` +
        `session-duration or idle limit, which you cannot change. Because psilink ` +
        `holds one SFTP session open for the whole exchange, this will keep ` +
        `recurring regardless of your settings until the planned ` +
        `connection-per-poll mode lands; a longer poll interval ` +
        `(--polling-frequency) helps only if the server is reacting to how often ` +
        `this exchange queries it.`,
    );
  }

  // Decide whether an op rejection is the CLEAN session loss recovery re-dials on.
  // Every condition is post-state, not error-message matching: ssh2-sftp-client
  // clears its `sftp` session property on a clean close/end (its temp-op and
  // global 'close'/'end' listeners both null it), so a cleared property is the
  // reliable signal that the session dropped -- unifying the adapter's own
  // `!sftp` throw in list()/createExclusive() with ssh2-sftp-client's
  // ERR_NOT_CONNECTED ("No SFTP connection available") rejection on the high-level
  // get/put/delete/rename/exists. Terminal (never re-dialed), in order:
  //   - no connect has succeeded yet (nothing to re-dial with);
  //   - the session is still live (a stall or app-level failure, not a loss);
  //   - a fatal SFTP protocol error killed the session (the wrapper is destroyed
  //     and cannot recover -- fatalSftpError, deadSessionError());
  //   - a liveness stall (TransportOperationStalledError): re-dialing on a stall
  //     would hand a withholding server a free liveness reset, so a timeout is
  //     never a reconnect trigger;
  //   - a memory bound (FrameSizeExceededError / DirectoryListingBoundsError).
  // A host-key mismatch on the re-dial is terminal for free: it surfaces inside
  // redialForRecovery -> connect(), whose retry predicate already treats "Host
  // denied" as terminal, so the rejection propagates rather than being re-issued.
  private shouldRecoverFromSessionLoss(error: unknown): boolean {
    if (this.closing) return false;
    if (this.originalConnectOptions === undefined) return false;
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (sftp) return false;
    if (this.fatalSftpError !== undefined) return false;
    if (error instanceof TransportOperationStalledError) return false;
    if (error instanceof FrameSizeExceededError) return false;
    if (error instanceof DirectoryListingBoundsError) return false;
    return true;
  }

  // Re-dial the dropped session by re-invoking connect() verbatim with the full
  // original options. It must go through connect(), never a bare
  // client.connect(): connect() re-runs the whole post-connect sequence on the
  // FRESH wrapper -- re-attaches the guarded fatal-'error' listener (a
  // listener-free wrapper would turn the next malformed packet into a process
  // crash), clears fatalSftpError, re-runs the enforcing fail-closed host-key
  // verifier that rides the options, re-verifies the raw sftp methods, advances
  // the heartbeat epoch, and re-applies setNoDelay/keepalive. The dead client is
  // NOT end()'d first: recovery only runs once this.sftp is already cleared (the
  // shouldRecoverFromSessionLoss gate), so connect()'s "already connected" guard
  // cannot fire, and calling ssh2-sftp-client's end() would latch its endCalled
  // flag, permanently disabling the global 'close' listener that clears this.sftp
  // -- which would stop a LATER idle drop from being detected and defeat recovery
  // of the repeated drops this targets.
  private redialForRecovery(): Promise<void> {
    if (this.originalConnectOptions === undefined)
      throw new Error(
        "SFTP session recovery reached the re-dial with no retained connect " +
          "options; a server-driven operation ran before connect()",
      );
    // Stop the heartbeat left armed by the dropped session before re-dialing: a
    // clean drop (unlike a fatal error) does not stop it, so its old timer could
    // otherwise tick mid-handshake and post a realPath keepalive on the client
    // while connect() re-establishes it -- a concurrent op. connect() re-arms a
    // fresh heartbeat via start() at the end of its sequence.
    this.heartbeat.stop();
    const redial = this.connect(this.originalConnectOptions);
    // Publish the re-dial (settled either way) so a concurrent end() serializes
    // its client.end() behind it; clear the handle once this same re-dial settles
    // so a later end() is never held by a stale one.
    const tracked = redial.then(
      () => {},
      () => {},
    );
    this.redialInFlight = tracked;
    void tracked.finally(() => {
      if (this.redialInFlight === tracked) this.redialInFlight = undefined;
    });
    return redial;
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

  async connect(options: Record<string, unknown>): Promise<void> {
    this.originalConnectOptions = options;
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
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
      // Host-key verification failure is terminal: the server is actively
      // presenting a different or unknown key, so retrying the key exchange
      // against the same server changes nothing. ssh2's "Host denied
      // (verification failed)" is wrapped by ssh2-sftp-client as a new Error
      // with the same message (prefixed with the listener context); match on the
      // stable message fragment from kex.js rather than a code that is not set
      // on the error object.
      (err) => !(err instanceof Error && err.message.includes("Host denied")),
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
    // Attach the guarded fatal-'error' listener to the raw wrapper now, while it
    // is known present and callable, so a malformed server reply can never crash
    // the process. See attachFatalErrorListener for the full rationale and the
    // reconnect/idempotency analysis.
    this.attachFatalErrorListener(sftp);
    // The session is established: arm the keepalive heartbeat so a long idle
    // stretch (a PSI round on the computing side) does not let the server's idle
    // timeout drop it. start() resets the idle clock, so a reconnect re-arms
    // cleanly. It is torn down by end() and by the fatal-'error' guard. Skipped in
    // ephemeral-session mode, where each cycle's session lives only for its op
    // batch (seconds) and is released before the idle gap, so there is no held
    // session to keep warm -- an armed heartbeat would be moot.
    if (!this.ephemeralSessions) this.heartbeat.start();
  }

  async end(): Promise<void> {
    // Mark teardown so an op racing this close cannot trigger a NEW mid-exchange
    // re-dial (see withSessionRecovery).
    this.closing = true;
    // A recovery re-dial may already be mid-handshake on the shared client. Its
    // connect() and this teardown's client.end() must not overlap on the one
    // Ssh2SftpClient, so wait the re-dial out first (bounded by connect()'s own
    // retry/readyTimeout). withSessionRecovery's post-re-dial `closing` check then
    // tears down whatever session it dialed, so none outlives this close.
    await this.redialInFlight;
    // Stop the keepalive before tearing the client down so no beat races the
    // teardown, and so the unref'd timer never lingers past the session.
    this.heartbeat.stop();
    await this.client.end();
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
   * live. Awaits the 'close' so the release is complete before the loop idles;
   * bounded so a pathological withheld local close cannot hang the poll loop.
   */
  async releaseForIdle(): Promise<void> {
    if (!this.ephemeralSessions || this.closing) return;
    // No held session to keep warm across the idle gap.
    this.heartbeat.stop();
    const internals = this.client as unknown as Ssh2SftpClientInternals;
    const rawClient = internals.client;
    if (!internals.sftp || rawClient === undefined) return;
    if (
      typeof rawClient.end !== "function" ||
      typeof rawClient.once !== "function"
    ) {
      // An upgrade relocated the ssh2 Client's end()/once(): hold the session
      // this cycle (correct, just not released) rather than failing the exchange.
      // Re-verify on any ssh2 upgrade per docs/spec/DEPENDENCY_PINS.md.
      this.log.warn(
        "ssh2 client end()/once() unavailable; the ephemeral SFTP session is " +
          "held this cycle instead of released. Check the ssh2 changelog.",
      );
      return;
    }
    const end = rawClient.end.bind(rawClient);
    const once = rawClient.once.bind(rawClient);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, EPHEMERAL_RELEASE_CLOSE_TIMEOUT_MS);
      // The bound is the safety net, not real work: unref'd so it never holds a
      // healthy process open (the deliberately-unref'd SFTP-liveness-timer
      // contract), and cleared the instant 'close' fires.
      timer.unref();
      once("close", () => {
        clearTimeout(timer);
        finish();
      });
      end();
    });
  }

  /**
   * Connection-per-poll cycle-START reconnect (see
   * {@link FileTransportClient.ensureConnected}). Re-establishes the session
   * {@link releaseForIdle} released, reusing the retained full connect options
   * (pinned host key, stored credentials, reconnect bound) with NO re-prompt and
   * NO re-pinning: connect() re-runs the enforcing fail-closed host-key verifier
   * that rides those options, so a server presenting a different key on a re-dial
   * is still rejected. Resolves `true` once a session is live, `false` on a
   * transient dial failure (the caller skips this cycle and retries next tick),
   * and rejects only on a fatal condition (a host-key rejection) that terminates
   * the exchange. A no-op returning `true` when the mode is off, during teardown,
   * or when a session is already live.
   */
  async ensureConnected(): Promise<boolean> {
    if (!this.ephemeralSessions || this.closing) return true;
    // Serialize behind an in-flight recovery re-dial so two connect()s never run
    // on the one shared Ssh2SftpClient (it shares connection-level listeners, so
    // two handshakes at once is unsafe) -- the same guard end() applies.
    await this.redialInFlight;
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    // A concurrent recovery re-dial (e.g. the close() abort-marker write) already
    // reconnected; nothing to do.
    if (sftp) return true;
    if (this.originalConnectOptions === undefined)
      throw new Error(
        "ephemeral SFTP re-dial reached with no retained connect options; a " +
          "poll cycle ran before connect()",
      );
    try {
      await this.connect(this.originalConnectOptions);
      return true;
    } catch (error: unknown) {
      if (this.isFatalDialError(error)) throw error;
      // A transient dial failure (server briefly unreachable, connection refused,
      // auth exhaustion) is not fatal in this mode: report it and let the poll
      // loop skip this cycle and retry on the next tick. The exchange's
      // peer-inactivity ceiling terminates the run if dials keep failing for the
      // whole budget, so an indefinitely-unreachable server still fails loudly.
      this.log.warn(
        "ephemeral SFTP re-dial failed; skipping this poll cycle and retrying " +
          `on the next tick: ${sanitizeErrorForDisplay(error)}`,
      );
      return false;
    }
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
