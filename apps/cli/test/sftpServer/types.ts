// The pluggable test-server interface backing the CLI integration suite. One
// implementation runs an SFTP server inside the test process (the default); the
// other spawns a native OpenSSH sshd as an unprivileged child. The conformance
// suite drives the production SSH2SFTPClientAdapter against whichever backend the
// PSILINK_SFTP_BACKEND environment variable selects, reading every server-shaped
// detail (host, port, credentials, served directory, remote-path root) from the
// handle rather than hardcoding it, so the same tests run unchanged against both.

/**
 * One party's credentials for the shared rendezvous directory. The two parties
 * are distinct (distinct usernames and key material); `password` is present only
 * on backends that authenticate by password, `privateKey` only on backends that
 * authenticate by public key. A backend may surface both (the in-process server
 * does) so the suite can drive either method against it.
 */
export interface SftpPartyCredentials {
  /** SSH username the client authenticates as. */
  username: string;
  /** Password, when the backend authenticates this party by password. */
  password?: string;
  /** OpenSSH private key (PEM), when the backend authenticates by public key. */
  privateKey?: string;
  /**
   * The server's OpenSSH SHA256 host-key fingerprint (server-wide, identical for
   * both parties), copied onto each party so the shared `serverAuth`/
   * `publicKeyAuth` helpers spread it into the connection `server` block and the
   * suite's connections are pinned. Pinning is required since the no-pin default
   * is fail-closed; see {@link SftpServerHandle.hostKeyFingerprint}.
   */
  hostKeyFingerprint: string;
}

/**
 * The connection details and served directory the conformance suite drives
 * against. Every field is plain serializable data so the vitest globalSetup can
 * hand the running server to the test workers through `provide`/`inject`.
 */
export interface SftpServerHandle {
  /** Loopback host the server listens on. */
  host: string;
  /** Ephemeral port the server listens on. */
  port: number;
  /** The two distinct parties sharing one rendezvous directory. */
  usera: SftpPartyCredentials;
  userb: SftpPartyCredentials;
  /**
   * The server's OpenSSH SHA256 host-key fingerprint (`SHA256:...`), the value a
   * client pins as `connection.server.host_key_fingerprint`. Exposed so the
   * suite can pin the server it connects to, as every conformance connection
   * must under the fail-closed no-pin default.
   */
  hostKeyFingerprint: string;
  /**
   * Host filesystem root the server serves. Tests create their namespace
   * subdirectory, plant out-of-band files, and clean up directly under it.
   */
  backingDir: string;
  /**
   * Remote-path root the client passes as the connection `path`: a served
   * namespace `ns` is reached at `${remoteRoot}/${ns}` over SFTP and lives on
   * the host at `${backingDir}/${ns}`. The in-process backend maps a virtual
   * `/psi` root into `backingDir`; the non-chroot native sshd serves
   * `backingDir` at its real absolute path, so the two roots differ and tests
   * must take theirs from here.
   */
  remoteRoot: string;
}

/** A started test SFTP server: its connection handle plus a teardown. */
export interface SftpTestServer {
  /** Connection details surfaced to the conformance suite. */
  handle: SftpServerHandle;
  /** Stop listening and remove the served directory. */
  stop(): Promise<void>;
}

/**
 * Per-request fault hooks the in-process backend exposes so the adversarial
 * tests can drive deterministic wire states the production adapter must survive.
 * Default values leave every request behaving normally; a test flips one, drives
 * the operation, and the server applies the fault once. Only the in-process
 * backend offers these (a native sshd cannot emit a malformed packet), so the
 * adversarial subset runs in-process only.
 */
export interface SftpFaultInjection {
  /** Answer the next READDIR with a malformed NAME packet (drives the client's fatal-error path). */
  malformedNameOnNextReaddir: boolean;
  /** Answer the next READ with a malformed DATA packet (the read-path fatal-error case). */
  malformedDataOnNextRead: boolean;
  /**
   * Answer the next READDIR with a well-formed NAME batch carrying this single
   * over-length filename, then EOF, so the directory-listing length bound is
   * exercised against real wire bytes. Null leaves READDIR normal.
   */
  oversizeNameOnNextReaddir: string | null;
  /** Accept a request of this opcode but never answer it (withheld response). */
  withholdOn: string | null;
  /** Fail RENAME with the generic-failure status this many times, then succeed. */
  renameFailuresRemaining: number;
  /** Cap each READDIR to this many entries (realistic batching); 0 means one batch. */
  readdirBatchSize: number;
}

/**
 * Deterministic staging of a RENAME torn by a session drop, and of the partner
 * consumption that can follow it. Every flag is OFF by default and each arming
 * flag is one-shot: the RENAME that fires it clears it, so a recovery's re-issue
 * of the same rename is served normally.
 *
 * The op-count drops ({@link SftpSessionControls.dropActiveAfterOps} and
 * {@link SftpSessionControls.maxOps}) cannot stage this: they arm the teardown as
 * a request is counted and defer it to the check phase, so whether the request's
 * own filesystem work lands before the connection goes is a race against that
 * request's fs callback. These controls cut at a named point inside the RENAME
 * handler instead, so what landed at the server is decided rather than raced.
 *
 * In-process only, like the fault hooks: a native sshd can neither be told where
 * inside a request to cut nor made to hold a reply for another request.
 */
export interface SftpRenameTearControls {
  /**
   * Tear the connection serving the next RENAME from inside its `fs.rename`
   * callback, on success and before its reply is written: the publish is durably
   * in place at the server and the client's rename is torn off the wire with no
   * status ever sent.
   */
  tearAfterRenameLands: boolean;
  /**
   * Tear the connection serving the next RENAME before any filesystem work runs,
   * so nothing lands and the destination never exists. The source is left in
   * place, so a recovery's re-issue can complete it.
   */
  tearBeforeRenameLands: boolean;
  /**
   * At a {@link tearAfterRenameLands} tear, also unlink the landed destination
   * server-side. This stands in for a partner that consumed the message inside
   * the recovery window, for a case driving one adapter with no partner in it.
   */
  consumeDestinationAtTear: boolean;
  /**
   * Hold any STAT/LSTAT of {@link tornDestination} until that path has been
   * REMOVEd, so a real partner's consume-delete strictly precedes the sender's
   * landed-confirmation probe of the same path regardless of how the two would
   * otherwise interleave. Released by {@link reset} as well, so a case whose
   * partner never consumes does not park the probe for the run.
   */
  holdProbeUntilDestinationConsumed: boolean;
  /**
   * Fail any STAT/LSTAT of {@link tornDestination} with a generic error, which
   * is a different answer from "the server reported it absent": the publishing
   * party's landed-confirmation probe cannot settle the publish either way, so
   * the publish stays undetermined with its message file still on the server.
   * Deterministic where the real shape of that state is a race -- a probe torn,
   * expired, or refused on a dead session -- and it is the arm the
   * clean-directory remedy exists for.
   */
  refuseProbeOfTornDestination: boolean;
  /**
   * Acknowledge any REMOVE of {@link tornDestination} without performing it, so
   * the partner's consume-delete leaves the torn publish's message file on the
   * server. It stages the residue rather than a server behaviour: a real run
   * reaches the same state when the publishing party's abort marker reaches the
   * partner before that partner's next poll, which is a race a case must not
   * tune a sleep to.
   */
  preserveTornDestinationOnRemove: boolean;
  /** The destination path of the torn RENAME, as the client named it. */
  tornDestination: string | undefined;
  /** Disarm every flag, forget the torn destination, and release parked probes. */
  reset(): void;
}

/**
 * One reading of {@link SftpRequestMeter}, covering the window since the meter
 * was last {@link SftpRequestMeter.reset | reset}.
 */
export interface SftpRequestMeterReading {
  /** SFTP requests that arrived in the window. */
  received: number;
  /** Replies written in the window for requests that arrived in it. */
  answered: number;
  /** Requests that arrived in the window and are still unanswered. */
  outstanding: number;
  /**
   * The most requests that were simultaneously unanswered at any instant in the
   * window: how deep the client let its request pipeline run on the one channel.
   */
  peakOutstanding: number;
  /** Requests that arrived in the window, by opcode. */
  receivedByOp: Record<string, number>;
  /**
   * Replies written in the window, by the opcode of the request each answers.
   * Subtracting this from {@link receivedByOp} gives the requests of one opcode
   * still in flight, which is what a suite driving a fan of a single opcode
   * alongside other traffic reads instead of {@link outstanding}.
   */
  answeredByOp: Record<string, number>;
  /**
   * Milliseconds from an opcode's first arrival in the window to the last reply
   * written for that opcode, per opcode. An opcode with no reply yet is absent.
   */
  spanMsByOp: Record<string, number>;
}

/**
 * Server-side accounting of the SFTP requests in flight on the channels the
 * backend is serving, so a suite driving a concurrent fan can read what that fan
 * actually put on the wire from the end that owns it, rather than from the
 * client library's internals.
 *
 * Counts requests of the {@link import("./sessionControls").COUNTED_SFTP_OPS}
 * set as they arrive and reply writes as they are issued, across every session
 * the backend is serving at once. A reply written straight onto the channel by a
 * fault injection, bypassing the backend's reply methods, is not counted as an
 * answer, and a withheld reply is likewise never answered -- either leaves its
 * request outstanding for the rest of the window, which is what a suite driving
 * those injections should expect to read.
 */
export interface SftpRequestMeter {
  /** The window's counts as they stand now. */
  read(): SftpRequestMeterReading;
  /**
   * Start a fresh window: zero every count and forget the requests already in
   * flight, so a reply that arrives for one of them is ignored rather than
   * driving the new window's outstanding count negative.
   */
  reset(): void;
}

/**
 * Opt-in session-lifecycle controls the in-process backend exposes so the
 * connection-per-poll and mid-exchange-recovery tests can drive a server that
 * drops sessions the way the real partner's does. Every control is OFF by
 * default (a zero cap, no armed drop, a fresh handshake count), so a suite that
 * never touches them runs exactly as before. All durations are milliseconds.
 *
 * The standing caps model the partner's server policy: they apply to EVERY
 * session while set, so a held session is dropped again on each re-dial (the
 * operator's actual thrash) while a connection-per-poll cycle that stays under
 * the bound is never dropped. The one-shot drops instead target a single active
 * session, for a within-batch or mid-rendezvous drop the re-dial recovers from.
 * Set the standing caps before the exchange starts; each newly established
 * session reads them as it comes up.
 */
export interface SftpSessionControls {
  /**
   * Wall-clock session-lifetime cap: a session is dropped this many ms after its
   * SSH handshake completes, regardless of traffic -- a keepalive cannot beat it,
   * reproducing the partner's hard max-session-duration cap. 0 disables it.
   */
  maxLifetimeMs: number;
  /**
   * Op-count session cap: the drop is armed once a session has been dispatched
   * this many SFTP operations. The teardown may pre-empt that Nth op's own reply
   * (a mid-request cut), so the op that trips the cap is not guaranteed to
   * complete. 0 disables it.
   */
  maxOps: number;
  /**
   * Idle cap: a session is dropped after going this many ms without an SFTP
   * operation; each op resets the timer, so unlike {@link maxLifetimeMs} a
   * keepalive op CAN beat it. 0 disables it.
   */
  maxIdleMs: number;
  /**
   * Accept the client's disconnect and then go quiet: while set, each newly
   * accepted connection's socket is stopped from ever closing itself, so a
   * client that disconnects is left in half-close -- its FIN is consumed, no FIN
   * or reset comes back, and its ssh2 `Client` never emits `'close'`. This is the
   * partner server the connection-per-poll idle release must force closed from
   * its own side. Read as each connection is accepted, so it governs every
   * connection established while it is set and leaves earlier ones untouched;
   * false by default. In-process only, like the fault hooks: a native sshd cannot
   * be told to withhold its close.
   */
  withholdCloseOnDisconnect: boolean;
  /**
   * Accept the TCP connection and never complete the SSH handshake: while set,
   * each newly accepted connection's socket is stopped from ever writing, so a
   * dial hangs, established but never ready, until the client's own connect
   * deadline (ssh2's `readyTimeout`) expires. The mute takes hold as the
   * connection is accepted, which is after ssh2 has written the server's
   * identification string, so the client hears that one line and nothing after
   * it -- the key exchange never reaches it. This is the partner server a dial
   * spends its whole budget against. Read as each connection is accepted, so it
   * governs every connection established while it is set and leaves earlier ones
   * untouched; false by default. In-process only, like the fault hooks: a native
   * sshd cannot be told to stall its handshake.
   */
  stallHandshakeOnConnect: boolean;
  /**
   * Stop stalling handshakes entirely: clear {@link stallHandshakeOnConnect} so
   * later connections handshake normally, and hand the real write back to every
   * socket already muted. Clearing the flag alone does neither of those for a
   * connection already accepted under it. The backend's own `stop()` calls this
   * before ending its connections, for the same reason it stops withholding
   * closes: a muted socket cannot answer the disconnect that ends it.
   *
   * A session {@link vanishActiveSession} muted is in that pool as well, and is
   * released WHOLE here -- its closers with its write, and it counts as vanished
   * no longer -- so unstalling one connection's dial cannot leave another's
   * session answering again but still impossible to close. Re-arm a vanish that
   * is still wanted afterwards.
   */
  stopStallingHandshakes(): void;
  /**
   * Make the currently established session VANISH: from this call on, nothing
   * the server produces for it reaches the wire and the server can no longer
   * close it, so a client with an operation outstanding never gets its reply and
   * a client with nothing outstanding sees a session that simply went quiet. No
   * FIN, no reset, no ssh2 `'end'` or `'close'` -- the partner appliance that
   * stopped answering without hanging up, which the adapter can only discover by
   * its own liveness deadline.
   *
   * Distinct from {@link withholdCloseOnDisconnect}, which is armed before a
   * connection is accepted and fires only in response to the client's own
   * disconnect: this one is invoked mid-exchange against a live session that has
   * asked for nothing. It composes with the caps -- a capped session that is
   * also vanished is ended server-side while the client hears nothing of it.
   *
   * Throws when no session is established or its socket cannot be reached,
   * rather than silently doing nothing: a test whose vanish quietly missed would
   * assert "the client heard nothing" against a server that was answering all
   * along. In-process only, like the fault hooks.
   */
  vanishActiveSession(): void;
  /**
   * Bring every vanished session back: hand the real write and the real closers
   * back to each socket {@link vanishActiveSession} silenced, so the connection
   * can be closed from either side again. The backend's own `stop()` calls this
   * before ending its connections -- a vanished socket cannot answer that end(),
   * which would leave `server.close()` waiting forever -- and a test calls it
   * before its own teardown for the same reason.
   *
   * A socket the withheld-close or stalled-handshake control silenced as well is
   * released here too: each replaced method is held in one place, so whichever
   * of these releases reaches a socket first hands the real one back. That keeps
   * teardown terminating regardless of the order the controls are stopped in;
   * re-arm a control that is still wanted afterwards.
   *
   * The release runs whole or not at all in the other direction too: because the
   * vanish silences its socket in the pools those two controls draw from,
   * {@link stopWithholdingCloses} and {@link stopStallingHandshakes} each finish
   * the vanish release they reach rather than leaving half of one standing.
   */
  restoreVanishedSessions(): void;
  /**
   * Stop withholding closes entirely: clear {@link withholdCloseOnDisconnect} so
   * later connections close normally, and hand the real closers back to every
   * socket already silenced. Clearing the flag alone does neither of those for a
   * connection already established under it. The backend's own `stop()` calls
   * this before ending its connections; a test calls it before its own teardown,
   * since a client's `end()` awaits a close a silenced server never sends -- and
   * a teardown typically dials once more (the pre-drain reconnect), which the
   * flag would silence in turn.
   *
   * A session {@link vanishActiveSession} silenced is in that pool as well, and
   * is released WHOLE here -- its write with its closers, and it counts as
   * vanished no longer -- so releasing one connection's withheld close cannot
   * leave another's session closable but still mute. Re-arm a vanish that is
   * still wanted afterwards.
   */
  stopWithholdingCloses(): void;
  /**
   * Arm a one-shot drop keyed to the `ops`th further SFTP operation, then
   * disarm -- a within-batch or mid-rendezvous drop the re-dial recovers from,
   * distinct from the standing {@link maxOps} cap. The drop is armed as that op
   * is counted and may pre-empt its own reply (a mid-request cut), so it is not
   * guaranteed to complete. "The active session" is the single-active-session
   * appliance model: the counter is server-wide, not per-connection, so if a
   * connection-per-poll re-dial overlaps the prior connection (a new session
   * comes up before the old one closes), the count spans both and the drop may
   * land on a different connection than the one active when it was armed. A
   * value <= 0 disarms it.
   */
  dropActiveAfterOps(ops: number): void;
  /**
   * Arm a one-shot drop of the active session `ms` from now, on wall-clock
   * regardless of traffic, then disarm. A no-op when no session is currently
   * established; a value <= 0 cancels any pending one-shot timer. "The active
   * session" is the single-active-session appliance model: the target is fixed
   * to the connection active when this is armed, so if a connection-per-poll
   * re-dial replaces it before the timer fires, the drop still lands on the
   * original connection, not the current one.
   */
  dropActiveAfterMs(ms: number): void;
  /**
   * The number of SSH session establishments (handshakes) served since the
   * server started or since the last {@link resetHandshakeCount}. A held-session
   * exchange handshakes once; a connection-per-poll exchange handshakes once per
   * cycle; each mid-exchange re-dial adds one. A test asserts on this to prove
   * connection-per-poll is NOT establishing per poll at the default interval.
   */
  handshakeCount(): number;
  /** Reset {@link handshakeCount} to zero (e.g. after a fixture's own connect). */
  resetHandshakeCount(): void;
  /** Deterministic rename-tear staging; see {@link SftpRenameTearControls}. */
  renameTear: SftpRenameTearControls;
  /** Server-side in-flight request accounting; see {@link SftpRequestMeter}. */
  requests: SftpRequestMeter;
}

/**
 * The in-process backend, which additionally exposes its fault hooks for the
 * adversarial tests and its session controls for the connection-lifecycle tests
 * that stand up their own worker-local instance.
 */
export interface InProcessSftpServer extends SftpTestServer {
  inject: SftpFaultInjection;
  sessionControls: SftpSessionControls;
}
