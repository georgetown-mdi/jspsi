import { expect, test } from "vitest";

import { FileSyncConnection } from "../src/connection/fileSyncConnection";
import type {
  FileTransportClient,
  FileInfo,
} from "../src/connection/fileSyncConnection";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../src/config/connection";
import { UsageError, BilateralModeMismatchError } from "../src/errors";
import { withCapturedLogs } from "../src/testing";

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
    // Reflect the in-memory store so send()/poll(), which now detect files via
    // list() pattern scans, see the same state exists()/get() do. Returns
    // direct children of `dir`, with `size` taken from the buffer length.
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

// Put a connection into the post-open state without running the handshake.
// Calls open() with a fake filedrop config so this.config is populated and
// the drain deadline in close() reads peerTimeoutMs from the config rather
// than falling back to DEFAULT_PEER_TIMEOUT_MS (1 hour).
async function makeConnectedConn(
  client: FileTransportClient,
  opts?: Partial<{
    pollingFrequency: number;
    timeToLiveMs: number;
    peerTimeoutMs: number;
    joinerRecoveryMs: number;
  }>,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
    ...(opts?.joinerRecoveryMs !== undefined
      ? { joinerRecoveryMs: opts.joinerRecoveryMs }
      : {}),
  });
  // Pass peerTimeoutMs via a fake filedrop config so close()'s drain deadline
  // reads from this.config rather than falling back to DEFAULT_PEER_TIMEOUT_MS.
  const fakeConfig: FileDropConnectionConfig = {
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: opts?.peerTimeoutMs ?? 50 },
  };
  await conn.open(fakeConfig);
  return conn;
}

// A valid hello body advertising the default lock/non-retain flags. Tests whose
// rendezvous reader runs in the default (lock) mode hand-plant this as the peer
// hello so it passes the HelloEnvelope read gate without a spurious bilateral
// mismatch. 193901017 made the hello body carry these two required flags, so a
// bare `{}` no longer satisfies the hello schema.
const LOCK_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
);

// --- connection lifecycle (unconnected) --------------------------------------

test("stop and cleanup are safe on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(() => conn.stop()).not.toThrow();
  await expect(conn.cleanup()).resolves.not.toThrow();
});

test("close is idempotent and safe on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await expect(conn.close()).resolves.toBeUndefined();
  await expect(conn.close()).resolves.toBeUndefined();
});

test("close() sweeps responsible files and ends the client, idempotently", async () => {
  const { client, files } = makeMockClient();
  let ended = false;
  client.end = async () => {
    ended = true;
  };
  const deleted: string[] = [];
  const origSafeDelete = client.safeDelete;
  client.safeDelete = async (p: string) => {
    deleted.push(p);
    return origSafeDelete(p);
  };
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";
  // send() records the outbound file as one this side is responsible for.
  await conn.send({ hello: 1 });
  const messagePath = [...files.keys()].find((p) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(messagePath).toBeDefined();

  await conn.close();

  expect(ended).toBe(true);
  expect(deleted).toContain(messagePath);
  expect(files.has(messagePath!)).toBe(false);

  // A second close neither throws nor re-ends the client.
  ended = false;
  await expect(conn.close()).resolves.toBeUndefined();
  expect(ended).toBe(false);
});

test("close() stops a running poller", async () => {
  const { client } = makeMockClient();
  let listCalls = 0;
  const origList = client.list;
  client.list = async (p: string) => {
    listCalls++;
    return origList(p);
  };
  const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
  conn.peerId = "peer-test";
  conn.start();
  await new Promise((r) => setTimeout(r, 25));
  await conn.close();

  const callsAfterClose = listCalls;
  await new Promise((r) => setTimeout(r, 25));
  expect(listCalls).toBe(callsAfterClose);
});

// --- buffered error ----------------------------------------------------------

test("emit('error', ...) with no listener is buffered and returned by takeBufferedError", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const err = new Error("transport failure");
  conn.emit("error", err);
  expect(conn.takeBufferedError()).toBe(err);
  // Second read clears the buffer.
  expect(conn.takeBufferedError()).toBeUndefined();
});

test("emit('error', ...) with an attached listener is delivered and not buffered", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const observed: unknown[] = [];
  conn.on("error", (err) => observed.push(err));
  const err = new Error("transport failure");
  conn.emit("error", err);
  expect(observed).toEqual([err]);
  expect(conn.takeBufferedError()).toBeUndefined();
});

test("only the most recent buffered error is retained", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  conn.emit("error", new Error("first"));
  conn.emit("error", new Error("second"));
  expect((conn.takeBufferedError() as Error).message).toBe("second");
});

test("re-emitting the same buffered error does not create a self-referential cause cycle", () => {
  // Regression guard: when an unhandled error is buffered and then the same
  // Error reference is emitted again, the cause-chain branch must NOT assign
  // `err.cause = err`. A self-cycle would loop any downstream walker.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const err = new Error("repeated");
  conn.emit("error", err);
  conn.emit("error", err);
  expect(conn.takeBufferedError()).toBe(err);
  expect(err.cause).toBeUndefined();
});

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
  const ttl = conn.options.timeToLive!.getTime();
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

test("open preserves constructor timeToLive and stores config peerTimeoutMs when both are supplied", async () => {
  // Constructor timeToLive wins; open() must not recompute it from
  // config.options.peerTimeoutMs. The config is stored as a private field so
  // close() can read peerTimeoutMs from it for a fresh drain deadline.
  const { client } = makeMockClient();
  const constructorTtl = new Date(Date.now() + 9_999_999);
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    timeToLive: constructorTtl,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 30_000 },
  });
  expect(conn.options.timeToLive).toBe(constructorTtl);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBe(30_000);
});

test("open preserves constructor timeToLive and leaves peerTimeoutMs undefined when config has none", async () => {
  // Constructor timeToLive wins; when no config peerTimeoutMs is provided
  // the config's options.peerTimeoutMs stays undefined, so close() falls back
  // to DEFAULT_PEER_TIMEOUT_MS for the drain deadline.
  const { client } = makeMockClient();
  const constructorTtl = new Date(Date.now() + 9_999_999);
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    timeToLive: constructorTtl,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
  });
  expect(conn.options.timeToLive).toBe(constructorTtl);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBeUndefined();
});

test("open derives timeToLive from config peerTimeoutMs when no constructor timeToLive is set", async () => {
  // Existing behavior: no constructor timeToLive, config peerTimeoutMs present
  // -> timeToLive is computed as Date.now() + peerTimeoutMs. The config is
  // stored as a private field so close() can read peerTimeoutMs from it.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 45_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 45_000);
  expect(ttl).toBeLessThanOrEqual(after + 45_000);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBe(45_000);
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
  const ttl = conn.options.timeToLive!.getTime();
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

test("open defers default timeToLive computation until connect resolves", async () => {
  // Regression guard: previously the default 1-hour TTL was computed in the
  // constructor, so retry latency between construction and open() ate into
  // the budget. The TTL must now be set during open() so the full default
  // window is available for peer-waiting.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(conn.options.timeToLive).toBeUndefined();
  const before = Date.now();
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  // Default is 1 hour. Allow a generous lower bound to keep this stable on
  // slow CI: the budget should be near full, not consumed by construction.
  expect(ttl).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 100);
  expect(ttl).toBeLessThanOrEqual(after + 60 * 60 * 1000);
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

test("open normalizes Windows UNC filedrop path", async () => {
  // \\server\share is the canonical UNC form on Windows. After backslash-to-
  // forward conversion it becomes //server/share, which Node's win32 path
  // resolution still recognizes as a UNC path. Verify the leading double
  // slash is preserved (it would be ambiguous with a non-UNC path otherwise)
  // and that trailing-slash stripping does not collapse the prefix.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "\\\\server\\share" });
  expect(conn.path).toBe("//server/share");
});

test("open normalizes Windows UNC filedrop path with trailing backslash", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "\\\\server\\share\\" });
  expect(conn.path).toBe("//server/share");
});

test("open normalizes Windows UNC filedrop path with subdirectory", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "filedrop",
    path: "\\\\server\\share\\exchanges\\drop",
  });
  expect(conn.path).toBe("//server/share/exchanges/drop");
});

// --- Happy path --------------------------------------------------------------

test("send writes the message file to the store", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  // Default (timestampInFilename unset): `<id>-<byteCount>.json`.
  const written = [...files.keys()].filter((p) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(written).toHaveLength(1);
});

test("send encodes the exact serialized byte count in the filename", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  const [written] = [...files.entries()].filter(([p]) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(written).toBeDefined();
  const [path, buf] = written;
  const declared = Number(path.slice(0, -".json".length).split("-").at(-1));
  expect(declared).toBe(buf.length);
});

test("send writes the in-flight file with a .tmp extension and renames to .json", async () => {
  // A sync tool watching `*.json` must never match the partial write, so the
  // temp file carries a `.tmp` extension; only the atomic rename target ends
  // in `.json`.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const putDests: string[] = [];
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    putDests.push(dest);
    return origPut(src, dest, opts);
  };
  const renameTargets: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from, to) => {
    renameTargets.push(to);
    return origRename(from, to);
  };

  await conn.send({ hello: "world" });

  expect(putDests).toHaveLength(1);
  expect(putDests[0].endsWith(".tmp")).toBe(true);
  expect(putDests[0].endsWith(".json")).toBe(false);

  expect(renameTargets).toHaveLength(1);
  expect(renameTargets[0]).toMatch(
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`),
  );
});

test("send removes the .tmp file in-process when the rename fails", async () => {
  // If the rename throws (e.g. transport failure) the catch block must delete
  // the orphaned .tmp file so it is not left behind for the failed exchange.
  // This is a best-effort in-process sweep through the still-live client; it
  // is the only cleanup path for an in-flight write, so the .tmp name is
  // deliberately not tracked in responsibleFiles (see send()).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Capture the temp path the write actually produced so the cleanup
  // assertion cannot pass vacuously: if a refactor stopped writing the temp
  // file, tempPath stays undefined and the "was written" check below fails.
  let tempPath: string | undefined;
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    await origPut(src, dest, opts);
    tempPath = dest;
  };
  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  client.rename = async () => {
    throw new Error("synthetic rename failure");
  };

  await expect(conn.send({ hello: "world" })).rejects.toThrow(
    "synthetic rename failure",
  );

  // The temp file was actually written (a .tmp, not a .json) ...
  expect(tempPath).toBeDefined();
  expect(tempPath!.endsWith(".tmp")).toBe(true);
  // ... the catch swept exactly that file via safeDelete ...
  expect(safeDeleted).toContain(tempPath!);
  // ... and no .tmp residue remains on disk.
  expect(files.has(tempPath!)).toBe(false);
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

// --- Race condition: consecutive sends ---------------------------------------

test("send waits for a previous unconsumed message before writing the next", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Simulate a message from this connection already sitting in the store
  // (e.g. the peer's poller hasn't run yet). The exact byte count is
  // irrelevant; send() detects any `<id>-*.json` it still owns.
  const outPath = `/test/${conn.id}-99.json`;
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
  const conn = await makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";

  // Plant a stale message that nobody will ever delete.
  const outPath = `/test/${conn.id}-99.json`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));

  await expect(conn.send({ next: true })).rejects.toThrow("timed out");
});

// --- TOCTOU race: ENOENT from get() ------------------------------------------

test("poll does not emit error when get() throws ENOENT after list() surfaced the file", async () => {
  // Simulate the TOCTOU window: list() surfaces the peer's message file, but by
  // the time get() runs the peer has already deleted it (their cleanup() raced
  // with our poll()). The poller must swallow ENOENT and reschedule rather than
  // emitting "error" and killing the connection.
  let getCount = 0;
  const peerId = "peer-test";
  let listCount = 0;
  const errors: unknown[] = [];

  // Resolved on list()'s 3rd call, confirming the poller rescheduled at least
  // twice after the ENOENT — without relying on a fixed wall-clock wait.
  let notifyThirdList!: () => void;
  const thirdList = new Promise<void>((r) => {
    notifyThirdList = r;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    // Surface a matching message file once (size matches the declared count so
    // poll() proceeds to get()); empty afterwards.
    client.list = async () => {
      listCount++;
      return listCount === 1
        ? [{ name: `${peerId}-5.json`, modifyTime: 0, size: 5 }]
        : [];
    };
    client.get = async (p) => {
      if (++getCount === 1) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${p}'`),
          { code: "ENOENT" },
        );
      }
      throw new Error("unexpected second get()");
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => errors.push(err));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      const result = await origList(p);
      if (listCount === 3) notifyThirdList();
      return result;
    };
    conn.start();
    await Promise.race([
      thirdList,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for 3rd list() call")),
          2_000,
        ),
      ),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(errors).toHaveLength(0);
  // get() was called exactly once (on the ENOENT-throwing poll cycle).
  expect(getCount).toBe(1);
  // The poller rescheduled and ran additional cycles after the ENOENT.
  expect(listCount).toBeGreaterThan(1);
});

test("poll delivers a subsequent valid message after swallowing an ENOENT", async () => {
  let getCount = 0;
  const peerId = "peer-test";
  const validMessage = Buffer.from(
    JSON.stringify({
      ts: 1,
      seq: 0,
      type: "Object",
      payload: { hello: "world" },
    }),
  );
  const peerName = `${peerId}-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  let listCount = 0;
  const received: unknown[] = [];
  // Resolved when the first message arrives — no fixed wall-clock wait.
  let notifyReceived!: () => void;
  const firstMessage = new Promise<void>((r) => {
    notifyReceived = r;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const originalGet = client.get.bind(client);
    client.list = async () => {
      listCount++;
      // First cycle surfaces a phantom file (get() throws ENOENT); second cycle
      // is empty (resets the consecutive-ENOENT counter); third cycle surfaces a
      // real message whose on-disk size matches its declared byte count.
      if (listCount === 1)
        return [{ name: `${peerId}-1.json`, modifyTime: 0, size: 1 }];
      if (listCount >= 3) {
        if (!files.has(peerPath)) files.set(peerPath, validMessage);
        return [{ name: peerName, modifyTime: 0, size: validMessage.length }];
      }
      return [];
    };
    client.get = async (p: string, opts?: unknown) => {
      if (++getCount === 1)
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${p}'`),
          { code: "ENOENT" },
        );
      return originalGet(p, opts as Parameters<typeof originalGet>[1]);
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("data", (msg) => {
      received.push(msg);
      notifyReceived();
    });
    conn.start();
    await Promise.race([
      firstMessage,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("timed out waiting for first message delivery")),
          2_000,
        ),
      ),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["hello"]).toBe("world");
});

test("poll emits error when ENOENT threshold is reached on consecutive poll cycles", async () => {
  // list() always surfaces a matching file (size matches declared count);
  // get() always throws ENOENT. After 3 consecutive ENOENT cycles the poller
  // must emit an error instead of warning indefinitely.
  const peerId = "peer-test";
  const errors: unknown[] = [];
  // Resolved by the error handler so the test waits only as long as necessary
  // rather than sleeping a fixed amount of wall time.
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  const [, logs] = await withCapturedLogs(async () => {
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
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    // Stop the poller on the first error, mirroring real protocol behavior where
    // the error handler calls doCleanup()/conn.stop().
    conn.on("error", (err) => {
      errors.push(err);
      conn.stop();
      notifyError();
    });
    conn.start();
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("timed out waiting for ENOENT threshold error")),
          2_000,
        ),
      ),
    ]);
  });
  expect(logs).toHaveLength(2);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(errors).toHaveLength(1);
});

test("poll emits error immediately when list() throws ENOENT (not a TOCTOU race)", async () => {
  // reachedGet is false when list() throws, so ENOENT from the detection scan
  // is a hard error that must be emitted immediately — not tolerated as a
  // TOCTOU race.
  const { client } = makeMockClient();
  client.list = async (p) => {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, scandir '${p}'`),
      { code: "ENOENT" },
    );
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  conn.on("error", (err) => {
    errors.push(err);
    conn.stop();
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for exists() ENOENT error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
});

// --- createExclusive() mock semantics ----------------------------------------

test("createExclusive throws EEXIST when destination already exists", async () => {
  const { client, files } = makeMockClient();
  files.set("/existing", Buffer.from("y"));
  await expect(client.createExclusive("/existing")).rejects.toMatchObject({
    code: "EEXIST",
  });
  // destination is unchanged
  expect(files.get("/existing")).toEqual(Buffer.from("y"));
});

test("createExclusive creates an empty entry and does not affect other files", async () => {
  const { client, files } = makeMockClient();
  files.set("/other", Buffer.from("data"));
  await client.createExclusive("/new");
  expect(files.has("/new")).toBe(true);
  expect(files.get("/new")).toEqual(Buffer.alloc(0));
  // unrelated file is untouched
  expect(files.get("/other")).toEqual(Buffer.from("data"));
});

// --- synchronize(): lock-file race cleanup ------------------------------------

test("synchronize() cleans up hello and lock files when createExclusive() throws EEXIST", async () => {
  // Simulates the losing party in the lock-file race: createExclusive() throws
  // because the peer already claimed the lock slot, and all three residue files
  // (-hello.json x2, -lock.json) must be deleted before synchronize() returns.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it,
  // guaranteeing the lock-file name and role assignment are deterministic.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer "arrived first" by name tiebreak.
  // Lock name: peer-mine.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  // Provide a consistent modifyTime: same for both so the name tiebreak decides.
  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer hello body so the two-hellos branch's HelloEnvelope read
  // gate (added by 193901017) passes before reaching createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  // createExclusive() throws EEXIST; also plant the lock file so
  // exists(lockPath) → true, simulating the peer having already claimed it.
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  // All residue files must be gone.
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // Roles are set correctly for the losing party.
  expect(conn.peerId).toBe(peerId);
  // peerId arrived first → this connection is initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
});

test("synchronize() throws when createExclusive throws EEXIST but lock file is already gone (peer abandoned)", async () => {
  // The lock file is only gone after EEXIST if the winner crashed during the
  // narrow window between createExclusive succeeding and responsibleFiles
  // being cleared. Polling for a peer that is not coming would stall until
  // peerTimeoutMs; synchronize() must fail fast and leave the directory clean.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer "arrived first" by name tiebreak.
  // Lock name would be peer-mine.

  // Plant both hello files so the defensive safeDelete calls have something
  // to remove; the directory must be clean after the throw so a retry can
  // run from scratch.
  const basePath = conn.path;
  files.set(`${basePath}/${myHelloName}`, Buffer.alloc(0));
  // Peer hello carries a valid HelloEnvelope so the two-hellos read gate passes
  // before createExclusive (193901017); the own hello is never gate-read.
  files.set(`${basePath}/${peerHelloName}`, LOCK_HELLO_BODY);

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // createExclusive() throws EEXIST but does NOT plant the lock file,
  // simulating the peer having already cleaned it up before exists() runs.
  client.createExclusive = async (path) => {
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "peer appears to have abandoned",
  );

  // The directory must be clean after the throw so a retry can run from
  // scratch. Both hellos were deleted by the inner branch before the throw;
  // the outer catch safeDeletes lockPath and helloPath (no-ops here).
  expect(files.has(`${basePath}/${myHelloName}`)).toBe(false);
  expect(files.has(`${basePath}/${peerHelloName}`)).toBe(false);
});

test("synchronize() rejects and cleans up hello and lock files when createExclusive throws a non-EEXIST error", async () => {
  // Simulates an SFTP close-after-open failure: createExclusive atomically
  // creates the lock file on the server (open succeeds) but then fails to
  // close the handle, rejecting with a non-EEXIST error. The outer catch in
  // synchronize() must safeDelete the lock file and reject.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer arrived first.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer's hello in the mock filesystem so the assertion below is
  // not vacuously true (and so the two-hellos read gate passes). The outer catch
  // is responsible only for this party's files (lockPath and helloPath); it does
  // not touch the peer's hello.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  // Simulate a partial createExclusive: create the file on the mock filesystem
  // (mimicking a successful open) but then reject (mimicking a close failure).
  client.createExclusive = async (path) => {
    files.set(path, Buffer.alloc(0));
    throw Object.assign(new Error("SFTP handle close failed"), { code: "EIO" });
  };

  await expect(conn.synchronize()).rejects.toThrow();

  // The lock file must be cleaned up (outer catch calls safeDelete(lockPath)).
  expect(files.has(lockPath)).toBe(false);
  // The outer catch cleans up only this party's hello (helloPath).
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // The peer's hello is left intact — it is the peer's responsibility and will
  // be swept on the next synchronize() call by whichever party reconnects first.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("synchronize() outer catch clears responsibleFiles so cleanup() makes no redundant safeDeletes", async () => {
  // Verifies that responsibleFiles is cleared in the outer catch block, so a
  // subsequent cleanup() call does not re-attempt safeDelete on files that the
  // outer catch already deleted.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer's hello so the safeDelete count is not skewed by a missing
  // file: if peerHelloName were absent, a safeDelete call for it would still
  // succeed (no-op on missing), so the count would be the same either way, but
  // the test is clearer when files match what list() claims exists. A valid
  // HelloEnvelope body also lets the two-hellos read gate pass.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  client.createExclusive = async (path) => {
    files.set(path, Buffer.alloc(0));
    throw Object.assign(new Error("SFTP handle close failed"), { code: "EIO" });
  };

  let safeDeleteCount = 0;
  const originalSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (path) => {
    safeDeleteCount++;
    return originalSafeDelete(path);
  };

  await expect(conn.synchronize()).rejects.toThrow();

  // The outer catch deletes lockPath and helloPath (my hello): 2 safeDeletes.
  // The peer's hello is left intact — it is the peer's responsibility, not this
  // party's — so no safeDelete is issued for it.
  const countAfterSync = safeDeleteCount;
  expect(countAfterSync).toBe(2);

  // responsibleFiles was cleared by the outer catch: cleanup() must not call
  // safeDelete again. Without the clear, cleanup() would re-attempt safeDelete
  // on lockName and myHelloName (both already deleted), adding 2 more calls.
  await conn.cleanup();
  expect(safeDeleteCount).toBe(countAfterSync);

  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

test("synchronize() resolves cleanly when it observes a lock file already created by the peer", async () => {
  // Regression guard: the lock-detection branch
  // (waitForPeer's "lockFiles.length > 0" arm) used to compare bare UUIDs
  // from the lock filename against -hello.json entries, which never matched,
  // so any party that observed a peer-created lock file threw
  // "lock file does not reference this connection" instead of completing
  // the rendezvous.
  //
  // Scenario reproduced here: peer arrived first, both wrote -hello.json,
  // peer won the lock race and created `${peerId}-${myId}-lock.json`. This party
  // observes peer-hello.json + my-hello.json + lock file on its next list().
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // Peer arrived first (sorted lower) so the lock name is `${peer}-${my}`.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  // Plant the three files so safeDelete calls have something to remove.
  // Peer hello must be valid JSON so the I5 read gate does not retry to timeout.
  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // Initial check (sees only our own newly-written hello mid-flow).
    // Subsequent listings expose the peer hello and the peer-created lock.
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  // Peer arrived first so this party is the initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
  // The lock-detection branch must label roles with the same convention as
  // the other rendezvous branches: responder=starter, initiator=joiner.
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  // All three files cleaned up by the lock-detection branch.
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

// --- synchronize(): lock-detection with arbitrary-string ids -----------------

test("synchronize() lock-detection branch completes rendezvous with arbitrary string ids", async () => {
  // Acceptance criterion: a two-party unit test with arbitrary string ids
  // (not UUIDs) completes the lock handshake and assigns roles deterministically.
  //
  // "Agency A-hello.json" < "Agency B-hello.json" lexicographically, so
  // "Agency A" arrived first. The lock producer (the winner of the lock race,
  // which is unmodelled here -- we plant the lock directly) creates
  // "Agency A-Agency B-lock.json". This connection is "Agency B" and observes both
  // hellos plus the peer-created lock, triggering the lock-detection branch.
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // Peer arrived first (sorts lower) so the lock name is `${peerId}-${myId}`.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  // Peer arrived first => this connection is initiator/joiner.
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

test("synchronize() lock-detection branch uses filename order (I7), not id order, for prefix-related ids", async () => {
  // Acceptance criterion: with prefix-related ids where filename order and raw
  // id-compare diverge, roles are derived from filename order (I7) and the
  // lock-detection branch does NOT throw.
  //
  // "Agency A-hello.json" < "Agency-hello.json" because space (U+0020) sorts
  // before "-" (U+002D). So "Agency A" arrived first by filename order.
  // A raw `"Agency" < "Agency A"` id-compare would say "Agency" arrived first,
  // producing the wrong expected lock name and a false rejection. Filename order
  // is the source of truth (I7) and must win.
  const myId = "Agency";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // "Agency A-hello.json" < "Agency-hello.json" => peer arrived first.
  // Lock name is `${peerId}-${myId}-lock.json`, matching what the producer wrote.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  // Must not throw "lock does not reference this connection".
  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  expect(files.has(lockPath)).toBe(false);
});

test("synchronize() lock-detection branch rejects a stale lock from a different id-pair", async () => {
  // Acceptance criterion: a stale -lock.json from a different id-pair, present
  // alongside the current pair's hellos, fails the pair-validation check.
  //
  // The current pair is "Agency B" + "Agency A". A stale lock file
  // "StaleX-StaleY-lock.json" from a prior session of a different pair is present.
  // Reconstruct-and-compare produces "Agency A-Agency B-lock.json" (peer arrived
  // first by filename order), which does not match the stale name.
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const staleLockName = "StaleX-StaleY-lock.json";
  const staleLockPath = `${conn.path}/${staleLockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  files.set(staleLockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: staleLockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "lock file does not reference this connection",
  );
});

// --- synchronize(): createExclusive winner retains responsibleFiles --------

test("synchronize() createExclusive winner: leaves own hello and lock name in responsibleFiles so cleanup() can sweep them if peer never arrives", async () => {
  // Regression guard: previously, the outer try block in synchronize() cleared
  // responsibleFiles on every successful waitForPeer() return — including the
  // createExclusive-winner path, which is the one path that legitimately needs
  // to retain its files. The loser (whose createExclusive throws EEXIST) is
  // normally responsible for cleaning the lock and both hellos, but if the
  // loser never arrives (crash, partition), the winner's eventual cleanup()
  // must sweep them. With the clear, the winner's responsibleFiles was empty
  // and the files were stranded.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId so the peer "arrived first" by name tiebreak; lock name
  // is `${peerId}-${myId}-lock.json` and is created by THIS connection.
  const lockName = `${peerId}-${myId}-lock.json`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };
  // Peer hello body so the two-hellos read gate passes before createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  // Default mock createExclusive succeeds (no EEXIST) — this conn is the
  // lock-race winner.

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Winner retains its own hello AND the lock name; cleanup() can sweep
  // them later if the loser never arrives.
  const responsible = (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
  expect(responsible.has(myHelloName)).toBe(true);
  expect(responsible.has(lockName)).toBe(true);
});

test("synchronize() two-hellos branch: tiebreaker uses UUID order only, ignoring divergent modifyTimes", async () => {
  // Across heterogeneous transports the two parties can observe different --
  // even contradictory -- modifyTimes for the same hello files, because sync
  // tools stamp the transfer time rather than the original creation time. Here
  // each side sees ITS OWN hello as the earlier file, the worst case for a
  // modifyTime tiebreaker: it would make both parties believe they arrived
  // first, both claim the starter role, and derive two different lock names --
  // a deadlock. The UUID-only tiebreaker must instead assign the starter role
  // to the lexicographically-smaller UUID on both sides regardless of
  // modifyTime, so the parties agree on roles and on a single lock name.
  const idLow = "00000000-0000-4000-8000-000000000001";
  const idHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";

  // Run one side's synchronize() against a listing in which this side's own
  // hello is the earlier (smaller modifyTime) file. Returns the assigned roles
  // plus the lock name the side derived (captured from createExclusive).
  const runSide = async (
    myId: string,
    peerId: string,
  ): Promise<{
    role: string;
    handshakeRole: string | undefined;
    lockName: string;
  }> => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.id = myId;
    const base = conn.path ?? "";
    const myHelloName = `${myId}-hello.json`;
    const peerHelloName = `${peerId}-hello.json`;

    let listCallCount = 0;
    client.list = async () => {
      listCallCount++;
      if (listCallCount === 1) return []; // initial check: directory is clean
      // This side's own hello carries the EARLIER timestamp; under a
      // modifyTime tiebreaker that would mark this side as "arrived first".
      return [
        { name: myHelloName, modifyTime: 1000, size: 0 },
        { name: peerHelloName, modifyTime: 5000, size: 0 },
      ];
    };
    // Peer hello body so the two-hellos read gate passes before createExclusive.
    files.set(`${base}/${peerHelloName}`, LOCK_HELLO_BODY);

    let lockName = "";
    const realCreateExclusive = client.createExclusive.bind(client);
    client.createExclusive = async (path: string) => {
      lockName = path.slice(base.length + 1);
      return realCreateExclusive(path);
    };

    await conn.synchronize();
    return { role: conn.role, handshakeRole: conn.handshakeRole, lockName };
  };

  const low = await runSide(idLow, idHigh);
  const high = await runSide(idHigh, idLow);

  // The smaller UUID is the starter on both sides; modifyTime is ignored even
  // though it pointed the other way for the high-UUID side.
  expect(low.handshakeRole).toBe("responder");
  expect(low.role).toBe("starter");
  expect(high.handshakeRole).toBe("initiator");
  expect(high.role).toBe("joiner");

  // Both sides independently derive the SAME lock name, `${low}-${high}-lock.json`,
  // which is what lets the loser locate and clean up the winner's lock file.
  expect(low.lockName).toBe(`${idLow}-${idHigh}-lock.json`);
  expect(high.lockName).toBe(`${idLow}-${idHigh}-lock.json`);
});

// --- synchronize(): joiner branch (initial list shows one peer hello) -------

test("synchronize() joiner branch: assigns initiator role and writes own hello after deleting peer's", async () => {
  // Initial list returns one peer .hello, triggering the joiner branch
  // (this party arrived second on a previously-empty directory).
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Peer's hello was deleted; our own hello was written via the sentinel
  // rename, and no `<id>-joining.json` sentinel is left behind (it became the
  // hello).
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-joining.json`)).toBe(false);
});

// --- synchronize(): joiner partial-failure (sentinel) ------------------------

// Helper: stand up a joiner whose initial list shows exactly one peer hello,
// so synchronize() takes the lock-path joiner branch (this party arrived
// second). Returns the live store and the planted peer-hello name.
async function makeJoiner(joinerRecoveryMs?: number): Promise<{
  conn: FileSyncConnection;
  client: FileTransportClient;
  files: Map<string, Buffer>;
  peerId: string;
  peerHelloName: string;
}> {
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];
  return { conn, client, files, peerId, peerHelloName };
}

// Reads the private responsibleFiles set for assertions.
function responsibleFilesOf(conn: FileSyncConnection): Set<string> {
  return (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
}

test("synchronize() joiner branch: a sentinel put failure leaves the peer hello intact and the connection unsynchronized", async () => {
  // First failure point: the joiner cannot even write its `<id>-joining.json`
  // sentinel. Because the sentinel is written BEFORE the peer hello is deleted,
  // a failure here cannot strand the peer -- its hello is untouched and no
  // sentinel is committed, so the directory is exactly as the joiner found it.
  const { conn, client, files, peerHelloName } = await makeJoiner();
  client.put = async () => {
    throw new Error("synthetic sentinel put failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic sentinel put failure",
  );

  // Peer hello untouched; nothing the joiner owns is left behind.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-joining.json`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(false);
  // Pre-synchronize state, so a retry on this instance is not blocked by the
  // "already synchronized" guard.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

test("synchronize() joiner branch: a failure before the peer hello is deleted tracks the sentinel for cleanup()", async () => {
  // Second failure point, still BEFORE the peer hello is deleted: the sentinel
  // was written but delete(peer hello) throws. The peer hello is intact, so the
  // sentinel is the joiner's own residue -- it stays in responsibleFiles and
  // cleanup() sweeps it (taxonomy: joining is in responsibleFiles, swept by
  // cleanup(), until the peer hello is deleted).
  const { conn, client, files, peerHelloName } = await makeJoiner();
  const joiningName = `${conn.id}-joining.json`;
  client.delete = async () => {
    throw new Error("synthetic peer-hello delete failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic peer-hello delete failure",
  );

  // Sentinel was committed and the peer hello is intact (delete never ran).
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
  // The joiner still owns the sentinel: it is tracked and cleanup() removes it.
  expect(responsibleFilesOf(conn).has(joiningName)).toBe(true);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(false);
});

test("synchronize() joiner branch: a failure after the peer hello is deleted leaves the sentinel as the peer's recovery signal", async () => {
  // Critical failure point: the joiner deleted the peer hello, then the rename
  // of the sentinel to its hello throws. The peer hello is gone, so the sentinel
  // MUST persist as the peer's recovery signal -- it is released from
  // responsibleFiles so a failure-path cleanup() does not sweep it. This is the
  // exact partial-failure window the fix closes: the peer sees the sentinel and
  // recovers within a bounded window instead of polling to the peer timeout.
  const { conn, client, files, peerHelloName } = await makeJoiner();
  const joiningName = `${conn.id}-joining.json`;
  client.rename = async () => {
    throw new Error("synthetic sentinel rename failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic sentinel rename failure",
  );

  // Peer hello deleted, sentinel still on disk and NOT renamed to a hello.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(false);
  // Released from responsibleFiles, so the failure-path cleanup() leaves the
  // sentinel in place for the peer to recover from (and for the next run's
  // Phase 0 guard to reject if this process dies).
  expect(responsibleFilesOf(conn).has(joiningName)).toBe(false);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  // Pre-synchronize state regardless of where the joiner failed.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

// --- synchronize(): lock starter peer-side joiner recovery -------------------

test("synchronize() lock starter: completes rendezvous when a mid-arrival joiner recovers", async () => {
  // The peer (arrived first, lock starter) sees the joiner's sentinel for a few
  // polls -- the joiner is mid-arrival, having deleted our hello but not yet
  // renamed its sentinel to its hello -- then the rename lands and the joiner
  // appears as a normal peer hello. The starter must wait through the sentinel
  // and complete, not abort or stall.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  const peerHelloName = `${idB}-hello.json`;
  // The joiner's hello body must be readable through the gate once the rename
  // makes it appear under its final name.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // First list (preexisting guard) sees an empty directory, so this party
    // becomes the lock starter and writes its hello.
    if (listCallCount === 1) return [];
    // Joiner mid-arrival: only the sentinel is visible (our hello is gone).
    if (listCallCount <= 3)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    // Joiner recovered: the rename landed, so the sentinel is now its hello.
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();

  // Arrived first => starter/responder; peer id recovered from the hello name.
  expect(conn.role).toBe("starter");
  expect(conn.handshakeRole).toBe("responder");
  expect(conn.peerId).toBe(idB);
  // The starter branch consumed (deleted) the joiner's hello.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
});

test("synchronize() lock starter: aborts with a distinct transport error within a bounded window when a joiner never completes", async () => {
  // The critical case the fix closes. A joiner deleted our hello and then died
  // before renaming its sentinel to its hello, so the sentinel persists. The
  // peer must surface a distinct, terminal error and abort on the bounded
  // recovery window -- NOT poll silently to the full peerTimeoutMs, and NOT a
  // usage error (this is a transport failure, CLI exit 69).
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // Empty at entry (this party becomes the starter and writes its hello),
    // then the stuck sentinel forever: our hello gone, the rename never lands.
    if (listCallCount === 1) return [];
    return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
  };

  const start = Date.now();
  const err = await conn.synchronize().catch((e: unknown) => e);
  const elapsed = Date.now() - start;

  expect(err).toBeInstanceOf(Error);
  // Distinct, actionable message -- not the generic "synchronization has timed
  // out" the full peerTimeoutMs path produces.
  expect((err as Error).message).toMatch(
    /did not complete within the recovery window/,
  );
  // Describes the mid-arrival failure without pinning it to a single step (the
  // crash can be on either side of the joiner's delete).
  expect((err as Error).message).toMatch(
    /failed after announcing its arrival but before publishing its hello/,
  );
  // Tagged with the waiting party's actual role rather than the uninitialized
  // "unknown role" sentinel value.
  expect((err as Error).message).toMatch(/^\[starter\]/);
  // Transport failure (CLI exit 69), not a usage error (exit 64).
  expect(err).not.toBeInstanceOf(UsageError);
  // Bounded by the recovery window, far below the 5 s TTL.
  expect(elapsed).toBeLessThan(2_000);
  // The peer never owned the sentinel, so its outer-catch sweep leaves it on
  // disk for the next run's Phase 0 guard rather than masking the crash.
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  // Instance is reset, not wedged: a retry is not blocked.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

test("synchronize() lock starter: aborts on a stuck sentinel even while its own hello is still present (state a)", async () => {
  // State (a) of the joiner's sequence: it has written its sentinel (put) but
  // not yet deleted this party's hello, so the starter's own hello and the
  // sentinel are visible together (otherFiles === 0, theseFiles === 1,
  // joiningFiles === 1). The recovery branch is gated only on the sentinel, not
  // on whether our hello is gone, so the bounded-window abort must still fire
  // here -- and the message must NOT claim the joiner already deleted our hello,
  // because it may have crashed before that step. This pins finding 1's premise
  // (the recovery branch is reachable before the delete) and its reworded text.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myHello = `${conn.id}-hello.json`;
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Our own hello is still present (the joiner has not deleted it yet) and the
    // joiner's sentinel sits beside it, never resolving to a hello.
    return [
      { name: myHello, modifyTime: Date.now(), size: 0 },
      { name: joiningName, modifyTime: Date.now(), size: 0 },
    ];
  };

  const start = Date.now();
  const err = await conn.synchronize().catch((e: unknown) => e);
  const elapsed = Date.now() - start;

  expect(err).toBeInstanceOf(Error);
  // Transport failure (exit 69), not a usage error.
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(
    /did not complete within the recovery window/,
  );
  // Crucially: does NOT assert the delete already happened, since in state (a)
  // it has not. The reworded message brackets both sub-windows.
  expect((err as Error).message).toMatch(
    /failed after announcing its arrival but before publishing its hello/,
  );
  expect((err as Error).message).toMatch(/^\[starter\]/);
  // Bounded by the recovery window, far below the 5 s TTL.
  expect(elapsed).toBeLessThan(2_000);
});

test("synchronize() lock starter: a sentinel visible when the TTL expires yields the stuck-joiner error, not a bare timeout", async () => {
  // The recovery window (joinerRecoveryMs) is independent of the outer TTL
  // (peerTimeoutMs). If a sentinel first appears with less than joinerRecoveryMs
  // left on the TTL, the poll loop exits before the recovery check can fire.
  // Here joinerRecoveryMs (10 s) far exceeds the TTL (150 ms), so the recovery
  // check never fires and the loop exits via the TTL while the sentinel is still
  // tracked. The fallback must still surface the actionable stuck-joiner cause,
  // not the generic "synchronization has timed out".
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 10_000,
    timeToLiveMs: 150,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  // Names the stuck sentinel and the mid-arrival failure like the bounded-window
  // abort, but via the TTL fallback ("the exchange timed out before it
  // completed" rather than "within the recovery window").
  expect((err as Error).message).toMatch(/^\[starter\] peer began arriving/);
  expect((err as Error).message).toContain(joiningName);
  expect((err as Error).message).toMatch(
    /the exchange timed out before it completed/,
  );
  // NOT the generic bare timeout the pre-fix path produced.
  expect((err as Error).message).not.toMatch(/synchronization has timed out/);
});

test("synchronize() lock starter: a sentinel that vanishes and reappears gets a fresh recovery window", async () => {
  // The empty-poll reset of joiningSeenAt/joiningSeenName times a reappearing
  // sentinel from its REappearance, not its first sighting. Without the reset,
  // the reappearing sentinel would inherit the now-elapsed timestamp and abort
  // immediately. The gap of empty polls advances real time past the 50 ms
  // window, so the regression is observable: with the reset the rendezvous
  // completes; without it, it would reject on reappearance.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 50,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  const peerHelloName = `${idB}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Sentinel appears once (poll 2), vanishes for several polls (long enough
    // that a stale timestamp would be past the 50 ms window), then returns.
    if (listCallCount === 2)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    if (listCallCount <= 9) return []; // vanished -> joiningSeenAt reset
    if (listCallCount === 10)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    // The fresh-windowed joiner then completes its rename.
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  // With the reset this completes; without it, it would reject on reappearance.
  await conn.synchronize();
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idB);
});

test("synchronize() lock starter: a different-id sentinel replacing an earlier one completes with the second joiner", async () => {
  // The joiningSeenName !== joiningName arm restarts the recovery window when a
  // sentinel from a different id replaces an earlier one (a second joiner taking
  // over). This pins the functional outcome: the starter completes against
  // whichever joiner ultimately publishes its hello, even after seeing a
  // different sentinel first. (The sub-poll timing of the restart is covered by
  // reasoning, not asserted: A directly replaced by B has no empty poll between,
  // so the restart's effect is a single poll interval, below real-timer
  // resolution.) joinerRecoveryMs is large so no abort fires during the swap.
  const idB = "00000000-0000-4000-8000-000000000001";
  const idC = "00000000-0000-4000-8000-000000000002";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 10_000,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sentinelB = `${idB}-joining.json`;
  const sentinelC = `${idC}-joining.json`;
  const helloC = `${idC}-hello.json`;
  files.set(`${conn.path}/${helloC}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    if (listCallCount === 2)
      return [{ name: sentinelB, modifyTime: Date.now(), size: 0 }];
    if (listCallCount <= 4)
      return [{ name: sentinelC, modifyTime: Date.now(), size: 0 }];
    // The second joiner (idC) completes its rename.
    return [{ name: helloC, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idC);
});

test("synchronize() lock starter: TTL expiry with no joiner produces the bare [starter] timeout", async () => {
  // The lock-path TTL fallback when no peer hello and no sentinel were ever
  // seen: the lone starter polled until the TTL. Pins the exact "[starter]
  // synchronization has timed out" text (a regression swapping or stripping the
  // tag would be caught) and that this is a transport failure, not a usage
  // error. With Issue-1's fix the bare timeout is reached only when no sentinel
  // was tracked at exit, so this complements the stuck-joiner-at-TTL test above.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 80,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  client.list = async () => []; // empty forever: no peer, no sentinel

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toBe(
    "[starter] synchronization has timed out",
  );
});

test("synchronize() lock starter: a peer hello alongside a foreign-id joining sentinel is a UsageError", async () => {
  // Three-party contamination: a legitimate peer hello (idB) and a joining
  // sentinel from a different id (idC) are visible together. A sentinel whose
  // id matches no peer hello cannot be the peer we are completing against, so
  // it is rejected as a usage error (exit 64) -- like a second peer hello or
  // lock -- rather than silently ignored.
  const idB = "00000000-0000-4000-8000-000000000001";
  const idC = "00000000-0000-4000-8000-000000000002";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${idB}-hello.json`;
  const foreignSentinel = `${idC}-joining.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(`${conn.path}/${foreignSentinel}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    return [
      { name: peerHelloName, modifyTime: Date.now(), size: 0 },
      { name: foreignSentinel, modifyTime: Date.now(), size: 0 },
    ];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(foreignSentinel);
  expect((err as Error).message).toMatch(/matches no peer hello/);
});

test("synchronize() lock starter: a peer hello alongside the peer's own same-id sentinel completes (transient rename tolerated)", async () => {
  // On a sync-mediated transport the joiner's rename can momentarily expose
  // both `<idB>-joining.json` and `<idB>-hello.json`. That same-id sentinel is
  // the peer we are completing against, not contamination, so the starter must
  // tolerate it and finish the rendezvous rather than throw a foreign-sentinel
  // usage error.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${idB}-hello.json`;
  const sameSentinel = `${idB}-joining.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(`${conn.path}/${sameSentinel}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Both names visible together: the joiner's rename is mid-propagation.
    return [
      { name: peerHelloName, modifyTime: Date.now(), size: 0 },
      { name: sameSentinel, modifyTime: Date.now(), size: 0 },
    ];
  };

  await conn.synchronize();

  // Rendezvous completes against the peer despite the lingering same-id
  // sentinel; the starter consumed the peer hello.
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idB);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
});

test("synchronize() preexisting-file guard rejects a leftover joining sentinel at startup", async () => {
  // A `<id>-joining.json` left by a crashed prior session is rejected by the
  // strict-empty entry rule (I0) exactly like any other non-peer-hello file --
  // the sentinel needs no per-type screening (it is "anything else"). This is a
  // usage error (CLI exit 64), and the guard does not delete the stale file.
  const staleId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const staleName = `${staleId}-joining.json`;
  files.set(`${conn.path}/${staleName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: staleName, modifyTime: Date.now(), size: 0 },
  ];

  const err = await conn.synchronize().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(staleName);
  expect((err as Error).message).toContain("joining sentinel");
  // Not swept by the guard: the operator clears the directory after confirming
  // no live session is using it.
  expect(files.has(`${conn.path}/${staleName}`)).toBe(true);
});

test("ENOENT counter resets after a clean poll cycle, allowing a fresh set of retries", async () => {
  // Two ENOENTs (below threshold of 3), then exists() returns false (counter
  // resets), then two more ENOENTs. Four total ENOENTs — but split across two
  // groups — must never reach the threshold and must not emit an error.
  const peerId = "peer-test";
  let listCallCount = 0;
  let getCount = 0;
  const errors: unknown[] = [];

  let resolveDone!: () => void;
  // Resolves once list() is called a 6th time, confirming all 5 expected poll
  // cycles (including both ENOENT groups and the reset cycle) are done.
  const cyclesDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    const match = [{ name: `${peerId}-5.json`, modifyTime: 0, size: 5 }];
    client.list = async () => {
      listCallCount++;
      // Cycles 1-2: match -> ENOENT on get (count reaches 2, below threshold 3)
      // Cycle 3: empty -> clean poll, counter resets to 0
      // Cycles 4-5: match -> ENOENT on get (count reaches 2 again, still below 3)
      if (listCallCount === 6) resolveDone();
      return listCallCount === 1 ||
        listCallCount === 2 ||
        listCallCount === 4 ||
        listCallCount === 5
        ? match
        : [];
    };
    client.get = async (p) => {
      getCount++;
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => errors.push(err));
    conn.start();
    // Wait until the 6th exists() call confirms all 5 cycles completed;
    // fall back to a 2 s safety timeout so the test never hangs.
    await Promise.race([
      cyclesDone,
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(4);
  expect(logs[0].message).toContain("disappeared between list and get");

  // 4 ENOENTs were thrown (get() called 4 times), but no single run of 3
  // consecutive ENOENTs occurred, so no error should be emitted.
  expect(getCount).toBe(4);
  expect(errors).toHaveLength(0);
});

// --- message filename format -------------------------------------------------

// Drives a poller until `signal` resolves or a safety timeout fires, then
// stops it. Keeps the message-format tests free of repeated race scaffolding.
async function runPoller(
  conn: FileSyncConnection,
  signal: Promise<void>,
): Promise<void> {
  conn.start();
  await Promise.race([signal, new Promise<void>((r) => setTimeout(r, 2_000))]);
  conn.stop();
}

test("send filename is <id>-<byteCount>.json when timestampInFilename is unset", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  const names = [...files.keys()].map((p) => p.slice("/test/".length));
  expect(names).toHaveLength(1);
  // Exactly two segments around the id: `<uuid>-<digits>.json`, no timestamp
  // or counter inserted.
  expect(names[0]).toMatch(new RegExp(`^${conn.id}-\\d+\\.json$`));
});

test("send filename encodes timestamp and zero-padded counter when timestampInFilename is true", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    timestampInFilename: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = "stub-peer";

  await conn.send({ first: true });
  const firstName = [...files.keys()][0].slice("/test/".length);
  // <id>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>.json; counter starts at 000.
  expect(firstName).toMatch(
    new RegExp(`^${conn.id}-\\d{8}T\\d{6}-000-\\d+\\.json$`),
  );
  // The last segment is the exact serialized byte count.
  const firstBuf = files.get(`/test/${firstName}`)!;
  expect(Number(firstName.slice(0, -".json".length).split("-").at(-1))).toBe(
    firstBuf.length,
  );

  // Simulate the peer consuming the first message, then send again: the
  // per-session counter advances to 001.
  files.clear();
  await conn.send({ second: true });
  const secondName = [...files.keys()][0].slice("/test/".length);
  expect(secondName).toMatch(
    new RegExp(`^${conn.id}-\\d{8}T\\d{6}-001-\\d+\\.json$`),
  );
});

test("poll waits while the file is partially synced and reads it once the size matches", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-partial";
  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { value: 42 } }),
  );
  const name = `${peerId}-${message.length}.json`;
  const fullPath = `/test/${name}`;

  let listCount = 0;
  client.list = async () => {
    listCount++;
    // First two cycles: the file is present but not fully synced. It reports a
    // smaller size and is deliberately absent from the store, so any premature
    // get() would throw "not found" and surface as an error below.
    if (listCount <= 2)
      return [{ name, modifyTime: 0, size: message.length - 5 }];
    files.set(fullPath, message);
    return [{ name, modifyTime: 0, size: message.length }];
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["value"]).toBe(42);
  // The reader did not act on either partial-sync cycle.
  expect(listCount).toBeGreaterThanOrEqual(3);
});

test("poll ignores message files belonging to a different peer", async () => {
  const { client } = makeMockClient();
  const peerId = "peer-a";

  let listCount = 0;
  let notifyEnough!: () => void;
  const enoughCycles = new Promise<void>((r) => (notifyEnough = r));
  // Only a different peer's message file is present; it pattern-matches
  // `*-<count>.json` but not our peer-scoped `<peerId>-` prefix.
  client.list = async () => {
    listCount++;
    if (listCount >= 4) notifyEnough();
    return [{ name: "peer-b-7.json", modifyTime: 0, size: 7 }];
  };
  let getCalled = false;
  client.get = async () => {
    getCalled = true;
    return Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, enoughCycles);

  expect(getCalled).toBe(false);
  expect(received).toHaveLength(0);
  expect(errors).toHaveLength(0);
});

test("poll extracts the byte count from the last segment when the filename has many segments", async () => {
  const { client, files } = makeMockClient();
  // A peer id containing hyphens plus an inserted timestamp and counter: the
  // right-anchored parse must still read the byte count from the final segment.
  const peerId = "00000000-0000-4000-8000-000000000abc";
  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 7, type: "Object", payload: { ok: true } }),
  );
  const name = `${peerId}-20260529T142301-007-${message.length}.json`;
  files.set(`/test/${name}`, message);

  client.list = async () => [{ name, modifyTime: 0, size: message.length }];

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
});

test("poll ignores a prefix-matching file whose final segment is not a byte count", async () => {
  // A leftover or foreign file sharing the peer's id prefix but not encoding a
  // byte count (e.g. `<peerId>-backup.json`) must be ignored, not treated as a
  // fatal protocol error: the exact-name lookup it replaced never matched such
  // a file. The real message alongside it is still delivered.
  const { client, files } = makeMockClient();
  const peerId = "peer-leftover";
  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { ok: true } }),
  );
  files.set(`/test/${peerId}-${message.length}.json`, message);
  files.set(`/test/${peerId}-backup.json`, Buffer.from("not a message"));

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
  // The non-message file is left untouched, not deleted or read.
  expect(files.has(`/test/${peerId}-backup.json`)).toBe(true);
});

// --- drain-before-cleanup (terminal-frame race regression) -------------------

test("close() drains the last sent file before cleanup, preventing premature deletion of the terminal frame", async () => {
  // Regression guard for the file-sync terminal-frame race: the sender's
  // close() must not call safeDelete on the last sent file until the peer has
  // consumed it (i.e. the file has disappeared from the directory listing).
  // Without the drain, cleanup() runs immediately after stop(), deleting the
  // file before a slow receiver's next poll.

  const { client, files } = makeMockClient();

  let receiverConsumed = false;
  let deletedBeforeConsumed = false;

  const sender = await makeConnectedConn(client, {
    pollingFrequency: 5,
    peerTimeoutMs: 500,
  });
  sender.peerId = "stub-peer";

  // Intercept safeDelete to record whether cleanup races the receiver.
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (path: string) => {
    if (!receiverConsumed && /\/[^/]+-\d+\.json$/.test(path)) {
      deletedBeforeConsumed = true;
    }
    return origSafeDelete(path);
  };

  await sender.send({ terminal: true });

  // Identify the written message file.
  const msgPath = [...files.keys()].find((p) =>
    new RegExp(`^/test/${sender.id}-\\d+\\.json$`).test(p),
  );
  expect(msgPath).toBeDefined();

  // Kick off close() - the drain holds cleanup until the file disappears.
  const closePromise = sender.close();

  // Let the drain poll at least once (pollingFrequency = 5 ms) before the
  // "receiver" consumes the file.
  await new Promise((r) => setTimeout(r, 20));

  // Simulate receiver consuming the terminal frame.
  receiverConsumed = true;
  files.delete(msgPath!);

  await closePromise;

  expect(deletedBeforeConsumed).toBe(false);
});

// --- synchronize(): unconditional hello rename --------------------------------

test("synchronize() lock path writes hello as <id>-hello.json and self-hello detection still works", async () => {
  // Regression guard: the unconditional hello rename must not break the
  // self-hello filter inside waitForPeer (the pair of checks that prevents a
  // party from treating its own hello as the peer's).
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };
  // Peer hello body so the two-hellos read gate passes before createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  await conn.synchronize();

  // The lock-race winner (this conn: lock created by createExclusive)
  // committed peerId correctly from the -hello.json filename.
  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("initiator");
  // Our hello is named with the new convention and was written to the store.
  const helloInStore = [...files.keys()].find((p) =>
    p.endsWith(`/${myHelloName}`),
  );
  expect(helloInStore).toBeDefined();
});

// --- synchronize(): lockless mode ---------------------------------------------

test("synchronize() lockless mode completes rendezvous when createExclusive and delete both throw", async () => {
  // Robustness proof: the ack-handshake barrier must complete rendezvous even
  // when createExclusive and delete both throw. This is the most extreme
  // constraint possible and is here to prove the protocol is sound under it.
  // Real lockless deployments target sync-mediated transports where
  // createExclusive lacks atomicity or deletion has high propagation latency
  // -- delete itself works, just asynchronously. Cleanup therefore succeeds
  // eventually on real transports; the pure no-op safeDelete here is not
  // representative of a real storage backend.
  const idA = "00000000-0000-4000-8000-000000000001"; // sorts lower
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff"; // sorts higher

  const sharedFiles = new Map<string, Buffer>();

  const makeThrowingClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async () => {
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {
      // Swallow silently: transport cannot delete.
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported on this transport");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeThrowingClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeThrowingClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Both parties must be synchronized.
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
});

test("synchronize() lockless mode role assignment matches the lexicographic rule for the same id pair as the lock path", async () => {
  // Role must be determined by lexicographic id order regardless of arrival
  // timing. The throwing delete/createExclusive is robustness scaffolding
  // (see the previous test); real lockless transports support delete.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async () => {
      throw new Error("delete not supported");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // idA < idB: A arrived "first" by lexicographic order.
  expect(connA.handshakeRole).toBe("responder");
  expect(connA.role).toBe("starter");
  expect(connB.handshakeRole).toBe("initiator");
  expect(connB.role).toBe("joiner");
});

test("synchronize() lockless mode joiner fast-path is skipped; lockless barrier is entered even with peer hello already present", async () => {
  // The throwing delete proves the joiner fast-path (which calls delete) is
  // not taken in lockless mode. The no-op safeDelete is robustness scaffolding
  // only; real lockless transports support delete (see the first lockless test).
  //
  // When locklessRendezvous is set and a party's entry list() (or barrier loop)
  // finds the peer's hello, it must NOT take the joiner shortcut (which would
  // call delete(peer hello), unsupported on a lockless transport). It must
  // write its own hello and enter the lockless ack-handshake barrier instead.
  //
  // Both parties start against an empty directory and run concurrently: each
  // writes its own hello during its own synchronize() and the slower-to-list
  // party sees the peer hello already present, exercising the "peer hello
  // already present" path. A's hello is deliberately NOT pre-planted -- a
  // party's own hello never predates its own synchronize() (it would be a
  // self-hello and rejected by the entry precondition).
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  let deleteCalled = false;
  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async () => {
      deleteCalled = true;
      throw new Error("delete not supported");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  // Run A and B concurrently against the empty directory: each writes its own
  // hello and enters the lockless barrier, and the slower-to-list party sees
  // the peer hello already present.
  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Neither party should have called delete (unsupported on lockless transport).
  expect(deleteCalled).toBe(false);
  // Both are synchronized.
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // Lockless never deletes a hello: both remain in the directory.
  expect(sharedFiles.has(`/shared/${idA}-hello.json`)).toBe(true);
  expect(sharedFiles.has(`/shared/${idB}-hello.json`)).toBe(true);
});

// --- send(): hasOutstandingMessage excludes typed protocol files ---------------

test("send() completes without spinning when a <id>-hello.json file is present in the store", async () => {
  // Regression guard: after the hello rename, <id>-hello.json matches the
  // `startsWith(<id>-) && endsWith(.json)` scan in hasOutstandingMessage.
  // Without the parseMessageByteCount fix, send() would spin waiting for the
  // hello file to be consumed. Verify it completes immediately instead.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Plant the hello file as it would appear after synchronize().
  const helloPath = `/test/${conn.id}-hello.json`;
  files.set(helloPath, Buffer.alloc(0));

  // send() must complete without looping on the hello file.
  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // The hello file must still be present (send() is not responsible for it).
  expect(files.has(helloPath)).toBe(true);
});

test("send() is not blocked by a <id>-joining.json sentinel (grammar discriminant excludes it)", async () => {
  // The joining sentinel shares the `<id>-` prefix and `.json` extension but
  // its terminal segment is the type word `joining`, not a byte count, so
  // hasOutstandingMessage excludes it via parseMessageByteCount (I3) -- no
  // per-suffix screening is needed. Were it mis-routed as an outstanding
  // message, send() would spin until the peer timeout. Verify it completes.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Plant a sentinel under this party's own id, as a crashed prior arrival
  // would leave it.
  const joiningPath = `/test/${conn.id}-joining.json`;
  files.set(joiningPath, LOCK_HELLO_BODY);

  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // send() does not own the sentinel and must not have consumed it.
  expect(files.has(joiningPath)).toBe(true);
});

test("a <a>-<b>-lock.json tiebreaker is grammar-excluded from the .json message scans (poll() and hasOutstandingMessage)", async () => {
  // The lock tiebreaker is a `.json` control file (`<peer1>-<peer2>-lock.json`),
  // so unlike a by-extension control name it reaches the `.json`-gated message
  // scans in send()'s hasOutstandingMessage and in poll(). The grammar
  // discriminant must classify it as a control file via its non-numeric terminal
  // token `lock`: never counted as an outstanding message, never delivered as a
  // message. A by-extension control name never reached these scans, so this path
  // had no prior coverage.
  const { client, files } = makeMockClient();
  const peerId = "peer-a";
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "self-b";
  conn.peerId = peerId;

  // (1) hasOutstandingMessage (in send()) must not count a lock file we own.
  // `<myId>-<peerId>-lock.json` shares our `<id>-` prefix and `.json` extension,
  // so a bare prefix glob would mistake it for an unconsumed message and spin
  // send() until the peer timeout; the non-numeric `lock` terminal excludes it.
  const ourLockPath = `/test/${conn.id}-${peerId}-lock.json`;
  files.set(ourLockPath, Buffer.alloc(0));
  await expect(conn.send({ check: true })).resolves.toBeUndefined();
  // send() does not own the lock file and must leave it in place.
  expect(files.has(ourLockPath)).toBe(true);

  // (2) poll() must ignore a peer-prefixed lock file, delivering only the real
  // message. `<peerId>-<myId>-lock.json` matches the peer scan's prefix and
  // `.json` extension but its terminal `lock` token is non-numeric.
  const peerLockPath = `/test/${peerId}-${conn.id}-lock.json`;
  files.set(peerLockPath, Buffer.alloc(0));
  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { ok: true } }),
  );
  files.set(`/test/${peerId}-${message.length}.json`, message);

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
  // The lock file is a control file: poll() neither reads nor deletes it.
  expect(files.has(peerLockPath)).toBe(true);
});

test("synchronize() lockless timeout message carries no role prefix", async () => {
  // The lockless-barrier timeout fires while the role is genuinely indeterminate
  // (it can occur after the peer hello was seen and acked, where filename order
  // may make this party the joiner), so the message has no [role] prefix --
  // unlike the lock TTL fallback, which is reachable only as the lone starter.
  // Pins the exact bare "synchronization has timed out" text.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 80),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  conn.connected = true;
  conn.path = "/test";
  client.list = async () => []; // never a peer hello: barrier loops to the TTL

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toBe("synchronization has timed out");
});

test("synchronize() lockless mode throws when more than one peer hello is detected during the poll loop", async () => {
  // Regression guard for the multi-peer-hello guard added to the lockless
  // loop: mirrors the lock path's otherFiles.length > 1 check and catches a
  // third party that slipped in after the initial synchronize() guard.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  conn.connected = true;
  conn.path = "/test";

  const peerId1 = "00000000-0000-4000-8000-000000000001";
  const peerId2 = "00000000-0000-4000-8000-000000000002";
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial synchronize() guard: clean
    // Second call (inside waitForPeer): two peer hellos are present.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: `${peerId1}-hello.json`, modifyTime: 0, size: 0 },
      { name: `${peerId2}-hello.json`, modifyTime: 0, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow(/more than one peer hello/);
});

// --- peerId: construction and open() ----------------------------------------

test("unconfigured id falls back to UUID v4 format", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(conn.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("peerId from constructor option sets this.id and appears in message filenames", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    peerId: "agency-a",
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 50 },
  });
  expect(conn.id).toBe("agency-a");
  conn.peerId = "stub-peer";
  await conn.send({ hello: 1 });
  const messageFile = [...files.keys()].find((p) =>
    /\/test\/agency-a-\d+\.json$/.test(p),
  );
  expect(messageFile).toBeDefined();
});

test("peerId from open() config sets this.id and appears in message filenames", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 50, peerId: "agency-b" },
  });
  expect(conn.id).toBe("agency-b");
  conn.peerId = "stub-peer";
  await conn.send({ hello: 1 });
  const messageFile = [...files.keys()].find((p) =>
    /\/test\/agency-b-\d+\.json$/.test(p),
  );
  expect(messageFile).toBeDefined();
});

// --- peerId: prefix-at-dash guard --------------------------------------------

test("synchronize() joiner branch rejects a prefix-at-dash id pair", async () => {
  // "site-2".startsWith("site-") is true, so the pair is rejected.
  const myId = "site-2";
  const peerId = "site";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("'-' boundary");
  // Connection must stay unsynchronized so a retry is not blocked.
  expect(conn.peerId).toBeUndefined();
  // Our hello must have been deleted so a retry does not find a stale file.
  expect(files.has(`${conn.path}/${myId}-hello.json`)).toBe(false);
});

test("synchronize() lock-detection branch rejects a prefix-at-dash id pair", async () => {
  // "site-2-hello.json" < "site-hello.json" (because '2' < 'h'), so myId
  // ("site-2") arrived first; lock name is "site-2-site-lock.json".
  const myId = "site-2";
  const peerId = "site";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${myId}-${peerId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow("'-' boundary");
  // peerId must be reset so a retry is not blocked by "already synchronized".
  expect(conn.peerId).toBeUndefined();
});

test("synchronize() joiner branch accepts shared-prefix ids that are not prefix-at-dash", async () => {
  // "agency-a" and "agency-b" share the "agency" prefix but neither is the
  // other extended by "-", so the pair is valid.
  const myId = "agency-b";
  const peerId = "agency-a";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() joiner branch accepts space-containing ids", async () => {
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();
  expect(conn.peerId).toBe(peerId);
});

// --- UsageError taxonomy -------------------------------------------------------

test("synchronize() throws UsageError for multiple concurrent sessions detected in lock-race path", async () => {
  // Trigger the "more than one peer hello" guard inside waitForPeer(). The
  // initial list() returns empty (passes the preexisting check); subsequent
  // calls return our own hello plus two peer hellos, simulating a third party
  // joining the same directory mid-rendezvous.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const myHello = `${conn.id}-hello.json`;
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting check: empty
    return [
      { name: myHello, modifyTime: 0, size: 0 },
      { name: "peer-aaa-hello.json", modifyTime: 0, size: 0 },
      { name: "peer-bbb-hello.json", modifyTime: 0, size: 0 },
    ];
  };
  // put() must succeed (writing our hello); delete/safeDelete are no-ops.
  client.put = async () => {};
  client.safeDelete = async () => {};
  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() throws UsageError for more than one joining sentinel in the lock-race path", async () => {
  // Parity with the multi-peer-hello guard for the new control file. Exactly
  // one sentinel is the only valid mid-arrival state (one joiner, one starter,
  // and the starter writes no sentinel), so two simultaneous sentinels are
  // directory contamination from a third party and must be rejected the same
  // way -- not silently timed against joiningFiles[0]. The initial list() is
  // empty (passes the preexisting check); subsequent calls return our own hello
  // plus two distinct sentinels, so otherFiles is empty and the joiningFiles
  // guard fires.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const myHello = `${conn.id}-hello.json`;
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting check: empty
    return [
      { name: myHello, modifyTime: 0, size: 0 },
      { name: "peer-aaa-joining.json", modifyTime: 0, size: 0 },
      { name: "peer-bbb-joining.json", modifyTime: 0, size: 0 },
    ];
  };
  client.put = async () => {};
  client.safeDelete = async () => {};
  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/more than one joining sentinel/);
});

test("synchronize() transport failure is not a UsageError", async () => {
  // A rejected list() (e.g. SFTP connection lost) is a transport failure and
  // must NOT be identified as a UsageError.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  client.list = async () => {
    throw new Error("SFTP connection lost");
  };
  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(UsageError);
  expect(err).toBeInstanceOf(Error);
});

test("send() message timeout throws UsageError", async () => {
  // A stale unconsumed message that outlasts the TTL is a send-timeout usage
  // error: the caller is responsible for ensuring the peer is polling.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";
  // Plant a stale outbound message that nobody will consume.
  files.set(`${conn.path}/${conn.id}-99.json`, Buffer.from("stale"));
  await expect(conn.send({ next: true })).rejects.toBeInstanceOf(UsageError);
});

// --- control file envelope: round-trip, partial-sync gate, malformed body -----

test("synchronize() lock mode: round-trip hello write and read with JSON envelope body", async () => {
  // Both the joiner fast-path (writes and reads the peer hello) and the starter
  // (reads the joiner hello before deleting) must write and read the JSON envelope.
  // Run joiner path: initial list shows one peer hello; joiner reads it, deletes
  // it, writes its own with an envelope body.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  // Joiner wrote its own hello with a JSON envelope body.
  const myHelloPath = `${conn.path}/${conn.id}-hello.json`;
  expect(files.has(myHelloPath)).toBe(true);
  const body = JSON.parse(files.get(myHelloPath)!.toString());
  expect(body).toMatchObject({});
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() lockless mode: round-trip hello body and zero-length ack markers", async () => {
  // Both parties write a hello carrying the bilateral-flag envelope and a
  // zero-length ack marker named after the peer hello they acknowledge. The
  // hello is read through the gate; the ack is matched by name existence only.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async (path: string) => {
      sharedFiles.delete(path);
    },
    safeDelete: async (path: string) => {
      sharedFiles.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Both hellos carry the bilateral-flag envelope body.
  for (const id of [idA, idB]) {
    const helloBody = JSON.parse(
      sharedFiles.get(`/shared/${id}-hello.json`)!.toString(),
    );
    expect(helloBody).toMatchObject({
      locklessRendezvous: true,
      retainFiles: false,
    });
  }
  // A acked B's hello; B acked A's hello. Each marker is named after the
  // acknowledged hello and is zero bytes (no envelope body).
  const ackAofB = sharedFiles.get(`/shared/${idA}-${idB}-hello-ack.json`);
  expect(ackAofB).toBeDefined();
  expect(ackAofB!.length).toBe(0);
  const ackBofA = sharedFiles.get(`/shared/${idB}-${idA}-hello-ack.json`);
  expect(ackBofA).toBeDefined();
  expect(ackBofA!.length).toBe(0);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
});

test("synchronize() joiner: mid-sync hello body retried, not reported malformed", async () => {
  // A hello body that fails JSON.parse on the first get() (simulating a partial
  // write by a sync tool) must be retried rather than causing a terminal failure.
  // Only once the body becomes valid JSON should synchronize() proceed.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  // First two get() calls return truncated JSON (partial sync); the third
  // returns a fully valid envelope. The gate must retry silently for the
  // first two and succeed on the third.
  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  // Gate retried at least twice before succeeding.
  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() joiner: fully-synced but malformed hello body is a UsageError", async () => {
  // A hello body that parses as JSON but fails the envelope schema is a
  // terminal UsageError (protocol mismatch), not a retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  // A JSON array is syntactically valid but fails the envelope schema (expects
  // an object), so it is a terminal malformed-payload error, not a retry.
  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() lockless: rendezvous completes on ack existence; ack body is never read", async () => {
  // The ack is a zero-length marker matched by name existence: the barrier must
  // complete without ever get()-ing an `-ack.json` file. There is no body and no
  // read gate on the ack (only the hello body is read through the gate). This
  // replaces the former mid-sync-ack-body-retry test, which guarded a read gate
  // the unified zero-byte marker no longer has.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();
  const ackGets: string[] = [];

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      if (path.endsWith("-ack.json")) ackGets.push(path);
      const data = sharedFiles.get(path);
      if (data === undefined) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async (path: string) => {
      sharedFiles.delete(path);
    },
    safeDelete: async (path: string) => {
      sharedFiles.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // No `-ack.json` file was ever read through get(): the barrier matched on
  // existence alone.
  expect(ackGets).toEqual([]);
});

test("synchronize() lock-detection: mid-sync peer hello body retried, not malformed", async () => {
  // The lock-detection branch (lockFiles.length > 0) calls readControlFileWithGate
  // on the peer hello before committing roles. A partially-synced body (invalid
  // JSON on first get()) must cause a retry, not a terminal failure.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() lock-detection: malformed peer hello body is a UsageError", async () => {
  // A fully-synced hello body in the lock-detection branch that parses as JSON
  // but fails the envelope schema must throw a terminal UsageError, not retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() lock starter: mid-sync joiner hello body retried, not malformed", async () => {
  // The starter fast-path (theseFiles.length === 0 in waitForPeer) calls
  // readControlFileWithGate on the joiner's hello before deleting it. A
  // partially-synced body must be retried, not treated as a terminal failure.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  // First list(): empty (initial preexisting check passes). Second+: only the
  // peer hello is visible — no self hello — triggering the theseFiles===0 branch.
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();

  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("responder");
});

test("synchronize() lock starter: malformed joiner hello body is a UsageError", async () => {
  // A fully-synced but schema-invalid joiner hello body in the starter
  // theseFiles===0 branch must throw a terminal UsageError, not retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));

  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

// --- bilateral mode flags: advertise + symmetric fast-fail (193901017) -------

// Two sortable UUIDs reused across the bilateral-flag tests. idLow < idHigh
// lexicographically, so the lower one is the "arrived first" party.
const ID_LOW = "00000000-0000-4000-8000-000000000001";
const ID_HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

// Builds two FileSyncConnections sharing one in-memory directory, each already
// in the post-open connected state, for concurrent-rendezvous tests. The
// generous timeToLive means a stall (instead of a fast-fail) would exceed the
// vitest timeout and fail the test, so a passing concurrent mismatch test is
// itself proof the failure is at rendezvous and not at the peer timeout.
//
// Determinism note: the concurrent tests rely on the mock client's synchronous
// in-memory Map (no await/delay in list/put), so the two parties' list()/put()
// interleave predictably under the microtask scheduler and each sees the
// other's hello on its first poll. If the mock ever gains artificial latency, a
// party could miss the peer hello on its first list() and poll to the (generous)
// TTL, surfacing as a vitest timeout -- a test artifact to fix in the mock, not
// a production regression.
function makeRendezvousPair(
  idA: string,
  optsA: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  idB: string,
  optsB: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
): {
  connA: FileSyncConnection;
  connB: FileSyncConnection;
  files: Map<string, Buffer>;
} {
  const { client, files } = makeMockClient();
  const make = (
    id: string,
    opts: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 30_000),
      verbose: -1,
      ...opts,
    });
    conn.id = id;
    conn.connected = true;
    conn.path = "/test";
    return conn;
  };
  return { connA: make(idA, optsA), connB: make(idB, optsB), files };
}

// (a) Each rendezvous branch writes the hello with the advertised flags. Drive
// the lock joiner fast-path against a matched peer so the hello it writes
// survives (the joiner keeps its own hello) and can be inspected.
test("(a) hello payload carries both bilateral flags", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  await conn.synchronize();

  const body = JSON.parse(
    files.get(`${conn.path}/${conn.id}-hello.json`)!.toString(),
  );
  expect(body).toEqual({ locklessRendezvous: false, retainFiles: false });
  expect(conn.peerId).toBe(ID_LOW);
});

// (b) Matched pairings succeed without spurious mismatch errors.

test("(b) lockless/lockless pairing succeeds and advertises both flags", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true },
    ID_HIGH,
    { locklessRendezvous: true },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
  for (const id of [ID_LOW, ID_HIGH]) {
    const body = JSON.parse(files.get(`/test/${id}-hello.json`)!.toString());
    expect(body).toEqual({ locklessRendezvous: true, retainFiles: false });
  }
});

test("(b) delete/delete (lock) pairing succeeds", async () => {
  const { connA, connB } = makeRendezvousPair(ID_LOW, {}, ID_HIGH, {});

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
});

test("(b) retain/retain pairing succeeds and advertises the retain flag", async () => {
  const retainOpts = {
    locklessRendezvous: true,
    retainFiles: true,
    timestampInFilename: true,
  };
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    retainOpts,
    ID_HIGH,
    retainOpts,
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
  for (const id of [ID_LOW, ID_HIGH]) {
    const body = JSON.parse(files.get(`/test/${id}-hello.json`)!.toString());
    expect(body).toEqual({ locklessRendezvous: true, retainFiles: true });
  }
});

// (c) Mismatched pairings fail fast at rendezvous on BOTH parties, in both
// arrival orders, with the both-sides-named error, identified as usage errors.

test("(c) lockless vs lock mismatch fails fast on BOTH parties, concurrently", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true },
    ID_HIGH,
    { locklessRendezvous: false },
  );

  const results = await Promise.allSettled([
    connA.synchronize(),
    connB.synchronize(),
  ]);

  for (const r of results) {
    expect(r.status).toBe("rejected");
    const reason = (r as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BilateralModeMismatchError);
    expect(reason).toBeInstanceOf(UsageError);
    expect(reason.message).toMatch(/lockless_rendezvous mismatch/);
    // Distinct from the generic peer-timeout backstop.
    expect(reason.message).not.toMatch(/timed out|synchronization has timed/);
  }
  // Both advertised hellos remain as the directory's terminal state.
  expect(files.has(`/test/${ID_LOW}-hello.json`)).toBe(true);
  expect(files.has(`/test/${ID_HIGH}-hello.json`)).toBe(true);
});

test("(c) retain vs non-retain mismatch (both lockless) fails fast on BOTH parties", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true, retainFiles: true, timestampInFilename: true },
    ID_HIGH,
    { locklessRendezvous: true, retainFiles: false },
  );

  const results = await Promise.allSettled([
    connA.synchronize(),
    connB.synchronize(),
  ]);

  for (const r of results) {
    expect(r.status).toBe("rejected");
    const reason = (r as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BilateralModeMismatchError);
    expect(reason.message).toMatch(/retain_files mismatch/);
  }
  expect(files.has(`/test/${ID_LOW}-hello.json`)).toBe(true);
  expect(files.has(`/test/${ID_HIGH}-hello.json`)).toBe(true);
});

test("(c) lock joiner reading a lockless peer hello fails fast and leaves both hellos", async () => {
  // Arrival order 1: the lock party reads a peer hello already present (joiner
  // fast-path) and detects the mismatch. It must write its own advertisement
  // before throwing and must not delete the peer hello.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock (default)
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toContain(
    "this party has lockless_rendezvous=false",
  );
  expect((err as Error).message).toContain(
    "the peer has lockless_rendezvous=true",
  );
  // Own advertisement written, peer hello not deleted: both remain.
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lockless party reading a lock peer hello fails fast and leaves both hellos", async () => {
  // Arrival order 2: the lockless party reads the lock peer's left-behind hello
  // in its ack barrier and detects the mismatch, after having written its own
  // hello before the loop. The same pairing's other side (above) detects via
  // the joiner fast-path, so both parties surface it.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 30_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = ID_LOW;
  conn.connected = true;
  conn.path = "/test";
  const peerHelloName = `${ID_HIGH}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toContain(
    "this party has lockless_rendezvous=true",
  );
  expect((err as Error).message).toContain(
    "the peer has lockless_rendezvous=false",
  );
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);

  // The durable-hello guarantee is load-bearing: the outer catch must clear
  // responsibleFiles so a later cleanup()/close() does not sweep the hello this
  // party advertised. If it were swept, the peer's read would miss it and the
  // peer would fall through to the timeout instead of fast-failing. Assert the
  // clear directly, then prove its consequence -- cleanup() (non-retain here,
  // so not a no-op) removes nothing and both hellos persist as the terminal
  // state.
  const responsible = (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
  expect(responsible.size).toBe(0);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lock two-hellos branch detects the mismatch before createExclusive (EEXIST-loser sub-path pre-empted)", async () => {
  // The check precedes createExclusive, so neither the createExclusive-winner
  // nor the EEXIST-loser sub-path runs on a mismatch. createExclusive is stubbed
  // to throw EEXIST (and exists() to report a live lock) so that, were the check
  // NOT pre-empting it, the loser sub-path would run; assert it never does.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  let createExclusiveCalls = 0;
  client.createExclusive = async () => {
    createExclusiveCalls++;
    throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  };
  client.exists = async () => true;

  // First list (entry guard) is empty so conn writes its own hello and enters
  // the lock loop; subsequent lists show both hellos and no lock, routing into
  // the two-hellos branch.
  let listCalls = 0;
  client.list = async () => {
    listCalls++;
    if (listCalls === 1) return [];
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: peerHelloName, modifyTime: 0, size: 0 },
    ];
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/lockless_rendezvous mismatch/);
  expect(createExclusiveCalls).toBe(0);
  // The conn's own hello (written before the loop) is left behind, not swept.
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
});

test("(c) lock-detection branch sweeps the lock and leaves both hellos on a mismatch", async () => {
  // Defense-in-depth path (waitForPeer's "lockFiles.length > 0" arm). A lock on
  // disk implies both parties are lock (lockless never creates one) and a lock
  // party always has retain_files=false, so no flag can differ and this branch
  // cannot reach a mismatch for any valid pairing. Drive it with a synthetic
  // directory -- a peer-created lock plus a lockless-advertising peer hello --
  // to cover the safeDelete(lock)-then-throw code added for the prior review.
  // The lock is a transient, not an advertisement, so it is swept; both hellos
  // remain as the directory's terminal state.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock, non-retain
  const peerHelloName = `${ID_LOW}-hello.json`;
  // ID_LOW sorts first, so the producer's lock name is `${ID_LOW}-${ID_HIGH}`;
  // this matches the branch's reconstruct-and-compare (I7) so the read gate and
  // mismatch check are reached rather than a "lock does not reference" throw.
  const lockName = `${ID_LOW}-${conn.id}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );
  files.set(lockPath, Buffer.alloc(0));

  // First list (entry guard) empty so conn writes its own hello and enters the
  // lock loop; subsequent lists expose both hellos plus the peer-created lock,
  // routing into the lock-detection branch.
  let listCalls = 0;
  client.list = async () => {
    listCalls++;
    if (listCalls === 1) return [];
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: peerHelloName, modifyTime: 0, size: 0 },
      { name: lockName, modifyTime: 0, size: 0 },
    ];
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/lockless_rendezvous mismatch/);
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) a both-flags-differ mismatch names retain_files (the implying flag)", async () => {
  // retain=true/lockless=true vs retain=false/lockless=false: both flags differ,
  // and the error names retain_files so a single rerun realigns both.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock, non-retain
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: true }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/retain_files mismatch/);
  expect((err as Error).message).not.toMatch(/lockless_rendezvous mismatch/);
});

// (d) A fully-synced hello that parses as JSON but is missing a flag or carries
// an out-of-type value fails the required-field schema as a terminal usage
// error on the reading party -- no crash, no silent default.

test("(d) a fully-synced hello missing a flag is a terminal usage error", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(JSON.stringify({ locklessRendezvous: true })), // retainFiles absent
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/malformed payload/);
});

test("(d) a fully-synced hello with an out-of-type flag is a terminal usage error", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: "yes", retainFiles: false }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/malformed payload/);
});

// (e) After a mismatch the directory retains both hellos, so a rerun against it
// is rejected by the entry guard (I0) -- the terminal mismatch is not auto-
// retried and the operator must clear the directory first.

test("(e) leftover hellos after a mismatch make a rerun rejected by the entry guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    BilateralModeMismatchError,
  );
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);

  // A rerun against the non-clean directory (fresh party id) is rejected by the
  // entry guard: two peer hellos are now present.
  const rerun = await makeConnectedConn(client, { pollingFrequency: 10 });
  rerun.id = "11111111-1111-4111-8111-111111111111";

  let rerunErr: unknown;
  await rerun.synchronize().catch((e: unknown) => {
    rerunErr = e;
  });
  expect(rerunErr).toBeInstanceOf(UsageError);
  expect((rerunErr as Error).message).toMatch(/peer hello|must be empty/);
});

// --- retain mode (retainFiles: true) -----------------------------------------

// Creates a retain-mode connection that is already open, connected, and paired.
function makeRetainConn(
  client: FileTransportClient,
  id: string,
  peerId: string,
  timeToLiveMs = 5_000,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/shared";
  conn.peerId = peerId;
  return conn;
}

test("retain mode: synchronize() throws UsageError when locklessRendezvous is false", async () => {
  // Class-boundary guard: constructing FileSyncConnection with retainFiles:
  // true but locklessRendezvous: false (or unset) bypasses the schema refine
  // and CLI imply, so synchronize() must catch the combination and throw before
  // entering any rendezvous path.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    // locklessRendezvous intentionally omitted (defaults to false)
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: synchronize() throws UsageError when locklessRendezvous is explicitly false", async () => {
  // Explicit false must also be rejected, not just the default (unset) case.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: multi-message exchange completes when delete() always fails", async () => {
  // Acceptance: two-party unit test demonstrating a full multi-message cycle
  // when the mock's delete() is stubbed to always throw.
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async () => {
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {},
    exists: async (path: string) => sharedFiles.has(path),
  });

  const idA = "sender-a";
  const idB = "receiver-b";
  const connA = makeRetainConn(makeClient(), idA, idB);
  const connB = makeRetainConn(makeClient(), idB, idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  // Send 3 messages concurrently with B's poller; the ack gate serializes
  // them even though delete() always fails.
  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
});

test("retain mode: ack marker is written before the data event fires", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let ackPresentAtEmit = false;
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => {
    ackPresentAtEmit = [...files.keys()].some(
      (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
    );
    notifyReceived();
  });

  await runPoller(conn, delivered);

  expect(ackPresentAtEmit).toBe(true);
});

// Returns the stem (name minus .json) of the single message file this party
// wrote, so a test can construct the ack the sender's gate waits for.
const lastSentStem = (files: Map<string, Buffer>, dir: string, id: string) => {
  const sent = [...files.keys()].find(
    (p) =>
      p.startsWith(`${dir}/${id}-`) &&
      p.endsWith(".json") &&
      !p.endsWith("-ack.json") &&
      !p.endsWith("-hello.json"),
  );
  if (sent === undefined) throw new Error("no sent message found");
  return sent.slice(`${dir}/`.length, -".json".length);
};

test("retain mode: sender blocks until the ack of its last message appears, then proceeds", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send proceeds without waiting (seq=0).
  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  // Second send blocks waiting for the ack of the first message.
  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 50));
  expect(secondDone).toBe(false);

  // Plant the zero-length ack named after the sent message; the gate matches it
  // by name existence (constructed from the stem, not parsed).
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: an ack for a different message does not release the sender", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // An ack for a different message (a wrong stem) does not match the expected
  // name, so the gate stays closed.
  files.set(
    `/test/${peerId}-${id}-20260101T000000-999-5-ack.json`,
    Buffer.alloc(0),
  );

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // The ack of the actual last-sent message releases the gate.
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: first send proceeds immediately without any ack", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // No acks present; first send must resolve without waiting.
  await conn.send({ first: true });

  const messageFiles = [...files.keys()].filter(
    (p) =>
      p.includes(`${id}-`) && p.endsWith(".json") && !p.endsWith("-ack.json"),
  );
  expect(messageFiles).toHaveLength(1);
});

test("retain mode: cleanup() does not delete exchange files", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  // cleanup() must not delete any files in retain mode.
  await conn.cleanup();
  expect(safeDeleted).toHaveLength(0);
  // The ack marker is still on disk (cleanup did not remove it).
  const ackOnDisk = [...files.keys()].find(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBeDefined();
});

test("retain mode: a consumed message file is retained on a delete-capable transport", async () => {
  // Regression: retain mode must never delete the message payload, even when the
  // transport's delete() succeeds (e.g. real SFTP). The directory is the durable
  // transcript and the ack is the consumption signal that replaces deletion.
  // Previously the receiver issued a best-effort delete that silently removed the
  // message on capable transports, so the "permanent transcript" guarantee held
  // only on no-delete transports. makeMockClient's delete() actually removes the
  // file, so this exercises the capable-transport path.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  const msgPath = `/test/${msgName}`;
  files.set(msgPath, message);

  // Spy on delete() so the test fails if any deletion is attempted at all.
  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  // The message payload is still on disk after consumption...
  expect(files.has(msgPath)).toBe(true);
  // ...because no deletion was ever attempted in retain mode.
  expect(deleted).toHaveLength(0);
  // The ack -- the consumption signal that replaces deletion -- was written.
  const ackOnDisk = [...files.keys()].some(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBe(true);
});

test("retain mode: a message reprocessed after an emit failure is not acked twice", async () => {
  // The ack is written before emit, and on an emit failure recvSeq stays so the
  // (never-deleted) message is reprocessed on the next poll. The ack write must
  // produce exactly one marker across that retry, even though the message is
  // processed twice.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  // Count ack writes via rename rather than the on-disk file set: the ack name
  // is a pure function of the consumed message's fixed name, so a duplicate
  // write would overwrite the first under an identical name and be invisible to
  // a file-count check.
  const ackRenames: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    if (to.endsWith("-ack.json")) ackRenames.push(to);
    return origRename(from, to);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  // Fail the first emit so the message is reprocessed; deliver on the second.
  let emitCount = 0;
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    emitCount += 1;
    if (emitCount === 1) throw new Error("data handler failed on first emit");
    received.push(msg);
    notifyReceived();
  });
  // Swallow the error the failed emit raises through poll() so the poller keeps
  // running and reprocesses the retained message.
  conn.on("error", () => {});

  await runPoller(conn, delivered);

  // Processed twice (first emit threw, second delivered)...
  expect(emitCount).toBeGreaterThanOrEqual(2);
  expect(received).toHaveLength(1);
  // ...but the ack was written exactly once (idempotent across the retry).
  expect(ackRenames).toHaveLength(1);
});

test("retain mode: ack-wait timeout throws a UsageError on the timeToLive budget", async () => {
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 100),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send uses the budget without blocking; no ack will arrive.
  await conn.send({ first: true });

  // Second send must time out and throw UsageError.
  await expect(conn.send({ second: true })).rejects.toBeInstanceOf(UsageError);
});

test("retain mode + lockless rendezvous: multi-message exchange completes end-to-end", async () => {
  // Primary production configuration: sync-mediated transports that lack both
  // atomic exclusive-create and deletion visibility need lockless_rendezvous
  // for rendezvous AND retain_files for message-loop signaling. This test
  // covers the one combination that had zero prior coverage.
  const idA = "00000000-0000-4000-8000-000000000001"; // sorts lower
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff"; // sorts higher

  const sharedFiles = new Map<string, Buffer>();
  const deleteCalls: string[] = [];

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
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
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src: string | Buffer | NodeJS.ReadableStream, dest: string) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async (path: string) => {
      deleteCalls.push(path);
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported on this transport");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
  // delete() was never called: retain mode on a no-delete transport must not
  // attempt deletion anywhere in the rendezvous-to-message-loop path.
  expect(deleteCalls).toHaveLength(0);
});

// --- finding #1: seq advances only after durable rename ----------------------

test("retain mode: send() does not advance seq when rename throws", async () => {
  // Regression guard: a write failure must not leave this.seq past the slot of
  // the unwritten message, which would cause the retain-mode ack gate to wait
  // forever for the ack of a message that was never written.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = "sender-me";
  conn.peerId = "peer-receiver";

  const seqBefore = conn.seq;

  // Stub rename to throw so the durable write never completes.
  client.rename = async () => {
    throw new Error("rename failed");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("rename failed");

  // seq must be unchanged: the message was never committed to disk.
  expect(conn.seq).toBe(seqBefore);
});

test("delete mode: send() does not advance seq when rename throws", async () => {
  // Same invariant must hold in non-retain mode.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;
  client.rename = async () => {
    throw new Error("rename failed");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("rename failed");
  expect(conn.seq).toBe(seqBefore);
});

// --- finding #4: retain => timestampInFilename guard in synchronize() --------

test("retain mode: synchronize() throws UsageError when timestampInFilename is false", async () => {
  // Guard fires when retainFiles=true and timestampInFilename=false (even when
  // locklessRendezvous=true, so it is the timestamp guard that triggers).
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: true,
    timestampInFilename: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

// --- finding #5: close() resets session counters -----------------------------

test("close() resets seq, recvSeq, and lastAckedNNN to their initial values", async () => {
  // A closed connection must not carry stale counters into a hypothetical
  // re-open. Set each to a non-zero value, close(), then assert they reset.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Drive counters to non-initial values by sending a message and manipulating
  // internal state directly (the fields are internal but accessible in tests).
  await conn.send({ n: 1 });
  // seq is now 1 after a successful send.
  expect(conn.seq).toBe(1);
  // Manually set recvSeq and lastAckedNNN to non-zero/non-(-1) values.
  (conn as unknown as { recvSeq: number }).recvSeq = 3;
  (conn as unknown as { lastAckedNNN: number }).lastAckedNNN = 2;

  await conn.close();

  expect(conn.seq).toBe(0);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(0);
  expect((conn as unknown as { lastAckedNNN: number }).lastAckedNNN).toBe(-1);
});

// --- finding #1/#6: terminal poll errors stop the poller ---------------------

test("retain mode: poll() duplicate-NNN error is a UsageError and stops the poller", async () => {
  // Finding #6: the duplicate-NNN throw is now UsageError (terminal protocol
  // violation). Finding #1: a UsageError in the non-TOCTOU catch branch sets
  // pollerActive=false before emitting, so the finally block does not reschedule
  // and the error fires exactly once without the handler calling stop().
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant two message files with the same NNN (0): the poller scan for
  // recvSeq=0 will find both and throw the duplicate-NNN UsageError.
  const msg = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);
  files.set(`/test/${peerId}-20260101T120000-000-${msg.length}.json`, msg);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
    // Intentionally do NOT call conn.stop() -- the poller must have already
    // stopped itself before the emit so the finally block does not reschedule.
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  // Error fired exactly once.
  expect(errors).toHaveLength(1);
  // The error is classified as a UsageError (terminal protocol violation).
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");

  // pollerActive must be false: the poller stopped itself before emitting.
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );

  // Wait two poll intervals and confirm no second error arrives (poller did not
  // reschedule). If the finally block had rescheduled, a second error would
  // arrive almost immediately.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("delete mode: poll() more-than-one-message error is a UsageError and stops the poller", async () => {
  // Delete mode keeps at most one outstanding message per direction (I9), so two
  // peer messages at once is a terminal protocol violation (a concurrent session
  // or a bug), not a retryable transport failure -- a UsageError that stops the
  // poller, matching the retain-mode duplicate-NNN case. Re-reading the same two
  // files cannot reconcile them.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // Two distinct, fully-synced delete-mode message files from the peer.
  files.set(`/test/${peerId}-10.json`, Buffer.from("a".repeat(10)));
  files.set(`/test/${peerId}-20.json`, Buffer.from("b".repeat(20)));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  // Do NOT call stop() -- a terminal error must stop the poller on its own.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  // No second error: the poller did not reschedule.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("retain mode: poll() seq-mismatch (UsageError) stops the poller", async () => {
  // The seq-mismatch UsageError was already a UsageError before this change;
  // confirm it also stops the poller (finding #1), consistent with the
  // duplicate-NNN path above.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant a message whose body seq disagrees with the filename NNN (NNN=0,
  // body seq=99). The validator throws UsageError on the mismatch.
  const msg = Buffer.from(
    JSON.stringify({ ts: 1, seq: 99, type: "Object", payload: { v: 1 } }),
  );
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
    // Do NOT call stop() -- the poller must stop itself.
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("seq=");

  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

// --- finding #4: send() not-synchronized guard applies to non-retain mode ----

test("non-retain send() before synchronize() (peerId unset) throws 'not synchronized'", async () => {
  // Finding #4: the not-synchronized guard is hoisted to the top of send() and
  // now fires for both retain and non-retain modes.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    // Explicitly NOT retain mode.
    retainFiles: false,
  });
  conn.connected = true;
  conn.path = "/test";
  // peerId is NOT set (synchronize() was not called).

  await expect(conn.send({ n: 1 })).rejects.toThrow("not synchronized");
});

// --- I8 counter seam: error-injection tests -----------------------------------
// Each test targets one of the three I8 rules: (a) seq advances only after a
// durable rename in send(), (b) recvSeq advances only after a successful emit
// in poll() and the ack is written before emit, (c) all counters reset via
// resetSessionState() at every session-boundary path.

test("I8: send() whose put throws -- seq unchanged, temp file cleaned up", async () => {
  // Rule (a): a write failure before the rename must not advance seq and must
  // leave no temp-*.tmp residue in the store.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;

  // Track every safeDelete call so we can confirm the temp path was swept.
  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  // Stub put to throw, making the temp write itself fail.
  client.put = async () => {
    throw new Error("synthetic put failure");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("synthetic put failure");

  // seq must be unchanged -- the message slot was never durably written.
  expect(conn.seq).toBe(seqBefore);

  // The catch block in send() calls safeDelete(tempPath) even when put threw,
  // so the temp path was passed to safeDelete.
  expect(safeDeleted.length).toBeGreaterThanOrEqual(1);
  const tempSweep = safeDeleted.find((p) => p.endsWith(".tmp"));
  expect(tempSweep).toBeDefined();

  // No temp-*.tmp file must remain in the store.
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

test("I8: send() whose rename throws -- seq unchanged, temp file cleaned up", async () => {
  // Rule (a): rename failure (put succeeded, rename threw) must not advance seq
  // and must leave no orphaned temp-*.tmp. This test extends the existing
  // rename-failure coverage to confirm temp cleanup explicitly on the send path.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;

  // Capture the temp path that put() actually wrote so the cleanup assertion
  // cannot pass vacuously (a refactor that skipped the temp write would leave
  // tempPath undefined and the check below would fail).
  let tempPath: string | undefined;
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    await origPut(src, dest, opts);
    tempPath = dest;
  };

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  client.rename = async () => {
    throw new Error("synthetic rename failure");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("synthetic rename failure");

  // seq must not have advanced.
  expect(conn.seq).toBe(seqBefore);

  // The temp file was written (a .tmp path)...
  expect(tempPath).toBeDefined();
  expect(tempPath!.endsWith(".tmp")).toBe(true);
  // ...and swept via safeDelete.
  expect(safeDeleted).toContain(tempPath!);
  // No temp-*.tmp residue on disk.
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

test("I8: retain send() ack-gate list throws -- send rejects rather than spinning", async () => {
  // Rule (a) + gateway liveness: when list() throws inside the ack-gate loop
  // (waiting for the peer's ack after the first send), send() must surface the
  // error rather than looping silently. Without this, a broken list() path would
  // spin until the TTL expires, which takes too long for a unit test.
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    // Short TTL so a spin would be caught by the test runner.
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send: proceeds immediately (seq=0, no ack wait).
  await conn.send({ first: true });

  // Now stub list() to throw so the second send's ack-gate list fails.
  // The gate loop exits when list() rejects and the caught error is rethrown.
  client.list = async () => {
    throw new Error("synthetic list failure");
  };

  // Second send must reject (not spin to TTL expiry).
  await expect(conn.send({ second: true })).rejects.toThrow(
    "synthetic list failure",
  );
});

test("I8: poll() list throws -- error reaches the error event, recvSeq unchanged", async () => {
  // Rule (b): when list() throws inside poll(), the error must be emitted on
  // the "error" channel. recvSeq must not advance (no message was consumed).
  const { client } = makeMockClient();
  const peerId = "peer-sender";

  // Stub list to throw on every call so poll() fails immediately.
  client.list = async () => {
    throw new Error("synthetic list failure from poll");
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = "receiver-me";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    conn.stop();
    notifyError();
  });

  const recvSeqBefore = (conn as unknown as { recvSeq: number }).recvSeq;

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  // Error must have been emitted.
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("synthetic list failure");

  // recvSeq must not have advanced -- no message was processed.
  const recvSeqAfter = (conn as unknown as { recvSeq: number }).recvSeq;
  expect(recvSeqAfter).toBe(recvSeqBefore);
});

test("I8: retain poll() ack-write failure -- recvSeq held, message reprocessed and acked once", async () => {
  // Rule (b), ack-write-failure variant (distinct from the emit-failure path
  // covered above): if writeAck() throws before lastAckedNNN is set, recvSeq
  // must NOT advance, so the never-deleted message is reprocessed on the next
  // poll. The retry writes the ack successfully -- exactly one ack and one
  // delivery, no double-ack and no skipped message.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  // Fail the first ack rename, then allow subsequent ones. During poll() the ack
  // is the only file renamed to a -ack.json target (the message is read via
  // get()), so this isolates the ack write from the message read.
  let ackRenameAttempts = 0;
  const ackRenames: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    if (to.endsWith("-ack.json")) {
      ackRenameAttempts += 1;
      if (ackRenameAttempts === 1)
        throw new Error("synthetic ack rename failure");
      ackRenames.push(to);
    }
    return origRename(from, to);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  // Swallow the ack-write error so the poller keeps running and reprocesses
  // the retained message rather than tearing down.
  conn.on("error", (err) => {
    errors.push(err);
  });

  await runPoller(conn, delivered);

  // The ack write was attempted twice: it threw once, then succeeded.
  expect(ackRenameAttempts).toBe(2);
  // The failure surfaced on the error channel.
  expect(errors.length).toBeGreaterThanOrEqual(1);
  // The message was delivered exactly once...
  expect(received).toHaveLength(1);
  // ...recvSeq advanced exactly once, only after the successful ack + emit
  // (so it was held across the failed attempt)...
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(1);
  // ...and exactly one ack persists on disk.
  expect(ackRenames).toHaveLength(1);
  const onDiskAcks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(onDiskAcks).toHaveLength(1);
});

// --- synchronize() entry precondition matrix ---------------------------------
// One mode-agnostic rule replaces the former generic + retain-specific guards:
// at synchronize() entry the directory must be empty except for at most one peer
// hello. The matrix is the full (file-kind x mode) cross-product of that rule,
// generated rather than hand-listed so a missing combination is structurally
// impossible. The only legal pre-entry states are an empty directory and a
// single peer hello (the case the old retain guard wrongly rejected); every
// other file kind can appear only AFTER entry and is rejected, in both modes.
// If a kind below is not a direct consequence of the rule, the rule -- not the
// matrix -- is wrong.

const ENTRY_SELF_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_PEER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const ENTRY_PEER_ID_2 = "11111111-1111-4111-8111-111111111111";

// One row per file kind. `present` is what sits in the directory at entry. A
// peer hello on a proceed row is read through the HelloEnvelope gate, so the
// test body (below) gives it a full mode-matched envelope; every other kind is
// rejected on filename before any body read, so those bodies stay "{}". Outcome
// does not vary by mode (the rule is mode-agnostic), so each kind carries a
// single expected outcome and is run in both modes below.
const entryPreconditionKinds: Array<{
  kind: string;
  present: string[];
  outcome: "proceed" | "reject";
}> = [
  { kind: "empty directory", present: [], outcome: "proceed" },
  {
    kind: "one peer hello",
    present: [`${ENTRY_PEER_ID}-hello.json`],
    outcome: "proceed",
  },
  // A self-hello is a same-id leftover from a crashed session, not the peer's.
  {
    kind: "self-hello",
    present: [`${ENTRY_SELF_ID}-hello.json`],
    outcome: "reject",
  },
  {
    kind: "two peer hellos",
    present: [`${ENTRY_PEER_ID}-hello.json`, `${ENTRY_PEER_ID_2}-hello.json`],
    outcome: "reject",
  },
  {
    kind: "lock file",
    present: [`${ENTRY_SELF_ID}-${ENTRY_PEER_ID}-lock.json`],
    outcome: "reject",
  },
  // A rendezvous ack marker (a crashed lockless session): a peer acking this
  // party's hello. Its terminal segment is `ack`, so it is not a peer hello.
  {
    kind: "rendezvous ack",
    present: [`${ENTRY_PEER_ID}-${ENTRY_SELF_ID}-hello-ack.json`],
    outcome: "reject",
  },
  // A joining sentinel left by a lock joiner that crashed mid-arrival. Its
  // terminal segment is the type word `joining`, so it is neither a peer hello
  // nor a message -- but the directory must be clean at entry, so the strict-
  // empty guard rejects it (and a fresh joiner must not adopt a stale one).
  {
    kind: "joining sentinel",
    present: [`${ENTRY_PEER_ID}-joining.json`],
    outcome: "reject",
  },
  // A stale non-timestamped message closes the pre-existing gap where the old
  // generic (delete-mode) guard let leftover messages through.
  {
    kind: "non-timestamped message",
    present: [`${ENTRY_PEER_ID}-42.json`],
    outcome: "reject",
  },
  {
    kind: "timestamped message",
    present: [`${ENTRY_PEER_ID}-20260101T000000-000-42.json`],
    outcome: "reject",
  },
  // A retain-mode message ack: the peer acking a message this party sent. The
  // embedded byte-count (2) is all digits but the terminal segment is `ack`.
  {
    kind: "message ack",
    present: [
      `${ENTRY_PEER_ID}-${ENTRY_SELF_ID}-20260101T000000-000-2-ack.json`,
    ],
    outcome: "reject",
  },
  // An in-flight temp file is rejected today (strict-empty). The planned tmp
  // sweep (193792285) will move this into the guard's `ignored` set.
  { kind: "temp file", present: ["temp-abc.tmp"], outcome: "reject" },
  // A foreign (non-protocol) file: the directory is the state machine, so it
  // must be clean at entry.
  { kind: "foreign file", present: ["notes.txt"], outcome: "reject" },
];

const entryPreconditionModes: Array<{ label: string; retain: boolean }> = [
  { label: "delete mode", retain: false },
  { label: "retain mode", retain: true },
];

const entryPreconditionCells = entryPreconditionModes.flatMap((mode) =>
  entryPreconditionKinds.map((k) => ({
    name: `${k.kind} (${mode.label})`,
    present: k.present,
    retain: mode.retain,
    outcome: k.outcome,
  })),
);

test.each(entryPreconditionCells)(
  "synchronize() entry precondition: $name -> $outcome",
  async ({ present, retain, outcome }) => {
    const { client, files } = makeMockClient();
    // A peer hello in the "proceed" row is read through the HelloEnvelope gate,
    // so it must advertise flags matching this conn's mode (193901017); other
    // present-file kinds are rejected on filename before any body read, so an
    // empty body is fine for them.
    const helloBody = Buffer.from(
      JSON.stringify({ locklessRendezvous: retain, retainFiles: retain }),
    );
    for (const name of present)
      files.set(
        `/test/${name}`,
        name.endsWith("-hello.json") ? helloBody : Buffer.from("{}"),
      );

    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      // A short TTL so the proceed rows with no live peer enter the rendezvous
      // wait and time out quickly with a transport Error (never a UsageError).
      timeToLive: new Date(Date.now() + 60),
      verbose: -1,
      locklessRendezvous: retain,
      timestampInFilename: retain,
      retainFiles: retain,
    });
    conn.id = ENTRY_SELF_ID;
    conn.connected = true;
    conn.path = "/test";

    const err = await conn.synchronize().catch((e: unknown) => e);
    if (outcome === "reject") {
      // The precondition guard rejects before any rendezvous I/O.
      expect(err).toBeInstanceOf(UsageError);
    } else {
      // Proceeds past the guard: it either completes rendezvous (the delete-mode
      // joiner fast-path with one peer hello) or enters the rendezvous wait and
      // times out with a transport Error -- never the precondition UsageError.
      expect(err).not.toBeInstanceOf(UsageError);
    }
  },
);

// --- poll() error classification: terminal vs retryable ----------------------
// poll() stops the poller on a terminal error (re-reading the same bytes cannot
// help) and reschedules on a retryable one (a later attempt may succeed). The
// terminal class includes a fully-synced message that fails to parse or
// validate -- the missing case that let a corrupt, never-deleted retain-mode
// message re-read until the peer timeout. The retryable class includes a
// transient transport hiccup. (Seq/NNN-mismatch and duplicate-NNN terminal
// cases are covered by their own tests above.)

test("poll() terminal: a fully-synced message with an unparseable body stops the poller", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // Body is not valid JSON; the filename declares its exact byte length so the
  // size gate passes and poll() reaches the parse step.
  const body = Buffer.from("this is not json");
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  // Do NOT call stop() -- a terminal error must stop the poller on its own.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  // The poller stopped itself; no payload delivered and no ack written.
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
  // No second error arrives (the finally block did not reschedule).
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("poll() terminal: a fully-synced message that fails schema validation stops the poller", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // Valid JSON, but missing the required Message fields -> schema failure.
  const body = Buffer.from(JSON.stringify({ not: "a message" }));
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("failed schema validation");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
});

test("poll() retryable: a transient list() failure reschedules and the message is delivered on a later cycle", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const body = Buffer.from(
    JSON.stringify({ ts: 1, seq: 0, type: "Object", payload: { v: 1 } }),
  );
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  // Throw on the first list() only, then defer to the real listing. A transient
  // transport failure is retryable: the poller must reschedule and deliver.
  let listCalls = 0;
  const realList = client.list.bind(client);
  client.list = async (dir: string) => {
    listCalls += 1;
    if (listCalls === 1) throw new Error("transient list failure");
    return realList(dir);
  };

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  // Record the transient error but keep the poller running.
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  // The transient error surfaced but was not terminal...
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]).not.toBeInstanceOf(UsageError);
  // ...and the poller rescheduled and delivered the message exactly once.
  expect(received).toHaveLength(1);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(1);
});

test("poll() terminal: delete mode also stops the poller on a fully-synced corrupt message", async () => {
  // The terminal-parse rule is mode-agnostic. In delete mode poll() parses
  // before deleting, so a corrupt fully-synced file stops the poller AND is left
  // on disk for inspection -- it no longer silently drops-and-continues as it
  // did before this change (the deliberate "both modes" behavior change).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // Non-timestamped delete-mode message name; body is corrupt but full length.
  const body = Buffer.from("not json");
  const msgName = `${peerId}-${body.length}.json`;
  files.set(`/test/${msgName}`, body);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  // parse-before-delete: the corrupt file is left on disk for inspection.
  expect(files.has(`/test/${msgName}`)).toBe(true);
  // No second error: the finally block did not reschedule.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("retain mode: send() honors an ack already on disk even when the TTL has elapsed", async () => {
  // Regression guard for the ack-gate ordering: the loop checks for the
  // qualifying ack BEFORE the deadline, so an ack present when send() is entered
  // is honored rather than discarded as a spurious timeout.
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    // TTL already in the past: a deadline-first loop would throw immediately.
    timeToLive: new Date(Date.now() - 1),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send (seq=0) proceeds without the gate even with an elapsed TTL, and
  // records the sent message as lastSentFile. Plant the ack of that message so
  // the next send's gate finds it on its first check.
  await conn.send({ n: 1 });
  const stem = lastSentStem(files, "/test", id);
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  // Must not throw a timeout: the ack is present, so send() proceeds and writes
  // the next message even though the TTL has already elapsed.
  await expect(conn.send({ n: 2 })).resolves.toBeUndefined();
  expect(conn.seq).toBe(2);
});

// --- unified ack marker: determinism, grammar routing, construct-and-match ---

test("retain mode: writeAck is deterministic and idempotent by name (hyphen-containing id)", async () => {
  // The marker name is a pure function of this party's id and the acknowledged
  // file's fixed name, so two writes for the same message yield the identical
  // name and a single zero-length file -- no duplicate even if the per-message
  // write guard is bypassed. `site-a` exercises a hyphen-containing id, proving
  // the name is built by concatenation and never split back into ids.
  const { client, files } = makeMockClient();
  const conn = makeRetainConn(client, "site-a", "b"); // path "/shared"
  const writeAck = (
    conn as unknown as {
      writeAck: (dir: string, originalName: string) => Promise<string>;
    }
  ).writeAck.bind(conn);

  const messageName = "b-20260101T000000-000-42.json";
  const originalName = messageName.slice(0, -".json".length);

  const first = await writeAck("/shared", originalName);
  const second = await writeAck("/shared", originalName);

  expect(first).toBe("site-a-b-20260101T000000-000-42-ack.json");
  expect(second).toBe(first);
  const acks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(acks).toHaveLength(1);
  expect(files.get(`/shared/${first}`)!.length).toBe(0);
});

test("poll(): a message-ack with an all-digit embedded byte count is not routed as a message", async () => {
  // Grammar routing keys on the terminal segment only. A message-ack's embedded
  // <byteCount> (42) is all digits, but the terminal segment is `ack`, so poll()
  // never delivers it and recvSeq does not advance.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";
  files.set(
    `/shared/${peerId}-${id}-20260101T000000-000-42-ack.json`,
    Buffer.alloc(0),
  );
  const conn = makeRetainConn(client, id, peerId); // path "/shared"

  const received: unknown[] = [];
  conn.on("data", (m) => received.push(m));
  conn.on("error", () => {});

  conn.start();
  await new Promise((r) => setTimeout(r, 60));
  conn.stop();

  expect(received).toHaveLength(0);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(0);
});

test("delete mode: hasOutstandingMessage ignores a `<id>-...-ack.json` file (numeric mid-name)", async () => {
  // The delete-mode sender's outstanding-message scan uses the grammar
  // discriminant, so a marker this party wrote -- whose embedded byte count (42)
  // is all digits but whose terminal segment is `ack` -- is not mistaken for an
  // unconsumed message. send() proceeds rather than spinning to the TTL.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { timeToLiveMs: 300 });
  conn.id = "me";
  conn.peerId = "peer";
  files.set(`/test/me-peer-20260101T000000-000-42-ack.json`, Buffer.alloc(0));

  await expect(conn.send({ n: 1 })).resolves.toBeUndefined();
});

test.each([
  { a: "site-a", b: "b" }, // hyphen-containing id
  { a: "ack", b: "b" }, // id equal to a type word
])(
  "lockless+retain construct-and-match: ids $a / $b complete rendezvous and exchange messages",
  async ({ a, b }) => {
    // Both the rendezvous ack and the message ack are matched by constructing the
    // expected name from the ids and filenames each end already holds -- never by
    // splitting the two concatenated ids out of a marker. A hyphen-containing id
    // (`site-a`) and an id equal to a type word (`ack`) both round-trip.
    const sharedFiles = new Map<string, Buffer>();
    const makeClient = (): FileTransportClient => ({
      connect: async () => {},
      end: async () => {},
      list: async (dir: string): Promise<FileInfo[]> => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        return [...sharedFiles.entries()]
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
        const data = sharedFiles.get(path);
        if (data === undefined) throw new Error(`${path}: not found`);
        return data as Buffer<ArrayBufferLike>;
      },
      put: async (
        src: string | Buffer | NodeJS.ReadableStream,
        dest: string,
      ) => {
        if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
      },
      delete: async () => {
        throw new Error("delete not supported on this transport");
      },
      safeDelete: async () => {},
      rename: async (from: string, to: string) => {
        const data = sharedFiles.get(from);
        if (data === undefined) throw new Error(`${from}: no such file`);
        sharedFiles.delete(from);
        sharedFiles.set(to, data);
      },
      createExclusive: async () => {
        throw new Error("createExclusive not supported on this transport");
      },
      exists: async (path: string) => sharedFiles.has(path),
    });

    const makeConn = (id: string) => {
      const c = new FileSyncConnection(makeClient(), {
        pollingFrequency: 10,
        timeToLive: new Date(Date.now() + 5_000),
        verbose: -1,
        locklessRendezvous: true,
        timestampInFilename: true,
        retainFiles: true,
      });
      c.id = id;
      c.connected = true;
      c.path = "/shared";
      return c;
    };

    const connA = makeConn(a);
    const connB = makeConn(b);

    await Promise.all([connA.synchronize(), connB.synchronize()]);
    expect(connA.peerId).toBe(b);
    expect(connB.peerId).toBe(a);

    // B receives two messages from A; the ack gate serializes them with no
    // id-splitting of any marker name.
    const received: unknown[] = [];
    let resolveAll!: () => void;
    const allReceived = new Promise<void>((r) => (resolveAll = r));
    connB.on("data", (m) => {
      received.push(m);
      if (received.length === 2) resolveAll();
    });

    const sending = (async () => {
      await connA.send({ n: 1 });
      await connA.send({ n: 2 });
    })();

    await runPoller(connB, allReceived);
    await sending;

    expect(received).toHaveLength(2);
    expect((received[0] as { n: number }).n).toBe(1);
    expect((received[1] as { n: number }).n).toBe(2);
  },
);
