import PSI from "@openmined/psi.js";

import {
  FileSyncConnection,
  fromEventConnection,
  EncryptedMessageConnection,
  DEFAULT_PEER_TIMEOUT_MS,
  getLogger,
  describeExchangeStages,
  runExchange,
  buildOutputTable,
  authenticateConnection,
  assertSharedSecretReadyForHandshake,
  deriveAbortToken,
  PeerAbortError,
  sanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type {
  Authentication,
  ConnectionConfig,
  PreparedExchange,
  ExchangeBootstrapResult,
} from "@psilink/core";

import { LocalFSClient } from "./connection/localFSClient";
import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { buildRotatedKeyFile, saveKeyFile } from "./keyFile";
import { preflightKeyFilePath } from "./keyFilePreflight";
import { writeExchangeRecord, type RecordOutput } from "./recordFile";
import { writeOutput } from "./util/cli";

/**
 * Operator guidance appended to the file-sync peer-silence timeout error.
 *
 * This is the sender-side residue of board item 195173462: when the peer dies
 * mid-exchange -- the canonical case being its exchange directory going
 * read-only so it can never write its next message or ack -- the receiver names
 * its own cause locally (`asConnectionError`), but the remote sender only
 * observes the inactivity deadline and would otherwise fail with a bare "peer
 * went silent". The authenticated cross-party abort marker
 * (`<id>-abort.json`, armed below post-handshake) now upgrades this hedge to a
 * definitive {@link PeerAbortError} for the failure modes where the failing
 * party's directory is still writable. It cannot cover the headline mode (an
 * unwritable directory is exactly what stops the peer from writing any marker)
 * or a hard kill, and a best-effort write can be lost, so this guidance remains
 * the floor whenever no valid marker is present -- absence stays strictly
 * uninformative. The marker carries no cause, so this text still surfaces the
 * likely receiver-side causes and points at the peer's own logs, where the real
 * cause was recorded, rather than overclaiming a specific one. The wording
 * deliberately hedges ("may have") and notes the slow-peer case so the operator
 * is not misdirected. See docs/spec/FILE_SYNC.md ("Sender-side peer-silence
 * attribution").
 */
export const PEER_SILENCE_GUIDANCE =
  "The peer completed the rendezvous but has sent nothing since. The likely " +
  "cause is on the peer's side: its process may have exited, or its exchange " +
  "directory may have become unwritable (for example a read-only or full " +
  "filesystem, or revoked permissions) -- and a peer that cannot write its " +
  "next message also cannot record why, so this side cannot name the cause. " +
  "Check the peer's own logs for the underlying error. If the peer is instead " +
  "still working on a large dataset, raise the peer timeout (--peer-timeout).";

/**
 * CLI-layer extension of {@link Authentication} that co-locates the path where
 * the rotated shared secret is persisted after each successful key exchange.
 * Passed to {@link runProtocol} on its own `auth` parameter, separate from the
 * connection config (the shared secret is a channel-agnostic partner-trust
 * concern, no longer embedded in the connection).
 *
 * `sharedSecret` is narrowed from optional in {@link Authentication} to required
 * here: every authenticated exchange must supply a valid token before the
 * connection is opened.
 */
export interface AuthPersist extends Authentication {
  sharedSecret: string;
  keyFilePath: string;
}

/**
 * The connection configs {@link runProtocol} can run: the `sftp` and `filedrop`
 * channels. `Extract` narrows {@link ConnectionConfig} to those channels so
 * passing a WebRTC config requires an explicit `as unknown as` cast and cannot
 * happen by accident. Authentication is no longer part of the connection union
 * (it is a top-level spec block); `runProtocol` takes it on a separate `auth`
 * parameter, so this type is just the channel-narrowed connection with no
 * `Omit`/`null` machinery.
 */
export type ProtocolConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

/**
 * CLI-only, non-persistable runtime controls for the file-sync transport's entry
 * sweep, threaded straight to the {@link FileSyncConnection} constructor. They
 * are deliberately NOT part of {@link ProtocolConnectionConfig} / FileSyncOptions
 * / the Zod config schema: anything there is persistable in psilink.yaml, which
 * contradicts "invocation-scoped, never persisted". The CLI command layer
 * resolves these from argv and passes them here on a path separate from config
 * construction (applyConnectionOverrides).
 */
export interface FileSyncRuntimeOptions {
  /** `--sweep-exchange-files`: clear protocol files at entry (see FILE_SYNC.md). */
  sweepExchangeFiles?: boolean;
  /** `--force-retain-sweep`: permit the sweep to wipe a retain-mode transcript. */
  forceRetainSweep?: boolean;
}

/** The value {@link runProtocol} resolves with. */
export interface RunProtocolResult {
  /**
   * Outcome of the zero-setup `--save` bootstrap, forwarded from
   * {@link runExchange}. Defined whenever `saveIntent` is a boolean -- including
   * `false`, where it carries `partnerSaveIntent` with `sharedSecret` undefined,
   * which the caller needs to drive its no-save notice. `undefined` only when
   * `saveIntent` was `undefined` (every authenticated exchange) or when the run
   * is short-circuited by a signal (the interrupt path returns `{}`). The
   * zero-setup caller relies on this: it passes the raw `--save` boolean so a
   * non-saving party still receives a defined result, and reads `undefined` as
   * "interrupted, do nothing" -- see the guard in the zeroSetup handler. Do not
   * collapse a `false` saveIntent to `undefined`; that would silently suppress
   * the no-save notices.
   */
  bootstrap?: ExchangeBootstrapResult;
  /**
   * The error thrown or rejected by `onAuthenticated`, when the post-handshake
   * hook failed but the run otherwise resolved. The hook is non-fatal, so its
   * failure does not stop the exchange; this field reports it so the caller can
   * correct its own messaging (the online invite/accept callers read it to avoid
   * claiming the config was saved when the hook's `saveConfig` actually failed).
   * The error itself was already logged at error level by {@link runProtocol}.
   * `undefined` when no hook was passed or the hook succeeded. On a
   * signal-interrupted run the value is preserved as recorded: it carries the
   * hook error if the hook had already failed before the signal arrived, and is
   * `undefined` otherwise. When the hook failed AND the exchange then also
   * failed, `runProtocol` rejects with the exchange error and this field is
   * never observed.
   */
  onAuthenticatedError?: unknown;
}

/**
 * Runs the PSI protocol over an SFTP or file-drop connection and writes
 * results to output. Authentication is supplied on the separate `auth`
 * parameter, not embedded in `connection`.
 *
 * When `auth` is an {@link AuthPersist}, `keyFilePath` must be a non-empty,
 * non-whitespace string; this is checked before any connection is opened so
 * that a whitespace-only path does not silently create a file named " " in
 * the current directory. `sharedSecret` is validated by {@link authenticateConnection}
 * after the connection opens. `keyFilePath` is checked for non-emptiness only
 * — invalid paths are caught with a clear OS error at the key-file write step.
 *
 * When `auth` is `null` the exchange runs without authentication; this is the
 * path taken by callers (e.g. zero-setup) that explicitly acknowledge relying
 * on transport-layer security only. The parameter has no `undefined` state, so
 * every caller makes the authentication choice explicit: `AuthPersist` to
 * authenticate, `null` to opt out. There is no library "fall through with a
 * warning" branch -- the only consumers of `runProtocol` are the CLI commands,
 * and both produce one of the two values.
 *
 * When `recordOutput` is provided, the self-attested exchange record and its
 * private opening data are written after the results (non-fatal on failure; see
 * {@link writeExchangeRecord}). Pass `undefined` to skip recording.
 *
 * `saveIntent` carries this party's zero-setup `--save` intent into the
 * exchange's in-band bootstrap (see {@link runExchange}). Pass `undefined`
 * (the default) on every authenticated path; pass a boolean only from the
 * zero-setup command, which then reads {@link RunProtocolResult.bootstrap} to
 * provision the saved config/key. It is only meaningful with `auth: null`.
 *
 * `onAuthenticated` is an optional post-handshake hook invoked exactly once, on
 * the authenticated path only, after the rotated token is saved to the key file
 * and before the data exchange begins -- i.e. at the moment of acceptance. The
 * online invite/accept callers persist their configuration here, so a handshake
 * that succeeds but whose exchange then fails leaves both the rotated key and
 * the config on disk. A handshake that never succeeds (declined, expired, or
 * unreachable partner) never reaches the hook. The hook may be synchronous or
 * async; it is awaited, so a returned promise is settled before the exchange
 * begins. A failure from the hook -- a synchronous throw or a rejected promise
 * -- is non-fatal: it is logged at error level (so it survives
 * `--log-level=error`) and the exchange still runs, because the data exchange is
 * the irreplaceable two-party operation and must not be aborted by a failure to
 * persist the recoverable config. The failure is also reported in
 * {@link RunProtocolResult.onAuthenticatedError} so the caller can correct its
 * own messaging. Pass `undefined` (the default) on the no-auth path and from
 * callers that need no post-handshake step (zero-setup, exchange); passing a
 * hook with `auth: null` is rejected up front, since an unauthenticated
 * exchange has no acceptance step to hook.
 *
 * `fileSyncRuntime` carries the CLI-only, non-persistable file-sync entry-sweep
 * controls (`--sweep-exchange-files` / `--force-retain-sweep`) straight to the
 * {@link FileSyncConnection} constructor, bypassing config construction so they
 * can never be persisted to psilink.yaml. Defaults to `{}` (no sweep) and is
 * inert on any non-file-sync transport.
 */
export async function runProtocol(
  connection: ProtocolConnectionConfig,
  auth: AuthPersist | null,
  prepared: PreparedExchange,
  output: string | undefined,
  verbosity: number,
  loggerName: string,
  recordOutput?: RecordOutput,
  saveIntent?: boolean,
  onAuthenticated?: () => void | Promise<void>,
  fileSyncRuntime: FileSyncRuntimeOptions = {},
): Promise<RunProtocolResult> {
  const log = getLogger(loggerName);

  if (connection.channel !== "filedrop" && connection.channel !== "sftp")
    // Inside this branch `connection` narrows to `never`; cast through unknown
    // to recover the channel name for the error message. This branch is only
    // reached when the caller bypasses the type system with `as unknown as`.
    throw new Error(
      `unsupported channel: ` +
        (connection as unknown as { channel: string }).channel,
    );

  // saveIntent drives the zero-setup `--save` bootstrap, which exists only on
  // the unauthenticated path: an authenticated exchange already has a persistent
  // key and no provisioning step to consume a bootstrap result, so a stray
  // saveIntent here would advertise a save field (and possibly transmit a secret
  // frame) inside the authenticated channel with nothing reading it back. Reject
  // the combination rather than leave the footgun open to a future caller; the
  // type docs already mark saveIntent as meaningful only with `auth: null`, and
  // both current callers honor that.
  if (auth && saveIntent !== undefined)
    throw new Error(
      "saveIntent is only valid on an unauthenticated (zero-setup) exchange; " +
        "an authenticated exchange must not pass it",
    );
  // The mirror constraint: onAuthenticated hooks the moment of acceptance, which
  // exists only on the authenticated path -- its invocation below is nested in
  // `if (auth)`. Reject a hook supplied with `auth: null` up front rather than
  // silently dropping it, so a future caller that wires a hook to a zero-setup
  // exchange gets a clear error instead of a persistence step that never runs.
  if (!auth && onAuthenticated !== undefined)
    throw new Error(
      "onAuthenticated is only valid on an authenticated exchange; an " +
        "unauthenticated (zero-setup) exchange has no acceptance step to hook",
    );
  // Captured in the outer scope so the post-handshake saveKeyFile call below
  // can reuse the trimmed value without re-reading auth.keyFilePath.
  let trimmedKeyFilePath: string | undefined;
  if (auth) {
    // Fail fast on the locally-knowable secret preconditions -- a malformed or
    // already-expired shared secret -- BEFORE opening any connection. Both are
    // determinable without a peer, and deferring them to authenticateConnection
    // (which runs only after the connection is open) would let a dead credential
    // first drive the file-sync rendezvous, whose losing side can then surface a
    // misleading "peer abandoned the handshake; retry" hint for what is really an
    // expired or malformed secret. Running the same tagged check here keeps both
    // parties' failure deterministic and correctly hinted, with no rendezvous
    // I/O. authenticateConnection still runs it (and the post-handshake expiry
    // check) as the authoritative boundary for library consumers that bypass
    // runProtocol. The shared check carries psilinkRecoveryHintEmitted, so the
    // catch block below suppresses its generic advisory.
    assertSharedSecretReadyForHandshake(auth);
    // Validate and trim the key-file path before any connection is opened, so a
    // misconfiguration fails here -- with no rendezvous I/O and before the
    // partner can be left holding a rotated token this side cannot persist --
    // rather than at saveKeyFile post-handshake. Returns the trimmed path, which
    // the saveKeyFile call below reuses without re-reading the caller's auth.
    trimmedKeyFilePath = preflightKeyFilePath(auth.keyFilePath, log);
  }
  const client =
    connection.channel === "filedrop"
      ? new LocalFSClient()
      : new SSH2SFTPClientAdapter({ verbosity });
  // CLI-only sweep controls are passed straight to the constructor (the
  // verbose/joinerRecoveryMs precedent), never through config.options, so they
  // cannot be persisted to psilink.yaml. Spread conditionally so an unset value
  // does not clobber the constructor default.
  const conn = new FileSyncConnection(client, {
    verbose: verbosity,
    ...(fileSyncRuntime.sweepExchangeFiles !== undefined && {
      sweepExchangeFiles: fileSyncRuntime.sweepExchangeFiles,
    }),
    ...(fileSyncRuntime.forceRetainSweep !== undefined && {
      forceRetainSweep: fileSyncRuntime.forceRetainSweep,
    }),
  });

  // The PSI protocol layer (authenticateConnection / runExchange) consumes the
  // pull-based MessageConnection interface. Bridge the event-based
  // FileSyncConnection through fromEventConnection so its data/error events are
  // delivered to awaited receive() calls with no per-phase listener gap. The
  // bridge bounds a parked receive() by the peer-inactivity budget: if the peer
  // stays silent past this window the exchange fails as a transport error
  // rather than hanging. peerTimeoutMs (when configured) overrides the default;
  // the same value bounds the file-sync rendezvous TTL inside conn.open().
  const peerBudgetMs =
    connection.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
  // inactivityHint enriches the generic peer-silence error with file-sync
  // operator guidance: the receiver names its own cause locally, but the sender
  // only sees the inactivity timeout, so it points at the likely receiver-side
  // causes and the peer's own logs (see PEER_SILENCE_GUIDANCE).
  const mc = fromEventConnection(conn, {
    inactivityTimeoutMs: peerBudgetMs,
    inactivityHint: PEER_SILENCE_GUIDANCE,
  });

  // SIGINT/SIGTERM handlers and the finally block share this closure so that
  // stop/cleanup/close run at most once regardless of which path gets there
  // first. The cleaned guard is the re-entry lock; signal handlers are
  // deregistered only after the async operations complete so that a signal
  // arriving mid-cleanup still has a handler (which returns immediately via the
  // guard and then calls process.exit) rather than triggering Node's default
  // signal behavior (immediate process termination without any code running).
  // All three are function declarations so they can reference each other freely
  // without intermediate let-undefined variables.
  //
  // No conn.on("error", ...) listener is installed at this layer. Synchronous
  // transport failures (open/synchronize) throw directly; asynchronous poll()
  // errors are observed by the permanent data/error listeners that the
  // fromEventConnection bridge attaches for the connection's whole lifetime
  // (mc, above), which surface on the protocol layer's awaited receive() calls.
  let cleaned = false;
  let opened = false;
  let started = false;
  // The AEAD decorator that wraps `mc` when the handshake negotiates encryption.
  // Declared in the outer scope so doCleanup can close it; left undefined
  // whenever no wrap is applied -- the no-auth path (no session key) and the
  // authenticated path where the negotiated applyEncryption is false -- in which
  // case the exchange runs over the unencrypted `mc`. secure.close() delegates to
  // mc.close(), so closing it closes the underlying FileSyncConnection and sweeps
  // its responsible files.
  let secure: EncryptedMessageConnection | undefined;
  // Set synchronously immediately before `await authenticateConnection`.
  // The partner can complete its own handshake and persist the rotated token
  // before our await resolves, so any failure that arrives after this flag is
  // set leaves us potentially out of sync with the partner even if our own
  // `saveKeyFile` never ran. `tokenRotated` is the stricter signal: it is true
  // only after our own save succeeds.
  let authStarted = false;
  let tokenRotated = false;
  // Set synchronously at the top of a signal handler before any await, so the
  // catch block below can detect that an in-flight failure was caused by the
  // signal-driven cleanup (rather than an organic protocol error) and yield
  // the exit code to the signal handler — preventing the CLI handler's
  // process.exit(69) from racing the signal handler's process.exit(130/143).
  let signalReceived: NodeJS.Signals | undefined;
  async function doCleanup() {
    if (cleaned) return;
    cleaned = true;
    // Seal the abort decision before the first layer-close drives the real
    // conn.close() cascade (secure.close() -> mc.close() -> conn.close()). On the
    // clean-completion, signal, and echo paths no writeAbortMarker() ran, so
    // without this seal conn.close() would park on its backstop grace and block
    // teardown for the full grace window. A catch-path writeAbortMarker() (if it
    // ran) already pre-empted this, making the seal a no-op. It is a pure
    // synchronous one-shot with no transport dependency, so hoisting it to the
    // top is safe; it is also a no-op on the unauthenticated path (never armed).
    conn.sealAbort();
    if (started) log.info("stopping polling");
    if (opened) log.info("closing connection");
    // When the AEAD decorator was built (encryption negotiated), close it: its
    // close() delegates to mc.close(), which detaches the bridge's data/error
    // listeners and closes the underlying FileSyncConnection. secure is undefined
    // whenever no wrap was applied -- the no-auth path, the authenticated path
    // where applyEncryption is false, and the window where a signal arrived
    // between authenticateConnection returning and create resolving -- and the
    // mc.close() below then closes the transport directly. All of these are
    // idempotent.
    if (secure !== undefined) {
      await secure.close().catch((err: unknown) => {
        log.debug(
          "secure.close() during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      });
    }
    // mc.close() detaches the bridge's data/error listeners and then closes the
    // underlying FileSyncConnection, which stops the poller, sweeps the
    // responsible files, and ends the client (all idempotent, so this is safe
    // even when open() never ran, and a near no-op after secure.close() already
    // closed it via the same delegation).
    await mc.close().catch((err: unknown) => {
      log.debug("mc.close() during cleanup:", sanitizeErrorForDisplay(err));
    });
    // If an earlier transport failure already terminated mc, its close()
    // returns immediately without re-closing conn (and the close it triggered
    // on failure was fire-and-forget, hence unawaited). Close conn directly to
    // guarantee the poller is stopped, the responsible files are swept, and the
    // client is ended before doCleanup returns. close() is idempotent, so in
    // the normal path this is a near no-op after mc.close() already closed it.
    await conn.close().catch((err: unknown) => {
      // When the connection was open, a close failure is user-visible: the
      // transport may not have terminated cleanly (e.g. SSH session timeout).
      // close() is idempotent and does not throw on an unopened instance, so
      // the else branch is only a defensive fallback for an unexpected error.
      if (opened) {
        log.warn(
          "failed to close connection during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      } else {
        log.debug("conn.close() during cleanup:", sanitizeErrorForDisplay(err));
      }
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Undo our own contribution to the max-listeners threshold rather than
    // decrementing from whatever it is now. If another module (or a parallel
    // runProtocol) mutated the threshold in between, decrementing from the
    // current value would walk the baseline off by ±2 each cleanup cycle.
    // We restore the captured value verbatim, which leaves any external
    // adjustment intact and undoes only our own +2.
    if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners);
  }
  // The try/catch/finally in each handler ensures process.exit is always called
  // and that a rejection from doCleanup (possible if future modifications add an
  // un-caught throw) never surfaces as an unhandled promise rejection — which
  // process.on("SIGINT") would otherwise silently discard.
  // Three states share one message helper so SIGINT, SIGTERM, and the catch
  // block stay consistent:
  // - tokenRotated: our saveKeyFile completed; the partner also derived the
  //   same new token but their save status is unknown.
  // - authStarted && !tokenRotated: the key exchange may have completed on either side;
  //   the partner may have persisted a rotated token even though we did not.
  // - !authStarted: handshake never began; the existing token is still valid.
  function logRotationStateOnInterrupt(reason: string): void {
    if (tokenRotated) {
      log.warn(
        `The shared secret was already rotated and saved before ${reason}. ` +
          "Retry without re-inviting; if authentication fails on retry, " +
          "both parties must re-invite.",
      );
    } else if (authStarted) {
      log.warn(
        `The key exchange was in progress when ${reason}. Depending on ` +
          "how far the handshake had progressed, the partner may have " +
          "already completed it and saved the rotated token even though " +
          "this side did not. Retry the exchange with the existing key " +
          "file; if authentication fails on retry, both parties must " +
          "re-invite.",
      );
    }
  }
  async function onSigint(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    signalReceived = "SIGINT";
    try {
      log.info("caught SIGINT, exiting");
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug("onSigint cleanup threw:", sanitizeErrorForDisplay(cleanupErr));
    } finally {
      // 128 + 2 (SIGINT): conventional exit code for a process interrupted
      // by SIGINT, distinguishable from a clean exit (0) or an error (69).
      process.exit(130);
    }
  }
  async function onSigterm(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    signalReceived = "SIGTERM";
    try {
      log.info("caught SIGTERM, exiting");
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "onSigterm cleanup threw:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    } finally {
      // 128 + 15 (SIGTERM): conventional exit code for a process terminated by
      // SIGTERM, distinguishable from a clean exit (0) or an error exit (69).
      process.exit(143);
    }
  }

  // Each runProtocol call adds two process-level listeners (SIGINT + SIGTERM).
  // Increment the max-listener threshold for the duration of this call so
  // that concurrent invocations (e.g., two-party integration tests) do not
  // trigger the MaxListenersExceededWarning. doCleanup restores the captured
  // baseline so any concurrent module that adjusts the threshold separately
  // is not disturbed by our increment/decrement asymmetry.
  // 0 means "unlimited"; leave it unchanged in that case.
  const prevMaxListeners = process.getMaxListeners();
  const maxListenersIncremented = prevMaxListeners !== 0;
  if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners + 2);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // Captures a failure from the optional post-handshake hook (onAuthenticated).
  // The hook is non-fatal, so a failure here does not stop the exchange; it is
  // surfaced in the resolved result (onAuthenticatedError) so the caller can
  // correct its own messaging rather than report a config that was never saved.
  let onAuthenticatedError: unknown;

  try {
    if (connection.channel === "filedrop") {
      log.info(
        "opening local path",
        // The filedrop path is partner-seeded on an offline-accept config (it
        // comes from the invitation's filedrop endpoint, charset-unconstrained),
        // so escape it before it reaches the operator's terminal -- the filedrop
        // twin of the SFTP host below.
        sanitizeForDisplay(connection.path),
      );
    } else {
      log.info(
        "opening connection to",
        // The SFTP host is partner-controlled on an offline-accept-seeded config
        // (it comes from the invitation endpoint, charset-unconstrained), so
        // escape it before it reaches the operator's terminal.
        sanitizeForDisplay(connection.server.host),
        "with options",
        connection.options,
      );
    }
    // Authentication is no longer embedded in the connection config, so the
    // connection is the open() argument type directly (sftp | filedrop) -- no
    // destructure or cast needed.
    await conn.open(connection);
    opened = true;

    // If a signal fired while `conn.open()` was awaiting, the signal handler
    // already ran doCleanup — including a conn.close() that no-op'd because
    // `connected` was still false at that moment. Now that open() has
    // resolved (`connected === true`), close the freshly-opened connection
    // explicitly and short-circuit so the catch's signalReceived branch
    // resolves runProtocol cleanly. Without this, the connection would
    // remain open until process termination, which is a non-issue in
    // production (process.exit follows the handler) but leaks state in
    // tests that mock process.exit.
    if (signalReceived !== undefined) {
      try {
        await conn.close();
      } catch (err) {
        log.debug(
          "post-open signal close failed:",
          sanitizeErrorForDisplay(err),
        );
      }
      throw new Error(
        `interrupted by ${signalReceived} during connection open`,
      );
    }

    log.info("synchronizing");
    await conn.synchronize();

    // If a signal fired during the synchronize() round-trip, doCleanup already
    // ran (closing the connection and removing our hello/lock files). Bail
    // out before start() so the poller is not launched against a closed
    // transport. Without this, conn.start() would schedule polls that fail
    // when they hit the closed underlying client, producing spurious error
    // logs even though the signal handler is already on its way to exit.
    // The corresponding check after open() handles the open/synchronize
    // window; this one handles the synchronize/start window.
    if (signalReceived !== undefined) {
      throw new Error(
        `interrupted by ${signalReceived} during synchronization`,
      );
    }

    const role = conn.handshakeRole;
    // Invariant: synchronize() throws on all failure paths, so role is always
    // defined when synchronize() returns normally.
    if (role === undefined)
      throw new Error(
        "connection did not establish a handshake role after synchronization",
      );

    if (role === "responder") {
      log.info("arrived first - will wait for message");
    } else {
      log.info("arrived second - will send first message");
    }

    log.info("starting polling");
    conn.start();
    started = true;

    if (auth) {
      log.info("authenticating");
      // conn.start() must precede authenticateConnection: the key exchange
      // awaits mc.receive(), which is fed by the bridge's data listener; that
      // listener only sees inbound frames once the polling loop is running.
      // Discard the (possibly whitespace-padded) keyFilePath from auth;
      // saveKeyFile below uses trimmedKeyFilePath, which was captured and
      // trimmed during pre-flight without mutating the caller-supplied
      // auth object.
      const { keyFilePath: _ignored, ...authParams } = auth;
      // trimmedKeyFilePath is set whenever auth is set; they are populated
      // together in the pre-flight branch above.
      const keyFilePath = trimmedKeyFilePath!;
      // Set synchronously before the await so a signal arriving during the
      // key-exchange round-trip or before saveKeyFile runs can distinguish the
      // "handshake may have completed on the partner side" case from the
      // "handshake never started" case.
      authStarted = true;
      // sessionKey is the 32-byte session key; both parties derive the
      // same value. It keys the per-direction AEAD encryption set up below, so
      // every PSI frame after this point is opaque on the wire to an SFTP/
      // file-drop admin. rotatedSecret is the new shared secret persisted to disk.
      // requestEncryption is true unconditionally here: this code path serves
      // only the file-sync channels (sftp, filedrop), whose server admin can
      // snoop the transport, so the application-encryption layer always applies.
      // applyEncryption is the negotiated OR decision both parties agree on; it
      // gates the EncryptedMessageConnection wrap below.
      const { rotatedSecret, sessionKey, applyEncryption } =
        await authenticateConnection(mc, authParams, role, true);
      // buildRotatedKeyFile stamps `expires` = now + tokenMaxAgeDays days when the
      // operator set a max-age policy, and omits it otherwise. The stamp is
      // computed here, at the moment of rotation, so it reflects the real rotation
      // time rather than config-parse time. It is built BEFORE the try/catch below
      // so its input-validation guard (a non-positive or non-integer
      // tokenMaxAgeDays -- reachable only by a caller bypassing the config schema)
      // propagates as the UsageError it is (exit 64, bad input) rather than being
      // caught and re-wrapped as a "could not be saved" transport-style failure
      // (exit 69).
      const rotatedKeyFile = buildRotatedKeyFile(
        rotatedSecret,
        auth.tokenMaxAgeDays,
        Date.now(),
      );
      try {
        // saveKeyFile is synchronous; the assignment below runs in the same
        // microtask tick. A signal cannot interleave between them, so any
        // signal handler that reads tokenRotated sees either both pre-save
        // state (tokenRotated=false) or both post-save state (tokenRotated
        // =true). Maintain this invariant: do not insert awaits between
        // saveKeyFile and the assignment.
        saveKeyFile(keyFilePath, rotatedKeyFile);
        tokenRotated = true;
      } catch (err) {
        // "may already hold": both parties independently derive rotatedSecret from
        // the session key, but either party's disk write can fail. We
        // cannot know whether the partner's save succeeded, so "may" is
        // intentionally conservative.
        //
        // The wrapped error already contains the full recovery hint specific
        // to this failure mode (definite local rotation, partner unknown).
        // Tag it with the same `psilinkRecoveryHintEmitted` convention that
        // authenticateConnection uses on its own validation errors (see
        // auth.ts); the runProtocol catch below honors the tag and skips its
        // generic authStarted advisory, so the user sees one coherent
        // recovery message rather than two contradictory ones.
        throw Object.assign(
          new Error(
            `authentication succeeded and the shared token was rotated, but ` +
              `the updated token could not be saved to ${keyFilePath}: ` +
              (err instanceof Error ? err.message : String(err)) +
              ` Your partner may already hold the rotated token. ` +
              `To recover, both parties must re-invite to establish a new ` +
              `shared secret.`,
          ),
          { psilinkRecoveryHintEmitted: true },
        );
      }

      // The handshake has succeeded and the rotated token is now persisted to
      // the key file. Fire the optional post-handshake hook here -- exactly at
      // acceptance, after the key save and before the data exchange (and before
      // encryption setup, so the hook's persistence survives even a failure in
      // that setup or an interrupt) -- so a caller (online invite/accept) can
      // persist its configuration at this point. The hook runs only on the
      // authenticated path (the only path with an acceptance) and exactly once.
      // It is awaited (so a sync or async hook both work, and a synchronous
      // throw or a rejected promise are both caught below); the await comes
      // after the saveKeyFile/tokenRotated assignment above, so that pair's
      // no-await invariant is untouched.
      //
      // Unlike the other interruptible awaits, this one has no preceding
      // `signalReceived` guard, by design: the gap since the last guarded await
      // (authenticateConnection) is synchronous -- saveKeyFile plus the
      // tokenRotated assignment -- so no signal can have arrived before we reach
      // the hook. If a signal fires *during* an async hook, letting that write
      // finish is the intended behavior (persist the config at acceptance); the
      // existing signalReceived check after EncryptedMessageConnection.create
      // then bails before the exchange.
      //
      // A failure from the hook is non-fatal: it is logged at error level (so it
      // survives --log-level=error and is never silently lost) and the exchange
      // proceeds. The data exchange is the irreplaceable two-party operation; a
      // failure to persist the recoverable config must not abort it. In the
      // worst case -- the hook write fails and the exchange then also fails --
      // the outcome is no worse than before this hook existed (rotated key on
      // disk, no config); the common case persists the config as intended.
      if (onAuthenticated !== undefined) {
        try {
          await onAuthenticated();
        } catch (hookErr) {
          // The caller distinguishes a hook failure from success by the presence
          // of this value, so it must be truthy even when the hook threw a falsy
          // value (`undefined`, `null`, `0`, `""`, `false`, `NaN`). `undefined`
          // is the success sentinel and the others would slip a downstream
          // truthiness check, so coerce any falsy throw to an Error: a failure
          // can then never masquerade as a clean write regardless of which check
          // the caller uses.
          onAuthenticatedError = hookErr
            ? hookErr
            : new Error(
                "the post-authentication hook threw a falsy value: " +
                  String(hookErr),
              );
          log.error(
            "the post-authentication hook failed after the handshake " +
              "succeeded and the rotated key was saved; the exchange will " +
              "continue, but any persistence the hook performs (e.g. writing " +
              "the configuration) did not complete: " +
              (hookErr instanceof Error ? hookErr.message : String(hookErr)),
          );
        }
      }

      // Wrap mc in the AEAD decorator when the handshake negotiated it, and run
      // the PSI exchange through `secure` so every frame is encrypted on the
      // wire. The wrap is gated on applyEncryption -- the transcript-bound OR of
      // both parties' requests -- rather than on the bare authentication state:
      // file-sync requests it unconditionally (true is passed above), so the
      // observable behavior is unchanged here (an authenticated file-sync
      // exchange always encrypts), while the gate readies the path for a future
      // caller that authenticates over an already-confidential transport and
      // declines the extra layer. create() derives the two per-direction keys via
      // HKDF and registers no listeners on mc, so a signal arriving between
      // authenticateConnection returning and this resolving needs no listener
      // juggling: the handler's doCleanup closes mc/conn directly. If the signal
      // lands before create() resolves, doCleanup runs while secure is still
      // undefined and latches cleaned, so the decorator that create() then
      // assigns to secure is never close()d -- harmless, because mc is already
      // closed and the decorator holds only CryptoKey objects, reclaimed when
      // runProtocol returns. The signalReceived check below mirrors the
      // post-open and post-synchronize guards, bailing before runExchange so the
      // encrypted stream is never started against an already-closed mc; it runs
      // whether or not the wrap was applied, since a signal may also have arrived
      // during the awaited onAuthenticated hook above.
      if (applyEncryption) {
        secure = await EncryptedMessageConnection.create(mc, sessionKey, role);
      }
      if (signalReceived !== undefined) {
        throw new Error(
          `interrupted by ${signalReceived} during channel encryption setup`,
        );
      }

      // Arm the authenticated cross-party abort marker now that the session key
      // is in hand (this is the only path that holds one). Derive this party's
      // token -- written into <myId>-abort.json on a terminal organic fault so a
      // waiting peer fails fast instead of waiting out its full peer-timeout --
      // and the peer's, which an incoming <peerId>-abort.json is verified
      // against. The poller (started above) reads the armed tokens fresh each
      // cycle; no marker exists during the unarmed handshake window, so that gap
      // is benign. Placed after the signal guard so an interrupt during setup
      // bails before arming.
      //
      // Armed unconditionally, including retain mode (not gated on retainFiles).
      // The fast-fail benefits a waiting peer in either mode, and the marker
      // doubles as an audit record that the exchange was aborted. The connection's
      // entry-time leftover-abort sweep is delete-mode only, so a retain-mode
      // fault leaves the marker on disk -- but a retain fault ALREADY leaves a
      // non-clean directory (the partial transcript persists; retain never
      // auto-deletes), so the marker adds no incremental cleanup burden: the
      // operator rotates or --force-retain-sweep clears the directory between
      // retain exchanges regardless. Withholding the marker in retain mode would
      // forfeit the peer fast-fail and the audit record for no cleanliness gain.
      const peerRole = role === "initiator" ? "responder" : "initiator";
      const [selfAbortToken, peerAbortToken] = await Promise.all([
        deriveAbortToken(sessionKey, role),
        deriveAbortToken(sessionKey, peerRole),
      ]);
      conn.armAbort(selfAbortToken, peerAbortToken);
    }

    const stageLabels = Object.fromEntries(
      describeExchangeStages(prepared).map(({ id, label }) => [id, label]),
    );
    const { associationTable, partnerPayload, audit, bootstrap } =
      await runExchange(
        // Encrypted path: `secure` is the AEAD decorator over mc (the handshake
        // negotiated applyEncryption), so PSI frames are encrypted on the wire.
        // Otherwise secure is undefined and the exchange runs over the unencrypted
        // mc (transport security only): the no-auth zero-setup path that carries
        // the --save bootstrap, and the authenticated path where the negotiated
        // applyEncryption is false.
        secure ?? mc,
        role,
        prepared,
        {
          psiLibrary: await PSI(),
          verbosity,
          saveIntent,
          onStage: (id: string) => {
            const label = stageLabels[id] ?? id;
            log.info(label.charAt(0).toLowerCase() + label.slice(1));
          },
          onWarning: (msg: string) => log.warn("terms exchange:", msg),
          onProtocolConfirmed: (partnerTerms, resolvedRole) => {
            // identity is partner-controlled free text with no consistency check
            // (a mutually-distrusting party sets it), so escape it before it
            // reaches the operator's terminal/logs.
            log.info(
              "terms agreed, partner identity:",
              sanitizeForDisplay(partnerTerms.identity),
            );
            log.info("role:", resolvedRole);
          },
        },
      );

    const { headers, rows } = buildOutputTable(
      associationTable,
      prepared.rawRows,
      prepared.metadata,
      partnerPayload,
    );
    writeOutput(output, headers, rows);

    // Persist the self-attested record after the results: it is a secondary
    // audit artifact, so it is written last and its failure is non-fatal (see
    // writeExchangeRecord). Skipped when records are disabled, or when the
    // record could not be built (runExchange returns audit undefined and has
    // already warned -- the exchange still succeeded). The record and its
    // opening are a single optional field, so one check covers both.
    if (recordOutput !== undefined && audit !== undefined)
      writeExchangeRecord(
        recordOutput,
        audit.record,
        audit.opening,
        loggerName,
      );

    // bootstrap is undefined on every authenticated path (saveIntent unset) and
    // populated on the zero-setup --save path; the caller branches on it.
    // onAuthenticatedError is set only when a post-handshake hook failed but the
    // exchange above still succeeded (a hook failure followed by an exchange
    // failure rethrows from the catch below instead of reaching here).
    return { bootstrap, onAuthenticatedError };
  } catch (err) {
    // tokenRotated=true means this party's saveKeyFile succeeded; the partner
    // independently derived the same new token from the session key, but
    // their disk write cannot be verified from here. "Retry without
    // re-inviting" is the correct first step: if the partner also saved, retry
    // succeeds; if their save failed, they received a separate error and the
    // retry will surface a shared-secret mismatch, at which point both parties
    // re-invite. We do not say "both parties hold" (overstates certainty) or
    // "may already hold" (understates - this party definitely saved).
    //
    // authStarted && !tokenRotated handles the looser window: the key exchange may have
    // completed on the partner side even though our own save did not run.
    // Surfaced at error level (rather than warn) because the user's exchange
    // is failing and they need the recovery hint surfaced prominently.
    // The `psilinkRecoveryHintEmitted` tag is set in two places:
    //   - The saveKeyFile-failure path below, because its wrapped error
    //     already explains "definite local rotation, partner unknown".
    //   - authenticateConnection's own validation errors (token format,
    //     pre- and post-handshake expiry — see auth.ts), because their
    //     messages already include specific recovery hints ("must
    //     re-invite" / "obtain a new invitation").
    // Skip the generic advisory in both cases so the user does not see two
    // messages that contradict each other. Key-exchange protocol failures from
    // runKex (generic "key exchange authentication failed" / "key exchange
    // handshake timed out") are NOT tagged and DO get the generic advisory,
    // which adds useful "retry first; if it fails, re-invite" context.
    //
    // The walker follows `cause` so a future wrap (e.g. `new Error('outer: '
    // + inner.message, { cause: inner })`) still suppresses the generic
    // advisory when an inner error already carries the recovery hint. A seen
    // set guards against `cause` cycles in pathological inputs.
    const isHintTagged = (e: unknown): boolean => {
      const seen = new Set<unknown>();
      let cursor: unknown = e;
      while (
        typeof cursor === "object" &&
        cursor !== null &&
        !seen.has(cursor)
      ) {
        seen.add(cursor);
        if (
          (cursor as { psilinkRecoveryHintEmitted?: unknown })
            .psilinkRecoveryHintEmitted === true
        )
          return true;
        cursor = (cursor as { cause?: unknown }).cause;
      }
      return false;
    };
    // Walks the `cause` chain for a PeerAbortError (mirroring isHintTagged), so
    // the echo gate below still recognizes one even behind a future wrap. The
    // load-bearing barrier is actually the sticky first-error latch in the bridge
    // and AEAD layers (a later admin-induced error cannot supersede the
    // PeerAbortError that reaches here); this cause-walk is cheap insurance.
    const errIsPeerAbort = (e: unknown): boolean => {
      const seen = new Set<unknown>();
      let cursor: unknown = e;
      while (
        typeof cursor === "object" &&
        cursor !== null &&
        !seen.has(cursor)
      ) {
        seen.add(cursor);
        if (cursor instanceof PeerAbortError) return true;
        cursor = (cursor as { cause?: unknown }).cause;
      }
      return false;
    };

    const hintAlreadyEmitted = isHintTagged(err);
    if (!hintAlreadyEmitted) {
      if (tokenRotated && onAuthenticatedError === undefined) {
        log.error(
          "The shared secret was already rotated and saved before this error. " +
            "Retry the exchange without re-inviting; if authentication " +
            "fails on retry, both parties must re-invite.",
        );
      } else if (tokenRotated) {
        // The rotated key is on disk, but the post-handshake persistence hook
        // failed (onAuthenticatedError is set), so whatever it would have
        // written -- e.g. the online invite/accept config -- is not on disk. A
        // plain "retry the exchange without re-inviting" is misleading here:
        // `psilink exchange` may have no config to run against. The specific
        // hook failure was already logged at error level when it happened, so
        // emit a corrected advisory rather than the clean-retry one, which would
        // point the user at a recovery path that cannot succeed.
        log.error(
          "The shared secret was rotated and saved, but a post-handshake " +
            "persistence step failed earlier (logged above); resolve that " +
            "before retrying, as the retry may have nothing to run against.",
        );
      } else if (authStarted) {
        log.error(
          "The key exchange was in progress when this error occurred. " +
            "Depending on how far the handshake had progressed, the " +
            "partner may have already completed it and saved the rotated " +
            "token even though this side did not. Retry the exchange " +
            "with the existing key file; if authentication fails on " +
            "retry, both parties must re-invite.",
        );
      }
    }
    // If a signal handler is mid-cleanup, it owns the exit code (130/143).
    // Swallowing the error here resolves runProtocol normally so the CLI
    // handler does not race with its own process.exit(69). The signal
    // handler is still running asynchronously and will call process.exit
    // once its cleanup completes; the event loop stays alive until then
    // because the handler's awaited doCleanup is a pending Promise.
    //
    // The in-flight error may be caused by the signal-driven cleanup itself
    // (e.g. a poller rejecting because the connection was closed) or it may
    // be an unrelated protocol error that happened to coincide with the
    // signal. The two cases are not distinguishable here, so the error is
    // logged at error level rather than discarded silently: if it carries
    // diagnostic information about a real failure, the user sees it even at
    // a strict `--log-level=error` setting; if it is merely cleanup noise,
    // the surrounding "caught SIG..." context makes it clear that the
    // process is exiting on the signal regardless. (Was previously `warn`,
    // which was suppressed by `--log-level=error` and could hide a genuine
    // protocol failure that happened to coincide with shutdown.)
    // Authenticated cross-party abort marker: on a terminal organic fault with
    // the directory still writable, leave a signal so a waiting peer fails fast
    // instead of waiting out its full peer-timeout and then hedging. Gated to
    // fire only on a genuine fault: not on a signal interrupt (Ctrl-C stays
    // clean), and not on a PeerAbortError (the waiting party must not echo a
    // marker back). The await resolves the connection's abort decision to
    // "write", which a teardown close() parked on that decision then awaits, so
    // the marker lands before the shared transport is ended. Best-effort -- a
    // failed write leaves no marker and the peer falls back to the hedge -- and
    // placed before the signalReceived early-return so a fault that coincides
    // with a signal still defers to the signal (the gate's own check skips it).
    //
    // Deliberately fires for EVERY terminal post-arm fault, not only "pure"
    // transport faults: a post-arm UsageError (an over-cap inbound frame, a
    // hostile directory, a stalled server, a duplicate/malformed message) is just
    // as terminal and non-retryable, and a peer is waiting on it, so it benefits
    // from the same fast-fail. Those UsageErrors are peer- or environment-induced,
    // not local misconfiguration -- the config-shaped UsageErrors (token expiry,
    // bilateral mode mismatch, not-clean directory) are all detected pre-arm and
    // so never reach here armed. The marker carries no cause, so signalling on a
    // UsageError discloses nothing the peer's own view of the teardown would not;
    // the local party still sees its specific error and exits 64, while the peer
    // sees the cause-free "peer aborted" and exits 69. The pre-arm/post-arm line
    // is principled, not incidental: only post-arm does a session key (to
    // authenticate the marker) and a waiting post-handshake peer both exist.
    if (
      conn.abortArmed &&
      signalReceived === undefined &&
      !errIsPeerAbort(err)
    ) {
      await conn.writeAbortMarker().catch(() => {
        /* best-effort; teardown proceeds regardless of write outcome */
      });
    }

    if (signalReceived !== undefined) {
      log.error(
        `error in flight when ${signalReceived} arrived: ` +
          sanitizeErrorForDisplay(err),
      );
      // The run was cut short by a signal and the process is exiting; the
      // caller guards against an absent bootstrap result. Preserve
      // onAuthenticatedError so a hook failure recorded before the signal is not
      // silently dropped here -- otherwise the caller would treat the run as a
      // clean config write.
      return { onAuthenticatedError };
    }
    throw err;
  } finally {
    await doCleanup();
  }
}
