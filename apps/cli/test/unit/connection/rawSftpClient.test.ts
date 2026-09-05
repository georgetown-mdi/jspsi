import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import { createRawSftpClient } from "../../rawSftpClient";

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

// Fires the three teardown events the constructor's callbacks handle -- including
// the read ECONNRESET that flaked the suite -- with console.error/console.log
// spied, and asserts neither was touched. Reading the callbacks the constructor
// actually stored, rather than asserting on the routing in the abstract, means a
// client reverted to the bare `new Ssh2SftpClient()` -- whose defaults call
// console.error/console.log -- re-fails this.
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

// Regression guard: a bare `new Ssh2SftpClient()` writes its default teardown
// lines to the console, which the integration sentinel catches only best-effort.
// createRawSftpClient must route those off console at the source,
// deterministically -- its named logger pins its level at creation and never
// tracks later root changes. Forcing root here to the most verbose level and
// confirming teardown stays silent turns that claim into a check.
test("teardown stays off the console even at the most verbose root level", () => {
  logLibrary.setLevel(logLibrary.levels.TRACE, false);
  expectTeardownStaysOffConsole();
});
