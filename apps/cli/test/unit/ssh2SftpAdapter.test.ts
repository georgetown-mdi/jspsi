import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
} from "../../src/connection/listingGuard";
import {
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_SLOW_OPERATION_WARNING_MS,
  SFTP_STALL_DEADLINE_MS,
} from "../../src/connection/sftpLivenessGuard";

// --- connect retry -----------------------------------------------------------

describe("connect retry", () => {
  test("retries and succeeds within maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      // `on` models the raw wrapper's EventEmitter surface: connect() attaches a
      // guarded fatal-'error' listener to it (so a malformed server reply cannot
      // crash the process), so the mock must expose it like the real wrapper does.
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi.fn().mockImplementation(async () => {
        if (++calls < 3) throw new Error("connection refused");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 2,
      });
      // Advance past two 1 s retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(2_001);
      await p;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("throws after exhausting maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi.fn().mockImplementation(async () => {
        calls++;
        throw new Error("connection refused");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 1,
      });
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(p).rejects.toThrow("connection refused");
      // 2 total attempts (initial + 1 reconnect) with 1 s delay between each.
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("strips maxReconnectAttempts from options passed to ssh2", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    let capturedOptions: Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi
        .fn()
        .mockImplementation(async (opts: Record<string, unknown>) => {
          capturedOptions = opts;
        }),
    };

    // 0 retries = 1 total attempt.
    await adapter.connect({
      host: "sftp.example.org",
      maxReconnectAttempts: 0,
    });
    expect(capturedOptions).toHaveProperty("host", "sftp.example.org");
    expect(capturedOptions).not.toHaveProperty("maxReconnectAttempts");
  });

  test("rejects at connect time when the internal SFTP API drops a method it drives", async () => {
    // createExclusive()/list() call open/close/opendir/readdir on the internal
    // SFTPWrapper directly. The connect-time guard must catch an upstream
    // rename or removal of any of them and surface one actionable error here,
    // rather than letting a TypeError surface at the first send()/poll.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      // `readdir` is absent, as if a future ssh2 version renamed it; the
      // session property itself is present, so the bare null check would pass.
      sftp: { open: vi.fn(), close: vi.fn(), opendir: vi.fn() },
      connect: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      adapter.connect({ host: "sftp.example.org", maxReconnectAttempts: 0 }),
    ).rejects.toThrow("readdir");
  });
});

// --- rename retry ------------------------------------------------------------

describe("rename retry", () => {
  // rename() wraps client.rename in retryPromise, but -- unlike the idempotent
  // put() -- gates the retry on the generic SSH_FX_FAILURE (status 4): the
  // "operation did not take effect" code that surfaced as the `_rename: Failure`
  // crashing the mixed-connection rendezvous joiner under load. These tests pin
  // that contract: a transient status-4 failure is absorbed within a bounded
  // budget, a persistent one still surfaces after the bound, and a non-status-4
  // failure (e.g. SSH_FX_NO_SUCH_FILE) is terminal and is NOT retried, so a
  // succeeded-but-lost-reply rename cannot be amplified into a spurious error.

  // An error shaped like the one ssh2-sftp-client surfaces: the raw numeric SFTP
  // status on `code` (passed through fmtError).
  const sftpError = (message: string, code: number) =>
    Object.assign(new Error(message), { code });

  test("retries a transient SSH_FX_FAILURE and resolves", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        // Fail the first two attempts with the server's generic failure, then
        // succeed -- the shape of the observed transient flake.
        if (++calls < 3) throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // rename reads this.options!.retries; an empty object falls back to 5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Advance past the two 100 ms retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(250);
      await expect(renaming).resolves.toBeUndefined();
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects after exhausting the bounded retries on persistent SSH_FX_FAILURE", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // Bound the retries explicitly so the attempt count is asserted, not the
      // default: 2 retries == 3 total attempts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 2 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(renaming).rejects.toThrow("_rename: Failure");
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a non-SSH_FX_FAILURE error (NO_SUCH_FILE surfaces at once)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        // SSH_FX_NO_SUCH_FILE (2): the code a second attempt would see if the
        // first rename had actually succeeded but its reply was lost. Retrying
        // it would manufacture a spurious failure from a successful rename, so
        // it must be terminal -- one attempt, no re-issue.
        throw sftpError("_rename: No such file or directory", 2);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      const assertion = expect(renaming).rejects.toThrow("No such file");
      // Advancing well past several retry windows proves no retry was scheduled.
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("honors an explicit retries: 0 (no retry even on SSH_FX_FAILURE)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // retries: 0 must disable the retry, not be coerced to the default of 5 --
      // the `?? 5` (not `|| 5`) guard. A status-4 failure that would otherwise be
      // retried is surfaced after the single attempt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      const assertion = expect(renaming).rejects.toThrow("_rename: Failure");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops retrying when a fatal session error lands between attempts", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        // A fatal protocol error lands in the inter-attempt window: it sets
        // fatalSftpError (as the guarded wrapper 'error' listener would), but
        // this attempt still rejects with the status-4 the server already sent.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // The status-4 reply alone would be retried, but the next attempt's
      // dead-session re-check rejects promptly with the terminal stalled error
      // (not status 4) rather than buffering a request on the dead channel.
      const assertion = expect(renaming).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- createExclusive ---------------------------------------------------------

describe("createExclusive", () => {
  let adapter: SSH2SFTPClientAdapter;
  let mockOpen: ReturnType<typeof vi.fn>;
  let mockClose: ReturnType<typeof vi.fn>;
  let mockExists: ReturnType<typeof vi.fn>;

  function injectSftpSession(sftpOpen: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: sftpOpen ? { open: mockOpen, close: mockClose } : null,
      // exists() is called by createExclusive when SFTPv3 FAILURE (code 4)
      // is received, to resolve the ambiguity between a genuine race and a
      // real I/O error. Default: returns false (file not present).
      exists: mockExists,
    };
  }

  beforeEach(() => {
    adapter = new SSH2SFTPClientAdapter();
    mockOpen = vi
      .fn()
      .mockImplementation(
        (
          _path: string,
          _flags: number,
          _attrs: object,
          cb: (err: Error | null, handle: Buffer) => void,
        ) => cb(null, Buffer.alloc(4)),
      );
    mockClose = vi
      .fn()
      .mockImplementation((_handle: Buffer, cb: (err: Error | null) => void) =>
        cb(null),
      );
    mockExists = vi.fn().mockResolvedValue(false);
    injectSftpSession(true);
  });

  test("resolves when the server creates the file", async () => {
    await expect(
      adapter.createExclusive("/remote/new.txt"),
    ).resolves.toBeUndefined();
    expect(mockOpen).toHaveBeenCalledOnce();
    // SSH_FXF_WRITE (0x02) | SSH_FXF_CREAT (0x08) | SSH_FXF_EXCL (0x20) = 0x2A
    expect(mockOpen).toHaveBeenCalledWith(
      "/remote/new.txt",
      0x2a,
      {},
      expect.any(Function),
    );
    expect(mockClose).toHaveBeenCalledOnce();
  });

  test("rejects with the original server error when open fails with an unrecognized code", async () => {
    const serverErr = new Error("SSH_FX_FILE_ALREADY_EXISTS");
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(serverErr, Buffer.alloc(0)),
    );
    await expect(adapter.createExclusive("/remote/existing.txt")).rejects.toBe(
      serverErr,
    );
    // close must not be called when open fails
    expect(mockClose).not.toHaveBeenCalled();
  });

  test("normalizes SFTPv3 FAILURE (numeric 4) to code === 'EEXIST' when the file exists (genuine race)", async () => {
    // SFTPv3 SSH_FX_FAILURE (4) is ambiguous. When exists() confirms the file
    // is present, the exclusive-create lost a genuine lock-file race and the
    // adapter must normalize to EEXIST so FileSyncConnection's race handler
    // fires.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    mockExists.mockResolvedValue(true);
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(mockExists).toHaveBeenCalledWith("/remote/existing.txt");
  });

  test("wraps SFTPv3 FAILURE (numeric 4) with a diagnostic hint when the file does not exist (real I/O error)", async () => {
    // When exists() reports the file is absent, code 4 indicates a genuine I/O
    // failure (disk full, permissions, etc.) rather than a race. The error is
    // wrapped with an actionable message that points the user at the SFTP
    // server logs before retrying; the original error is available as
    // err.cause.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    // mockExists defaults to false (file not present), which is the I/O-error path.
    const err = await adapter
      .createExclusive("/remote/new.txt")
      .catch((e: unknown) => e);
    expect(err).not.toBe(sftpV3Err);
    expect((err as Error).cause).toBe(sftpV3Err);
    expect((err as Error).message).toContain("SSH_FX_FAILURE");
    // The wrap must steer users toward diagnosis (server logs) before any
    // retry, since the file is absent and the cause is therefore server-side.
    expect((err as Error).message).toContain("server logs");
    expect(mockExists).toHaveBeenCalledWith("/remote/new.txt");
  });

  test("normalizes SFTPv4+ FILE_ALREADY_EXISTS (numeric 11) to code === 'EEXIST'", async () => {
    const sftpV4Err = Object.assign(new Error("File already exists"), {
      code: 11,
    });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV4Err, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("passes through an error that already has code === 'EEXIST' without re-wrapping", async () => {
    // If a future ssh2 version normalizes the error to "EEXIST" before we see
    // it, we should pass it through unchanged rather than wrapping it in a new
    // Error (which would add noise to the error chain).
    const alreadyNormalized = Object.assign(new Error("file exists"), {
      code: "EEXIST",
    });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(alreadyNormalized, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    // Same object reference — not re-wrapped.
    expect(err).toBe(alreadyNormalized);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("does not normalize other SFTP error codes (e.g. PERMISSION_DENIED = 3)", async () => {
    const permErr = Object.assign(new Error("Permission denied"), { code: 3 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(permErr, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/noperm.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe(3);
  });

  test("rejects with the close error when close fails after a successful open", async () => {
    const closeErr = new Error("sftp close error");
    mockClose.mockImplementation(
      (_handle: Buffer, cb: (err: Error | null) => void) => cb(closeErr),
    );
    await expect(adapter.createExclusive("/remote/new.txt")).rejects.toBe(
      closeErr,
    );
  });

  test("propagates original SFTPv3 FAILURE (4) when exists() itself rejects", async () => {
    // When the secondary exists() call fails (e.g., a second network error
    // immediately after the exclusive-open failure), the ambiguity between a
    // genuine race and a real I/O error cannot be resolved. The original
    // openErr is propagated unchanged so callers see the first error rather
    // than a confusing secondary one.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    mockExists.mockRejectedValue(new Error("network timeout during exists()"));
    const err = await adapter
      .createExclusive("/remote/path.txt")
      .catch((e: unknown) => e);
    expect(err).toBe(sftpV3Err);
    expect((err as NodeJS.ErrnoException).code).toBe(4);
    expect(mockExists).toHaveBeenCalledWith("/remote/path.txt");
  });

  test("rejects with a diagnostic error when the SFTP session is not open", async () => {
    injectSftpSession(false);
    await expect(adapter.createExclusive("/remote/new.txt")).rejects.toThrow(
      "SFTP session is not open",
    );
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test("bounds an open() whose callback is never invoked via the operation deadline", async () => {
    // The withheld-response liveness class: the server accepts the request but
    // never invokes the open callback, so the exclusive create would await
    // forever. The whole-operation deadline must fail it with the typed error.
    vi.useFakeTimers();
    try {
      mockOpen.mockImplementation(() => {
        // Deliberately never invokes the callback.
      });
      const creating = adapter.createExclusive("/remote/lock.json");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(creating).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      expect(mockClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a close() whose callback is never invoked via the operation deadline", async () => {
    // open succeeds (default mock) but the server withholds the close callback;
    // the deadline still fails the operation rather than hanging after the file
    // was created.
    vi.useFakeTimers();
    try {
      mockClose.mockImplementation(() => {
        // Deliberately never invokes the callback.
      });
      const creating = adapter.createExclusive("/remote/lock.json");
      const assertion = expect(creating).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      expect(mockClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded metadata write/stat/delete --------------------------------------
//
// rename/delete/exists are single metadata round-trips (no payload), so each is
// bounded by the same flat 60 s withSftpOperationDeadline that createExclusive
// uses: a server that accepts the request but withholds the callback fast-fails
// with the typed terminal TransportOperationStalledError rather than riding the
// ~1 h whole-exchange budget. Each op needs its own case (a single op's test does
// not prove the others are wrapped). The dead-session short-circuit for the same
// four ops is covered by the fatal-wrapper-error guard tests below.

describe("bounded metadata write/stat/delete", () => {
  test("bounds a withheld rename by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // rename reads this.options!.retries; an empty object falls back to 5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        // Accepts the call but never settles: the server withholds the rename ack.
        rename: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Capture before advancing so the mid-advance rejection is not unhandled.
      const captured = renaming.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("withheld the rename response");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a withheld delete by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        delete: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const deleting = adapter.delete("/remote/x.json");
      const captured = deleting.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("withheld the delete response");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a withheld exists by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        exists: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const checking = adapter.exists("/remote/lock.json");
      const captured = checking.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("withheld the stat response");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not deadline a metadata op that completes promptly", async () => {
    // The deadline must not penalize a normal sub-second round-trip: a delete
    // that resolves at once settles on its own result, leaving no pending timer.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        delete: vi.fn().mockResolvedValue(undefined),
      };
      await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded safeDelete (best-effort, never rejects) -------------------------
//
// safeDelete gets the same 60 s per-op deadline as delete(), so a hostile server
// withholding the delete callback during teardown can no longer stall to the
// coarse whole-exchange budget -- but it must keep its never-reject contract, so
// both the delete's own error AND the deadline's stall error are swallowed: it
// always resolves, just within 60 s.

describe("bounded safeDelete", () => {
  test("bounds a withheld safeDelete by the deadline and still resolves (never rejects)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        // Withholds the delete callback: the inner promise never settles, so only
        // the deadline can end it.
        delete: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const deleting = adapter.safeDelete("/remote/x.json");
      // Resolves (not rejects) once the deadline fires -- the stall error is
      // swallowed to honor the never-reject contract.
      const assertion = expect(deleting).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("swallows a safeDelete error and resolves without waiting the deadline", async () => {
    // A delete that fails for its own reason (e.g. permissions) settles at once;
    // safeDelete swallows it and resolves promptly, never arming a lingering wait.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      delete: vi.fn().mockRejectedValue(new Error("permission denied")),
    };
    await expect(adapter.safeDelete("/remote/x.json")).resolves.toBeUndefined();
  });
});

// --- capped get --------------------------------------------------------------

describe("capped get", () => {
  test("refuses an over-cap file even when get() resolves before the sink error settles", async () => {
    // Regression: ssh2-sftp-client resolves a stream destination via the read
    // stream's 'end' listener while the sink's cap-exceeded error rejects via a
    // separate listener. For a file that finishes in one or two chunks the
    // 'end' can win the race and resolve(wtr) with the under-cap prefix before
    // the rejection settles. createCappedSink settles its own `result` at the
    // point of detection (inside the sink's write handler), so the adapter
    // surfaces a FrameSizeExceededError regardless of which listener fired or
    // how get() ultimately settles.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        // No sink.on('error') here: createCappedSink attaches its own no-op
        // listener, so the cap-fire error is handled without the caller's help.
        sink.write(Buffer.alloc(20)); // under cap (maxBytes 32): retained
        sink.write(Buffer.alloc(20)); // crosses cap: rejects result at detection
        return Promise.resolve(sink); // mimic 'end' winning the race
      }),
    };
    await expect(
      adapter.get("/remote/oversize.bin", { maxBytes: 32 }),
    ).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("rejects at the point of detection without waiting for get() to settle", async () => {
    // The structural guarantee: the over-cap refusal is owned by the sink and
    // does not depend on whether/how ssh2-sftp-client's get() promise settles.
    // Here get() never settles at all; the adapter must still reject as soon as
    // the running total crosses the cap.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        // No sink.on('error'): createCappedSink self-handles the cap-fire error.
        sink.write(Buffer.alloc(40)); // crosses cap (maxBytes 32) immediately
        return new Promise<void>(() => {}); // never settles
      }),
    };
    await expect(
      adapter.get("/remote/oversize.bin", { maxBytes: 32 }),
    ).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("returns the buffer for an under-cap file", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        sink.write(Buffer.from("hello"));
        return Promise.resolve(sink);
      }),
    };
    const buf = await adapter.get("/remote/ok.bin", { maxBytes: 32 });
    expect(buf.toString()).toBe("hello");
  });

  test("bounds a capped read whose transfer never delivers data via the idle deadline", async () => {
    // The withheld-transfer liveness class: the server opens the read stream but
    // writes nothing and never ends it, so `result` would never settle. The size
    // cap cannot catch this (no bytes accumulate); the idle deadline must.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation(() => new Promise<Writable>(() => {})),
      };
      const reading = adapter.get("/remote/silent.bin", { maxBytes: 32 });
      const assertion = expect(reading).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not stall a slow but progressing transfer (idle window resets on each chunk)", async () => {
    // The idle bound must not penalize a legitimately large, slow transfer: it
    // resets on every chunk, so a transfer whose chunk gaps stay under the
    // window completes even though its TOTAL time exceeds the window -- which a
    // whole-operation deadline would have wrongly failed.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let resolveGet!: (s: Writable) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
          sink.write(Buffer.from("a"));
          // Next chunk and completion each land under one idle window after the
          // previous event, but the total span (1.2x the window) exceeds it.
          setTimeout(
            () => sink.write(Buffer.from("b")),
            SFTP_STALL_DEADLINE_MS * 0.6,
          );
          setTimeout(() => resolveGet(sink), SFTP_STALL_DEADLINE_MS * 1.2);
          return new Promise<Writable>((res) => {
            resolveGet = res;
          });
        }),
      };
      const reading = adapter.get("/remote/slow.bin", { maxBytes: 32 });
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS * 1.2 + 1);
      expect((await reading).toString()).toBe("ab");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds an uncapped read whose transfer never settles via the operation deadline", async () => {
    // The uncapped path returns the library's get() promise directly and has no
    // counting sink (hence no per-chunk progress signal), so it is bounded by a
    // coarse whole-operation deadline. The transport always passes maxBytes, so
    // this path is the defensive backstop.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const reading = adapter.get("/remote/silent.bin"); // no maxBytes: uncapped
      const assertion = expect(reading).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded put (idle window) -----------------------------------------------
//
// Unlike the metadata ops, put carries a payload whose legitimate transfer can
// exceed a flat 60 s deadline over a slow link, so it is bounded by a
// progress-based idle window (createBoundedPutSource): the payload is streamed in
// chunks, and the window resets on each chunk pulled under the write stream's
// ack-driven backpressure. A withheld/stalled (no-progress) upload trips the
// window; a slow-but-progressing one keeps resetting it and is never false-failed.
// Both cases need their own test (one is not sufficient for the other).

describe("bounded put (idle window)", () => {
  test("bounds a put that progresses then stalls via the idle window", async () => {
    // The server accepts and acks the first couple of chunks, then withholds all
    // further acks (stops consuming the source). The idle window, reset by those
    // chunks, then fires on the no-progress gap with the typed terminal error --
    // proving the bound catches a transfer that genuinely started and then stalled,
    // not merely one that never began.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          // Never resolves: the stall is what settles the adapter's promise.
          return new Promise<never>(() => {
            let consumed = 0;
            source.on("data", () => {
              consumed += 1;
              // Consume two chunks, then withhold acks entirely by pausing -- no
              // further chunks are pulled, so progress stops.
              if (consumed >= 2) source.pause();
            });
          });
        }),
      };
      const payload = Buffer.alloc(3 * SFTP_PUT_PROGRESS_CHUNK_BYTES, 7);
      const writing = adapter.put(payload, "/remote/out.bin");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("made no upload progress");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not stall a slow but progressing upload (window resets on each chunk)", async () => {
    // The idle bound must not penalize a legitimately large, slow upload: each
    // chunk consumed resets the window, so an upload whose chunk gaps stay under
    // the window completes even though its TOTAL time spans several windows --
    // which a flat whole-operation deadline would have wrongly failed.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // Consume one chunk per half-window: each gap stays under the 60 s window,
      // but the six-chunk total spans ~3 windows.
      const gap = SFTP_STALL_DEADLINE_MS / 2;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          return new Promise<string>((resolve) => {
            source.on("data", () => {
              source.pause();
              setTimeout(() => source.resume(), gap);
            });
            source.on("end", () => resolve("uploaded data stream"));
          });
        }),
      };
      const payload = Buffer.alloc(6 * SFTP_PUT_PROGRESS_CHUNK_BYTES, 7);
      const writing = adapter.put(payload, "/remote/big.bin");
      let settled: "resolved" | "rejected" | "pending" = "pending";
      void writing.then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );
      // Past a full window, still uploading (not stalled, not yet done): the
      // window has been reset by intervening chunks rather than firing.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      expect(settled).toBe("pending");
      // Drive the remaining paced chunks and completion.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS * 3);
      await expect(writing).resolves.toBe("uploaded data stream");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uploads the exact payload bytes through the chunked source", async () => {
    // The chunked source must reassemble to the original payload byte-for-byte --
    // chunking for the progress signal must not corrupt or reorder the upload.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).options = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    const received: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      put: vi.fn().mockImplementation((source: Readable) => {
        return new Promise<string>((resolve) => {
          source.on("data", (c: Buffer) => received.push(c));
          source.on("end", () => resolve("uploaded data stream"));
        });
      }),
    };
    // A payload that is not a whole multiple of the chunk size, so the final
    // short chunk is exercised too.
    const payload = Buffer.alloc(SFTP_PUT_PROGRESS_CHUNK_BYTES + 123);
    for (let i = 0; i < payload.length; i += 1)
      payload[i] = (i * 31 + 7) & 0xff;
    await adapter.put(payload, "/remote/exact.bin");
    expect(Buffer.concat(received).equals(payload)).toBe(true);
  });

  test("stops retrying when a fatal session error lands between put attempts", async () => {
    // Mirrors the rename() between-attempts case. The first attempt fails with a
    // retryable (non-stall) error while a fatal protocol error lands in the
    // inter-attempt window. The next attempt's dead-session re-check must reject
    // promptly with the terminal stalled error -- without it, that attempt would
    // issue put() on the dead channel and wait out the full idle window before the
    // typed (non-retryable) error ended the retry. The re-check makes it prompt.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      const put = vi.fn().mockImplementation(() => {
        calls += 1;
        // A fatal protocol error lands in the inter-attempt window (as the guarded
        // wrapper 'error' listener would set it), but this attempt still rejects
        // with the retryable transient failure the server already returned.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        return Promise.reject(new Error("transient write failure"));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { put };
      const writing = adapter.put(Buffer.from("x"), "/remote/out.json");
      const captured = writing.catch((e: unknown) => e);
      // Advance past the 100 ms retry delay; the second attempt's re-check runs and
      // rejects at once, with no need for the 60 s idle window.
      await vi.advanceTimersByTimeAsync(200);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("Malformed DATA packet");
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a one-shot ReadableStream put (single attempt)", async () => {
    // A provided stream is one-shot: a failed attempt half-drains it, so retrying
    // would re-pipe an already-consumed stream and silently upload nothing. The
    // non-Buffer branch must therefore attempt a stream exactly once, never retry.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).options = {}; // retries falls back to the default of 5
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      put: vi.fn().mockImplementation(() => {
        calls += 1;
        return Promise.reject(new Error("transient write failure"));
      }),
    };
    const stream = Readable.from([Buffer.from("x")]);
    await expect(adapter.put(stream, "/remote/out.json")).rejects.toThrow(
      "transient write failure",
    );
    expect(calls).toBe(1);
  });

  test("retries a string-path put (re-runnable source) on transient failure", async () => {
    // A string src is re-runnable -- ssh2-sftp-client opens a fresh read stream per
    // attempt -- so the retry is preserved for it (only the one-shot stream loses it).
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 2 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 3) return Promise.reject(new Error("transient"));
          return Promise.resolve("uploaded");
        }),
      };
      const writing = adapter.put("/local/file.bin", "/remote/out.json");
      // Advance past the two 100 ms retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(250);
      await expect(writing).resolves.toBe("uploaded");
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops retrying a string-path put when a fatal session error lands between attempts", async () => {
    // The non-Buffer (string) branch re-checks the dead-session guard before each
    // attempt, mirroring the Buffer branch: a fatal error in the inter-attempt
    // window short-circuits the next attempt with the terminal stalled error
    // instead of issuing put() on the dead channel.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      const put = vi.fn().mockImplementation(() => {
        calls += 1;
        // A fatal protocol error lands in the inter-attempt window; this attempt
        // still rejects with the retryable transient failure the server returned.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        return Promise.reject(new Error("transient write failure"));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { put };
      const writing = adapter.put("/local/file.bin", "/remote/out.json");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(200);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect((err as Error).message).toContain("Malformed DATA packet");
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded list ------------------------------------------------------------

interface MockDirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

// A stand-in for the internal ssh2 SFTPWrapper that serves a directory through
// the handle-based opendir/readdir/close protocol the adapter's list() drives.
// readdir hands back one batch of `batchSize` entries per call and reports
// end-of-directory as an error whose `code` is SSH_FX_EOF (1) -- ssh2's actual
// contract -- and the mock generates entries lazily so a test can model a flood
// far larger than the cap while recording how many entries were actually
// produced (proving the walk stops early) and that the handle is closed exactly
// once.
function makeBatchedSftp(opts: {
  totalEntries: number;
  batchSize: number;
  makeName?: (i: number) => string;
}) {
  const makeName = opts.makeName ?? ((i: number) => `f${i}.json`);
  let produced = 0;
  let readdirCalls = 0;
  let closeCalls = 0;
  const sftp = {
    opendir: (_path: string, cb: (err: Error | null, handle: Buffer) => void) =>
      cb(null, Buffer.from("handle")),
    readdir: (
      _handle: Buffer,
      cb: (
        err: (Error & { code?: number }) | null,
        list?: MockDirEntry[],
      ) => void,
    ) => {
      readdirCalls += 1;
      if (produced >= opts.totalEntries) {
        cb(Object.assign(new Error("EOF"), { code: 1 }));
        return;
      }
      const batch: MockDirEntry[] = [];
      for (
        let i = 0;
        i < opts.batchSize && produced < opts.totalEntries;
        i += 1
      ) {
        batch.push({
          filename: makeName(produced),
          attrs: { mtime: 7, size: produced },
        });
        produced += 1;
      }
      cb(null, batch);
    },
    close: (_handle: Buffer, cb: (err: Error | null) => void) => {
      closeCalls += 1;
      cb(null);
    },
  };
  return {
    sftp,
    get produced() {
      return produced;
    },
    get readdirCalls() {
      return readdirCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

describe("bounded list", () => {
  test("maps a normal directory's entries and closes the handle", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const mock = makeBatchedSftp({ totalEntries: 3, batchSize: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    const result = await adapter.list("/remote/dir");
    expect(result.map((e) => e.name)).toEqual([
      "f0.json",
      "f1.json",
      "f2.json",
    ]);
    // ssh2 reports mtime in seconds; FileInfo.modifyTime is ms.
    expect(result[0].modifyTime).toBe(7000);
    expect(result[2].size).toBe(2);
    expect(mock.closeCalls).toBe(1);
    // A legitimate listing completes in a small, fixed number of round-trips
    // (here 2 batches + the EOF read) -- far under the liveness round-trip cap,
    // so the bound never rejects normal exchange traffic.
    expect(mock.readdirCalls).toBeLessThan(MAX_LISTING_READDIR_BATCHES);
  });

  test("refuses a directory with more entries than the cap without enumerating it all", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const batchSize = 4096;
    // A flood far larger than the cap: list() must refuse it after at most the
    // cap plus one batch, never producing the whole set -- otherwise the SFTP
    // adapter (the path with the in-scope adversary) allocates proportional to
    // the attacker-chosen entry count.
    const mock = makeBatchedSftp({
      totalEntries: MAX_DIRECTORY_ENTRIES + 100_000,
      batchSize,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    await expect(adapter.list("/remote/hostile")).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
    expect(mock.produced).toBeLessThanOrEqual(
      MAX_DIRECTORY_ENTRIES + batchSize,
    );
    expect(mock.produced).toBeLessThan(MAX_DIRECTORY_ENTRIES + 100_000);
    // The handle is closed despite the refusal, and not double-closed.
    expect(mock.closeCalls).toBe(1);
  });

  test("rejects an entry whose filename exceeds the maximum length", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const longName = `${"x".repeat(MAX_FILENAME_LENGTH + 1)}.json`;
    const mock = makeBatchedSftp({
      totalEntries: 1,
      batchSize: 1,
      makeName: () => longName,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    await expect(adapter.list("/remote/hostile")).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
    expect(mock.closeCalls).toBe(1);
  });

  test("accepts a directory at exactly the entry cap", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const mock = makeBatchedSftp({
      totalEntries: MAX_DIRECTORY_ENTRIES,
      batchSize: 4096,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    const result = await adapter.list("/remote/dir");
    expect(result).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(mock.closeCalls).toBe(1);
  });

  test("propagates a non-EOF readdir error and closes the handle", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const ioErr = Object.assign(new Error("permission denied"), { code: 3 });
    let closeCalls = 0;
    const sftp = {
      opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("handle")),
      readdir: (
        _handle: Buffer,
        cb: (err: (Error & { code?: number }) | null) => void,
      ) => cb(ioErr),
      close: (_handle: Buffer, cb: (err: Error | null) => void) => {
        closeCalls += 1;
        cb(null);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp };

    await expect(adapter.list("/remote/dir")).rejects.toBe(ioErr);
    expect(closeCalls).toBe(1);
  });

  test("rejects with a diagnostic error when the SFTP session is not open", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: null };
    await expect(adapter.list("/remote/dir")).rejects.toThrow(
      "SFTP session is not open",
    );
  });

  test("bounds a server that returns empty non-EOF batches forever and closes the handle", async () => {
    // The liveness DoS: a hostile server returns valid but empty (count = 0)
    // non-EOF readdir batches without end. Each advances neither the entry-count
    // nor the filename-length size bound and never carries the EOF status, so
    // the batch loop would recurse forever. The round-trip cap must fail it with
    // the typed terminal error and still close the open handle. Fake timers keep
    // the test purely about the round-trip cap: list()'s wall-clock deadline is
    // cleared by the cap's settle() before list() rejects, but faking setTimeout
    // means it is never even registered with the real event loop.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let readdirCalls = 0;
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        readdir: (
          _handle: Buffer,
          cb: (
            err: (Error & { code?: number }) | null,
            list?: unknown[],
          ) => void,
        ) => {
          readdirCalls += 1;
          // Deliver the empty batch asynchronously so the bounded recursion
          // unwinds the stack each round, mirroring ssh2's per-batch
          // socket-event dispatch; a synchronous callback would recurse to the
          // cap in one frame. queueMicrotask is not faked, so the flood still
          // drives to the cap without advancing timers.
          queueMicrotask(() => cb(null, []));
        },
        close: (_handle: Buffer, cb: (err: Error | null) => void) => {
          closeCalls += 1;
          cb(null);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      await expect(adapter.list("/remote/hang")).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      // Stopped at the round-trip cap rather than looping forever.
      expect(readdirCalls).toBe(MAX_LISTING_READDIR_BATCHES);
      // Handle closed on the bounded-failure path, exactly once.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a server that never invokes the readdir callback via the wall-clock deadline", async () => {
    // The other liveness DoS: the server accepts the opendir but withholds the
    // readdir callback entirely, so the call would await an unresolved promise
    // forever. No batch ever arrives, so only the wall-clock deadline can fail
    // it -- and it must still close the open handle.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let readdirCalls = 0;
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        // Never calls back: the directory read hangs.
        readdir: () => {
          readdirCalls += 1;
        },
        close: (_handle: Buffer, cb: (err: Error | null) => void) => {
          closeCalls += 1;
          cb(null);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      const listing = adapter.list("/remote/silent");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      // Tried readdir once, then hung; the deadline, not the round-trip cap,
      // bounded it.
      expect(readdirCalls).toBe(1);
      // Handle closed on the bounded-failure path, exactly once.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("settles on the deadline even when the close callback is also withheld", async () => {
    // Regression: settle() must not gate the listing's settlement on the close
    // callback. A server can withhold close exactly as it withholds a readdir,
    // so if settle() awaited close() the deadline would fire, clear its own
    // timer, then hang forever inside the un-returning close -- restoring the
    // unbounded wait the deadline exists to defeat. The listing must reject on
    // the deadline regardless of whether close ever calls back; the handle close
    // is attempted best-effort but does not block the rejection.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        // Withholds the readdir callback, so the deadline -- not a batch -- ends
        // the operation.
        readdir: () => {},
        // Attempted, but its own callback is never delivered.
        close: (_handle: Buffer, _cb: (err: Error | null) => void) => {
          closeCalls += 1;
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      const listing = adapter.list("/remote/silent-close");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      // close was attempted as best-effort cleanup even though its callback
      // never arrived; the settlement did not wait on it.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- slow-operation warning (observability) ----------------------------------
//
// The non-fatal warning fires at SFTP_SLOW_OPERATION_WARNING_MS (below the 60 s
// read fast-fail) and reports observed progress where a cheap signal exists:
// bytes-so-far for a capped get, entries-so-far for a list, the payload size for a
// put, and elapsed-only for the atomic ops. It never alters the result. The
// adapter's log is replaced with a spy so the warning line can be asserted without
// touching the console. (withSlowOperationWarning's own contract -- threshold,
// non-fatal passthrough, no-warn-when-fast -- is covered in
// sftpLivenessGuard.test.ts; these tests pin the per-operation wiring.)

describe("slow-operation warning", () => {
  test("reports bytes-so-far for a slow capped get and still resolves (non-fatal)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      let resolveGet!: (s: Writable) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
          // 100 bytes arrive up front, then the transfer completes after the
          // warning threshold but before the idle deadline.
          sink.write(Buffer.alloc(100));
          setTimeout(
            () => resolveGet(sink),
            SFTP_SLOW_OPERATION_WARNING_MS + 5_000,
          );
          return new Promise<Writable>((res) => {
            resolveGet = res;
          });
        }),
      };
      const reading = adapter.get("/remote/big.bin", { maxBytes: 1_000 });
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("file read");
      expect(message).toContain("/remote/big.bin");
      expect(message).toContain("100 bytes received so far");
      // Non-fatal: the read still completes with its bytes.
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await reading).length).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports the payload size for a slow put and still resolves (non-fatal)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      let resolvePut!: () => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      // put reads this.options!.retries; an empty object falls back to the default.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation(
          () =>
            new Promise<void>((res) => {
              resolvePut = res;
            }),
        ),
      };
      const writing = adapter.put(Buffer.alloc(2048), "/remote/out.tmp");
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("file write");
      expect(message).toContain("/remote/out.tmp");
      expect(message).toContain("2048 byte payload");
      resolvePut();
      await expect(writing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports entries-so-far for a slow list while the read deadline still bounds it", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      let readdirCalls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        sftp: {
          opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
            cb(null, Buffer.from("handle")),
          readdir: (
            _h: Buffer,
            cb: (
              e: (Error & { code?: number }) | null,
              list?: unknown[],
            ) => void,
          ) => {
            // First batch delivers two entries; the next readdir callback is
            // withheld, so the listing is bounded by the 60 s deadline -- but the
            // 30 s warning fires first, reporting the two entries already read.
            if (++readdirCalls === 1)
              cb(null, [
                { filename: "a.json", attrs: { mtime: 1, size: 1 } },
                { filename: "b.json", attrs: { mtime: 1, size: 1 } },
              ]);
          },
          close: (_h: Buffer, cb: () => void) => cb(),
        },
      };
      const listing = adapter.list("/remote/dir");
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("2 entries read so far");
      // The terminal deadline still fires; the warning did not displace it.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("warns elapsed-only (no progress snippet) for a slow atomic exists and still resolves", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      let resolveExists!: (value: boolean) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        exists: vi.fn().mockImplementation(
          () =>
            new Promise<boolean>((res) => {
              resolveExists = res;
            }),
        ),
      };
      const checking = adapter.exists("/remote/lock");
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("existence check");
      expect(message).toContain("/remote/lock");
      // No payload, so elapsed-only: no parenthesized progress snippet.
      expect(message).not.toContain("(");
      resolveExists(true);
      await expect(checking).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- fatal wrapper-error guard -----------------------------------------------

// A stand-in for the raw ssh2 SFTPWrapper as a real EventEmitter, so the guarded
// 'error' listener and Node's zero-listener throw semantics are exercised
// faithfully. It carries the handle-based methods connect()'s presence guard
// requires plus the EventEmitter surface (`on`), and tracks whether the
// directory methods were invoked so a test can prove a post-crash operation
// rejects WITHOUT issuing a request to the dead session.
function makeWrapper() {
  const wrapper = new EventEmitter() as EventEmitter & {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    opendir: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
  };
  wrapper.open = vi.fn();
  wrapper.close = vi.fn();
  wrapper.opendir = vi.fn();
  wrapper.readdir = vi.fn();
  return wrapper;
}

describe("fatal wrapper-error guard", () => {
  test("connect attaches exactly one 'error' listener to the raw wrapper", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(wrapper.listenerCount("error")).toBe(1);
  });

  test("emitting 'error' on the wrapper does not crash (listener handles it)", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Node throws on an 'error' event only when there are zero listeners; the
    // guard makes this a no-op instead of an uncaught exception.
    expect(() =>
      wrapper.emit("error", new Error("Malformed NAME packet")),
    ).not.toThrow();
  });

  test("a repeated connect on the same wrapper does not duplicate the listener", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Idempotent on the same wrapper instance: no second listener (which would
    // eventually trip MaxListenersExceeded), because the wrapper identity is
    // unchanged.
    expect(wrapper.listenerCount("error")).toBe(1);
  });

  test("a fresh wrapper after a reconnect gets its own listener", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const first = makeWrapper();
    const client = {
      sftp: first as EventEmitter,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    // Model ssh2-sftp-client handing back a new wrapper after an end()/connect()
    // cycle: a different object identity. The guard must attach to it too.
    const second = makeWrapper();
    client.sftp = second;
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    expect(first.listenerCount("error")).toBe(1);
    expect(second.listenerCount("error")).toBe(1);
  });

  test("an operation after a fatal wrapper error rejects promptly with the terminal cause", async () => {
    // The captured-cause nice-to-have: once a fatal 'error' has killed the
    // session, the next operation rejects at once with the typed terminal error
    // (carrying the real cause) instead of issuing a request to the dead wrapper
    // and waiting out the 60 s liveness deadline.
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    wrapper.emit("error", new Error("Malformed NAME packet"));

    const listErr = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(listErr).toBeInstanceOf(TransportOperationStalledError);
    expect(listErr).toBeInstanceOf(UsageError);
    expect((listErr as Error).message).toContain("Malformed NAME packet");
    // It did not even attempt to drive the dead session.
    expect(wrapper.opendir).not.toHaveBeenCalled();

    // Same terminal, prompt rejection on the lock path.
    const createErr = await adapter
      .createExclusive("/remote/lock.json")
      .catch((e: unknown) => e);
    expect(createErr).toBeInstanceOf(TransportOperationStalledError);
    expect(wrapper.open).not.toHaveBeenCalled();
  });

  test("the remaining server-driven methods short-circuit after a fatal error", async () => {
    // The crash fix's entry guard covers list/get/createExclusive, but put,
    // delete, rename, exists, and the uncapped get() also drive the server and
    // must short-circuit too. After a fatal error the SFTP channel is destroyed
    // while the TCP/SSH socket stays up (a hostile server keeps it alive), so a
    // request buffered on the closing channel never calls back -- it HANGS rather
    // than erroring. Each guarded method must instead reject promptly with the
    // typed terminal error WITHOUT issuing a request to the dead session; the
    // catch + the never-called mock together prove both. safeDelete is the
    // exception: it MUST honor its never-reject contract (callers run it in catch
    // blocks), so on a dead session it RESOLVES promptly as a best-effort no-op.
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // The ssh2-sftp-client surface put/delete/rename/exists/get delegate to. None
    // may be called once the session is dead; a call would buffer on the closing
    // channel and hang.
    const put = vi.fn();
    const del = vi.fn();
    const rename = vi.fn();
    const exists = vi.fn();
    const get = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      put,
      delete: del,
      rename,
      exists,
      get,
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    wrapper.emit("error", new Error("Malformed DATA packet"));

    const putErr = await adapter
      .put(Buffer.from("x"), "/remote/out.json")
      .catch((e: unknown) => e);
    expect(putErr).toBeInstanceOf(TransportOperationStalledError);
    expect(putErr).toBeInstanceOf(UsageError);
    expect((putErr as Error).message).toContain("Malformed DATA packet");
    expect(put).not.toHaveBeenCalled();

    const deleteErr = await adapter
      .delete("/remote/out.json")
      .catch((e: unknown) => e);
    expect(deleteErr).toBeInstanceOf(TransportOperationStalledError);
    expect(del).not.toHaveBeenCalled();

    const renameErr = await adapter
      .rename("/remote/a.json", "/remote/b.json")
      .catch((e: unknown) => e);
    expect(renameErr).toBeInstanceOf(TransportOperationStalledError);
    expect(rename).not.toHaveBeenCalled();

    const existsErr = await adapter
      .exists("/remote/out.json")
      .catch((e: unknown) => e);
    expect(existsErr).toBeInstanceOf(TransportOperationStalledError);
    expect(exists).not.toHaveBeenCalled();

    // The uncapped get() path (maxBytes === undefined) is guarded at get()'s
    // entry alongside the capped path; assert it rejects terminally and never
    // drives the dead stream.
    const getErr = await adapter
      .get("/remote/out.json")
      .catch((e: unknown) => e);
    expect(getErr).toBeInstanceOf(TransportOperationStalledError);
    expect(get).not.toHaveBeenCalled();

    // safeDelete honors its never-reject contract: on a dead session it RESOLVES
    // (best-effort no-op) rather than rejecting, and does not drive the dead
    // session. Promptness is implicit -- the default test timeout would catch a
    // hang on the still-alive socket.
    await expect(
      adapter.safeDelete("/remote/out.json"),
    ).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });
});
