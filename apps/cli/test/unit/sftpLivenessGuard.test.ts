import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { TransportOperationStalledError } from "@psilink/core";

import {
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_SLOW_OPERATION_WARNING_MS,
  createBoundedPutSource,
  transportOperationStalledError,
  withSlowOperationWarning,
} from "../../src/connection/sftpLivenessGuard";

// The slow-operation warning is observability, NOT a security control: it tells a
// watching operator that an operation is taking a while, and must stay entirely
// outside the terminal-error paths so it can never alter a result. These tests pin
// that contract -- it fires once at the threshold, reports observed progress where
// supplied, and forwards the underlying settlement (value or rejection) unchanged.

describe("withSlowOperationWarning", () => {
  test("emits one warning at the threshold naming the operation, path, and elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      // An operation that never settles on its own within the test window.
      const op = new Promise<string>(() => {});
      void withSlowOperationWarning(op, {
        operation: "file write",
        path: "/dir/temp-x.tmp",
        log: { warn },
        thresholdMs: 1_000,
      });
      // Just before the threshold: silent.
      await vi.advanceTimersByTimeAsync(999);
      expect(warn).not.toHaveBeenCalled();
      // At the threshold: exactly one warning, naming the op, path, and elapsed.
      await vi.advanceTimersByTimeAsync(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("file write");
      expect(message).toContain("/dir/temp-x.tmp");
      expect(message).toContain("1000 ms");
      // It does not re-fire after the threshold.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("includes observed progress (with the elapsed time) when a progress callback is supplied", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const op = new Promise<string>(() => {});
      void withSlowOperationWarning(op, {
        operation: "file read",
        path: "/dir/msg.json",
        log: { warn },
        thresholdMs: 1_000,
        // The callback receives the elapsed time so it can report a rate.
        progress: (elapsedMs) => `42 bytes in ${elapsedMs} ms`,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("(42 bytes in 1000 ms)");
    } finally {
      vi.useRealTimers();
    }
  });

  test("defaults to SFTP_SLOW_OPERATION_WARNING_MS when no threshold is given", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const op = new Promise<string>(() => {});
      void withSlowOperationWarning(op, {
        operation: "rename",
        path: "/dir/a to /dir/b",
        log: { warn },
      });
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS - 1);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not warn when the operation settles before the threshold", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const wrapped = withSlowOperationWarning(Promise.resolve("done"), {
        operation: "delete",
        path: "/dir/x.json",
        log: { warn },
        thresholdMs: 1_000,
      });
      await expect(wrapped).resolves.toBe("done");
      // The timer was cleared on settle, so advancing past the threshold is silent.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("is non-fatal: forwards the resolved value unchanged even after warning", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      let resolveOp!: (value: string) => void;
      const op = new Promise<string>((resolve) => {
        resolveOp = resolve;
      });
      const wrapped = withSlowOperationWarning(op, {
        operation: "file write",
        path: "/dir/x.tmp",
        log: { warn },
        thresholdMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(warn).toHaveBeenCalledTimes(1);
      resolveOp("payload");
      await expect(wrapped).resolves.toBe("payload");
    } finally {
      vi.useRealTimers();
    }
  });

  test("is non-fatal: forwards a rejection unchanged", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const failure = new Error("transport failed");
      const wrapped = withSlowOperationWarning(Promise.reject(failure), {
        operation: "delete",
        path: "/dir/x.json",
        log: { warn },
        thresholdMs: 1_000,
      });
      await expect(wrapped).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("escapes a control/ANSI sequence in the partner-supplied path", async () => {
    // The path can carry a peer-supplied filename (a get/put of a partner file);
    // a hostile server must not reach the operator's terminal through it.
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const op = new Promise<string>(() => {});
      void withSlowOperationWarning(op, {
        operation: "file read",
        path: "/dir/\x1b[31mEVIL.json",
        log: { warn },
        thresholdMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      const message = warn.mock.calls[0][0] as string;
      expect(message).not.toContain("\x1b");
      expect(message).toContain("\\x1b");
    } finally {
      vi.useRealTimers();
    }
  });
});

// createBoundedPutSource tears the source Readable down on every terminal path:
// the idle-stall path destroys it (covered via the adapter), and complete()/fail()
// must too -- ssh2-sftp-client does not destroy a provided stream src on a
// write-stream error, so an undestroyed source would linger until GC.
describe("createBoundedPutSource source teardown", () => {
  test("destroys the source on fail()", () => {
    const { source, result, fail } = createBoundedPutSource(
      "/remote/x",
      Buffer.from("payload"),
    );
    result.catch(() => {}); // the rejection is the point of fail(); absorb it
    expect(source.destroyed).toBe(false);
    fail(new Error("transient write failure"));
    expect(source.destroyed).toBe(true);
  });

  test("destroys the source on complete()", () => {
    const { source, result, complete } = createBoundedPutSource(
      "/remote/x",
      Buffer.from("payload"),
    );
    void result;
    complete("uploaded");
    expect(source.destroyed).toBe(true);
  });
});

// createBoundedPutSource accepts a [header, payload] chunk list and streams the
// parts back-to-back, so the transport writes header || payload without the
// source ever concatenating them in memory (the send-path peak-shaving).
describe("createBoundedPutSource chunk list", () => {
  const drain = (source: Readable): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const received: Buffer[] = [];
      source.on("data", (c: Buffer) => received.push(c));
      source.on("end", () => resolve(Buffer.concat(received)));
      source.on("error", reject);
    });

  test("emits the parts in order, reassembling to their concatenation", async () => {
    const header = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
    // A plain Uint8Array part (not a Buffer) crossing a chunk boundary exercises
    // the zero-copy Buffer-view path and the multi-part slicing loop.
    const payload = new Uint8Array(SFTP_PUT_PROGRESS_CHUNK_BYTES + 40);
    for (let i = 0; i < payload.length; i += 1)
      payload[i] = (i * 17 + 3) & 0xff;
    const { source, result, complete } = createBoundedPutSource(
      "/remote/framed",
      [header, payload],
    );
    void result.catch(() => {});
    const bytes = await drain(source);
    complete("uploaded");
    expect(bytes.equals(Buffer.concat([header, payload]))).toBe(true);
    // Every emitted chunk is a Buffer (what ssh2's write stream consumes), and the
    // header led, so byte 0 is the version marker.
    expect(bytes[0]).toBe(1);
  });

  test("skips zero-length parts and still reaches EOF", async () => {
    const { source, result, complete } = createBoundedPutSource(
      "/remote/framed",
      [Buffer.alloc(0), Buffer.from("abc"), Buffer.alloc(0)],
    );
    void result.catch(() => {});
    const bytes = await drain(source);
    complete("uploaded");
    expect(bytes.toString()).toBe("abc");
  });
});

// The stalled-operation builder is the shared seam every per-operation liveness
// bound routes through -- the capped get/put stalls, the listing stalls, and the
// adapter's dead-session error. Its `path` carries a peer-supplied filename on a
// read/write/delete op, so it is escaped at this one point. Mirrors the
// sanitizeForDisplay categories.
describe("transportOperationStalledError", () => {
  test("is a typed, terminal (TransportOperationStalledError) error", () => {
    const err = transportOperationStalledError(
      "file read",
      "/p/x.json",
      "idle",
    );
    expect(err).toBeInstanceOf(TransportOperationStalledError);
  });

  test("an ordinary path passes through unchanged", () => {
    const err = transportOperationStalledError(
      "file read",
      "/drop/peer-7-42.json",
      "received no data",
    );
    expect(err.message).toContain("/drop/peer-7-42.json");
  });

  test("escapes control/ANSI characters in the path", () => {
    const err = transportOperationStalledError(
      "file read",
      "/drop/\x1b[2J\x1b[31mEVIL.json",
      "received no data",
    );
    expect(err.message).not.toContain("\x1b");
    expect(err.message).toContain("\\x1b");
  });

  test("escapes a newline so the path cannot spoof a log line", () => {
    const err = transportOperationStalledError(
      "file write",
      "/drop/ok.json\nFAKE: clear",
      "no progress",
    );
    expect(err.message).not.toContain("\n");
    expect(err.message).toContain("\\x0a");
  });

  test("neutralizes deceptive Unicode (bidi-override) in the path", () => {
    const err = transportOperationStalledError(
      "file read",
      "/drop/file\u202eEVIL.json",
      "received no data",
    );
    expect(err.message).not.toContain("\u202e");
    expect(err.message).toContain("\\u202e");
  });

  test("neutralizes a homoglyph / confusable in the path", () => {
    // U+0430 (Cyrillic small a) renders identically to ASCII "a".
    const err = transportOperationStalledError(
      "file read",
      "/drop/c\u0430fe.json",
      "received no data",
    );
    expect(err.message).not.toContain("\u0430");
    expect(err.message).toContain("\\u0430");
  });
});
