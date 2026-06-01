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
  }>,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
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
  const { client } = makeMockClient();
  const peerId = "peer-test";
  let listCount = 0;
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

  const errors: unknown[] = [];
  conn.on("error", (err) => errors.push(err));

  // Resolved on list()'s 3rd call, confirming the poller rescheduled at least
  // twice after the ENOENT — without relying on a fixed wall-clock wait.
  let notifyThirdList!: () => void;
  const thirdList = new Promise<void>((r) => {
    notifyThirdList = r;
  });
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

  expect(errors).toHaveLength(0);
  // get() was called exactly once (on the ENOENT-throwing poll cycle).
  expect(getCount).toBe(1);
  // The poller rescheduled and ran additional cycles after the ENOENT.
  expect(listCount).toBeGreaterThan(1);
});

test("poll delivers a subsequent valid message after swallowing an ENOENT", async () => {
  const { client, files } = makeMockClient();
  const originalGet = client.get.bind(client);
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

  const received: unknown[] = [];
  // Resolved when the first message arrives — no fixed wall-clock wait.
  let notifyReceived!: () => void;
  const firstMessage = new Promise<void>((r) => {
    notifyReceived = r;
  });
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });

  conn.start();
  await Promise.race([
    firstMessage,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for first message delivery")),
        2_000,
      ),
    ),
  ]);
  conn.stop();

  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["hello"]).toBe("world");
});

test("poll emits error when ENOENT threshold is reached on consecutive poll cycles", async () => {
  // list() always surfaces a matching file (size matches declared count);
  // get() always throws ENOENT. After 3 consecutive ENOENT cycles the poller
  // must emit an error instead of warning indefinitely.
  const { client } = makeMockClient();
  const peerId = "peer-test";
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

  const errors: unknown[] = [];
  // Resolved by the error handler so the test waits only as long as necessary
  // rather than sleeping a fixed amount of wall time.
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

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
        () => reject(new Error("timed out waiting for ENOENT threshold error")),
        2_000,
      ),
    ),
  ]);

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

// --- synchronize(): wave-file race cleanup ------------------------------------

test("synchronize() cleans up hello and wave files when createExclusive() throws EEXIST", async () => {
  // Simulates the losing party in the wave-file race: createExclusive() throws
  // because the peer already claimed the wave slot, and all three residue files
  // (-hello.json x2, .wave) must be deleted before synchronize() returns.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it,
  // guaranteeing the wave-file name and role assignment are deterministic.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer "arrived first" by name tiebreak.
  // Wave name: peer-mine.
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

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

  // createExclusive() throws EEXIST; also plant the wave file so
  // exists(wavePath) → true, simulating the peer having already claimed it.
  client.createExclusive = async (path) => {
    files.set(wavePath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  // All residue files must be gone.
  expect(files.has(wavePath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // Roles are set correctly for the losing party.
  expect(conn.peerId).toBe(peerId);
  // peerId arrived first → this connection is initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
});

test("synchronize() throws when createExclusive throws EEXIST but wave file is already gone (peer abandoned)", async () => {
  // The wave file is only gone after EEXIST if the winner crashed during the
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
  // Wave name would be peer-mine.

  // Plant both hello files so the defensive safeDelete calls have something
  // to remove; the directory must be clean after the throw so a retry can
  // run from scratch.
  const basePath = conn.path;
  files.set(`${basePath}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${basePath}/${peerHelloName}`, Buffer.alloc(0));

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

  // createExclusive() throws EEXIST but does NOT plant the wave file,
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
  // the outer catch safeDeletes wavePath and helloPath (no-ops here).
  expect(files.has(`${basePath}/${myHelloName}`)).toBe(false);
  expect(files.has(`${basePath}/${peerHelloName}`)).toBe(false);
});

test("synchronize() rejects and cleans up hello and wave files when createExclusive throws a non-EEXIST error", async () => {
  // Simulates an SFTP close-after-open failure: createExclusive atomically
  // creates the wave file on the server (open succeeds) but then fails to
  // close the handle, rejecting with a non-EEXIST error. The outer catch in
  // synchronize() must safeDelete the wave file and reject.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer arrived first.
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

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
  // not vacuously true. The outer catch is responsible only for this party's
  // files (wavePath and helloPath); it does not touch the peer's hello.
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));

  // Simulate a partial createExclusive: create the file on the mock filesystem
  // (mimicking a successful open) but then reject (mimicking a close failure).
  client.createExclusive = async (path) => {
    files.set(path, Buffer.alloc(0));
    throw Object.assign(new Error("SFTP handle close failed"), { code: "EIO" });
  };

  await expect(conn.synchronize()).rejects.toThrow();

  // The wave file must be cleaned up (outer catch calls safeDelete(wavePath)).
  expect(files.has(wavePath)).toBe(false);
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
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

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
  // the test is clearer when files match what list() claims exists.
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));

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

  // The outer catch deletes wavePath and helloPath (my hello): 2 safeDeletes.
  // The peer's hello is left intact — it is the peer's responsibility, not this
  // party's — so no safeDelete is issued for it.
  const countAfterSync = safeDeleteCount;
  expect(countAfterSync).toBe(2);

  // responsibleFiles was cleared by the outer catch: cleanup() must not call
  // safeDelete again. Without the clear, cleanup() would re-attempt safeDelete
  // on waveName and myHelloName (both already deleted), adding 2 more calls.
  await conn.cleanup();
  expect(safeDeleteCount).toBe(countAfterSync);

  expect(files.has(wavePath)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

test("synchronize() resolves cleanly when it observes a wave file already created by the peer", async () => {
  // Regression guard: the wave-detection branch
  // (waitForPeer's "waveFiles.length > 0" arm) used to compare bare UUIDs
  // from the wave filename against -hello.json entries, which never matched,
  // so any party that observed a peer-created wave file threw
  // "wave file does not reference this connection" instead of completing
  // the rendezvous.
  //
  // Scenario reproduced here: peer arrived first, both wrote -hello.json,
  // peer won the wave race and created `${peerId}-${myId}.wave`. This party
  // observes peer-hello.json + my-hello.json + wave file on its next list().
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // Peer arrived first (sorted lower) so the wave name is `${peer}-${my}`.
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

  // Plant the three files so safeDelete calls have something to remove.
  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  files.set(wavePath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // Initial check (sees only our own newly-written hello mid-flow).
    // Subsequent listings expose the peer hello and the peer-created wave.
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: waveName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  // Peer arrived first so this party is the initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
  // The wave-detection branch must label roles with the same convention as
  // the other rendezvous branches: responder=starter, initiator=joiner.
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  // All three files cleaned up by the wave-detection branch.
  expect(files.has(wavePath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

// --- synchronize(): createExclusive winner retains responsibleFiles --------

test("synchronize() createExclusive winner: leaves own hello and wave name in responsibleFiles so cleanup() can sweep them if peer never arrives", async () => {
  // Regression guard: previously, the outer try block in synchronize() cleared
  // responsibleFiles on every successful waitForPeer() return — including the
  // createExclusive-winner path, which is the one path that legitimately needs
  // to retain its files. The loser (whose createExclusive throws EEXIST) is
  // normally responsible for cleaning the wave and both hellos, but if the
  // loser never arrives (crash, partition), the winner's eventual cleanup()
  // must sweep them. With the clear, the winner's responsibleFiles was empty
  // and the files were stranded.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId so the peer "arrived first" by name tiebreak; wave name
  // is `${peerId}-${myId}.wave` and is created by THIS connection.
  const waveName = `${peerId}-${myId}.wave`;

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
  // Default mock createExclusive succeeds (no EEXIST) — this conn is the
  // wave-race winner.

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Winner retains its own hello AND the wave name; cleanup() can sweep
  // them later if the loser never arrives.
  const responsible = (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
  expect(responsible.has(myHelloName)).toBe(true);
  expect(responsible.has(waveName)).toBe(true);
});

test("synchronize() two-hellos branch: tiebreaker uses UUID order only, ignoring divergent modifyTimes", async () => {
  // Across heterogeneous transports the two parties can observe different --
  // even contradictory -- modifyTimes for the same hello files, because sync
  // tools stamp the transfer time rather than the original creation time. Here
  // each side sees ITS OWN hello as the earlier file, the worst case for a
  // modifyTime tiebreaker: it would make both parties believe they arrived
  // first, both claim the starter role, and derive two different wave names --
  // a deadlock. The UUID-only tiebreaker must instead assign the starter role
  // to the lexicographically-smaller UUID on both sides regardless of
  // modifyTime, so the parties agree on roles and on a single wave name.
  const idLow = "00000000-0000-4000-8000-000000000001";
  const idHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";

  // Run one side's synchronize() against a listing in which this side's own
  // hello is the earlier (smaller modifyTime) file. Returns the assigned roles
  // plus the wave name the side derived (captured from createExclusive).
  const runSide = async (
    myId: string,
    peerId: string,
  ): Promise<{
    role: string;
    handshakeRole: string | undefined;
    waveName: string;
  }> => {
    const { client } = makeMockClient();
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

    let waveName = "";
    const realCreateExclusive = client.createExclusive.bind(client);
    client.createExclusive = async (path: string) => {
      waveName = path.slice(base.length + 1);
      return realCreateExclusive(path);
    };

    await conn.synchronize();
    return { role: conn.role, handshakeRole: conn.handshakeRole, waveName };
  };

  const low = await runSide(idLow, idHigh);
  const high = await runSide(idHigh, idLow);

  // The smaller UUID is the starter on both sides; modifyTime is ignored even
  // though it pointed the other way for the high-UUID side.
  expect(low.handshakeRole).toBe("responder");
  expect(low.role).toBe("starter");
  expect(high.handshakeRole).toBe("initiator");
  expect(high.role).toBe("joiner");

  // Both sides independently derive the SAME wave name, `${low}-${high}.wave`,
  // which is what lets the loser locate and clean up the winner's wave file.
  expect(low.waveName).toBe(`${idLow}-${idHigh}.wave`);
  expect(high.waveName).toBe(`${idLow}-${idHigh}.wave`);
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
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Peer's hello was deleted; our own hello was written.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
});

test("synchronize() joiner branch: leaves connection unsynchronized when put fails after delete succeeds", async () => {
  // Regression guard: previously, `peerId` and `handshakeRole` were assigned
  // before the delete/put pair. A `put` failure after a successful `delete`
  // left the connection in a half-state where `synchronize()` could not be
  // re-run on the same instance because the "already synchronized" guard
  // tripped on the stale `peerId`. The fix defers the assignment until both
  // writes succeed.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];
  // delete succeeds (default mock behavior); put rejects with a synthetic
  // transport error.
  client.put = async () => {
    throw new Error("synthetic put failure");
  };

  await expect(conn.synchronize()).rejects.toThrow("synthetic put failure");

  // Connection must be in its pre-synchronize state: no peer identity, no
  // role. Otherwise a retry on this instance would hit the
  // "already synchronized" guard.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

test("ENOENT counter resets after a clean poll cycle, allowing a fresh set of retries", async () => {
  // Two ENOENTs (below threshold of 3), then exists() returns false (counter
  // resets), then two more ENOENTs. Four total ENOENTs — but split across two
  // groups — must never reach the threshold and must not emit an error.
  const { client } = makeMockClient();
  const peerId = "peer-test";
  let listCallCount = 0;
  let getCount = 0;

  let resolveDone!: () => void;
  // Resolves once list() is called a 6th time, confirming all 5 expected poll
  // cycles (including both ENOENT groups and the reset cycle) are done.
  const cyclesDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

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

  const errors: unknown[] = [];
  conn.on("error", (err) => errors.push(err));

  conn.start();
  // Wait until the 6th exists() call confirms all 5 cycles completed;
  // fall back to a 2 s safety timeout so the test never hangs.
  await Promise.race([
    cyclesDone,
    new Promise<void>((r) => setTimeout(r, 2_000)),
  ]);
  conn.stop();

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

test("synchronize() preexisting -hello-ack.json causes an immediate rejection", async () => {
  // A stale ack file indicates a crashed lockless session. The preexisting-file
  // guard must reject regardless of whether locklessRendezvous is set.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const staleAck = "some-peer-id-hello-ack.json";
  files.set(`${conn.path}/${staleAck}`, Buffer.alloc(0));
  client.list = async () => [
    { name: staleAck, modifyTime: 0, size: 0 },
  ];

  await expect(conn.synchronize()).rejects.toThrow(/handshake-ack/);
});

test("synchronize() wave path writes hello as <id>-hello.json and self-hello detection still works", async () => {
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

  await conn.synchronize();

  // The wave-race winner (this conn: wave created by createExclusive)
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
    put: async (
      src: string | Buffer | NodeJS.ReadableStream,
      dest: string,
    ) => {
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

test("synchronize() lockless mode role assignment matches the lexicographic rule for the same id pair as the wave path", async () => {
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
    put: async (
      src: string | Buffer | NodeJS.ReadableStream,
      dest: string,
    ) => {
      if (Buffer.isBuffer(src)) sharedFiles.set(dest, src);
    },
    delete: async () => { throw new Error("delete not supported"); },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => { throw new Error("not supported"); },
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
  // When locklessRendezvous is set and a single peer hello is found on the
  // initial list(), the party must NOT take the joiner shortcut (which would
  // call delete(peer hello), unsupported on a lockless transport). It must
  // write its own hello and enter the lockless ack-handshake barrier instead.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  // Pre-plant A's hello so B's initial list() sees it (simulating A having
  // arrived first and written its hello before B calls synchronize()).
  sharedFiles.set(`/shared/${idA}-hello.json`, Buffer.alloc(0));

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
    put: async (
      src: string | Buffer | NodeJS.ReadableStream,
      dest: string,
    ) => {
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

  // Simulate A entering the lockless barrier (A's hello is pre-planted; A
  // must poll for B's hello). Run A and B concurrently.
  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Neither party should have called delete (unsupported on lockless transport).
  expect(deleteCalled).toBe(false);
  // Both are synchronized.
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // A's hello was NOT deleted (still in sharedFiles).
  expect(sharedFiles.has(`/shared/${idA}-hello.json`)).toBe(true);
});

// --- send(): hasOutstandingMessage excludes typed protocol files ---------------

test("send() completes without spinning when a <id>-hello.json file is present in the store", async () => {
  // Regression guard: after the hello rename, <id>-hello.json matches the
  // `startsWith(<id>-) && endsWith(.json)` scan in hasOutstandingMessage.
  // Without the parseMessageByteCount fix, send() would spin waiting for the
  // hello file to be consumed. Verify it completes immediately instead.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);

  // Plant the hello file as it would appear after synchronize().
  const helloPath = `/test/${conn.id}-hello.json`;
  files.set(helloPath, Buffer.alloc(0));

  // send() must complete without looping on the hello file.
  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // The hello file must still be present (send() is not responsible for it).
  expect(files.has(helloPath)).toBe(true);
});

test("synchronize() lockless mode throws when more than one peer hello is detected during the poll loop", async () => {
  // Regression guard for the multi-peer-hello guard added to the lockless
  // loop: mirrors the wave path's otherFiles.length > 1 check and catches a
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
