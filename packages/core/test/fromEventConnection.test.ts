import { expect, test } from "vitest";

import { FileSyncConnection } from "../src/connection/fileSyncConnection";
import type {
  FileTransportClient,
  FileInfo,
} from "../src/connection/fileSyncConnection";
import {
  ConnectionError,
  fromEventConnection,
} from "../src/connection/messageConnection";
import { withCapturedLogs } from "../src/testing";

// These tests exercise `fromEventConnection` over the *real* FileSyncConnection
// transport (driven by an in-memory FileTransportClient), rather than the
// passthrough double used in messageConnection.test.ts. The point is to confirm
// the bridge faithfully surfaces the transport's actual behaviours - polled
// data delivery, asynchronous poll-loop errors, send-time failures, and the
// pre-attach buffered-error path - through the pull-based interface.

// Minimal in-memory FileTransportClient. Mirrors the harness in
// fileSyncConnection.test.ts; only the methods the poll/send/close paths touch
// need real behaviour.
function makeMockClient(): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();

  const client: FileTransportClient = {
    connect: async () => {},
    end: async () => {},
    // Reflect the in-memory store so send()/poll(), which detect files via
    // list() pattern scans, observe the same state get() does.
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) {
        files.set(dest, src);
      } else if (typeof src === "string") {
        files.set(dest, Buffer.from(src));
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
    createExclusive: async (path: string) => {
      if (files.has(path))
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      files.set(path, Buffer.alloc(0));
    },
    exists: async (path: string) => files.has(path),
  };

  return { client, files };
}

// Put a connection into the post-synchronize state without running the
// handshake, so the poll/send paths can be driven directly.
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

function envelope(payload: unknown, seq = 0): Buffer {
  return Buffer.from(
    JSON.stringify({ ts: Date.now(), seq, type: "Object", payload }),
  );
}

test("fromEventConnection over FileSyncConnection: a polled message is delivered to receive()", async () => {
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client);
  conn.peerId = "peer-test";
  const body = envelope({ hello: "world" });
  files.set(`/test/peer-test-${body.length}.json`, body);

  const mc = fromEventConnection(conn);
  conn.start();
  try {
    expect(await mc.receive()).toEqual({ hello: "world" });
  } finally {
    conn.stop();
  }
});

test("fromEventConnection over FileSyncConnection: send() writes the outbound message file", async () => {
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client);
  conn.peerId = "peer-test";

  const mc = fromEventConnection(conn);
  await mc.send({ ping: 1 });

  const written = [...files.keys()].filter((p) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(written).toHaveLength(1);
});

test("fromEventConnection over FileSyncConnection: a poll-loop error surfaces as a sticky transport ConnectionError", async () => {
  const peerId = "peer-test";
  // list() always surfaces a matching file (size matches declared) but get()
  // always throws ENOENT: after MAX_CONSECUTIVE_ENOENT cycles the poller emits
  // a terminal error.
  const [{ err, mc }, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    client.list = async () => [
      { name: `${peerId}-5.json`, modifyTime: 0, size: 5 },
    ];
    client.get = async (p) => {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    };
    const conn = makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    const mc = fromEventConnection(conn);
    try {
      conn.start();
      const err = await mc.receive().catch((e: unknown) => e);
      return { err, mc };
    } finally {
      conn.stop();
    }
  });

  expect(logs).toHaveLength(2);
  expect(logs[0].message).toContain("disappeared between list and get");
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");

  // The terminal state is sticky: later calls observe the same latch.
  await expect(mc.receive()).rejects.toBeInstanceOf(ConnectionError);
  await expect(mc.send("x")).rejects.toBeInstanceOf(ConnectionError);
});

test("fromEventConnection over FileSyncConnection: an error buffered before the bridge attaches is surfaced", async () => {
  const { client } = makeMockClient();
  const conn = makeConnectedConn(client);
  // Error emitted with no listener attached is buffered by the transport's
  // emit() override; the bridge drains it via takeBufferedError() on start.
  conn.emit("error", new Error("early transport failure"));

  const mc = fromEventConnection(conn);
  const err = await mc.receive().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as ConnectionError).message).toContain("early transport failure");
});

test("fromEventConnection over FileSyncConnection: a send-time transport failure becomes a sticky terminal error", async () => {
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "peer-test";
  // A previous unconsumed message blocks send(); with a short TTL the wait
  // times out and send() rejects, which the bridge latches as terminal. The
  // drain waits for the exact lastSentFile, so point it at the planted name.
  const outName = `${conn.id}-99.json`;
  files.set(`/test/${outName}`, Buffer.from(JSON.stringify({ stale: 1 })));
  (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

  const mc = fromEventConnection(conn);
  const err = await mc.send({ next: true }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");

  await expect(mc.receive()).rejects.toBeInstanceOf(ConnectionError);
});

test("fromEventConnection over FileSyncConnection: close() tears down the transport and rejects later sends", async () => {
  const { client } = makeMockClient();
  let ended = false;
  client.end = async () => {
    ended = true;
  };
  const conn = makeConnectedConn(client);

  const mc = fromEventConnection(conn);
  await mc.close();
  await mc.close(); // idempotent

  expect(ended).toBe(true);
  expect(conn.connected).toBe(false);
  const err = await mc.send("x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("usage");
});
