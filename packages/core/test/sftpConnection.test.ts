import { expect, test } from "vitest";

import { SFTPConnection } from "../src/connection/sftpConnection";
import type { SFTPClient, FileInfo } from "../src/connection/sftpConnection";

// Minimal in-memory SFTPClient mock.  Only the methods called by send() need
// real implementations; everything else is a no-op.
function makeMockSftp(): { sftp: SFTPClient; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();

  const sftp: SFTPClient = {
    connect: async () => {},
    end: async () => {},
    list: async (): Promise<FileInfo[]> => [],
    get: async (path) => {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      files.set(dest, Buffer.isBuffer(src) ? src : Buffer.from(src as string));
    },
    delete: async (path) => {
      files.delete(path);
    },
    safeDelete: async (path) => {
      files.delete(path);
    },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data !== undefined) {
        files.delete(from);
        files.set(to, data);
      }
    },
    exists: async (path) => files.has(path),
  };

  return { sftp, files };
}

// Put a connection into the post-synchronize state without actually
// running the handshake.
function makeConnectedConn(
  sftp: SFTPClient,
  opts?: Partial<{ pollingFrequency: number; timeToLiveMs: number }>,
): SFTPConnection {
  const conn = new SFTPConnection(sftp, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
  });
  conn.connected = true;
  conn.path = "/test";
  return conn;
}

// --- openWithConfig -----------------------------------------------------------

test("openWithConfig connects and sets path from config", async () => {
  const { sftp } = makeMockSftp();
  const conn = new SFTPConnection(sftp, { verbose: -1 });
  await conn.openWithConfig({
    channel: "sftp",
    server: { host: "sftp.example.org", path: "/exchanges" },
  });
  expect(conn.connected).toBe(true);
  expect(conn.path).toBe("/exchanges");
});

test("openWithConfig maps peerTimeoutMs to timeToLive", async () => {
  const { sftp } = makeMockSftp();
  const conn = new SFTPConnection(sftp, { verbose: -1 });
  const before = Date.now();
  await conn.openWithConfig({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 60_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 60_000);
  expect(ttl).toBeLessThanOrEqual(after + 60_000);
});

test("openWithConfig maps pollIntervalMs to pollingFrequency", async () => {
  const { sftp } = makeMockSftp();
  const conn = new SFTPConnection(sftp, { verbose: -1 });
  await conn.openWithConfig({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 15_000 },
  });
  expect(conn.options.pollingFrequency).toBe(15_000);
});

// --- Happy path --------------------------------------------------------------

test("send writes the message file to the server", async () => {
  const { sftp, files } = makeMockSftp();
  const conn = makeConnectedConn(sftp);

  await conn.send({ hello: "world" });

  expect(files.has(`/test/${conn.id}.json`)).toBe(true);
});

// --- Race condition: consecutive sends ---------------------------------------

test("send waits for a previous unconsumed message before writing the next", async () => {
  const { sftp, files } = makeMockSftp();
  const conn = makeConnectedConn(sftp);

  // Simulate a message from this connection already sitting on the server
  // (e.g. the peer's poller hasn't run yet).
  const outPath = `/test/${conn.id}.json`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));

  // After 50 ms, simulate the peer consuming (deleting) the stale message.
  const consumed = new Promise<void>((resolve) => {
    setTimeout(() => {
      files.delete(outPath);
      resolve();
    }, 50);
  });

  // send() must not throw; it should wait until the stale file is gone.
  await expect(conn.send({ next: true })).resolves.toBeUndefined();
  await consumed;
});

test("send times out when the previous message is never consumed", async () => {
  const { sftp, files } = makeMockSftp();
  // Short TTL so the test doesn't take long.
  const conn = makeConnectedConn(sftp, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });

  // Plant a stale message that nobody will ever delete.
  const outPath = `/test/${conn.id}.json`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));

  await expect(conn.send({ next: true })).rejects.toThrow("timed out");
});
