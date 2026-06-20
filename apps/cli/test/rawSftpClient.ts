import Ssh2SftpClient from "ssh2-sftp-client";
import { getLogger, sanitizeErrorForDisplay } from "@psilink/core";

/**
 * Constructs a raw {@link Ssh2SftpClient} whose lifecycle diagnostics are routed
 * to the project logger instead of ssh2-sftp-client's default console sinks.
 *
 * A few integration tests must drive a BARE ssh2-sftp-client -- bypassing
 * {@link SSH2SFTPClientAdapter} -- to exercise a server profile's refusal or
 * confinement directly (a kex the policy excludes, a chroot jail). The trouble is
 * the bare constructor: with no callbacks, ssh2-sftp-client installs defaults that
 * `console.error`/`console.log` the underlying ssh2 Client's error/end/close
 * events whenever they fire OUTSIDE a high-level operation. On a deliberately
 * refused or torn-down test connection that surfaces as an async-late
 * `Global error listener: read ECONNRESET` on `console.error` during teardown. The
 * integration console sentinel can only catch that best-effort -- it races the
 * bounded `afterAll` drain -- so a line that lands past the budget reds the run
 * non-deterministically.
 *
 * Routing the three events to the project logger closes the leak at the source,
 * exactly as {@link SSH2SFTPClientAdapter}'s constructor callbacks do for an
 * adapter-driven connection: the line never reaches the console regardless of WHEN
 * the event fires, the deterministic guarantee the sentinel cannot give on its
 * own. The callbacks REPLACE ssh2-sftp-client's console defaults as a set (its
 * `globalListener` runs `eventCallbacks?.<evt>` and is otherwise a no-op), and are
 * purely observational -- the handled-flag bookkeeping and `this.sftp` cleanup run
 * inside `globalListener` regardless.
 *
 * All three route to TRACE, which the project logger keeps a no-op: this named
 * logger's level is fixed at WARN when it is created here and does NOT track later
 * root-level changes, so the line stays off the console even when an integration
 * file raises the root level (the suite's noisiest do, to DEBUG). That
 * non-propagation -- not merely the trace-below-DEBUG margin -- is what makes the
 * suppression deterministic rather than dependent on the suite's log level; it is
 * asserted in `test/unit/rawSftpClient.test.ts` (which forces root to its most
 * verbose level and confirms the teardown still touches no console sink). It
 * surfaces only if this logger itself is set to trace.
 *
 * Routing all three to trace differs from the adapter, which keeps an escaped
 * `error` at error: there an unhandled client error is an operator-actionable
 * fault, whereas here the teardown ECONNRESET is an EXPECTED artifact of a test
 * that purposely refuses or ends the connection -- the same benign-lifecycle
 * category the adapter already routes to trace for end/close. The error message is
 * server-controlled (ssh2 rides an SSH_MSG_DISCONNECT description on `err.message`),
 * so it is escaped through {@link sanitizeErrorForDisplay} before logging,
 * mirroring the adapter.
 *
 * Covered by `test/unit/rawSftpClient.test.ts`, which drives the constructed
 * client's callbacks and asserts they reach neither `console.error` nor
 * `console.log`; reverting a call site to a bare `new Ssh2SftpClient()` re-fails
 * it.
 */
const log = getLogger("raw-sftp-test-client");

export function createRawSftpClient(): Ssh2SftpClient {
  return new Ssh2SftpClient("sftp", {
    error: (err: unknown) =>
      log.trace(
        "raw ssh2-sftp-client error outside an operation: " +
          sanitizeErrorForDisplay(err),
      ),
    end: () =>
      log.trace("raw ssh2-sftp-client connection ended outside an operation"),
    close: () =>
      log.trace("raw ssh2-sftp-client connection closed outside an operation"),
  });
}
