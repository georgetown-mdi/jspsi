import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import os from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LocalFSClient } from "../../src/connection/localFSClient";

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
});
