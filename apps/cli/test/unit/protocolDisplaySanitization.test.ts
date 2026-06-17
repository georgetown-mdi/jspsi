import { vi, test, expect, beforeEach } from "vitest";

import type { PreparedExchange } from "@psilink/core";

// Shared, reconfigurable state readable inside the vi.mock factories despite ESM
// hoisting. The log arrays capture only runProtocol's own logger (getLogger is
// overridden below); the *Impl handlers let each test steer the mocked SFTP
// adapter without re-declaring the mock.
const mockState = vi.hoisted(() => ({
  infos: [] as string[],
  warnings: [] as string[],
  debugs: [] as string[],
  errors: [] as string[],
  connectImpl: async (_options: Record<string, unknown>): Promise<void> => {},
}));

// runProtocol imports PSI at module load; the factory is never invoked on the
// connect-/synchronize-failure paths these tests exercise, but stub it so the
// WASM module is not pulled in.
vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Keep all of @psilink/core real -- FileSyncConnection, fromEventConnection, and
// the sanitize helpers especially -- and replace only getLogger so runProtocol's
// log.{info,warn,debug,error} calls land in mockState. FileSyncConnection logs
// through getLoggerForVerbosity (a different, un-mocked export), so its internal
// chatter does not pollute these arrays: they hold runProtocol's sinks alone.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: (msg: string, ...args: unknown[]) => {
        mockState.infos.push([msg, ...args.map(String)].join(" "));
      },
      warn: (msg: string, ...args: unknown[]) => {
        mockState.warnings.push([msg, ...args.map(String)].join(" "));
      },
      debug: (msg: string, ...args: unknown[]) => {
        mockState.debugs.push([msg, ...args.map(String)].join(" "));
      },
      error: (msg: string, ...args: unknown[]) => {
        mockState.errors.push([msg, ...args.map(String)].join(" "));
      },
      trace: () => {},
    }),
  };
});

// A fully-stubbed SFTP transport so the host log and the cleanup error sink can
// be driven deterministically, with no real network. A real class (not a
// vi.fn().mockImplementation) so runProtocol's `new SSH2SFTPClientAdapter(...)`
// constructs cleanly; connect/end/list defer to the reconfigurable handlers and
// the remaining methods are inert.
vi.mock("../../src/connection/ssh2SftpAdapter", () => ({
  SSH2SFTPClientAdapter: class {
    connect(options: Record<string, unknown>) {
      return mockState.connectImpl(options);
    }
    async end() {}
    async list() {
      return [];
    }
    async get() {
      return Buffer.alloc(0);
    }
    async put() {}
    async delete() {}
    async safeDelete() {}
    async rename() {}
    async createExclusive() {}
    async exists() {
      return false;
    }
  },
}));

import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { runProtocol } from "../../src/protocol";

// runExchange/buildOutputTable are never reached on these failure paths, so the
// prepared value is unused.
const minimalPrepared = {} as unknown as PreparedExchange;

// runProtocol constructs a real FileSyncConnection, which logs through the
// (un-mocked) getLoggerForVerbosity. Run it under withCapturedLogs so that
// connection-level chatter is captured rather than leaked to the suite output;
// runProtocol's own logs still reach mockState through the mocked getLogger. The
// failure-path rejection propagates unchanged (withCapturedLogs rethrows), so
// callers still assert `.rejects`.
function runProtocolCapturingConnLogs(
  ...args: Parameters<typeof runProtocol>
): Promise<void> {
  return withCapturedLogs(() => runProtocol(...args)).then(() => {});
}

function sftpConfig(host: string) {
  return {
    channel: "sftp" as const,
    server: { host },
    // A short peer-wait budget so the lone-party synchronize times out promptly
    // on the cleanup-sink test; harmless on the host-log test (connect rejects
    // first).
    options: { pollIntervalMs: 1, peerTimeoutMs: 300 },
  };
}

beforeEach(() => {
  mockState.infos.length = 0;
  mockState.warnings.length = 0;
  mockState.debugs.length = 0;
  mockState.errors.length = 0;
  mockState.connectImpl = async () => {};
});

// --- Host log (info sink) ----------------------------------------------------

test("routes a partner-controlled SFTP host through sanitizeForDisplay before logging", async () => {
  // The host on an offline-accept-seeded config comes from the partner's
  // invitation endpoint (charset-unconstrained), so a control/ANSI/bidi-laden
  // value must be escaped before it reaches the operator's terminal. The log
  // fires before conn.open(), so a rejecting connect still exercises it.
  mockState.connectImpl = async () => {
    throw new Error("connect refused");
  };
  const hostileHost = "\x1b[31mevil.example‮com";

  await expect(
    runProtocolCapturingConnLogs(
      sftpConfig(hostileHost),
      null,
      minimalPrepared,
      undefined,
      -1,
      "t",
    ),
  ).rejects.toThrow();

  const hostLine = mockState.infos.find((m) =>
    m.startsWith("opening connection to"),
  );
  expect(hostLine).toBeDefined();
  // Escaped form is present; the raw ESC and bidi-override bytes are gone.
  expect(hostLine).toContain("\\x1b[31mevil.example\\u202ecom");
  expect(hostLine).not.toContain("\x1b");
  expect(hostLine).not.toContain("‮");
});

test("leaves an ordinary printable SFTP host unchanged", async () => {
  mockState.connectImpl = async () => {
    throw new Error("connect refused");
  };

  await expect(
    runProtocolCapturingConnLogs(
      sftpConfig("sftp.example.com"),
      null,
      minimalPrepared,
      undefined,
      -1,
      "t",
    ),
  ).rejects.toThrow();

  expect(
    mockState.infos.some((m) =>
      m.includes("opening connection to sftp.example.com with options"),
    ),
  ).toBe(true);
});

// --- Filedrop path log (info sink) -------------------------------------------

test("routes a partner-seeded filedrop path through sanitizeForDisplay before logging", async () => {
  // The filedrop path on an offline-accept-seeded config comes from the partner's
  // invitation endpoint too (charset-unconstrained). The log fires before
  // conn.open(), and a nonexistent path makes the real LocalFSClient reject so
  // the run still ends. (This branch uses LocalFSClient, not the mocked adapter.)
  const hostilePath = "/srv/\x1b[31mevil‮drop-does-not-exist";

  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: hostilePath,
        options: { pollIntervalMs: 1, peerTimeoutMs: 300 },
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "t",
    ),
  ).rejects.toThrow();

  const pathLine = mockState.infos.find((m) =>
    m.startsWith("opening local path"),
  );
  expect(pathLine).toBeDefined();
  expect(pathLine).toContain("/srv/\\x1b[31mevil\\u202edrop-does-not-exist");
  expect(pathLine).not.toContain("\x1b");
  expect(pathLine).not.toContain("‮");
});

// --- Cleanup error sinks (render sanitizeErrorForDisplay, not the raw Error) --
//
// conn.close() is non-throwing by design -- FileSyncConnection swallows a failed
// end() and logs it through its own logger -- so the protocol-layer cleanup
// catches (the debug `mc.close()` sink and the warn `failed to close connection`
// sink) are defensive against an unexpected close() rejection. Spy close() to
// reject so those catches run, and synchronize() to reject so doCleanup is
// reached promptly after a successful open (opened === true, which selects the
// warn branch).

test("renders a hostile close error through sanitizeErrorForDisplay in the cleanup logs", async () => {
  const syncSpy = vi
    .spyOn(FileSyncConnection.prototype, "synchronize")
    .mockRejectedValue(new Error("synchronize aborted"));
  const closeSpy = vi
    .spyOn(FileSyncConnection.prototype, "close")
    .mockRejectedValue(new Error("ENOENT: open '/srv/\x1b[31mEVIL\r\n‮FAKE'"));

  try {
    await expect(
      runProtocolCapturingConnLogs(
        sftpConfig("sftp.example.com"),
        null,
        minimalPrepared,
        undefined,
        -1,
        "t",
      ),
    ).rejects.toThrow();

    const escaped = "ENOENT: open '/srv/\\x1b[31mEVIL\\x0d\\x0a\\u202eFAKE'";
    // The warn path (failed close while opened) renders the sanitized string...
    const warnLine = mockState.warnings.find((m) =>
      m.includes("during cleanup"),
    );
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain(escaped);
    // ...and so does a debug path (the mc.close() catch).
    expect(mockState.debugs.some((m) => m.includes(escaped))).toBe(true);
    // No raw dangerous bytes survive: no ESC, no CR, no LF, no bidi RLO.
    expect(warnLine).not.toContain("\x1b");
    expect(warnLine).not.toContain("\r");
    expect(warnLine).not.toContain("\n");
    expect(warnLine).not.toContain("‮");
  } finally {
    syncSpy.mockRestore();
    closeSpy.mockRestore();
  }
});

test("leaves an ordinary close error message intact (only control bytes are escaped)", async () => {
  const syncSpy = vi
    .spyOn(FileSyncConnection.prototype, "synchronize")
    .mockRejectedValue(new Error("synchronize aborted"));
  const closeSpy = vi
    .spyOn(FileSyncConnection.prototype, "close")
    .mockRejectedValue(new Error("connection reset by peer"));

  try {
    await expect(
      runProtocolCapturingConnLogs(
        sftpConfig("sftp.example.com"),
        null,
        minimalPrepared,
        undefined,
        -1,
        "t",
      ),
    ).rejects.toThrow();

    expect(
      mockState.warnings.some((m) => m.includes("connection reset by peer")),
    ).toBe(true);
  } finally {
    syncSpy.mockRestore();
    closeSpy.mockRestore();
  }
});

test("renders a hostile close error through sanitizeErrorForDisplay in the opened===false cleanup debug sink", async () => {
  // When open() fails (connect rejects, so opened stays false) and close() then
  // rejects, the cleanup catch takes the debug "conn.close() during cleanup"
  // else-branch rather than the warn branch. It must still render the sanitized
  // string. (Covers the other cleanup catch from the one the warn test above hits.)
  mockState.connectImpl = async () => {
    throw new Error("connect refused");
  };
  const closeSpy = vi
    .spyOn(FileSyncConnection.prototype, "close")
    .mockRejectedValue(new Error("teardown failed: /srv/\x1b[31mX‮Y"));

  try {
    await expect(
      runProtocolCapturingConnLogs(
        sftpConfig("sftp.example.com"),
        null,
        minimalPrepared,
        undefined,
        -1,
        "t",
      ),
    ).rejects.toThrow();

    const escaped = "teardown failed: /srv/\\x1b[31mX\\u202eY";
    const elseLine = mockState.debugs.find((m) =>
      m.includes("conn.close() during cleanup:"),
    );
    expect(elseLine).toBeDefined();
    expect(elseLine).toContain(escaped);
    expect(elseLine).not.toContain("\x1b");
    expect(elseLine).not.toContain("‮");
  } finally {
    closeSpy.mockRestore();
  }
});
