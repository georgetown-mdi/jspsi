import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";
import type { PreparedExchange } from "@psilink/core";

// Shared state readable inside the vi.mock factory despite ESM hoisting.
const mockState = vi.hoisted(() => ({
  dropDir: "",
  // Captured log output from the mock getLogger returned to runProtocol.
  infos: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  // Two-party barrier counter for the abort-marker echo tests: each party
  // increments on entering the (mocked) runExchange, and the mock waits for both
  // before injecting its fault, so the first party to fail cannot tear down files
  // the second still needs to finish its own handshake.
  runExchangeEntries: 0,
  // Constructor options the mock SFTP adapter last received, so a test can assert
  // runProtocol threads connection_per_poll into the adapter's ephemeralSessions.
  lastSftpAdapterOptions: undefined as Record<string, unknown> | undefined,
}));

// Keep FileSyncConnection and authenticateConnection real so the key exchange runs over a
// real file-drop connection. Mock only the PSI exchange layer, which would
// otherwise require the full WASM stack and a prepared dataset.
vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Default runExchange mock implementation. Polls the drop directory until it
// is empty before resolving: the receiver's poller deletes each message file
// after consuming it, so an empty directory is a deterministic signal that the
// peer has consumed the final key-exchange message - no fixed sleep required. .hello
// and -lock.json files from synchronize() are ignored; after the lock race the
// winner's lock file remains until cleanup() runs in the finally block (after
// runExchange returns), so it may still be present while this mock polls for
// .json files. These files are harmless residue and will not be consumed by
// the message poller. The wait is on the peer, so it takes the same backstop as
// the peer budget the two-party cases run under rather than one of its own.
async function defaultRunExchange(): Promise<unknown> {
  const { readdir } = await import("node:fs/promises");
  const deadline = Date.now() + PEER_WAIT_HANG_BACKSTOP_MS;
  while (mockState.dropDir) {
    let jsonFiles: string[];
    try {
      const all = await readdir(mockState.dropDir);
      jsonFiles = all.filter((f) => f.endsWith(".json"));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    if (jsonFiles.length === 0) break;
    if (Date.now() > deadline)
      throw new Error(
        "runExchange mock timed out waiting for .json files to clear",
      );
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  return { associationTable: [[], []], partnerPayload: {} };
}

// Block a mocked runExchange until BOTH key files hold a rotated (non-original)
// token. The recovery-path tests throw from runExchange to land a synthetic
// fault in runProtocol's catch; waiting for both rotations first guarantees the
// key exchange has finished on both sides (and its last message file is off
// disk) before either party's doCleanup runs, so no cleanup races the peer's
// still-pending receive. Bounded so a lone arrival cannot hang, on the same
// peer-wait backstop the two-party cases run under.
async function waitForBothKeysRotated(
  keyFileA: string,
  keyFileB: string,
): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const deadline = Date.now() + PEER_WAIT_HANG_BACKSTOP_MS;
  for (;;) {
    try {
      const a = JSON.parse(readFileSync(keyFileA, "utf8")).sharedSecret;
      const b = JSON.parse(readFileSync(keyFileB, "utf8")).sharedSecret;
      if (a !== TOKEN_A && b !== TOKEN_A) break;
    } catch {
      // file may not exist yet; retry
    }
    if (Date.now() > deadline)
      throw new Error("timed out waiting for both key files to rotate");
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Assert neither of runProtocol's two generic recovery-advisory lines was
// logged. A tagged (psilinkRecoveryHintEmitted) error must suppress both, since
// each would contradict the error's own specific hint.
function expectNoGenericRecoveryAdvisory(errors: readonly string[]): void {
  expect(errors.every((m) => !m.includes("key exchange was in progress"))).toBe(
    true,
  );
  expect(errors.every((m) => !m.includes("already rotated and saved"))).toBe(
    true,
  );
}

// Poll dropDir until B's rendezvous (-hello) file appears, then backdate every
// entry's mtime by 3 s. Party B is started first; making its mtime strictly
// older than A's forces B to be the responder even on coarse-mtime filesystems
// (FAT/some NFS), where same-bucket timestamps would fall back to UUID
// comparison and could assign roles unexpectedly. The ENOENT tolerance covers a
// file that raced ahead of B's synchronize and was already deleted. The wait is
// on the other party, so it takes the shared peer-wait backstop.
async function backdateDropDirRendezvousFile(dropDir: string): Promise<void> {
  const deadline = Date.now() + PEER_WAIT_HANG_BACKSTOP_MS;
  for (;;) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dropDir);
    } catch (e) {
      throw new Error(
        `dropDir became unavailable while polling B's rendezvous: ` +
          (e as Error).message,
      );
    }
    if (entries.length > 0) {
      const past = new Date(Date.now() - 3_000);
      for (const f of entries) {
        try {
          fs.utimesSync(path.join(dropDir, f), past, past);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      return;
    }
    if (Date.now() > deadline)
      throw new Error("timed out waiting for B to write its rendezvous file");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    // Replace getLogger so that runProtocol's log.warn / log.error calls are
    // captured in mockState and can be asserted by individual tests. The
    // logger is only used for informational output; replacing it does not
    // affect key-exchange or PSI correctness.
    getLogger: (_name: string) => ({
      info: (msg: string, ...args: unknown[]) => {
        mockState.infos.push([msg, ...args.map(String)].join(" "));
      },
      warn: (msg: string, ...args: unknown[]) => {
        mockState.warnings.push([msg, ...args.map(String)].join(" "));
      },
      error: (msg: string, ...args: unknown[]) => {
        mockState.errors.push([msg, ...args.map(String)].join(" "));
      },
      debug: () => {},
      trace: () => {},
    }),
    runExchange: vi.fn().mockImplementation(defaultRunExchange),
    // The record a terminated run hands back on its error, and the predicate for
    // the case where one was owed and its build threw. Core marks the error
    // inside runExchange, which is mocked here, so both accessors are mocked
    // alongside it; their defaults are the real ones' answers for an error
    // carrying neither mark, which is every other test in this file.
    exchangeRecordFromFailure: vi.fn().mockReturnValue(undefined),
    exchangeRecordOwedButUnbuilt: vi.fn().mockReturnValue(false),
    describeExchangeStages: vi.fn().mockReturnValue([]),
    buildOutputTable: vi.fn().mockReturnValue({ headers: [], rows: [] }),
  };
});

// Replace the SFTP adapter with a transport mock whose connect() drives the
// configured hostVerifier with a fixed ssh-ed25519 key blob (as ssh2 would) and
// rejects with ssh2's host-denied message when the verifier refuses -- the same
// harness core's fileSyncConnection host-key tests use. This lets an
// sftp-channel runProtocol exercise the REAL host-key verification wrap in core
// (the security classification under test) with no live SSH connection. Only
// the sftp-channel test below constructs this class; every other test in this
// file runs filedrop, which never touches the adapter.
vi.mock("../../src/connection/ssh2SftpAdapter", () => {
  // A raw OpenSSH ssh-ed25519 host-key blob: uint32 len + "ssh-ed25519" +
  // uint32 len + 32 key bytes, matching what ssh2 hands hostVerifier.
  const keyTypeBytes = Buffer.from("ssh-ed25519");
  const keyBytes = Buffer.alloc(32, 7);
  const blob = Buffer.alloc(4 + keyTypeBytes.length + 4 + keyBytes.length);
  blob.writeUInt32BE(keyTypeBytes.length, 0);
  keyTypeBytes.copy(blob, 4);
  blob.writeUInt32BE(keyBytes.length, 4 + keyTypeBytes.length);
  keyBytes.copy(blob, 4 + keyTypeBytes.length + 4);

  const notImplemented = (op: string) => () =>
    Promise.reject(new Error(`mock sftp adapter: ${op} not implemented`));

  class MockHostKeySftpAdapter {
    constructor(options: Record<string, unknown> = {}) {
      mockState.lastSftpAdapterOptions = options;
    }
    connect(options: Record<string, unknown>): Promise<void> {
      const verifier = options["hostVerifier"] as
        | ((keyBlob: Buffer, verify: (permitted: boolean) => void) => void)
        | undefined;
      return new Promise<void>((resolve, reject) => {
        if (verifier === undefined) {
          resolve();
          return;
        }
        verifier(blob, (permitted: boolean) => {
          if (permitted) resolve();
          else reject(new Error("Host denied (verification failed)"));
        });
      });
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
    safeDelete(): Promise<void> {
      return Promise.resolve();
    }
    list = notImplemented("list");
    get = notImplemented("get");
    put = notImplemented("put");
    delete = notImplemented("delete");
    rename = notImplemented("rename");
    createExclusive = notImplemented("createExclusive");
    exists = notImplemented("exists");
  }
  return { SSH2SFTPClientAdapter: MockHostKeySftpAdapter };
});

import {
  buildOutputTable,
  parseDualSignedRecord,
  parseExchangeRecord,
  parseVerificationKeys,
  runExchange,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
  PeerAbortError,
  ConnectionError,
  FrameSizeExceededError,
  InternalConsistencyError,
  InvitationTermDivergenceError,
  FileSyncConnection,
  fromEventConnection,
  authenticateConnection,
  generateSigningIdentity,
  OperatorConfigError,
  ReceiptVerificationError,
  isPeerWaitTimeout,
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  AEAD_ENVELOPE_VERSION,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  describeResolvedRunShape,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@psilink/core";
import type {
  AssociationTable,
  DualSignedRecord,
  ExchangeRecord,
  PartnerPayload,
  ResolvedRunShape,
  VerificationKeys,
} from "@psilink/core";
import {
  runProtocol,
  PEER_SILENCE_GUIDANCE,
  BOTH_SWEPT_GUIDANCE,
  SIGNING_WITHOUT_RECORD_WARNING,
  TERMINATED_RECORD_UNBUILT_WARNING,
  entryHelloResidueGuidance,
  type RunProtocolResult,
  type SigningPersist,
} from "../../src/protocol";
import {
  reportPersistenceLoss,
  type EventStreamEmitter,
} from "../../src/eventStream";
import { keysPathFor, type RecordOutput } from "../../src/recordFile";
import { openEventStreamWithFdWired } from "../eventStreamTestSupport";
import { exitCodeForError, runOrExit } from "../../src/util/exit";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import { LocalFSClient } from "../../src/connection/localFSClient";

// 32 zero bytes in base64url (43 chars, no padding).
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// 32 0x01 bytes in base64url: a second valid token for the mismatched-secret case.
const TOKEN_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

// A fixed signing identity for the runProtocol-level warn-gate tests below. Its
// content is never verified in these tests (runExchange is mocked), so any valid
// identity will do.
const signingIdentityFixture = await generateSigningIdentity("test-party", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "JHWxrL6MWMbpKlF5G-EULYpHJ5M6PnEdleg66V0RCvo",
    y: "ZQuEikGWXN5_AKJYN-xh_HjLnqrQG4QpVkzPocFYbJg",
    d: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw",
  },
});

// Values unused because runExchange and buildOutputTable are mocked.
const minimalPrepared = {} as unknown as PreparedExchange;

// The peer budget every two-party case in this file gives both parties, and the
// 20 s bound each of those cases carries as its own timeout. Neither is a timing
// assertion: the two parties start together and meet in milliseconds, and each
// case settles its outcome through the mocked runExchange, so nothing here waits
// for either to elapse on a healthy run.
//
// The budget bounds every wait before the exchange, and the teardown drain and
// close, which core caps at min(their own bound, this). At the default -- one
// hour -- a party still waiting on a partner that failed its own rendezvous
// outlives its case's bound and is killed by vitest with a generic message in
// place of the core layer's own diagnosable timeout; sized near the milliseconds
// a rendezvous actually costs, it settles the outcome by how promptly a loaded
// machine schedules the two parties against each other instead. Under a full
// unit-project run on an idle ten-core container the two-party cases here
// measure single-digit to low-hundred milliseconds apiece, and 1.6 s at worst
// across 28 runs with unrelated builds competing for the same cores, so both
// values stay an order of magnitude clear of the worst measured case and a later
// tightening has that measurement to start from.
//
// The bound sits five seconds above the budget rather than at it, so a run that
// burns the whole budget still surfaces that budget's own diagnosable timeout.
// Each case spells the bound as a literal third argument to test(), because
// prettier keeps a test's callback hugged only for a numeric-literal timeout;
// the cases that also hold both parties at a barrier spell the same 20 s as
// BOTH_ARMED_HANG_BACKSTOP_MS + 5_000, the wait their run actually sits in.
//
// A second group carries that same 20 s for a different reason: the four cases
// that point a filedrop connection at a path which does not exist, to end the
// run after the part they assert about. The local-FS connect reads that ENOENT
// as the transient a share whose permissions are still settling raises, and
// re-attempts it maxReconnectAttempts times on a fixed one-second delay, so each
// of them spends three seconds inside a retry schedule none of them is about.
// The floor is timer-driven and barely moves under load -- 3.01 s idle, 3.15 s
// at worst pinned to a contended core -- but it leaves the 5 s default under two
// seconds for everything else the case does, the thinnest margin in this file,
// and what the default buys once that runs out is a bare test timeout in place
// of the rejection the case reads.
const PEER_WAIT_HANG_BACKSTOP_MS = 15_000;

// Both parties of every two-party case: a 1 ms poll so the rendezvous and key
// exchange settle without waiting on the polling cadence, and the budget above
// in place of the one-hour default.
const TWO_PARTY_OPTIONS = {
  pollIntervalMs: 1,
  peerTimeoutMs: PEER_WAIT_HANG_BACKSTOP_MS,
};

// The peer budget for the lone-party cases that wait for a partner who never
// arrives: each spends it in full, so it is what that case costs, and core
// races every single transport op against a fresh copy of it as well. That
// second role is what sizes it. A budget near the cost of one loaded transport
// op is spent by that op instead, and the run then reports a stalled-transport
// error rather than the peer-silence timeout these cases read their advice off
// -- a misreport, not a failure of the thing under test. On a container whose
// cores are contended a single local-FS op has been measured at 196 ms, so this
// stands an order of magnitude above it, and short enough that a case spending
// it once still costs about two seconds.
//
// A case whose party reaches teardown holding a frame no peer ever consumed
// spends it a second time, the terminal-frame drain capping itself at min(its
// own bound, this): the entry-hello residue cases below measure about four
// seconds apiece and so spell a 20 s bound of their own, vitest's 5 s default
// leaving a budget spent twice under a second.
const LONE_PARTY_PEER_BUDGET_MS = 2_000;

let tmpDir: string;
let dropDir: string;

// fd-3 sentinel and capture: wrap writeSync so a write to the machine-interface
// descriptor (EVENT_STREAM_FD = 3) is captured into a buffer -- never delivered
// to the real descriptor, which the test process does not own -- while every
// other fd passes straight through to the real implementation. A test that runs
// under --event-stream drains the capture with takeFd3Lines() and asserts on the
// parsed events; afterEach then asserts the capture is EMPTY, which pins two
// requirements at once: a flag-off run writes nothing to fd 3 across every
// scenario in this file, and a flag-on test must account for every line it
// caused (so an unexpected extra emission -- a double terminal event -- fails
// the test that produced it).
const EVENT_STREAM_FD = 3;
let fd3Chunks: Buffer[];
let realWriteSync: typeof fs.writeSync;

// A persistence loss on a completed run moves the REAL process.exitCode (that is
// the contract: an unattended supervisor reads it), so every test here is fenced
// -- the value is snapshotted before each test and put back after, and a test
// that expects a loss asserts the code inside its own body, before this fires.
// Without the fence one such test would hand its 73 to the whole worker.
let exitCodeBeforeTest: typeof process.exitCode;

/** Drain the captured fd-3 bytes and return them parsed, one event per line. */
function takeFd3Lines(): Array<Record<string, unknown>> {
  const text = Buffer.concat(fd3Chunks).toString("utf8");
  fd3Chunks.length = 0;
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  exitCodeBeforeTest = process.exitCode;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-proto-integ-"));
  dropDir = path.join(tmpDir, "drop");
  mockState.dropDir = dropDir;
  mockState.infos.length = 0;
  mockState.warnings.length = 0;
  mockState.errors.length = 0;
  mockState.runExchangeEntries = 0;
  mockState.lastSftpAdapterOptions = undefined;
  fs.mkdirSync(dropDir);

  fd3Chunks = [];
  realWriteSync = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    ...args: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) {
      const [buffer, offset, length] = args as [Buffer, number, number];
      fd3Chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
      return length;
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, ...args);
  }) as typeof fs.writeSync);
});

afterEach(async () => {
  process.exitCode = exitCodeBeforeTest;
  // Empty on a flag-off run (nothing may reach fd 3 without --event-stream);
  // empty after a flag-on test too, because the test must have drained and
  // asserted every line it caused via takeFd3Lines().
  expect(fd3Chunks).toHaveLength(0);
  vi.mocked(fs.writeSync).mockRestore();
  // Clear any unconsumed mockImplementationOnce entries. When a test times out
  // before runExchange is called, the pending entry remains in the queue and
  // the next test receives a stale blocking promise instead of the default
  // polling implementation, causing it to hang indefinitely. mockReset() drains
  // the queue; mockImplementation() then restores the default polling behavior
  // for the next test.
  vi.mocked(runExchange).mockReset();
  vi.mocked(runExchange).mockImplementation(defaultRunExchange as never);
  vi.mocked(exchangeRecordFromFailure).mockReset();
  vi.mocked(exchangeRecordFromFailure).mockReturnValue(undefined);
  vi.mocked(exchangeRecordOwedButUnbuilt).mockReset();
  vi.mocked(exchangeRecordOwedButUnbuilt).mockReturnValue(false);
  mockState.dropDir = "";
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Peer-silence guidance ---------------------------------------------------

// The receiver names its own cause locally, but the remote sender only sees the
// inactivity timeout, so it surfaces guidance about likely receiver-side causes.
// runProtocol threads this text to fromEventConnection's inactivityHint, which
// the core layer appends to the peer-silence error (the append mechanism is
// pinned in packages/core/test/messageConnection.test.ts). This pins the wording
// itself.
test("PEER_SILENCE_GUIDANCE names likely receiver-side causes without overclaiming", () => {
  // Names the two probable receiver-side faults.
  expect(PEER_SILENCE_GUIDANCE).toContain("exited");
  expect(PEER_SILENCE_GUIDANCE).toContain("unwritable");
  // Directs the operator to where the real cause was recorded.
  expect(PEER_SILENCE_GUIDANCE).toContain("logs");
  // Hedges rather than asserting a single definite cause (no overclaim).
  expect(PEER_SILENCE_GUIDANCE).toContain("may have");
  // Notes the slow-large-dataset case so the timeout is not misread as a death.
  expect(PEER_SILENCE_GUIDANCE).toContain("--peer-timeout");
});

// --- Pre-flight validation ---------------------------------------------------

test("rejects before opening a connection when keyFilePath is whitespace-only", async () => {
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
      },
      { sharedSecret: TOKEN_A, keyFilePath: "   " },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow("non-empty keyFilePath");
});

test("rejects before opening a connection when saveIntent is passed on an authenticated exchange", async () => {
  // saveIntent drives the zero-setup `--save` bootstrap, which is meaningful
  // only on the unauthenticated path. Passing it alongside authentication is a
  // misuse: the guard must reject it up front, before any connection is opened
  // (and before the keyFilePath pre-flight), so a stray save field never rides
  // the authenticated channel.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
      },
      {
        sharedSecret: TOKEN_A,
        keyFilePath: path.join(tmpDir, "k.key"),
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
      undefined,
      true,
    ),
  ).rejects.toThrow("only valid on an unauthenticated");
});

test("rejects before opening a connection when onAuthenticated is passed on an unauthenticated exchange", async () => {
  // onAuthenticated hooks the moment of acceptance, which exists only on the
  // authenticated path; its invocation is nested inside the `if (auth)` block.
  // Passing it with `authentication: null` is a misuse: the guard must reject it
  // up front rather than silently dropping the hook so the write never runs.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test",
      undefined,
      undefined,
      () => {
        /* never invoked: the guard rejects before the hook would fire */
      },
    ),
  ).rejects.toThrow("only valid on an authenticated exchange");
});

test.skipIf(process.getuid?.() === 0)(
  "rejects before opening a connection when keyFilePath parent is not writable",
  async () => {
    // 0o555 = r-x for all; the current user cannot write into the directory, so
    // saveKeyFile would fail after the key exchange. The pre-flight should catch
    // this. Root bypasses mode bits, so the probe would succeed there instead.
    const readOnlyDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o555);
    try {
      await expect(
        runProtocol(
          {
            channel: "filedrop",
            path: dropDir,
          },
          {
            sharedSecret: TOKEN_A,
            keyFilePath: path.join(readOnlyDir, "key.json"),
          },
          minimalPrepared,
          undefined,
          -1,
          "test",
        ),
      ).rejects.toThrow("not writable");
    } finally {
      // Restore mode so afterEach can rm -rf the tmp dir.
      fs.chmodSync(readOnlyDir, 0o755);
    }
  },
);

test("rejects before opening a connection when keyFilePath parent exists but is a regular file", async () => {
  // statSync resolves the parent successfully but isDirectory() returns false.
  // Without the dedicated branch in runProtocol the failure would not surface
  // until saveKeyFile attempted fs.mkdirSync on a non-directory path.
  const fileParent = path.join(tmpDir, "not-a-dir");
  fs.writeFileSync(fileParent, "");
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
      },
      {
        sharedSecret: TOKEN_A,
        keyFilePath: path.join(fileParent, "key.json"),
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow("exists but is not a directory");
});

test("creates the keyFilePath parent directory when it does not yet exist", async () => {
  // saveKeyFile calls mkdirSync({ recursive: true }), so a keyFilePath whose
  // parent does not exist is a valid configuration that the pre-flight must
  // accept. The pre-flight mirrors that behavior by creating the directory.
  const createdParent = path.join(tmpDir, "newly-created", "nested");
  expect(fs.existsSync(createdParent)).toBe(false);
  // authentication: null skips runProtocol's authentication branch, but the keyFilePath
  // probe runs only when authentication is set. To exercise the probe and
  // still abort before the full exchange, point dropDir at a path that
  // localFSClient cannot open so runProtocol throws after the probe runs.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: "/nonexistent-path-that-cannot-exist-psilink-test",
      },
      {
        sharedSecret: TOKEN_A,
        keyFilePath: path.join(createdParent, "key.json"),
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow();
  // The probe succeeded only if the parent was created.
  expect(fs.existsSync(createdParent)).toBe(true);
}, 20_000);

test("rejects before opening a connection when keyFilePath itself is a directory", async () => {
  // Pre-flight must reject when keyFilePath points at an existing directory:
  // saveKeyFile's renameSync would fail post-handshake (after the partner
  // may have already rotated), forcing an unnecessary re-invitation.
  const keyDirAsFile = path.join(tmpDir, "key-as-directory");
  fs.mkdirSync(keyDirAsFile);
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
      },
      {
        sharedSecret: TOKEN_A,
        keyFilePath: keyDirAsFile,
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow("not a regular file");
});

test("does not mutate the caller-supplied auth object when trimming whitespace from keyFilePath", async () => {
  // A keyFilePath of "  ./key  " is almost certainly a user typo and must
  // not produce a file with literal whitespace in its name. The pre-flight
  // uses the trimmed value internally without mutating the caller's auth
  // object, so the supplied reference is observable as the caller passed it.
  const realKey = path.join(tmpDir, "real-key.json");
  const originalPath = `  ${realKey}  `;
  const auth = {
    sharedSecret: TOKEN_A,
    keyFilePath: originalPath,
  };
  // Force the run to fail after the pre-flight runs by pointing dropDir at
  // a non-existent path; the pre-flight write probe must succeed (which
  // requires the trimmed path to be usable) for the test to be meaningful.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: "/nonexistent-path-that-cannot-exist-psilink-test",
      },
      auth,
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow();
  expect(auth.keyFilePath).toBe(originalPath);
}, 20_000);

test.skipIf(process.platform === "win32")(
  "rejects before opening a connection when keyFilePath parent is a dangling symlink",
  async () => {
    // statSync follows symlinks, so a dangling-symlink parent surfaces as
    // ENOENT. The lstat probe distinguishes "dangling symlink" from "missing
    // path" and the message must include the dangling-symlink hint.
    // symlink semantics differ on Win
    const target = path.join(tmpDir, "missing-target");
    const link = path.join(tmpDir, "dangling-link");
    fs.symlinkSync(target, link);
    await expect(
      runProtocol(
        {
          channel: "filedrop",
          path: dropDir,
        },
        {
          sharedSecret: TOKEN_A,
          keyFilePath: path.join(link, "key.json"),
        },
        minimalPrepared,
        undefined,
        -1,
        "test",
      ),
    ).rejects.toThrow("dangling");
  },
);

test("rejects and cleans up when conn.open() itself throws (opened=false cleanup path)", async () => {
  // Uses a path that does not exist so that LocalFSClient.connect() ->
  // fs.access() throws ENOENT. open() rejects before opened=true, exercising
  // the doCleanup branch where close() runs idempotently on a connection that
  // was never opened (no teardown to perform).
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: "/nonexistent-path-that-cannot-exist-psilink-test",
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow();
}, 20_000);

// --- Unauthenticated exchange paths ------------------------------------------

test("authentication=null runs the exchange without authentication and without error", async () => {
  // Zero-setup path: authentication: null tells runProtocol to skip authentication and
  // emit no warning. Output is left undefined so writeOutput writes to stdout
  // rather than a temp file whose parent may be deleted before the stream
  // flushes.
  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);
  // No assertion on key files: no rotation occurs when auth is null.
}, 20_000);

// --- The resolved run shape, named at the pre-round seam ---------------------

// A runExchange that fires the pre-round seam with one resolved shape and then
// finishes like the default, or with `settled` where the configuration under test
// ends somewhere else. Both parties get it -- runProtocol's rendering is
// per-party -- so each renders the shape handed to it, and only the party under
// --event-stream puts its lines on fd 3.
function runExchangeConfirming(
  runShape: ResolvedRunShape,
  settled?: Record<string, unknown>,
) {
  return async (
    _conn: unknown,
    _role: unknown,
    _prepared: unknown,
    options: {
      onProtocolConfirmed?: (
        partnerTerms: unknown,
        resolvedRole: unknown,
        shape: ResolvedRunShape,
      ) => void;
    },
  ): Promise<unknown> => {
    options.onProtocolConfirmed?.(
      { identity: "Party B" },
      "receiver",
      runShape,
    );
    const byDefault = await defaultRunExchange();
    return settled ?? byDefault;
  };
}

test("names a deduplicating cardinality and warns on an over-bound projection", async () => {
  // 3,163 records a side projects 10,004,569 pairs, past the advisory bound. The
  // run continues -- nothing refuses on a projection -- so both notices must
  // reach the operator while the run is still going: on stderr, and on the
  // machine-interface stream a supervisor or a console seat reads instead of it.
  const runShape: ResolvedRunShape = {
    cardinality: "many-to-many",
    localRecordCount: 3163,
    localDeclaredRecordCount: 3163,
    partnerRecordCount: 3163,
    localExpectsOutput: true,
    partnerAssociationTableWithheld: false,
  };
  const { cardinalityNotice, pairTableAdvisory } =
    describeResolvedRunShape(runShape);
  vi.mocked(runExchange).mockImplementation(
    runExchangeConfirming(runShape) as never,
  );
  mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // Composed by core and rendered here unchanged, so the CLI and the browser
  // seats cannot drift into two wordings of the one fact.
  expect(mockState.warnings).toContain(cardinalityNotice);
  expect(mockState.warnings).toContain(pairTableAdvisory);
  expect(pairTableAdvisory).toContain("10,004,569");

  // Both ride the warning event, ahead of the terminal one, and in the order
  // they were raised.
  const lines = takeFd3Lines();
  expect(lines.map((l) => l.type)).toEqual([
    "stages",
    "warning",
    "warning",
    "metrics",
    "result",
  ]);
  expect(lines[1].message).toBe(cardinalityNotice);
  expect(lines[2].message).toBe(pairTableAdvisory);
}, 20_000);

test("leaves the pre-round seam silent on a one-to-one run", async () => {
  // The cardinality that adds no multiplicity is the one every consent surface
  // already describes, so naming it here would be noise on the ordinary run.
  vi.mocked(runExchange).mockImplementation(
    runExchangeConfirming({
      cardinality: "one-to-one",
      localRecordCount: 3163,
      localDeclaredRecordCount: 3163,
      partnerRecordCount: 3163,
      localExpectsOutput: true,
      partnerAssociationTableWithheld: false,
    }) as never,
  );
  await Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  expect(mockState.warnings).toStrictEqual([]);
}, 20_000);

test("tells a non-receiving party what the run's completion tells it too", async () => {
  // The contradiction this closes, end to end on one seat: only the declaring
  // "many" party is required to expect output, so the "one" party of a
  // one-to-many run can legitimately receive none, and a pre-round notice naming
  // its result file meets the same run's completion line ("you receive no
  // result, so no result file was written") minutes later.
  vi.mocked(runExchange).mockImplementation(
    runExchangeConfirming(
      {
        cardinality: "one-to-many",
        localRecordCount: 4,
        localDeclaredRecordCount: 4,
        partnerRecordCount: 6,
        localExpectsOutput: false,
        partnerAssociationTableWithheld: false,
      },
      // What core hands a party its terms give no output: no association table,
      // which is what the completion line below reads.
      { associationTable: undefined, partnerPayload: {} },
    ) as never,
  );
  const output = path.join(tmpDir, "no-output-party.csv");

  await runBothHalves(output);

  const notice = mockState.warnings.find((line) =>
    line.includes("one-to-many"),
  );
  expect(notice).toContain("you receive no result from this run");
  expect(notice).not.toContain("Your result file");
  // The two lines the one run puts in front of the same operator agree.
  expect(
    mockState.infos.some((line) => line.includes("you receive no result")),
  ).toBe(true);
  expect(fs.existsSync(output)).toBe(false);
}, 20_000);

// --- Self-attested record persistence via runProtocol ------------------------

const sampleRecord: ExchangeRecord = {
  version: "psilink-exchange-record/v6",
  outcome: "completed",
  createdAt: "2026-01-02T03:04:05.000Z",
  termsHash: "hQi6gjL9Z0RFtfz2TZVqXmUF1Cu8PaBFbClOJ9R8l_Q",
  localIdentity: "Party A",
  partnerIdentity: "Party B",
  governance: {
    algorithm: "psi",
    matchingBasis: [{ name: "ssn", type: "ssn" }],
    payloadSent: [],
    payloadReceived: [],
  },
  recordsExposed: 5,
  bindingNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  commitments: {
    localPayloadSent: "We5eIlrtkWBUe1uSGrla5rvLs0YhGFPPVDjk4EPX2k8",
    partnerPayloadReceived: "IFfNSyYoX8tKe2k-o6TjmrS1sW1ndtpZjexzR-fZa5g",
  },
};
const sampleKeys: VerificationKeys = {
  version: "psilink-exchange-keys/v1",
  salts: {
    localPayloadSent: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    partnerPayloadReceived: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  },
};
const audit = { record: sampleRecord, keys: sampleKeys };

// Drain the drop directory exactly as the default mock does (so neither party's
// cleanup races the other's poller), then return the audit alongside the usual
// fields.
async function runExchangeWithAudit(): Promise<unknown> {
  const base = (await defaultRunExchange()) as Record<string, unknown>;
  return { ...base, audit };
}

test("writes the self-attested record and verification keys when runExchange returns an audit", async () => {
  // Covers the record-write wiring in runProtocol (the runExchange audit ->
  // writeExchangeRecord call), which the default mock leaves unexercised by
  // returning no audit. Each party's runExchange returns a built audit and is
  // given its own record output paths; both the record and its keys must land
  // on disk and round-trip the schema parsers.
  vi.mocked(runExchange).mockImplementation(runExchangeWithAudit as never);

  const recordA = path.join(tmpDir, "rec-a.json");
  const recordB = path.join(tmpDir, "rec-b.json");
  const keysA = path.join(tmpDir, "rec-a.keys.json");
  const keysB = path.join(tmpDir, "rec-b.keys.json");

  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
      { recordFile: recordA },
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
      { recordFile: recordB },
    ),
  ]);

  for (const [rec, keyPath] of [
    [recordA, keysA],
    [recordB, keysB],
  ] as const) {
    expect(
      parseExchangeRecord(JSON.parse(fs.readFileSync(rec, "utf8"))),
    ).toEqual(sampleRecord);
    expect(
      parseVerificationKeys(JSON.parse(fs.readFileSync(keyPath, "utf8"))),
    ).toEqual(sampleKeys);
  }
}, 20_000);

test("a record the run was asked for and could not write warns on fd 3 and exits 73", async () => {
  // The unattended case: records are enabled, the exchange and its results
  // succeed, and the record write fails (here on a path whose parent is a
  // regular file). A supervisor that discards stderr -- or an operator at
  // --log-level error, which suppresses the warn -- would otherwise read a clean
  // exit 0 for a run that produced no audit artifact. Both machine channels must
  // carry it: a warning event ahead of the terminal event, and the
  // persistence-loss exit code (73, EX_CANTCREAT) -- asserted as the literal the
  // exit-code contract in docs/CLI.md publishes, not as 69, which tells a
  // supervisor the exchange did not happen and may be retried. The terminal
  // event stays `result`: the exchange succeeded and must not be re-run.
  const blocker = path.join(tmpDir, "blocker");
  fs.writeFileSync(blocker, "x");
  vi.mocked(runExchange).mockImplementation(runExchangeWithAudit as never);
  mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        { recordFile: path.join(blocker, "rec-a.json") },
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
        { recordFile: path.join(tmpDir, "rec-b.json") },
      ),
    ]);
    expect(process.exitCode).toBe(73);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // Only party A ran under --event-stream, so every captured line is its own.
  const lines = takeFd3Lines();
  expect(lines.map((l) => l.type)).toEqual([
    "stages",
    "warning",
    "metrics",
    "result",
  ]);
  expect(String(lines[1].message)).toContain(
    "the audit record could not be written to",
  );
  // The successful party is untouched: its record landed and its exit is clean.
  expect(fs.existsSync(path.join(tmpDir, "rec-b.json"))).toBe(true);
}, 20_000);

// The fixed text runProtocol reports when records were asked for and runExchange
// returned no audit. It names no destination -- none was ever resolved -- so it
// says instead that nothing was written and that the run must not be re-run.
const NO_RECORD_BUILT_WARNING =
  "no audit record could be built for this exchange, so none was written; " +
  "the exchange and its results succeeded and need not be re-run";

test(
  "a record that could not be built warns and exits non-zero",
  { timeout: 20_000 },
  async () => {
    // The other missing-artifact shape: records are enabled, the exchange and its
    // results succeed, and runExchange returns no audit at all -- the record could
    // not be BUILT, warned with its cause inside runExchange, which a supervisor
    // that discards stderr never sees. The default runExchange mock returns
    // exactly that shape. Party B is asked for no record, so the single warning
    // and the non-zero exit are provably party A's.
    const recordA = path.join(tmpDir, "rec-a.json");
    mockFd3Open();
    try {
      await Promise.all([
        runProtocol(
          {
            channel: "filedrop",
            path: dropDir,
            options: TWO_PARTY_OPTIONS,
          },
          null,
          minimalPrepared,
          undefined,
          -1,
          "test-a",
          { recordFile: recordA },
          undefined,
          undefined,
          { eventStream: true },
        ),
        runProtocol(
          {
            channel: "filedrop",
            path: dropDir,
            options: TWO_PARTY_OPTIONS,
          },
          null,
          minimalPrepared,
          undefined,
          -1,
          "test-b",
        ),
      ]);
      expect(process.exitCode).toBe(73);
    } finally {
      vi.mocked(fs.fstatSync).mockRestore();
    }

    const lines = takeFd3Lines();
    expect(lines.map((l) => l.type)).toEqual([
      "stages",
      "warning",
      "metrics",
      "result",
    ]);
    expect(lines[1].message).toBe(NO_RECORD_BUILT_WARNING);
    expect(lines[3].resultWritten).toBe(true);
    // What the warning asserts: neither the record nor its keys reached disk.
    expect(fs.existsSync(recordA)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "rec-a.keys.json"))).toBe(false);
  },
);

test("a result file that could not be written fails with the persistence-loss exit code", async () => {
  // The terminal form of the same loss: the exchange completed and only local
  // result generation failed (here the output path's parent is a regular file),
  // so re-running would re-send this party's data for an exchange that already
  // happened. The run fails -- there is no result -- but it carries 73 to the
  // command boundary rather than the 69 a transport fault gets, and the terminal
  // event's `output` category names the finer distinction for a reader of fd 3.
  const blocker = path.join(tmpDir, "blocker");
  fs.writeFileSync(blocker, "x");
  mockFd3Open();
  let outcome: PromiseSettledResult<unknown>;
  try {
    [outcome] = await Promise.allSettled([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        path.join(blocker, "out.csv"),
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  expect(outcome.status).toBe("rejected");
  const reason = (outcome as PromiseRejectedResult).reason as {
    exitCode?: number;
  };
  expect(reason.exitCode).toBe(73);
  // What a command boundary would actually report for it. The stamped property
  // is only half the contract: exchange.test.ts and zeroSetup.test.ts drive the
  // handlers to a real process exit, and this is the rule they share.
  expect(exitCodeForError(reason)).toBe(73);

  const lines = takeFd3Lines();
  const terminal = lines[lines.length - 1];
  expect(terminal.type).toBe("error");
  expect(terminal.category).toBe("output");
}, 20_000);

test("a partner-shaped output-phase fault exits 69, not the local write-loss code", async () => {
  // The other half of the same boundary. buildOutputTable's integrity checks run
  // in the output phase but refuse PARTNER-controlled shapes -- here a payload
  // carrying no row for a record the association table matched, thrown by the real
  // core function -- and 73's published meaning is that what failed is a local
  // write on this machine. Such a fault stays 69; only the result file failing to
  // reach disk is stamped. The terminal event's `output` category still covers it,
  // since the exchange did complete and must not be re-run.
  const { buildOutputTable: coreBuildOutputTable } =
    await vi.importActual<typeof import("@psilink/core")>("@psilink/core");
  const payloadMissingAMatchedRow: PartnerPayload = {
    columns: ["dob"],
    rowIndices: [5],
    rows: [["1990-01-02"]],
  };
  const associationNamingAnotherRow: AssociationTable = [[0], [7]];
  vi.mocked(buildOutputTable).mockImplementation(() =>
    coreBuildOutputTable(
      associationNamingAnotherRow,
      [],
      [],
      payloadMissingAMatchedRow,
    ),
  );

  mockFd3Open();
  let outcome: PromiseSettledResult<unknown>;
  try {
    [outcome] = await Promise.allSettled([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
    vi.mocked(buildOutputTable).mockReturnValue({ headers: [], rows: [] });
  }

  expect(outcome.status).toBe("rejected");
  const reason = (outcome as PromiseRejectedResult).reason as Error & {
    exitCode?: number;
  };
  // The real core refusal, not a stand-in shaped like one.
  expect(reason.message).toContain(
    "missing rows for association table indices",
  );
  expect(reason.exitCode).toBeUndefined();
  expect(exitCodeForError(reason)).toBe(69);

  const lines = takeFd3Lines();
  const terminal = lines[lines.length - 1];
  expect(terminal.type).toBe("error");
  expect(terminal.category).toBe("output");
}, 20_000);

// --- One-sided result withholding via runProtocol ----------------------------

test("writes no result file for a non-receiving party when the exchange withholds the table", async () => {
  // The CLI half of the one-sided result-withholding gate: when the exchange
  // returns no association table (this party's agreed terms give it no output, so
  // it is the PSI sender/helper), runProtocol must write no result CSV -- it
  // contributed to the match but is not entitled to the result. Both parties model
  // a withheld result here, so neither writes an output file and the table
  // formatter (buildOutputTable) is never reached.
  async function runExchangeWithheld(): Promise<unknown> {
    // Drain the drop dir exactly as the default mock does, so neither party's
    // cleanup races the other's poller, then return a withheld result.
    await defaultRunExchange();
    return { associationTable: undefined, partnerPayload: {} };
  }
  vi.mocked(runExchange).mockImplementation(runExchangeWithheld as never);
  // Other tests in this file call buildOutputTable through runProtocol's normal
  // (non-withheld) path, so clear its accumulated calls before asserting it is not
  // reached here.
  vi.mocked(buildOutputTable).mockClear();

  const outputA = path.join(tmpDir, "out-a.csv");
  const outputB = path.join(tmpDir, "out-b.csv");

  await Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      outputA,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      outputB,
      -1,
      "test-b",
    ),
  ]);

  // No result file is written for either non-receiving party...
  expect(fs.existsSync(outputA)).toBe(false);
  expect(fs.existsSync(outputB)).toBe(false);
  // ...and the table-formatting step is never reached, so there is nothing in
  // memory to write either.
  expect(vi.mocked(buildOutputTable)).not.toHaveBeenCalled();
}, 20_000);

// Mock a count-only run for the given PSI seat: the receiver computed the count
// itself, the sender was handed one over the count-report leg.
function mockCountOnlyRun(resolvedRole: "receiver" | "sender") {
  async function runExchangeCountOnly(): Promise<unknown> {
    await defaultRunExchange();
    return {
      associationTable: undefined,
      intersectionCount: 7,
      resolvedRole,
      partnerPayload: {},
    };
  }
  vi.mocked(runExchange).mockImplementation(runExchangeCountOnly as never);
  vi.mocked(buildOutputTable).mockClear();
}

// Drive both halves of a filedrop run, writing this party's result to `output`.
function runBothHalves(output: string) {
  return Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      output,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      `${output}.partner`,
      -1,
      "test-b",
    ),
  ]);
}

test("reports a count-only exchange's count instead of reading as withheld", async () => {
  // A count-only run hands back no association table for anyone, so it lands in the
  // same no-result-file branch a withheld table does -- and must not be reported the
  // same way: this party received exactly what its terms promised.
  mockCountOnlyRun("receiver");

  const output = path.join(tmpDir, "count-only.csv");
  await runBothHalves(output);

  expect(fs.existsSync(output)).toBe(false);
  expect(vi.mocked(buildOutputTable)).not.toHaveBeenCalled();
  expect(
    mockState.infos.some((line) => line.includes("7 record(s) in common")),
  ).toBe(true);
  expect(
    mockState.infos.some((line) => line.includes("you receive no result")),
  ).toBe(false);
  // The receiver computed its own count under an enforced mode, so it gets no
  // trust-contingent caveat -- one there would be false. Asserted on the caveat's
  // own clause: the rendezvous lines name the partner too, in the ordinary way.
  expect(
    mockState.infos.some((line) =>
      line.includes("Only your partner computed the count"),
    ),
  ).toBe(false);
}, 20_000);

test("caveats a count-only count the partner reported rather than computed", async () => {
  // The sender seat's number arrives over the partner's count-report leg and is
  // checked against no run of its own, so the reminder lands where the operator
  // reads the number rather than only at consent time.
  mockCountOnlyRun("sender");

  const output = path.join(tmpDir, "count-only-sender.csv");
  await runBothHalves(output);

  expect(fs.existsSync(output)).toBe(false);
  const line = mockState.infos.find((entry) =>
    entry.includes("7 record(s) in common"),
  );
  expect(line).toContain("your partner reported 7 record(s) in common");
  expect(line).toContain("psilink does not check a count it is sent");
  expect(line).toContain("no result file was written");
}, 20_000);

// --- Expired token via runProtocol -------------------------------------------

test("runProtocol rejects an expired token without rotating, and the tagged recovery hint suppresses the generic catch advisory", async () => {
  // runProtocol checks the pre-handshake expiry (assertSharedSecretReadyForHandshake)
  // BEFORE opening any connection, so each party trips the same check independently
  // with no rendezvous I/O. Both parties supply the same expired token, so both
  // reject deterministically with the "expired" hint. (Before that check was
  // hoisted ahead of connect(), an expired token first drove the file-drop
  // rendezvous, and the losing side could race into a "peer appears to have
  // abandoned the handshake; retry" error instead -- a misleading hint for a dead
  // credential, and the source of a ~1-in-10 flake in this assertion.) The error
  // carries `psilinkRecoveryHintEmitted: true` (set in auth.ts), so the runProtocol
  // catch must NOT log either of its generic advisory lines - those would
  // contradict the specific "obtain a new invitation" message. Also verifies that
  // no token rotation occurred: the original key file contents must be unchanged
  // after the failure.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, {
    sharedSecret: TOKEN_A,
    expires: "2000-01-01T00:00:00.000Z",
  });
  saveKeyFile(keyFileB, {
    sharedSecret: TOKEN_A,
    expires: "2000-01-01T00:00:00.000Z",
  });

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    {
      sharedSecret: TOKEN_A,
      expires: "2000-01-01T00:00:00.000Z",
      keyFilePath: keyFileA,
    },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    {
      sharedSecret: TOKEN_A,
      expires: "2000-01-01T00:00:00.000Z",
      keyFilePath: keyFileB,
    },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "expired",
  );
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "expired",
  );

  // Neither generic advisory line in runProtocol's catch must fire: both
  // would contradict the tagged "obtain a new invitation" recovery hint.
  expectNoGenericRecoveryAdvisory(mockState.errors);

  // Token must remain unchanged on both sides.
  expect(loadKeyFile(keyFileA)?.sharedSecret).toBe(TOKEN_A);
  expect(loadKeyFile(keyFileB)?.sharedSecret).toBe(TOKEN_A);
}, 20_000);

test("runProtocol rejects an already-expired token before opening any connection (no rendezvous I/O)", async () => {
  // The regression guard for hoisting the pre-handshake expiry check ahead of
  // connect(). A LONE party with an expired token must reject at once with the
  // "expired" hint, WITHOUT entering the file-drop rendezvous: it writes no
  // hello/lock files and never waits for a peer. Were the check moved back inside
  // authenticateConnection (which runs only after the connection is open), this
  // lone party would instead write its hello and block at the rendezvous until
  // peerTimeoutMs, then reject with a timeout rather than "expired" -- failing the
  // message and empty-directory assertions below. The lone-party peerTimeoutMs
  // keeps that regression mode fast rather than letting it hang the suite; the
  // healthy path never opens a connection, so it spends none of it. This is also
  // why the two-party expired-token test above is now deterministic: neither side
  // reaches the rendezvous, so its loser can no longer race into a "peer abandoned
  // the handshake" error in place of "expired".
  const keyFile = path.join(tmpDir, "lone.key");
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2000-01-01T00:00:00.000Z",
  });

  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: {
          pollIntervalMs: 1,
          peerTimeoutMs: LONE_PARTY_PEER_BUDGET_MS,
        },
      },
      {
        sharedSecret: TOKEN_A,
        expires: "2000-01-01T00:00:00.000Z",
        keyFilePath: keyFile,
      },
      minimalPrepared,
      undefined,
      -1,
      "test-lone",
    ),
  ).rejects.toThrow("expired");

  // The rendezvous was never entered: nothing was written to the drop directory.
  expect(fs.readdirSync(dropDir)).toEqual([]);
  // The tagged hint means runProtocol emits neither generic catch advisory, and
  // the credential is left untouched (no rotation on a pre-connect failure).
  expectNoGenericRecoveryAdvisory(mockState.errors);
  expect(loadKeyFile(keyFile)?.sharedSecret).toBe(TOKEN_A);
});

// --- Online invite early-invalidation: nothing persisted before acceptance ---
//
// The online-invite revocation guarantee holds by construction: the setup secret
// is held only in memory and the key file is written only after a successful
// handshake (saveKeyFile runs inside the post-authentication block). So when the
// inviter exits before acceptance -- the partner never arrives (accept-timeout /
// connection timeout) or the user cancels -- no usable credential is left behind.
// These two tests lock that in for the lone-inviter case.

test("runProtocol writes no key when the partner never arrives (accept-timeout)", async () => {
  // A lone inviter waits at the rendezvous and the accept-timeout (modeled by
  // the lone-party peerTimeoutMs) elapses with no peer. The run rejects with a
  // timeout and must persist nothing: the key file is never created.
  const keyFile = path.join(tmpDir, "a.key");
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: {
          pollIntervalMs: 1,
          peerTimeoutMs: LONE_PARTY_PEER_BUDGET_MS,
        },
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFile },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
  ).rejects.toThrow(/timed out/i);
  expect(fs.existsSync(keyFile)).toBe(false);
});

test("runProtocol writes no key when SIGINT cancels before the handshake completes", async () => {
  // Cancelling the lone inviter mid-wait (before any peer arrives, so before the
  // handshake) must leave no usable credential: the in-memory setup secret is
  // discarded and the key file is never written. process.exit is mocked so the
  // signal handler runs to completion without terminating the test process.
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const keyFile = path.join(tmpDir, "a.key");
  // peerTimeoutMs is generous so the wait does not time out on its own before the
  // signal arrives; the SIGINT is what ends the run.
  const p = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1, peerTimeoutMs: 5_000 },
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFile },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  try {
    // Wait until the inviter has published its rendezvous file (it is now waiting
    // for a peer in synchronize()), then cancel. A lone party has no peer whose
    // lock files the cleanup could disrupt, so cancelling during synchronize() is
    // safe here.
    await vi.waitFor(
      () => expect(fs.readdirSync(dropDir).length).toBeGreaterThan(0),
      { timeout: 5_000 },
    );
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });
    // Drain the interrupted run before asserting. It resolves cleanly via the
    // signal path, but settle it with allSettled so a cleanup-race rejection
    // cannot skip the key-file invariant below (and to match the other
    // SIGINT-mid-synchronize tests in this file).
    await Promise.allSettled([p]);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    exitSpy.mockRestore();
  }
});

// --- Entry-present hello attribution -----------------------------------------

// Runs a lone party into a folder already holding a leftover peer hello under a
// foreign id -- exactly what a hard kill during a prior rendezvous leaves when
// the party id is a fresh uuid per run. In the default lock mode the run takes
// the joiner fast path, consumes the leftover, commits a peer id, and then
// stalls in the key exchange against a party that does not exist.
async function runIntoLeftoverPeerHello(
  leftoverId: string = LEFTOVER_HELLO_ID,
): Promise<unknown> {
  fs.writeFileSync(
    path.join(dropDir, `${leftoverId}-hello.json`),
    JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
  );
  const [result] = await Promise.allSettled([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: {
          pollIntervalMs: 1,
          peerTimeoutMs: LONE_PARTY_PEER_BUDGET_MS,
        },
      },
      { sharedSecret: TOKEN_A, keyFilePath: path.join(tmpDir, "a.key") },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
  ]);
  expect(result.status).toBe("rejected");
  return (result as PromiseRejectedResult).reason;
}

const LEFTOVER_HELLO_ID = "2f1c9a04-3b7e-4f6a-9d21-88ca0e6b5477";

test("a run against an unconfirmed entry-present hello blames the leftover, not the peer", async () => {
  const err = await runIntoLeftoverPeerHello();

  const rendered = sanitizeErrorForDisplay(err);
  // The claim the code cannot support is gone: nothing here established that a
  // peer completed the rendezvous, so the operator is not sent to their partner.
  expect(rendered).not.toContain("The peer completed the rendezvous");
  expect(rendered).not.toContain("cause is on the peer's side");
  // Replaced by the fact the run does hold, the leftover named, and the local
  // recovery step -- asserted through the rendering path, where each cause-chain
  // link is truncated, not on the raw message.
  expect(rendered).toContain("No peer was confirmed");
  expect(rendered).toContain(`${LEFTOVER_HELLO_ID}-hello.json`);
  // The re-run leads and the removal is conditioned on surviving it: from here
  // a leftover and a partner that arrived first and then stalled are the same
  // shape, and a partner that is merely slow completes the re-run.
  expect(rendered).toContain("Re-run");
  expect(rendered).toContain("remove only if it persists");
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
}, 20_000);

test("a run whose partner completed the rendezvous keeps the peer-side guidance", async () => {
  // The partner's hello appears AFTER this party's entry scan and it acks this
  // party's own hello, so nothing about it is unconfirmed residue: the default
  // attribution is the true one and must be preserved.
  const err = await runPartyToKeyExchangeTimeout();

  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain("The peer completed the rendezvous");
  expect(rendered).not.toContain("No peer was confirmed");
}, 20_000);

test("entryHelloResidueGuidance leads with the diagnosis and recovery, filename last", () => {
  const line = entryHelloResidueGuidance(`${LEFTOVER_HELLO_ID}-hello.json`);
  expect(line.indexOf("Re-run")).toBeLessThan(line.indexOf(LEFTOVER_HELLO_ID));
  const long = entryHelloResidueGuidance(`${"x".repeat(400)}-hello.json`);
  const rendered = sanitizeErrorForDisplay(new Error(long));
  expect(rendered).toContain("No peer was confirmed");
  expect(rendered).toContain("remove only if it persists");
});

// A configured peer_id is not bounded to a uuid's 36 characters, and this
// clause shares one 256-character cause-chain link with the core layer's own
// peer-silence sentence -- so the budget the fixed text leaves for the filename
// is small, and every word of it is one the operator does not get to read. This
// drives the real composite through the real renderer at a name half again a
// uuid's length: a text that grows past the budget truncates the very filename
// the recovery step names, which is a measurement, not something a comment can
// promise.
test("the residue guidance renders in full for a configured peer_id longer than a uuid", async () => {
  const err = await runIntoLeftoverPeerHello(
    "acme-health-2026-partner-exchange-north-region-01",
  );

  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered).toContain(
    "acme-health-2026-partner-exchange-north-region-01-hello.json",
  );
  expect(rendered).toContain("remove only if it persists");
}, 20_000);

// The residue filename is partner-chosen text that reaches the operator only
// through this guidance, and the escaping happens at ONE altitude: the fragment
// is composed RAW into the error and sanitizeErrorForDisplay escapes the whole
// chain once where it is shown. Twice is not cosmetic -- sanitizeForDisplay
// doubles a literal backslash on every pass, so one backslash in the name would
// reach the operator as four and the name they are told to remove would not be
// the name on disk. Both halves are asserted, because the presence check alone
// passes on the doubled output too.
test.each([
  ["a literal backslash", "back\\slash"],
  ["a non-ASCII code point", "你好"],
  ["a control byte", "\x1b[31mred"],
  ["an astral code point", "\u{1f600}"],
])(
  "a residue filename carrying %s is escaped once at the rendered boundary",
  async (_, leftoverId) => {
    const err = await runIntoLeftoverPeerHello(leftoverId);

    const rendered = sanitizeErrorForDisplay(err);
    const once = sanitizeForDisplay(`${leftoverId}-hello.json`);
    expect(rendered).toContain(once);
    expect(rendered).not.toContain(sanitizeForDisplay(once));
    // The whole guidance survives the per-link cap, so the escaped name is the
    // one the operator reads rather than a clipped prefix of it.
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(rendered).toContain("remove only if it persists");
  },
  20_000,
);

// --- Both-parties-swept retry advice -----------------------------------------

// Runs a lone party against the shared folder with no partner ever arriving.
// Given a clean folder it reaches the rendezvous peer-wait timeout, which is
// the failure the second party to sweep observes.
async function runLonePartyWithNoPartner(
  fileSyncRuntime: { sweepExchangeFiles?: boolean } = {},
): Promise<unknown> {
  const [result] = await Promise.allSettled([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: {
          pollIntervalMs: 1,
          peerTimeoutMs: LONE_PARTY_PEER_BUDGET_MS,
        },
      },
      { sharedSecret: TOKEN_A, keyFilePath: path.join(tmpDir, "a.key") },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
      undefined,
      undefined,
      undefined,
      fileSyncRuntime,
    ),
  ]);
  expect(result.status).toBe("rejected");
  return (result as PromiseRejectedResult).reason;
}

// Runs a party whose partner completes the rendezvous and then never answers
// the handshake -- the failure the first party to sweep observes, its own live
// hello having been taken by the second party's sweep. The partner is a bare
// connection that rendezvouses and then stays silent, because the point of
// departure has to be after the rendezvous and before the first handshake
// message. The surviving party is started first so its own entry sweep runs
// against an empty folder and cannot itself remove the partner's files.
async function runPartyToKeyExchangeTimeout(
  fileSyncRuntime: {
    sweepExchangeFiles?: boolean;
    forceRetainSweep?: boolean;
  } = {},
  connectionOptions: {
    retainFiles?: boolean;
    timestampInFilename?: boolean;
    locklessRendezvous?: boolean;
  } = {},
): Promise<unknown> {
  const surviving = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: {
        // Not the shared backstop: this budget is the thing under test, waited
        // out in full on every healthy run, so each case below spends it and
        // measures ~1.6 s for that reason rather than for a loaded runner.
        pollIntervalMs: 1,
        peerTimeoutMs: 1_500,
        ...connectionOptions,
      },
    },
    { sharedSecret: TOKEN_A, keyFilePath: path.join(tmpDir, "a.key") },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
    undefined,
    undefined,
    undefined,
    fileSyncRuntime,
  );
  await vi.waitFor(
    () => expect(fs.readdirSync(dropDir).length).toBeGreaterThan(0),
    { timeout: 5_000 },
  );
  const silentPartner = new FileSyncConnection(new LocalFSClient(), {
    verbose: -1,
    pollingFrequency: 1,
  });
  let result: PromiseSettledResult<RunProtocolResult>;
  try {
    // The peer runs the same bilateral flags: retain_files and
    // lockless_rendezvous must match on both sides or the rendezvous fast-fails
    // with a mismatch instead of reaching the handshake.
    await silentPartner.open({
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1, ...connectionOptions },
    });
    await silentPartner.synchronize();
    [result] = await Promise.allSettled([surviving]);
  } finally {
    await silentPartner.close().catch(() => {});
  }
  expect(result.status).toBe("rejected");
  return (result as PromiseRejectedResult).reason;
}

// The gate tests below compare against the imported constant, so rewriting
// the constant to assert a definite cause keeps every one of them green. Only
// the party that swept FIRST can observe the collision -- its own live hello
// vanished; the second can only infer it, and a run that swept and then timed
// out because the partner never started reads this line too. The hedge is what
// keeps it a likely cause rather than a wrong diagnosis, so it is pinned on the
// words.
test("the both-swept advice is phrased as a likely cause, not a diagnosis", () => {
  expect(BOTH_SWEPT_GUIDANCE).toContain("appear to have");
});

test("the both-swept advice appears on a flagged run that fails waiting for the partner", async () => {
  const err = await runLonePartyWithNoPartner({
    sweepExchangeFiles: true,
  });
  expect((err as Error).message).toContain("synchronization has timed out");
  expect(mockState.errors).toContain(BOTH_SWEPT_GUIDANCE);
});

test("the both-swept advice appears on a flagged run that fails in the key exchange", async () => {
  const err = await runPartyToKeyExchangeTimeout({ sweepExchangeFiles: true });
  expect((err as Error).message).toBe("key exchange handshake timed out");
  expect(mockState.errors).toContain(BOTH_SWEPT_GUIDANCE);
}, 20_000);

test("the both-swept advice is absent from an unflagged run that fails the same two ways", async () => {
  const waitErr = await runLonePartyWithNoPartner();
  expect((waitErr as Error).message).toContain("synchronization has timed out");
  expect(mockState.errors).not.toContain(BOTH_SWEPT_GUIDANCE);

  fs.rmSync(dropDir, { recursive: true, force: true });
  fs.mkdirSync(dropDir);
  mockState.errors.length = 0;

  const kexErr = await runPartyToKeyExchangeTimeout();
  expect((kexErr as Error).message).toBe("key exchange handshake timed out");
  expect(mockState.errors).not.toContain(BOTH_SWEPT_GUIDANCE);
}, 20_000);

test("the both-swept advice is absent when the sweep could not delete every file", async () => {
  // The claim that the folder is now empty is unfounded when the sweep itself
  // failed part-way, so this run keeps its own error and nothing else. The
  // transport delete is stubbed to fail because a leftover the process cannot
  // unlink is not constructible from within the test's own directory.
  fs.writeFileSync(path.join(dropDir, "leftover-peer-lock.json"), "{}");
  const deleteSpy = vi
    .spyOn(LocalFSClient.prototype, "delete")
    .mockRejectedValue(new Error("simulated delete failure"));
  try {
    const err = await runLonePartyWithNoPartner({
      sweepExchangeFiles: true,
    });
    expect((err as Error).message).toContain("may be partially swept");
    expect(mockState.errors).not.toContain(BOTH_SWEPT_GUIDANCE);
  } finally {
    deleteSpy.mockRestore();
  }
});

test("the both-swept advice is absent from a flagged retain-mode run", async () => {
  // Retain mode keeps the transcript -- cleanup() deletes nothing -- so the
  // folder this run leaves behind still holds the rendezvous files, and the
  // advice's premise that it is now empty (and so its "run it again" recovery,
  // which the next run's entry guard rejects) does not hold. Retain mode is
  // itself a retain signal, so the sweep needs --force-retain-sweep too.
  const err = await runPartyToKeyExchangeTimeout(
    { sweepExchangeFiles: true, forceRetainSweep: true },
    { retainFiles: true, timestampInFilename: true, locklessRendezvous: true },
  );
  expect((err as Error).message).toBe("key exchange handshake timed out");
  // The very failure the advice is gated on, so its absence below is the
  // retain-mode exclusion and not some other error arriving first.
  expect(isPeerWaitTimeout(err)).toBe(true);
  expect(fs.readdirSync(dropDir).length).toBeGreaterThan(0);
  expect(mockState.errors).not.toContain(BOTH_SWEPT_GUIDANCE);
}, 20_000);

// --- Token rotation via runProtocol ------------------------------------------

test("both key files hold the same rotated token after a successful exchange", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const outputA = path.join(tmpDir, "out-a.csv");
  const outputB = path.join(tmpDir, "out-b.csv");

  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      outputA,
      -1,
      "test-a",
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      minimalPrepared,
      outputB,
      -1,
      "test-b",
    ),
  ]);

  const loadedA = loadKeyFile(keyFileA);
  const loadedB = loadKeyFile(keyFileB);

  // Both parties derive the same new token from the shared session key.
  expect(loadedA?.sharedSecret).toBeDefined();
  expect(loadedA?.sharedSecret).toBe(loadedB?.sharedSecret);
  // The token must differ from the original (it was rotated).
  expect(loadedA?.sharedSecret).not.toBe(TOKEN_A);
  // Rotation tokens carry no expiry.
  expect(loadedA?.expires).toBeUndefined();
  expect(loadedB?.expires).toBeUndefined();
}, 20_000);

test("a token_max_age_days policy stamps expires onto both rotated key files", async () => {
  // The no-policy test above locks in the absent-expiry default; this exercises
  // the other half of the rotation write path -- that auth.tokenMaxAgeDays is
  // threaded through runProtocol into buildRotatedKeyFile and a stamped expiry
  // actually lands on disk. Without this, a regression that dropped the argument
  // would still pass every test.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const outputA = path.join(tmpDir, "out-a.csv");
  const outputB = path.join(tmpDir, "out-b.csv");

  const before = Date.now();
  await Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA, tokenMaxAgeDays: 30 },
      minimalPrepared,
      outputA,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB, tokenMaxAgeDays: 30 },
      minimalPrepared,
      outputB,
      -1,
      "test-b",
    ),
  ]);
  const after = Date.now();

  const loadedA = loadKeyFile(keyFileA);
  const loadedB = loadKeyFile(keyFileB);

  // Both rotated tokens carry a stamped expiry of ~now + 30 days, where "now" is
  // the rotation moment somewhere between `before` and `after`.
  expect(loadedA?.expires).toBeDefined();
  expect(loadedB?.expires).toBeDefined();
  const THIRTY_DAYS_MS = 30 * 86_400_000;
  const expiresA = Date.parse(loadedA?.expires ?? "");
  const expiresB = Date.parse(loadedB?.expires ?? "");
  expect(expiresA).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
  expect(expiresA).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
  expect(expiresB).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
  expect(expiresB).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
}, 20_000);

// --- Abort-marker echo suppression via runProtocol ---------------------------
//
// These pin the orchestrator-side gate that DECIDES whether to write an abort
// marker -- `conn.abortArmed && signalReceived === undefined && !errIsPeerAbort(err)`
// in runProtocol's catch. The core test (fileSyncAbortMarker.test.ts) exercises
// the connection's seal-vs-write machinery by calling sealAbort()/writeAbortMarker()
// directly; nothing else drives the protocol-level gate, so a regression that
// dropped the `!errIsPeerAbort` term (making two peers reflect markers at each
// other) or the `abortArmed` term would pass the rest of the suite. Both tests run
// a REAL two-party handshake to the armed state (only runExchange is mocked), then
// inject the fault by throwing from runExchange -- which lands in the same catch a
// real mid-exchange fault would, but deterministically. The injection keys on the
// rendezvous-assigned ROLE, not the party, so the outcome is independent of who
// wins the rendezvous. A barrier in the mock holds both parties past the handshake
// before either fails, so the first teardown cannot strand the other's handshake.

// The barrier's bound is a hang backstop for a party that never arrives, not a
// budget for how long the other party's rendezvous may take. The two are started
// together and meet within milliseconds, but a loaded machine can stretch the
// second party's rendezvous past a bound sized near that: the party already
// through then gives up, tears down, and strands the one still arriving, which
// fails the run for the scheduling rather than for what the test injected.
const BOTH_ARMED_HANG_BACKSTOP_MS = 15_000;

// Holds the calling party inside the mocked runExchange until BOTH parties have
// arrived (both are armed and past the handshake), bounded so a lone arrival does
// not hang. See mockState.runExchangeEntries.
async function awaitBothArmed(): Promise<void> {
  mockState.runExchangeEntries++;
  const deadline = Date.now() + BOTH_ARMED_HANG_BACKSTOP_MS;
  while (mockState.runExchangeEntries < 2 && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 1));
}

function runAbortParty(keyFilePath: string, name: string): Promise<unknown> {
  return runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      // Bound peerTimeoutMs: when a party fails it tears down without consuming a
      // trailing handshake frame the peer may have left, so the peer's teardown
      // drain would otherwise wait a full (default, very long) peerTimeoutMs.
      // The bound is a backstop for that drain, not a budget for the rendezvous
      // and handshake it also bounds: every wait before runExchange is capped by
      // this value, so a bound sized near the happy path (tens of milliseconds)
      // fails BOTH parties on a loaded machine before either reaches the barrier
      // -- for the scheduling rather than for the fault the test injects, and
      // reported as the runExchangeEntries assertion below.
      options: { pollIntervalMs: 1, peerTimeoutMs: 2_000 },
    },
    { sharedSecret: TOKEN_A, keyFilePath },
    minimalPrepared,
    undefined,
    -1,
    name,
  ) as unknown as Promise<unknown>;
}

test(
  "runProtocol suppresses its own abort marker on a PeerAbortError but writes one for a generic transport fault",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    // Exactly one role raises a PeerAbortError (as if it had READ the peer's marker)
    // and the other a generic transport fault, no matter who arrives first.
    vi.mocked(runExchange).mockImplementation((async (
      _conn: unknown,
      role: unknown,
    ) => {
      await awaitBothArmed();
      if (role === "initiator") throw new PeerAbortError();
      throw new ConnectionError("simulated transport fault", "transport");
    }) as never);

    const [resultA, resultB] = await Promise.allSettled([
      runAbortParty(keyFileA, "test-a"),
      runAbortParty(keyFileB, "test-b"),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    // Both parties must have reached the armed state and entered runExchange, or
    // "exactly one marker" could read green for the wrong reason -- a party that
    // failed the handshake before arming also writes no marker, which would mimic
    // echo suppression without exercising the gate. Asserting both arrived makes
    // the count a genuine suppression signal.
    expect(mockState.runExchangeEntries).toBe(2);

    // Echo suppressed: the PeerAbort side wrote nothing, so only the generic-fault
    // side's marker remains. (If the gate dropped `!errIsPeerAbort`, this would be 2.)
    expect(
      fs.readdirSync(dropDir).filter((f) => f.endsWith("-abort.json")),
    ).toHaveLength(1);
  },
);

test(
  "runProtocol writes an abort marker on each side when both fail with a generic transport fault",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    // The control for the suppression test: with no PeerAbortError in play, both
    // armed parties take the write branch and two distinct markers result. This
    // proves the harness CAN produce two markers, so the "exactly one" above is a
    // genuine suppression signal rather than an artifact of only one side writing.
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ConnectionError("simulated transport fault", "transport");
    }) as never);

    const results = await Promise.allSettled([
      runAbortParty(keyFileA, "test-a"),
      runAbortParty(keyFileB, "test-b"),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // Both parties reached the armed state and entered runExchange (see the
    // suppression test): without this, a one-sided handshake failure could leave
    // fewer markers and still read green.
    expect(mockState.runExchangeEntries).toBe(2);

    expect(
      fs.readdirSync(dropDir).filter((f) => f.endsWith("-abort.json")),
    ).toHaveLength(2);
  },
);

// --- Signed-receipt non-signing-partner warn gate via runProtocol ------------
//
// Pins the catch-block gate that decides whether to warn the operator that a
// signed receipt was configured but the exchange did not complete the receipt
// swap -- `signing !== null && !exchangeComplete && !isReceiptVerificationFailure
// && !isLocalConfigRefusal` in runProtocol's catch. Runs a REAL two-party
// handshake (only runExchange is mocked) with a signing config threaded
// through, using the same awaitBothArmed/runAbortParty barrier pattern as the
// abort-marker section above so both parties reach the same point
// deterministically.

const NON_SIGNING_PARTNER_WARNING =
  "A signed receipt was configured for this exchange, but the exchange " +
  "did not complete the receipt swap";

function signingPersistFixture(receiptFile: string): SigningPersist {
  return {
    identity: signingIdentityFixture,
    receiptOutput: { receiptFile },
  };
}

function runSigningParty(
  keyFilePath: string,
  name: string,
  receiptFile: string,
  recordOutput?: RecordOutput,
  machineInterface: { eventStream?: boolean } = {},
): Promise<unknown> {
  return runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath },
    minimalPrepared,
    undefined,
    -1,
    name,
    recordOutput,
    undefined,
    undefined,
    machineInterface,
    signingPersistFixture(receiptFile),
  ) as unknown as Promise<unknown>;
}

test("a completed signed run does not warn about a non-signing partner", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const [resultA, resultB] = await Promise.allSettled([
    runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
    runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
  ]);
  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");

  expect(
    mockState.warnings.some((m) => m.includes(NON_SIGNING_PARTNER_WARNING)),
  ).toBe(false);
}, 20_000);

// A minimal schema-valid dual-signed record: the receipt an exchange that
// completed its signature swap returns. Its certificates are the checked-in
// signing-cert vectors' identities, reused here for a valid shape -- nothing
// verifies them on the write path.
const signedReceiptCertificate = {
  version: "psilink-signing-cert/v2" as const,
  algorithm: "ecdsa-p256-sha256" as const,
  identity: "Party A",
  publicKey: {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: "UVw9brnjlrkE0_7Kf1T9zQzB6Ze_N13KUVrQpsO0A18",
    y: "RTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q",
  },
  signature:
    "CzgwEmZnlYhLunf5m3CK7WWpHiUlMeRW_hhdJmbaPiwbsuT0LPP0EJGcHskJMB7icXOXfuZ1DPlQlnkpqtVL4g",
};
const signedReceiptFixture: DualSignedRecord = {
  version: "psilink-signed-receipt/v2",
  content: {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  },
  initiator: {
    certificate: signedReceiptCertificate,
    signature: "AAAA",
  },
  responder: {
    certificate: { ...signedReceiptCertificate, identity: "Party B" },
    signature: "AAAA",
  },
};

test("writes the dual-signed receipt when no audit record was built", async () => {
  // The two artifacts are independent: core signs the receipt from the
  // mutually-verifiable facts whether or not this party's local record built, so
  // a record-build failure (which leaves audit undefined, warned and swallowed
  // inside runExchange) must not discard a completed dual-signed receipt -- the
  // one artifact a partner and an auditor can check. This models that return
  // shape exactly: a signed receipt with no audit beside it.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  vi.mocked(runExchange).mockImplementation((async () => {
    const base = (await defaultRunExchange()) as Record<string, unknown>;
    return { ...base, signedReceipt: signedReceiptFixture };
  }) as never);

  const receiptA = path.join(tmpDir, "receipt-a.json");
  const receiptB = path.join(tmpDir, "receipt-b.json");
  const [resultA, resultB] = await Promise.allSettled([
    runSigningParty(keyFileA, "test-a", receiptA),
    runSigningParty(keyFileB, "test-b", receiptB),
  ]);
  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");

  for (const receipt of [receiptA, receiptB]) {
    expect(
      parseDualSignedRecord(JSON.parse(fs.readFileSync(receipt, "utf8"))),
    ).toEqual(signedReceiptFixture);
  }
}, 20_000);

test(
  "a ReceiptVerificationError does not warn about a non-signing partner",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    // A pin-mismatch/verification failure is its own hard security failure,
    // surfaced on its own path (a distinct error kind/message); the softer
    // "partner may not be configured to sign" warning must not also fire and
    // dilute it.
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ReceiptVerificationError("simulated receipt pin mismatch");
    }) as never);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    expect(mockState.runExchangeEntries).toBe(2);

    expect(
      mockState.warnings.some((m) => m.includes(NON_SIGNING_PARTNER_WARNING)),
    ).toBe(false);
  },
);

test(
  "a ReceiptVerificationError wrapped via cause still suppresses the warn",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    // isReceiptVerificationFailure walks the error's cause chain, mirroring the
    // sibling isHintTagged/errIsPeerAbort predicates in the same catch, so a
    // future wrap of the security failure cannot downgrade it to the soft warn.
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      const inner = new ReceiptVerificationError(
        "simulated receipt pin mismatch",
      );
      throw new Error(`outer wrap: ${inner.message}`, { cause: inner });
    }) as never);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    expect(mockState.runExchangeEntries).toBe(2);

    expect(
      mockState.warnings.some((m) => m.includes(NON_SIGNING_PARTNER_WARNING)),
    ).toBe(false);
  },
);

test(
  "an OperatorConfigError does not warn about a non-signing partner",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    // A run stopped by this party's own certificate/terms divergence (the
    // swap gate's local certificate check) is a local configuration fault,
    // not evidence the partner failed to configure signing; the advisory
    // must not point the operator at the partner for a purely local refusal.
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new OperatorConfigError("simulated local certificate refusal");
    }) as never);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    expect(mockState.runExchangeEntries).toBe(2);

    expect(
      mockState.warnings.some((m) => m.includes(NON_SIGNING_PARTNER_WARNING)),
    ).toBe(false);
  },
);

test(
  "a non-receipt failure with signing configured warns about a non-signing partner",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ConnectionError("simulated transport fault", "transport");
    }) as never);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    expect(mockState.runExchangeEntries).toBe(2);

    expect(
      mockState.warnings.some((m) => m.includes(NON_SIGNING_PARTNER_WARNING)),
    ).toBe(true);
  },
);

// --- The record a terminated run leaves behind -------------------------------
//
// A run that reaches the signed-receipt swap has already disclosed, so core hands
// the self-attested record of that disclosure back on the error it throws
// (docs/spec/PROTOCOL.md, Self-attested record). This pins runProtocol's half:
// the catch writes that record to the same destination a completed run's goes to,
// under --no-record it writes nothing, and the record itself is what says the run
// terminated.

const terminatedAudit = {
  record: {
    ...sampleRecord,
    outcome: "receipt-swap-terminated" as const,
    receiptBinder: "YmluZGVy",
  },
  keys: sampleKeys,
};

test(
  "a run that fails in the receipt swap still writes the record of what it disclosed",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });
    const recordA = path.join(tmpDir, "record-a.json");
    const recordB = path.join(tmpDir, "record-b.json");

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ReceiptVerificationError("simulated receipt pin mismatch");
    }) as never);
    vi.mocked(exchangeRecordFromFailure).mockReturnValue(terminatedAudit);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json"), {
        recordFile: recordA,
      }),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json"), {
        recordFile: recordB,
      }),
    ]);
    // The run still fails: keeping the record is not a rescue of the exchange.
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");

    for (const recordPath of [recordA, recordB]) {
      const written = parseExchangeRecord(
        JSON.parse(fs.readFileSync(recordPath, "utf8")),
      );
      expect(written).toEqual(terminatedAudit.record);
      // What separates it from a completed run's record travels in the file.
      expect(written.outcome).toBe("receipt-swap-terminated");
      expect(
        parseVerificationKeys(
          JSON.parse(fs.readFileSync(keysPathFor(recordPath), "utf8")),
        ),
      ).toEqual(sampleKeys);
    }
    // No dual-signed receipt accompanies it: a terminated swap persists no
    // partial artifact.
    expect(fs.existsSync(path.join(tmpDir, "receipt-a.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "receipt-b.json"))).toBe(false);
  },
);

test(
  "--no-record suppresses the terminated run's record as it does a completed run's",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ReceiptVerificationError("simulated receipt pin mismatch");
    }) as never);
    vi.mocked(exchangeRecordFromFailure).mockReturnValue(terminatedAudit);

    const [resultA, resultB] = await Promise.allSettled([
      runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
      runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
    ]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.startsWith("psilink-record-")),
    ).toHaveLength(0);
  },
);

// The other shape of the same loss on the failing path: the record was owed --
// the run had disclosed -- and core could not build it, so there is nothing to
// write and nothing to hand back. Core warns at the build, on the operator log
// alone, which an unattended run discards; these two pin that the machine stream
// carries the fact, and only when it is true.

test(
  "a terminated run whose record could not be built reports the loss on the stream",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });
    const recordA = path.join(tmpDir, "record-a.json");

    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new ReceiptVerificationError("simulated receipt pin mismatch");
    }) as never);
    // The disclosure happened and the record for it did not build: no pair comes
    // back on the error, and the predicate is what separates that from a failure
    // that owed nothing.
    vi.mocked(exchangeRecordFromFailure).mockReturnValue(undefined);
    vi.mocked(exchangeRecordOwedButUnbuilt).mockReturnValue(true);
    mockFd3Open();
    try {
      const [resultA, resultB] = await Promise.allSettled([
        runSigningParty(
          keyFileA,
          "test-a",
          path.join(tmpDir, "receipt-a.json"),
          { recordFile: recordA },
          { eventStream: true },
        ),
        runSigningParty(
          keyFileB,
          "test-b",
          path.join(tmpDir, "receipt-b.json"),
        ),
      ]);
      expect(resultA.status).toBe("rejected");
      expect(resultB.status).toBe("rejected");
    } finally {
      vi.mocked(fs.fstatSync).mockRestore();
    }

    // Only party A ran under --event-stream, so every captured line is its own.
    const lines = takeFd3Lines();
    expect(
      lines.filter((l) => l.type === "warning").map((l) => String(l.message)),
    ).toContain(TERMINATED_RECORD_UNBUILT_WARNING);
    // The run still fails on its own terms: the terminal event is the error, not
    // the persistence-loss report a completed run's lost artifact takes.
    expect(lines[lines.length - 1].type).toBe("error");
    expect(process.exitCode).not.toBe(73);
    // Nothing was written, which is what the warning says.
    expect(fs.existsSync(recordA)).toBe(false);
    expect(fs.existsSync(keysPathFor(recordA))).toBe(false);
  },
);

test(
  "a failure that owed no record stays silent on the stream",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    const keyFileA = path.join(tmpDir, "a.key");
    const keyFileB = path.join(tmpDir, "b.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });
    const recordA = path.join(tmpDir, "record-a.json");

    // A failure raised before the payloads flowed: no disclosure to attest, so
    // core marks the error neither way, which is what the mocked defaults stand
    // for here.
    vi.mocked(runExchange).mockImplementation((async () => {
      await awaitBothArmed();
      throw new Error("simulated failure before any payload crossed");
    }) as never);
    mockFd3Open();
    try {
      const [resultA, resultB] = await Promise.allSettled([
        runSigningParty(
          keyFileA,
          "test-a",
          path.join(tmpDir, "receipt-a.json"),
          { recordFile: recordA },
          { eventStream: true },
        ),
        runSigningParty(
          keyFileB,
          "test-b",
          path.join(tmpDir, "receipt-b.json"),
        ),
      ]);
      expect(resultA.status).toBe("rejected");
      expect(resultB.status).toBe("rejected");
    } finally {
      vi.mocked(fs.fstatSync).mockRestore();
    }

    const lines = takeFd3Lines();
    expect(
      lines.filter((l) => l.type === "warning").map((l) => String(l.message)),
    ).not.toContain(TERMINATED_RECORD_UNBUILT_WARNING);
  },
);

// --- Signing configured with record writing off ------------------------------
//
// A run that signs while `--no-record` suppresses the record produces a receipt
// nothing can ever pair to it, and the record cannot be rebuilt afterwards, so
// runProtocol warns while both choices are still the operator's to change.
// Warn, not refuse: the outcome of the run itself is untouched.
//
// The predicate cases below need no peer. They run the warn site and then land
// on preflightKeyFilePath, the next prepare-block throw after it, by passing an
// empty keyFilePath -- so each settles immediately, with no connection opened.

function runThroughWarnGate(
  signing: SigningPersist | null,
  recordOutput?: { recordFile?: string },
  eventStream?: boolean,
): Promise<unknown> {
  return runProtocol(
    { channel: "filedrop", path: dropDir },
    { sharedSecret: TOKEN_A, keyFilePath: "" },
    minimalPrepared,
    undefined,
    -1,
    "test",
    recordOutput,
    undefined,
    undefined,
    { eventStream },
    signing,
  ) as unknown as Promise<unknown>;
}

test("signing with records off warns on both the log and the event stream", async () => {
  // Both channels, because the population most likely to run this combination
  // and not notice is the unattended supervisor that discards stderr on success.
  mockFd3Open();
  try {
    await expect(
      runThroughWarnGate(
        signingPersistFixture(path.join(tmpDir, "receipt.json")),
        undefined,
        true,
      ),
    ).rejects.toThrow("non-empty keyFilePath");
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  expect(mockState.warnings).toContain(SIGNING_WITHOUT_RECORD_WARNING);
  // The warning precedes the prepare-phase terminal event, so it is on the
  // stream before anything the run could fail on -- and before any credential,
  // terms, or data would have been sent.
  const lines = takeFd3Lines();
  expect(lines.map((l) => l.type)).toEqual(["warning", "metrics", "error"]);
  expect(lines[0].message).toBe(SIGNING_WITHOUT_RECORD_WARNING);
});

test("a signing run that writes its record does not warn", async () => {
  await expect(
    runThroughWarnGate(
      signingPersistFixture(path.join(tmpDir, "receipt.json")),
      {
        recordFile: path.join(tmpDir, "rec.json"),
      },
    ),
  ).rejects.toThrow("non-empty keyFilePath");

  expect(mockState.warnings).not.toContain(SIGNING_WITHOUT_RECORD_WARNING);
});

test("an unsigned run with records off does not warn", async () => {
  // --no-record alone is an ordinary choice: nothing is left unpairable by it.
  await expect(runThroughWarnGate(null)).rejects.toThrow(
    "non-empty keyFilePath",
  );

  expect(mockState.warnings).not.toContain(SIGNING_WITHOUT_RECORD_WARNING);
});

test("the warned run still completes", { timeout: 20_000 }, async () => {
  // The guidance is advice, not a gate: a real two-party exchange with the
  // warned combination reaches the same completed outcome an unwarned one does.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const [resultA, resultB] = await Promise.allSettled([
    runSigningParty(keyFileA, "test-a", path.join(tmpDir, "receipt-a.json")),
    runSigningParty(keyFileB, "test-b", path.join(tmpDir, "receipt-b.json")),
  ]);
  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");

  // One per party: each side warns about its own configuration.
  expect(
    mockState.warnings.filter((m) => m === SIGNING_WITHOUT_RECORD_WARNING),
  ).toHaveLength(2);
});

// --- Signal and error handler recovery paths ---------------------------------
//
// SIGINT/SIGTERM tests mock process.exit so the handlers can run to completion
// without terminating the test process. vi.spyOn returns undefined rather than
// never, letting the async handler resolve normally. Each test restores the
// spy in a try/finally block for isolation.
//
// The recovery-message test does not need process.exit: runProtocol throws on
// errors and the test asserts on the rejected promise plus the captured log
// output. The runExchange mock is replaced so the first call (for whichever
// party becomes the first to reach runExchange) rejects with a synthetic
// transport error after the key exchange has rotated the secret, exercising the catch block
// in runProtocol that logs the recovery hint.

test("runProtocol suppresses the generic advisory when a tagged error is wrapped via `cause`", async () => {
  // The `psilinkRecoveryHintEmitted` tag is sometimes attached to an inner
  // error that a later catch wraps with `new Error(..., { cause: innerErr })`.
  // The runProtocol catch walks the cause chain so the wrap does not lose the
  // suppression. This test simulates that wrap by having runExchange throw a
  // wrapped error whose `cause` carries the tag.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  async function waitForRotationThenThrowWrapped(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    const inner = Object.assign(new Error("inner tagged failure"), {
      psilinkRecoveryHintEmitted: true,
    });
    throw new Error(`outer wrap: ${inner.message}`, { cause: inner });
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrowWrapped)
    .mockImplementationOnce(waitForRotationThenThrowWrapped);

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");

  // Neither generic advisory should fire: the tag is on the inner error,
  // not the outer wrap, but the cause walker finds it anyway.
  expectNoGenericRecoveryAdvisory(mockState.errors);
}, 20_000);

test("runProtocol suppresses the generic advisory for a terminal FrameSizeExceededError", async () => {
  // A terminal transport/directory UsageError thrown during the data exchange
  // reaches the catch with tokenRotated=true, where the generic "retry without
  // re-inviting" advisory would otherwise fire and contradict the error's own
  // terminal refusal. FrameSizeExceededError carries a class-level
  // psilinkRecoveryHintEmitted tag, so the hint-walker must suppress the generic
  // advisory -- this pins that the class tag is honored end to end, not just the
  // Object.assign tags the other tests cover.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  async function waitForRotationThenThrowFrameSize(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new FrameSizeExceededError("inbound frame exceeds the cap");
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrowFrameSize)
    .mockImplementationOnce(waitForRotationThenThrowFrameSize);

  const pA = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");

  // The terminal error's class tag suppresses both generic advisory lines.
  expectNoGenericRecoveryAdvisory(mockState.errors);
}, 20_000);

test("runProtocol suppresses the generic advisory for the reply-cap internal fault", async () => {
  // The single-pass reply-cap backstop fires mid-data-exchange, so it reaches the
  // catch with tokenRotated=true -- the one window where the generic "retry
  // without re-inviting" advisory does fire -- and its own message prescribes the
  // opposite: report the fault, because a retry rebuilds the same reply and
  // refuses it again. InternalConsistencyError carries the class-level
  // psilinkRecoveryHintEmitted tag, so the hint-walker suppresses the generic
  // advisory and the operator is left the fault's own remedy alone.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  async function waitForRotationThenThrowInternalFault(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new InternalConsistencyError(
      "server: single-pass built a reply of 4096 byte(s), above the 2048 " +
        "byte(s) both parties derive from their declared sizes. The exchange " +
        "cannot proceed; report it with this message.",
    );
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrowInternalFault)
    .mockImplementationOnce(waitForRotationThenThrowInternalFault);

  const pA = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  // The fault itself still propagates to the command boundary, which renders its
  // report-it remedy and maps the class to exit 70: the suppression removes the
  // contradicting line, not the guidance.
  expect((resultA as PromiseRejectedResult).reason).toBeInstanceOf(
    InternalConsistencyError,
  );
  expectNoGenericRecoveryAdvisory(mockState.errors);
}, 20_000);

test("runProtocol suppresses the generic advisory for the invitation-term divergence refusal", async () => {
  // The binding refuses at the terms exchange, inside the data exchange and so
  // after the token has rotated -- the window where the generic "retry without
  // re-inviting" advisory fires. A retry re-runs the same refusal against the
  // same invitation, so the advisory would tell an operator to loop; the
  // refusal's own message prescribes the step that ends it, obtaining an
  // invitation declaring what the partner will run.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  async function waitForRotationThenThrowDivergence(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new InvitationTermDivergenceError(
      "the partner presented linkage terms that contradict the invitation " +
        "this acceptance consented to",
    );
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrowDivergence)
    .mockImplementationOnce(waitForRotationThenThrowDivergence);

  const pA = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  // The refusal itself still reaches the command boundary, which renders its own
  // remedy: the suppression removes the contradicting line, not the guidance.
  expect((resultA as PromiseRejectedResult).reason).toBeInstanceOf(
    InvitationTermDivergenceError,
  );
  expectNoGenericRecoveryAdvisory(mockState.errors);
}, 20_000);

test("runProtocol logs recovery message when an error occurs after tokenRotated=true", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  // Throwing from both sides keeps the test deterministic: every protocol call
  // exercises the recovery-log catch branch in runProtocol.
  async function waitForRotationThenThrow(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new Error("simulated transport error after token rotation");
  }

  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrow)
    .mockImplementationOnce(waitForRotationThenThrow);

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "simulated transport error",
  );
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "simulated transport error",
  );

  expect(
    mockState.errors.some((m) =>
      m.includes("shared secret was already rotated and saved"),
    ),
  ).toBe(true);
}, 20_000);

test.skipIf(process.platform === "win32")(
  "runProtocol suppresses the generic authStarted advisory when the thrown error already carries the specific saveKeyFile recovery hint",
  async () => {
    // When saveKeyFile fails, runProtocol throws a wrapped error whose message
    // already says "authentication succeeded and the shared token was rotated,
    // but the updated token could not be saved...". The generic authStarted
    // advisory ("the partner may have already derived...while this side did
    // not") contradicts this -- it understates a definite local rotation.
    // The wrapped error sets `psilinkRecoveryHintEmitted: true` to suppress the
    // generic advisory; this test verifies neither generic hint is logged.
    //
    // To force saveKeyFile to fail AFTER the key exchange rotates (and not at the
    // pre-flight in runProtocol), we use a keyFilePath that pre-flight
    // accepts (a non-existent regular file path) but pre-create a directory
    // at saveKeyFile's tmp-file path (`${keyFilePath}.tmp.${pid}`) so the
    // initial unlinkSync inside saveKeyFile throws EISDIR/EPERM and aborts
    // the save. This isolates the failure to saveKeyFile while leaving
    // pre-flight green.
    //
    // Gated on POSIX: Windows `unlinkSync` on a directory can return EACCES,
    // EPERM, or "operation not permitted" depending on filesystem driver and
    // permissions; the existing saveKeyFile error path is uniform under
    // POSIX-style errno but not portable enough to assert against on Windows
    // without a separate fixture.
    const keyFileA = path.join(tmpDir, "a.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
    const bogusKeyFile = path.join(tmpDir, "b.key");
    fs.mkdirSync(`${bogusKeyFile}.tmp.${process.pid}`);

    const dropConfig = {
      channel: "filedrop" as const,
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    };

    // B starts first (becomes responder) so that B's saveKeyFile failure
    // happens after the key exchange completes but before B's runExchange is reached.
    const bPromise = runProtocol(
      {
        ...dropConfig,
      },
      { sharedSecret: TOKEN_A, keyFilePath: bogusKeyFile },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    );

    // Wait for B to register its hello file so role assignment is deterministic.
    await backdateDropDirRendezvousFile(dropDir);

    const aPromise = runProtocol(
      {
        ...dropConfig,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    );

    const [, resultB] = await Promise.allSettled([aPromise, bPromise]);
    expect(resultB.status).toBe("rejected");
    const msg = ((resultB as PromiseRejectedResult).reason as Error).message;
    // The thrown error carries the saveKeyFile-specific recovery hint.
    expect(msg).toContain(
      "authentication succeeded and the shared token was rotated",
    );
    expect(msg).toContain("Your partner may already hold the rotated token");
    // Neither generic catch-block advisory must fire: both would contradict the
    // wrapped error message.
    expectNoGenericRecoveryAdvisory(mockState.errors);
  },
  20_000,
);

test("runProtocol logs an 'error in flight when SIGINT arrived' error when interrupted", async () => {
  // When the signal arrives mid-runExchange and the caller swallows the
  // resulting error (so the CLI handler's process.exit(69) does not race the
  // signal handler's process.exit(130)), the in-flight error must still be
  // surfaced at error level so its diagnostic information is not lost even
  // under `--log-level=error`.
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;
  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () =>
        expect(vi.mocked(runExchange).mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 10_000 },
    );
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    rejectA(new Error("synthetic transport failure"));
    rejectB(new Error("synthetic transport failure"));

    await Promise.allSettled([pA, pB]);

    // The error text must reference both the signal name and the original
    // error message so that a user can correlate the two.
    expect(
      mockState.errors.some(
        (m) =>
          m.includes("SIGINT") && m.includes("synthetic transport failure"),
      ),
    ).toBe(true);
  } finally {
    exitSpy.mockRestore();
  }
}, 20_000);

test("runProtocol sanitizes a hostile cause chain in the signal in-flight log", async () => {
  // The in-flight error is swallowed on the signal path (the process exits on
  // the signal), so this log is the only place its cause surfaces. A hostile
  // cause -- a partner-chosen message-file path carrying control/ANSI bytes --
  // must be neutralized here, and the chain surfaced, like the per-command
  // catches.
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;
  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () =>
        expect(vi.mocked(runExchange).mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 10_000 },
    );
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    const hostile = () =>
      new Error("transport failed", {
        cause: new Error(
          "ENOENT: no such file or directory, open '/drop/\x1b[31mEVIL\nFAKE.json'",
        ),
      });
    rejectA(hostile());
    rejectB(hostile());

    await Promise.allSettled([pA, pB]);

    const inFlight = mockState.errors.find(
      (m) => m.includes("SIGINT") && m.includes("caused by:"),
    );
    expect(inFlight).toBeDefined();
    expect(inFlight).toContain("\\x1b[31mEVIL\\x0aFAKE.json");
    expect(inFlight).not.toContain("\x1b");
  } finally {
    exitSpy.mockRestore();
  }
}, 20_000);

test("SIGINT logs recovery message when tokenRotated=true", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;

  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () => {
        expect(loadKeyFile(keyFileA)?.sharedSecret).not.toBe(TOKEN_A);
        expect(loadKeyFile(keyFileB)?.sharedSecret).not.toBe(TOKEN_A);
      },
      { timeout: 10_000 },
    );

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    expect(
      mockState.warnings.some((m) =>
        m.includes("shared secret was already rotated and saved"),
      ),
    ).toBe(true);
  } finally {
    exitSpy.mockRestore();
    rejectA?.(new Error("test cleanup"));
    rejectB?.(new Error("test cleanup"));
    await Promise.allSettled([pA, pB]);
  }
}, 20_000);

test("SIGINT mid-synchronize exits with 130 and cleans up the hello file (started=false branch)", async () => {
  // Distinct from the SIGINT-mid-runExchange test: a single party is started
  // so no peer arrives, leaving synchronize() in waitForPeer indefinitely.
  // The party reaches `opened=true` but never `started=true`, so doCleanup
  // takes the started=false branch and conn.stop() is skipped. The hello
  // file written by synchronize() must be cleaned up by conn.cleanup()
  // before process.exit(130) is called.
  //
  // "Before" is read off the exit itself: the spy captures the drop directory as
  // it stands at the instant the handler calls exit, which is the ordering the
  // case is about. A directory read taken later, once the interrupted run has
  // been polled to completion, is satisfied by a cleanup that finished after the
  // exit too, and so cannot carry that claim.
  let helloFilesAtExit: string[] | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    if (code === 130 && helloFilesAtExit === undefined)
      helloFilesAtExit = fs
        .readdirSync(dropDir)
        .filter((f) => f.endsWith("-hello.json"));
    return undefined as never;
  });

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );

  try {
    // Hello file present in dropDir confirms synchronize() reached waitForPeer.
    // No mocked runExchange call expected: signal must arrive before that step.
    await vi.waitFor(
      () => {
        const entries = fs
          .readdirSync(dropDir)
          .filter((f) => f.endsWith("-hello.json"));
        expect(entries.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 },
    );
    expect(vi.mocked(runExchange).mock.calls.length).toBe(0);

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    // Cleanup ran before the exit and the hello file is gone -- otherwise a
    // retry would trip the "preexisting hello or lock files" guard.
    expect(helloFilesAtExit).toEqual([]);
  } finally {
    exitSpy.mockRestore();
    await Promise.allSettled([pA]);
  }
}, 20_000);

test("SIGTERM logs recovery message when tokenRotated=true", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;

  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () => {
        expect(loadKeyFile(keyFileA)?.sharedSecret).not.toBe(TOKEN_A);
        expect(loadKeyFile(keyFileB)?.sharedSecret).not.toBe(TOKEN_A);
      },
      { timeout: 10_000 },
    );

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143), {
      timeout: 5_000,
    });

    expect(
      mockState.warnings.some((m) =>
        m.includes("shared secret was already rotated and saved"),
      ),
    ).toBe(true);
  } finally {
    exitSpy.mockRestore();
    rejectA?.(new Error("test cleanup"));
    rejectB?.(new Error("test cleanup"));
    await Promise.allSettled([pA, pB]);
  }
}, 20_000);

// --- SIGINT/SIGTERM exit-code race ------------------------------------------
//
// Regression guard for the race where a signal-induced cleanup causes
// runExchange to throw, runProtocol's catch propagates the error, and the
// CLI handler's process.exit(69) preempts the signal handler's
// process.exit(130/143). After the fix runProtocol detects signalReceived
// and resolves rather than rejecting, so the CLI handler never enters its
// own exit path.

test("runProtocol resolves (does not reject) when interrupted by SIGINT mid-runExchange", async () => {
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;
  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () =>
        expect(vi.mocked(runExchange).mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 10_000 },
    );
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    // Simulate the production scenario: doCleanup closes the connection, so a
    // real runExchange would throw. We force that here by rejecting the mock
    // after the signal has been delivered.
    rejectA(new Error("synthetic post-signal failure"));
    rejectB(new Error("synthetic post-signal failure"));

    const [resultA, resultB] = await Promise.allSettled([pA, pB]);
    // Both runProtocol calls must resolve, not reject. A reject here would
    // mean the CLI handler's catch would fire and call process.exit(69),
    // racing the signal handler's 130.
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
  } finally {
    exitSpy.mockRestore();
  }
}, 20_000);

test("runProtocol resolves (does not reject) when interrupted by SIGTERM mid-runExchange", async () => {
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  let rejectA!: (err: Error) => void;
  let rejectB!: (err: Error) => void;
  vi.mocked(runExchange)
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectA = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectB = reject;
        }),
    );

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () =>
        expect(vi.mocked(runExchange).mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 10_000 },
    );
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143), {
      timeout: 5_000,
    });

    rejectA(new Error("synthetic post-signal failure"));
    rejectB(new Error("synthetic post-signal failure"));

    const [resultA, resultB] = await Promise.allSettled([pA, pB]);
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
  } finally {
    exitSpy.mockRestore();
  }
}, 20_000);

// --- Application-layer AEAD encryption ----------------------------------------

test("authenticated exchange runs through EncryptedMessageConnection: wire bytes are binary AEAD frames, not cleartext", async () => {
  // After the key exchange, runProtocol must wrap mc in EncryptedMessageConnection and run
  // the PSI exchange through it. This is asserted at the wire level: at least one
  // PSI frame written to the drop directory is an encrypted binary AEAD frame,
  // the cleartext probe never appears on the wire, and the peer decrypts the frame
  // back to its original form (proving a real AES-GCM round-trip through the
  // decorator, not a no-op pass-through). FileSyncConnection and
  // authenticateConnection are the real implementations here, so the session
  // key, the per-direction keys, and the envelopes are all genuine.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  // A distinctive cleartext probe; if it ever crossed the wire in cleartext the
  // raw-bytes substring check below would catch it. It rides the encrypted
  // channel, so it must never appear in any written frame.
  const CANARY = "PSILINK_CLEARTEXT_CANARY_!do-not-leak!";

  // Capture every byte the transport writes, at write time, before the peer's
  // poller can consume and delete the file (reading the directory afterwards
  // would race that deletion). vi.spyOn calls through to the real put().
  const putSpy = vi.spyOn(LocalFSClient.prototype, "put");

  // Coordinate the two mocked runExchange invocations: the initiator sends one
  // PSI frame through the encrypted connection it was handed, the responder
  // receives and decrypts it. The initiator waits for the responder to consume
  // before returning, so neither party's doCleanup sweeps the frame mid-flight.
  // The decorator pairs the initiator's send key with the responder's receive
  // key, so this direction also exercises the role-keyed HKDF derivation.
  let received: unknown;
  let signalConsumed!: () => void;
  const consumed = new Promise<void>((resolve) => {
    signalConsumed = resolve;
  });

  async function encryptingExchange(
    conn: {
      send: (d: unknown) => Promise<void>;
      receive: () => Promise<unknown>;
    },
    role: "initiator" | "responder",
  ): Promise<unknown> {
    if (role === "initiator") {
      await conn.send({ probe: CANARY });
      await consumed;
    } else {
      received = await conn.receive();
      signalConsumed();
    }
    return { associationTable: [[], []], partnerPayload: {} };
  }

  vi.mocked(runExchange).mockImplementation(encryptingExchange as never);

  try {
    await Promise.all([
      runProtocol(
        {
          channel: "filedrop",
          path: dropDir,
          options: TWO_PARTY_OPTIONS,
        },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        {
          channel: "filedrop",
          path: dropDir,
          options: TWO_PARTY_OPTIONS,
        },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);

    // 1. The peer decrypted the frame back to the exact object that was sent:
    //    the decorator performed a real AES-GCM round-trip, not a pass-through.
    expect(received).toEqual({ probe: CANARY });

    // Collect every non-empty body the transport wrote, normalized to its on-disk
    // bytes. A protocol frame is written either as a single Buffer (a hello or
    // ack) or, for a message, as a [header, payload] chunk list the transport
    // writes back-to-back -- FileSyncConnection.send streams the 10-byte header
    // and the payload as two chunks rather than concatenating them (the
    // peak-shaving framing). Assert every src is one of those two shapes -- never
    // a string or a stream, either of which could slip a cleartext frame past the
    // canary check below -- rather than silently filtering, so a future write that
    // smuggled bytes fails this test loudly.
    const writtenSrcs = putSpy.mock.calls.map((call) => call[0]);
    const wireBuffers: Buffer[] = [];
    for (const src of writtenSrcs) {
      let buf: Buffer;
      if (Buffer.isBuffer(src)) {
        buf = src;
      } else {
        expect(
          Array.isArray(src) && src.every((part) => part instanceof Uint8Array),
        ).toBe(true);
        buf = Buffer.concat(src as Uint8Array[]);
      }
      if (buf.length > 0) wireBuffers.push(buf);
    }

    // 2. The cleartext probe never crossed the wire in any frame (PSI or
    //    key-exchange) -- checked over the raw bytes, since frames are binary.
    for (const buf of wireBuffers) {
      expect(buf.includes(CANARY)).toBe(false);
    }

    // 3. At least one message frame is a binary-typed envelope whose payload is
    //    itself an AEAD envelope -- the PSI frame went out encrypted, not as a
    //    cleartext protocol frame. The file-sync envelope is
    //    `version || type || seq || payload`; the key-exchange handshake frames
    //    are MESSAGE_TYPE_OBJECT (JSON), while an encrypted AEAD frame rides a
    //    MESSAGE_TYPE_BINARY envelope. Checking the inner payload's leading
    //    AEAD_ENVELOPE_VERSION (not merely the outer cleartext MESSAGE_TYPE_BINARY
    //    discriminator, which any Uint8Array send would set) keeps this specific
    //    to the AEAD layer: a future raw-binary path that bypassed the decorator
    //    would fail it. The min length is the file-sync header plus the AEAD
    //    minimum (1-byte version + 12-byte IV + 16-byte tag).
    const aeadFrames = wireBuffers.filter(
      (buf) =>
        buf.length >= MESSAGE_HEADER_BYTES + 1 + 12 + 16 &&
        buf[0] === MESSAGE_ENVELOPE_VERSION &&
        buf[1] === MESSAGE_TYPE_BINARY &&
        buf[MESSAGE_HEADER_BYTES] === AEAD_ENVELOPE_VERSION,
    );
    expect(aeadFrames.length).toBeGreaterThanOrEqual(1);
  } finally {
    putSpy.mockRestore();
  }
}, 20_000);

// --- Post-handshake hook (onAuthenticated) -----------------------------------

test("runProtocol invokes onAuthenticated after the rotated key is saved and before the exchange begins", async () => {
  // The hook must fire at the moment of acceptance: after saveKeyFile has
  // rotated the on-disk token, but before runExchange runs. Party A carries the
  // hook; party B does not (exercising the no-hook path alongside). The hook
  // reads the key file (which must already show the rotated token) and inspects
  // the recorded exchange events (A's exchange must not have started yet).
  // Moving the hook after runExchange would flip the second assertion; moving it
  // before saveKeyFile would flip the first.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  // Record per-party exchange entry, keyed off a sentinel id on `prepared`, then
  // fall through to the default polling drain so the peer consumes the last
  // key-exchange message before runExchange resolves (avoids a cleanup/receive
  // race).
  const events: string[] = [];
  vi.mocked(runExchange).mockImplementation((async (...callArgs: unknown[]) => {
    const prepared = callArgs[2] as { id?: string };
    events.push(`exchange:${prepared.id ?? "?"}`);
    return defaultRunExchange();
  }) as never);

  const preparedA = { id: "A" } as unknown as PreparedExchange;
  const preparedB = { id: "B" } as unknown as PreparedExchange;

  let hookSawToken: string | undefined;
  let aExchangeRunAtHookTime: boolean | undefined;
  const onAuthenticatedA = () => {
    hookSawToken = loadKeyFile(keyFileA)?.sharedSecret;
    aExchangeRunAtHookTime = events.includes("exchange:A");
  };

  const [resultA] = await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      preparedA,
      undefined,
      -1,
      "test-a",
      undefined,
      undefined,
      onAuthenticatedA,
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      preparedB,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  // Fired after the key save: the hook saw a rotated (non-original) token.
  expect(hookSawToken).toBeDefined();
  expect(hookSawToken).not.toBe(TOKEN_A);
  // Fired before the exchange: A's runExchange had not run when the hook fired.
  expect(aExchangeRunAtHookTime).toBe(false);
  // A successful hook leaves no error in the result.
  expect(resultA.onAuthenticatedError).toBeUndefined();
}, 20_000);

test("runProtocol persists the onAuthenticated side effect even when the data exchange then fails", async () => {
  // The recurring-exchange guarantee: a handshake success followed by an
  // exchange failure must still leave the hook's persistence on disk (the
  // bootstrap callers write the config here). A marker file stands in for the
  // config write.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });
  const markerA = path.join(tmpDir, "config-a.marker");
  const markerB = path.join(tmpDir, "config-b.marker");

  async function waitForRotationThenThrow(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new Error("simulated data-exchange failure after rotation");
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrow)
    .mockImplementationOnce(waitForRotationThenThrow);

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
    undefined,
    undefined,
    () => fs.writeFileSync(markerA, "config-a"),
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
    undefined,
    undefined,
    () => fs.writeFileSync(markerB, "config-b"),
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  // The exchange failed, but the hook's persistence survived on both sides.
  expect(fs.existsSync(markerA)).toBe(true);
  expect(fs.existsSync(markerB)).toBe(true);
  // The handshake had succeeded: the token was rotated before the failure.
  expect(loadKeyFile(keyFileA)?.sharedSecret).not.toBe(TOKEN_A);
  expect(loadKeyFile(keyFileB)?.sharedSecret).not.toBe(TOKEN_A);
}, 20_000);

test("runProtocol's recovery hint does not promise a clean retry when the post-handshake hook failed", async () => {
  // Compound-failure regression: the handshake succeeds and the key rotates,
  // then the post-handshake persistence hook throws (so the config the bootstrap
  // callers write is NOT on disk), and the data exchange then also fails. The
  // catch must not tell the user to "retry the exchange without re-inviting" --
  // `psilink exchange` would have no config to run against -- but instead point
  // at the failed persistence step.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  async function waitForRotationThenThrow(): Promise<never> {
    await waitForBothKeysRotated(keyFileA, keyFileB);
    throw new Error("simulated data-exchange failure after rotation");
  }
  vi.mocked(runExchange)
    .mockImplementationOnce(waitForRotationThenThrow)
    .mockImplementationOnce(waitForRotationThenThrow);

  // The hook stands in for the bootstrap config write; throwing leaves
  // onAuthenticatedError set with no config on disk.
  const failingHook = () => {
    throw new Error("simulated config-write failure");
  };

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
    undefined,
    undefined,
    failingHook,
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
    undefined,
    undefined,
    failingHook,
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");

  // The corrected advisory is shown...
  expect(
    mockState.errors.some((m) => m.includes("nothing to run against")),
  ).toBe(true);
  // ...and the clean-retry advisory -- which would point `psilink exchange` at a
  // config that was never written -- is suppressed on both sides.
  expect(
    mockState.errors.some((m) =>
      m.includes("Retry the exchange without re-inviting"),
    ),
  ).toBe(false);
}, 20_000);

test("runProtocol does not invoke onAuthenticated when the handshake fails", async () => {
  // An expired token fails the pre-handshake expiry check in
  // authenticateConnection, before any token rotation. The hook must not fire
  // -- preserving the "declined or unreachable partner leaves no config behind"
  // guarantee -- so neither marker is written and neither token rotates.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  const expired = "2000-01-01T00:00:00.000Z";
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A, expires: expired });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A, expires: expired });
  const markerA = path.join(tmpDir, "config-a.marker");
  const markerB = path.join(tmpDir, "config-b.marker");

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    {
      sharedSecret: TOKEN_A,
      expires: expired,
      keyFilePath: keyFileA,
    },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
    undefined,
    undefined,
    () => fs.writeFileSync(markerA, "config-a"),
  );
  const pB = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: TWO_PARTY_OPTIONS,
    },
    {
      sharedSecret: TOKEN_A,
      expires: expired,
      keyFilePath: keyFileB,
    },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
    undefined,
    undefined,
    () => fs.writeFileSync(markerB, "config-b"),
  );

  const [resultA, resultB] = await Promise.allSettled([pA, pB]);
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  // Hook never fired: no marker on either side.
  expect(fs.existsSync(markerA)).toBe(false);
  expect(fs.existsSync(markerB)).toBe(false);
  // No rotation occurred: the original token is unchanged on both sides.
  expect(loadKeyFile(keyFileA)?.sharedSecret).toBe(TOKEN_A);
  expect(loadKeyFile(keyFileB)?.sharedSecret).toBe(TOKEN_A);
}, 20_000);

test("a throw from onAuthenticated is non-fatal: the exchange still runs and the failure is logged", async () => {
  // The data exchange is the irreplaceable operation; a config-write failure at
  // acceptance must not abort it. A's hook throws, but A's exchange still
  // completes and the failure is reported at error level (captured in
  // mockState.errors), not silently swallowed. Party B carries no hook.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const throwingHook = () => {
    throw new Error("simulated config write failure");
  };

  const [resultA, resultB] = await Promise.allSettled([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
      undefined,
      undefined,
      throwingHook,
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  // The exchange completed on both sides despite A's hook throwing.
  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");
  // The token still rotated (handshake + exchange succeeded).
  expect(loadKeyFile(keyFileA)?.sharedSecret).not.toBe(TOKEN_A);
  // The hook failure was reported at error level, not silently lost.
  expect(
    mockState.errors.some((m) => m.includes("post-authentication hook failed")),
  ).toBe(true);
  expect(
    mockState.errors.some((m) => m.includes("simulated config write failure")),
  ).toBe(true);
  // ...and is surfaced in the resolved result so the caller can fix its message.
  const valueA = (resultA as PromiseFulfilledResult<RunProtocolResult>).value;
  expect(valueA.onAuthenticatedError).toBeInstanceOf(Error);
  expect((valueA.onAuthenticatedError as Error).message).toBe(
    "simulated config write failure",
  );
}, 20_000);

test("a failed post-authentication hook warns on fd 3 and exits 73 with a result terminal event", async () => {
  // The unattended half of the same non-fatal contract: the exchange completed,
  // so the terminal event is a `result` and the run must NOT be re-run -- but
  // what the hook was there to persist is not on disk. A supervisor that
  // discards stderr reads that from the pair (warning + result) and, with no
  // fd 3 at all, from the exit code alone, which is the persistence-loss 73
  // rather than the 69 that would invite a retry of a completed exchange.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  mockFd3Open();
  try {
    const [resultA, resultB] = await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        () => {
          throw new Error("simulated config write failure");
        },
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
    // The exchange itself completed on both sides; only the hook was lost.
    expect(resultA.onAuthenticatedError).toBeInstanceOf(Error);
    expect(resultB.onAuthenticatedError).toBeUndefined();
    expect(process.exitCode).toBe(73);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // Party B ran without --event-stream, so every captured line is party A's.
  const lines = takeFd3Lines();
  const warnings = lines.filter((l) => l.type === "warning");
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0].message)).toContain(
    "the post-authentication persistence step",
  );
  // The cause stays on the human log: the emitter escapes its message once, so
  // pre-rendered error text would reach a supervisor double-escaped.
  expect(String(warnings[0].message)).not.toContain(
    "simulated config write failure",
  );
  // The terminal event is the success one, and it is last: the exchange is not
  // to be re-run.
  expect(lines[lines.length - 1].type).toBe("result");
  expect(lines.filter((l) => l.type === "error")).toHaveLength(0);
}, 20_000);

test("an async onAuthenticated that rejects is non-fatal: the exchange still runs and the rejection is logged", async () => {
  // The hook is awaited, so an async hook works and its rejected promise is
  // caught (not a detached unhandled rejection). Same non-fatal contract as the
  // synchronous-throw case: the exchange completes and the failure is logged.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const rejectingHook = async () => {
    await Promise.resolve();
    throw new Error("simulated async config write failure");
  };

  const [resultA, resultB] = await Promise.allSettled([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
      undefined,
      undefined,
      rejectingHook,
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  // The exchange completed despite A's async hook rejecting.
  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");
  expect(loadKeyFile(keyFileA)?.sharedSecret).not.toBe(TOKEN_A);
  // The rejection was caught and reported at error level, not detached.
  expect(
    mockState.errors.some((m) => m.includes("post-authentication hook failed")),
  ).toBe(true);
  expect(
    mockState.errors.some((m) =>
      m.includes("simulated async config write failure"),
    ),
  ).toBe(true);
  // ...and is surfaced in the resolved result, just like a synchronous throw.
  const valueA = (resultA as PromiseFulfilledResult<RunProtocolResult>).value;
  expect(valueA.onAuthenticatedError).toBeInstanceOf(Error);
  expect((valueA.onAuthenticatedError as Error).message).toBe(
    "simulated async config write failure",
  );
}, 20_000);

test("a hook that throws a falsy value still reports a defined onAuthenticatedError (failure never masquerades as success)", async () => {
  // The caller distinguishes failure from success by the presence of
  // onAuthenticatedError; a pathological `throw undefined` must not collapse to
  // the undefined "no error" value, so runProtocol coerces it to an Error.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  // `throw undefined` via a variable so the intent is explicit (and not read as
  // a thrown literal). This is the worst case the coercion guards against.
  const nothing: unknown = undefined;
  const throwFalsyHook = () => {
    throw nothing;
  };

  const [resultA, resultB] = await Promise.allSettled([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
      undefined,
      undefined,
      throwFalsyHook,
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  expect(resultA.status).toBe("fulfilled");
  expect(resultB.status).toBe("fulfilled");
  const valueA = (resultA as PromiseFulfilledResult<RunProtocolResult>).value;
  // Defined despite the falsy throw, so the caller's `=== undefined` success
  // guard correctly treats this as a failure rather than a clean write.
  expect(valueA.onAuthenticatedError).toBeDefined();
  expect(valueA.onAuthenticatedError).toBeInstanceOf(Error);
}, 20_000);

test("runProtocol without onAuthenticated runs a normal authenticated exchange (existing callers unaffected)", async () => {
  // zeroSetup and exchange pass no post-handshake hook; the new optional
  // parameter must leave that path unchanged -- the token rotates, both sides
  // agree, and no hook-related error is logged.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: TWO_PARTY_OPTIONS,
      },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  const a = loadKeyFile(keyFileA)?.sharedSecret;
  const b = loadKeyFile(keyFileB)?.sharedSecret;
  expect(a).toBeDefined();
  expect(a).not.toBe(TOKEN_A);
  expect(a).toBe(b);
  expect(
    mockState.errors.some((m) => m.includes("post-authentication hook")),
  ).toBe(false);
}, 20_000);

// --- Machine-interface event stream (--event-stream) --------------------------
//
// The flag-on tests below mock fstatSync for fd 3 (so the fail-closed preflight
// passes deterministically regardless of how the test process was spawned) and
// read the events from the fd-3 capture installed in beforeEach. Each drains the
// capture with takeFd3Lines() and accounts for every line, so the afterEach
// empty-capture assertion doubles as an exactly-one-terminal-event check.

/**
 * Make fstatSync succeed for fd 3 (pass every other target through), and count
 * the fd-3 probes in the returned live state. The probe is the observable half
 * of opening the stream -- the fail-closed preflight -- so a test that hands
 * runProtocol an already-open emitter asserts the count stayed at zero.
 */
function mockFd3Open(): { preflightProbes: number } {
  const state = { preflightProbes: 0 };
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) {
      state.preflightProbes += 1;
      return {} as fs.Stats;
    }
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  return state;
}

test("an expired shared secret under --event-stream emits exactly one terminal error event", async () => {
  // The expired-secret rejection (assertSharedSecretReadyForHandshake) fires in
  // the pre-connection prepare block, BEFORE the main try whose catch is the
  // other emission site; this pins that the prepare block's own catch emits the
  // terminal event for it. The error is a plain tagged Error (not an
  // OperatorConfigError, not a security-kind ConnectionError), so the category
  // is "exchange" per the classification rules.
  mockFd3Open();
  try {
    await expect(
      runProtocol(
        { channel: "filedrop", path: dropDir },
        {
          sharedSecret: TOKEN_A,
          expires: "2000-01-01T00:00:00.000Z",
          keyFilePath: path.join(tmpDir, "expired.key"),
        },
        minimalPrepared,
        undefined,
        -1,
        "test",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
    ).rejects.toThrow(/expired/);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // The events were flushed before the rejection propagated (emit precedes the
  // rethrow), so they are already in the capture here. The metrics summary
  // precedes the classified terminal error; both carry the schema version.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(2);
  expect(lines[0].type).toBe("metrics");
  expect(lines[1].type).toBe("error");
  expect(lines[1].category).toBe("exchange");
  expect(lines[1].v).toBe(1);
  expect(String(lines[1].message)).toContain("expired");
});

test("a main-try failure under --event-stream emits exactly one terminal error event (no double emission)", async () => {
  // conn.open() on a nonexistent drop path rejects inside the main try, whose
  // catch is the other emission site. Exactly one terminal (error) line -- after
  // the single metrics summary -- proves the prepare block's catch did not also
  // fire for the same failure.
  mockFd3Open();
  try {
    await expect(
      runProtocol(
        {
          channel: "filedrop",
          path: "/nonexistent-path-that-cannot-exist-psilink-test",
        },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
    ).rejects.toThrow();
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  expect(lines).toHaveLength(2);
  expect(lines[0].type).toBe("metrics");
  expect(lines[1].type).toBe("error");
  expect(lines[1].category).toBe("exchange");
  expect(lines[1].v).toBe(1);
}, 20_000);

test("a count-only run's terminal event carries the count beside resultWritten:false", async () => {
  // The outcome a supervisor reading only fd 3 would otherwise misreport: a
  // count-only run writes no result file, so its terminal event carries the same
  // resultWritten:false a withheld helper's does. The count is what separates
  // them, and it must ride the machine event rather than only the human log.
  mockCountOnlyRun("sender");

  mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        path.join(tmpDir, "count-only-stream.csv"),
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  expect(lines.map((line) => line.type)).toEqual([
    "stages",
    "metrics",
    "result",
  ]);
  expect(lines[2].resultWritten).toBe(false);
  expect(lines[2].intersectionCount).toBe(7);
  // The provenance the human line states rides the same event, so a console
  // rendering only fd 3 caveats the number exactly where the terminal does.
  expect(lines[2].countReportedByPartner).toBe(true);
}, 20_000);

test("a receiver seat's count-only event reports the count as computed here", async () => {
  // The other seat of the same pairing: this party ran the count-only round under
  // a mode the wire enforces, so its event states the provenance as false rather
  // than omitting the field. Omission is reserved for a run carrying no count at
  // all, so a consumer separating the two seats reads this value, not the field's
  // presence.
  mockCountOnlyRun("receiver");

  mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        path.join(tmpDir, "count-only-receiver-stream.csv"),
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  expect(lines.map((line) => line.type)).toEqual([
    "stages",
    "metrics",
    "result",
  ]);
  expect(lines[2].resultWritten).toBe(false);
  expect(lines[2].intersectionCount).toBe(7);
  expect(lines[2].countReportedByPartner).toBe(false);
}, 20_000);

test("a withheld result's terminal event carries no count at all", async () => {
  // The other side of the same discriminant: a helper whose terms give it no
  // output table has no count either, so the field is absent rather than zero.
  vi.mocked(runExchange).mockImplementation((async () => {
    await defaultRunExchange();
    return { associationTable: undefined, partnerPayload: {} };
  }) as never);

  mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        path.join(tmpDir, "withheld-stream.csv"),
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  expect(lines[lines.length - 1].type).toBe("result");
  expect(lines[lines.length - 1].resultWritten).toBe(false);
  expect("intersectionCount" in lines[lines.length - 1]).toBe(false);
  // With no count there is nothing to qualify, so the provenance field is absent
  // rather than a false that would read as a locally computed count.
  expect("countReportedByPartner" in lines[lines.length - 1]).toBe(false);
}, 20_000);

test("an emitter passed instead of the flag carries every event, and no second stream is opened", async () => {
  // The object-reuse branch, which the online bootstrap takes: that caller opens
  // the stream itself (it emits persistence warnings from outside this frame)
  // and hands the emitter over. runProtocol must drive THAT object -- opening
  // one of its own would take a second fail-closed preflight and build a second
  // writer, splitting one run's events across two streams. Both halves of the
  // second open are observable here: this emitter goes nowhere near fd 3, so a
  // preflight probe or a captured fd-3 line could only come from a writer
  // runProtocol built for itself.
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const record =
    (event: string) =>
    (...args: unknown[]): void => {
      emitted.push({ event, args });
    };
  const emitter: EventStreamEmitter = {
    stages: record("stages"),
    stage: record("stage"),
    stageEnd: record("stageEnd"),
    warning: record("warning"),
    metrics: record("metrics"),
    result: record("result"),
    error: record("error"),
  };

  const fd3 = mockFd3Open();
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: emitter },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // The whole run reported through the caller's object, terminal event included.
  // A matched run passes no count, so the terminal call carries the written flag
  // and an absent count (the builder omits the field entirely for it).
  expect(emitted.map((e) => e.event)).toEqual(["stages", "metrics", "result"]);
  expect(emitted[2].args).toEqual([true, undefined]);
  // Nothing re-ran the preflight and nothing reached the descriptor: the
  // already-preflighted emitter was reused rather than re-opened.
  expect(fd3.preflightProbes).toBe(0);
  expect(takeFd3Lines()).toHaveLength(0);
}, 20_000);

// --- The caller's pre-terminal hook ------------------------------------------

/** The received-payload column set the mocked exchange reports observing, so the
 *  hook's context is measured against a value the run actually produced rather
 *  than the empty default. */
const OBSERVED_PARTNER_COLUMNS = ["dob", "zip"];

/** Complete both parties' exchanges with a partner payload carrying `columns`,
 *  which runProtocol then hands the pre-terminal hook and returns. */
function mockExchangeObserving(columns: string[]): void {
  vi.mocked(runExchange).mockImplementation((async () => {
    const base = (await defaultRunExchange()) as Record<string, unknown>;
    return { ...base, partnerPayload: { columns, rowIndices: [], rows: [] } };
  }) as never);
}

test("a loss reported from the pre-terminal hook precedes the metrics and terminal events", async () => {
  // The ordering the whole hook exists for, measured on the REAL stream. The
  // online bootstrap's last write -- crystallizing the observed received-payload
  // set -- can fail, and the warning naming that loss is only useful ahead of the
  // terminal event: the spec makes the terminal event last, and a supervisor that
  // stops there discards anything behind it (apps/web's job manager drops
  // post-terminal events outright). Driven exactly as the bootstrap drives it:
  // the caller opens the stream, hands runProtocol the emitter, and reports from
  // the hook with that same object.
  mockExchangeObserving(OBSERVED_PARTNER_COLUMNS);
  const emitter = openEventStreamWithFdWired();
  let seen: string[] | undefined;
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        {
          eventStream: emitter,
          onOutputComplete: ({ observedReceivedPayloadColumns }) => {
            seen = observedReceivedPayloadColumns;
            reportPersistenceLoss("the lock-in was not recorded", emitter);
          },
        },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
    // Reported on the exit code too, from inside the hook rather than after it.
    expect(process.exitCode).toBe(73);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  expect(seen).toEqual(OBSERVED_PARTNER_COLUMNS);
  expect(takeFd3Lines().map((line) => line.type)).toEqual([
    "stages",
    "warning",
    "metrics",
    "result",
  ]);
}, 20_000);

test("a throw from the pre-terminal hook does not fail the completed exchange", async () => {
  // The hook reports its own losses, so a throw escaping it is a defect -- but
  // the exchange has already happened and cannot be undone by a local write, so
  // it must not turn a completed run into a failure. It still reports: an
  // unattended run that swallowed it silently would read as a clean success.
  mockExchangeObserving(OBSERVED_PARTNER_COLUMNS);
  const emitter = openEventStreamWithFdWired();
  let seen: string[] | undefined;
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        {
          eventStream: emitter,
          onOutputComplete: ({ observedReceivedPayloadColumns }) => {
            seen = observedReceivedPayloadColumns;
            throw new Error("the hook let one escape");
          },
        },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
    // The run resolved: the exchange completed and its observation reached the
    // hook, which is the only route it takes out of runProtocol.
    expect(seen).toEqual(OBSERVED_PARTNER_COLUMNS);
    expect(process.exitCode).toBe(73);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  expect(lines.map((line) => line.type)).toEqual([
    "stages",
    "warning",
    "metrics",
    "result",
  ]);
  // The cause stays on the human log; the stream warning carries first-party
  // prose only, so no pre-rendered error text reaches it double-escaped.
  expect(String(lines[1].message)).not.toContain("let one escape");
  expect(mockState.errors.some((line) => line.includes("let one escape"))).toBe(
    true,
  );
}, 20_000);

// --- Stage/warning stderr sanitization -----------------------------------------

test("a hostile stage label and terms warning reach the human log neutralized", async () => {
  // The onStage/onWarning strings can derive from partner-authored linkage-key
  // and column names. Drive both callbacks with the repo's hostile patterns (a
  // bidi override and an ANSI ESC sequence) through a real two-party run and
  // assert the captured stderr lines carry only the visible escapes.
  const hostileStageId = "user\u202eEVIL stage";
  const hostileWarning = "column \x1b[31mEVIL\x1b[0m mismatch";

  vi.mocked(runExchange).mockImplementationOnce((async (...args: unknown[]) => {
    const options = args[3] as {
      onStage?: (id: string) => void;
      onWarning?: (msg: string) => void;
    };
    // describeExchangeStages is mocked to [], so the raw id doubles as the
    // label the log line renders.
    options.onStage?.(hostileStageId);
    options.onWarning?.(hostileWarning);
    return defaultRunExchange();
  }) as never);

  await Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  const stageLine = mockState.infos.find((m) => m.includes("EVIL stage"));
  expect(stageLine).toBeDefined();
  expect(stageLine).not.toContain("\u202e");
  expect(stageLine).toContain("\\u202e");

  const warnLine = mockState.warnings.find((m) =>
    m.includes("terms exchange:"),
  );
  expect(warnLine).toBeDefined();
  expect(warnLine).not.toContain("\x1b");
  expect(warnLine).toContain("\\x1b");
}, 20_000);

// --- connection_per_poll threads to the SFTP adapter -------------------------
//
// The resolved config's connectionPerPoll must set the SFTP adapter's
// ephemeralSessions constructor option, turning on connection-per-poll
// (ephemeral-session) mode end to end. The mock adapter records its constructor
// options so the wiring is asserted with no live server; the run then rejects at
// the pinned-host-key verifier, which is irrelevant here -- the constructor has
// already run and recorded its options.

test("runProtocol threads connection_per_poll into the adapter's ephemeralSessions", async () => {
  await runProtocol(
    {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      },
      options: { connectionPerPoll: true },
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test",
  ).catch(() => undefined);
  expect(mockState.lastSftpAdapterOptions?.["ephemeralSessions"]).toBe(true);
});

test("runProtocol leaves ephemeralSessions unset when connection_per_poll is absent", async () => {
  await runProtocol(
    {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      },
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test",
  ).catch(() => undefined);
  expect(
    mockState.lastSftpAdapterOptions?.["ephemeralSessions"],
  ).toBeUndefined();
});

// --- Security classification, end to end ---------------------------------------
//
// The two canonical trust-boundary failures must classify as category "security"
// on the event stream from their REAL production paths (not a hand-built
// ConnectionError): a failed key-exchange authentication driven by a genuine
// mismatched-secret handshake over the real filedrop transport, and an SFTP
// host-key verification failure driven through core's real hostVerifier wrap
// (mocked transport). Both must keep exit code 69, pinned through the real
// runOrExit mapper fed the real captured error.

test("a mismatched shared secret under --event-stream emits category security and maps to exit 69", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });

  // Party B: a real peer running the real key exchange with a DIFFERENT
  // token, orchestrated by hand (open/synchronize/start, then
  // authenticateConnection) exactly as authentication.test.ts does. Its
  // teardown is deferred until both parties settle so its handshake files --
  // including a best-effort abort -- stay readable for party A. Its own
  // outcome is not asserted (it may see the generic failure or, if A's
  // teardown swept the abort file first, a bounded transport timeout).
  const connB = new FileSyncConnection(new LocalFSClient(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  const partyB = (async () => {
    await connB.open({ channel: "filedrop", path: dropDir });
    await connB.synchronize();
    connB.start();
    const roleB = connB.handshakeRole;
    if (roleB === undefined) throw new Error("party B resolved no role");
    const mcB = fromEventConnection(connB, { inactivityTimeoutMs: 2000 });
    return authenticateConnection(mcB, { sharedSecret: TOKEN_B }, roleB, true);
  })();

  mockFd3Open();
  let resA: PromiseSettledResult<unknown>;
  try {
    [resA] = await Promise.allSettled([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      partyB,
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
    await connB.close().catch(() => {});
  }

  // The real handshake failure: the generic non-oracular message, carried by a
  // security-kind ConnectionError.
  expect(resA.status).toBe("rejected");
  const reasonA = (resA as PromiseRejectedResult).reason as unknown;
  expect(reasonA).toBeInstanceOf(ConnectionError);
  expect((reasonA as ConnectionError).kind).toBe("security");
  expect((reasonA as ConnectionError).message).toBe(
    "key exchange authentication failed",
  );

  // Exactly one terminal event, classified security, after the metrics summary.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(2);
  expect(lines[0].type).toBe("metrics");
  expect(lines[1].type).toBe("error");
  expect(lines[1].category).toBe("security");
  expect(lines[1].v).toBe(1);

  // The exit code stays 69: feed the real captured error through the real
  // command exit mapper (a ConnectionError is not a UsageError and carries no
  // exitCode of its own).
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  try {
    await runOrExit("test-a", () => Promise.reject(reasonA));
    expect(exitSpy).toHaveBeenCalledWith(69);
  } finally {
    exitSpy.mockRestore();
  }
}, 20_000);

test("an SFTP host-key mismatch under --event-stream emits category security and maps to exit 69", async () => {
  // The pinned fingerprint is well-formed but matches no key, so core's real
  // hostVerifier wrap (driven by the mocked adapter's connect) fails closed
  // with its mismatch error.
  mockFd3Open();
  let err: unknown;
  try {
    err = await runProtocol(
      {
        channel: "sftp",
        server: {
          host: "sftp.example.org",
          hostKeyFingerprint: "SHA256:" + "A".repeat(43),
        },
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test",
      undefined,
      undefined,
      undefined,
      { eventStream: true },
    ).then(
      () => {
        throw new Error("expected the host-key mismatch to reject");
      },
      (e: unknown) => e,
    );
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  expect((err as Error).message).toMatch(/SFTP host-key verification failed/);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");

  const lines = takeFd3Lines();
  expect(lines).toHaveLength(2);
  expect(lines[0].type).toBe("metrics");
  expect(lines[1].type).toBe("error");
  expect(lines[1].category).toBe("security");
  expect(lines[1].v).toBe(1);

  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  try {
    await runOrExit("test", () => Promise.reject(err));
    expect(exitSpy).toHaveBeenCalledWith(69);
  } finally {
    exitSpy.mockRestore();
  }
});

test("a host-key divergence under --event-stream emits a warning event and still warns on stderr", async () => {
  // The divergence notice is the one control that catches a one-sided SFTP
  // interception, and a supervisor that discards child stderr on success (the
  // appliance job runner) would otherwise lose it -- so it must ride the fd-3
  // stream as a structured warning event, in addition to the human warn line.
  const divergence =
    "Both observed key type 'ssh-ed25519', but this party observed " +
    `fingerprint SHA256:${"A".repeat(43)} while the partner observed ` +
    `SHA256:${"B".repeat(43)}.`;

  vi.mocked(runExchange).mockImplementation((async (...args: unknown[]) => {
    const options = args[3] as {
      onHostKeyDivergence?: (msg: string) => void;
    };
    options.onHostKeyDivergence?.(divergence);
    return defaultRunExchange();
  }) as never);

  mockFd3Open();
  try {
    // Party A runs flag-on; party B flag-off, so every captured fd-3 line is
    // A's (the afterEach empty-capture assertion backs this up). The mocked
    // runExchange fires the divergence callback for both parties, so the
    // emission is exercised regardless of which party reaches it first.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // A's full stream: the one-shot (empty, mocked) stage list, the divergence
  // warning, the metrics summary, and the success terminal event. The mocked
  // runExchange fires no onStage, so there is no stageEnd line.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(4);
  expect(lines[0].type).toBe("stages");
  expect(lines[1].type).toBe("warning");
  expect(lines[1].v).toBe(1);
  expect(lines[1].message).toBe(divergence);
  expect(lines[2].type).toBe("metrics");
  expect(lines[3].type).toBe("result");

  // The stderr warn line is preserved verbatim: un-prefixed, unlike the
  // "terms exchange:" lines onWarning produces.
  expect(mockState.warnings).toContain(divergence);
}, 20_000);

test("a terms-exchange warning under --event-stream reaches the fd-3 warning event", async () => {
  // The partner-width notice (packages/core/src/protocolSetup.ts) is a
  // terms-exchange warning, so it rides onWarning. An unattended run is the case
  // it exists for -- nobody is watching the terminal when a scheduled exchange
  // runs wider than the terms its operator agreed to -- so it has to land on the
  // machine-readable stream a supervisor reads, not only on stderr.
  const widthNotice =
    "effective key count above the agreed terms: partner advertised 21 " +
    "value slot(s) per record against the 2 the agreed linkage keys imply; " +
    "the extra width is the partner's own declaration and is not shown in " +
    "the agreed terms";

  vi.mocked(runExchange).mockImplementation((async (...args: unknown[]) => {
    const options = args[3] as { onWarning?: (msg: string) => void };
    options.onWarning?.(widthNotice);
    return defaultRunExchange();
  }) as never);

  mockFd3Open();
  try {
    // Party A runs flag-on, party B flag-off, so every captured fd-3 line is A's.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  const warning = lines.find((line) => line.type === "warning");
  expect(warning).toBeDefined();
  expect(warning!.v).toBe(1);
  // Numbers and first-party prose only, and short of the per-value display cap,
  // so both sinks carry the notice whole: neither escape rewrites or cuts it.
  expect(warning!.message).toBe(widthNotice);
  // Present on the human log too, under the terms-exchange prefix.
  expect(
    mockState.warnings.some(
      (line) => line.includes("terms exchange:") && line.includes(widthNotice),
    ),
  ).toBe(true);
}, 20_000);

test("a terms-exchange warning past the per-value cap reaches stderr as whole as it reaches fd 3", async () => {
  // A terms warning is a COMPOSITION -- first-party explanation and recovery
  // text around fragments each escaped and capped where they were interpolated
  // -- so both CLI sinks carry one text and neither may deliver less of it than
  // the other. Charging the stderr line to the per-value cap deletes the
  // recovery clause a composed warning ends on while fd 3 relays the whole of
  // it, which is the operator at the terminal reading less than the supervisor
  // reading the machine channel. No warning core composes today is this wide,
  // so the width is driven here rather than waited for.
  const partnerKeys = Array.from(
    { length: 12 },
    (_, index) => `partner_linkage_key_${index}`,
  ).join(", ");
  const composedWarning =
    `linkage key set mismatch: the partner's copy of the agreed terms names ` +
    `[${partnerKeys}], which is not the set this party's copy names; one ` +
    `party may have a stale copy of the linkage terms, so compare the two ` +
    `copies out of band before you re-run the exchange`;
  expect(composedWarning.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
  expect(composedWarning.length).toBeLessThan(
    WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  );

  vi.mocked(runExchange).mockImplementation((async (...args: unknown[]) => {
    const options = args[3] as { onWarning?: (msg: string) => void };
    options.onWarning?.(composedWarning);
    return defaultRunExchange();
  }) as never);

  mockFd3Open();
  try {
    // Party A runs flag-on, party B flag-off, so every captured fd-3 line is A's.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const warning = takeFd3Lines().find((line) => line.type === "warning");
  expect(warning).toBeDefined();
  expect(warning!.message).toBe(composedWarning);

  // The same text on the human log, prefix aside: equality rather than
  // containment, so a cap that shortened either sink fails here.
  const stderrLine = mockState.warnings.find((line) =>
    line.startsWith("terms exchange:"),
  );
  expect(stderrLine).toBe(`terms exchange: ${warning!.message as string}`);
  expect(stderrLine).not.toContain(DISPLAY_TRUNCATION_MARKER);
}, 20_000);

test("a failed onAuthenticated hook under --event-stream emits a warning event before the success terminal event", async () => {
  // The run completes and writes its result, so the terminal event is a success:
  // a supervisor that discards stderr would read the whole stream as a clean
  // provisioning while the configuration never reached disk. The warning event is
  // what tells it the setup is half provisioned, and it must arrive before the
  // terminal event like every other non-terminal line.
  const keyFileA = path.join(tmpDir, "hook-event-a.key");
  const keyFileB = path.join(tmpDir, "hook-event-b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  mockFd3Open();
  try {
    // Party A runs flag-on and carries the throwing hook; party B flag-off and
    // hookless, so every captured fd-3 line is A's.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        () => {
          throw new Error("simulated config write failure");
        },
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        { sharedSecret: TOKEN_A, keyFilePath: keyFileB },
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // The hook runs at the moment of acceptance, before the exchange proper, so
  // its warning precedes even the stage list.
  const lines = takeFd3Lines();
  expect(lines.map((l) => l.type)).toEqual([
    "warning",
    "stages",
    "metrics",
    "result",
  ]);
  expect(String(lines[0].message)).toContain("did not complete");
  // The cause stays on the human log, which the warning event deliberately does
  // not repeat (its own escape pass would double-escape rendered error text).
  expect(String(lines[0].message)).not.toContain("simulated config write");
  expect(
    mockState.errors.some((m) => m.includes("simulated config write failure")),
  ).toBe(true);
}, 20_000);

// --- Stage timing and operational counters -------------------------------------

test("a successful run under --event-stream reports stage timing and counters", async () => {
  // Drive two real stage transitions through the mocked runExchange so the
  // stream carries a stageEnd (with a duration) for each completed stage, then a
  // metrics summary, then the success terminal event. recordsProcessed reflects
  // this party's own input row count; a clean filedrop run retried/reconnected
  // zero times.
  const preparedWithRows = { rowCount: 7 } as unknown as PreparedExchange;
  vi.mocked(runExchange).mockImplementation((async (...args: unknown[]) => {
    const options = args[3] as { onStage?: (id: string) => void };
    options.onStage?.("stage 1 / 2");
    options.onStage?.("stage 2 / 2");
    return defaultRunExchange();
  }) as never);

  mockFd3Open();
  try {
    // Party A runs flag-on; party B flag-off, so every captured fd-3 line is A's.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        preparedWithRows,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        preparedWithRows,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    vi.mocked(fs.fstatSync).mockRestore();
  }

  const lines = takeFd3Lines();
  // A stageEnd closes each stage: the first when the second starts, the second
  // when the exchange completes. The metrics summary precedes the terminal event.
  expect(lines.map((l) => l.type)).toEqual([
    "stages",
    "stage",
    "stageEnd",
    "stage",
    "stageEnd",
    "metrics",
    "result",
  ]);

  const stageEnds = lines.filter((l) => l.type === "stageEnd");
  expect(stageEnds.map((l) => l.id)).toEqual(["stage 1 / 2", "stage 2 / 2"]);
  for (const stageEnd of stageEnds) {
    expect(typeof stageEnd.durationMs).toBe("number");
    expect(stageEnd.durationMs as number).toBeGreaterThanOrEqual(0);
  }

  const metrics = lines.find((l) => l.type === "metrics")!;
  expect(metrics.v).toBe(1);
  expect(metrics.recordsProcessed).toBe(7);
  expect(metrics.transportRetries).toBe(0);
  expect(metrics.reconnects).toBe(0);
}, 20_000);

test("summarizes the reconnect count at normal verbosity when the session was re-established", async () => {
  // Without --event-stream the reconnect count reaches the operator nowhere, so a
  // server that repeatedly dropped and was re-dialed would be invisible on a
  // normal run. runProtocol logs a one-line teardown summary at info instead.
  // Force a non-zero count on the (real) file-drop client via its reconnectCount
  // getter; midExchangeReconnectCount stays 0 (a file-drop channel holds no
  // session), so this is the connect-retries-only case: the summary reports just
  // the total and omits the mid-exchange session-re-dial clause entirely.
  const reconnectSpy = vi
    .spyOn(LocalFSClient.prototype, "reconnectCount", "get")
    .mockReturnValue(3);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    reconnectSpy.mockRestore();
  }

  expect(
    mockState.infos.some(
      (line) =>
        line.includes("re-established 3 times") &&
        line.includes("during this exchange"),
    ),
  ).toBe(true);
  // No session was lost mid-exchange, so the "of which ... mid-exchange" clause
  // -- and its session terminology, which does not apply to a file-drop channel
  // -- must not appear.
  expect(mockState.infos.some((line) => line.includes("mid-exchange"))).toBe(
    false,
  );
  expect(mockState.infos.some((line) => line.includes("of which"))).toBe(false);
}, 20_000);

test("summary reports the mid-exchange sub-count apart from the total", async () => {
  // A single merged reconnect number cannot tell benign startup retries from
  // chronic mid-exchange session drops. The summary reports the mid-exchange
  // sub-count distinctly so the operator sees the signal that matters. Force a
  // total of 4 with 3 of them sessions lost mid-exchange on the (real) file-drop
  // client via its metric getters.
  const reconnectSpy = vi
    .spyOn(LocalFSClient.prototype, "reconnectCount", "get")
    .mockReturnValue(4);
  const midExchangeSpy = vi
    .spyOn(LocalFSClient.prototype, "midExchangeReconnectCount", "get")
    .mockReturnValue(3);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    reconnectSpy.mockRestore();
    midExchangeSpy.mockRestore();
  }

  expect(
    mockState.infos.some(
      (line) =>
        line.includes("re-established 4 times") &&
        line.includes("of which 3 were sessions lost mid-exchange"),
    ),
  ).toBe(true);
}, 20_000);

test("summarizes the forced idle-boundary releases apart from the reconnects", async () => {
  // In connection-per-poll mode a partner that never closes the connection makes
  // the release close it from this side, once per cycle. The inline WARN is paced
  // (the first, then every tenth), so a run whose last one falls between those
  // states its true total nowhere -- and an operator who left the run unattended
  // cannot tell afterwards how the partner's server behaved. The teardown summary
  // reports it, apart from the reconnect line and in terms that cannot be read as a
  // dropped session. Forced on the (real) file-drop client via its metric getter.
  const forcedSpy = vi
    .spyOn(LocalFSClient.prototype, "forcedReleaseCount", "get")
    .mockReturnValue(7);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    forcedSpy.mockRestore();
  }

  const summary = mockState.infos.find((line) =>
    line.includes("did not close when released at 7 idle boundaries"),
  );
  expect(summary).toBeDefined();
  expect(summary).toContain("so it was closed from this side");
  // The forced close is a mechanism rather than a verdict on who ended the
  // session -- a release forced over a transport a partner's drop had already
  // ended reaches it too -- so this line says nothing about whether a session was
  // lost, and must not tell the operator none was.
  expect(summary).not.toContain("not a dropped session");
  // Whether a session was lost at one of these boundaries is the reconnect
  // summary's to report, and this run staged none.
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
}, 20_000);

test("summarizes the declined idle releases as a line apart from the forced ones", async () => {
  // The mode's other per-cycle outcome: the release gave up its wait for another
  // session transition and closed nothing, so the session it exists to release was
  // held across the idle gap. Its WARN is paced exactly like the forced release's
  // and states its true total nowhere else, so the teardown summary carries it --
  // as its own line, because the two report opposite outcomes and a reader who saw
  // them merged could not tell a boundary this side ended from one it never
  // reached. Both forced on the (real) file-drop client via its metric getters,
  // with distinct totals so neither line can be reporting the other's count.
  const forcedSpy = vi
    .spyOn(LocalFSClient.prototype, "forcedReleaseCount", "get")
    .mockReturnValue(3);
  const declinedSpy = vi
    .spyOn(LocalFSClient.prototype, "declinedReleaseCount", "get")
    .mockReturnValue(5);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    forcedSpy.mockRestore();
    declinedSpy.mockRestore();
  }

  const declined = mockState.infos.find((line) =>
    line.includes("did not close the session at 5 idle boundaries"),
  );
  expect(declined).toBeDefined();
  expect(declined).toContain("not a dropped session");
  expect(declined).toContain("the session stayed live across those idle gaps");
  // The forced line is still its own, on its own count: nothing was summed, and
  // the decline does not borrow the forced release's "this side closed it".
  expect(declined).not.toContain("closed from this side");
  expect(
    mockState.infos.some(
      (line) =>
        line.includes("did not close when released at 3 idle boundaries") &&
        line.includes("so it was closed from this side"),
    ),
  ).toBe(true);
  expect(mockState.infos.some((line) => line.includes("8 idle"))).toBe(false);
  // Neither outcome is a reconnection, so nothing about them may reach the
  // reconnect summary.
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
}, 20_000);

test("summarizes the boundaries the partner closed on request as the forced total's denominator", async () => {
  // The mode's ordinary outcome has no inline line at all -- nothing anomalous
  // happens when a server closes on request -- so the teardown summary is where an
  // operator learns it worked, and how often. Read beside the forced total it is
  // the denominator for: 3 forced out of 3 boundaries is a server that never
  // closes, 3 out of 60 is a server that occasionally lags, and the forced count
  // alone cannot tell them apart. Separate lines on separate counts, neither
  // summed into the other.
  const releasedSpy = vi
    .spyOn(LocalFSClient.prototype, "releasedBoundaryCount", "get")
    .mockReturnValue(57);
  const forcedSpy = vi
    .spyOn(LocalFSClient.prototype, "forcedReleaseCount", "get")
    .mockReturnValue(3);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    releasedSpy.mockRestore();
    forcedSpy.mockRestore();
  }

  const released = mockState.infos.find((line) =>
    line.includes("closed the SFTP session at 57 idle boundaries"),
  );
  expect(released).toBeDefined();
  expect(released).toContain("re-dialed at the start of the next poll cycle");
  // The mode working is not a session this side had to close itself, and not a
  // drop: neither the forced line nor the reconnect line absorbs it.
  expect(released).not.toContain("closed from this side");
  expect(
    mockState.infos.some((line) =>
      line.includes("did not close when released at 3 idle boundaries"),
    ),
  ).toBe(true);
  expect(mockState.infos.some((line) => line.includes("60 idle"))).toBe(false);
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
}, 20_000);

test("summarizes the poll cycles a declined cycle-start re-dial skipped", async () => {
  // The dialing half of what the declined release reports for the releasing half:
  // one stuck transition declines both signals of the same cycle, and a cycle that
  // carried no session at all is what the operator needs to see. Its inline WARN is
  // paced like every other, so the run total is stated nowhere else. Distinct
  // totals here, so neither line can be reporting the other's count.
  const skippedSpy = vi
    .spyOn(LocalFSClient.prototype, "declinedCycleRedialCount", "get")
    .mockReturnValue(4);
  const declinedSpy = vi
    .spyOn(LocalFSClient.prototype, "declinedReleaseCount", "get")
    .mockReturnValue(6);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    skippedSpy.mockRestore();
    declinedSpy.mockRestore();
  }

  const skipped = mockState.infos.find((line) =>
    line.includes("re-dial skipped 4 poll cycles"),
  );
  expect(skipped).toBeDefined();
  expect(skipped).toContain("not a dropped session");
  expect(skipped).toContain("those cycles had no session");
  expect(
    mockState.infos.some((line) =>
      line.includes("did not close the session at 6 idle boundaries"),
    ),
  ).toBe(true);
  expect(mockState.infos.some((line) => line.includes("10 poll"))).toBe(false);
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
}, 20_000);

test("summarizes the held idle boundaries as a line apart from the forced and declined ones", async () => {
  // The mode's third per-cycle outcome, and the only one with no inline line at
  // all: a boundary held for an operation this side had issued is ordinary, so it
  // is never warned per occurrence. The run total is still the operator's only
  // signal that the mode stopped delivering per-cycle sessions -- an operation with
  // no bound of its own holds every remaining boundary -- so the teardown summary
  // carries it, as its own line naming its own cause: neither a session this side
  // closed nor a release that gave up its wait. Three distinct totals, so no line
  // can be reporting another's count.
  const forcedSpy = vi
    .spyOn(LocalFSClient.prototype, "forcedReleaseCount", "get")
    .mockReturnValue(3);
  const declinedSpy = vi
    .spyOn(LocalFSClient.prototype, "declinedReleaseCount", "get")
    .mockReturnValue(5);
  const heldSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryCount", "get")
    .mockReturnValue(9);
  const stretchSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryStretchCount", "get")
    .mockReturnValue(9);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    forcedSpy.mockRestore();
    declinedSpy.mockRestore();
    heldSpy.mockRestore();
    stretchSpy.mockRestore();
  }

  const held = mockState.infos.find((line) =>
    line.includes("held the SFTP session at 9 idle boundaries"),
  );
  expect(held).toBeDefined();
  expect(held).toContain("not a dropped session");
  expect(held).toContain(
    "an operation this side had issued was still unsettled",
  );
  expect(held).toContain("the session stayed live across those idle gaps");
  // It borrows neither sibling's cause: the forced line's socket this side closed,
  // or the decline's transition that did not complete within the release's wait.
  expect(held).not.toContain("closed from this side");
  expect(held).not.toContain("release's wait");
  // Both siblings still report their own counts, on their own lines.
  expect(
    mockState.infos.some(
      (line) =>
        line.includes("did not close when released at 3 idle boundaries") &&
        line.includes("so it was closed from this side"),
    ),
  ).toBe(true);
  expect(
    mockState.infos.some((line) =>
      line.includes("did not close the session at 5 idle boundaries"),
    ),
  ).toBe(true);
  // Nothing was summed into anything: not a pair, not all three.
  for (const summed of ["8 idle", "12 idle", "14 idle", "17 idle"])
    expect(mockState.infos.some((line) => line.includes(summed))).toBe(false);
  // A hold is not a reconnection, so nothing about it may reach the reconnect
  // summary.
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
}, 20_000);

test("held boundaries exceeding their stretches state the stretch count", async () => {
  // What separates one unbounded operation holding twenty boundaries from twenty
  // that each settled in between: the first has stopped the mode for the rest of
  // the run, the second is the mode working. The boundary count alone cannot say
  // which, so the sub-clause carries the stretches whenever they say something it
  // does not.
  const heldSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryCount", "get")
    .mockReturnValue(20);
  const stretchSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryStretchCount", "get")
    .mockReturnValue(2);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    heldSpy.mockRestore();
    stretchSpy.mockRestore();
  }

  const held = mockState.infos.find((line) =>
    line.includes("held the SFTP session at 20 idle boundaries"),
  );
  expect(held).toBeDefined();
  expect(held).toContain("in 2 unbroken stretches");
}, 20_000);

test("held boundaries equal to their stretches omit the stretch sub-clause", async () => {
  // Every hold cost exactly one boundary, so the sub-count restates the total and
  // adds nothing but noise.
  const heldSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryCount", "get")
    .mockReturnValue(6);
  const stretchSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryStretchCount", "get")
    .mockReturnValue(6);
  try {
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    heldSpy.mockRestore();
    stretchSpy.mockRestore();
  }

  const held = mockState.infos.find((line) =>
    line.includes("held the SFTP session at 6 idle boundaries"),
  );
  expect(held).toBeDefined();
  expect(held).not.toContain("unbroken");
}, 20_000);

test("a held boundary with no session drop leaves the reconnect total and the metrics event untouched", async () => {
  // A held boundary closed nothing, so nothing was lost. The reconnect total stays
  // what it would have been -- here zero, so the line does not appear at all -- and
  // the machine metrics event carries its own three counters and nothing else.
  // Neither held count reaches either: they are an operator-facing line only.
  const heldSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryCount", "get")
    .mockReturnValue(11);
  const stretchSpy = vi
    .spyOn(LocalFSClient.prototype, "heldBoundaryStretchCount", "get")
    .mockReturnValue(1);
  mockFd3Open();
  try {
    // Party A runs flag-on; party B flag-off, so every captured fd-3 line is A's.
    await Promise.all([
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-a",
        undefined,
        undefined,
        undefined,
        { eventStream: true },
      ),
      runProtocol(
        { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
        null,
        minimalPrepared,
        undefined,
        -1,
        "test-b",
      ),
    ]);
  } finally {
    heldSpy.mockRestore();
    stretchSpy.mockRestore();
    vi.mocked(fs.fstatSync).mockRestore();
  }

  expect(
    mockState.infos.some((line) => line.includes("held the SFTP session")),
  ).toBe(true);
  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );

  const lines = takeFd3Lines();
  const metrics = lines.find((l) => l.type === "metrics")!;
  expect(Object.keys(metrics).sort()).toEqual([
    "reconnects",
    "recordsProcessed",
    "transportRetries",
    "type",
    "v",
  ]);
  expect(metrics.reconnects).toBe(0);
  expect(metrics.transportRetries).toBe(0);
  expect(JSON.stringify(metrics)).not.toContain("11");
}, 20_000);

test("logs no reconnect or per-cycle boundary summary of any kind on a clean run", async () => {
  // The teardown summary is guarded on a non-zero count, so a normal exchange
  // stays quiet.
  await Promise.all([
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  expect(mockState.infos.some((line) => line.includes("re-established"))).toBe(
    false,
  );
  expect(mockState.infos.some((line) => line.includes("idle boundar"))).toBe(
    false,
  );
  expect(
    mockState.infos.some((line) => line.includes("did not close the session")),
  ).toBe(false);
  expect(
    mockState.infos.some((line) => line.includes("held the SFTP session")),
  ).toBe(false);
  expect(
    mockState.infos.some((line) => line.includes("closed the SFTP session")),
  ).toBe(false);
  expect(mockState.infos.some((line) => line.includes("poll cycle"))).toBe(
    false,
  );
}, 20_000);

test(
  "an aborted run under --event-stream reports metrics then the classified reason",
  { timeout: BOTH_ARMED_HANG_BACKSTOP_MS + 5_000 },
  async () => {
    // A mid-run fault after a stage started: the completed stage's timing is
    // already on the stream, and the terminal sequence is the metrics summary
    // followed by the classified error -- the machine-readable abort reason,
    // distinct from the free-text stderr log. No stageEnd fires for the in-flight
    // stage (only completed stages are timed).
    const preparedWithRows = { rowCount: 4 } as unknown as PreparedExchange;
    vi.mocked(runExchange).mockImplementation((async (...args: unknown[]) => {
      // Hold both parties here before either fault fires: the lock winner reaches
      // runExchange the moment it creates the lock, while the loser is still
      // between its EEXIST and the exists(lock) check that tells a live winner
      // from a departed one. Without the barrier the winner's teardown deletes
      // the lock inside that gap, and the loser -- which may be party A, the one
      // asserted below -- fails with "peer appears to have abandoned the
      // handshake" instead of the fault this test injects.
      await awaitBothArmed();
      const options = args[3] as { onStage?: (id: string) => void };
      options.onStage?.("stage 1 / 1");
      throw new Error("simulated mid-run transport fault");
    }) as never);

    // Two parties complete the real rendezvous before either reaches the mocked
    // runExchange, where both then throw. Only party A is flag-on; its outcome is
    // the one asserted (party B's is not).
    mockFd3Open();
    let resA: PromiseSettledResult<unknown>;
    try {
      [resA] = await Promise.allSettled([
        runProtocol(
          { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
          null,
          preparedWithRows,
          undefined,
          -1,
          "test-a",
          undefined,
          undefined,
          undefined,
          { eventStream: true },
        ),
        runProtocol(
          { channel: "filedrop", path: dropDir, options: TWO_PARTY_OPTIONS },
          null,
          preparedWithRows,
          undefined,
          -1,
          "test-b",
        ),
      ]);
    } finally {
      vi.mocked(fs.fstatSync).mockRestore();
    }
    // Both parties reached the mocked runExchange, so the barrier above held
    // rather than expiring: a run where one party never arrives still reports the
    // injected fault on the other, which would read green without this.
    expect(mockState.runExchangeEntries).toBe(2);
    expect(resA.status).toBe("rejected");
    expect(String((resA as PromiseRejectedResult).reason)).toContain(
      "simulated mid-run transport fault",
    );

    const lines = takeFd3Lines();
    // stages, stage(1) -- no stageEnd for the aborted in-flight stage -- metrics,
    // then the classified terminal error.
    expect(lines.map((l) => l.type)).toEqual([
      "stages",
      "stage",
      "metrics",
      "error",
    ]);
    const metrics = lines.find((l) => l.type === "metrics")!;
    expect(metrics.recordsProcessed).toBe(4);
    const errorLine = lines.find((l) => l.type === "error")!;
    expect(errorLine.category).toBe("exchange");
    expect(String(errorLine.message)).toContain("simulated mid-run transport");
  },
);
