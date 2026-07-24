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
   * suite can pin the server it connects to: with the no-pin default now
   * fail-closed, every conformance connection must pin this.
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
   * Op-count session cap: a session is dropped once it has served this many SFTP
   * operations. 0 disables it.
   */
  maxOps: number;
  /**
   * Idle cap: a session is dropped after going this many ms without an SFTP
   * operation; each op resets the timer, so unlike {@link maxLifetimeMs} a
   * keepalive op CAN beat it. 0 disables it.
   */
  maxIdleMs: number;
  /**
   * Arm a one-shot drop of the active session after it serves `ops` more SFTP
   * operations, then disarm -- a within-batch or mid-rendezvous drop the re-dial
   * recovers from, distinct from the standing {@link maxOps} cap. A value <= 0
   * disarms it.
   */
  dropActiveAfterOps(ops: number): void;
  /**
   * Arm a one-shot drop of the active session `ms` from now, on wall-clock
   * regardless of traffic, then disarm. A no-op when no session is currently
   * established; a value <= 0 cancels any pending one-shot timer.
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
