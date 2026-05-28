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

// --- connection lifecycle (unconnected) --------------------------------------

test("stop and cleanup are safe on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(() => conn.stop()).not.toThrow();
  await expect(conn.cleanup()).resolves.not.toThrow();
});

test("close throws 'not connected' on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await expect(conn.close()).rejects.toThrow("not connected");
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

// --- TOCTOU race: ENOENT from get() ------------------------------------------

test("poll does not emit error when get() throws ENOENT after a successful exists()", async () => {
  // Simulate the TOCTOU window: exists() returns true, but by the time get()
  // runs the peer has already deleted the file (their cleanup() raced with our
  // poll()). The poller must swallow ENOENT and reschedule rather than
  // emitting "error" and killing the connection.
  let getCount = 0;
  const { client } = makeMockClient();
  const originalGet = client.get.bind(client);
  let existsCount = 0;
  client.exists = async () => {
    existsCount++;
    // Return true once so poll() attempts get(); false afterwards.
    return existsCount === 1;
  };
  client.get = async (p, opts) => {
    if (++getCount === 1) {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    }
    return originalGet(p, opts);
  };

  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

  const errors: unknown[] = [];
  conn.on("error", (err) => errors.push(err));

  // Resolved by exists() on its 3rd call, confirming the poller rescheduled at
  // least twice after the ENOENT — without relying on a fixed wall-clock wait.
  let notifyThirdExists!: () => void;
  const thirdExists = new Promise<void>((r) => {
    notifyThirdExists = r;
  });
  const origExists = client.exists.bind(client);
  client.exists = async (p: string) => {
    const result = await origExists(p);
    if (existsCount === 3) notifyThirdExists();
    return result;
  };

  conn.start();
  await Promise.race([
    thirdExists,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for 3rd exists() call")),
        2_000,
      ),
    ),
  ]);
  conn.stop();

  expect(errors).toHaveLength(0);
  // get() was called exactly once (on the ENOENT-throwing poll cycle).
  expect(getCount).toBe(1);
  // The poller rescheduled and ran additional cycles after the ENOENT.
  expect(existsCount).toBeGreaterThan(1);
});

test("poll delivers a subsequent valid message after swallowing an ENOENT", async () => {
  const { client, files } = makeMockClient();
  const originalGet = client.get.bind(client);
  let existsCallCount = 0;
  let getCount = 0;
  const peerId = "peer-test";
  const peerPath = `/test/${peerId}.json`;

  client.exists = async (p: string) => {
    existsCallCount++;
    if (existsCallCount === 1) return true; // triggers ENOENT on get()
    if (existsCallCount === 3) {
      // Plant a valid message on the third poll cycle, after the ENOENT.
      files.set(
        peerPath,
        Buffer.from(
          JSON.stringify({
            ts: Date.now(),
            seq: 0,
            type: "Object",
            payload: { hello: "world" },
          }),
        ),
      );
      return true;
    }
    return files.has(p);
  };
  client.get = async (p: string, opts?: unknown) => {
    if (++getCount === 1)
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    return originalGet(p, opts as Parameters<typeof originalGet>[1]);
  };

  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
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
  // exists() always returns true; get() always throws ENOENT. After 3
  // consecutive ENOENT cycles the poller must emit an error instead of
  // warning indefinitely.
  const { client } = makeMockClient();
  client.exists = async () => true;
  client.get = async (p) => {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: "ENOENT" },
    );
  };

  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

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

test("poll emits error immediately when exists() throws ENOENT (not a TOCTOU race)", async () => {
  // reachedGet is false when exists() throws, so ENOENT from exists() is a
  // hard error that must be emitted immediately — not tolerated as a TOCTOU race.
  const { client } = makeMockClient();
  client.exists = async (p) => {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: "ENOENT" },
    );
  };

  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
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
  // (.hello x2, .wave) must be deleted before synchronize() returns.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it,
  // guaranteeing the wave-file name and role assignment are deterministic.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
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
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
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
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
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
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
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
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
  // peerId < myId (pinned to max), so peer arrived first.
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
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
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
  const waveName = `${peerId}-${myId}.wave`;
  const wavePath = `${conn.path}/${waveName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
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
  // from the wave filename against .hello entries, which never matched, so
  // any party that observed a peer-created wave file threw
  // "wave file does not reference this connection" instead of completing
  // the rendezvous.
  //
  // Scenario reproduced here: peer arrived first, both wrote .hello, peer
  // won the wave race and created `${peerId}-${myId}.wave`. This party
  // observes peer.hello + my.hello + wave file on its next list().
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
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
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
      { name: waveName, modifyTime: mtime },
    ];
  };

  await conn.synchronize();

  // Peer arrived first so this party is the initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
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
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}.hello`;
  const peerHelloName = `${peerId}.hello`;
  // peerId < myId so the peer "arrived first" by name tiebreak; wave name
  // is `${peerId}-${myId}.wave` and is created by THIS connection.
  const waveName = `${peerId}-${myId}.wave`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check
    return [
      { name: myHelloName, modifyTime: mtime },
      { name: peerHelloName, modifyTime: mtime },
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

// --- synchronize(): joiner branch (initial list shows one peer hello) -------

test("synchronize() joiner branch: assigns initiator role and writes own hello after deleting peer's", async () => {
  // Initial list returns one peer .hello, triggering the joiner branch
  // (this party arrived second on a previously-empty directory).
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}.hello`;
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  client.list = async () => [{ name: peerHelloName, modifyTime: Date.now() }];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Peer's hello was deleted; our own hello was written.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}.hello`)).toBe(true);
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
  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}.hello`;
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  client.list = async () => [{ name: peerHelloName, modifyTime: Date.now() }];
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
  let existsCallCount = 0;
  let getCount = 0;

  let resolveDone!: () => void;
  // Resolves once exists() is called a 6th time, confirming all 5 expected
  // poll cycles (including both ENOENT groups and the reset cycle) are done.
  const cyclesDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  client.exists = async () => {
    existsCallCount++;
    // Cycles 1–2: true → ENOENT on get (count reaches 2, below threshold 3)
    // Cycle 3: false → clean poll, counter resets to 0
    // Cycles 4–5: true → ENOENT on get (count reaches 2 again, still below 3)
    if (existsCallCount === 6) resolveDone();
    return (
      existsCallCount === 1 ||
      existsCallCount === 2 ||
      existsCallCount === 4 ||
      existsCallCount === 5
    );
  };
  client.get = async (p) => {
    getCount++;
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: "ENOENT" },
    );
  };

  const conn = makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

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
