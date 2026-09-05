import Ssh2SftpClient from "ssh2-sftp-client";
import { getLogger, sanitizeErrorForDisplay } from "@psilink/core";

/**
 * Constructs a raw {@link Ssh2SftpClient} whose lifecycle diagnostics route
 * to the project logger instead of ssh2-sftp-client's console defaults. A
 * bare `new Ssh2SftpClient()` leaves those defaults active, so an ssh2
 * Client error/end/close firing outside a high-level operation -- including
 * an expected ECONNRESET from a test that purposely tears down a connection
 * -- reaches `console.error`/`console.log` directly.
 *
 * All three route here to TRACE, on a logger fixed at WARN that ignores
 * later root-level changes, so the suppression holds regardless of a
 * suite's log level; the error message is escaped through
 * {@link sanitizeErrorForDisplay} first. Covered by
 * `test/unit/connection/rawSftpClient.test.ts`.
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
