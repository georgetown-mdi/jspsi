import { expect, test } from "vitest";

import { FileSyncConnection } from "../src/connection/fileSyncConnection";
import type {
  FileTransportClient,
  FileInfo,
} from "../src/connection/fileSyncConnection";

// Minimal in-memory FileTransportClient mock.  Only the methods called by
// send() need real implementations; everything else is a no-op.
function makeMockClient(): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();

  const client: FileTransportClient = {
    connect: async () => {},
    end: async () => {},
    list: async (): Promise<FileInfo[]> => [],
    get: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (typeof src === "string") {
        throw new Error("string src is not supported");
      } else if (Buffer.isBuffer(src)) {
        files.set(dest, src);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of src) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        files.set(dest, Buffer.concat(chunks));
      }
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    safeDelete: async (path: string) => {
      files.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
    },
    exists: async (path: string) => files.has(path),
  };

  return { client, files };
}

// Put a connection into the post-synchronize state without actually
// running the handshake.
function makeConnectedConn(
  client: FileTransportClient,
  opts?: Partial<{ pollingFrequency: number; timeToLiveMs: number }>,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
  });
  conn.connected = true;
  conn.path = "/test";
  return conn;
}

// --- open (sftp) -------------------------------------------------------------

test("open connects and sets path from sftp config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org", path: "/exchanges" },
  });
  expect(conn.connected).toBe(true);
  expect(conn.path).toBe("/exchanges");
});

test("open maps peerTimeoutMs to timeToLive for sftp config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 60_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 60_000);
  expect(ttl).toBeLessThanOrEqual(after + 60_000);
});

test("open maps pollIntervalMs to pollingFrequency for sftp config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 15_000 },
  });
  expect(conn.options.pollingFrequency).toBe(15_000);
});

// --- open (filedrop) ---------------------------------------------------------

test("open sets path and marks connected for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  expect(conn.connected).toBe(true);
  expect(conn.path).toBe("/mnt/share/drop");
});

test("open strips trailing slash from filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop/" });
  expect(conn.path).toBe("/mnt/share/drop");
});

test("open strips multiple trailing slashes from filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop//" });
  expect(conn.path).toBe("/mnt/share/drop");
});

test("open preserves root filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/" });
  expect(conn.path).toBe("/");
});

test("open maps peerTimeoutMs to timeToLive for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { peerTimeoutMs: 60_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 60_000);
  expect(ttl).toBeLessThanOrEqual(after + 60_000);
});

test("open maps pollIntervalMs to pollingFrequency for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { pollIntervalMs: 15_000 },
  });
  expect(conn.options.pollingFrequency).toBe(15_000);
});

test("open normalizes Windows backslashes in filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:\\Users\\shared\\drop" });
  expect(conn.path).toBe("C:/Users/shared/drop");
});

test("open preserves Windows drive root filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:/" });
  expect(conn.path).toBe("C:/");
});

test("open normalizes Windows drive root with trailing backslash", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:\\" });
  expect(conn.path).toBe("C:/");
});

// --- Happy path --------------------------------------------------------------

test("send writes the message file to the store", async () => {
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client);

  await conn.send({ hello: "world" });

  expect(files.has(`/test/${conn.id}.json`)).toBe(true);
});

// --- Race condition: consecutive sends ---------------------------------------

test("send waits for a previous unconsumed message before writing the next", async () => {
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client);

  // Simulate a message from this connection already sitting in the store
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
  const { client, files } = makeMockClient();
  // Short TTL so the test doesn't take long.
  const conn = makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });

  // Plant a stale message that nobody will ever delete.
  const outPath = `/test/${conn.id}.json`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));

  await expect(conn.send({ next: true })).rejects.toThrow("timed out");
});
