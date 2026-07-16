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
// the message poller.
async function defaultRunExchange(): Promise<unknown> {
  const { readdir } = await import("node:fs/promises");
  const deadline = Date.now() + 5_000;
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
// still-pending receive. Bounded so a lone arrival cannot hang.
async function waitForBothKeysRotated(
  keyFileA: string,
  keyFileB: string,
): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const deadline = Date.now() + 5_000;
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
// file that raced ahead of B's synchronize and was already deleted.
async function backdateDropDirRendezvousFile(dropDir: string): Promise<void> {
  const deadline = Date.now() + 5_000;
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
  parseExchangeRecord,
  parseVerificationKeys,
  runExchange,
  PeerAbortError,
  ConnectionError,
  FrameSizeExceededError,
  FileSyncConnection,
  fromEventConnection,
  authenticateConnection,
  generateSigningIdentity,
  ReceiptVerificationError,
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  AEAD_ENVELOPE_VERSION,
} from "@psilink/core";
import type { ExchangeRecord, VerificationKeys } from "@psilink/core";
import {
  runProtocol,
  PEER_SILENCE_GUIDANCE,
  type RunProtocolResult,
  type SigningPersist,
} from "../../src/protocol";
import { runOrExit } from "../../src/util/cli";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import { LocalFSClient } from "../../src/connection/localFSClient";

// 32 zero bytes in base64url (43 chars, no padding).
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// 32 0x01 bytes in base64url: a second valid token for the mismatched-secret case.
const TOKEN_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

// A fixed, deterministic signing identity for the runProtocol-level warn-gate
// tests below. Its content is never verified in these tests (runExchange is
// mocked), so any valid identity will do.
const signingIdentityFixture = generateSigningIdentity("test-party", {
  seed: new Uint8Array(32).fill(9),
});

// Values unused because runExchange and buildOutputTable are mocked.
const minimalPrepared = {} as unknown as PreparedExchange;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-proto-integ-"));
  dropDir = path.join(tmpDir, "drop");
  mockState.dropDir = dropDir;
  mockState.infos.length = 0;
  mockState.warnings.length = 0;
  mockState.errors.length = 0;
  mockState.runExchangeEntries = 0;
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
  mockState.dropDir = "";
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Peer-silence guidance ---------------------------------------------------

// The sender-side residue of board item 195173462: the receiver names its own
// cause locally, but the remote sender only sees the inactivity timeout, so it
// surfaces guidance about likely receiver-side causes. runProtocol threads this
// text to fromEventConnection's inactivityHint, which the core layer appends to
// the peer-silence error (the append mechanism is pinned in
// packages/core/test/messageConnection.test.ts). This pins the wording itself:
// the deliverable per the acceptance criteria.
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

test("rejects before opening a connection when keyFilePath parent is not writable", async () => {
  // 0o555 = r-x for all; the current user cannot write into the directory, so
  // saveKeyFile would fail after the key exchange. The pre-flight should catch this. Skip
  // if running as root (CI sometimes does), since root bypasses mode bits.
  if (process.getuid?.() === 0) return;
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
});

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
});

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
});

test("rejects before opening a connection when keyFilePath parent is a dangling symlink", async () => {
  // statSync follows symlinks, so a dangling-symlink parent surfaces as
  // ENOENT. The lstat probe distinguishes "dangling symlink" from "missing
  // path" and the message must include the dangling-symlink hint.
  if (process.platform === "win32") return; // symlink semantics differ on Win
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
});

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
});

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
      },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);
  // No assertion on key files: no rotation occurs when auth is null.
});

// --- Self-attested record persistence via runProtocol ------------------------

test("writes the self-attested record and verification keys when runExchange returns an audit", async () => {
  // Covers the record-write wiring in runProtocol (the runExchange audit ->
  // writeExchangeRecord call), which the default mock leaves unexercised by
  // returning no audit. Each party's runExchange returns a built audit and is
  // given its own record output paths; both the record and its keys must land
  // on disk and round-trip the schema parsers.
  const sampleRecord: ExchangeRecord = {
    version: "psilink-exchange-record/v1",
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

  // Drain the drop directory exactly as the default mock does (so neither
  // party's cleanup races the other's poller), then return the audit alongside
  // the usual fields.
  async function runExchangeWithAudit(): Promise<unknown> {
    const base = (await defaultRunExchange()) as Record<string, unknown>;
    return { ...base, audit };
  }
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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
      null,
      minimalPrepared,
      outputA,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
});

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

test("runProtocol rejects an already-expired token before opening any connection (no rendezvous I/O)", async () => {
  // The regression guard for hoisting the pre-handshake expiry check ahead of
  // connect(). A LONE party with an expired token must reject at once with the
  // "expired" hint, WITHOUT entering the file-drop rendezvous: it writes no
  // hello/lock files and never waits for a peer. Were the check moved back inside
  // authenticateConnection (which runs only after the connection is open), this
  // lone party would instead write its hello and block at the rendezvous until
  // peerTimeoutMs, then reject with a timeout rather than "expired" -- failing the
  // message and empty-directory assertions below. The short peerTimeoutMs keeps
  // that regression mode fast rather than letting it hang the suite. This is also
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
        options: { pollIntervalMs: 1, peerTimeoutMs: 200 },
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
  // A lone inviter waits at the rendezvous and the accept-timeout (modeled by a
  // short peerTimeoutMs) elapses with no peer. The run rejects with a timeout and
  // must persist nothing: the key file is never created.
  const keyFile = path.join(tmpDir, "a.key");
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1, peerTimeoutMs: 200 },
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

// --- Token rotation via runProtocol ------------------------------------------

test("both key files hold the same rotated token after a successful exchange", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });
  saveKeyFile(keyFileB, { sharedSecret: TOKEN_A });

  const outputA = path.join(tmpDir, "out-a.csv");
  const outputB = path.join(tmpDir, "out-b.csv");

  // pollIntervalMs: 1 keeps key-exchange latency low so each party's poller
  // consumes the peer's last message well before the mock's 5 s deadline.
  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
      { sharedSecret: TOKEN_A, keyFilePath: keyFileA, tokenMaxAgeDays: 30 },
      minimalPrepared,
      outputA,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
});

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

// Holds the calling party inside the mocked runExchange until BOTH parties have
// arrived (both are armed and past the handshake), bounded so a lone arrival does
// not hang. See mockState.runExchangeEntries.
async function awaitBothArmed(): Promise<void> {
  mockState.runExchangeEntries++;
  const deadline = Date.now() + 2_000;
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
      options: { pollIntervalMs: 1, peerTimeoutMs: 200 },
    },
    { sharedSecret: TOKEN_A, keyFilePath },
    minimalPrepared,
    undefined,
    -1,
    name,
  ) as unknown as Promise<unknown>;
}

test("runProtocol suppresses its own abort marker on a PeerAbortError but writes one for a generic transport fault", async () => {
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
});

test("runProtocol writes an abort marker on each side when both fail with a generic transport fault", async () => {
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
});

// --- Signed-receipt non-signing-partner warn gate via runProtocol ------------
//
// Pins the catch-block gate that decides whether to warn the operator that a
// signed receipt was configured but the exchange did not complete the receipt
// swap -- `signing !== null && !exchangeComplete && !isReceiptVerificationFailure`
// in runProtocol's catch. Runs a REAL two-party handshake (only runExchange is
// mocked) with a signing config threaded through, using the same
// awaitBothArmed/runAbortParty barrier pattern as the abort-marker section
// above so both parties reach the same point deterministically.

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
): Promise<unknown> {
  return runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1, peerTimeoutMs: 200 },
    },
    { sharedSecret: TOKEN_A, keyFilePath },
    minimalPrepared,
    undefined,
    -1,
    name,
    undefined,
    undefined,
    undefined,
    {},
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
});

test("a ReceiptVerificationError does not warn about a non-signing partner", async () => {
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
});

test("a ReceiptVerificationError wrapped via cause still suppresses the warn", async () => {
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
});

test("a non-receipt failure with signing configured warns about a non-signing partner", async () => {
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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
}, 15_000);

test("runProtocol suppresses the generic advisory for a terminal FrameSizeExceededError", async () => {
  // A terminal transport/directory UsageError thrown during the data exchange
  // reaches the catch with tokenRotated=true, where the generic "retry without
  // re-inviting" advisory would otherwise fire and contradict the error's own
  // terminal refusal. FrameSizeExceededError now carries a class-level
  // psilinkRecoveryHintEmitted tag (board item 199419757), so the hint-walker
  // must suppress the generic advisory -- this pins that the new class tag is
  // honored end to end, not just the Object.assign tags the other tests cover.
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
    { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
    { sharedSecret: TOKEN_A, keyFilePath: keyFileA },
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
}, 15_000);

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

test.skipIf(process.platform === "win32")(
  "runProtocol suppresses the generic authStarted advisory when the thrown error already carries the specific saveKeyFile recovery hint",
  async () => {
    // When saveKeyFile fails, runProtocol throws a wrapped error whose message
    // already says "authentication succeeded and the shared token was rotated,
    // but the updated token could not be saved...". The generic authStarted
    // advisory ("the partner may have already derived...while this side did
    // not") contradicts this — it understates a definite local rotation.
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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

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
    { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-a",
  );
  const pB = runProtocol(
    { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
});

test("SIGINT handler exits with code 130", async () => {
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  // Two parties are required: a single party blocks forever in synchronize()
  // (waiting for a peer's hello/lock file), so runExchange is never reached
  // and the mockImplementationOnce entry is never consumed.
  // mockImplementationOnce is provided for both parties so both entries are
  // consumed after synchronize() completes.
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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
    },
    null,
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    // Wait for both parties to enter runExchange before emitting the signal.
    // Emitting SIGINT while a party is still in synchronize() could cause its
    // cleanup to delete lock files the other party is still waiting for.
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
  } finally {
    exitSpy.mockRestore();
    rejectA?.(new Error("test cleanup"));
    rejectB?.(new Error("test cleanup"));
    await Promise.allSettled([pA, pB]);
  }
});

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

test("SIGINT mid-synchronize exits with 130 and cleans up the hello file (started=false branch)", async () => {
  // Distinct from the SIGINT-mid-runExchange test: a single party is started
  // so no peer arrives, leaving synchronize() in waitForPeer indefinitely.
  // The party reaches `opened=true` but never `started=true`, so doCleanup
  // takes the started=false branch and conn.stop() is skipped. The hello
  // file written by synchronize() must be cleaned up by conn.cleanup()
  // before process.exit(130) is called.
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

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
      { timeout: 5_000 },
    );
    expect(vi.mocked(runExchange).mock.calls.length).toBe(0);

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    // After cleanup runs the hello file must be gone — otherwise a retry
    // would trip the "preexisting hello or lock files" guard.
    expect(
      fs.readdirSync(dropDir).filter((f) => f.endsWith("-hello.json")),
    ).toHaveLength(0);
  } finally {
    exitSpy.mockRestore();
    await Promise.allSettled([pA]);
  }
});

test("SIGTERM handler exits with code 143", async () => {
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  // Two parties required for the same reason as the SIGINT test above.
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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
  } finally {
    exitSpy.mockRestore();
    rejectA?.(new Error("test cleanup"));
    rejectB?.(new Error("test cleanup"));
    await Promise.allSettled([pA, pB]);
  }
});

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

// --- Key-file write failure via runProtocol ----------------------------------

test.skipIf(process.platform === "win32")(
  "key file write failure surfaces a recovery message without hiding the cause",
  async () => {
    // To force a saveKeyFile failure AFTER the key exchange rotates, point B's key file
    // at a non-existent regular file path (so pre-flight accepts it) and
    // pre-create a directory at saveKeyFile's tmp-file path
    // (`${keyFilePath}.tmp.${pid}`). The unlinkSync inside saveKeyFile then
    // throws EISDIR/EPERM (depending on platform) instead of ENOENT, aborting
    // the save and exercising the recovery-message path.
    //
    // Gated on POSIX for the same reason as the sibling test above: Windows
    // `unlinkSync` on a directory does not produce a uniform errno across
    // filesystem drivers.
    const bogusKeyFile = path.join(tmpDir, "b.key");
    fs.mkdirSync(`${bogusKeyFile}.tmp.${process.pid}`);

    const keyFileA = path.join(tmpDir, "a.key");
    saveKeyFile(keyFileA, { sharedSecret: TOKEN_A });

    const dropConfig = {
      channel: "filedrop" as const,
      path: dropDir,
      options: { pollIntervalMs: 1 },
    };

    // Start B first so it becomes the responder. As the responder, B's only
    // outgoing key-exchange message (msg2) is consumed by A before B returns from
    // authenticateConnection; by the time B fails at saveKeyFile and doCleanup
    // runs, all of B's responsible files are already gone — no cleanup race.
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

    // Poll for B's rendezvous file rather than sleeping a fixed amount, then
    // backdate it so B is deterministically the responder before A starts.
    await backdateDropDirRendezvousFile(dropDir);

    // A uses runProtocol so its cleanup runs through the full exchange path.
    // send() in the exchange phase waits for A's last key-exchange message (msg3) to
    // be consumed before writing, which guarantees B has consumed msg3 before
    // A's cleanup could touch it.
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

    // B must fail with the recovery message.
    expect(resultB.status).toBe("rejected");
    const msg = ((resultB as PromiseRejectedResult).reason as Error).message;
    expect(msg).toContain(
      "authentication succeeded and the shared token was rotated",
    );
    expect(msg).toContain("Your partner may already hold the rotated token");
  },
);

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

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
          options: { pollIntervalMs: 1 },
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
          options: { pollIntervalMs: 1 },
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
    //    key-exchange) -- checked over the raw bytes, since frames are now binary.
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
}, 15_000);

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
}, 15_000);

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
}, 15_000);

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
      options: { pollIntervalMs: 1 },
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
      options: { pollIntervalMs: 1 },
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
});

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

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
        options: { pollIntervalMs: 1 },
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
        options: { pollIntervalMs: 1 },
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
});

// --- Machine-interface event stream (--event-stream) --------------------------
//
// The flag-on tests below mock fstatSync for fd 3 (so the fail-closed preflight
// passes deterministically regardless of how the test process was spawned) and
// read the events from the fd-3 capture installed in beforeEach. Each drains the
// capture with takeFd3Lines() and accounts for every line, so the afterEach
// empty-capture assertion doubles as an exactly-one-terminal-event check.

/** Make fstatSync succeed for fd 3 (pass every other target through). */
function mockFd3Open(): void {
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) return {} as fs.Stats;
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
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

  // The event was flushed before the rejection propagated (emit precedes the
  // rethrow), so it is already in the capture here. Exactly one line: the
  // classified terminal error, carrying the schema version.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(1);
  expect(lines[0].type).toBe("error");
  expect(lines[0].category).toBe("exchange");
  expect(lines[0].v).toBe(1);
  expect(String(lines[0].message)).toContain("expired");
});

test("a main-try failure under --event-stream emits exactly one terminal error event (no double emission)", async () => {
  // conn.open() on a nonexistent drop path rejects inside the main try, whose
  // catch is the other emission site. Exactly one captured line proves the
  // prepare block's catch did not also fire for the same failure.
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
  expect(lines).toHaveLength(1);
  expect(lines[0].type).toBe("error");
  expect(lines[0].category).toBe("exchange");
  expect(lines[0].v).toBe(1);
});

// --- Stage/warning stderr sanitization -----------------------------------------

test("a hostile stage label and terms warning reach the human log neutralized", async () => {
  // The onStage/onWarning strings can derive from partner-authored linkage-key
  // and column names. Drive both callbacks with the repo's hostile patterns (a
  // bidi override and an ANSI ESC sequence) through a real two-party run and
  // assert the captured stderr lines carry only the visible escapes.
  const hostileStageId = "user‮EVIL stage";
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
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-a",
    ),
    runProtocol(
      { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
      null,
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);

  const stageLine = mockState.infos.find((m) => m.includes("EVIL stage"));
  expect(stageLine).toBeDefined();
  expect(stageLine).not.toContain("‮");
  expect(stageLine).toContain("\\u202e");

  const warnLine = mockState.warnings.find((m) =>
    m.includes("terms exchange:"),
  );
  expect(warnLine).toBeDefined();
  expect(warnLine).not.toContain("\x1b");
  expect(warnLine).toContain("\\x1b");
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
        { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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

  // The real handshake failure: the generic non-oracular message, now carried
  // by a security-kind ConnectionError.
  expect(resA.status).toBe("rejected");
  const reasonA = (resA as PromiseRejectedResult).reason as unknown;
  expect(reasonA).toBeInstanceOf(ConnectionError);
  expect((reasonA as ConnectionError).kind).toBe("security");
  expect((reasonA as ConnectionError).message).toBe(
    "key exchange authentication failed",
  );

  // Exactly one terminal event, classified security.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(1);
  expect(lines[0].type).toBe("error");
  expect(lines[0].category).toBe("security");
  expect(lines[0].v).toBe(1);

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
}, 15_000);

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
  expect(lines).toHaveLength(1);
  expect(lines[0].type).toBe("error");
  expect(lines[0].category).toBe("security");
  expect(lines[0].v).toBe(1);

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
        { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
        { channel: "filedrop", path: dropDir, options: { pollIntervalMs: 1 } },
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
  // warning, and the success terminal event.
  const lines = takeFd3Lines();
  expect(lines).toHaveLength(3);
  expect(lines[0].type).toBe("stages");
  expect(lines[1].type).toBe("warning");
  expect(lines[1].v).toBe(1);
  expect(lines[1].message).toBe(divergence);
  expect(lines[2].type).toBe("result");

  // The stderr warn line is preserved verbatim: un-prefixed, unlike the
  // "terms exchange:" lines onWarning produces.
  expect(mockState.warnings).toContain(divergence);
});
