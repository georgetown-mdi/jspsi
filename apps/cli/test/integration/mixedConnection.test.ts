import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { ensureServerDir, sftpPort } from "../container/env";

import log from "loglevel";

log.setLevel(log.levels.DEBUG);

// compose.yaml mounts apps/cli/test/container/sftp/srv/ as /home/{user}/psi
// inside the container, so subdirectories of srv/ are served as subdirectories
// of /psi via SFTP. beforeAll creates SFTP_LOCAL_DIRECTORY with { recursive:
// true } before opening connections, so the host directory exists when the
// server needs it. The directory is resolved relative to this test file (via
// import.meta.url) so it is independent of vitest's cwd, matching the pattern in
// authenticatedExchange.test.ts; the resulting absolute path serves both the
// cleanup helpers and LocalFSClient, which requires an absolute path.
const SFTP_LOCAL_DIRECTORY = fileURLToPath(
  new URL("../container/sftp/srv/mixed", import.meta.url),
);
const SFTP_PATH = "/psi/mixed";
const SFTP_PORT = sftpPort();

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

const sftpAdapter = new SSH2SFTPClientAdapter();
const sftpConn = new FileSyncConnection(sftpAdapter, { verbose: -1 });
const localConn = new FileSyncConnection(new LocalFSClient(), { verbose: -1 });

sftpConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});
localConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});

beforeAll(async () => {
  await ensureServerDir(SFTP_LOCAL_DIRECTORY);
  await cleanServer();
  await Promise.all([
    sftpConn.open({
      channel: "sftp",
      server: {
        host: "localhost",
        port: SFTP_PORT,
        username: "usera",
        password: "usera",
        path: SFTP_PATH,
      },
    }),
    localConn.open({ channel: "filedrop", path: SFTP_LOCAL_DIRECTORY }),
  ]);
});

// to test race condition, Promise.all is used when synchronizing
// to set an explicit order, one party is delayed a tick by using setImmediate

// All tests in this file share one SFTP_PATH rendezvous directory and reuse the
// module-level connections. A test that crashes mid-protocol -- e.g. a transient
// SFTP rename failure in the joiner fast-path -- intentionally leaves its
// <uuid>-joining.json sentinel behind (it is the peer's cross-process recovery
// signal; see fileSyncConnection synchronize()). Without per-test cleanup that
// stray sentinel trips the next test's session-start hygiene guard, turning one
// transient flake into three red tests. Reset the directory and the shared
// connection state after every test so a single failure cannot cascade to its
// siblings.
afterEach(async () => {
  await cleanServer();
  desynchronize(sftpConn);
  desynchronize(localConn);
});

afterAll(async () => {
  await Promise.all([sftpConn.close(), localConn.close()]);
  await cleanServer();
});

test("lock synchronization with race condition", async () => {
  await Promise.all([sftpConn.synchronize(), localConn.synchronize()]);

  expect(sftpConn.peerId).toEqual(localConn.id);
  expect(localConn.peerId).toEqual(sftpConn.id);
  expect(sftpConn.handshakeRole !== localConn.handshakeRole).toBe(true);

  const currentFiles = await sftpAdapter.list(SFTP_PATH);
  expect(currentFiles.length).toEqual(0);

  desynchronize(sftpConn);
  desynchronize(localConn);
});

test("basic synchronization", async () => {
  await sftpAdapter.put(
    // The planted peer hello must advertise the bilateral mode flags
    // (193901017); an empty {} body now fails the HelloEnvelope schema. Both
    // parties run default lock mode, so both flags are false.
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${SFTP_PATH}/${localConn.id}-hello.json`,
  );

  await sftpConn.synchronize();

  const currentFiles = await sftpAdapter.list(SFTP_PATH);
  await sftpAdapter.safeDelete(`${SFTP_PATH}/${sftpConn.id}-hello.json`);

  expect(sftpConn.peerId).toBe(localConn.id);
  expect(sftpConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name).toBe(`${sftpConn.id}-hello.json`);

  desynchronize(sftpConn);
});

test("sftp sends, local receives", async () => {
  const sftpSyncPromise = sftpConn.synchronize();
  const localSyncPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => void localConn.synchronize().then(resolve, reject));
  });
  await Promise.all([sftpSyncPromise, localSyncPromise]);

  localConn.start();

  const messagePromise = new Promise((resolve) => {
    localConn.once("data", (data: unknown) => {
      resolve(data);
    });
  });

  await sftpConn.send({ message: "hello from sftp" });
  const message = await messagePromise;

  localConn.stop();

  desynchronize(sftpConn);
  desynchronize(localConn);

  expect(message).toEqual({ message: "hello from sftp" });
});

test("local sends, sftp receives", async () => {
  const sftpSyncPromise = sftpConn.synchronize();
  const localSyncPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => void localConn.synchronize().then(resolve, reject));
  });
  await Promise.all([sftpSyncPromise, localSyncPromise]);

  sftpConn.start();

  const messagePromise = new Promise((resolve) => {
    sftpConn.once("data", (data: unknown) => {
      resolve(data);
    });
  });

  await localConn.send({ message: "hello from local" });
  const message = await messagePromise;

  sftpConn.stop();

  desynchronize(sftpConn);
  desynchronize(localConn);

  expect(message).toEqual({ message: "hello from local" });
});
