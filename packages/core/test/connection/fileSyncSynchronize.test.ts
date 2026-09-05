// Scenario tests for FileSyncConnection.synchronize(), which delegates its
// rendezvous work to FileSyncRendezvous.

import { expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import {
  UsageError,
  ConnectionClosedError,
  FrameSizeExceededError,
  TransportOperationStalledError,
  isPeerWaitTimeout,
} from "../../src/errors";
import { DISPLAY_TRUNCATION_MARKER } from "../../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { withCapturedLogs } from "../../src/testing";
import {
  makeMockClient,
  makeConnectedConn,
  LOCK_HELLO_BODY,
  responsibleFilesOf,
  makeRendezvousPair,
} from "../utils/fileSyncConnectionFixture";

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
  // gate passes before reaching createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  // createExclusive() throws EEXIST; also plant the lock file so
  // exists(lockPath) -> true, simulating the peer having already claimed it.
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // Roles are set correctly for the losing party.
  expect(conn.peerId).toBe(peerId);
  // peerId arrived first -> this connection is initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
});

test("synchronize() recognize-and-sweeps leftover abort markers (own and peer) at entry in delete mode", async () => {
  // Every authenticated terminal failure leaves a `<writerId>-abort.json`, so a
  // directory reused for a later exchange would otherwise reject "directory not
  // clean". The entry guard sweeps any well-formed marker, whichever party's id
  // names it.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;
  const ownAbortPath = `${conn.path}/${myId}-abort.json`;
  const peerAbortPath = `${conn.path}/${peerId}-abort.json`;

  // Plant the leftover markers (their bodies are irrelevant -- the sweep deletes
  // by name) and the peer hello body for the rendezvous read gate.
  files.set(ownAbortPath, Buffer.from("{}"));
  files.set(peerAbortPath, Buffer.from("{}"));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1)
      // Entry snapshot: a peer hello (recovers peerId) plus both leftover
      // markers. After the sweep, no unexpected protocol file remains.
      return [
        {
          name: peerHelloName,
          modifyTime: mtime,
          size: LOCK_HELLO_BODY.length,
        },
        { name: `${myId}-abort.json`, modifyTime: mtime, size: 2 },
        { name: `${peerId}-abort.json`, modifyTime: mtime, size: 2 },
      ];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: LOCK_HELLO_BODY.length },
    ];
  };
  // Lose the lock race so rendezvous completes (mirrors the EEXIST test above).
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  expect(files.has(ownAbortPath)).toBe(false);
  expect(files.has(peerAbortPath)).toBe(false);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() recognize-and-sweeps a leftover abort marker whose id names neither this party nor a hello present at entry", async () => {
  // The shape a retry after a failed exchange actually presents: both parties
  // draw fresh ids, so the marker the failure left is named by neither the
  // retrying party nor the peer whose hello is on disk. The sweep matches any
  // well-formed marker rather than an id it can name, so the retry proceeds.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const priorSessionId = "22222222-2222-4222-8222-222222222222";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;
  const priorAbortPath = `${conn.path}/${priorSessionId}-abort.json`;

  files.set(priorAbortPath, Buffer.from("{}"));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1)
      return [
        {
          name: peerHelloName,
          modifyTime: mtime,
          size: LOCK_HELLO_BODY.length,
        },
        { name: `${priorSessionId}-abort.json`, modifyTime: mtime, size: 2 },
      ];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: LOCK_HELLO_BODY.length },
    ];
  };
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  expect(files.has(priorAbortPath)).toBe(false);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() does not sweep a bare `-abort.json`; it stays an unexpected protocol file", async () => {
  // The empty-prefix form recovers no id, so it is attributable to no party and
  // is not a marker any honest party writes. The sweep requires a non-empty
  // recovered id, so this name keeps the same fate as a bare `-hello.json`:
  // rejected by the clean-entry guard rather than deleted.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const barePath = `${conn.path}/-abort.json`;
  files.set(barePath, Buffer.from("{}"));
  client.list = async () => [{ name: "-abort.json", modifyTime: 0, size: 2 }];

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
  expect(files.has(barePath)).toBe(true);
});

test("synchronize() does NOT sweep a leftover abort marker in retain mode; it shows as exit-64", async () => {
  // In retain mode the directory is a durable audit transcript, so a leftover
  // marker beside it must not be auto-swept (that would reintroduce the
  // destruction the retain guard prevents). It falls through to the unexpected-
  // protocol guard (a UsageError -> exit 64), which --force-retain-sweep clears.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: {
      peerTimeoutMs: 50,
      retainFiles: true,
      locklessRendezvous: true,
    },
  });
  const ownAbortPath = `/test/${conn.id}-abort.json`;
  files.set(ownAbortPath, Buffer.from("{}"));
  client.list = async () => [
    { name: `${conn.id}-abort.json`, modifyTime: 0, size: 2 },
  ];

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
  expect(files.has(ownAbortPath)).toBe(true);
});

test("synchronize() reports an over-cap peer hello as a terminal FrameSizeExceededError", async () => {
  // The rendezvous gate (readControlFileWithGate) must treat an over-cap hello
  // control file as terminal rather than retrying it until the deadline: a
  // hostile server could otherwise hold the gate open by serving an oversized
  // hello every cycle, re-incurring on each pass the allocation the cap exists
  // to prevent. Covers the FrameSizeExceededError rethrow in the gate's catch.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

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

  // The peer hello is present in the listing, but the adapter refuses to read it
  // because it exceeds the cap (a server under-reporting its size in the listing
  // and then serving an oversized body). Count reads to prove the gate does not
  // retry at the polling cadence.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new FrameSizeExceededError(
        `inbound file ${path} exceeds the maximum inbound frame size`,
      );
    }
    return originalGet(path);
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    FrameSizeExceededError,
  );
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("synchronize() reports a stalled peer-hello read as a terminal TransportOperationStalledError", async () => {
  // Liveness sibling of the over-cap case above. The rendezvous gate
  // (readControlFileWithGate) must treat a stalled hello read as terminal
  // rather than retrying it: a hostile server that withholds the transfer makes
  // each get() reject with the typed liveness error, and retrying at the polling
  // cadence would loop back into the stall every pass until the hour-long peer
  // TTL instead of failing fast in seconds. TransportOperationStalledError is a
  // UsageError, so the gate's catch rethrows it exactly as it does the over-cap
  // FrameSizeExceededError.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

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

  // The peer hello is present in the listing, but the server withholds the
  // transfer so the adapter's liveness bound rejects the read. Count reads to
  // prove the gate does not retry at the polling cadence.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new TransportOperationStalledError(
        `SFTP file read of ${path} stalled: received no data for 60000 ms ` +
          `(the server withheld the transfer); refusing to wait on the server ` +
          `further`,
      );
    }
    return originalGet(path);
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("synchronize() propagates a base UsageError from a transport read as the terminal exit-64 failure, not retried", async () => {
  // The two cases above cover the concrete FrameSizeExceededError and
  // TransportOperationStalledError subclasses; this pins the contract at the
  // UsageError BASE class the gate's catch (and the poll loop) actually key off
  // ("if (err instanceof UsageError) throw err"), so the terminal behavior is the
  // class-level invariant rather than a per-subclass coincidence -- a future
  // UsageError subclass thrown from a transport read is terminal for free. The
  // rejection being an instanceof UsageError is exactly the exit-64 (EX_USAGE)
  // classification the CLI maps from this base class.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

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

  // The peer-hello read rejects with a bare UsageError (the base class, not one of
  // the typed transport bounds). Count reads to prove the gate propagates it on
  // the first pass instead of retrying at the polling cadence until the TTL.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new UsageError(`usage fault reading ${path}`);
    }
    return originalGet(path);
  };

  const rejection = await conn.synchronize().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(rejection).toBeInstanceOf(UsageError);
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("synchronize() fails within the peer budget when the server withholds the delete callback", async () => {
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  // A valid peer hello so the bilateral-flag gate passes and the joiner proceeds
  // to the delete; the put(sentinel) before it succeeds against the mock store.
  files.set(`${conn.path}/${peerId}-hello.json`, LOCK_HELLO_BODY);
  client.delete = () => new Promise<void>(() => {});
  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
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
  // Peer hello contains a valid HelloEnvelope so the two-hellos read gate
  // passes before createExclusive; the own hello is never gate-read.
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
  // The peer's hello is left intact -- it is the peer's responsibility and will
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
  // The peer's hello is left intact -- it is the peer's responsibility, not this
  // party's -- so no safeDelete is issued for it.
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
  // Scenario: peer arrived first, both wrote -hello.json,
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
  // before "-" (U+002D), so "Agency A" arrives first by filename order. A raw
  // `"Agency" < "Agency A"` id-compare would say "Agency" arrived first,
  // producing the wrong lock name and a false rejection.
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
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };
  // Peer hello body so the two-hellos read gate passes before createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  // Default mock createExclusive succeeds (no EEXIST) -- this conn is the
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
  // tools stamp the transfer time rather than the creation time. Here each
  // side sees ITS OWN hello as earlier, the worst case for a modifyTime
  // tiebreaker: both parties would believe they arrived first, both claim
  // the starter role, and derive different lock names -- a deadlock. The
  // UUID-only tiebreaker must instead agree on roles and a single lock name
  // regardless of modifyTime.
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
      // This side's own hello has the EARLIER timestamp; under a
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

  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
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
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
});

test("synchronize() lock starter: aborts with a distinct transport error within a bounded window when a joiner never completes", async () => {
  // The critical case the fix closes. A joiner deleted our hello and then died
  // before renaming its sentinel to its hello, so the sentinel persists. The
  // peer must report a distinct, terminal error and abort on the bounded
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
  // because it may have crashed before that step.
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
  // Does NOT assert the delete already happened, since in state (a)
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
  // tracked. The fallback must still report the actionable stuck-joiner cause,
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
  // Not a peer-wait timeout either: the peer did arrive and then stalled, and
  // this error already has its own diagnosis and next step, so a consumer
  // must not layer a second, contradicting likely cause onto it.
  expect(isPeerWaitTimeout(err)).toBe(false);
});

// The sentinel's name contains a peer id recovered from a partner-written
// filename under no charset bound, and both stuck-joiner errors put the whole
// diagnosis and "Retry the exchange." BEHIND it in one link. Redacting the name
// where it is interpolated is what keeps the next step reachable.
test("synchronize() lock starter: a private-key-shaped sentinel name does not take the stuck-joiner diagnosis", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 10_000,
    timeToLiveMs: 150,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `-----BEGIN RSA PRIVATE KEY------joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain("[redacted private key]");
  expect(rendered).toMatch(/the exchange timed out before it completed/);
  expect(rendered).toMatch(
    /failed after announcing its arrival but before publishing its hello/,
  );
  expect(rendered).toContain("Retry the exchange.");
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
  client.list = async () => [];

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toBe(
    "[starter] synchronization has timed out",
  );
  // Tagged as a peer-wait timeout so a consumer that also knows the run swept
  // the shared folder at entry can offer that as the likely cause.
  expect(isPeerWaitTimeout(err)).toBe(true);
});

test("synchronize() lock starter: a bare -joining.json injected mid-rendezvous does not trigger the joiner-recovery stall", async () => {
  // A `-joining.json` (empty recovered id) appearing after entry must NOT be
  // treated as a real joiner mid-arrival: the lock starter must keep polling and
  // hit the bare TTL timeout, never the bounded joiner-recovery (joinerRecoveryMs)
  // abort. Were the empty-id sentinel adopted, an injected file would force the
  // ~30 s starter stall its joinerRecoveryMs path induces. joinerRecoveryMs (30)
  // is far below the TTL (150) so a regression that adopted it would abort early
  // with the distinct stuck-joiner message instead of the bare timeout asserted
  // here.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 150,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const bareJoining = "-joining.json";
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, this party is the starter
    // After entry, only the empty-id sentinel beside our own hello. A real
    // joiner never appears.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: bareJoining, modifyTime: Date.now(), size: 0 },
    ];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  // The bare timeout, proving the empty-id sentinel never started the recovery
  // window: the stuck-joiner path produces a different, distinct message.
  expect((err as Error).message).toBe(
    "[starter] synchronization has timed out",
  );
  expect((err as Error).message).not.toMatch(/recovery window/);
  expect((err as Error).message).not.toMatch(/began arriving/);
});

test("synchronize() lock starter: a bare -hello.json injected mid-rendezvous is ignored and rendezvous completes with the real joiner", async () => {
  // A `-hello.json` (empty recovered id) appearing after entry, alongside the
  // real joiner's hello, must not be counted as a peer hello: the lock starter's
  // otherFiles scan must see exactly the one real hello and complete the
  // rendezvous, recovering the real (non-empty) peer id. Were the empty-id hello
  // counted, otherFiles would hold two hellos and the >1 guard would abort with
  // "more than one peer hello" -- a planted file derailing a legitimate exchange.
  const joinerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joinerHello = `${joinerId}-hello.json`;
  // The joiner's hello body must read through the gate before the lock race.
  files.set(`${conn.path}/${joinerHello}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, this party is the starter
    // After entry: our own hello, the real joiner's hello, and an injected bare
    // `-hello.json`. Only the real joiner is a peer hello.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: joinerHello, modifyTime: Date.now(), size: 0 },
      { name: "-hello.json", modifyTime: Date.now(), size: 0 },
    ];
  };

  await conn.synchronize();

  // Completed against the real joiner; the empty-id hello was never adopted.
  expect(conn.peerId).toBe(joinerId);
});

test("synchronize() lockless mode: a bare -hello.json injected mid-rendezvous is ignored and the barrier completes with the real peer", async () => {
  // The lockless counterpart: a `-hello.json` (empty recovered id) appearing in
  // the ack-handshake barrier alongside the real peer's hello must not be counted
  // as a peer hello. The barrier must ack and complete against the real peer,
  // never committing peerId="". Were the empty-id hello counted, the barrier's
  // own >1 guard would abort with "more than one peer hello".
  const peerId = "00000000-0000-4000-8000-000000000001";
  const myId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 2_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = myId;
  conn.connected = true;
  conn.path = "/shared";

  const peerHello = `${peerId}-hello.json`;
  const locklessHelloBody = Buffer.from(
    JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
  );
  files.set(`/shared/${peerHello}`, locklessHelloBody);
  // The peer's ack of THIS party's hello: `${peerId}-${myId}-hello-ack.json`.
  const peerAck = `${peerId}-${myId}-hello-ack.json`;

  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, write own hello and enter the barrier
    const base = [
      { name: `${myId}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: peerHello, modifyTime: Date.now(), size: 0 },
      { name: "-hello.json", modifyTime: Date.now(), size: 0 },
    ];
    // From the second barrier listing on, the peer's ack of our hello is visible,
    // so the barrier completes (the first barrier pass writes our ack and loops).
    if (listCallCount >= 3)
      base.push({ name: peerAck, modifyTime: Date.now(), size: 0 });
    return base;
  };

  await conn.synchronize();

  // Completed against the real peer; the empty-id hello was never adopted.
  expect(conn.peerId).toBe(peerId);
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
  // The name is what the operator acts on, so it is asserted where they read
  // it: the display boundary truncates each cause-chain link.
  expect(sanitizeErrorForDisplay(err)).toContain(staleName);
  // Not swept by the guard: the operator clears the directory after confirming
  // no live session is using it.
  expect(files.has(`${conn.path}/${staleName}`)).toBe(true);
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

  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("initiator");
  const helloInStore = [...files.keys()].find((p) =>
    p.endsWith(`/${myHelloName}`),
  );
  expect(helloInStore).toBeDefined();
});

// --- synchronize(): lockless mode ---------------------------------------------

test("synchronize() lockless mode role assignment matches the lexicographic rule for the same id pair as the lock path", async () => {
  // Role must be determined by lexicographic id order regardless of arrival
  // timing. The throwing delete/createExclusive is robustness scaffolding --
  // the ack-handshake barrier must complete rendezvous even under the most
  // extreme constraint -- while real lockless transports support delete.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";

  const { connA, connB } = makeRendezvousPair(
    idA,
    { locklessRendezvous: true },
    idB,
    { locklessRendezvous: true },
    {
      client: { deleteBehavior: "throw", createExclusiveBehavior: "throw" },
      timeToLiveMs: 5_000,
      pollingFrequency: 10,
    },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // idA < idB: A arrived "first" by lexicographic order.
  expect(connA.handshakeRole).toBe("responder");
  expect(connA.role).toBe("starter");
  expect(connB.handshakeRole).toBe("initiator");
  expect(connB.role).toBe("joiner");
});

test("synchronize() lockless mode joiner fast-path is skipped; lockless barrier is entered even with peer hello already present", async () => {
  // The throwing delete proves the joiner fast-path (which calls delete) is
  // not taken in lockless mode; the no-op safeDelete is scaffolding only --
  // real lockless transports support delete.
  //
  // When locklessRendezvous is set and a party's entry list() (or barrier
  // loop) finds the peer's hello, it must not take the joiner shortcut
  // (unsupported delete on a lockless transport) but instead write its own
  // hello and enter the lockless ack-handshake barrier.
  //
  // Both parties start against an empty directory and run concurrently, so
  // the slower-to-list party sees the peer hello already present, exercising
  // that path. A's hello is not pre-planted: a party's own hello never
  // predates its own synchronize() call.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";

  let deleteCalled = false;
  const { connA, connB, files } = makeRendezvousPair(
    idA,
    { locklessRendezvous: true },
    idB,
    { locklessRendezvous: true },
    {
      client: {
        deleteBehavior: "throw",
        createExclusiveBehavior: "throw",
        onDelete: () => {
          deleteCalled = true;
        },
      },
      timeToLiveMs: 5_000,
      pollingFrequency: 10,
    },
  );

  // Run A and B concurrently against the empty directory: each writes its own
  // hello and enters the lockless barrier, and the slower-to-list party sees
  // the peer hello already present.
  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Neither party should have called delete (unsupported on lockless transport).
  expect(deleteCalled).toBe(false);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // Lockless never deletes a hello: both remain in the directory.
  expect(files.has(`/test/${idA}-hello.json`)).toBe(true);
  expect(files.has(`/test/${idB}-hello.json`)).toBe(true);
});

test("synchronize() lockless timeout message has no role prefix", async () => {
  // The lockless-barrier timeout fires while the role is indeterminate
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
  // Tagged as a peer-wait timeout so a consumer that also knows the run swept
  // the shared folder at entry can offer that as the likely cause.
  expect(isPeerWaitTimeout(err)).toBe(true);
});

test("synchronize() lockless mode throws when more than one peer hello is detected during the poll loop", async () => {
  // Regression guard for the lockless loop's multi-peer-hello guard: mirrors
  // the lock path's otherFiles.length > 1 check and catches a third party
  // that slipped in after the initial synchronize() guard.
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
  // The hello publish must succeed (put then rename, neither reflected into the
  // store the stubbed list() above bypasses); delete/safeDelete are no-ops.
  client.put = async () => {};
  client.rename = async () => {};
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
  // The hello publish must succeed (put then rename, neither reflected into the
  // store the stubbed list() above bypasses).
  client.put = async () => {};
  client.rename = async () => {};
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

// --- control file envelope: round-trip, partial-sync gate, malformed body -----

test("synchronize() lockless mode: round-trip hello body and zero-length ack markers", async () => {
  // Both parties write a hello containing the bilateral-flag envelope and a
  // zero-length ack marker named after the peer hello they acknowledge. The
  // hello is read through the gate; the ack is matched by name existence only.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  // Throwing createExclusive forces the lockless ack-handshake barrier instead
  // of the lock/EEXIST fast-path; delete stays real (baseline).
  const { connA, connB, files } = makeRendezvousPair(
    idA,
    { locklessRendezvous: true },
    idB,
    { locklessRendezvous: true },
    {
      client: { createExclusiveBehavior: "throw" },
      timeToLiveMs: 5_000,
      pollingFrequency: 10,
    },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  for (const id of [idA, idB]) {
    const helloBody = JSON.parse(
      files.get(`/test/${id}-hello.json`)!.toString(),
    );
    expect(helloBody).toMatchObject({
      locklessRendezvous: true,
      retainFiles: false,
    });
  }
  // A acked B's hello; B acked A's hello. Each marker is named after the
  // acknowledged hello and is zero bytes (no envelope body).
  const ackAofB = files.get(`/test/${idA}-${idB}-hello-ack.json`);
  expect(ackAofB).toBeDefined();
  expect(ackAofB!.length).toBe(0);
  const ackBofA = files.get(`/test/${idB}-${idA}-hello-ack.json`);
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
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const ackGets: string[] = [];
  // Record only ack-file reads through get(); throwing createExclusive forces
  // the lockless barrier so the ack path is exercised.
  const { connA, connB } = makeRendezvousPair(
    idA,
    { locklessRendezvous: true },
    idB,
    { locklessRendezvous: true },
    {
      client: {
        createExclusiveBehavior: "throw",
        onGet: (path) => {
          if (path.endsWith("-ack.json")) ackGets.push(path);
        },
      },
      timeToLiveMs: 5_000,
      pollingFrequency: 10,
    },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
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
  // peer hello is visible -- no self hello -- triggering the theseFiles===0 branch.
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

test("synchronize() sweeps an orphaned temp file at the entry guard and does not abort", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    // Short TTL: with no peer hello the conn writes its own hello, enters the
    // rendezvous wait, and times out with a transport Error -- never the
    // strict-empty UsageError, which the guard would have thrown synchronously
    // had the temp not been swept.
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const tempPath = `/test/temp-11111111-1111-4111-8111-111111111111.tmp`;
  files.set(tempPath, Buffer.alloc(0));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // The guard did not abort on the temp's account: the error is the rendezvous
  // timeout (a transport Error), not the strict-empty UsageError.
  expect(err).not.toBeInstanceOf(UsageError);
  // The orphan was swept via safeDelete and is gone from the store.
  expect(safeDeleted).toContain(tempPath);
  expect(files.has(tempPath)).toBe(false);
});

test("synchronize() leaves a temp-free directory unaffected by the sweep", async () => {
  // No temp-*.tmp present: the sweep is a transparent no-op. The conn proceeds
  // exactly as before -- past the guard, into the rendezvous wait, timing out
  // with a transport Error rather than a UsageError -- and the sweep deletes no
  // .tmp file. (The lone safeDelete on this path is the outer catch sweeping
  // this party's own .json hello on the timeout, which the sweep never touches.)
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard into the rendezvous wait (a timeout Error), rather
  // than being rejected there with the strict-empty UsageError.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(String(err)).toContain("timed out");
  expect(safeDeleted.filter((p) => p.endsWith(".tmp"))).toHaveLength(0);
});

test("synchronize() sweeps a temp file alongside a single peer hello and completes rendezvous", async () => {
  // A temp-<uuid>.tmp orphan coexists with a lone peer hello. The sweep removes
  // the temp and excludes it from the I0 guard; the peer hello remains the one
  // tolerated entry file (per I0), so the joiner fast-path completes rendezvous
  // instead of the guard rejecting the directory as non-empty.
  const myId = "00000000-0000-4000-8000-000000000001";
  const peerId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const tempPath = `${conn.path}/temp-22222222-2222-4222-9222-222222222222.tmp`;
  const peerHelloPath = `${conn.path}/${peerId}-hello.json`;
  files.set(tempPath, Buffer.alloc(0));
  files.set(peerHelloPath, LOCK_HELLO_BODY);

  await conn.synchronize();

  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  expect(files.has(tempPath)).toBe(false);
  expect(files.has(peerHelloPath)).toBe(false);
  expect(files.has(`${conn.path}/${myId}-hello.json`)).toBe(true);
});

test("synchronize() sweeps multiple orphaned temp files at the entry guard", async () => {
  // The spec's motivating case: temp artifacts accumulate across several crashed
  // exchanges (distinct uuids). All are swept in one entry and none aborts the
  // guard -- exercising the N>1 path (Promise.all over many, the plural log
  // branch, multiple `ignored` entries) the single-temp tests above do not.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const tempPaths = [
    `/test/temp-33333333-3333-4333-a333-333333333333.tmp`,
    `/test/temp-44444444-4444-4444-b444-444444444444.tmp`,
    `/test/temp-55555555-5555-4555-8555-555555555555.tmp`,
  ];
  for (const p of tempPaths) files.set(p, Buffer.alloc(0));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Entry proceeded past the guard (a timeout Error), not rejected as non-empty.
  expect(err).not.toBeInstanceOf(UsageError);
  // Every orphan was swept via safeDelete and is gone from the store.
  for (const p of tempPaths) {
    expect(safeDeleted).toContain(p);
    expect(files.has(p)).toBe(false);
  }
});

test("synchronize() does NOT sweep a foreign temp-*.tmp whose stem is not a UUID; it is tolerated as foreign", async () => {
  // The entry sweep matches only the protocol's own
  // temp-<uuidv4()>.tmp shape, so a foreign `temp-export.tmp` (a user or
  // sync-tool file in a namespace collision) is NOT deleted. It fails the
  // protocol grammar, so it is snapshotted and tolerated exactly as notes.txt
  // is -- the data-loss the broad `temp-`/`.tmp` match could cause is gone.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const foreignTempPath = "/test/temp-export.tmp";
  files.set(foreignTempPath, Buffer.from("unrelated"));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard (a timeout Error), tolerating the foreign temp.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(safeDeleted).not.toContain(foreignTempPath);
  expect(files.has(foreignTempPath)).toBe(true);
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("temp-export.tmp")).toBe(true);
});

test("synchronize() does NOT sweep a foreign temp whose stem is an UPPERCASE v4 UUID", async () => {
  // The uuid package's validate() uses the /i flag, so an
  // uppercase-but-syntactically-valid v4 stem would pass a bare validate(); but
  // uuidv4() only ever emits lowercase, so the protocol's own temp is always
  // lowercase. A foreign temp-<UPPERCASE-v4>.tmp must therefore be treated as
  // foreign (not swept), closing the residual case-collision data-loss window.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  // A valid v4 UUID in uppercase -- accepted by a case-insensitive validate(),
  // rejected by the lowercase-only protocol-temp match.
  const foreignTempPath = "/test/temp-953D0248-D2F0-46F2-94DC-5082EED218F9.tmp";
  files.set(foreignTempPath, Buffer.from("unrelated"));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard, tolerating the uppercase-stem foreign temp.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(safeDeleted).not.toContain(foreignTempPath);
  expect(files.has(foreignTempPath)).toBe(true);
  // Recording it in the entry snapshot is what makes the poll loop tolerate it
  // for the rest of the session.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("temp-953D0248-D2F0-46F2-94DC-5082EED218F9.tmp")).toBe(
    true,
  );
});

test("synchronize() re-arms a fresh controller per session so a retry's waits stay live (D1)", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 60_000,
    peerTimeoutMs: 50,
  });
  conn.id = "starter";

  // Simulate a controller left aborted by a prior life (the state a failed-then-
  // retried session must recover from). Without the re-arm at synchronize()
  // entry, waitForPeer's first this.wait would observe this aborted signal and
  // reject immediately instead of polling for the peer.
  (
    conn as unknown as { abortController: AbortController }
  ).abortController.abort(new ConnectionClosedError("stale"));

  // The peer hello appears after a few empty polls, so the rendezvous parks in
  // this.wait (against the re-armed controller) before completing.
  setTimeout(() => {
    files.set("/test/other-hello.json", LOCK_HELLO_BODY);
  }, 40);

  await expect(conn.synchronize()).resolves.toBeUndefined();
  expect(conn.peerId).toBe("other");
});

// A hello body advertising retain mode (lockless + retain), planted as a peer
// hello so the pre-sweep inspection reads it as a retain signal.
const RETAIN_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: true, retainFiles: true }),
);

test("synchronize() default: an unexpected protocol file is exit-64 and points at --sweep-exchange-files", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  // A stale rendezvous hello-ack: a protocol-grammar file that is not the one
  // tolerated peer hello, so the default entry guard rejects it.
  files.set("/test/old-peer-old-hello-ack.json", Buffer.alloc(0));

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  // Asserted on the rendered string, not the raw message: the display boundary
  // truncates each cause-chain link, so a raw-message assertion passes on text
  // the operator is never shown.
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered).toContain("old-peer-old-hello-ack.json");
  expect(rendered).toContain("--sweep-exchange-files");
  expect(files.has("/test/old-peer-old-hello-ack.json")).toBe(true);
});

test("synchronize() default: a message-shaped <id>-<digits>.json is rejected at entry, not snapshotted (Reading A)", async () => {
  // A message-shaped name MATCHES the protocol grammar, so it is a protocol
  // file, not a foreign file: the default guard rejects it at entry rather than
  // snapshotting it and letting it reach poll().
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  files.set("/test/peer-12345.json", Buffer.from("stale"));

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect(sanitizeErrorForDisplay(err)).toContain("peer-12345.json");
  // Grammar-matching names are never recorded in the foreign snapshot.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("peer-12345.json")).toBe(false);
});

test("synchronize() default: a foreign file is tolerated, snapshotted, and not deleted", async () => {
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set("/test/notes.txt", Buffer.from("unrelated"));
  client.list = async () => [
    {
      name: peerHelloName,
      modifyTime: Date.now(),
      size: LOCK_HELLO_BODY.length,
    },
    { name: "notes.txt", modifyTime: Date.now(), size: 9 },
  ];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(files.has("/test/notes.txt")).toBe(true);
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("notes.txt")).toBe(true);
});

test("synchronize() --sweep-exchange-files: sweeps stale delete-mode protocol files and passes the entry guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Stale delete-mode residue: a lock and a rendezvous hello-ack (NOT a retain
  // signal -- the pre-`ack` segment is `hello`, not a numeric byte count).
  files.set("/test/x-y-lock.json", Buffer.alloc(0));
  files.set("/test/a-b-hello-ack.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // Got past the entry guard (no UsageError); the initiator then timed out
  // waiting for a peer on the swept-clean directory.
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/x-y-lock.json");
  expect(deleted).toContain("/test/a-b-hello-ack.json");
  expect(files.has("/test/x-y-lock.json")).toBe(false);
  expect(files.has("/test/a-b-hello-ack.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) on a peer hello advertising retain_files=true, without deleting it", async () => {
  const peerId = "peer-uuid";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // delete-mode party, bare flag
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY);

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain/i);
  expect((err as Error).message).toContain("--force-retain-sweep");
  expect(deleted).toHaveLength(0);
  expect(files.has(`/test/${peerHelloName}`)).toBe(true);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) on a retain-only message ack, without deleting it", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // A retain-only message ack the peer wrote for a message this party sent. A
  // retain message is always timestamped (<id>-<ts>-<NNN>-<byteCount>.json), so
  // its ack ends in two all-digit segments (NNN then byte count) -- both
  // required, vs `hello` for a rendezvous hello-ack, which is not a retain
  // signal.
  const ackName = "peer-me-20260101T000000-000-100-ack.json";
  files.set(`/test/${ackName}`, Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(ackName);
  expect((err as Error).message).toContain("--force-retain-sweep");
  expect(deleted).toHaveLength(0);
  expect(files.has(`/test/${ackName}`)).toBe(true);
});

test("synchronize() --sweep-exchange-files: a `-ack.json` lacking two trailing digit segments is swept, not read as a retain signal", async () => {
  // Regression for the isRetainMessageAck false positive. A real retain message
  // ack ends in <NNN>-<byteCount>, two digit segments. Neither of these is one:
  // notes-5-ack.json has a non-digit leading segment, and 100-ack.json has only
  // ONE segment before -ack.json (the off-by-one case where the lastIndexOf
  // arithmetic mis-sliced "100" -> "10" and wrongly matched). Both match the
  // broad `-ack.json` grammar (so they are unexpected protocol files, swept
  // under the flag) but neither is a retain signal: the bare flag must proceed
  // and delete them, not refuse for --force-retain-sweep.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // delete-mode party, bare flag
  files.set("/test/notes-5-ack.json", Buffer.alloc(0));
  files.set("/test/100-ack.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // No retain refusal: it swept both files and then timed out waiting for a peer
  // (a transport Error, never a UsageError).
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/notes-5-ack.json");
  expect(deleted).toContain("/test/100-ack.json");
  expect(files.has("/test/notes-5-ack.json")).toBe(false);
  expect(files.has("/test/100-ack.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) when this party is in retain mode", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Local retain mode is itself a retain signal; set the flags it implies so the
  // synchronize() retain preconditions do not fire first.
  conn.options.retainFiles = true;
  conn.options.locklessRendezvous = true;
  conn.options.timestampInFilename = true;
  files.set("/test/me-100-0-50.json", Buffer.from("stale transcript"));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain/i);
  expect((err as Error).message).toContain("--force-retain-sweep");
  expect(deleted).toHaveLength(0);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: wipes the retain transcript with a danger warning", async () => {
  const peerId = "peer-uuid";
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true; // delete-mode party forcing a retain sweep
    const peerHelloName = `${peerId}-hello.json`;
    files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY);

    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // The wipe succeeds; the delete-mode initiator then times out waiting for a
    // peer on the now-empty directory.
    await conn.synchronize().catch(() => {});
    expect(files.has(`/test/${peerHelloName}`)).toBe(false);
  });
  expect(deleted.some((p) => p.includes(`${peerId}-hello.json`))).toBe(true);
  const warning = logs.find((l) =>
    /force-retain-sweep|destructive and irreversible/i.test(l.message),
  );
  expect(warning).toBeDefined();
  // The warning identifies the party by id, not the pre-rendezvous sentinel
  // (the sweep runs before this.role is assigned).
  expect(warning?.message).toContain("[me]");
  expect(warning?.message).not.toContain("unknown role");
});

test("synchronize() --sweep-exchange-files: a delete failure shows as a transport error (exit 69), not silent success", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  files.set("/test/x-y-lock.json", Buffer.alloc(0)); // stale, no retain signal
  // Transport cannot delete: client.delete rejects (unlike safeDelete, which
  // swallows). The sweep must report that, not silently claim a clean slate.
  client.delete = async () => {
    throw new Error("transport refused delete");
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError); // -> CLI exit 69, not 64
  expect((err as Error).message).toContain("transport refused delete");
});

test("synchronize() --sweep-exchange-files: one delete failure still attempts every other delete and names the failure", async () => {
  // allSettled, not all: a single rejection must not abandon the other deletes
  // mid-flight. Every delete is attempted, and the reported error names the
  // file that failed (and is a transport error -> exit 69, not a UsageError).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Three stale protocol files, no retain signal. The middle one cannot be
  // deleted; the other two must still be attempted and removed.
  files.set("/test/a-b-lock.json", Buffer.alloc(0));
  files.set("/test/peerA-hello.json", LOCK_HELLO_BODY);
  files.set("/test/peerB-hello.json", LOCK_HELLO_BODY);

  const attempted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    attempted.push(p);
    if (p.endsWith("a-b-lock.json"))
      throw new Error("transport refused delete");
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("a-b-lock.json");
  expect(attempted).toHaveLength(3);
  expect(files.has("/test/peerA-hello.json")).toBe(false);
  expect(files.has("/test/peerB-hello.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: a non-resolving peer hello is retain-uncertain and refuses the bare flag (bounded)", async () => {
  const peerId = "peer-uuid";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY); // present in the listing...
  // ...but its body never finishes syncing: every get() for it throws, so the
  // bounded gate exhausts its budget and the read is treated as retain-uncertain.
  const origGet = client.get.bind(client);
  client.get = async (p: string) => {
    if (p.endsWith(peerHelloName)) throw new Error("partial sync");
    return origGet(p);
  };

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const start = Date.now();
  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  const elapsed = Date.now() - start;
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain-uncertain|did not resolve/i);
  expect(deleted).toHaveLength(0);
  // Bounded: it refused within a couple of poll cycles, not the peer timeout.
  expect(elapsed).toBeLessThan(2_000);
});

test("synchronize() --sweep-exchange-files: the retain inspection stops at the first unreadable hello", async () => {
  // Short-circuit: once a hello body cannot be read, retain-uncertainty is sticky
  // and the decision (refuse on the bare flag, warn under --force) is fixed, so
  // the inspection must not read later hellos -- a hostile directory of
  // unreadable hellos cannot be made to cost one network read apiece.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  const firstHello = "peerA-hello.json";
  const secondHello = "peerB-hello.json";
  files.set(`/test/${firstHello}`, RETAIN_HELLO_BODY);
  files.set(`/test/${secondHello}`, RETAIN_HELLO_BODY);

  const bodyReads: string[] = [];
  const origGet = client.get.bind(client);
  client.get = async (p: string) => {
    bodyReads.push(p);
    if (p.endsWith(firstHello)) throw new Error("partial sync");
    return origGet(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain-uncertain|did not resolve/i);
  expect(bodyReads.some((p) => p.endsWith(firstHello))).toBe(true);
  expect(bodyReads.some((p) => p.endsWith(secondHello))).toBe(false);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: an earlier unreadable hello shadows a later malformed one and the forced sweep proceeds", async () => {
  const peerA = "peerA-hello.json"; // unreadable: body never finishes syncing
  const peerB = "peerB-hello.json"; // fully synced but malformed (not a HelloEnvelope)
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true;
    files.set(`/test/${peerA}`, RETAIN_HELLO_BODY);
    files.set(`/test/${peerB}`, Buffer.from("{}")); // missing required flags

    const origGet = client.get.bind(client);
    client.get = async (p: string) => {
      if (p.endsWith(peerA)) throw new Error("partial sync");
      return origGet(p);
    };
    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // Proceeds past the malformed peerB instead of aborting, then times out
    // waiting for a real peer on the now-clean directory.
    await conn.synchronize().catch(() => {});
  });
  expect(deleted.some((p) => p.endsWith(peerA))).toBe(true);
  expect(deleted.some((p) => p.endsWith(peerB))).toBe(true);
  expect(
    logs.some((l) =>
      /force-retain-sweep|destructive and irreversible/i.test(l.message),
    ),
  ).toBe(true);
});

test("synchronize() --sweep-exchange-files: sweeps a second peer hello, overriding the I1 concurrent-session guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Two peer hellos -- without the flag this is the I1 "other sessions using
  // this path?" error. Both advertise delete mode, so there is no retain signal
  // and the bare flag sweeps them.
  files.set("/test/peerA-hello.json", LOCK_HELLO_BODY);
  files.set("/test/peerB-hello.json", LOCK_HELLO_BODY);

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // No I1 error: both peer hellos were swept and the initiator then timed out.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/peerA-hello.json");
  expect(deleted).toContain("/test/peerB-hello.json");
});

test("synchronize() --sweep-exchange-files: a bare empty-id hello is swept, not adopted as the peer hello", async () => {
  // A planted "-hello.json" has an empty id. It must be treated as an unexpected
  // protocol file (swept under the flag), never adopted as a peer hello -- which
  // would otherwise commit rendezvous to peerId="".
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  files.set("/test/-hello.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // Swept (not adopted), then the initiator timed out waiting for a real peer.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/-hello.json");
  expect(files.has("/test/-hello.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: no danger warning when there is nothing to delete", async () => {
  // Local retain mode is the only retain signal and the directory holds no peer
  // protocol files, so the sweep deletes nothing. The danger warning must not
  // fire (it would otherwise claim to permanently delete 0 protocol files).
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true;
    // Local retain mode (the lone signal); set the flags it implies so the
    // synchronize() retain preconditions do not fire first.
    conn.options.retainFiles = true;
    conn.options.locklessRendezvous = true;
    conn.options.timestampInFilename = true;

    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // Empty directory: nothing to sweep, then the initiator times out.
    await conn.synchronize().catch(() => {});
  });
  expect(deleted).toHaveLength(0);
  expect(
    logs.filter((l) =>
      /permanently deleting|destructive and irreversible/i.test(l.message),
    ),
  ).toHaveLength(0);
});

test("synchronize() --sweep-exchange-files: a close() during the retain-signal inspection shows as a clean shutdown, not retain-uncertain", async () => {
  // A close() racing the bounded hello-body inspection aborts the gate read with
  // the ConnectionClosedError reason. That must propagate as a clean shutdown
  // (exit 69), NOT be masked as a retain-uncertain UsageError (exit 64).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    // Large frequency so the gate parks on its retry backoff until the abort.
    pollingFrequency: 10_000,
    timeToLiveMs: 60_000,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // bare flag, delete-mode party
  // A peer hello is present, so the inspection enters the gate read; get() parks
  // (always throws) so the gate retries via cancellableDelay until the abort.
  files.set("/test/peer-hello.json", RETAIN_HELLO_BODY);
  let reachedGate!: () => void;
  const parked = new Promise<void>((r) => (reachedGate = r));
  client.get = async () => {
    reachedGate();
    throw new Error("partial sync; retry");
  };

  const outcome = conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  await parked;
  await expect(conn.close()).resolves.toBeUndefined();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  expect(err).not.toBeInstanceOf(UsageError);
});

// Helper: a retain/lockless split connection placed directly into the
// post-open, pre-rendezvous state (mirrors makeRetainConn but with distinct
// inbound and outbound directories and without a pre-set peerId, so
// synchronize() runs).
function makeSplitConn(
  client: FileTransportClient,
  id: string,
  inbound: string,
  outbound: string,
  timeToLiveMs = 1_000,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
    peerId: id,
  });
  conn.connected = true;
  conn.path = inbound;
  conn.outbound = outbound;
  return conn;
}

test("synchronize() (split): a non-fresh OUTBOUND directory fails the clean-start guard", async () => {
  // The fresh-directory enforcement applies to BOTH halves: a leftover self
  // message in the outbound directory is a terminal usage error even though the
  // inbound directory is clean.
  const { client, files } = makeMockClient();
  files.set("/out/me-20260101T000000-000-12.json", Buffer.from("x".repeat(12)));
  const conn = makeSplitConn(client, "me", "/in", "/out");

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() (split): an orphaned temp in the OUTBOUND directory is swept, not rejected", async () => {
  // A crashed in-flight write (temp-<uuidv4()>.tmp) in outbound is swept at
  // entry like the inbound one, so it never trips the clean-start guard; the
  // rendezvous then times out only because no peer arrives.
  const { client, files } = makeMockClient();
  const tempName = "temp-00000000-0000-4000-8000-000000000000.tmp";
  files.set(`/out/${tempName}`, Buffer.alloc(0));
  const conn = makeSplitConn(client, "me", "/in", "/out", 80);

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("timed out");
  expect(files.has(`/out/${tempName}`)).toBe(false);
});

test("synchronize() (split): a configured outbound without retain mode is rejected", async () => {
  // Library-level defense-in-depth: the config schema rejects split-without-
  // retain, but a direct caller that sets conn.outbound without retainFiles must
  // still be stopped before reaching a lock/delete path that would rename across
  // the two directories.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 1_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    // retainFiles intentionally omitted (defaults to false)
  });
  conn.connected = true;
  conn.path = "/in";
  conn.outbound = "/out";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});
