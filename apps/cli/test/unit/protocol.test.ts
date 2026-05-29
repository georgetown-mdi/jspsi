import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";
import type { PreparedExchange } from "@psilink/core";

// Shared state readable inside the vi.mock factory despite ESM hoisting.
const mockState = vi.hoisted(() => ({
  dropDir: "",
  // Captured log output from the mock getLogger returned to runProtocol.
  warnings: [] as string[],
  errors: [] as string[],
}));

// Keep FileSyncConnection and authenticateConnection real so PAKE runs over a
// real file-drop connection. Mock only the PSI exchange layer, which would
// otherwise require the full WASM stack and a prepared dataset.
vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Default runExchange mock implementation. Polls the drop directory until it
// is empty before resolving: the receiver's poller deletes each message file
// after consuming it, so an empty directory is a deterministic signal that the
// peer has consumed the final PAKE message - no fixed sleep required. .hello
// and .wave files from synchronize() are ignored; after the wave race the
// winner's wave file remains until cleanup() runs in the finally block (after
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

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    // Keep the real EncryptedConnection so that protocol.ts can call
    // EncryptedConnection.create after PAKE, and so vi.spyOn tests can
    // replace create() on the real class object. Without this explicit
    // entry Vitest's module proxy stubs the class's static methods and
    // throws when create() is called.
    EncryptedConnection: actual.EncryptedConnection,
    // Replace getLogger so that runProtocol's log.warn / log.error calls are
    // captured in mockState and can be asserted by individual tests. The
    // logger is only used for informational output; replacing it does not
    // affect PAKE or PSI correctness.
    getLogger: (_name: string) => ({
      info: () => {},
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

import { runExchange, EncryptedConnection } from "@psilink/core";
import { runProtocol } from "../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";

// 32 zero bytes in base64url (43 chars, no padding).
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Values unused because runExchange and buildOutputTable are mocked.
const minimalPrepared = {} as unknown as PreparedExchange;

let tmpDir: string;
let dropDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-proto-integ-"));
  dropDir = path.join(tmpDir, "drop");
  mockState.dropDir = dropDir;
  mockState.warnings.length = 0;
  mockState.errors.length = 0;
  fs.mkdirSync(dropDir);
});

afterEach(async () => {
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

// --- Pre-flight validation ---------------------------------------------------

test("rejects before opening a connection when keyFilePath is whitespace-only", async () => {
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        authentication: { pakeToken: TOKEN_A, keyFilePath: "   " },
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow("non-empty keyFilePath");
});

test("rejects before opening a connection when keyFilePath parent is not writable", async () => {
  // 0o555 = r-x for all; the current user cannot write into the directory, so
  // saveKeyFile would fail after PAKE. The pre-flight should catch this. Skip
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
          authentication: {
            pakeToken: TOKEN_A,
            keyFilePath: path.join(readOnlyDir, "key.json"),
          },
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
        authentication: {
          pakeToken: TOKEN_A,
          keyFilePath: path.join(fileParent, "key.json"),
        },
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
  // authentication: null skips runProtocol's PAKE branch, but the keyFilePath
  // probe runs only when authentication is set. To exercise the probe and
  // still abort before the full exchange, point dropDir at a path that
  // localFSClient cannot open so runProtocol throws after the probe runs.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: "/nonexistent-path-that-cannot-exist-psilink-test",
        authentication: {
          pakeToken: TOKEN_A,
          keyFilePath: path.join(createdParent, "key.json"),
        },
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
        authentication: {
          pakeToken: TOKEN_A,
          keyFilePath: keyDirAsFile,
        },
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
    pakeToken: TOKEN_A,
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
        authentication: auth,
      },
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
        authentication: {
          pakeToken: TOKEN_A,
          keyFilePath: path.join(link, "key.json"),
        },
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
  // the doCleanup branch where close() throws "not connected" and is swallowed
  // at debug level.
  await expect(
    runProtocol(
      {
        channel: "filedrop",
        path: "/nonexistent-path-that-cannot-exist-psilink-test",
        authentication: null,
      },
      minimalPrepared,
      undefined,
      -1,
      "test",
    ),
  ).rejects.toThrow();
});

// --- Unauthenticated exchange paths ------------------------------------------

test("authentication=null runs the exchange without PAKE and without error", async () => {
  // Zero-setup path: authentication: null tells runProtocol to skip PAKE and
  // emit no warning. Output is left undefined so writeOutput writes to stdout
  // rather than a temp file whose parent may be deleted before the stream
  // flushes.
  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
        authentication: null,
      },
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
        authentication: null,
      },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    ),
  ]);
  // No assertion on key files: no rotation occurs when auth is null.
});

// --- Expired token via runProtocol -------------------------------------------

test("runProtocol rejects an expired token without rotating, and the tagged recovery hint suppresses the generic catch advisory", async () => {
  // Pre-handshake expiry check in authenticateConnection fires before any
  // SPAKE2 message is exchanged. Both parties supply the same expired token
  // so each side trips the same check independently. The resulting error
  // carries `psilinkRecoveryHintEmitted: true` (set in auth.ts), so the
  // runProtocol catch must NOT log either of its generic advisory lines -
  // those would contradict the specific "obtain a new invitation" message.
  // Also verifies that no token rotation occurred: the original key file
  // contents must be unchanged after the failure.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, {
    pakeToken: TOKEN_A,
    expires: "2000-01-01T00:00:00.000Z",
  });
  saveKeyFile(keyFileB, {
    pakeToken: TOKEN_A,
    expires: "2000-01-01T00:00:00.000Z",
  });

  const pA = runProtocol(
    {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
      authentication: {
        pakeToken: TOKEN_A,
        expires: "2000-01-01T00:00:00.000Z",
        keyFilePath: keyFileA,
      },
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
      authentication: {
        pakeToken: TOKEN_A,
        expires: "2000-01-01T00:00:00.000Z",
        keyFilePath: keyFileB,
      },
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
  expect(
    mockState.errors.every(
      (m) => !m.includes("PAKE handshake was in progress"),
    ),
  ).toBe(true);
  expect(
    mockState.errors.every((m) => !m.includes("already rotated and saved")),
  ).toBe(true);

  // Token must remain unchanged on both sides.
  expect(loadKeyFile(keyFileA)?.pakeToken).toBe(TOKEN_A);
  expect(loadKeyFile(keyFileB)?.pakeToken).toBe(TOKEN_A);
});

// --- Token rotation via runProtocol ------------------------------------------

test("both key files hold the same rotated token after a successful exchange", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

  const outputA = path.join(tmpDir, "out-a.csv");
  const outputB = path.join(tmpDir, "out-b.csv");

  // pollIntervalMs: 1 keeps PAKE latency low so each party's poller
  // consumes the peer's last message well before the mock's 5 s deadline.
  await Promise.all([
    runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
      },
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
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
      },
      minimalPrepared,
      outputB,
      -1,
      "test-b",
    ),
  ]);

  // Both runExchange calls must have received the EncryptedConnection wrapper,
  // not the raw FileSyncConnection. A regression here would silently bypass
  // AES-256-GCM and send plaintext over the filedrop transport.
  expect(vi.mocked(runExchange).mock.calls).toHaveLength(2);
  for (const [conn] of vi.mocked(runExchange).mock.calls) {
    expect(conn).toBeInstanceOf(EncryptedConnection);
  }

  const loadedA = loadKeyFile(keyFileA);
  const loadedB = loadKeyFile(keyFileB);

  // Both parties derive the same new token from the shared SPAKE2 session key.
  expect(loadedA?.pakeToken).toBeDefined();
  expect(loadedA?.pakeToken).toBe(loadedB?.pakeToken);
  // The token must differ from the original (it was rotated).
  expect(loadedA?.pakeToken).not.toBe(TOKEN_A);
  // Rotation tokens carry no expiry.
  expect(loadedA?.expires).toBeUndefined();
  expect(loadedB?.expires).toBeUndefined();
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
// transport error after PAKE has rotated the token, exercising the catch block
// in runProtocol that logs the recovery hint.

test("runProtocol suppresses the generic advisory when a tagged error is wrapped via `cause`", async () => {
  // The `psilinkRecoveryHintEmitted` tag is sometimes attached to an inner
  // error that a later catch wraps with `new Error(..., { cause: innerErr })`.
  // The runProtocol catch walks the cause chain so the wrap does not lose the
  // suppression. This test simulates that wrap by having runExchange throw a
  // wrapped error whose `cause` carries the tag.
  //
  // Both parties must wait for both key files to reach the rotated state
  // before throwing. Without that synchronization the first party to throw
  // would close its connection while the second is still completing PAKE,
  // causing a PAKE failure that would log the generic authStarted advisory
  // (the very thing this test asserts is suppressed). See the
  // "logs recovery message when an error occurs after tokenRotated=true"
  // test below for the same pattern.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

  async function waitForRotationThenThrowWrapped(): Promise<never> {
    const { readFileSync } = await import("node:fs");
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const a = JSON.parse(readFileSync(keyFileA, "utf8")).pakeToken;
        const b = JSON.parse(readFileSync(keyFileB, "utf8")).pakeToken;
        if (a !== TOKEN_A && b !== TOKEN_A) break;
      } catch {
        // file may not exist yet; retry
      }
      if (Date.now() > deadline)
        throw new Error("timed out waiting for both key files to rotate");
      await new Promise((r) => setTimeout(r, 1));
    }
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
    },
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
  expect(
    mockState.errors.every(
      (m) => !m.includes("PAKE handshake was in progress"),
    ),
  ).toBe(true);
  expect(
    mockState.errors.every((m) => !m.includes("already rotated and saved")),
  ).toBe(true);
}, 15_000);

test("runProtocol logs recovery message when an error occurs after tokenRotated=true", async () => {
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

  // Both runExchange calls wait until both key files reflect the rotated
  // token, then throw. Waiting for both rotations guarantees that PAKE has
  // completed on both sides (and the last PAKE message file has been consumed
  // off disk) before either party's doCleanup runs, so neither cleanup can
  // race with the other party's still-pending pake.receive(). Throwing from
  // both sides keeps the test deterministic: every protocol call exercises
  // the recovery-log catch branch in runProtocol.
  async function waitForRotationThenThrow(): Promise<never> {
    const { readFileSync } = await import("node:fs");
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const a = JSON.parse(readFileSync(keyFileA, "utf8")).pakeToken;
        const b = JSON.parse(readFileSync(keyFileB, "utf8")).pakeToken;
        if (a !== TOKEN_A && b !== TOKEN_A) break;
      } catch {
        // file may not exist yet; retry
      }
      if (Date.now() > deadline)
        throw new Error("timed out waiting for both key files to rotate");
      await new Promise((r) => setTimeout(r, 1));
    }
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
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
    "simulated transport error",
  );
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "simulated transport error",
  );

  expect(
    mockState.errors.some((m) =>
      m.includes("PAKE token was already rotated and saved"),
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
    // To force saveKeyFile to fail AFTER PAKE rotates (and not at the
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
    saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
    const bogusKeyFile = path.join(tmpDir, "b.key");
    fs.mkdirSync(`${bogusKeyFile}.tmp.${process.pid}`);

    const dropConfig = {
      channel: "filedrop" as const,
      path: dropDir,
      options: { pollIntervalMs: 1 },
    };

    // B starts first (becomes responder) so that B's saveKeyFile failure
    // happens after PAKE completes but before B's runExchange is reached.
    const bPromise = runProtocol(
      {
        ...dropConfig,
        authentication: { pakeToken: TOKEN_A, keyFilePath: bogusKeyFile },
      },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    );

    // Wait for B to register its hello file so role assignment is deterministic.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const entries = fs.readdirSync(dropDir);
      if (entries.length > 0) {
        const past = new Date(Date.now() - 3_000);
        for (const f of entries) {
          try {
            fs.utimesSync(path.join(dropDir, f), past, past);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        break;
      }
      if (Date.now() > deadline)
        throw new Error("timed out waiting for B's hello");
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    const aPromise = runProtocol(
      {
        ...dropConfig,
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
      },
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
    expect(
      mockState.errors.every(
        (m) => !m.includes("PAKE handshake was in progress"),
      ),
    ).toBe(true);
    expect(
      mockState.errors.every((m) => !m.includes("already rotated and saved")),
    ).toBe(true);
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
      authentication: null,
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
      authentication: null,
    },
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

test("SIGINT handler exits with code 130", async () => {
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

  // Two parties are required: a single party blocks forever in synchronize()
  // (waiting for a peer's hello/wave file), so runExchange is never reached
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
      authentication: null,
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
      authentication: null,
    },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    // Wait for both parties to enter runExchange before emitting the signal.
    // Emitting SIGINT while a party is still in synchronize() could cause its
    // cleanup to delete wave files the other party is still waiting for.
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
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
    },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () => {
        expect(loadKeyFile(keyFileA)?.pakeToken).not.toBe(TOKEN_A);
        expect(loadKeyFile(keyFileB)?.pakeToken).not.toBe(TOKEN_A);
      },
      { timeout: 10_000 },
    );

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    expect(
      mockState.warnings.some((m) =>
        m.includes("PAKE token was already rotated and saved"),
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
      authentication: null,
    },
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
          .filter((f) => f.endsWith(".hello"));
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
    // would trip the "preexisting hello or wave files" guard.
    expect(
      fs.readdirSync(dropDir).filter((f) => f.endsWith(".hello")),
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
      authentication: null,
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
      authentication: null,
    },
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
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
      authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
    },
    minimalPrepared,
    undefined,
    -1,
    "test-b",
  );

  try {
    await vi.waitFor(
      () => {
        expect(loadKeyFile(keyFileA)?.pakeToken).not.toBe(TOKEN_A);
        expect(loadKeyFile(keyFileB)?.pakeToken).not.toBe(TOKEN_A);
      },
      { timeout: 10_000 },
    );

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143), {
      timeout: 5_000,
    });

    expect(
      mockState.warnings.some((m) =>
        m.includes("PAKE token was already rotated and saved"),
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
    // To force a saveKeyFile failure AFTER PAKE rotates, point B's key file
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
    saveKeyFile(keyFileA, { pakeToken: TOKEN_A });

    const dropConfig = {
      channel: "filedrop" as const,
      path: dropDir,
      options: { pollIntervalMs: 1 },
    };

    // Start B first so it becomes the responder. As the responder, B's only
    // outgoing PAKE message (msg2) is consumed by A before B returns from
    // authenticateConnection; by the time B fails at saveKeyFile and doCleanup
    // runs, all of B's responsible files are already gone — no cleanup race.
    const bPromise = runProtocol(
      {
        ...dropConfig,
        authentication: { pakeToken: TOKEN_A, keyFilePath: bogusKeyFile },
      },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    );

    // Poll for B's rendezvous file rather than sleeping a fixed amount. B
    // writes its .hello file to dropDir during open()/synchronize(); its
    // presence is the deterministic signal that B has reached synchronize() and
    // is waiting for a peer. A only starts after this loop exits, guaranteeing
    // B is already in the drop directory before A's open() runs.
    //
    // After detecting B's hello file, backdate its mtime by 3 seconds. This
    // ensures B's mtime is strictly older than A's (written after this loop),
    // making B the responder even on coarse-mtime filesystems (FAT with 2-
    // second granularity, some NFS configs with 1-second granularity) where
    // both writes would otherwise land in the same timestamp bucket and fall
    // back to UUID comparison for role assignment — which could assign roles
    // unexpectedly.
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
            // ENOENT: file raced ahead of B's synchronize and was deleted;
            // harmless. Any other error (e.g. EPERM) indicates a real
            // filesystem problem.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        break;
      }
      if (Date.now() > deadline)
        throw new Error("timed out waiting for B to write its rendezvous file");
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    // A uses runProtocol so its cleanup runs through the full exchange path.
    // send() in the exchange phase waits for A's last PAKE message (msg3) to
    // be consumed before writing, which guarantees B has consumed msg3 before
    // A's cleanup could touch it.
    const aPromise = runProtocol(
      {
        ...dropConfig,
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
      },
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
      authentication: null,
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
      authentication: null,
    },
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
      authentication: null,
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
      authentication: null,
    },
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

// --- EncryptedConnection.create failure paths --------------------------------

test("runProtocol throws a tagged recovery message when EncryptedConnection.create fails after tokenRotated=true", async () => {
  // Path A: saveKeyFile succeeds (tokenRotated=true) but create() rejects with
  // a synthetic error. The catch block wraps the error with the recovery message
  // and tags it psilinkRecoveryHintEmitted=true to suppress the generic
  // "already rotated and saved" advisory that would otherwise also fire.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

  // Wait for both key files to reflect the rotated token before rejecting: same
  // synchronization pattern used by waitForRotationThenThrow. This ensures PAKE
  // has completed on both sides before either party's create() throws; without
  // it, the first party to throw would close its connection while the second is
  // still exchanging PAKE messages, causing a PAKE failure with different
  // diagnostics.
  async function waitForBothRotationsThenReject(): Promise<never> {
    const { readFileSync } = await import("node:fs");
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const a = JSON.parse(readFileSync(keyFileA, "utf8")).pakeToken;
        const b = JSON.parse(readFileSync(keyFileB, "utf8")).pakeToken;
        if (a !== TOKEN_A && b !== TOKEN_A) break;
      } catch {
        // key file may not exist yet; retry
      }
      if (Date.now() > deadline)
        throw new Error("timed out waiting for both key files to rotate");
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("simulated create() failure");
  }

  const createSpy = vi
    .spyOn(EncryptedConnection, "create")
    .mockImplementation(waitForBothRotationsThenReject as never);

  try {
    const pA = runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
      },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    );

    const [resultA, resultB] = await Promise.allSettled([pA, pB]);
    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");

    // Both rejection messages must carry the Path A recovery hint.
    expect((resultA as PromiseRejectedResult).reason.message).toContain(
      "PAKE token was already rotated and saved, but encryption key setup failed",
    );
    expect((resultB as PromiseRejectedResult).reason.message).toContain(
      "PAKE token was already rotated and saved, but encryption key setup failed",
    );

    // The psilinkRecoveryHintEmitted tag must suppress the generic advisory.
    // If the tag is missing, the catch block logs "The PAKE token was already
    // rotated and saved before this error." which would appear in mockState.errors.
    expect(
      mockState.errors.every((m) => !m.includes("already rotated and saved")),
    ).toBe(true);
  } finally {
    createSpy.mockRestore();
  }
}, 15_000);

test("runProtocol resolves (does not reject) when SIGINT fires during EncryptedConnection.create", async () => {
  // Path B: a signal fires while create() is awaiting key derivation. doCleanup
  // runs against the raw conn (activeConn before create resolves). After create
  // resolves, the code closes the wrapper and throws "interrupted by SIGINT
  // during key derivation". The catch block sees signalReceived !== undefined,
  // logs the error, and returns — so runProtocol resolves rather than rejecting,
  // leaving the signal handler's process.exit(130) as the sole exit path.
  //
  // Both parties must reach create() before the signal fires so neither is
  // still in the PAKE round-trip when doCleanup closes the connection.
  const keyFileA = path.join(tmpDir, "a.key");
  const keyFileB = path.join(tmpDir, "b.key");
  saveKeyFile(keyFileA, { pakeToken: TOKEN_A });
  saveKeyFile(keyFileB, { pakeToken: TOKEN_A });

  const exitSpy = vi
    .spyOn(process, "exit")
    .mockReturnValue(undefined as never);

  const detachListeners = vi.fn();
  const stubConn = { detachListeners } as unknown as EncryptedConnection;

  let resolveA!: () => void;
  let resolveB!: () => void;
  let callCount = 0;
  const createSpy = vi
    .spyOn(EncryptedConnection, "create")
    .mockImplementation(
      () =>
        new Promise<EncryptedConnection>((resolve) => {
          if (callCount === 0) {
            resolveA = () => resolve(stubConn);
          } else {
            resolveB = () => resolve(stubConn);
          }
          callCount++;
        }),
    );

  try {
    const pA = runProtocol(
      {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileA },
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
        authentication: { pakeToken: TOKEN_A, keyFilePath: keyFileB },
      },
      minimalPrepared,
      undefined,
      -1,
      "test-b",
    );

    // Wait for both parties to enter create() before emitting the signal. Both
    // PAKE handshakes must have completed at this point.
    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });

    // Resolve both held create() Promises so runProtocol can proceed to the
    // signalReceived check at line 612, close the wrapper, and return.
    resolveA();
    resolveB();

    const [resultA, resultB] = await Promise.allSettled([pA, pB]);
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
    expect(detachListeners).toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
    createSpy.mockRestore();
  }
}, 20_000);
