import { Writable } from "node:stream";

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  DirectoryListingBoundsError,
  FrameSizeExceededError,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
} from "../../src/connection/listingGuard";

// --- connect retry -----------------------------------------------------------

describe("connect retry", () => {
  test("retries and succeeds within maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
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
});
