import fs from "node:fs/promises";
import path from "node:path";

import { EventEmitter } from "node:events";

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  FileSyncConnection,
  FrameSizeExceededError,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";
import Ssh2SftpClient from "ssh2-sftp-client";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend } from "../sftpServer";
import {
  ensureNamespace,
  localPath,
  publicKeyAuth,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";

import log from "loglevel";

log.setLevel(log.levels.DEBUG);

// The test SFTP server serves a fresh per-run directory; this file rendezvouses
// in its `sftp` namespace. SFTP_LOCAL_DIRECTORY is the host directory the server
// serves (where the oversize-read test plants its file straight onto disk), and
// SFTP_PATH is the path the client connects to -- which differs by backend, so
// both come from the running server rather than a fixed path. ensureNamespace
// creates the host directory before any party connects, since the connection
// does not create remote directories.
const srv = sftpServer();
const NS = "sftp";
const SFTP_LOCAL_DIRECTORY = localPath(srv, NS);
const SFTP_PATH = remotePath(srv, NS);

// The wrapper-crash and ssh2-lifecycle contract assertions exercise the
// in-process backend's real ssh2 wrapper and a synthetic fatal emit; the native
// sshd backend validates the real-server happy path and auth instead, so they
// are tagged to run only in-process.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

async function cleanServer() {
  for (const file of await fs.readdir(SFTP_LOCAL_DIRECTORY)) {
    try {
      await fs.unlink(path.join(SFTP_LOCAL_DIRECTORY, file));
    } catch {
      // ignore
    }
  }
}

function desynchronize(conn: FileSyncConnection) {
  conn.peerId = undefined;
  conn.handshakeRole = undefined;
  conn.role = "unknown";
}

// Poll a predicate until it holds (no fixed sleep), failing if it never does.
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

// A freshly-created, exclusively-owned rendezvous directory under the served
// root, for tests that stand up their own connections. The shared `sftp`
// namespace is reused by the persistent serverConn/clientConn across the first
// tests; a test that opens a new exchange on that same path can trip the
// directory-exclusivity guard on a stray message or lock file a prior test's
// still-settling poll/close left behind -- a window the restricted-crypto
// native-sshd profile widens via its slower handshake (board item 200576628).
// Giving each such test its own mkdtemp directory isolates it from that residue.
// Returns the remote path to connect to and records the host directory for
// teardown in afterAll, so the per-test directories do not pile up under the
// served root over the run.
const rendezvousDirs: string[] = [];

async function freshRendezvous(): Promise<string> {
  const local = await fs.mkdtemp(path.join(srv.backingDir, "sftp-"));
  rendezvousDirs.push(local);
  return remotePath(srv, path.basename(local));
}

afterAll(async () => {
  await Promise.all(
    rendezvousDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const serverSFTP = new SSH2SFTPClientAdapter();
const serverConn = new FileSyncConnection(serverSFTP, { verbose: -1 });
const clientSFTP = new SSH2SFTPClientAdapter();
const clientConn = new FileSyncConnection(clientSFTP, { verbose: -1 });

serverConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});
clientConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});

beforeAll(async () => {
  await ensureNamespace(srv, NS);
  await cleanServer();
  await Promise.all([
    serverConn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: SFTP_PATH,
      },
    }),
    clientConn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.userb),
        path: SFTP_PATH,
      },
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([clientConn.close(), serverConn.close()]);
  await cleanServer();
});

// to test race condition, Promise.all is used when synchronizing
// to set an explicit order, one party is delayed a tick by using setImmediate

test("lock synchronization with race condition", async () => {
  await Promise.all([serverConn.synchronize(), clientConn.synchronize()]);

  const currentFiles = await serverSFTP.list(SFTP_PATH);

  expect(serverConn.peerId).toEqual(clientConn.id);
  expect(clientConn.peerId).toEqual(serverConn.id);
  expect(serverConn.handshakeRole !== clientConn.handshakeRole).toBe(true);

  expect(currentFiles.length).toEqual(0);

  desynchronize(serverConn);
  desynchronize(clientConn);
});

test("basic synchronization", async () => {
  await serverSFTP.put(
    // The planted peer hello must advertise the bilateral mode flags
    // (193901017); an empty {} body now fails the HelloEnvelope schema. Both
    // parties run default lock mode, so both flags are false.
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${SFTP_PATH}/${clientConn.id}-hello.json`,
  );

  await serverConn.synchronize();

  const currentFiles = await serverSFTP.list(SFTP_PATH);

  await serverSFTP.safeDelete(`${SFTP_PATH}/${serverConn.id}-hello.json`);

  expect(serverConn.peerId).toBe(clientConn.id);
  expect(serverConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name === `${serverConn.id}-hello.json`).toBe(true);

  desynchronize(serverConn);
});

test("message deliverable", async () => {
  const serverSyncPromise = serverConn.synchronize();
  setImmediate(async () => {
    await clientConn.synchronize();
  });
  await serverSyncPromise;

  serverConn.start();

  const serverMessagePromise = new Promise((resolve) => {
    serverConn.once("data", (data: unknown) => {
      resolve(data);
    });
  });

  await clientConn.send({ message: "hello world" });
  const message = await serverMessagePromise;

  serverConn.stop();

  desynchronize(serverConn);
  desynchronize(clientConn);

  expect(message).toEqual({ message: "hello world" });
});

test("public-key authentication connects and runs a rendezvous", async () => {
  // Net-new coverage: public-key auth is a distinct connect path (a private key
  // rather than a password) and the representative method for unattended
  // transfers, which the password-driven tests above never exercise. Both
  // backends surface a per-party private key, so this leg runs on either.
  const keyServerSFTP = new SSH2SFTPClientAdapter();
  const keyServerConn = new FileSyncConnection(keyServerSFTP, { verbose: -1 });
  const keyClientConn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
  });
  keyServerConn.on("error", (err: unknown) => {
    throw new Error(String(err));
  });
  keyClientConn.on("error", (err: unknown) => {
    throw new Error(String(err));
  });

  const remote = await freshRendezvous();
  try {
    await Promise.all([
      keyServerConn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          ...publicKeyAuth(srv.usera),
          path: remote,
        },
      }),
      keyClientConn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          ...publicKeyAuth(srv.userb),
          path: remote,
        },
      }),
    ]);

    await Promise.all([
      keyServerConn.synchronize(),
      keyClientConn.synchronize(),
    ]);

    expect(keyServerConn.peerId).toEqual(keyClientConn.id);
    expect(keyClientConn.peerId).toEqual(keyServerConn.id);

    keyServerConn.start();
    const received = new Promise((resolve) =>
      keyServerConn.once("data", resolve),
    );
    await keyClientConn.send({ message: "over public key" });
    expect(await received).toEqual({ message: "over public key" });
    keyServerConn.stop();
  } finally {
    await Promise.all([keyServerConn.close(), keyClientConn.close()]);
  }
});

test("terminal frame is received when sender closes before receiver polls", async () => {
  // Regression guard for the terminal-frame deletion race: the sender's
  // close() must drain (wait for the receiver to consume the last sent file)
  // before running cleanup. This test sends a message, starts the receiver
  // polling concurrently with sender close(), and verifies the message arrives.
  // Without the drain, cleanup() deletes the file before the receiver polls and
  // the message is lost.

  const senderSFTP = new SSH2SFTPClientAdapter();
  const senderConn = new FileSyncConnection(senderSFTP, { verbose: -1 });
  const receiverSFTP = new SSH2SFTPClientAdapter();
  const receiverConn = new FileSyncConnection(receiverSFTP, { verbose: -1 });

  const remote = await freshRendezvous();
  const base = {
    channel: "sftp" as const,
    server: { host: srv.host, port: srv.port, path: remote },
  };

  await Promise.all([
    senderConn.open({
      ...base,
      server: { ...base.server, ...serverAuth(srv.usera) },
    }),
    receiverConn.open({
      ...base,
      server: { ...base.server, ...serverAuth(srv.userb) },
    }),
  ]);

  await Promise.all([senderConn.synchronize(), receiverConn.synchronize()]);

  await senderConn.send({ terminal: true });

  const received = new Promise<unknown>((resolve) => {
    receiverConn.once("data", resolve);
  });

  // Start the receiver polling concurrently with sender close().
  // The drain in close() holds cleanup until the receiver consumes the file.
  receiverConn.start();
  await senderConn.close();

  const message = await received;

  receiverConn.stop();
  await receiverConn.close();

  expect(message).toEqual({ terminal: true });
});

test("lock starter aborts on a stuck mid-arrival joiner over real SFTP", async () => {
  // End-to-end recovery path on the real SFTP transport. A joiner writes its
  // sentinel and deletes the starter's hello, then crashes before renaming the
  // sentinel to its own hello. The starter must observe the orphaned sentinel
  // over real SFTP and abort on the bounded recovery window with the actionable
  // error -- not poll to the full peer timeout. (The happy-path sentinel
  // put/delete/rename runs under the hood whenever a real joiner arrives second
  // in the lock tests above; this exercises the failure side, which those do
  // not.)
  await cleanServer();

  const abortSFTP = new SSH2SFTPClientAdapter();
  // joinerRecoveryMs well under the peer timeout so the bounded-window abort
  // fires first; the 100 ms default poll keeps the abort prompt.
  const abortConn = new FileSyncConnection(abortSFTP, {
    verbose: -1,
    joinerRecoveryMs: 400,
  });
  await abortConn.open({
    channel: "sftp",
    server: {
      host: srv.host,
      port: srv.port,
      ...serverAuth(srv.usera),
      path: SFTP_PATH,
    },
    options: { peerTimeoutMs: 8_000 },
  });

  const fakeJoinerId = "00000000-0000-4000-8000-0000000000aa";
  const sentinelName = `${fakeJoinerId}-joining.json`;
  const helloName = `${abortConn.id}-hello.json`;

  // Start the starter without awaiting: it writes its hello and begins polling.
  const syncPromise = abortConn.synchronize();

  try {
    // Wait until the starter's hello has landed, then simulate the stuck joiner
    // using the already-connected serverSFTP session (a separate SFTP client, so
    // it does not contend with the starter's own polling on abortSFTP): delete
    // the hello and drop a sentinel from a different id in its place.
    await waitFor(async () =>
      (await serverSFTP.list(SFTP_PATH)).some((f) => f.name === helloName),
    );
    await serverSFTP.safeDelete(`${SFTP_PATH}/${helloName}`);
    await serverSFTP.put(
      Buffer.from(
        JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
      ),
      `${SFTP_PATH}/${sentinelName}`,
    );

    const err = await syncPromise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /did not complete within the recovery window/,
    );
    // Transport failure (CLI exit 69), not a usage error (exit 64) -- mirrors
    // the unit-test assertion so a regression that reclassified the abort would
    // be caught over the real transport too.
    expect(err).not.toBeInstanceOf(UsageError);
  } finally {
    await serverSFTP.safeDelete(`${SFTP_PATH}/${sentinelName}`);
    await abortConn.close();
    await cleanServer();
  }
});

test("get aborts and rejects a file larger than maxBytes", async () => {
  // Write an over-cap file directly into the server's served directory and read
  // it back through the adapter with a small cap. The streaming read must reject
  // with the typed frame-size error after buffering at most a chunk past the
  // cap, rather than downloading the whole file. Exercises the real SFTP
  // read-stream abort path against the server, with several chunks flowing
  // before the cap fires (cap > one chunk).
  const name = "oversize-frame.bin";
  const localFile = path.join(SFTP_LOCAL_DIRECTORY, name);
  await fs.writeFile(localFile, Buffer.alloc(1024 * 1024)); // 1 MiB
  try {
    await expect(
      serverSFTP.get(`${SFTP_PATH}/${name}`, { maxBytes: 256 * 1024 }),
    ).rejects.toBeInstanceOf(FrameSizeExceededError);
  } finally {
    await fs.unlink(localFile).catch(() => {});
  }
});

test("get returns a file at or under maxBytes unchanged", async () => {
  const name = "under-cap-frame.bin";
  const localFile = path.join(SFTP_LOCAL_DIRECTORY, name);
  const contents = Buffer.from("a small but real frame body");
  await fs.writeFile(localFile, contents);
  try {
    const buf = await serverSFTP.get(`${SFTP_PATH}/${name}`, {
      maxBytes: contents.length,
    });
    expect(Buffer.from(buf)).toEqual(contents);
  } finally {
    await fs.unlink(localFile).catch(() => {});
  }
});

inProcessOnly(
  "ssh2 hands back a raw SFTP wrapper carrying zero 'error' listeners of its own",
  async () => {
    // CONTRACT ASSERTION pinning the load-bearing premise of the wrapper-crash fix
    // (SSH2SFTPClientAdapter.attachFatalErrorListener), checked WITHOUT the adapter
    // so it isolates ssh2's own behavior. The fix attaches the process's only guard
    // against a hostile/dead server's malformed SFTP packet (which drives ssh2's
    // doFatalSFTPError -> sftp.emit('error', err)); Node turns an 'error' emit on a
    // listener-free EventEmitter into an uncaught exception that crashes the CLI.
    // That guard is only sufficient if ssh2 itself leaves the handed-back wrapper
    // with NO 'error' listener -- which today it does, because Client.sftp()'s
    // onReady calls removeListeners() to strip its setup-time 'error'/'exit'/'close'
    // handlers before handing the wrapper back (node_modules/ssh2/lib/client.js),
    // and ssh2-sftp-client attaches 'error' handlers only to the SSH Client and to
    // per-operation streams, never to the wrapper itself.
    //
    // If a future ssh2 stops stripping that listener (or otherwise retains one),
    // the wrapper would arrive with a listener already attached and this assertion
    // fails RED -- the only place that detects ssh2 silently changing the emit/
    // listener lifecycle the fix depends on. The companion assertion in the test
    // below (listenerCount === 1 after the ADAPTER connects) catches the same drift
    // from the other side: zero-from-ssh2 here, exactly-the-adapter's-one there.
    const raw = new Ssh2SftpClient();
    try {
      await raw.connect({
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        retries: 0,
      });
      // Reach the raw ssh2 SFTPWrapper exactly as the adapter does: ssh2-sftp-client
      // stores it on `this.sftp`. This is the same internal coupling the adapter
      // documents; pinning it here means an upgrade that breaks the premise fails in
      // this test rather than silently in production.
      const wrapper = (raw as unknown as { sftp: EventEmitter }).sftp;
      expect(wrapper.listenerCount("error")).toBe(0);
    } finally {
      await raw.end().catch(() => {});
    }
  },
);

inProcessOnly(
  "a fatal 'error' on the raw SFTP wrapper does not crash and fails terminally",
  async () => {
    // Regression guard for the wrapper-crash vector. After a real connect, the raw
    // ssh2 SFTPWrapper carries no 'error' listener of its own: ssh2's Client.sftp()
    // strips its setup-time listener before handing the wrapper back, and
    // ssh2-sftp-client attaches 'error' handlers only to the SSH Client and to
    // per-operation streams. A hostile/dead server that returns a malformed SFTP
    // reply drives ssh2's doFatalSFTPError -> sftp.emit('error', err); on a
    // listener-free EventEmitter Node turns that into an uncaught exception that
    // crashes the CLI, skipping lock/temp-file cleanup and the typed exit-code
    // mapping. The adapter must attach a guarded 'error' listener in connect() so
    // the emit is handled. This runs against the real ssh2-sftp-client wrapper
    // lifecycle (a real connect over the in-process server), so it locks in the
    // fix on the actual object whose listeners the bug is about.
    //
    // Determinism: Node throws on an 'error' event ONLY when the emitter has zero
    // listeners, so listener-presence plus a handled synthetic emit is a sufficient
    // and non-flaky proof -- no need to synthesize a malformed packet on the wire
    // (which would be timing-dependent). The synthetic Error mirrors doFatalSFTPError's
    // shape (a plain Error with level 'sftp-protocol').
    const crashSFTP = new SSH2SFTPClientAdapter();
    await crashSFTP.connect({
      host: srv.host,
      port: srv.port,
      ...serverAuth(srv.usera),
      maxReconnectAttempts: 0,
    });
    try {
      // Reach the raw wrapper the same way the adapter does, to assert against the
      // exact EventEmitter ssh2's doFatalSFTPError emits on.
      const wrapper = (
        crashSFTP as unknown as { client: { sftp: EventEmitter } }
      ).client.sftp;

      // The guarded listener is present: this is what keeps Node from throwing on
      // the 'error' event. Without the fix this count is 0 and the emit below would
      // crash the process. The count is EXACTLY 1, not >= 1, and the exactness is
      // load-bearing against ssh2 upgrade drift: the crash fix rests on ssh2's
      // Client.sftp() stripping its own setup-time 'error' listener (removeListeners
      // in onReady, node_modules/ssh2/lib/client.js) before handing the wrapper
      // back, so the only listener after connect() is the adapter's own. If a future
      // ssh2 stops stripping it the count becomes 2 and this assertion fails RED --
      // a deliberate tripwire, not an off-by-one. The "ssh2 leaves zero of its own"
      // half of the premise is pinned independently by the raw-wrapper test above,
      // which connects WITHOUT the adapter.
      expect(wrapper.listenerCount("error")).toBe(1);

      // A baseline operation works before the session is killed, so the terminal
      // rejection afterward is attributable to the fatal error, not a bad connect.
      await expect(crashSFTP.list(SFTP_PATH)).resolves.toBeInstanceOf(Array);

      // Emit the synthetic fatal error. If this crashed the process the test run
      // would abort here; reaching the next line is itself part of the proof.
      const fatal = Object.assign(new Error("Malformed NAME packet"), {
        level: "sftp-protocol",
      });
      expect(() => wrapper.emit("error", fatal)).not.toThrow();

      // The adapter is left in a clean, terminal state: a subsequent operation
      // rejects promptly with the typed terminal error (a UsageError the poll loop
      // and rendezvous gate treat as terminal) carrying the fatal cause, rather than
      // hanging forever or surfacing an uncaught throw. Prompt -- it must not wait
      // out the 60 s liveness deadline, which the default test timeout would catch.
      const listErr = await crashSFTP.list(SFTP_PATH).catch((e: unknown) => e);
      expect(listErr).toBeInstanceOf(TransportOperationStalledError);
      expect(listErr).toBeInstanceOf(UsageError);
      expect((listErr as Error).message).toContain("Malformed NAME packet");

      // The same terminal failure on the lock path (createExclusive) and the read
      // path (get), so every server-driven operation fails cleanly post-crash.
      const createErr = await crashSFTP
        .createExclusive(`${SFTP_PATH}/never.json`)
        .catch((e: unknown) => e);
      expect(createErr).toBeInstanceOf(TransportOperationStalledError);

      const getErr = await crashSFTP
        .get(`${SFTP_PATH}/never.json`, { maxBytes: 32 })
        .catch((e: unknown) => e);
      expect(getErr).toBeInstanceOf(TransportOperationStalledError);

      // The remaining server-driven methods short-circuit too. Against the real
      // still-alive server socket, an unguarded put/delete/rename/exists/uncapped
      // get would buffer on the destroyed SFTP channel and HANG until the default
      // test timeout (the original residual this change closes); each must instead
      // reject promptly with the typed terminal error.
      const putErr = await crashSFTP
        .put(Buffer.from("x"), `${SFTP_PATH}/never.json`)
        .catch((e: unknown) => e);
      expect(putErr).toBeInstanceOf(TransportOperationStalledError);

      const deleteErr = await crashSFTP
        .delete(`${SFTP_PATH}/never.json`)
        .catch((e: unknown) => e);
      expect(deleteErr).toBeInstanceOf(TransportOperationStalledError);

      const renameErr = await crashSFTP
        .rename(`${SFTP_PATH}/a.json`, `${SFTP_PATH}/b.json`)
        .catch((e: unknown) => e);
      expect(renameErr).toBeInstanceOf(TransportOperationStalledError);

      const existsErr = await crashSFTP
        .exists(`${SFTP_PATH}/never.json`)
        .catch((e: unknown) => e);
      expect(existsErr).toBeInstanceOf(TransportOperationStalledError);

      const uncappedGetErr = await crashSFTP
        .get(`${SFTP_PATH}/never.json`)
        .catch((e: unknown) => e);
      expect(uncappedGetErr).toBeInstanceOf(TransportOperationStalledError);

      // safeDelete must never reject (callers use it in catch blocks): on a dead
      // session it RESOLVES promptly as a best-effort no-op. This is the realistic
      // teardown path -- FileSyncConnection.close() drives safeDelete -- so without
      // the resolve-on-dead guard a teardown after the crash would hang here against
      // the still-alive server rather than completing.
      await expect(
        crashSFTP.safeDelete(`${SFTP_PATH}/never.json`),
      ).resolves.toBeUndefined();
    } finally {
      // The session is already dead; end() is best-effort cleanup. Swallow any
      // error so a failed teardown does not mask the assertions above.
      await crashSFTP.end().catch(() => {});
    }
  },
);
