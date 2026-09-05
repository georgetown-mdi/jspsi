import fs from "node:fs/promises";
import path from "node:path";

import { EventEmitter } from "node:events";

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  FileSyncConnection,
  FrameSizeExceededError,
  TransportOperationStalledError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type { SFTPConnectionConfig } from "@psilink/core";
import Ssh2SftpClient from "ssh2-sftp-client";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  ensureNamespace,
  localPath,
  publicKeyAuth,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";

import log from "loglevel";
import { inProcessOnly } from "../sftpBackendGate";

log.setLevel(log.levels.DEBUG);

// The test SFTP server serves a fresh per-run directory; this file rendezvouses
// under it. SFTP_LOCAL_DIRECTORY and SFTP_PATH are the host and remote paths the
// raw-op tests use (list/get/put and the crashed-adapter assertions, none of
// which poll); every other exchange in this file -- the persistent
// serverConn/clientConn pair included -- MUST use freshRendezvous() or its own
// dedicated directory instead, or a stray poll or leftover lock can trip a
// later test's directory-exclusivity guard.
const srv = sftpServer();
const NS = "sftp";
const SFTP_LOCAL_DIRECTORY = localPath(srv, NS);
const SFTP_PATH = remotePath(srv, NS);

// The persistent serverConn/clientConn pair's dedicated rendezvous directory,
// created fresh in beforeAll (pairLocalDir is its host path, pairPath the remote
// path the pair connects to) so the pair never shares a namespace with the
// raw-op tests on SFTP_PATH. See the file header.
let pairLocalDir: string;
let pairPath: string;

// The wrapper-crash and ssh2-lifecycle contract assertions exercise the
// in-process backend's real ssh2 wrapper and a synthetic fatal emit; the native
// sshd backend validates the real-server happy path and auth instead, so they
// are tagged to run only in-process.

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
// root, for tests that stand up their own connections (see the file header:
// every exchange here must use one rather than share SFTP_PATH). Returns the
// remote path and records the host directory for teardown in afterAll, so
// per-test directories do not pile up under the served root.
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
const serverConn = new FileSyncConnection(serverSFTP, {
  verbose: -1,
  pollingFrequency: 10,
});
const clientSFTP = new SSH2SFTPClientAdapter();
const clientConn = new FileSyncConnection(clientSFTP, {
  verbose: -1,
  pollingFrequency: 10,
});

serverConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});
clientConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});

beforeAll(async () => {
  await ensureNamespace(srv, NS);
  await cleanServer();
  // Dedicate the persistent pair its own rendezvous directory (see file header):
  // a fresh, exclusively-owned mkdtemp under the served root, so the pair's poll
  // and any lock it leaves behind stay off SFTP_PATH and cannot show up in a
  // later raw-op or contract test.
  pairLocalDir = await fs.mkdtemp(path.join(srv.backingDir, "pair-"));
  pairPath = remotePath(srv, path.basename(pairLocalDir));
  await Promise.all([
    serverConn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: pairPath,
      },
    }),
    clientConn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.userb),
        path: pairPath,
      },
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([clientConn.close(), serverConn.close()]);
  await cleanServer();
  // Removed after close() drains/sweeps the pair's files (above), not before.
  // Guarded: if beforeAll threw before mkdtemp assigned it, there is nothing to
  // remove and fs.rm(undefined) would throw a TypeError that masks the real
  // beforeAll failure (force suppresses a missing path, not a bad argument).
  if (pairLocalDir) await fs.rm(pairLocalDir, { recursive: true, force: true });
});

// to test race condition, Promise.all is used when synchronizing
// to set an explicit order, one party is delayed a tick by using setImmediate

test("lock synchronization with race condition", async () => {
  await Promise.all([serverConn.synchronize(), clientConn.synchronize()]);

  const currentFiles = await serverSFTP.list(pairPath);

  expect(serverConn.peerId).toEqual(clientConn.id);
  expect(clientConn.peerId).toEqual(serverConn.id);
  expect(serverConn.handshakeRole !== clientConn.handshakeRole).toBe(true);

  expect(currentFiles.length).toEqual(0);

  desynchronize(serverConn);
  desynchronize(clientConn);
});

test("basic synchronization", async () => {
  await serverSFTP.put(
    // The planted peer hello must advertise the bilateral mode flags; an empty
    // {} body fails the HelloEnvelope schema. Both parties run default lock
    // mode, so both flags are false.
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${pairPath}/${clientConn.id}-hello.json`,
  );

  await serverConn.synchronize();

  const currentFiles = await serverSFTP.list(pairPath);

  await serverSFTP.safeDelete(`${pairPath}/${serverConn.id}-hello.json`);

  expect(serverConn.peerId).toBe(clientConn.id);
  expect(serverConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name === `${serverConn.id}-hello.json`).toBe(true);

  desynchronize(serverConn);
});

test("message deliverable", async () => {
  // Stagger the rendezvous so the server arrives a tick ahead of the client, but
  // await both parties' synchronize() before send(): under a slow handshake (the
  // restricted-crypto native-sshd profile), send() before the client commits its
  // peerId throws "not synchronized".
  const serverSyncPromise = serverConn.synchronize();
  const clientSyncPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      clientConn.synchronize().then(resolve, reject);
    });
  });
  await Promise.all([serverSyncPromise, clientSyncPromise]);

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
  // Public-key auth is a distinct connect path (a private key rather than a
  // password) and the representative method for unattended transfers, which the
  // password-driven tests above never exercise. Both backends expose a per-party
  // private key, so this leg runs on either.
  const keyServerSFTP = new SSH2SFTPClientAdapter();
  const keyServerConn = new FileSyncConnection(keyServerSFTP, {
    verbose: -1,
    pollingFrequency: 10,
  });
  const keyClientConn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
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
  // Regression guard for the terminal-frame deletion race: the sender's close()
  // must drain (wait for the receiver to consume the last sent file) before
  // running cleanup. Without the drain, cleanup() deletes the file before the
  // receiver polls and the message is lost.

  const senderSFTP = new SSH2SFTPClientAdapter();
  const senderConn = new FileSyncConnection(senderSFTP, {
    verbose: -1,
    pollingFrequency: 10,
  });
  const receiverSFTP = new SSH2SFTPClientAdapter();
  const receiverConn = new FileSyncConnection(receiverSFTP, {
    verbose: -1,
    pollingFrequency: 10,
  });

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

  // The drain in close() holds cleanup until the receiver consumes the file.
  receiverConn.start();
  await senderConn.close();

  const message = await received;

  receiverConn.stop();
  await receiverConn.close();

  expect(message).toEqual({ terminal: true });
});

test("lock starter aborts on a stuck mid-arrival joiner over real SFTP", async () => {
  // End-to-end recovery path on real SFTP: a joiner writes its sentinel, deletes
  // the starter's hello, then crashes before renaming the sentinel to its own
  // hello. The starter must observe the orphaned sentinel and abort within the
  // bounded recovery window with the actionable error, not poll to the full
  // peer timeout. Runs on its own freshRendezvous() directory, not the shared
  // `sftp` namespace (see the file header), or the sentinel and polling here
  // could trip another exchange's directory-exclusivity guard.
  const remote = await freshRendezvous();

  const abortSFTP = new SSH2SFTPClientAdapter();
  // joinerRecoveryMs well under the peer timeout so the bounded-window abort
  // fires first; the 100 ms default poll keeps the abort prompt.
  const abortConn = new FileSyncConnection(abortSFTP, {
    verbose: -1,
    joinerRecoveryMs: 400,
    pollingFrequency: 10,
  });
  await abortConn.open({
    channel: "sftp",
    server: {
      host: srv.host,
      port: srv.port,
      ...serverAuth(srv.usera),
      path: remote,
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
    // it does not contend with the starter's own polling on abortSFTP; its
    // operations take absolute paths, so it reaches this test's dedicated
    // rendezvous): delete the hello and drop a sentinel from a different id in
    // its place.
    await waitFor(async () =>
      (await serverSFTP.list(remote)).some((f) => f.name === helloName),
    );
    await serverSFTP.safeDelete(`${remote}/${helloName}`);
    await serverSFTP.put(
      Buffer.from(
        JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
      ),
      `${remote}/${sentinelName}`,
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
    // Best-effort sweep of the sentinel, then drain the starter via close(); the
    // dedicated rendezvous directory itself is removed in afterAll.
    await serverSFTP.safeDelete(`${remote}/${sentinelName}`);
    await abortConn.close();
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

test("connection-per-poll: an op after the idle release re-establishes with no reported drop", async () => {
  // releaseForIdle drives the ssh2 Client's own end() and awaits its 'close',
  // which clears ssh2-sftp-client's session property; the next operation then
  // re-establishes through the pinned host key and stored credentials. Neither
  // the release nor the re-establishment counts as a reconnection, so the run
  // must report none.
  const remote = await freshRendezvous();
  const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
  const conn = new FileSyncConnection(adapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  await conn.open({
    channel: "sftp",
    server: {
      host: srv.host,
      port: srv.port,
      ...serverAuth(srv.usera),
      path: remote,
    },
  });
  try {
    await expect(adapter.list(remote)).resolves.toEqual([]);
    await adapter.releaseForIdle();
    // The idle-gap operation: no cycle-start reconnect precedes it, so it is the
    // operation itself that must re-establish the session.
    await expect(adapter.list(remote)).resolves.toEqual([]);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
  } finally {
    await conn.close();
  }
});

inProcessOnly(
  "ssh2 hands back a raw SFTP wrapper holding zero 'error' listeners of its own",
  async () => {
    // CONTRACT ASSERTION for the wrapper-crash fix (attachFatalErrorListener):
    // checked without the adapter, to isolate ssh2's own behavior. The fix is a
    // correct guard only if ssh2 hands back the SFTP wrapper with zero 'error'
    // listeners of its own -- true today because Client.sftp()'s onReady strips
    // its setup-time listeners before returning the wrapper. If a future ssh2
    // stops doing that, this assertion fails.
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
      // documents; pinning it here means an upgrade that breaks the assumption fails
      // in this test rather than silently in production.
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
    // Regression guard for the wrapper-crash vector: a hostile/dead server's
    // malformed SFTP reply drives ssh2's doFatalSFTPError -> sftp.emit('error'),
    // and on a listener-free EventEmitter Node turns that into an uncaught
    // exception that crashes the CLI, skipping cleanup and the typed exit-code
    // mapping. The adapter attaches a guarded 'error' listener in connect() so
    // the emit is handled; the synthetic Error below mirrors doFatalSFTPError's
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

      // The guarded listener is present, which is what keeps Node from throwing
      // on the 'error' event; without the fix this count is 0. The count must be
      // exactly 1, not >= 1: the fix rests on ssh2's Client.sftp() stripping its
      // own setup-time 'error' listener before handing the wrapper back, so the
      // only listener after connect() is the adapter's own. If a future ssh2
      // stops stripping it, the count becomes 2 and this assertion fails.
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
      // and rendezvous gate treat as terminal) holding the fatal cause, rather than
      // hanging forever or throwing uncaught. Prompt -- it must not wait out the
      // 60 s liveness deadline, which the default test timeout would catch.
      const listErr = await crashSFTP.list(SFTP_PATH).catch((e: unknown) => e);
      expect(listErr).toBeInstanceOf(TransportOperationStalledError);
      expect(listErr).toBeInstanceOf(UsageError);
      // The server's own words reach the operator on a labelled link of their
      // own, so the rendered chain is where the fatal cause is read back.
      expect(sanitizeErrorForDisplay(listErr)).toContain(
        "Malformed NAME packet",
      );

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

// --- host-key verification over real SFTP ------------------------------------

test("an unpinned connection fails closed over real SFTP (the no-pin default)", async () => {
  const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  conn.on("error", () => {});
  // Spell out the credentials and OMIT the host-key pin (serverAuth would add
  // it), so this exercises the no-pin path: core refuses the connection before
  // authenticating and the error names the missing pin.
  const auth =
    srv.usera.password !== undefined
      ? { password: srv.usera.password }
      : { privateKey: srv.usera.privateKey };
  await expect(
    conn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        username: srv.usera.username,
        ...auth,
        path: SFTP_PATH,
      },
      // One attempt: a host-key refusal is terminal, so retrying only slows it.
      options: { maxReconnectAttempts: 0 },
    }),
  ).rejects.toThrow(/no host_key_fingerprint is pinned/);
  await conn.close().catch(() => {});
});

test("probeHostKeyFingerprint returns the server's real fingerprint without authenticating", async () => {
  const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  // Credentials are present (as in production: first-use establishes the host
  // key, not the credentials) but never used -- the probe refuses at host-key
  // verification, before auth. The host key is presented during the KEX that
  // precedes auth, so the fingerprint the probe learns equals the pin the suite
  // computed for this server; the pin itself is omitted, which is the point.
  const auth =
    srv.usera.password !== undefined
      ? { password: srv.usera.password }
      : { privateKey: srv.usera.privateKey };
  const presented = await conn.probeHostKeyFingerprint({
    channel: "sftp",
    server: {
      host: srv.host,
      port: srv.port,
      username: srv.usera.username,
      ...auth,
    },
  });
  expect(presented.fingerprint).toBe(srv.hostKeyFingerprint);
});

test("the peer-identification diagnosis leaves a real SSH server's probe alone", async () => {
  // The control for the non-SSH peers the unit suite drives with bare listeners:
  // the probe dials through the adapter that diagnoses every dial, and against a
  // server that really does speak SSH it returns the fingerprint and adds
  // nothing -- the probe's verify(false) refusal is not treated as a peer that
  // failed to identify itself.
  const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: srv.host,
      port: srv.port,
      username: srv.usera.username,
    },
  };
  const presented = await conn.probeHostKeyFingerprint(config);
  expect(presented.fingerprint).toBe(srv.hostKeyFingerprint);
});

// A schema-valid OpenSSH SHA256 fingerprint that is guaranteed NOT to match the
// server's real host key: flip one character of the real pin's base64 body to a
// different base64 character. It keeps the SHA256: prefix and length, so it
// passes the connection.server.host_key_fingerprint format check (which runs
// before connect) and the LIVE verifier -- not config validation -- is what
// rejects it, which is the whole point of the negative case below.
function wrongFingerprint(real: string): string {
  const prefix = "SHA256:";
  const body = real.slice(prefix.length);
  // Index 5 sits inside the unconstrained 42-character base64 body (not the
  // final, value-constrained character), so any base64 substitution there leaves
  // the fingerprint well-formed.
  const i = 5;
  const flipped = body[i] === "A" ? "B" : "A";
  return `${prefix}${body.slice(0, i)}${flipped}${body.slice(i + 1)}`;
}

test("a wrong pinned host-key fingerprint is rejected before auth over real SFTP", async () => {
  // The control under test: when connection.server.host_key_fingerprint is set,
  // core installs an ssh2 hostVerifier that runs before authentication and
  // aborts fail-closed on a mismatch. Valid credentials are supplied, so the
  // only thing that can fail this connect is the wrong pin; ssh2 invokes the
  // verifier at host-key verification and reaches userauth only after
  // verify(true), so the rejection necessarily precedes auth.
  const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  conn.on("error", () => {});
  const auth = serverAuth(srv.usera);
  const err = await conn
    .open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...auth,
        // Same server, wrong pin: well-formed SHA256, wrong digest.
        hostKeyFingerprint: wrongFingerprint(auth.hostKeyFingerprint),
        path: SFTP_PATH,
      },
      // One attempt (mirrors the no-pin test above): a host-key refusal is
      // terminal in the adapter -- its retry predicate treats ssh2's "Host
      // denied" as non-retryable -- so retries would only re-run the same key
      // exchange against the same untrusted host. This test pins the live
      // mismatch rejection; the retry classification itself is the adapter's
      // concern and is not what this assertion exercises.
      options: { maxReconnectAttempts: 0 },
    })
    .catch((e: unknown) => e);
  await conn.close().catch(() => {});

  // A rejection, not a resolved connection: catches a regression that stopped
  // rejecting at the pin check (pinning the wrong key would then connect).
  expect(err).toBeInstanceOf(Error);
  // Specifically the pin mismatch -- not the no-pin refusal ("no
  // host_key_fingerprint is pinned") and not an unrelated connect/auth error --
  // so a regression that rejected at the handshake instead of the pin check is
  // caught.
  expect((err as Error).message).toMatch(/SFTP host-key verification failed/);
  expect((err as Error).message).toMatch(
    /does not match the pinned fingerprint/,
  );
});

inProcessOnly(
  "the host-key probe and verify(false) rejections strand no Client listener",
  async () => {
    // CONTRACT ASSERTION: the first-use host-key probe and both verify(false)
    // host-key rejections tear the raw transport down outside ssh2-sftp-client's
    // own end(), so each must leave the underlying ssh2 Client with no stranded
    // 'error'/'end'/'close' handler. ssh2-sftp-client's constructor attaches
    // exactly three permanent listeners to its ssh2 Client (one each for
    // 'error'/'end'/'close'); every per-operation listener it adds is removed in
    // the same promise's .finally(). So after any connect-then-teardown the
    // Client must hold exactly those three and nothing more.

    // Reach the underlying ssh2 Client the way ssh2-sftp-client stores it (this.client)
    // through the adapter's own client field -- the same internal coupling the
    // wrapper-listener assertions above reach this.sftp through.
    const clientOf = (adapter: SSH2SFTPClientAdapter): EventEmitter =>
      (adapter as unknown as { client: { client: EventEmitter } }).client
        .client;
    const counts = (c: EventEmitter) => ({
      error: c.listenerCount("error"),
      end: c.listenerCount("end"),
      close: c.listenerCount("close"),
    });

    // Baseline: a freshly constructed, never-connected adapter holds the
    // constructor's three global listeners and nothing else.
    const baseline = counts(clientOf(new SSH2SFTPClientAdapter()));
    expect(baseline).toEqual({ error: 1, end: 1, close: 1 });

    // What a dial adds and keeps: the adapter's own persistent
    // transport-lifecycle watch, one 'end' and one 'close' (see
    // ssh2SftpAdapter.watchTransportLifecycle), attached once per adapter and
    // living as long as the Client does. It is not a temp listener, so every
    // path below is held to this baseline exactly.
    const dialed = {
      error: baseline.error,
      end: baseline.end + 1,
      close: baseline.close + 1,
    };

    const auth = serverAuth(srv.usera);

    // Path 1 -- the first-use probe: connect far enough to read the host key, refuse
    // at verification, then end(). The pin in `auth` is irrelevant here (the probe
    // installs its own capture verifier and always refuses); the teardown rides the
    // host-denied connect rejection plus the explicit end().
    const probeAdapter = new SSH2SFTPClientAdapter();
    const probeConn = new FileSyncConnection(probeAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    await probeConn.probeHostKeyFingerprint({
      channel: "sftp",
      server: { host: srv.host, port: srv.port, ...auth },
    });
    expect(counts(clientOf(probeAdapter))).toEqual(dialed);

    // Path 2 -- the pinned-mismatch enforce path: a wrong pin makes the enforce
    // verifier refuse, so open() rejects before reaching a session and -- unlike the
    // probe -- without an explicit end(). It must still strand no listener.
    const openAdapter = new SSH2SFTPClientAdapter();
    const openConn = new FileSyncConnection(openAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    openConn.on("error", () => {});
    await expect(
      openConn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          ...auth,
          hostKeyFingerprint: wrongFingerprint(auth.hostKeyFingerprint),
          path: SFTP_PATH,
        },
        options: { maxReconnectAttempts: 0 },
      }),
    ).rejects.toThrow(/SFTP host-key verification failed/);
    expect(counts(clientOf(openAdapter))).toEqual(dialed);
    await openConn.close().catch(() => {});

    // Path 3 -- the no-pin fail-closed path: the default posture for an unpinned
    // config drives a different verifier closure that also ends in verify(false).
    // It tears down identically to Path 2 today; the security-critical default
    // still gets its own check here so the no-pin verifier cannot silently
    // diverge. Omit the pin (and hence serverAuth) so this exercises the no-pin
    // branch.
    const noPinAuth =
      srv.usera.password !== undefined
        ? { password: srv.usera.password }
        : { privateKey: srv.usera.privateKey };
    const noPinAdapter = new SSH2SFTPClientAdapter();
    const noPinConn = new FileSyncConnection(noPinAdapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    noPinConn.on("error", () => {});
    await expect(
      noPinConn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          username: srv.usera.username,
          ...noPinAuth,
          path: SFTP_PATH,
        },
        options: { maxReconnectAttempts: 0 },
      }),
    ).rejects.toThrow(/no host_key_fingerprint is pinned/);
    expect(counts(clientOf(noPinAdapter))).toEqual(dialed);
    await noPinConn.close().catch(() => {});
  },
);

test("the server's real pinned fingerprint connects over real SFTP", async () => {
  // Companion to the wrong-pin test above: pinning the server's ACTUAL host-key
  // fingerprint must connect. This proves the negative case fails because the pin
  // mismatched, not because pinning refuses every connection. serverAuth pins
  // srv.hostKeyFingerprint, the real value the suite computed for this server.
  const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
    verbose: -1,
    pollingFrequency: 10,
  });
  conn.on("error", () => {});
  const remote = await freshRendezvous();
  try {
    await expect(
      conn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          ...serverAuth(srv.usera),
          path: remote,
        },
        // The correct pin matches on the first attempt, so no retry is needed.
        options: { maxReconnectAttempts: 0 },
      }),
    ).resolves.toBeUndefined();
  } finally {
    await conn.close().catch(() => {});
  }
});
