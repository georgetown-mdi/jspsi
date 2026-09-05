// The pluggable test-server interface backing the CLI integration suite. One
// implementation runs an SFTP server inside the test process (the default);
// the other spawns a native OpenSSH sshd as an unprivileged child. The
// conformance suite drives the production SSH2SFTPClientAdapter against
// whichever backend PSILINK_SFTP_BACKEND selects, reading every
// server-shaped detail from the handle instead of hardcoding it.

/**
 * One party's credentials for the shared rendezvous directory. The two parties
 * are distinct (distinct usernames and key material); `password` is present only
 * on backends that authenticate by password, `privateKey` only on backends that
 * authenticate by public key. A backend may expose both (the in-process server
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
  /** Connection details exposed to the conformance suite. */
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
   * Answer the next READDIR with a well-formed NAME batch containing this
   * single over-length filename, then EOF, so the directory-listing length
   * bound is exercised against real wire bytes. Null leaves READDIR normal.
   *
   * Assigning a filename past the backend's NAME batch budget throws at
   * assignment instead: a reply that wide is a fatal protocol error that
   * tears the session, so use {@link nameReplyFilenameBytesOnNextReaddir} to
   * put a reply at or past that wall on the wire.
   */
  oversizeNameOnNextReaddir: string | null;
  /**
   * Answer the next READDIR with a NAME batch of one entry whose filename is
   * this many bytes and whose longname is empty, then EOF, so a case can put a
   * reply of a chosen width on the wire and read whether the pinned stack still
   * delivers it. The reply goes through the server's public `name()` API, so it is
   * encoded and framed by the stack itself, and the width it produced is reported
   * in {@link lastNameReplyPayloadBytes}. Null leaves READDIR normal.
   */
  nameReplyFilenameBytesOnNextReaddir: number | null;
  /**
   * The payload length the stack declared for the last
   * {@link nameReplyFilenameBytesOnNextReaddir} reply -- read off the bytes ssh2
   * handed the protocol, so a case measuring what width still arrives states the
   * encoder's own number instead of an estimate of it. Undefined until such a
   * reply has been written.
   */
  lastNameReplyPayloadBytes: number | undefined;
  /** Accept a request of this opcode but never answer it (withheld response). */
  withholdOn: string | null;
  /** Fail RENAME with the generic-failure status this many times, then succeed. */
  renameFailuresRemaining: number;
  /**
   * Cap each READDIR to at most this many entries (realistic batching); 0
   * leaves the width to the backend.
   *
   * The backend still keeps every NAME reply inside one SFTP packet and
   * resumes the listing where the previous batch ended, so no value here can
   * lose a reply -- a cap wider than one packet is an upper bound on a
   * batch, not a promise of that many entries per round trip.
   */
  readdirBatchSize: number;
  /**
   * Answer this many further READDIRs with an empty NAME batch -- no entry
   * and no end-of-directory status -- before serving the directory normally.
   * This is the only shape that reaches the adapter's readdir round-trip
   * cap: a conformant server's every non-EOF batch contains at least one
   * name, so the entry-count bound would refuse such a listing first.
   * Decremented per batch served; 0 leaves READDIR normal.
   */
  emptyNonEofReaddirBatches: number;
}

/**
 * Deterministic staging of a RENAME torn by a session drop, and of the
 * partner consumption that can follow it. Every flag is off by default and
 * each arming flag is one-shot: the RENAME that fires it clears it, so a
 * recovery's re-issue of the same rename is served normally.
 *
 * The op-count drops ({@link SftpSessionControls.dropActiveAfterOps} and
 * {@link SftpSessionControls.maxOps}) race the request's own filesystem
 * callback instead of staging this deterministically; these controls cut at
 * a named point inside the RENAME handler instead. In-process only, like the
 * fault hooks.
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
   * Fail any STAT/LSTAT of {@link tornDestination} with a generic error,
   * distinct from "the server reported it absent": the publishing party's
   * landed-confirmation probe cannot determine the publish either way, so it
   * stays undetermined with its message file still on the server. Models the
   * race between a probe torn, expired, or refused on a dead session -- the
   * arm the clean-directory remedy exists for.
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
 * backend is serving, so a suite driving a concurrent fan can read what that
 * fan put on the wire from the end that owns it, not the client library's
 * internals.
 *
 * Counts requests of the {@link import("./sessionControls").COUNTED_SFTP_OPS}
 * set as they arrive and reply writes as they are issued. A reply written
 * straight onto the channel by a fault injection is not counted as an
 * answer, and a withheld reply is likewise never answered -- either leaves
 * its request outstanding for the window.
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
 * connection-per-poll and mid-exchange-recovery tests can drive a server
 * that drops sessions the way the real partner's does. Every control is off
 * by default, so a suite that never touches them runs exactly as before. All
 * durations are milliseconds.
 *
 * The standing caps model the partner's server policy and apply to every
 * session while set (a held session is dropped again on each re-dial). The
 * one-shot drops instead target a single active session, for a drop the
 * re-dial recovers from. Set the standing caps before the exchange starts.
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
   * client that disconnects is left in half-close -- no FIN or reset comes
   * back, and its ssh2 `Client` never emits `'close'`. Models the partner
   * server the connection-per-poll idle release must force closed itself.
   * Read as each connection is accepted; false by default. In-process only,
   * like the fault hooks.
   */
  withholdCloseOnDisconnect: boolean;
  /**
   * Accept the TCP connection and never complete the SSH handshake: while
   * set, each newly accepted connection's socket is stopped from ever
   * writing, so a dial hangs, established but never ready, until the
   * client's own connect deadline (ssh2's `readyTimeout`) expires. The mute
   * takes hold after ssh2 has written the server's identification string, so
   * the client hears that one line and the key exchange never reaches it.
   * Read as each connection is accepted; false by default. In-process only,
   * like the fault hooks.
   */
  stallHandshakeOnConnect: boolean;
  /**
   * Stop stalling handshakes entirely: clear {@link stallHandshakeOnConnect}
   * and hand the real write back to every muted socket -- clearing the flag
   * alone does neither for a connection already accepted under it. The
   * backend's own `stop()` calls this first, since a muted socket cannot
   * answer the disconnect that ends it.
   *
   * A session {@link vanishActiveSession} muted is released whole here too,
   * so unstalling one dial cannot leave another session answering but still
   * impossible to close. Re-arm a vanish that is still wanted afterwards.
   */
  stopStallingHandshakes(): void;
  /**
   * How many connections {@link stallHandshakeOnConnect} is holding
   * mid-handshake right now. A case must wait for this count before acting
   * on a parked dial: a client's socket exists before this server has
   * accepted anything, so reading the socket alone can catch a handshake
   * the stall has not reached yet.
   *
   * A session {@link vanishActiveSession} silenced is not counted here,
   * matching what {@link closeStalledConnections} reaches.
   */
  stalledConnectionCount(): number;
  /**
   * Close every connection {@link stallHandshakeOnConnect} is holding
   * mid-handshake, from the server's own side, so a client parked on that
   * dial hears a peer close rather than a teardown it drove itself -- the
   * same handshake stage a client's own socket cannot produce.
   *
   * The stall itself stays armed, so a later dial parks the same way. A
   * session {@link vanishActiveSession} silenced is skipped, since a session
   * the server can still close is not the black hole those cases measure.
   * In-process only, like the fault hooks.
   */
  closeStalledConnections(): void;
  /**
   * Make the currently established session vanish: from this call on,
   * nothing the server produces for it reaches the wire and the server can
   * no longer close it -- no FIN, no reset, no ssh2 `'end'` or `'close'` --
   * so a client can only discover the loss through its own liveness
   * deadline.
   *
   * Distinct from {@link withholdCloseOnDisconnect}, which fires only in
   * response to the client's own disconnect: this is invoked mid-exchange
   * against a live session that asked for nothing, and composes with the
   * caps.
   *
   * Throws when no session is established or its socket cannot be reached,
   * rather than silently doing nothing. In-process only, like the fault
   * hooks.
   */
  vanishActiveSession(): void;
  /**
   * Bring every vanished session back: hand the real write and closers back
   * to each socket {@link vanishActiveSession} silenced, so the connection
   * can be closed from either side again. The backend's own `stop()` calls
   * this first, since a vanished socket cannot answer `end()` and would
   * leave `server.close()` waiting forever.
   *
   * A socket the withheld-close or stalled-handshake control also silenced
   * is released here too, since each replaced method is held in one place;
   * re-arm a control that is still wanted afterwards.
   * {@link stopWithholdingCloses} and {@link stopStallingHandshakes} each
   * finish this release in turn, rather than leaving half of it standing.
   */
  restoreVanishedSessions(): void;
  /**
   * Stop withholding closes entirely: clear
   * {@link withholdCloseOnDisconnect} and hand the real closers back to
   * every silenced socket -- clearing the flag alone does neither for a
   * connection already established under it. The backend's own `stop()`
   * calls this first, since a client's `end()` awaits a close a silenced
   * server never sends.
   *
   * A session {@link vanishActiveSession} silenced is released whole here
   * too (write with closers), so releasing one connection's withheld close
   * cannot leave another session closable but still mute. Re-arm a vanish
   * that is still wanted afterwards.
   */
  stopWithholdingCloses(): void;
  /**
   * Arm a one-shot drop keyed to the `ops`th further SFTP operation, then
   * disarm -- distinct from the standing {@link maxOps} cap. The drop is
   * armed as that op is counted and may pre-empt its own reply: an op the
   * backend answers from a filesystem callback is cut mid-flight, while one
   * answered synchronously lands the cut with the client's wire already
   * empty, so a party with nothing outstanding may never observe it as a
   * lost session.
   *
   * "The active session" is server-wide, not per-connection, so an
   * overlapping connection-per-poll re-dial can land the drop on a
   * different connection than the one active when it was armed. A value
   * <= 0 disarms it.
   */
  dropActiveAfterOps(ops: number): void;
  /**
   * Arm a one-shot drop of the active session `ms` from now, on wall-clock
   * regardless of traffic, then disarm. A no-op when no session is currently
   * established; a value <= 0 cancels any pending timer. The target is
   * fixed to the connection active when armed, so a later connection-per-poll
   * re-dial does not redirect it.
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
