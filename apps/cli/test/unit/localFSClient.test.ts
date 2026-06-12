import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import os from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  TimeoutError,
} from "@psilink/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
} from "../../src/connection/listingGuard";

// A lazily-generated stand-in for fs.opendir's Dir: yields `total` synthetic
// entries one at a time and records how many were actually pulled. Generating
// entries on demand (rather than building an array) lets a test drive list()
// with a directory far larger than the cap while proving the walk stops at the
// bound -- without the test itself allocating the very array the bound exists to
// prevent.
function countingDir(
  total: number,
  makeEntry: (i: number) => { name: string; isFile: () => boolean },
) {
  let yielded = 0;
  return {
    get yielded() {
      return yielded;
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (yielded >= total)
            return Promise.resolve({ value: undefined, done: true as const });
          const value = makeEntry(yielded);
          yielded += 1;
          return Promise.resolve({ value, done: false as const });
        },
        // for-await calls return() when the body throws or breaks early.
        return() {
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
}

let dir: string;
let client: LocalFSClient;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "psilink-localfs-test-"));
  client = new LocalFSClient();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// --- connect / end -----------------------------------------------------------

test("connect rejects when no path is supplied", async () => {
  await expect(client.connect({})).rejects.toThrow("options.path is required");
});

test("connect resolves for an accessible directory", async () => {
  await expect(client.connect({ path: dir })).resolves.toBeUndefined();
});

test("connect rejects when directory does not exist", async () => {
  await expect(
    client.connect({ path: path.join(dir, "nonexistent") }),
  ).rejects.toThrow("cannot read/write filedrop directory");
});

test("end is a no-op and resolves", async () => {
  await expect(client.end()).resolves.toBeUndefined();
});

// --- list --------------------------------------------------------------------

test("list returns an empty array for an empty directory", async () => {
  const entries = await client.list(dir);
  expect(entries).toEqual([]);
});

test("list returns file names and modifyTime", async () => {
  await fs.writeFile(path.join(dir, "a.txt"), "hello");
  const entries = await client.list(dir);
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("a.txt");
  expect(typeof entries[0].modifyTime).toBe("number");
  expect(entries[0].modifyTime).toBeGreaterThan(0);
});

test("list returns multiple entries", async () => {
  await fs.writeFile(path.join(dir, "x.json"), "{}");
  await fs.writeFile(path.join(dir, "y.json"), "{}");
  const entries = await client.list(dir);
  const names = entries.map((e) => e.name).sort();
  expect(names).toEqual(["x.json", "y.json"]);
});

test("list omits subdirectories", async () => {
  await fs.writeFile(path.join(dir, "file.txt"), "x");
  await fs.mkdir(path.join(dir, "subdir"));
  const entries = await client.list(dir);
  expect(entries.map((e) => e.name)).toEqual(["file.txt"]);
});

test("list omits a file that disappears between readdir and stat", async () => {
  await fs.writeFile(path.join(dir, "keep.txt"), "a");
  await fs.writeFile(path.join(dir, "gone.txt"), "b");
  // Intercept fs.stat to simulate ENOENT for "gone.txt", replicating the
  // readdir/stat race window without requiring a real concurrent deletion.
  const realStat = fs.stat.bind(fs);
  const spy = vi.spyOn(fs, "stat").mockImplementation(((filePath: string) => {
    if (filePath.endsWith("gone.txt"))
      return Promise.reject(
        Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        }),
      );
    return realStat(filePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    const entries = await client.list(dir);
    expect(entries.map((e) => e.name)).toEqual(["keep.txt"]);
  } finally {
    spy.mockRestore();
  }
});

test("list refuses a directory with more entries than the cap, stopping early", async () => {
  // The directory is capable of yielding far more than the cap, but list() must
  // refuse it without enumerating past the bound -- otherwise an attacker who
  // floods the rendezvous directory drives an allocation proportional to the
  // entry count. Proven by asserting the walk pulled exactly cap+1 entries (the
  // one that tripped the bound) and stopped, not all 5000 extra.
  const big = countingDir(MAX_DIRECTORY_ENTRIES + 5_000, (i) => ({
    name: `f${i}.json`,
    isFile: () => true,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(fs, "opendir").mockResolvedValue(big as any);
  try {
    await expect(client.list(dir)).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
    expect(big.yielded).toBe(MAX_DIRECTORY_ENTRIES + 1);
  } finally {
    spy.mockRestore();
  }
});

test("list rejects an entry whose filename exceeds the maximum length", async () => {
  // A name longer than NAME_MAX cannot exist on a real filesystem, so this is
  // driven through a mocked directory: it is the SFTP-server case (a hostile
  // server can synthesize an over-length name in a READDIR response) exercised
  // against the shared bound.
  const longName = `${"x".repeat(MAX_FILENAME_LENGTH + 1)}.json`;
  const hostile = countingDir(1, () => ({
    name: longName,
    isFile: () => true,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(fs, "opendir").mockResolvedValue(hostile as any);
  try {
    await expect(client.list(dir)).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
  } finally {
    spy.mockRestore();
  }
});

test("list accepts a directory at exactly the entry cap", async () => {
  // Off-by-one guard: cap entries must list, only cap+1 trips. stat is mocked so
  // the synthetic names need not exist on disk.
  const atCap = countingDir(MAX_DIRECTORY_ENTRIES, (i) => ({
    name: `f${i}.json`,
    isFile: () => true,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openSpy = vi.spyOn(fs, "opendir").mockResolvedValue(atCap as any);
  const statSpy = vi
    .spyOn(fs, "stat")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockResolvedValue({ mtimeMs: 1, size: 0 } as any);
  try {
    const result = await client.list(dir);
    expect(result).toHaveLength(MAX_DIRECTORY_ENTRIES);
  } finally {
    openSpy.mockRestore();
    statSpy.mockRestore();
  }
});

// --- get ---------------------------------------------------------------------

test("get reads an existing file as a Buffer", async () => {
  const filePath = path.join(dir, "test.txt");
  await fs.writeFile(filePath, "contents");
  const buf = await client.get(filePath);
  expect(buf.toString()).toBe("contents");
});

test("get rejects when file does not exist", async () => {
  await expect(client.get(path.join(dir, "missing.txt"))).rejects.toThrow();
});

test("get refuses a file larger than maxBytes without allocating it", async () => {
  const filePath = path.join(dir, "oversize.bin");
  await fs.writeFile(filePath, Buffer.alloc(64));
  // Spy on the FileHandle read so we can prove the over-cap file is refused
  // after the fstat but before any content read/allocation.
  const handle = await fs.open(filePath, "r");
  const readSpy = vi.spyOn(handle, "read");
  const openSpy = vi.spyOn(fs, "open").mockResolvedValue(handle);
  try {
    await expect(client.get(filePath, { maxBytes: 32 })).rejects.toThrow(
      FrameSizeExceededError,
    );
    expect(readSpy).not.toHaveBeenCalled();
  } finally {
    openSpy.mockRestore();
    readSpy.mockRestore();
    await handle.close();
  }
});

test("get surfaces FrameSizeExceededError even when handle.close rejects", async () => {
  const filePath = path.join(dir, "oversize-closefail.bin");
  await fs.writeFile(filePath, Buffer.alloc(64));
  // A failing close() in the finally block must not mask the typed terminal
  // error: the poll loop classifies FrameSizeExceededError (a UsageError) as
  // terminal and would otherwise reschedule and re-read the oversized file.
  const handle = await fs.open(filePath, "r");
  const closeSpy = vi
    .spyOn(handle, "close")
    .mockRejectedValue(new Error("EIO: simulated close failure"));
  const openSpy = vi.spyOn(fs, "open").mockResolvedValue(handle);
  try {
    await expect(client.get(filePath, { maxBytes: 32 })).rejects.toThrow(
      FrameSizeExceededError,
    );
  } finally {
    openSpy.mockRestore();
    closeSpy.mockRestore();
    await handle.close().catch(() => {});
  }
});

test("get reads a file at exactly maxBytes", async () => {
  const filePath = path.join(dir, "atlimit.bin");
  const contents = Buffer.from("0123456789");
  await fs.writeFile(filePath, contents);
  const buf = await client.get(filePath, { maxBytes: contents.length });
  expect(buf).toEqual(contents);
});

test("get reads a file under maxBytes", async () => {
  const filePath = path.join(dir, "under.txt");
  await fs.writeFile(filePath, "small");
  const buf = await client.get(filePath, { maxBytes: 1024 });
  expect(buf.toString()).toBe("small");
});

// --- put ---------------------------------------------------------------------

test("put rejects a string src", async () => {
  const dest = path.join(dir, "out.txt");
  await expect(client.put("hello string", dest)).rejects.toThrow(
    "string src is not supported",
  );
});

test("put writes a Buffer", async () => {
  const dest = path.join(dir, "out.bin");
  await client.put(Buffer.from([1, 2, 3]), dest);
  const result = await fs.readFile(dest);
  expect(result).toEqual(Buffer.from([1, 2, 3]));
});

test("put writes a ReadableStream", async () => {
  const dest = path.join(dir, "out.stream");
  const stream = Readable.from(["chunk1", "chunk2"]);
  await client.put(stream, dest);
  expect(await fs.readFile(dest, "utf8")).toBe("chunk1chunk2");
});

test("put with flags: 'a' appends to an existing file", async () => {
  const dest = path.join(dir, "append.txt");
  await fs.writeFile(dest, "hello");
  await client.put(Buffer.from(" world"), dest, { flags: "a" });
  expect(await fs.readFile(dest, "utf8")).toBe("hello world");
});

// --- delete ------------------------------------------------------------------

test("delete removes an existing file", async () => {
  const filePath = path.join(dir, "to-delete.txt");
  await fs.writeFile(filePath, "x");
  await client.delete(filePath);
  await expect(fs.access(filePath)).rejects.toThrow();
});

test("delete rejects when file does not exist", async () => {
  await expect(client.delete(path.join(dir, "missing.txt"))).rejects.toThrow();
});

// --- safeDelete --------------------------------------------------------------

test("safeDelete removes an existing file", async () => {
  const filePath = path.join(dir, "to-safe-delete.txt");
  await fs.writeFile(filePath, "x");
  await client.safeDelete(filePath);
  await expect(fs.access(filePath)).rejects.toThrow();
});

test("safeDelete resolves without throwing when file does not exist", async () => {
  await expect(
    client.safeDelete(path.join(dir, "missing.txt")),
  ).resolves.toBeUndefined();
});

// --- rename ------------------------------------------------------------------

test("rename moves a file", async () => {
  const src = path.join(dir, "before.txt");
  const dst = path.join(dir, "after.txt");
  await fs.writeFile(src, "data");
  await client.rename(src, dst);
  await expect(fs.access(src)).rejects.toThrow();
  expect(await fs.readFile(dst, "utf8")).toBe("data");
});

test("rename rejects when source does not exist", async () => {
  await expect(
    client.rename(path.join(dir, "missing.txt"), path.join(dir, "dest.txt")),
  ).rejects.toThrow();
});

// --- createExclusive ---------------------------------------------------------

test("createExclusive creates an empty file that did not previously exist", async () => {
  const dst = path.join(dir, "exclusive.txt");
  await client.createExclusive(dst);
  const stat = await fs.stat(dst);
  expect(stat.size).toBe(0);
});

test("createExclusive rejects with EEXIST when destination already exists", async () => {
  const dst = path.join(dir, "exclusive-exists.txt");
  await fs.writeFile(dst, "existing");
  await expect(client.createExclusive(dst)).rejects.toMatchObject({
    code: "EEXIST",
  });
  // Destination must be unchanged.
  expect(await fs.readFile(dst, "utf8")).toBe("existing");
});

test("createExclusive rejects when the parent directory does not exist", async () => {
  await expect(
    client.createExclusive(path.join(dir, "nonexistent-dir", "file.txt")),
  ).rejects.toThrow();
});

// --- exists ------------------------------------------------------------------

test("exists returns true for an existing file", async () => {
  const filePath = path.join(dir, "present.txt");
  await fs.writeFile(filePath, "");
  expect(await client.exists(filePath)).toBe(true);
});

test("exists returns false for a missing file", async () => {
  expect(await client.exists(path.join(dir, "absent.txt"))).toBe(false);
});

// --- connect: retry and timeout ----------------------------------------------

describe("connect retry and timeout", () => {
  test("retries and succeeds within maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const realAccess = fs.access.bind(fs);
    const spy = vi.spyOn(fs, "access").mockImplementation(((
      filePath: string,
      ...args: unknown[]
    ) => {
      if (++calls < 3)
        return Promise.reject(
          Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          }),
        );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realAccess as any)(filePath, ...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    try {
      const p = client.connect({
        path: dir,
        maxReconnectAttempts: 3,
        connectTimeoutMs: 5_000,
      });
      // Advance past two 1s retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(2_001);
      await p;
      expect(calls).toBe(3);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("throws after exhausting maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const spy = vi.spyOn(fs, "access").mockImplementation(() => {
      calls++;
      return Promise.reject(
        Object.assign(new Error("cannot read/write filedrop directory"), {
          code: "EACCES",
        }),
      );
    });

    try {
      const p = client.connect({
        path: dir,
        maxReconnectAttempts: 2,
        connectTimeoutMs: 5_000,
      });
      const assertion = expect(p).rejects.toThrow(
        "cannot read/write filedrop directory",
      );
      // 3 total attempts (initial + 2 reconnects) with 1s delay between each.
      await vi.advanceTimersByTimeAsync(2_001);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("rejects when connect hangs past connectTimeoutMs", async () => {
    vi.useFakeTimers();
    // Never resolves, simulating a stalled NFS mount.
    const spy = vi
      .spyOn(fs, "access")
      .mockImplementation(() => new Promise(() => {}));

    try {
      const p = client.connect({
        path: dir,
        maxReconnectAttempts: 0,
        connectTimeoutMs: 5_000,
      });
      const assertion = expect(p).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a connect timeout is terminal: it is not retried and strands no second fs.access", async () => {
    vi.useFakeTimers();
    let calls = 0;
    // Every attempt hangs, simulating a stalled hard mount. If a timeout were
    // retried, `calls` would climb past one as the retry loop dispatched fresh
    // probes -- each stranding another thread-pool worker. Bounding that
    // accumulation is the whole point of treating a timeout as terminal.
    const spy = vi.spyOn(fs, "access").mockImplementation(() => {
      calls++;
      return new Promise(() => {});
    });

    try {
      const p = client.connect({
        path: dir,
        maxReconnectAttempts: 3,
        connectTimeoutMs: 5_000,
      });
      // A TimeoutError (not a plain Error) is what the retry predicate keys on
      // to stop, so assert the concrete type the production path now surfaces.
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      // Advance past the first timeout AND well past several 1s retry-delay
      // windows: a terminal timeout must schedule no further attempt.
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
