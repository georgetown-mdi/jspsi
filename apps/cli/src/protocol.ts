import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import PSI from "@openmined/psi.js";

import {
  FileSyncConnection,
  EncryptedConnection,
  getLogger,
  describeExchangeStages,
  runExchange,
  buildOutputTable,
  authenticateConnection,
} from "@psilink/core";
import type {
  Authentication,
  Connection,
  ConnectionConfig,
  SFTPConnectionConfig,
  FileDropConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import { LocalFSClient } from "./connection/localFSClient";
import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { saveKeyFile } from "./keyFile";
import { writeOutput } from "./util/cli";

/**
 * CLI-layer extension of {@link Authentication} that co-locates the path where
 * the rotated PAKE token is persisted after each successful SPAKE2 handshake.
 *
 * `pakeToken` is narrowed from optional in {@link Authentication} to required
 * here: every authenticated exchange must supply a valid token before the
 * connection is opened.
 */
export interface AuthPersist extends Authentication {
  pakeToken: string;
  keyFilePath: string;
}

// Distributive Omit: applied to each union member independently so that
// discriminated-union narrowing (e.g. on `channel`) is preserved.
type DistributedOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * A {@link ConnectionConfig} where `authentication` carries one of two
 * explicit states (no `undefined` third state):
 *
 * - `AuthPersist` — authenticated exchange; the token is persisted to
 *   `keyFilePath` after each successful SPAKE2 handshake.
 * - `null` — intentionally unauthenticated exchange (e.g. zero-setup); the
 *   caller has acknowledged the security tradeoff and `runProtocol` proceeds
 *   without PAKE.
 *
 * The required (non-optional) field forces every CLI caller to make the
 * authentication choice explicit at construction time. There is no library
 * "fall through with a warning" branch — the only consumers of `runProtocol`
 * are the CLI commands, and both currently produce one of the two values.
 *
 * `Extract` narrows the base to the channels that `runProtocol` actually
 * supports (`"sftp"` and `"filedrop"`), so passing a WebRTC config requires
 * an explicit `as unknown as` cast and cannot happen by accident. The
 * distributive `Omit` then removes `authentication` from each union member
 * independently so that discriminant narrowing on `channel` is preserved, and
 * the field is redefined here as required so that `null` is a valid state but
 * `undefined` is not.
 */
export type ProtocolConnectionConfig = DistributedOmit<
  Extract<ConnectionConfig, { channel: "sftp" | "filedrop" }>,
  "authentication"
> & {
  authentication: AuthPersist | null;
};

/**
 * Runs the PSI protocol over an SFTP or file-drop connection and writes
 * results to output.
 *
 * When `connection.authentication` is set, `keyFilePath` must be a non-empty,
 * non-whitespace string; this is checked before any connection is opened so
 * that a whitespace-only path does not silently create a file named " " in
 * the current directory. `pakeToken` is validated by {@link authenticateConnection}
 * after the connection opens. `keyFilePath` is checked for non-emptiness only
 * — invalid paths are caught with a clear OS error at the key-file write step.
 *
 * When `connection.authentication` is `null` the exchange runs without PAKE;
 * this is the path taken by callers (e.g. zero-setup) that explicitly
 * acknowledge relying on transport-layer security only. The field is required
 * (no `undefined`) so the choice is always explicit.
 */
export async function runProtocol(
  connection: ProtocolConnectionConfig,
  prepared: PreparedExchange,
  output: string | undefined,
  verbosity: number,
  loggerName: string,
): Promise<void> {
  const log = getLogger(loggerName);

  if (connection.channel !== "filedrop" && connection.channel !== "sftp")
    // Inside this branch `connection` narrows to `never`; cast through unknown
    // to recover the channel name for the error message. This branch is only
    // reached when the caller bypasses the type system with `as unknown as`.
    throw new Error(
      `unsupported channel: ` +
        (connection as unknown as { channel: string }).channel,
    );

  const auth = connection.authentication;
  // Captured in the outer scope so the post-handshake saveKeyFile call below
  // can reuse the trimmed value without re-reading auth.keyFilePath.
  let trimmedKeyFilePath: string | undefined;
  if (auth) {
    // Guards against a missing or whitespace-only keyFilePath before any
    // connection is opened (a whitespace-only path would create a file named
    // " " in the current directory rather than failing clearly). Trim leading
    // and trailing whitespace from the supplied value before using it: a
    // value like "  ./key  " is almost certainly user typo and would
    // otherwise become "  ." for dirname and " ./key  " for the file name,
    // producing a confusing on-disk artifact rather than the intended file.
    const rawKfp = auth.keyFilePath;
    if (typeof rawKfp !== "string" || rawKfp.trim().length === 0)
      throw new Error(
        "connection.authentication must include a non-empty keyFilePath",
      );
    const kfp = rawKfp.trim();
    trimmedKeyFilePath = kfp;
    // Pre-validate that the key file path itself, if it already exists, is
    // a regular file rather than a directory or other special node. If it
    // is a directory, saveKeyFile's renameSync would fail post-handshake
    // (when the partner may already hold the rotated token) and force a
    // re-invitation that is preventable here. Use lstatSync so a symlink at
    // the key file path is inspected as-is rather than followed: a symlink
    // pointing at a directory should still be rejected.
    try {
      const targetStat = fs.lstatSync(kfp);
      if (!targetStat.isFile() && !targetStat.isSymbolicLink())
        throw new Error(
          `keyFilePath ${kfp} exists but is not a regular file (` +
            `${
              targetStat.isDirectory()
                ? "directory"
                : "non-regular filesystem entry"
            }); saveKeyFile would fail after a successful PAKE handshake. ` +
            "Remove or rename it before running the exchange.",
        );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: keyFilePath does not yet exist (first run after invite/
      // accept) and saveKeyFile will create it — fine.
      // ENOTDIR: a component of the path prefix is a regular file, so kfp
      // cannot exist; fall through and let the parent-directory check below
      // raise the more specific "parent exists but is not a directory"
      // error.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    // Pre-validate that the parent directory exists (creating it if missing,
    // mirroring saveKeyFile's `mkdirSync({ recursive: true })`) and that it
    // is a directory, so saveKeyFile failure cannot occur after a successful
    // PAKE handshake, where the partner may already hold the rotated token
    // and recovery requires re-invitation.
    const parent = path.dirname(kfp);
    let parentStat: fs.Stats | undefined;
    try {
      parentStat = fs.statSync(parent);
    } catch (err) {
      // ENOENT means the parent does not yet exist. saveKeyFile would create
      // it via `mkdirSync({ recursive: true })`, so do the same here. Any
      // failure that prevents creation (EACCES on a read-only ancestor, a
      // dangling symlink whose target cannot be created) is the real
      // misconfiguration and is surfaced with a clearer message.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          `keyFilePath parent directory ${parent} is not accessible: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      try {
        fs.mkdirSync(parent, { recursive: true });
        // Surface the side effect so users can see why a directory appeared
        // even if the subsequent handshake or exchange fails and saveKeyFile
        // never writes the key file into it.
        log.info(
          `created keyFilePath parent directory ${parent} (mirrors ` +
            "saveKeyFile's recursive mkdir; left in place on failure)",
        );
        parentStat = fs.statSync(parent);
      } catch (createErr) {
        // lstat can distinguish a dangling symlink (target missing) from a
        // truly absent path so the hint points at the actual cause.
        let hint = "";
        try {
          if (fs.lstatSync(parent).isSymbolicLink())
            hint = " (path is a symbolic link, possibly dangling)";
        } catch {
          /* lstat failure: parent truly absent; default message applies. */
        }
        throw new Error(
          `keyFilePath parent directory ${parent} cannot be created${hint}: ` +
            (createErr instanceof Error
              ? createErr.message
              : String(createErr)),
        );
      }
    }
    if (!parentStat.isDirectory())
      throw new Error(
        `keyFilePath parent ${parent} exists but is not a directory; ` +
          "saveKeyFile would fail after a successful PAKE handshake",
      );
    // Best-effort writability check: catches the common case of a read-only
    // parent before PAKE rotates the token. fs.accessSync(W_OK) is
    // unreliable on Windows (it consults only the read-only attribute, not
    // the ACL) and can be inconsistent on Linux with capabilities such as
    // CAP_DAC_OVERRIDE. A create-and-unlink probe on a sentinel file
    // exercises the actual permission path that saveKeyFile will use, and
    // works identically on every platform. PID + crypto-random nonce in the
    // name prevents collisions with concurrent runs, and the unlink in
    // `finally` cleans up even if open fails partway. The real rename in
    // saveKeyFile may still fail (e.g. quota exceeded between probe and
    // write), but the common misconfiguration is caught here before the
    // partner can be left holding a rotated token this side cannot persist.
    //
    // Sweep any stale probe files from previous SIGKILL'd / OOM'd runs first
    // so the directory does not accumulate empty zero-byte litter. Names
    // include a unique nonce, so unlinking other entries that match the
    // pattern is safe on POSIX: a concurrent run that has already opened its
    // probe does not care if the path is unlinked underneath it (the fd
    // remains valid). On Windows the open file is held without
    // FILE_SHARE_DELETE, so unlinkSync on a peer's probe fails with EPERM;
    // the inner catch swallows the failure and the peer's probe remains.
    // The leftover is cosmetic (zero-byte file) and is swept on the next
    // non-concurrent invocation. This is documented rather than worked
    // around because no Node API exposes FILE_SHARE_DELETE without addons.
    // Match the exact probe-file name format produced below
    // (`.psilink-write-probe-<pid>-<8 hex chars>`) so that an unrelated
    // file the user happens to have placed with this prefix is not
    // silently unlinked.
    const PROBE_NAME_RE = /^\.psilink-write-probe-\d+-[0-9a-f]{8}$/;
    try {
      for (const entry of fs.readdirSync(parent)) {
        if (PROBE_NAME_RE.test(entry)) {
          try {
            fs.unlinkSync(path.join(parent, entry));
          } catch {
            /* best-effort cleanup; ignore failures (e.g. ENOENT from a
             * concurrent run that just unlinked its own probe). */
          }
        }
      }
    } catch {
      /* readdir failure (permission, transient) is non-fatal: the probe
       * itself will surface the underlying access problem with a clearer
       * message. */
    }
    const probeName =
      `.psilink-write-probe-${process.pid}-` + crypto.randomUUID().slice(0, 8);
    const probePath = path.join(parent, probeName);
    let probeFd: number | undefined;
    try {
      probeFd = fs.openSync(
        probePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
    } catch (err) {
      throw new Error(
        `keyFilePath parent directory ${parent} is not writable: ` +
          (err instanceof Error ? err.message : String(err)) +
          ". Restore write permission before running the exchange, " +
          "otherwise saveKeyFile would fail after a successful PAKE " +
          "handshake and both parties would need to re-invite.",
      );
    } finally {
      if (probeFd !== undefined) {
        try {
          fs.closeSync(probeFd);
        } catch {
          /* best-effort cleanup */
        }
      }
      try {
        fs.unlinkSync(probePath);
      } catch {
        /* best-effort cleanup; open() may have failed before the file was
         * created, in which case unlink ENOENT is expected. */
      }
    }
  }
  const client =
    connection.channel === "filedrop"
      ? new LocalFSClient()
      : new SSH2SFTPClientAdapter();
  const conn = new FileSyncConnection(client, { verbose: verbosity });

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
  // No conn.on("error", ...) listener is installed here. Synchronous transport
  // failures (send/synchronize) throw directly, and asynchronous poll() errors
  // are observed by the on("error") listeners that the protocol-layer receive
  // helpers (in pake.ts, protocolSetup.ts, payloadExchange.ts) register for the
  // duration of each pending receive — see types.ts:Connection.
  let cleaned = false;
  let opened = false;
  let started = false;
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
  // activeConn is the connection used for runExchange. When authentication
  // succeeds, it is replaced with an EncryptedConnection that wraps conn so
  // all subsequent messages are protected by AES-256-GCM. Without auth,
  // activeConn stays as conn (no AEAD). Declared here so doCleanup can call
  // activeConn.close(), which routes through the wrapper's teardown (listener
  // detach + inner.close()) when it is an EncryptedConnection.
  let activeConn: Connection = conn;
  async function doCleanup() {
    if (cleaned) return;
    cleaned = true;
    if (started) {
      log.info("stopping polling");
      try {
        conn.stop();
      } catch (err) {
        log.debug("conn.stop() during cleanup:", err);
      }
    }
    if (opened) log.info("closing connection");
    // cleanup() and close() are intentionally called even when opened is false:
    // cleanup() is a no-op on an unconnected instance; close() throws "not
    // connected" which the catch below handles. This covers any partial state
    // left by a failed open() call.
    await conn.cleanup().catch((err: unknown) => {
      log.debug("conn.cleanup() during cleanup:", err);
    });
    // When the connection was open, a close failure is user-visible: the
    // transport may not have terminated cleanly (e.g. SSH session timeout).
    // When it was never opened, "not connected" is the expected throw and
    // is logged at debug to avoid spurious noise.
    try {
      await activeConn.close();
    } catch (err: unknown) {
      if (opened) {
        log.warn("failed to close connection during cleanup:", err);
      } else {
        log.debug("connection close during cleanup:", err);
      }
    }
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
  // - authStarted && !tokenRotated: SPAKE2 may have completed on either side;
  //   the partner may have persisted a rotated token even though we did not.
  // - !authStarted: handshake never began; the existing token is still valid.
  function logRotationStateOnInterrupt(reason: string): void {
    if (tokenRotated) {
      log.warn(
        `The PAKE token was already rotated and saved before ${reason}. ` +
          "Retry without re-inviting; if PAKE authentication fails on retry, " +
          "both parties must re-invite.",
      );
    } else if (authStarted) {
      log.warn(
        `The PAKE handshake was in progress when ${reason}. Depending on ` +
          "how far the handshake had progressed, the partner may have " +
          "already completed it and saved the rotated token even though " +
          "this side did not. Retry the exchange with the existing key " +
          "file; if PAKE authentication fails on retry, both parties must " +
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
      log.debug("onSigint cleanup threw:", cleanupErr);
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
      log.debug("onSigterm cleanup threw:", cleanupErr);
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

  try {
    if (connection.channel === "filedrop") {
      log.info("opening local path", connection.path);
    } else {
      log.info(
        "opening connection to",
        connection.server.host,
        "with options",
        connection.options,
      );
    }
    // Destructure authentication out before calling open(): conn.open() does
    // not use the field, and null (from the no-auth path) is not assignable to
    // Authentication | undefined. The spread + cast is required because
    // DistributedOmit does not produce a type TypeScript can narrow back to the
    // union form without a cast.
    const { authentication: _auth, ...connForOpen } = connection;
    await conn.open(
      connForOpen as SFTPConnectionConfig | FileDropConnectionConfig,
    );
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
        log.debug("post-open signal close failed:", err);
      }
      throw new Error(
        `interrupted by ${signalReceived} during connection open`,
      );
    }

    log.info("synchronizing");
    await conn.synchronize();

    // If a signal fired during the synchronize() round-trip, doCleanup already
    // ran (closing the connection and removing our hello/wave files). Bail
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
      // conn.start() must precede authenticateConnection: the SPAKE2 receive()
      // helper registers conn.once("data", ...) listeners driven by the polling
      // loop.
      // Discard the (possibly whitespace-padded) keyFilePath from auth;
      // saveKeyFile below uses trimmedKeyFilePath, which was captured and
      // trimmed during pre-flight without mutating the caller-supplied
      // auth object.
      const { keyFilePath: _ignored, ...pakeAuth } = auth;
      // trimmedKeyFilePath is set whenever auth is set; they are populated
      // together in the pre-flight branch above.
      const keyFilePath = trimmedKeyFilePath!;
      // Set synchronously before the await so a signal arriving during the
      // SPAKE2 round-trip or before saveKeyFile runs can distinguish the
      // "handshake may have completed on the partner side" case from the
      // "handshake never started" case.
      authStarted = true;
      const { newToken, sessionKey } = await authenticateConnection(
        conn,
        pakeAuth,
        role,
      );
      try {
        // saveKeyFile is synchronous; the assignment below runs in the same
        // microtask tick. A signal cannot interleave between them, so any
        // signal handler that reads tokenRotated sees either both pre-save
        // state (tokenRotated=false) or both post-save state (tokenRotated
        // =true). Maintain this invariant: do not insert awaits between
        // saveKeyFile and the assignment.
        saveKeyFile(keyFilePath, { pakeToken: newToken });
        tokenRotated = true;
      } catch (err) {
        // "may already hold": both parties independently derive newToken from
        // the SPAKE2 session key, but either party's disk write can fail. We
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
      try {
        activeConn = await EncryptedConnection.create(conn, sessionKey, role);
      } catch (err) {
        // saveKeyFile already ran (tokenRotated=true), so the token state on
        // disk must be communicated even when the subsequent key setup fails
        // for an unrelated reason (e.g. a crypto environment issue). Tag the
        // wrapped error so the generic token-rotation advisory in the outer
        // catch is suppressed in favour of this more specific message.
        if (tokenRotated) {
          throw Object.assign(
            new Error(
              `the PAKE token was already rotated and saved, but encryption ` +
                `key setup failed: ` +
                (err instanceof Error ? err.message : String(err)) +
                ` Retry the exchange without re-inviting; if this error ` +
                `recurs, investigate whether your environment supports ` +
                `AES-GCM (WebCrypto). If PAKE authentication fails on ` +
                `retry, both parties must re-invite.`,
            ),
            { psilinkRecoveryHintEmitted: true },
          );
        }
        throw err;
      }
      if (signalReceived !== undefined) {
        // A signal fired during EncryptedConnection.create(): doCleanup
        // already ran against the raw conn (activeConn at that time). Now
        // that create() has resolved, close the wrapper explicitly so its
        // listeners are detached, then bail so the signal handler owns the
        // exit code.
        try {
          await activeConn.close();
        } catch (err) {
          log.debug("post-create signal close failed:", err);
        }
        throw new Error(
          `interrupted by ${signalReceived} during key derivation`,
        );
      }
    }

    const stageLabels = Object.fromEntries(
      describeExchangeStages(prepared).map(({ id, label }) => [id, label]),
    );
    const { associationTable, partnerPayload } = await runExchange(
      activeConn,
      role,
      prepared,
      {
        psiLibrary: await PSI(),
        verbosity,
        onStage: (id: string) => {
          const label = stageLabels[id] ?? id;
          log.info(label.charAt(0).toLowerCase() + label.slice(1));
        },
        onWarning: (msg: string) => log.warn("terms exchange:", msg),
        onProtocolConfirmed: (partnerTerms, resolvedRole) => {
          log.info("terms agreed, partner identity:", partnerTerms.identity);
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
  } catch (err) {
    // tokenRotated=true means this party's saveKeyFile succeeded; the partner
    // independently derived the same new token from the SPAKE2 session key, but
    // their disk write cannot be verified from here. "Retry without
    // re-inviting" is the correct first step: if the partner also saved, retry
    // succeeds; if their save failed, they received a separate error and the
    // retry will surface a PAKE mismatch, at which point both parties
    // re-invite. We do not say "both parties hold" (overstates certainty) or
    // "may already hold" (understates - this party definitely saved).
    //
    // authStarted && !tokenRotated handles the looser window: SPAKE2 may have
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
    // messages that contradict each other. SPAKE2 protocol failures from
    // runSpake2 (generic "PAKE authentication failed" / "PAKE handshake
    // timed out") are NOT tagged and DO get the generic advisory, which
    // adds useful "retry first; if it fails, re-invite" context.
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
    const hintAlreadyEmitted = isHintTagged(err);
    if (!hintAlreadyEmitted) {
      if (tokenRotated) {
        log.error(
          "The PAKE token was already rotated and saved before this error. " +
            "Retry the exchange without re-inviting; if PAKE authentication " +
            "fails on retry, both parties must re-invite.",
        );
      } else if (authStarted) {
        log.error(
          "The PAKE handshake was in progress when this error occurred. " +
            "Depending on how far the handshake had progressed, the " +
            "partner may have already completed it and saved the rotated " +
            "token even though this side did not. Retry the exchange " +
            "with the existing key file; if PAKE authentication fails on " +
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
    if (signalReceived !== undefined) {
      log.error(
        `error in flight when ${signalReceived} arrived: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    throw err;
  } finally {
    await doCleanup();
  }
}
