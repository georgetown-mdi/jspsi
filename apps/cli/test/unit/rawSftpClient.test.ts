import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import { createRawSftpClient } from "../rawSftpClient";

// The lifecycle callbacks ssh2-sftp-client stores from the constructor; the
// teardown events its `globalListener` invokes. Typed minimally so the test can
// fire them directly without a live connection.
interface RawClientCallbacks {
  eventCallbacks: {
    error: (err: unknown) => void;
    end: () => void;
    close: () => void;
  };
}

// Restore the root log level after any test that raises it (the verbose-root
// case below), so a mutation cannot leak into a sibling unit file sharing the
// worker. Captured before the level is touched.
const originalRootLevel = logLibrary.getLevel();

afterEach(() => {
  vi.restoreAllMocks();
  logLibrary.setLevel(originalRootLevel, false);
});

// Fire the three teardown events the constructor's callbacks handle -- including
// the read ECONNRESET that flaked the suite -- with console.error/console.log
// spied, and assert neither was touched. Returns nothing; the assertions are the
// point. Reading the callbacks the constructor actually stored (rather than
// asserting on the routing in the abstract) means a raw client reverted to the
// bare `new Ssh2SftpClient()` -- whose default callbacks call console.error/
// console.log at fire time -- re-fails this.
function expectTeardownStaysOffConsole(): void {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  const { eventCallbacks } =
    createRawSftpClient() as unknown as RawClientCallbacks;

  eventCallbacks.error(new Error("read ECONNRESET"));
  eventCallbacks.end();
  eventCallbacks.close();

  expect(errorSpy).not.toHaveBeenCalled();
  expect(logSpy).not.toHaveBeenCalled();
}

// Regression guard for the native-hardening console flake (board item 202617870):
// a bare `new Ssh2SftpClient()` leaves ssh2-sftp-client's default callbacks
// writing `Global error listener: read ECONNRESET` (and the end/close lines) to
// the console on teardown, which the integration sentinel catches only
// best-effort. createRawSftpClient must route those off the console at the source.
test("createRawSftpClient routes teardown diagnostics off the console", () => {
  expectTeardownStaysOffConsole();
});

// The suppression must be DETERMINISTIC, not contingent on the suite's log level:
// the whole point of routing (over draining) is that the line never reaches the
// console regardless of timing OR verbosity. The integration suite's noisiest
// files raise the ROOT log level (mixedConnection/sftpConnection set it to DEBUG);
// forks isolation keeps them in separate processes, but the property that makes
// this safe is local -- createRawSftpClient's named logger pins its own level at
// creation and does NOT track later root changes, so its trace stays a no-op even
// when root is raised. Assert that directly by forcing root to the MOST verbose
// level (stronger than the DEBUG the suite reaches) and confirming the teardown
// still touches no console sink. If the helper ever switched to a logger that
// tracked root (e.g. getLoggerForVerbosity) or this logger were bumped, this fails
// red -- turning the determinism claim into a check rather than a comment.
test("teardown stays off the console even at the most verbose root level", () => {
  logLibrary.setLevel(logLibrary.levels.TRACE, false);
  expectTeardownStaysOffConsole();
});
